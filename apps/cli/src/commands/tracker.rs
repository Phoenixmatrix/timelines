//! Private offline tracker replicas. The outbox is durable before HTTP and immutable
//! after its first send; an ambiguous acknowledgement is replayed with the same ID.
use super::Ctx;
use crate::{
    output::{GmError, Render, Result},
    remote::{self, Config},
    tracker_cli::*,
};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{IsTerminal, Read},
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Serialize)]
#[serde(transparent)]
pub struct Shown(pub Value);
impl Render for Shown {
    fn text(&self) -> String {
        serde_json::to_string_pretty(&self.0).unwrap_or_default()
    }
}
fn db_err(e: rusqlite::Error) -> GmError {
    GmError::new("replica_error", e.to_string())
}
fn uid() -> String {
    format!("{:032x}", rand::random::<u128>())
}
fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
fn private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
fn private_file(path: &Path) -> Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}
fn root(config: &Config) -> Result<PathBuf> {
    // Never use config.user alone: GM_TOKEN may belong to a different identity.
    // Rotated credentials deliberately start a separate replica, not someone else's outbox.
    let auth = if let Some(token) = config.token() {
        format!("token:{token}")
    } else if config.uses_ssh() {
        format!(
            "ssh:{}:{}",
            config.user.as_deref().unwrap_or(""),
            config.ssh_key.as_deref().unwrap_or("default")
        )
    } else {
        return Err(GmError::new(
            "unauthenticated",
            "Sign in before selecting a tracker replica.",
        ));
    };
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .ok_or_else(|| {
            GmError::new(
                "replica_path",
                "Set HOME or XDG_DATA_HOME for private tracker storage.",
            )
        })?;
    Ok(base
        .join("gitmatrix/tracker")
        .join(digest(&format!("{}\n{auth}", config.server()))))
}
fn safe_owner(owner: &str) -> Result<()> {
    if owner.is_empty()
        || !owner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(GmError::usage(
            "Owner must be an account slug (letters, numbers, '-' or '_').",
        ));
    }
    Ok(())
}
struct Replica {
    db: Connection,
    config: Config,
    owner: String,
}
impl Replica {
    fn meta(&self, key: &str) -> Result<Option<String>> {
        self.db
            .query_row("SELECT value FROM meta WHERE key=?", [key], |r| r.get(0))
            .optional()
            .map_err(db_err)
    }
    fn set(&self, key: &str, value: &str) -> Result<()> {
        self.db
            .execute(
                "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![key, value],
            )
            .map_err(db_err)?;
        Ok(())
    }
    fn snapshot(&self) -> Result<Value> {
        let raw = self.meta("snapshot")?.ok_or_else(|| {
            GmError::new(
                "replica_uninitialized",
                "Initialize online with `gm tracker use OWNER` before offline work.",
            )
        })?;
        Ok(serde_json::from_str(&raw)?)
    }
    fn path(&self, suffix: &str) -> String {
        format!("/tracker/{}/{}", self.owner, suffix)
    }
    fn verify(&self) -> Result<()> {
        let session = remote::api(&self.config, "GET", "/session", None)?;
        let actor = session["viewer"]["id"].as_str().ok_or_else(|| {
            GmError::new(
                "unauthenticated",
                "An authenticated tracker identity is required.",
            )
        })?;
        if self.meta("actor")?.is_some_and(|old| old != actor) {
            return Err(GmError::new(
                "identity_changed",
                "This replica belongs to another authenticated identity; select an explicit SSH key or use a separate XDG_DATA_HOME. No outbox was sent.",
            ));
        }
        self.set("server", &self.config.server())?;
        self.set("actor", actor)
    }
    fn pull(&self) -> Result<()> {
        if self.meta("snapshot")?.is_none() {
            let mut snapshot = remote::api(&self.config, "GET", &self.path("snapshot"), None)?;
            redact(&mut snapshot);
            if !snapshot["issues"].is_array() || !snapshot["cursor"].is_u64() {
                return Err(GmError::new("protocol_error", "Invalid tracker snapshot."));
            }
            return self.set("snapshot", &serde_json::to_string(&snapshot)?);
        }
        loop {
            let mut snapshot = self.snapshot()?;
            let before = snapshot["cursor"].as_u64().unwrap_or(0);
            let feed = remote::api(
                &self.config,
                "GET",
                &self.path(&format!("changes?after={before}&limit=200")),
                None,
            )?;
            let events = feed["events"].as_array().ok_or_else(|| {
                GmError::new("protocol_error", "Invalid tracker changes response.")
            })?;
            let cursor = feed["cursor"]
                .as_u64()
                .ok_or_else(|| GmError::new("protocol_error", "Missing change cursor."))?;
            if cursor < before || (feed["hasMore"] == true && cursor <= before) {
                return Err(GmError::new(
                    "protocol_error",
                    "Non-advancing tracker cursor.",
                ));
            }
            for event in events {
                apply_event(&mut snapshot, event)?;
            }
            snapshot["cursor"] = json!(cursor);
            snapshot["serverTime"] = feed["serverTime"].clone();
            self.set("snapshot", &serde_json::to_string(&snapshot)?)?;
            if feed["hasMore"] != true {
                return Ok(());
            }
        }
    }
    fn queued(&self) -> Result<Vec<Value>> {
        let mut stmt = self
            .db
            .prepare("SELECT operation,body,state,error FROM outbox ORDER BY seq")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(db_err)?;
        rows.map(|row| { let (operation,body,state,error)=row.map_err(db_err)?; Ok(json!({"operationId":operation,"request":serde_json::from_str::<Value>(&body)?,"state":state,"error":error})) }).collect()
    }
    fn view(&self) -> Result<Value> {
        let mut snapshot = self.snapshot()?;
        for row in self.queued()? {
            for mutation in row["request"]["mutations"].as_array().into_iter().flatten() {
                project(&mut snapshot, mutation)?;
            }
        }
        Ok(snapshot)
    }
    fn sync(&self) -> Result<()> {
        self.verify()?;
        // Replay before pulling: an uncertain ack must never be rewritten/rebased.
        for row in self.queued()? {
            let operation = row["operationId"].as_str().unwrap();
            if row["state"] == "conflict" {
                self.pull()?;
                return Err(conflict_error(operation));
            }
            self.db
                .execute(
                    "UPDATE outbox SET state='sending' WHERE operation=?",
                    [operation],
                )
                .map_err(db_err)?;
            match remote::api(
                &self.config,
                "POST",
                &self.path("mutate"),
                Some(&row["request"]),
            ) {
                Ok(reply) => {
                    if !reply["events"].is_array() || !reply["results"].is_array() {
                        return Err(GmError::new(
                            "uncertain_ack",
                            "Server reply was not a mutation receipt. Outbox retained; retry `gm tracker sync`.",
                        ));
                    }
                    // Do NOT advance the cursor to this receipt: concurrent intervening
                    // events must still be consumed through the ordered change feed.
                    let mut snapshot = self.snapshot()?;
                    for event in reply["events"].as_array().unwrap() {
                        apply_event(&mut snapshot, event)?;
                    }
                    self.db.execute_batch("BEGIN IMMEDIATE").map_err(db_err)?;
                    let applied = (|| -> Result<()> {
                        self.set("snapshot", &serde_json::to_string(&snapshot)?)?;
                        self.db
                            .execute("DELETE FROM outbox WHERE operation=?", [operation])
                            .map_err(db_err)?;
                        Ok(())
                    })();
                    if let Err(error) = applied {
                        let _ = self.db.execute_batch("ROLLBACK");
                        return Err(error);
                    }
                    self.db.execute_batch("COMMIT").map_err(db_err)?;
                }
                Err(error) => {
                    if error.code == "conflict"
                        || error.code == "not_found"
                        || error.code == "forbidden"
                        || (error.code == "server_error" && error.message.starts_with("HTTP 4"))
                    {
                        self.db
                            .execute(
                                "UPDATE outbox SET state='conflict',error=? WHERE operation=?",
                                params![error.message, operation],
                            )
                            .map_err(db_err)?;
                        self.pull()?;
                        return Err(conflict_error(operation));
                    }
                    return Err(error.hint("The durable operation is retained. Retry `gm tracker sync`; do not recreate the mutation."));
                }
            }
        }
        self.pull()
    }
    fn submit(&self, ctx: &Ctx, offline: bool, mutations: Vec<Value>) -> Result<Shown> {
        validate_batch(&mutations)?;
        let operation = uid();
        let request = json!({"operationId":operation,"mutations":mutations});
        if ctx.dry_run {
            let mut preview = self.view()?;
            for m in request["mutations"].as_array().unwrap() {
                project(&mut preview, m)?;
            }
            return Ok(Shown(
                json!({"dryRun":true,"request":request,"validation":"Local shape/reference preview only; authority revalidates atomically."}),
            ));
        }
        // Local projection validates shape/references before committing the intent.
        let mut preview = self.view()?;
        for m in request["mutations"].as_array().unwrap() {
            project(&mut preview, m)?;
        }
        self.db
            .execute(
                "INSERT INTO outbox(operation,body,state) VALUES (?,?,'queued')",
                params![operation, serde_json::to_string(&request)?],
            )
            .map_err(db_err)?;
        if !offline {
            self.sync()?;
        }
        let view = self.view()?;
        let entities: Vec<Value> = request["mutations"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|m| {
                collection(m["kind"].as_str().unwrap().split('.').next().unwrap())
                    .and_then(|c| view[c].as_array())
                    .and_then(|rows| rows.iter().find(|e| e["id"] == m["id"]))
                    .cloned()
            })
            .collect();
        Ok(Shown(
            json!({"operationId":operation,"queued":offline,"entities":entities,"cursor":view["cursor"]}),
        ))
    }
}
fn conflict_error(operation: &str) -> GmError {
    GmError::new("tracker_conflict", format!("Operation {operation} needs explicit resolution; later operations remain queued.")).exit(crate::output::exit::CONFLICT).hint("Run `gm tracker conflicts`, then `gm tracker resolve OPERATION --strategy accept-server|reapply-local`.")
}
fn with_replica(
    scope: &Scope,
    ctx: &Ctx,
    refresh: bool,
    f: impl FnOnce(&Replica) -> Result<Shown>,
) -> Result<Shown> {
    let config = Config::load();
    let root = root(&config)?;
    let owner = scope
        .owner
        .clone()
        .or_else(|| fs::read_to_string(root.join("selected")).ok())
        .ok_or_else(|| GmError::usage("Select `gm tracker use OWNER` or pass --owner OWNER."))?;
    safe_owner(&owner)?;
    if scope.offline && !root.join(format!("{owner}.sqlite")).exists() {
        return Err(GmError::new(
            "replica_uninitialized",
            format!(
                "Initialize this identity/owner online with `gm tracker use OWNER`. Retained credential partitions: {}. After token rotation, use `gm tracker recover OLD_REPLICA --owner OWNER` to recover the old outbox.",
                root.parent().unwrap().display()
            ),
        ));
    }
    private_dir(&root)?;
    let mut lock = fd_lock::RwLock::new(private_file(&root.join(format!("{owner}.lock")))?);
    let _guard = lock.write()?;
    let path = root.join(format!("{owner}.sqlite"));
    private_file(&path)?;
    let db = Connection::open(path).map_err(db_err)?;
    db.busy_timeout(Duration::from_secs(30)).map_err(db_err)?;
    db.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,operation TEXT UNIQUE NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL,error TEXT);").map_err(db_err)?;
    let replica = Replica { db, config, owner };
    if !scope.offline && refresh && !ctx.dry_run {
        replica.sync()?;
    }
    f(&replica)
}
fn collection(kind: &str) -> Option<&'static str> {
    match kind {
        "team" => Some("teams"),
        "workspace" => Some("workspaces"),
        "issue" => Some("issues"),
        "link" => Some("links"),
        "comment" => Some("comments"),
        "request" => Some("requests"),
        "subscription" => Some("subscriptions"),
        _ => None,
    }
}
fn apply_event(snapshot: &mut Value, event: &Value) -> Result<()> {
    let table = collection(event["entityType"].as_str().unwrap_or(""))
        .ok_or_else(|| GmError::new("protocol_error", "Unknown tracker entity type."))?;
    let rows = snapshot[table]
        .as_array_mut()
        .ok_or_else(|| GmError::new("protocol_error", "Missing tracker entity collection."))?;
    rows.retain(|row| row["id"] != event["entityId"]);
    if !event["entity"].is_null() {
        let mut entity = event["entity"].clone();
        redact(&mut entity);
        rows.push(entity);
    }
    Ok(())
}
fn redact(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.remove("leaseToken");
            for v in map.values_mut() {
                redact(v);
            }
        }
        Value::Array(items) => {
            for v in items {
                redact(v);
            }
        }
        _ => {}
    }
}
fn resolve<'a>(snapshot: &'a Value, table: &str, reference: &str) -> Result<&'a Value> {
    snapshot[table].as_array().into_iter().flatten().find(|v|v["id"]==reference || v["key"]==reference || v["slug"]==reference).ok_or_else(|| GmError::not_found("tracker_not_found",format!("No {table} entry '{reference}' in this replica. Sync first, or use its canonical ID.")))
}
fn id(snapshot: &Value, table: &str, reference: &str) -> Result<String> {
    Ok(resolve(snapshot, table, reference)?["id"]
        .as_str()
        .unwrap()
        .to_owned())
}
fn validate_batch(mutations: &[Value]) -> Result<()> {
    if mutations.is_empty() || mutations.len() > 100 {
        return Err(GmError::usage(
            "An atomic batch must contain 1..100 mutations.",
        ));
    }
    for m in mutations {
        let kind = m["kind"].as_str().unwrap_or("");
        if ![
            "team.create",
            "team.update",
            "workspace.create",
            "workspace.update",
            "issue.create",
            "issue.update",
            "link.add",
            "link.remove",
            "comment.add",
            "subscription.add",
            "subscription.remove",
        ]
        .contains(&kind)
        {
            return Err(GmError::usage(format!(
                "Unsupported offline/batch mutation '{kind}'. Lease operations require their dedicated online commands."
            )));
        }
        if m["id"].as_str().is_none_or(str::is_empty) {
            return Err(GmError::usage(
                "Every batch mutation requires a stable canonical id.",
            ));
        }
        if kind.ends_with(".update") && !m["expectedVersion"].is_u64() {
            return Err(GmError::usage("Updates require expectedVersion."));
        }
        if m.to_string().contains("\"leaseToken\"") {
            return Err(GmError::usage(
                "Lease tokens cannot enter the durable outbox. Use claim/renew/release/complete online.",
            ));
        }
    }
    Ok(())
}
fn project(snapshot: &mut Value, mutation: &Value) -> Result<()> {
    let kind = mutation["kind"].as_str().unwrap_or("");
    let (entity, action) = kind
        .split_once('.')
        .ok_or_else(|| GmError::usage("Mutation kind must be entity.action."))?;
    let table = collection(entity).ok_or_else(|| GmError::usage("Unknown mutation entity."))?;
    let rows = snapshot[table]
        .as_array_mut()
        .ok_or_else(|| GmError::new("protocol_error", "Missing replica collection."))?;
    let index = rows.iter().position(|v| v["id"] == mutation["id"]);
    if action == "remove" {
        rows.retain(|v| v["id"] != mutation["id"]);
        return Ok(());
    }
    let data = mutation["data"]
        .as_object()
        .ok_or_else(|| GmError::usage("Mutation data must be a JSON object."))?;
    if action == "update" {
        let index = index.ok_or_else(|| {
            GmError::not_found(
                "tracker_not_found",
                "Cannot update an entity missing from this replica.",
            )
        })?;
        let row = rows[index].as_object_mut().unwrap();
        for (key, value) in data {
            if ["id", "key", "version", "createdAt", "claim", "teamId"].contains(&key.as_str()) {
                return Err(GmError::usage(format!("Immutable field '{key}'.")));
            }
            row.insert(key.clone(), value.clone());
        }
        row.insert(
            "version".into(),
            json!(mutation["expectedVersion"].as_u64().unwrap_or(0) + 1),
        );
        row.insert("local".into(), json!(true));
    } else {
        if index.is_some() {
            return Err(GmError::usage("Duplicate create ID in replica."));
        }
        let mut row = match entity {
            "issue" => {
                json!({"key":null,"description":"","acceptance":"","type":"task","status":"todo","priority":2,"assigneeId":null,"parentId":null,"workspaceIds":[],"labels":[],"claim":null})
            }
            "team" => json!({"description":"","memberIds":[],"archived":false}),
            "workspace" => json!({"description":"","archived":false}),
            _ => json!({}),
        };
        for (key, value) in data {
            row[key] = value.clone();
        }
        row["id"] = mutation["id"].clone();
        row["version"] = json!(1);
        row["local"] = json!(true);
        row["createdAt"] = json!(Utc::now().to_rfc3339());
        rows.push(row);
    }
    Ok(())
}
fn input(text: &str) -> Result<String> {
    if text == "-" {
        let mut s = String::new();
        std::io::stdin().take(1_048_577).read_to_string(&mut s)?;
        if s.len() > 1_048_576 {
            return Err(GmError::usage("Input exceeds 1 MiB."));
        }
        Ok(s)
    } else if let Some(path) = text.strip_prefix('@') {
        Ok(fs::read_to_string(path)?)
    } else {
        Ok(text.to_owned())
    }
}
fn object(text: &str) -> Result<Value> {
    let value: Value = serde_json::from_str(&input(text)?)?;
    if !value.is_object() {
        return Err(GmError::usage("--data must be a JSON object."));
    }
    Ok(value)
}
fn create(entity: &str, data: Value) -> Value {
    json!({"kind":format!("{entity}.create"),"id":uid(),"data":data})
}
fn patch(snapshot: &Value, entity: &str, p: &Patch) -> Result<Value> {
    let row = resolve(snapshot, collection(entity).unwrap(), &p.id)?;
    Ok(
        json!({"kind":format!("{entity}.update"),"id":row["id"],"expectedVersion":row["version"],"data":object(&p.data)?}),
    )
}

pub fn tracker(ctx: &Ctx, args: &TrackerArgs) -> Result<Shown> {
    if matches!(args.command, TrackerCommand::List) {
        if args.scope.offline {
            return Err(GmError::usage(
                "Tracker discovery requires online authentication.",
            ));
        }
        return Ok(Shown(remote::api(
            &Config::load(),
            "GET",
            "/tracker",
            None,
        )?));
    }
    if let TrackerCommand::Use { owner } = &args.command {
        safe_owner(owner)?;
        if args.scope.offline {
            return Err(GmError::usage(
                "Initialize and select a tracker online first.",
            ));
        }
        if ctx.dry_run {
            return Ok(Shown(json!({"dryRun":true,"owner":owner})));
        }
        let scope = Scope {
            owner: Some(owner.clone()),
            offline: false,
        };
        return with_replica(&scope, ctx, true, |r| {
            let root = root(&r.config)?;
            private_file(&root.join("selected"))?;
            fs::write(root.join("selected"), owner)?;
            Ok(Shown(
                json!({"owner":owner,"identity":r.meta("actor")?,"replica":root.join(format!("{owner}.sqlite")),"cursor":r.snapshot()?["cursor"]}),
            ))
        });
    }
    with_replica(&args.scope, ctx, false, |r| match &args.command {
        TrackerCommand::Sync => {
            if args.scope.offline {
                return Err(GmError::usage(
                    "Sync requires online access; remove --offline.",
                ));
            }
            if !ctx.dry_run {
                r.sync()?;
            }
            Ok(Shown(
                json!({"dryRun":ctx.dry_run,"cursor":r.snapshot()?["cursor"],"pending":r.queued()?.len()}),
            ))
        }
        TrackerCommand::Status => Ok(Shown(
            json!({"owner":r.owner,"identity":r.meta("actor")?,"cursor":r.snapshot()?["cursor"],"operations":r.queued()?,"replica":root(&r.config)?.join(format!("{}.sqlite",r.owner)),"credentialPartitions":root(&r.config)?.parent(),"credentialRotation":"Old credential partitions remain intact. To reconnect a rotated token to its old outbox, use tracker recover with the old replica path after verifying the same identity."}),
        )),
        TrackerCommand::Recover { replica: source } => {
            if args.scope.offline {
                return Err(GmError::usage(
                    "Recovery must verify the authenticated identity online.",
                ));
            }
            r.verify()?;
            if !r.queued()?.is_empty() {
                return Err(GmError::usage(
                    "Destination outbox must be empty before recovery.",
                ));
            }
            let source = fs::canonicalize(source)?;
            let destination =
                fs::canonicalize(root(&r.config)?.join(format!("{}.sqlite", r.owner)))?;
            if source == destination {
                return Err(GmError::usage(
                    "Source and destination are the same replica.",
                ));
            }
            let mut lock = fd_lock::RwLock::new(private_file(&source.with_extension("lock"))?);
            let _guard = lock.write()?;
            r.db.execute(
                "ATTACH DATABASE ? AS recovery",
                [source.to_string_lossy().as_ref()],
            )
            .map_err(db_err)?;
            let actor: String =
                r.db.query_row(
                    "SELECT value FROM recovery.meta WHERE key='actor'",
                    [],
                    |row| row.get(0),
                )
                .map_err(db_err)?;
            let server: String =
                r.db.query_row(
                    "SELECT value FROM recovery.meta WHERE key='server'",
                    [],
                    |row| row.get(0),
                )
                .map_err(db_err)?;
            let raw: String =
                r.db.query_row(
                    "SELECT value FROM recovery.meta WHERE key='snapshot'",
                    [],
                    |row| row.get(0),
                )
                .map_err(db_err)?;
            let snapshot: Value = serde_json::from_str(&raw)?;
            if Some(actor) != r.meta("actor")?
                || server != r.config.server()
                || snapshot["owner"]["slug"] != r.owner
            {
                return Err(GmError::new(
                    "identity_mismatch",
                    "Recovery requires the same verified actor, server and tracker owner.",
                ));
            }
            let count: i64 =
                r.db.query_row("SELECT COUNT(*) FROM recovery.outbox", [], |row| row.get(0))
                    .map_err(db_err)?;
            if !ctx.dry_run {
                r.db.execute_batch("BEGIN IMMEDIATE; INSERT INTO main.outbox(operation,body,state,error) SELECT operation,body,state,error FROM recovery.outbox ORDER BY seq; INSERT INTO main.meta(key,value) SELECT key,value FROM recovery.meta WHERE key='snapshot' ON CONFLICT(key) DO UPDATE SET value=excluded.value; DELETE FROM recovery.outbox; COMMIT;").map_err(db_err)?;
            }
            Ok(Shown(
                json!({"dryRun":ctx.dry_run,"recovered":count,"source":source,"replica":destination,"next":"Run gm tracker sync. Original operation IDs and uncertain receipts were preserved."}),
            ))
        }
        TrackerCommand::Conflicts => {
            if !args.scope.offline {
                r.verify()?;
                r.pull()?;
            }
            let local = r.view();
            Ok(Shown(
                json!({"operations":r.queued()?,"remote":r.snapshot()?,"local":local.as_ref().ok().cloned(),"projectionError":local.err().map(|e|e.message),"resolution":"Only the head conflict may be resolved. accept-server discards that atomic batch only; later operations are retained. reapply-local rebases that batch explicitly onto current remote versions."}),
            ))
        }
        TrackerCommand::Resolve {
            operation,
            strategy,
        } => {
            if args.scope.offline {
                return Err(GmError::usage(
                    "Conflict resolution requires fresh online server state.",
                ));
            }
            r.verify()?;
            r.pull()?;
            let rows = r.queued()?;
            let head = rows
                .first()
                .ok_or_else(|| GmError::usage("There are no queued operations."))?;
            if head["operationId"] != *operation || head["state"] != "conflict" {
                return Err(GmError::usage(
                    "Only the first, definitively rejected conflict may be resolved. Uncertain acknowledgements must be replayed with sync.",
                ));
            }
            let mut request = head["request"].clone();
            request["operationId"] = json!(uid());
            if strategy == "reapply-local" {
                let mut snapshot = r.snapshot()?;
                for m in request["mutations"].as_array_mut().unwrap() {
                    if m["kind"].as_str().unwrap().ends_with(".update") {
                        let table =
                            collection(m["kind"].as_str().unwrap().split('.').next().unwrap())
                                .unwrap();
                        m["expectedVersion"] =
                            resolve(&snapshot, table, m["id"].as_str().unwrap())?["version"]
                                .clone();
                    }
                    project(&mut snapshot, m)?;
                }
            }
            if ctx.dry_run {
                return Ok(Shown(
                    json!({"dryRun":true,"strategy":strategy,"request":request}),
                ));
            }
            if strategy == "accept-server" {
                r.db.execute("DELETE FROM outbox WHERE operation=?", [operation])
                    .map_err(db_err)?;
            } else {
                r.db.execute("UPDATE outbox SET operation=?,body=?,state='queued',error=NULL WHERE operation=?",params![request["operationId"].as_str().unwrap(),serde_json::to_string(&request)?,operation]).map_err(db_err)?;
            }
            Ok(Shown(
                json!({"resolved":operation,"strategy":strategy,"pending":r.queued()?,"next":"Run gm tracker sync. Later operations were not discarded or silently rebased."}),
            ))
        }
        TrackerCommand::Changes { after, limit } => {
            if args.scope.offline {
                return Err(GmError::usage(
                    "The authoritative changes feed requires online access.",
                ));
            }
            r.verify()?;
            Ok(Shown(remote::api(
                &r.config,
                "GET",
                &r.path(&format!("changes?after={after}&limit={limit}")),
                None,
            )?))
        }
        _ => unreachable!(),
    })
}

/// Requests to people: listed from the replica, answered online. A credential's value
/// goes straight to its repository secret; the tracker only hears where it went.
pub fn request(ctx: &Ctx, args: &RequestArgs) -> Result<Shown> {
    with_replica(&args.scope, ctx, true, |r| {
        let snapshot = r.view()?;
        let me = remote::api(&r.config, "GET", "/session", None)
            .ok()
            .and_then(|s| s["viewer"]["id"].as_str().map(str::to_string))
            .unwrap_or_default();
        let find = |id: &str| -> Result<Value> {
            snapshot["requests"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|q| q["id"] == id || q["id"].as_str().is_some_and(|v| v.starts_with(id)))
                .cloned()
                .ok_or_else(|| GmError::usage(format!("No request {id}; see `gm request list`.")))
        };
        let mutation = match &args.command {
            RequestCommand::List => {
                let mut open: Vec<Value> = snapshot["requests"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|q| q["status"] == "open")
                    .map(|q| {
                        let mut q = q.clone();
                        let issue = find_issue(&snapshot, &q["issueId"]);
                        q["issue"] = json!({"key":issue["key"],"title":issue["title"]});
                        q["asker"] =
                            json!(actor_name(&snapshot, q["askedBy"].as_str().unwrap_or("")));
                        q["for"] =
                            json!(actor_name(&snapshot, q["routeTo"].as_str().unwrap_or("")));
                        q
                    })
                    .collect();
                open.sort_by_key(|q| q["routeTo"] != me.as_str());
                return Ok(Shown(
                    json!({"requests":open,"next":"Answer with `gm request answer ID`."}),
                ));
            }
            RequestCommand::Cancel { id } => {
                json!({"kind":"request.cancel","id":find(id)?["id"]})
            }
            RequestCommand::Answer {
                id,
                answer,
                choice,
                approve,
                reject,
            } => {
                let q = find(id)?;
                let mut data = json!({});
                match q["kind"].as_str() {
                    Some("decision") => {
                        data["choice"] = json!(choice.clone().ok_or_else(|| GmError::usage(
                            format!("Pass --choice: {}.", q["choices"])
                        ))?)
                    }
                    Some("approval") => {
                        if !approve && !reject {
                            return Err(GmError::usage(
                                "Pass --approve or --reject (and --answer for a note).",
                            ));
                        }
                        data["approved"] = json!(*approve);
                        if let Some(note) = answer {
                            data["answer"] = json!(input(note)?);
                        }
                    }
                    Some("credential") => {
                        let repo = q["secret"]["repo"].as_str().unwrap_or("");
                        let name = q["secret"]["name"].as_str().unwrap_or("");
                        let value = if std::io::stdin().is_terminal() {
                            rpassword::prompt_password(format!(
                                "Value for {name} on {repo} (hidden): "
                            ))?
                        } else {
                            let mut buffer = String::new();
                            std::io::stdin().read_to_string(&mut buffer)?;
                            buffer.trim_end_matches(['\n', '\r']).to_string()
                        };
                        if value.is_empty() {
                            return Err(GmError::usage("The credential's value is empty."));
                        }
                        if !ctx.dry_run {
                            remote::api(
                                &r.config,
                                "PUT",
                                &format!("/repos/{repo}/ci/secrets/{name}"),
                                Some(&json!({"value":value})),
                            )?;
                        }
                        data["stored"] = json!(true);
                    }
                    _ => {
                        data["answer"] = json!(input(
                            answer
                                .as_deref()
                                .ok_or_else(|| GmError::usage("Pass --answer."))?
                        )?)
                    }
                }
                json!({"kind":"request.answer","id":q["id"],"data":data})
            }
        };
        let request = json!({"operationId":uid(),"mutations":[mutation]});
        if ctx.dry_run {
            return Ok(Shown(json!({"dryRun":true,"request":request})));
        }
        let response = remote::api(&r.config, "POST", &r.path("mutate"), Some(&request))?;
        r.sync()?;
        Ok(Shown(response))
    })
}
fn find_issue(snapshot: &Value, id: &Value) -> Value {
    snapshot["issues"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|i| i["id"] == *id)
        .cloned()
        .unwrap_or(Value::Null)
}
pub fn team(ctx: &Ctx, args: &TeamArgs) -> Result<Shown> {
    with_replica(&args.scope, ctx, true, |r| {
        let snapshot = r.view()?;
        let mutation = match &args.command {
            TeamCommand::List => {
                return Ok(Shown(
                    json!({"teams":snapshot["teams"],"offline":args.scope.offline,"cursor":snapshot["cursor"]}),
                ));
            }
            TeamCommand::Create(a) => create(
                "team",
                json!({"key":a.key,"name":a.name,"description":a.description}),
            ),
            TeamCommand::Update(p) => patch(&snapshot, "team", p)?,
        };
        r.submit(ctx, args.scope.offline, vec![mutation])
    })
}
pub fn workspace(ctx: &Ctx, args: &WorkspaceArgs) -> Result<Shown> {
    with_replica(&args.scope, ctx, true, |r| {
        let snapshot = r.view()?;
        let mutation = match &args.command {
            WorkspaceCommand::List => {
                return Ok(Shown(
                    json!({"workspaces":snapshot["workspaces"],"subscriptions":snapshot["subscriptions"],"offline":args.scope.offline,"cursor":snapshot["cursor"]}),
                ));
            }
            WorkspaceCommand::Create(a) => create(
                "workspace",
                json!({"slug":a.key,"name":a.name,"description":a.description}),
            ),
            WorkspaceCommand::Update(p) => patch(&snapshot, "workspace", p)?,
            WorkspaceCommand::Subscribe { workspace, repo } => {
                json!({"kind":"subscription.add","id":uid(),"data":{"workspaceId":id(&snapshot,"workspaces",workspace)?,"repoId":repo}})
            }
            WorkspaceCommand::Unsubscribe { id } => json!({"kind":"subscription.remove","id":id}),
        };
        r.submit(ctx, args.scope.offline, vec![mutation])
    })
}
fn markdown(text: &Option<String>, file: &Option<PathBuf>) -> Result<String> {
    if let Some(path) = file {
        if path == Path::new("-") {
            input("-")
        } else {
            Ok(fs::read_to_string(path)?)
        }
    } else {
        Ok(text.clone().unwrap_or_default())
    }
}
/// A claim holds while it's unexpired, or parked waiting on a person.
fn active_claim(issue: &Value, now: DateTime<Utc>) -> bool {
    if issue["claim"]["parkedAt"].is_string() {
        return true;
    }
    issue["claim"]["expiresAt"]
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .is_some_and(|t| t.with_timezone(&Utc) > now)
}
fn is_open(issue: &Value) -> bool {
    !matches!(issue["status"].as_str(), Some("done" | "canceled"))
}
fn find<'a>(snapshot: &'a Value, id: &Value) -> Option<&'a Value> {
    snapshot["issues"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|i| i["id"] == *id)
}
/// The nearest ancestor with an active lease: its holder owns the whole subtree.
fn leased_ancestor<'a>(
    snapshot: &'a Value,
    issue: &Value,
    now: DateTime<Utc>,
) -> Option<&'a Value> {
    let mut seen = vec![issue["id"].clone()];
    let mut parent = issue["parentId"].clone();
    while !parent.is_null() && !seen.contains(&parent) {
        seen.push(parent.clone());
        let ancestor = find(snapshot, &parent)?;
        if active_claim(ancestor, now) {
            return Some(ancestor);
        }
        parent = ancestor["parentId"].clone();
    }
    None
}
/// Mirrors `readiness` in apps/website/shared/tracker.ts: todo (or in progress with an
/// expired claim), unblocked, a leaf, and outside any other active lease's subtree.
fn ready(snapshot: &Value, issue: &Value, now: DateTime<Utc>) -> bool {
    // Waiting on a person is never ready, whatever the status says.
    if issue["waiting"].as_u64().unwrap_or(0) > 0 {
        return false;
    }
    let status = issue["status"].as_str().unwrap_or("");
    if !(status == "todo" || (status == "in_progress" && !issue["claim"].is_null()))
        || active_claim(issue, now)
    {
        return false;
    }
    let blocked = snapshot["links"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|link| {
            link["kind"] == "blocks"
                && link["toId"] == issue["id"]
                && find(snapshot, &link["fromId"]).is_none_or(|i| i["status"] != "done")
        });
    let container = snapshot["issues"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|i| i["parentId"] == issue["id"] && is_open(i));
    !blocked && !container && leased_ancestor(snapshot, issue, now).is_none()
}
/// How the tracker names an actor: a member by name, an agent as "builder (for Ann Lee)".
fn actor_name(snapshot: &Value, id: &str) -> String {
    let find = |table: &str| {
        snapshot[table]
            .as_array()
            .into_iter()
            .flatten()
            .find(|v| v["id"] == id)
            .cloned()
    };
    if let Some(agent) = find("agents") {
        return format!(
            "{} (for {})",
            agent["name"].as_str().unwrap_or(id),
            agent["accountable"]["displayName"].as_str().unwrap_or("?")
        );
    }
    find("members")
        .and_then(|m| m["displayName"].as_str().map(str::to_string))
        .unwrap_or_else(|| id.to_string())
}
/// The issue as stored, plus who holds its claim and who it's assigned to, by name.
fn named(snapshot: &Value, issue: &Value) -> Value {
    let mut out = issue.clone();
    if let Some(holder) = issue["claim"]["actorId"].as_str() {
        out["claimedBy"] = json!(actor_name(snapshot, holder));
    }
    if let Some(assignee) = issue["assigneeId"].as_str() {
        out["assignee"] = json!(actor_name(snapshot, assignee));
    }
    out
}
fn listing(snapshot: &Value, args: &ListIssues, only_ready: bool, offline: bool) -> Result<Shown> {
    let team = args
        .team
        .as_deref()
        .map(|v| id(snapshot, "teams", v))
        .transpose()?;
    let workspace = args
        .workspace
        .as_deref()
        .map(|v| id(snapshot, "workspaces", v))
        .transpose()?;
    let now = Utc::now();
    let search = args.search.as_ref().map(|s| s.to_lowercase());
    let mut matching: Vec<&Value> = snapshot["issues"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|i| {
            team.as_ref().is_none_or(|t| i["teamId"] == *t)
                && workspace.as_ref().is_none_or(|w| {
                    i["workspaceIds"]
                        .as_array()
                        .is_some_and(|a| a.iter().any(|v| v == w))
                })
                && args.status.as_ref().is_none_or(|s| i["status"] == *s)
                && search.as_ref().is_none_or(|s| {
                    i["title"].as_str().unwrap_or("").to_lowercase().contains(s)
                        || i["description"]
                            .as_str()
                            .unwrap_or("")
                            .to_lowercase()
                            .contains(s)
                })
                && (!only_ready || ready(snapshot, i, now))
        })
        .collect();
    matching.sort_by(|a, b| {
        a["priority"]
            .as_u64()
            .cmp(&b["priority"].as_u64())
            .then_with(|| a["createdAt"].as_str().cmp(&b["createdAt"].as_str()))
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
    Ok(Shown(
        json!({"issues":matching.iter().take(args.limit as usize).map(|i| named(snapshot, i)).collect::<Vec<_>>(),"total":matching.len(),"truncated":matching.len()>args.limit as usize,"offline":offline,"readinessAdvisory":true,"cursor":snapshot["cursor"],"cachedAt":snapshot["serverTime"],"next":"Acquire an online claim before starting exclusive work."}),
    ))
}
fn context(snapshot: &Value, reference: &str, limit: usize, offline: bool) -> Result<Shown> {
    let issue = resolve(snapshot, "issues", reference)?;
    let mut ancestors = Vec::new();
    let mut parent = issue["parentId"].as_str();
    while let Some(p) = parent {
        if ancestors.len() >= limit {
            break;
        }
        let node = resolve(snapshot, "issues", p)?;
        if ancestors.iter().any(|v: &&Value| v["id"] == node["id"]) {
            break;
        }
        ancestors.push(node);
        parent = node["parentId"].as_str();
    }
    let links: Vec<&Value> = snapshot["links"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|l| l["fromId"] == issue["id"] || l["toId"] == issue["id"])
        .collect();
    let mut notes: Vec<&Value> = snapshot["comments"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["issueId"] == issue["id"])
        .collect();
    notes.sort_by(|a, b| {
        a["createdAt"]
            .as_str()
            .cmp(&b["createdAt"].as_str())
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
    let related: Vec<&Value> = snapshot["issues"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|i| {
            i["id"] != issue["id"]
                && links
                    .iter()
                    .any(|l| l["fromId"] == i["id"] || l["toId"] == i["id"])
        })
        .take(limit)
        .collect();
    Ok(Shown(
        json!({"issue":named(snapshot,issue),"ancestors":ancestors,"links":links.iter().take(limit).collect::<Vec<_>>(),"relatedIssues":related,"notes":notes.iter().rev().take(limit).collect::<Vec<_>>(),"limitPerSection":limit,"truncated":{"ancestors":parent.is_some(),"links":links.len()>limit,"notes":notes.len()>limit},"ready":ready(snapshot,issue,Utc::now()),"readinessAdvisory":true,"cursor":snapshot["cursor"],"cachedAt":snapshot["serverTime"],"offline":offline}),
    ))
}
/// Adds a delegation's underToken and forActorId (an agent resolved by name or id).
fn delegate(snapshot: &Value, delegation: &Delegation, data: &mut Value) -> Result<()> {
    if let Some(token) = &delegation.under_token {
        data["underToken"] = json!(token);
    }
    if let Some(agent) = &delegation.for_agent {
        let found = snapshot["agents"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|a| a["id"] == agent.as_str() || a["name"] == agent.as_str())
            .ok_or_else(|| {
                GmError::usage(format!("No agent named {agent} in this tracker."))
                    .hint("See your agents with `gm agent list`.")
            })?;
        data["forActorId"] = found["id"].clone();
    }
    Ok(())
}
/// What `gm issue next` reports: the claim (its token shown once) and the issue's working
/// context, or that nothing in scope is ready.
fn next_result(snapshot: &Value, response: &Value) -> Shown {
    let result = &response["results"][0];
    let Some(issue_id) = result["issueId"].as_str() else {
        return Shown(json!({
            "claimed": null,
            "message": "Nothing in scope is ready: everything is claimed, blocked, waiting, or done.",
        }));
    };
    let context = context(snapshot, issue_id, 30, false)
        .map(|shown| shown.0)
        .unwrap_or(Value::Null);
    // What finished blockers left behind: the evidence this work builds on.
    let blocker_evidence: Vec<&Value> = snapshot["links"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|l| l["kind"] == "blocks" && l["toId"] == issue_id)
        .flat_map(|l| {
            snapshot["comments"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(move |c| c["issueId"] == l["fromId"] && c["kind"] == "evidence")
        })
        .collect();
    Shown(json!({
        "claimed": {
            "issueId": issue_id,
            "key": result["key"],
            "leaseToken": result["leaseToken"],
            "expiresAt": result["expiresAt"],
        },
        "context": context,
        "blockerEvidence": blocker_evidence,
        "next": "Work it, checkpoint as you go (gm issue checkpoint), renew before it expires, then gm issue complete with evidence.",
    }))
}
pub fn issue(ctx: &Ctx, args: &IssueArgs) -> Result<Shown> {
    let lease_command = matches!(
        args.command,
        IssueCommand::Claim { .. }
            | IssueCommand::Handoff { .. }
            | IssueCommand::Withdraw(_)
            | IssueCommand::Accept { .. }
            | IssueCommand::Ask { .. }
            | IssueCommand::Resume { .. }
            | IssueCommand::Revoke { .. }
            | IssueCommand::Next { .. }
            | IssueCommand::Renew { .. }
            | IssueCommand::Release(_)
            | IssueCommand::Complete { .. }
    );
    if lease_command && args.scope.offline {
        return Err(GmError::usage(
            "Claims, renewal, release and completion require online fencing. Offline readiness never grants ownership.",
        ));
    }
    with_replica(&args.scope, ctx, true, |r| {
        let snapshot = r.view()?;
        let mutation = match &args.command {
            IssueCommand::List(a) => return listing(&snapshot, a, false, args.scope.offline),
            IssueCommand::Ready(a) => return listing(&snapshot, a, true, args.scope.offline),
            IssueCommand::Show { issue, limit } => {
                return context(&snapshot, issue, *limit as usize, args.scope.offline);
            }
            IssueCommand::Create(a) => {
                if a.description_file.as_deref() == Some(Path::new("-"))
                    && a.acceptance_file.as_deref() == Some(Path::new("-"))
                {
                    return Err(GmError::usage("Only one field can read stdin."));
                }
                create(
                    "issue",
                    json!({"teamId":id(&snapshot,"teams",&a.team)?,"title":a.title,"description":markdown(&a.description,&a.description_file)?,"acceptance":markdown(&a.acceptance,&a.acceptance_file)?,"type":a.r#type,"status":a.status,"priority":a.priority,"assigneeId":a.assignee,"parentId":a.parent.as_deref().map(|p|id(&snapshot,"issues",p)).transpose()?,"workspaceIds":a.workspace.iter().map(|w|id(&snapshot,"workspaces",w)).collect::<Result<Vec<_>>>()?,"labels":a.label}),
                )
            }
            IssueCommand::Update(p) => patch(&snapshot, "issue", p)?,
            IssueCommand::Link { from, to, kind } => {
                json!({"kind":"link.add","id":uid(),"data":{"fromId":id(&snapshot,"issues",from)?,"toId":id(&snapshot,"issues",to)?,"kind":kind}})
            }
            IssueCommand::Unlink { id } => json!({"kind":"link.remove","id":id}),
            IssueCommand::Comment(note)
            | IssueCommand::Checkpoint(note)
            | IssueCommand::Evidence(note) => {
                json!({"kind":"comment.add","id":uid(),"data":{"issueId":id(&snapshot,"issues",&note.issue)?,"body":input(&note.body)?,"kind":match &args.command {IssueCommand::Checkpoint(_)=>"checkpoint",IssueCommand::Evidence(_)=>"evidence",_=>"comment"}}})
            }
            IssueCommand::Batch { data } => {
                let mutations: Vec<Value> = serde_json::from_str(&input(data)?)?;
                return r.submit(ctx, args.scope.offline, mutations);
            }
            IssueCommand::Claim {
                issue,
                agent,
                ttl,
                delegation,
            } => {
                let mut data = json!({"agent":agent,"ttlSeconds":ttl});
                delegate(&snapshot, delegation, &mut data)?;
                json!({"kind":"issue.claim","id":id(&snapshot,"issues",issue)?,"data":data})
            }
            IssueCommand::Ask {
                issue,
                kind,
                prompt,
                choices,
                secret,
                route_to,
                lease_token,
            } => {
                let mut data = json!({"issueId":id(&snapshot,"issues",issue)?,"kind":kind,"prompt":input(prompt)?});
                if !choices.is_empty() {
                    data["choices"] = json!(choices);
                }
                if let Some(target) = secret {
                    let (repo, name) = target.split_once(':').ok_or_else(|| {
                        GmError::usage("--secret is owner/repo:NAME, e.g. orbit/app:DEPLOY_TOKEN.")
                    })?;
                    data["secret"] = json!({"repo":repo,"name":name});
                }
                if let Some(slug) = route_to {
                    let member = snapshot["members"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .find(|m| m["slug"] == slug.as_str() || m["id"] == slug.as_str())
                        .ok_or_else(|| {
                            GmError::usage(format!("{slug} isn't a member of this tracker."))
                        })?;
                    data["routeTo"] = member["id"].clone();
                }
                if let Some(token) = lease_token {
                    data["leaseToken"] = json!(token);
                }
                json!({"kind":"request.open","id":uid(),"data":data})
            }
            IssueCommand::Handoff { lease, to, ttl } => {
                let mut data = json!({"leaseToken":lease.lease_token,"ttlSeconds":ttl});
                if let Some(to) = to {
                    let found = ["agents", "members"]
                        .iter()
                        .flat_map(|t| snapshot[*t].as_array().into_iter().flatten())
                        .find(|a| {
                            a["id"] == to.as_str()
                                || a["name"] == to.as_str()
                                || a["slug"] == to.as_str()
                        })
                        .ok_or_else(|| {
                            GmError::usage(format!("No agent or member {to} in this tracker."))
                        })?;
                    data["toActorId"] = found["id"].clone();
                }
                json!({"kind":"issue.offer","id":id(&snapshot,"issues",&lease.issue)?,"data":data})
            }
            IssueCommand::Withdraw(lease) => {
                json!({"kind":"issue.withdraw","id":id(&snapshot,"issues",&lease.issue)?,"data":{"leaseToken":lease.lease_token}})
            }
            IssueCommand::Accept { code, agent, ttl } => {
                // A code starts with its issue's key: ENG-12.<secret>.
                let key = code.split_once('.').map(|(k, _)| k).ok_or_else(|| {
                    GmError::usage("That isn't a handoff code (ISSUE-KEY.secret).")
                })?;
                let mut data = json!({"code":code,"ttlSeconds":ttl});
                if let Some(agent) = agent {
                    data["agent"] = json!(agent);
                }
                json!({"kind":"issue.accept","id":id(&snapshot,"issues",key)?,"data":data})
            }
            IssueCommand::Resume { issue, ttl } => {
                json!({"kind":"issue.resume","id":id(&snapshot,"issues",issue)?,"data":{"ttlSeconds":ttl}})
            }
            IssueCommand::Revoke { issue, under_token } => {
                json!({"kind":"issue.revoke","id":id(&snapshot,"issues",issue)?,"data":{"underToken":under_token}})
            }
            IssueCommand::Next {
                agent,
                team,
                workspace,
                under,
                ttl,
                delegation,
            } => {
                let mut data = json!({"agent":agent,"ttlSeconds":ttl});
                delegate(&snapshot, delegation, &mut data)?;
                if let Some(t) = team {
                    data["teamId"] = json!(id(&snapshot, "teams", t)?);
                }
                if let Some(w) = workspace {
                    data["workspaceId"] = json!(id(&snapshot, "workspaces", w)?);
                }
                if let Some(u) = under {
                    data["underId"] = json!(id(&snapshot, "issues", u)?);
                }
                json!({"kind":"issue.next","id":uid(),"data":data})
            }
            IssueCommand::Renew { lease, ttl } => {
                json!({"kind":"issue.renew","id":id(&snapshot,"issues",&lease.issue)?,"data":{"leaseToken":lease.lease_token,"ttlSeconds":ttl}})
            }
            IssueCommand::Release(lease) => {
                json!({"kind":"issue.release","id":id(&snapshot,"issues",&lease.issue)?,"data":{"leaseToken":lease.lease_token}})
            }
            IssueCommand::Complete { lease, evidence } => {
                json!({"kind":"issue.complete","id":id(&snapshot,"issues",&lease.issue)?,"data":{"leaseToken":lease.lease_token,"evidence":input(evidence)?}})
            }
        };
        if lease_command {
            let mut request = json!({"operationId":uid(),"mutations":[mutation]});
            if ctx.dry_run {
                redact(&mut request);
                return Ok(Shown(json!({"dryRun":true,"request":request})));
            }
            // Lease secrets are never persisted, even in a pending outbox. An
            // ambiguous lease response is reported, never represented as success.
            let mut response=remote::api(&r.config,"POST",&r.path("mutate"),Some(&request)).map_err(|e|e.hint("Lease outcome may be uncertain after transport failure. Inspect the issue online; do not assume ownership without the returned fencing token."))?;
            if !response["results"].is_array()
                || !response["events"].is_array()
                || (matches!(
                    args.command,
                    IssueCommand::Claim { .. } | IssueCommand::Renew { .. }
                ) && response["results"][0]["leaseToken"].as_str().is_none())
            {
                return Err(GmError::new(
                    "uncertain_ack",
                    "The lease response was incomplete. Inspect the issue online; do not assume ownership without a fencing token.",
                ));
            }
            if let IssueCommand::Next { .. } = args.command {
                return Ok(next_result(&snapshot, &response));
            }
            if !matches!(
                args.command,
                IssueCommand::Claim { .. }
                    | IssueCommand::Renew { .. }
                    | IssueCommand::Resume { .. }
                    | IssueCommand::Accept { .. }
            ) {
                redact(&mut response);
            }
            return Ok(Shown(response));
        }
        r.submit(ctx, args.scope.offline, vec![mutation])
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot() -> Value {
        json!({"owner":{"slug":"orbit"},"teams":[],"workspaces":[],"issues":[],"links":[],"comments":[],"subscriptions":[],"cursor":0,"serverTime":"2026-10-01T00:00:00Z"})
    }
    #[test]
    fn offline_create_and_chained_updates_preserve_stable_id_and_versions() {
        let mut s = snapshot();
        project(
            &mut s,
            &json!({"kind":"issue.create","id":"stable","data":{"teamId":"eng","title":"Initial"}}),
        )
        .unwrap();
        assert!(s["issues"][0]["key"].is_null());
        project(&mut s,&json!({"kind":"issue.update","id":"stable","expectedVersion":1,"data":{"title":"First edit"}})).unwrap();
        project(&mut s,&json!({"kind":"issue.update","id":"stable","expectedVersion":2,"data":{"description":"Second edit"}})).unwrap();
        assert_eq!(s["issues"][0]["id"], "stable");
        assert_eq!(s["issues"][0]["version"], 3);
        assert_eq!(s["issues"][0]["title"], "First edit");
        assert_eq!(s["issues"][0]["description"], "Second edit");
        apply_event(&mut s,&json!({"entityType":"issue","entityId":"stable","entity":{"id":"stable","key":"ENG-9","version":3,"title":"First edit","description":"Second edit"}})).unwrap();
        assert_eq!(resolve(&s, "issues", "ENG-9").unwrap()["id"], "stable");
        assert_eq!(s["issues"][0]["description"], "Second edit");
    }
    #[test]
    fn canceled_blockers_and_live_leases_are_not_ready_but_expired_claims_are() {
        let now = DateTime::parse_from_rfc3339("2026-10-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut s = snapshot();
        s["issues"] =
            json!([{"id":"a","status":"canceled"},{"id":"b","status":"todo","claim":null}]);
        s["links"] = json!([{"fromId":"a","toId":"b","kind":"blocks"}]);
        assert!(!ready(&s, &s["issues"][1], now));
        s["issues"][0]["status"] = json!("done");
        assert!(ready(&s, &s["issues"][1], now));
        s["issues"][1]["status"] = json!("in_progress");
        s["issues"][1]["claim"] = json!({"expiresAt":"2026-10-01T00:01:00Z"});
        assert!(!ready(&s, &s["issues"][1], now));
        s["issues"][1]["claim"]["expiresAt"] = json!("2026-09-30T23:59:00Z");
        assert!(ready(&s, &s["issues"][1], now));
    }
    #[test]
    fn next_reports_the_claim_with_context_and_blocker_evidence_or_nothing_ready() {
        let mut s = snapshot();
        s["members"] = json!([]);
        s["agents"] = json!([]);
        s["issues"] = json!([
            {"id":"a","key":"ENG-1","status":"done","parentId":null,"claim":null},
            {"id":"b","key":"ENG-2","status":"in_progress","parentId":null,"claim":null}
        ]);
        s["links"] = json!([{"id":"l","fromId":"a","toId":"b","kind":"blocks"}]);
        s["comments"] = json!([
            {"id":"c1","issueId":"a","kind":"evidence","body":"Shipped","createdAt":"2026-10-01T00:00:00Z"},
            {"id":"c2","issueId":"a","kind":"comment","body":"Chatter","createdAt":"2026-10-01T00:00:00Z"}
        ]);
        let claimed = next_result(
            &s,
            &json!({"results":[{"issueId":"b","key":"ENG-2","leaseToken":"secret","expiresAt":"later"}]}),
        );
        assert_eq!(claimed.0["claimed"]["key"], "ENG-2");
        assert_eq!(claimed.0["claimed"]["leaseToken"], "secret");
        assert_eq!(claimed.0["context"]["issue"]["key"], "ENG-2");
        assert_eq!(claimed.0["blockerEvidence"].as_array().unwrap().len(), 1);
        let none = next_result(&s, &json!({"results":[{"id":"pick"}]}));
        assert!(none.0["claimed"].is_null());
    }
    #[test]
    fn agents_are_named_with_their_accountable_person() {
        let mut s = snapshot();
        s["members"] = json!([{"id":"acc_ann","displayName":"Ann Lee"}]);
        s["agents"] = json!([{"id":"agt_1","name":"builder","accountable":{"id":"acc_ann","displayName":"Ann Lee"}}]);
        let issue =
            json!({"id":"i","claim":{"actorId":"agt_1","agent":"session"},"assigneeId":"acc_ann"});
        let shown = named(&s, &issue);
        assert_eq!(shown["claimedBy"], "builder (for Ann Lee)");
        assert_eq!(shown["assignee"], "Ann Lee");
    }
    #[test]
    fn waiting_issues_and_parked_leases_are_not_ready() {
        let now = DateTime::parse_from_rfc3339("2026-10-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut s = snapshot();
        s["issues"] = json!([{"id":"w","status":"todo","claim":null,"parentId":null,"waiting":1}]);
        assert!(!ready(&s, &s["issues"][0], now));
        // A parked lease long past its expiry still holds.
        s["issues"][0]["waiting"] = json!(0);
        s["issues"][0]["status"] = json!("in_progress");
        s["issues"][0]["claim"] =
            json!({"expiresAt":"2026-09-01T00:00:00Z","parkedAt":"2026-08-31T00:00:00Z"});
        assert!(!ready(&s, &s["issues"][0], now));
        s["issues"][0]["claim"]
            .as_object_mut()
            .unwrap()
            .remove("parkedAt");
        assert!(ready(&s, &s["issues"][0], now));
    }
    #[test]
    fn containers_and_issues_under_another_lease_are_not_ready() {
        let now = DateTime::parse_from_rfc3339("2026-10-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut s = snapshot();
        s["issues"] = json!([
            {"id":"p","status":"todo","claim":null,"parentId":null},
            {"id":"a","status":"todo","claim":null,"parentId":"p"},
            {"id":"b","status":"done","claim":null,"parentId":"p"}
        ]);
        // An open sub-issue makes its parent a container; done ones don't count.
        assert!(!ready(&s, &s["issues"][0], now));
        assert!(ready(&s, &s["issues"][1], now));
        s["issues"][1]["status"] = json!("canceled");
        assert!(ready(&s, &s["issues"][0], now));
        // A live lease on the parent covers its subtree; an expired one doesn't.
        s["issues"][1]["status"] = json!("todo");
        s["issues"][0]["status"] = json!("in_progress");
        s["issues"][0]["claim"] = json!({"expiresAt":"2026-10-01T00:01:00Z"});
        assert!(!ready(&s, &s["issues"][1], now));
        assert!(leased_ancestor(&s, &s["issues"][1], now).is_some());
        s["issues"][0]["claim"]["expiresAt"] = json!("2026-09-30T23:59:00Z");
        assert!(ready(&s, &s["issues"][1], now));
    }
    #[test]
    fn lease_secrets_never_enter_replayable_batches_or_cached_events() {
        assert!(
            validate_batch(&[json!({"kind":"issue.claim","id":"a","data":{"agent":"worker"}})])
                .is_err()
        );
        assert!(validate_batch(&[json!({"kind":"issue.update","id":"a","expectedVersion":1,"data":{"leaseToken":"secret","status":"done"}})]).is_err());
        let mut s = snapshot();
        apply_event(&mut s,&json!({"entityType":"issue","entityId":"a","entity":{"id":"a","claim":{"agent":"worker","leaseToken":"secret"}}})).unwrap();
        assert_eq!(s["issues"][0]["claim"]["agent"], "worker");
        assert!(s["issues"][0]["claim"].get("leaseToken").is_none());
    }
    #[test]
    fn outbox_retains_uncertain_request_and_independent_later_edits() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,operation TEXT UNIQUE,body TEXT,state TEXT,error TEXT);").unwrap();
        let r = Replica {
            db,
            config: Config::default(),
            owner: "orbit".into(),
        };
        r.set("snapshot", &snapshot().to_string()).unwrap();
        let first = json!({"operationId":"one","mutations":[{"kind":"issue.create","id":"stable","data":{"title":"Offline"}}]});
        let second = json!({"operationId":"two","mutations":[{"kind":"issue.update","id":"stable","expectedVersion":1,"data":{"title":"Later"}}]});
        r.db.execute(
            "INSERT INTO outbox(operation,body,state) VALUES (?,?,?)",
            params!["one", first.to_string(), "sending"],
        )
        .unwrap();
        r.db.execute(
            "INSERT INTO outbox(operation,body,state) VALUES (?,?,?)",
            params!["two", second.to_string(), "queued"],
        )
        .unwrap();
        let queued = r.queued().unwrap();
        assert_eq!(queued[0]["request"], first);
        assert_eq!(queued[1]["request"], second);
        assert_eq!(r.view().unwrap()["issues"][0]["title"], "Later");
        // Refreshing remote state must never mutate the request awaiting its receipt.
        r.set("snapshot", &snapshot().to_string()).unwrap();
        assert_eq!(r.queued().unwrap()[0]["request"], first);
    }
}
