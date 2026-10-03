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
        if self.0.get("issueId").is_some() && self.0.get("events").is_some() {
            return history_text(&self.0);
        }
        let mut body = serde_json::to_string_pretty(&self.0).unwrap_or_default();
        // A claim leads with the issue's timeline rule, so the choice comes first.
        if let Some(rule) = self.0.get("timelineRule").filter(|r| r.is_object()) {
            body = format!(
                "Timeline: {}{}. {}\n\n{body}",
                rule["use"].as_str().unwrap_or("agent_decides"),
                rule["policy"]
                    .as_str()
                    .map(|p| format!(" ({p})"))
                    .unwrap_or_default(),
                rule["guidance"].as_str().unwrap_or(""),
            );
        }
        // An ended timeline's view stays readable, and says so (CORE-74).
        if let Some(status @ ("abandoned" | "landed")) = self.0["timeline"]["status"].as_str() {
            body = format!(
                "Timeline {} is {status}: this view is read-only.\n\n{body}",
                self.0["timeline"]["slug"].as_str().unwrap_or("?")
            );
        }
        if self.0.get("ancestors").is_some() && self.0.get("issue").is_some() {
            return format!(
                "Created by: {}\n{}\n{body}",
                self.0["issue"]["creatorDisplay"]
                    .as_str()
                    .unwrap_or("Unknown"),
                done_in_text(&self.0["issue"])
            );
        }
        body
    }
}

/// Where an issue is done while its timeline hasn't landed (CORE-74), as lines; else nothing.
fn done_in_text(issue: &Value) -> String {
    let Some(slug) = issue["doneIn"]["slug"].as_str() else {
        return String::new();
    };
    let key = issue["key"].as_str().unwrap_or("<issue>");
    if issue["status"] == "done_in_timeline" {
        format!(
            "Done in timeline {slug}: done on main when it lands; its status is locked here.\n\
             View it there: gm issue show {key} --timeline {slug} (the timeline: gm timeline show {slug}).\n"
        )
    } else {
        format!("Done in timeline {slug}, which hasn't landed yet.\n")
    }
}

/// Done in a timeline is locked wherever it shows (CORE-74), as on the server:
/// only landing, abandoning, merging or a reopen inside the timeline moves it.
fn locked_status(snapshot: &Value, mutation: &Value) -> Result<()> {
    let moves_status = match mutation["kind"].as_str().unwrap_or("") {
        "issue.update" => mutation["data"]
            .get("status")
            .is_some_and(|status| status != "done_in_timeline"),
        "issue.claim" | "issue.complete" | "issue.release" => true,
        _ => false,
    };
    let Some(issue) = find(snapshot, &mutation["id"]).filter(|_| moves_status) else {
        return Ok(());
    };
    if issue["status"] != "done_in_timeline" {
        return Ok(());
    }
    let slug = issue["doneIn"]["slug"].as_str().unwrap_or("its timeline");
    let key = issue["key"].as_str().unwrap_or("This issue");
    Err(GmError::new(
        "done_in_timeline",
        format!(
            "{key} is done in timeline {slug}; it lands with the timeline, or reopen it there with --timeline {slug}."
        ),
    )
    .hint(format!(
        "See it in the timeline: gm issue show {key} --timeline {slug}"
    )))
}

fn audit_actor(actor: &Value) -> String {
    let Some(id) = actor["id"].as_str() else {
        return "Unknown".into();
    };
    let name = actor["name"].as_str().unwrap_or(id);
    let kind = actor["kind"].as_str().unwrap_or("unknown");
    let mut label = format!("{name} [{kind}; {id}]");
    if let Some(accountable_id) = actor["accountable"]["id"].as_str() {
        let person = actor["accountable"]["displayName"]
            .as_str()
            .unwrap_or(accountable_id);
        label.push_str(&format!("; accountable: {person} [{accountable_id}]"));
    }
    label
}

fn history_text(history: &Value) -> String {
    let mut text = format!(
        "History: {}\nCreated by: {}\n",
        history["issueId"].as_str().unwrap_or("Unknown"),
        audit_actor(&history["creator"]),
    );
    for event in history["events"].as_array().into_iter().flatten() {
        text.push_str(&format!(
            "\n#{}  {}  {}\nSource: {}  Actor: {}\nMutation: {}  Operation: {}\nEntity: {} {}\nBefore:\n{}\nAfter:\n{}\n",
            event["cursor"],
            event["createdAt"].as_str().unwrap_or("Unknown time"),
            event["kind"].as_str().unwrap_or("Unknown action"),
            event["source"].as_str().unwrap_or("unknown"),
            audit_actor(&event["actor"]),
            event["mutationKind"].as_str().unwrap_or("unknown"),
            event["operationId"].as_str().unwrap_or("Unknown"),
            event["entityType"].as_str().unwrap_or("Unknown"),
            event["entityId"].as_str().unwrap_or("Unknown"),
            serde_json::to_string_pretty(&event["before"]).unwrap_or_default(),
            serde_json::to_string_pretty(&event["entity"]).unwrap_or_default(),
        ));
    }
    if history["hasMore"] == true {
        text.push_str(&format!(
            "\nMore history: repeat this command with --before {}\n",
            history["nextBefore"],
        ));
    } else {
        text.push_str("\nEnd of history.\n");
    }
    text
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
/// Lease tokens gm keeps: one private record per issue and server, with the
/// identity that took the lease (never in the replica or its outbox), so an
/// agent's next command finds its lease without the token passing through
/// prompts or shell history, and a lease taken before gm switched identity is
/// still finished as the identity that holds it. Records go when the lease
/// ends, or a day after it expires; an identity with no leases left leaves no
/// trace.
#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct Kept {
    token: String,
    identity: remote::Identity,
    /// The issue's key, for people reading `gm auth status`.
    #[serde(default)]
    issue: String,
    #[serde(default)]
    expires_at: Option<String>,
}

fn data_dir() -> Result<PathBuf> {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .map(|base| base.join("gitmatrix"))
        .ok_or_else(|| {
            GmError::new(
                "replica_path",
                "Set HOME or XDG_DATA_HOME for private tracker storage.",
            )
        })
}
fn leases_dir(config: &Config) -> Result<PathBuf> {
    Ok(data_dir()?.join("leases").join(digest(&config.server())))
}
fn checked(issue_id: &str) -> Result<&str> {
    if issue_id.is_empty()
        || !issue_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(GmError::new("invalid_input", "Unexpected issue id."));
    }
    Ok(issue_id)
}
fn keep_lease(config: &Config, issue_id: &str, kept: &Kept) -> Result<()> {
    let dir = leases_dir(config)?;
    private_dir(&dir)?;
    let mut file = private_file(&dir.join(format!("{}.json", checked(issue_id)?)))?;
    file.set_len(0)?;
    std::io::Write::write_all(&mut file, serde_json::to_string(kept)?.as_bytes())?;
    // The old per-credential file, if any, is superseded.
    if let Ok(root) = root(config) {
        let _ = fs::remove_file(root.join("leases").join(issue_id));
    }
    Ok(())
}
fn kept_lease(config: &Config, issue_id: &str) -> Option<Kept> {
    let id = checked(issue_id).ok()?;
    if let Some(kept) = fs::read_to_string(leases_dir(config).ok()?.join(format!("{id}.json")))
        .ok()
        .and_then(|text| serde_json::from_str::<Kept>(&text).ok())
    {
        return Some(kept);
    }
    // Kept by an older gm, beside the current identity's replica.
    let token = fs::read_to_string(root(config).ok()?.join("leases").join(id)).ok()?;
    (!token.is_empty()).then(|| Kept {
        token,
        identity: config.identity().unwrap_or(remote::Identity::Person),
        issue: String::new(),
        expires_at: None,
    })
}
fn drop_lease(config: &Config, issue_id: &str) {
    let Ok(id) = checked(issue_id) else { return };
    if let Ok(dir) = leases_dir(config) {
        let _ = fs::remove_file(dir.join(format!("{id}.json")));
    }
    if let Ok(root) = root(config) {
        let _ = fs::remove_file(root.join("leases").join(id));
    }
}
/// Past its expiry by more than the grace before `cutoff`. Parked leases (waiting
/// on a person) have no expiry, so they're kept until the lease ends.
fn stale(expires_at: Option<&str>, cutoff: DateTime<Utc>) -> bool {
    expires_at
        .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
        .is_some_and(|at| at < cutoff)
}

/// Every kept lease on this server, pruning those a day past expiry.
pub(crate) fn kept_leases(config: &Config) -> Vec<Kept> {
    let Ok(dir) = leases_dir(config) else {
        return Vec::new();
    };
    let cutoff = Utc::now() - chrono::Duration::days(1);
    let mut out = Vec::new();
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let Some(kept) = fs::read_to_string(entry.path())
            .ok()
            .and_then(|text| serde_json::from_str::<Kept>(&text).ok())
        else {
            continue;
        };
        let stale = stale(kept.expires_at.as_deref(), cutoff);
        if stale {
            let _ = fs::remove_file(entry.path());
        } else {
            out.push(kept);
        }
    }
    out
}
/// Leases held by identities gm no longer acts as: for `gm auth status`.
pub fn previous_identities(config: &Config) -> Value {
    let current = config.identity().ok();
    let mut by: Vec<(remote::Identity, Vec<String>)> = Vec::new();
    for kept in kept_leases(config) {
        if Some(&kept.identity) == current.as_ref() {
            continue;
        }
        match by
            .iter_mut()
            .find(|(identity, _)| *identity == kept.identity)
        {
            Some((_, issues)) => issues.push(kept.issue),
            None => by.push((kept.identity, vec![kept.issue])),
        }
    }
    json!(
        by.into_iter()
            .map(|(identity, issues)| json!({ "identity": identity.describe(), "leases": issues }))
            .collect::<Vec<_>>()
    )
}
/// The lease token to act with, given or kept, and the identity a kept one
/// belongs to.
fn lease_token(
    config: &Config,
    issue_id: &str,
    lease: &crate::tracker_cli::Lease,
) -> Result<(String, Option<remote::Identity>)> {
    if let Some(token) = &lease.lease_token {
        return Ok((token.clone(), None));
    }
    let kept = kept_lease(config, issue_id).ok_or_else(|| {
        GmError::usage(format!(
            "No lease token for {}: gm didn't claim it on this machine.",
            lease.issue
        ))
        .hint("Pass --lease-token or GM_LEASE_TOKEN, or take work with `gm issue next`. A tracker owner can take a stuck claim over with `gm issue claim --force`.")
    })?;
    Ok((kept.token, Some(kept.identity)))
}

fn root(config: &Config) -> Result<PathBuf> {
    // Never use config.user alone: GM_TOKEN may belong to a different identity.
    // Rotated credentials deliberately start a separate replica, not someone else's outbox.
    let auth = if let Some(token) = config.token()? {
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
    Ok(data_dir()?
        .join("tracker")
        .join(digest(&format!("{}\n{auth}", config.server()))))
}
/// The tracker account to act on: explicit, else `gm tracker use`, else .gitmatrix/agents.yml.
pub(crate) fn selected_owner(config: &Config, explicit: Option<String>) -> Result<String> {
    let owner = explicit
        .or_else(|| fs::read_to_string(root(config).ok()?.join("selected")).ok())
        .or_else(|| crate::profile::defaults().scope.owner)
        .ok_or_else(|| GmError::usage("Select `gm tracker use OWNER`, pass --owner OWNER, or set tracker.owner in .gitmatrix/agents.yml."))?;
    safe_owner(&owner)?;
    Ok(owner)
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
// Version 1 includes creator backfill, which did not produce change-feed events.
// Version 2 includes timelines and their events (asked for with `timelines=1`).
const SNAPSHOT_SCHEMA: &str = "2";

struct Replica {
    db: Connection,
    config: Config,
    owner: String,
    /// The timeline whose view this works in (`--timeline`); None for main.
    timeline: Option<String>,
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
    /// The base this replica views: main's snapshot, or the timeline's view as last fetched.
    /// The server projects a timeline's view (main's issues with the timeline's changes);
    /// offline, the copy fetched by the last online command stands in.
    fn base(&self) -> Result<Value> {
        let Some(slug) = &self.timeline else {
            return self.snapshot();
        };
        let raw = self.meta(&format!("view:{slug}"))?.ok_or_else(|| {
            GmError::new(
                "replica_uninitialized",
                format!("No copy of timeline {slug}'s view yet; run a command online first."),
            )
        })?;
        Ok(serde_json::from_str(&raw)?)
    }
    /// Fetch the selected timeline's view for offline use.
    fn refresh_view(&self) -> Result<()> {
        let Some(slug) = &self.timeline else {
            return Ok(());
        };
        let mut view = remote::api(
            &self.config,
            "GET",
            &self.path(&format!("snapshot?timeline={slug}")),
            None,
        )?;
        redact(&mut view);
        if !view["issues"].is_array() || !view["timeline"].is_object() {
            return Err(GmError::new("protocol_error", "Invalid timeline view."));
        }
        self.set(&format!("view:{slug}"), &serde_json::to_string(&view)?)
    }
    /// A request carries the timeline it was made in.
    fn request(&self, mutations: Value) -> Value {
        let mut request = json!({"operationId":uid(),"mutations":mutations});
        if let Some(slug) = &self.timeline {
            request["timeline"] = json!(slug);
        }
        request
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
        if self.meta("snapshot")?.is_none()
            || self.meta("snapshot_schema")?.as_deref() != Some(SNAPSHOT_SCHEMA)
        {
            let mut snapshot = remote::api(
                &self.config,
                "GET",
                &self.path("snapshot?timelines=1"),
                None,
            )?;
            redact(&mut snapshot);
            if !snapshot["issues"].is_array() || !snapshot["cursor"].is_u64() {
                return Err(GmError::new("protocol_error", "Invalid tracker snapshot."));
            }
            // Replace only the confirmed base, never queued intent or uncertain
            // receipts. Commit its schema with it so a failed refresh is retryable.
            let transaction = self.db.unchecked_transaction().map_err(db_err)?;
            self.set("snapshot", &serde_json::to_string(&snapshot)?)?;
            self.set("snapshot_schema", SNAPSHOT_SCHEMA)?;
            return transaction.commit().map_err(db_err);
        }
        // The first page also brings the current members and agents: they are
        // not events, so the snapshot alone would never learn of new ones.
        let mut directory = true;
        loop {
            let mut snapshot = self.snapshot()?;
            let before = snapshot["cursor"].as_u64().unwrap_or(0);
            let feed = remote::api(
                &self.config,
                "GET",
                &self.path(&format!(
                    "changes?after={before}&limit=200&timelines=1{}",
                    if directory { "&directory=1" } else { "" }
                )),
                None,
            )?;
            if std::mem::take(&mut directory) {
                for key in ["members", "agents", "canAdmin"] {
                    if !feed[key].is_null() {
                        snapshot[key] = feed[key].clone();
                    }
                }
            }
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
        let mut snapshot = self.base()?;
        for row in self.queued()? {
            // Queued changes to main show in every view; a timeline's only in its own.
            if !in_view(&row["request"], self.timeline.as_deref()) {
                continue;
            }
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
        self.pull()?;
        self.pull_preferences();
        self.refresh_view()
    }
    /// Your defaults for this tracker, set on the web, kept for offline use.
    /// Best effort: an older server or a failed fetch keeps what gm had.
    fn pull_preferences(&self) {
        if let Ok(reply) = remote::api(&self.config, "GET", &self.path("preferences"), None)
            && let Ok(text) = serde_json::to_string(&reply["preferences"])
        {
            let _ = self.set("preferences", &text);
        }
    }
    /// Your default team here (CORE-119), if it's still an open team.
    fn preferred_team(&self, snapshot: &Value) -> Result<Option<String>> {
        let Some(raw) = self.meta("preferences")? else {
            return Ok(None);
        };
        let preferences: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        let Some(team) = preferences["teamId"].as_str() else {
            return Ok(None);
        };
        Ok(snapshot["teams"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|t| t["id"] == team && t["archived"] != true)
            .and_then(|t| t["key"].as_str())
            .map(str::to_owned))
    }
    fn submit(&self, ctx: &Ctx, offline: bool, mutations: Vec<Value>) -> Result<Shown> {
        validate_batch(&mutations)?;
        let request = self.request(json!(mutations));
        let operation = request["operationId"].as_str().unwrap().to_string();
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
    let owner = selected_owner(&config, scope.owner.clone())?;
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
    let replica = Replica {
        db,
        config,
        owner,
        timeline: scope.timeline(),
    };
    if !scope.offline && refresh && !ctx.dry_run {
        replica.sync()?;
    }
    f(&replica)
}
/// The replica's timelines in brief, newest first: slug, name, status and parent.
fn timelines(snapshot: &Value) -> Value {
    let all = snapshot["timelines"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let slug = |id: &Value| {
        all.iter()
            .find(|t| t["id"] == *id)
            .map_or(Value::Null, |t| t["slug"].clone())
    };
    let mut out: Vec<Value> = all
        .iter()
        .map(|t| json!({"slug":t["slug"],"name":t["name"],"status":t["status"],"parent":slug(&t["parentId"]),"experimental":t["experimental"],"createdAt":t["createdAt"]}))
        .collect();
    out.sort_by(|a, b| b["createdAt"].as_str().cmp(&a["createdAt"].as_str()));
    json!(out)
}
/// Whether a queued request shows in a view: main's changes show everywhere.
fn in_view(request: &Value, timeline: Option<&str>) -> bool {
    match request["timeline"].as_str() {
        None | Some("main") => true,
        made_in => made_in == timeline,
    }
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
/// Timelines and their events: not tracker entities, kept for listing offline.
fn timeline_collection(kind: &str) -> Option<&'static str> {
    match kind {
        "timeline" => Some("timelines"),
        "timelineEvent" => Some("timelineEvents"),
        _ => None,
    }
}
fn apply_event(snapshot: &mut Value, event: &Value) -> Result<()> {
    let kind = event["entityType"].as_str().unwrap_or("");
    let table = if let Some(table) = collection(kind) {
        table
    } else if let Some(table) = timeline_collection(kind) {
        // A snapshot from before the server kept timelines starts the collection.
        if !snapshot[table].is_array() {
            snapshot[table] = json!([]);
        }
        table
    } else {
        // Entity types newer than this gm: skip them, so older binaries keep syncing.
        return Ok(());
    };
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
fn validate_close_reason(
    previous: Option<&Value>,
    data: &serde_json::Map<String, Value>,
) -> Result<()> {
    let previous_status = previous.and_then(|issue| issue["status"].as_str());
    let status = data
        .get("status")
        .and_then(Value::as_str)
        .or(previous_status)
        .unwrap_or("todo");
    let reason = data.get("closeReason");
    if status != "canceled" {
        if reason.is_some_and(|value| !value.is_null()) {
            return Err(GmError::usage(
                "closeReason is only allowed with status canceled.",
            ));
        }
        return Ok(());
    }
    if reason.is_none() && previous_status == Some("canceled") {
        // Historical canceled issues may have no reason; unrelated edits remain valid.
        return Ok(());
    }
    if !matches!(
        reason.and_then(Value::as_str),
        Some("duplicate" | "not_planned" | "obsolete" | "cannot_reproduce" | "other")
    ) {
        return Err(GmError::usage(
            "Canceled issues require closeReason: duplicate, not_planned, obsolete, cannot_reproduce or other.",
        ));
    }
    Ok(())
}

/// The timeline rule, as the server checks it: a known use, and a policy only
/// with `required`. Issues from before the field read as `agent_decides`.
fn validate_timeline(
    previous: Option<&Value>,
    data: &serde_json::Map<String, Value>,
) -> Result<()> {
    let usage = || {
        GmError::usage(
            "timelineUse is agent_decides, required or never; timelinePolicy (auto, approval or null) needs required.",
        )
    };
    let use_ = match data.get("timelineUse") {
        None => previous
            .and_then(|issue| issue["timelineUse"].as_str())
            .unwrap_or("agent_decides"),
        Some(value) => match value.as_str() {
            Some(use_ @ ("agent_decides" | "required" | "never")) => use_,
            _ => return Err(usage()),
        },
    };
    match data.get("timelinePolicy") {
        None | Some(Value::Null) => Ok(()),
        Some(value) if matches!(value.as_str(), Some("auto" | "approval")) => {
            if use_ == "required" {
                Ok(())
            } else {
                Err(usage())
            }
        }
        Some(_) => Err(usage()),
    }
}
/// An issue's timeline rule: `{use, policy}`, defaulted for issues from before it.
fn timeline_rule(issue: &Value) -> Value {
    let use_ = issue["timelineUse"].as_str().unwrap_or("agent_decides");
    let policy = if use_ == "required" {
        issue["timelinePolicy"].clone()
    } else {
        Value::Null
    };
    json!({"use": use_, "policy": policy})
}
/// What an agent claiming the issue does about timelines (the graph-work skill
/// explains): the rule, and how to record the choice it makes.
fn timeline_guidance(issue: &Value) -> Value {
    let mut rule = timeline_rule(issue);
    let key = issue["key"].as_str().unwrap_or("<issue>");
    let policy = rule["policy"].as_str();
    rule["guidance"] = json!(match rule["use"].as_str() {
        Some("required") => format!(
            "Work this issue in a timeline{}, not on main. Record it: gm issue checkpoint {key} 'Timeline: <slug>{}'.",
            policy
                .map(|p| format!(" with the {p} policy"))
                .unwrap_or_default(),
            policy.map(|p| format!(" ({p})")).unwrap_or_default(),
        ),
        Some("never") => format!(
            "Work this issue on main, not in a timeline. Record it: gm issue checkpoint {key} 'Timeline: main (the issue says never)'."
        ),
        _ => format!(
            "Your choice: read the description or PRD and comments for a request (\"do this in an approval timeline\"); otherwise choose by risk and review needs. Record it: gm issue checkpoint {key} 'Timeline: <slug> (<policy>)' or 'Timeline: main, because <why>'."
        ),
    });
    rule
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
    if entity == "issue" && data.contains_key("createdBy") {
        return Err(GmError::usage(
            "createdBy is assigned by the server and is immutable.",
        ));
    }
    if action == "update" {
        let index = index.ok_or_else(|| {
            GmError::not_found(
                "tracker_not_found",
                "Cannot update an entity missing from this replica.",
            )
        })?;
        if entity == "issue" {
            validate_close_reason(Some(&rows[index]), data)?;
            validate_timeline(Some(&rows[index]), data)?;
        }
        let row = rows[index].as_object_mut().unwrap();
        for (key, value) in data {
            if ["id", "key", "version", "createdAt", "claim", "teamId"].contains(&key.as_str()) {
                return Err(GmError::usage(format!("Immutable field '{key}'.")));
            }
            row.insert(key.clone(), value.clone());
        }
        if entity == "issue" && row.get("status").and_then(Value::as_str) != Some("canceled") {
            row.insert("closeReason".into(), Value::Null);
        }
        if entity == "issue"
            && data.contains_key("timelineUse")
            && !data.contains_key("timelinePolicy")
            && data["timelineUse"] != "required"
        {
            row.insert("timelinePolicy".into(), Value::Null);
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
        if entity == "issue" {
            validate_close_reason(None, data)?;
            validate_timeline(None, data)?;
        }
        let mut row = match entity {
            "issue" => {
                json!({"key":null,"description":"","acceptance":"","type":"task","status":"todo","closeReason":null,"timelineUse":"agent_decides","timelinePolicy":null,"priority":2,"assigneeId":null,"parentId":null,"workspaceIds":[],"labels":[],"claim":null})
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
/// `gm issue update`: the JSON patch, with the timeline flags on top.
fn issue_patch(snapshot: &Value, p: &IssuePatch) -> Result<Value> {
    let row = resolve(snapshot, "issues", &p.id)?;
    let mut data = match &p.data {
        Some(text) => object(text)?,
        None => json!({}),
    };
    timeline_fields(&p.timeline, &mut data);
    Ok(json!({"kind":"issue.update","id":row["id"],"expectedVersion":row["version"],"data":data}))
}
/// `--timeline-use`/`--timeline-policy` as `timelineUse`/`timelinePolicy` (`none` clears).
fn timeline_fields(rule: &TimelineRule, data: &mut Value) {
    if let Some(use_) = &rule.timeline_use {
        data["timelineUse"] = json!(use_);
    }
    if let Some(policy) = &rule.timeline_policy {
        data["timelinePolicy"] = if policy == "none" {
            Value::Null
        } else {
            json!(policy)
        };
    }
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
            timeline: None,
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
        TrackerCommand::Status => {
            if !args.scope.offline {
                r.pull_preferences();
            }
            let snapshot = r.view()?;
            let choice = choose_team(
                None,
                false,
                Some(&crate::profile::defaults()),
                false,
                r.preferred_team(&snapshot)?,
            );
            Ok(Shown(
                json!({"owner":r.owner,"identity":r.meta("actor")?,"defaultTeam":choice.describe(&r.owner, false),"cursor":r.snapshot()?["cursor"],"timelines":timelines(&r.snapshot()?),"operations":r.queued()?,"replica":root(&r.config)?.join(format!("{}.sqlite",r.owner)),"credentialPartitions":root(&r.config)?.parent(),"credentialRotation":"Old credential partitions remain intact. To reconnect a rotated token to its old outbox, use tracker recover with the old replica path after verifying the same identity."}),
            ))
        }
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
                r.db.execute_batch("BEGIN IMMEDIATE; INSERT INTO main.outbox(operation,body,state,error) SELECT operation,body,state,error FROM recovery.outbox ORDER BY seq; INSERT INTO main.meta(key,value) SELECT key,value FROM recovery.meta WHERE key='snapshot' ON CONFLICT(key) DO UPDATE SET value=excluded.value; DELETE FROM main.meta WHERE key='snapshot_schema'; DELETE FROM recovery.outbox; COMMIT;").map_err(db_err)?;
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
            RequestCommand::List { status, issue } => {
                let issue_id = issue
                    .as_deref()
                    .map(|key| id(&snapshot, "issues", key))
                    .transpose()?;
                let mut requests: Vec<Value> = snapshot["requests"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|q| status == "all" || q["status"] == status.as_str())
                    .filter(|q| {
                        issue_id
                            .as_ref()
                            .is_none_or(|id| q["issueId"] == id.as_str())
                    })
                    .map(|q| {
                        let mut q = q.clone();
                        let issue = find_issue(&snapshot, &q["issueId"]);
                        q["issue"] = json!({"key":issue["key"],"title":issue["title"]});
                        q["asker"] =
                            json!(actor_name(&snapshot, q["askedBy"].as_str().unwrap_or("")));
                        q["for"] =
                            json!(actor_name(&snapshot, q["routeTo"].as_str().unwrap_or("")));
                        // An approval of a timeline checkpoint: its commits, CI runs,
                        // previews and summary, read live (best effort: offline, the reference).
                        let pinned = q["checkpoint"]["timeline"]
                            .as_str()
                            .zip(q["checkpoint"]["id"].as_str())
                            .map(|(tl, cp)| format!("timelines/{tl}/checkpoints/{cp}"));
                        if let Some(Ok(view)) =
                            pinned.map(|path| remote::api(&r.config, "GET", &r.path(&path), None))
                        {
                            q["checkpointView"] = view;
                        }
                        q
                    })
                    .collect();
                requests.sort_by_key(|q| q["routeTo"] != me.as_str());
                return Ok(Shown(
                    json!({"requests":requests,"next":"People answer open requests with `gm request answer ID`. Inspect all requests for parked work with `gm request list --issue ISSUE --status all`, then `gm issue resume ISSUE` once none remain open."}),
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
/// `done_in_timeline` (finished in a timeline that hasn't landed) is neither ready nor
/// done: it keeps blocking, as on the server.
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
    let rule = timeline_rule(issue);
    out["timelineUse"] = rule["use"].clone();
    out["timelinePolicy"] = rule["policy"].clone();
    if let Some(holder) = issue["claim"]["actorId"].as_str() {
        out["claimedBy"] = json!(actor_name(snapshot, holder));
    }
    if let Some(assignee) = issue["assigneeId"].as_str() {
        out["assignee"] = json!(actor_name(snapshot, assignee));
    }
    out["creatorDisplay"] = json!(if issue["createdBy"].is_null() {
        "Unknown".to_string()
    } else if issue["createdBy"]["name"].is_null() {
        issue["createdBy"]["id"]
            .as_str()
            .map(|id| actor_name(snapshot, id))
            .unwrap_or_else(|| "Unknown".to_string())
    } else {
        audit_actor(&issue["createdBy"])
    });
    out
}
fn listing(
    snapshot: &Value,
    args: &ListIssues,
    choice: &TeamChoice,
    owner: &str,
    only_ready: bool,
    offline: bool,
) -> Result<Shown> {
    let team = choice
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
        json!({"team":choice.describe(owner, true),"issues":matching.iter().take(args.limit as usize).map(|i| named(snapshot, i)).collect::<Vec<_>>(),"total":matching.len(),"truncated":matching.len()>args.limit as usize,"offline":offline,"readinessAdvisory":true,"cursor":snapshot["cursor"],"cachedAt":snapshot["serverTime"],"timeline":snapshot["timeline"],"next":"Acquire an online claim before starting exclusive work."}),
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
        json!({"issue":named(snapshot,issue),"ancestors":ancestors,"links":links.iter().take(limit).collect::<Vec<_>>(),"relatedIssues":related,"notes":notes.iter().rev().take(limit).collect::<Vec<_>>(),"limitPerSection":limit,"truncated":{"ancestors":parent.is_some(),"links":links.len()>limit,"notes":notes.len()>limit},"ready":ready(snapshot,issue,Utc::now()),"readinessAdvisory":true,"cursor":snapshot["cursor"],"cachedAt":snapshot["serverTime"],"offline":offline,"timeline":snapshot["timeline"]}),
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
/// The claimed issue as the server returned it with the claim, else as the replica has it.
fn claimed_issue(snapshot: &Value, response: &Value, issue_id: &str) -> Option<Value> {
    response["events"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .find(|e| {
            e["entityType"] == "issue" && e["entityId"] == issue_id && e["entity"].is_object()
        })
        .map(|e| e["entity"].clone())
        .or_else(|| resolve(snapshot, "issues", issue_id).ok().cloned())
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
    let rule = claimed_issue(snapshot, response, issue_id)
        .map(|issue| timeline_guidance(&issue))
        .unwrap_or(Value::Null);
    let mut out = json!({
        "timelineRule": rule,
        "claimed": {
            "issueId": issue_id,
            "key": result["key"],
            "leaseToken": result["leaseToken"],
            "expiresAt": result["expiresAt"],
        },
        "context": context,
        "timeline": snapshot["timeline"],
        "blockerEvidence": blocker_evidence,
        "next": "Work it, checkpoint as you go (gm issue checkpoint), renew before it expires (gm issue renew), then gm issue complete with evidence. gm kept the lease token for this identity, so those commands need no token.",
    });
    if let Some(notice) = crate::profile::model_notice() {
        out["notice"] = json!(notice);
    }
    Shown(out)
}
pub fn issue(ctx: &Ctx, args: &IssueArgs) -> Result<Shown> {
    if let IssueCommand::History {
        issue,
        before,
        limit,
    } = &args.command
    {
        if args.scope.offline {
            return Err(GmError::usage(
                "Issue history requires online access; the offline replica is not an audit archive.",
            ));
        }
        let config = Config::load();
        let owner = selected_owner(&config, args.scope.owner.clone())?;
        use std::fmt::Write as _;
        let mut encoded = String::with_capacity(issue.len());
        for b in issue.bytes() {
            match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                    encoded.push(b as char)
                }
                _ => write!(&mut encoded, "%{b:02X}").expect("writing to a String"),
            }
        }
        let mut path = format!("/tracker/{owner}/issues/{encoded}/history?limit={limit}");
        if let Some(before) = before {
            path.push_str(&format!("&before={before}"));
        }
        return Ok(Shown(remote::api(&config, "GET", &path, None)?));
    }
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
            | IssueCommand::Release { .. }
            | IssueCommand::Complete { .. }
    );
    if lease_command && args.scope.offline {
        return Err(GmError::usage(
            "Claims, renewal, release and completion require online fencing. Offline readiness never grants ownership.",
        ));
    }
    // Unset flags come from .gitmatrix (`gm agent setup`).
    let defaults = crate::profile::defaults();
    let session = |agent: &Option<String>| {
        agent
            .clone()
            .or_else(|| defaults.agent.clone())
            .ok_or_else(|| {
                GmError::usage("Pass --agent <label> for your working session.")
                    .hint("Or run `gm agent setup` once, and gm uses this checkout's agent.")
            })
    };
    with_replica(&args.scope, ctx, true, |r| {
        let snapshot = r.view()?;
        // The identity holding a kept lease this command uses, if gm has switched since.
        let mut holder: Option<remote::Identity> = None;
        // The team a command picked for you, reported with its result.
        let mut picked: Option<Value> = None;
        let mutation = match &args.command {
            IssueCommand::List(a) | IssueCommand::Ready(a) => {
                let choice = choose_team(
                    a.team.as_deref(),
                    a.all_teams,
                    a.workspace.is_none().then_some(&defaults),
                    a.workspace.is_some(),
                    r.preferred_team(&snapshot)?,
                );
                let only_ready = matches!(args.command, IssueCommand::Ready(_));
                return listing(
                    &snapshot,
                    a,
                    &choice,
                    &r.owner,
                    only_ready,
                    args.scope.offline,
                );
            }
            IssueCommand::Show { issue, limit } => {
                return context(&snapshot, issue, *limit as usize, args.scope.offline);
            }
            IssueCommand::History { .. } => unreachable!("handled before opening the replica"),
            IssueCommand::Create(a) => {
                if a.description_file.as_deref() == Some(Path::new("-"))
                    && a.acceptance_file.as_deref() == Some(Path::new("-"))
                {
                    return Err(GmError::usage("Only one field can read stdin."));
                }
                let choice = choose_team(
                    a.team.as_deref(),
                    false,
                    Some(&defaults),
                    false,
                    r.preferred_team(&snapshot)?,
                );
                let Some(team) = choice.team.as_deref() else {
                    return Err(GmError::usage("Pass --team KEY for the new issue.").hint(
                        "Or set a default team: star a team in the web tracker, or set tracker.team in .gitmatrix/agents.yml.",
                    ));
                };
                let team = id(&snapshot, "teams", team)?;
                if choice.source != TeamSource::Flag {
                    picked = Some(choice.describe(&r.owner, false));
                }
                let mut mutation = create(
                    "issue",
                    json!({"teamId":team,"title":a.title,"description":markdown(&a.description,&a.description_file)?,"acceptance":markdown(&a.acceptance,&a.acceptance_file)?,"type":a.r#type,"status":a.status,"closeReason":a.close_reason,"priority":a.priority,"assigneeId":a.assignee,"parentId":a.parent.as_deref().map(|p|id(&snapshot,"issues",p)).transpose()?,"workspaceIds":a.workspace.iter().map(|w|id(&snapshot,"workspaces",w)).collect::<Result<Vec<_>>>()?,"labels":a.label}),
                );
                timeline_fields(&a.timeline, &mut mutation["data"]);
                mutation
            }
            IssueCommand::Update(p) => issue_patch(&snapshot, p)?,
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
                for mutation in &mutations {
                    locked_status(&snapshot, mutation)?;
                }
                return r.submit(ctx, args.scope.offline, mutations);
            }
            IssueCommand::Claim {
                issue,
                agent,
                ttl,
                delegation,
                force,
            } => {
                let mut data =
                    json!({"agent":session(agent)?,"ttlSeconds":ttl.unwrap_or(defaults.ttl)});
                delegate(&snapshot, delegation, &mut data)?;
                if *force {
                    data["force"] = json!(true);
                }
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
                checkpoint,
            } => {
                let mut data = json!({"issueId":id(&snapshot,"issues",issue)?,"kind":kind,"prompt":input(prompt)?});
                if let Some(checkpoint) = checkpoint {
                    if kind != "approval" {
                        return Err(GmError::usage("Only --kind approval names a --checkpoint."));
                    }
                    data["checkpoint"] = json!(checkpoint);
                }
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
                // Holding the issue's lease (given, or kept from claiming it) parks it while you wait.
                let issue_id = id(&snapshot, "issues", issue)?;
                let kept = if lease_token.is_some() {
                    None
                } else {
                    kept_lease(&r.config, &issue_id)
                };
                if let Some(token) = lease_token
                    .clone()
                    .or_else(|| kept.as_ref().map(|k| k.token.clone()))
                {
                    data["leaseToken"] = json!(token);
                }
                holder = kept.map(|k| k.identity);
                json!({"kind":"request.open","id":uid(),"data":data})
            }
            IssueCommand::Handoff { lease, to, ttl } => {
                let issue_id = id(&snapshot, "issues", &lease.issue)?;
                let (token, kept_by) = lease_token(&r.config, &issue_id, lease)?;
                holder = kept_by;
                let mut data = json!({"leaseToken":token,"ttlSeconds":ttl});
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
                let issue_id = id(&snapshot, "issues", &lease.issue)?;
                let (token, kept_by) = lease_token(&r.config, &issue_id, lease)?;
                holder = kept_by;
                json!({"kind":"issue.withdraw","id":issue_id,"data":{"leaseToken":token}})
            }
            IssueCommand::Accept { code, agent, ttl } => {
                // A code starts with its issue's key: ENG-12.<secret>.
                let key = code.split_once('.').map(|(k, _)| k).ok_or_else(|| {
                    GmError::usage("That isn't a handoff code (ISSUE-KEY.secret).")
                })?;
                let mut data = json!({"code":code,"ttlSeconds":ttl.unwrap_or(defaults.ttl)});
                if let Some(agent) = agent {
                    data["agent"] = json!(agent);
                }
                json!({"kind":"issue.accept","id":id(&snapshot,"issues",key)?,"data":data})
            }
            IssueCommand::Resume { issue, ttl } => {
                json!({"kind":"issue.resume","id":id(&snapshot,"issues",issue)?,"data":{"ttlSeconds":ttl.unwrap_or(defaults.ttl)}})
            }
            IssueCommand::Revoke { issue, under_token } => {
                json!({"kind":"issue.revoke","id":id(&snapshot,"issues",issue)?,"data":{"underToken":under_token}})
            }
            IssueCommand::Next {
                agent,
                team,
                all_teams,
                workspace,
                under,
                ttl,
                delegation,
            } => {
                let mut data =
                    json!({"agent":session(agent)?,"ttlSeconds":ttl.unwrap_or(defaults.ttl)});
                delegate(&snapshot, delegation, &mut data)?;
                // No scope given: this checkout's, else the project's (.gitmatrix/agents.yml),
                // else your default team.
                let configured = team.is_none() && workspace.is_none() && under.is_none();
                let (workspace, under) = if configured {
                    (&defaults.scope.workspace, &defaults.scope.under)
                } else {
                    (workspace, under)
                };
                let choice = choose_team(
                    team.as_deref(),
                    *all_teams,
                    configured.then_some(&defaults),
                    workspace.is_some() || under.is_some(),
                    r.preferred_team(&snapshot)?,
                );
                picked = Some(choice.describe(&r.owner, true));
                if let Some(t) = &choice.team {
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
                let issue_id = id(&snapshot, "issues", &lease.issue)?;
                let (token, kept_by) = lease_token(&r.config, &issue_id, lease)?;
                holder = kept_by;
                json!({"kind":"issue.renew","id":issue_id,"data":{"leaseToken":token,"ttlSeconds":ttl.unwrap_or(defaults.ttl)}})
            }
            IssueCommand::Release { lease, force } => {
                let issue_id = id(&snapshot, "issues", &lease.issue)?;
                if *force {
                    json!({"kind":"issue.release","id":issue_id,"data":{"force":true}})
                } else {
                    let (token, kept_by) = lease_token(&r.config, &issue_id, lease)?;
                    holder = kept_by;
                    json!({"kind":"issue.release","id":issue_id,"data":{"leaseToken":token}})
                }
            }
            IssueCommand::Complete { lease, evidence } => {
                let issue_id = id(&snapshot, "issues", &lease.issue)?;
                let (token, kept_by) = lease_token(&r.config, &issue_id, lease)?;
                holder = kept_by;
                json!({"kind":"issue.complete","id":issue_id,"data":{"leaseToken":token,"evidence":input(evidence)?}})
            }
        };
        locked_status(&snapshot, &mutation)?;
        if lease_command {
            let mut request = r.request(json!([mutation]));
            if ctx.dry_run {
                redact(&mut request);
                return Ok(Shown(json!({"dryRun":true,"request":request})));
            }
            // Lease secrets are never persisted, even in a pending outbox. An
            // ambiguous lease response is reported, never represented as success.
            let target = mutation["id"].as_str().unwrap_or_default().to_string();
            // A lease taken before gm switched identity is finished as the identity holding it.
            let current = r.config.identity()?;
            let switched = holder.clone().filter(|identity| *identity != current);
            let lease_config = match &switched {
                Some(identity) => r.config.acting_as(identity)?,
                None => r.config.clone(),
            };
            let mut response = match remote::api(
                &lease_config,
                "POST",
                &r.path("mutate"),
                Some(&request),
            ) {
                Ok(response) => response,
                Err(e) => {
                    // A kept token the server no longer honours is of no further use.
                    if e.code == "conflict"
                        && e.message.starts_with("Claim expired, was superseded")
                    {
                        drop_lease(&r.config, &target);
                    }
                    return Err(e.hint("Lease outcome may be uncertain after transport failure. Inspect the issue online; do not assume ownership without the returned fencing token."));
                }
            };
            if !response["results"].is_array()
                || !response["events"].is_array()
                || (matches!(
                    args.command,
                    IssueCommand::Claim { .. } | IssueCommand::Renew { .. }
                ) && response["results"][0]["leaseToken"].as_str().is_none())
                || (matches!(args.command, IssueCommand::Ask { .. })
                    && response["results"][0]["id"].as_str() != Some(target.as_str()))
            {
                return Err(GmError::new(
                    "uncertain_ack",
                    "The lease response was incomplete. Inspect the issue online; do not assume ownership without a fencing token.",
                ));
            }
            // Keep the newest token for the issue it holds; forget it once the lease ends.
            let result = &response["results"][0];
            match &args.command {
                IssueCommand::Complete { .. } | IssueCommand::Release { .. } => {
                    drop_lease(&r.config, &target)
                }
                _ => {
                    let (issue, token, expires_at) =
                        if matches!(args.command, IssueCommand::Ask { .. }) {
                            // Parking keeps the submitted token, but removes its deadline.
                            (
                                mutation["data"]["issueId"].as_str().unwrap_or(&target),
                                mutation["data"]["leaseToken"].as_str(),
                                None,
                            )
                        } else {
                            (
                                result["issueId"].as_str().unwrap_or(&target),
                                result["leaseToken"].as_str(),
                                result["expiresAt"].as_str(),
                            )
                        };
                    if let Some(token) = token {
                        let key = snapshot["issues"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .find(|i| i["id"] == issue)
                            .and_then(|i| i["key"].as_str())
                            .or(result["key"].as_str())
                            .unwrap_or(issue);
                        keep_lease(
                            &r.config,
                            issue,
                            &Kept {
                                token: token.to_string(),
                                identity: holder.clone().unwrap_or(current.clone()),
                                issue: key.to_string(),
                                expires_at: expires_at.map(str::to_string),
                            },
                        )?;
                    }
                }
            }
            if let Some(identity) = &switched {
                response["actedAs"] = json!(identity.describe());
            }
            if let IssueCommand::Next { .. } = args.command {
                let mut shown = next_result(&snapshot, &response);
                shown.0["intervention"] = json!({
                    "mode": defaults.intervention,
                    "guidance": defaults.intervention.guidance(),
                });
                if let Some(team) = picked {
                    shown.0["team"] = team;
                }
                return Ok(shown);
            }
            if let IssueCommand::Claim { .. } = args.command
                && let Some(issue) = claimed_issue(&snapshot, &response, &target)
            {
                response["timelineRule"] = timeline_guidance(&issue);
            }
            if matches!(
                args.command,
                IssueCommand::Claim { .. }
                    | IssueCommand::Resume { .. }
                    | IssueCommand::Accept { .. }
            ) {
                response["intervention"] = json!({
                    "mode": defaults.intervention,
                    "guidance": defaults.intervention.guidance(),
                });
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
        let mut shown = r.submit(ctx, args.scope.offline, vec![mutation])?;
        if let Some(team) = picked {
            shown.0["team"] = team;
        }
        Ok(shown)
    })
}

#[derive(Debug, PartialEq, Clone, Copy)]
enum TeamSource {
    Flag,
    AllTeams,
    Checkout,
    Project,
    /// A workspace or parent narrows the command instead.
    Narrowed,
    Default,
    None,
}

/// The team a command works in, and why.
#[derive(Debug)]
struct TeamChoice {
    team: Option<String>,
    source: TeamSource,
}

/// Which team a command uses (CORE-119), most specific first: `--team`, this
/// checkout's scope, the project's, then your default team from the web, else
/// all teams. `configured` is the .gitmatrix scope when it applies; a command
/// already narrowed by a workspace or parent doesn't take your default team.
fn choose_team(
    flag: Option<&str>,
    all_teams: bool,
    configured: Option<&crate::profile::Defaults>,
    narrowed: bool,
    preferred: Option<String>,
) -> TeamChoice {
    let choice = |team: Option<String>, source| TeamChoice { team, source };
    if all_teams {
        return choice(None, TeamSource::AllTeams);
    }
    if let Some(team) = flag {
        return choice(Some(team.to_owned()), TeamSource::Flag);
    }
    if let Some(d) = configured
        && let Some(team) = &d.scope.team
    {
        let source = if d.team_from == Some(crate::profile::LOCAL_FILE) {
            TeamSource::Checkout
        } else {
            TeamSource::Project
        };
        return choice(Some(team.clone()), source);
    }
    if narrowed {
        return choice(None, TeamSource::Narrowed);
    }
    match preferred {
        Some(team) => choice(Some(team), TeamSource::Default),
        None => choice(None, TeamSource::None),
    }
}

impl TeamChoice {
    /// `widen`: the command takes --all-teams.
    fn describe(&self, owner: &str, widen: bool) -> Value {
        let (source, why) = match self.source {
            TeamSource::Flag => ("flag", "--team".to_owned()),
            TeamSource::AllTeams => ("all-teams", "--all-teams".to_owned()),
            TeamSource::Checkout => (
                "checkout",
                format!("this checkout's scope ({})", crate::profile::LOCAL_FILE),
            ),
            TeamSource::Project => (
                "project",
                format!("the project's scope ({})", crate::profile::PROJECT_FILE),
            ),
            TeamSource::Narrowed => (
                "scope",
                "all teams: a workspace or parent scope narrows this instead".to_owned(),
            ),
            TeamSource::Default => (
                "default",
                format!("your default team in {owner}, set in the web tracker"),
            ),
            TeamSource::None => (
                "none",
                format!("all teams: no team given and no default team in {owner}"),
            ),
        };
        let flags = if widen {
            "Pass --team KEY or --all-teams"
        } else {
            "Pass --team KEY"
        };
        let change = match self.source {
            TeamSource::Default | TeamSource::None => {
                format!("{flags}; star a team in the web tracker to change your default.")
            }
            _ => format!("{flags} to choose another."),
        };
        json!({"key":self.team,"source":source,"why":why,"change":change})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_entity_types_are_skipped_and_timelines_kept() {
        let mut s = snapshot();
        let before = s.clone();
        apply_event(
            &mut s,
            &json!({"entityType":"discussion","entityId":"d","entity":{"id":"d"}}),
        )
        .unwrap();
        assert_eq!(s, before, "an entity type newer than gm changes nothing");
        apply_event(&mut s,&json!({"entityType":"timeline","entityId":"tl_1","entity":{"id":"tl_1","slug":"search","name":"Search","status":"active","parentId":null,"createdAt":"2026-10-03T00:00:00Z"}})).unwrap();
        apply_event(&mut s,&json!({"entityType":"timeline","entityId":"tl_2","entity":{"id":"tl_2","slug":"ranking","name":"Ranking","status":"active","parentId":"tl_1","createdAt":"2026-10-03T01:00:00Z"}})).unwrap();
        apply_event(&mut s,&json!({"entityType":"timelineEvent","entityId":"fork:tl_1","entity":{"id":"fork:tl_1","seq":1,"kind":"fork"}})).unwrap();
        apply_event(&mut s,&json!({"entityType":"timeline","entityId":"tl_1","entity":{"id":"tl_1","slug":"search","name":"Search","status":"abandoned","parentId":null,"createdAt":"2026-10-03T00:00:00Z"}})).unwrap();
        assert_eq!(s["timelineEvents"][0]["kind"], "fork");
        assert_eq!(
            timelines(&s),
            json!([
                {"slug":"ranking","name":"Ranking","status":"active","parent":"search","experimental":null,"createdAt":"2026-10-03T01:00:00Z"},
                {"slug":"search","name":"Search","status":"abandoned","parent":null,"experimental":null,"createdAt":"2026-10-03T00:00:00Z"},
            ])
        );
    }
    #[test]
    fn timeline_changes_show_in_their_own_view_and_mains_everywhere() {
        let main = json!({"mutations":[]});
        let search = json!({"mutations":[],"timeline":"search"});
        assert!(in_view(&main, None));
        assert!(in_view(&main, Some("search")));
        assert!(in_view(&search, Some("search")));
        assert!(!in_view(&search, None));
        assert!(!in_view(&search, Some("ranking")));
        let scope = |timeline: Option<&str>| Scope {
            owner: None,
            offline: false,
            timeline: timeline.map(str::to_string),
        };
        assert_eq!(scope(Some("main")).timeline(), None);
        assert_eq!(scope(Some("")).timeline(), None);
        assert_eq!(scope(Some("search")).timeline().as_deref(), Some("search"));
    }
    #[test]
    fn kept_leases_remember_who_took_them_and_expire() {
        let kept = Kept {
            token: "t".into(),
            identity: remote::Identity::Agent {
                name: "builder".into(),
            },
            issue: "CORE-1".into(),
            expires_at: Some("2026-10-02T12:00:00Z".into()),
        };
        let text = serde_json::to_string(&kept).unwrap();
        assert!(text.contains(r#""identity":{"kind":"agent","name":"builder"}"#));
        let back: Kept = serde_json::from_str(&text).unwrap();
        assert_eq!(back.identity, kept.identity);
        assert_eq!(back.identity.describe(), "your agent builder");
        assert_eq!(remote::Identity::Person.describe(), "you");
        let cutoff = |at: &str| {
            DateTime::parse_from_rfc3339(at)
                .unwrap()
                .with_timezone(&Utc)
        };
        // A day of grace after expiry, so a renew racing the clock isn't lost.
        assert!(!stale(
            kept.expires_at.as_deref(),
            cutoff("2026-10-02T11:00:00Z")
        ));
        assert!(stale(
            kept.expires_at.as_deref(),
            cutoff("2026-10-02T13:00:00Z")
        ));
        assert!(!stale(None, cutoff("2030-01-01T00:00:00Z")));
    }

    fn snapshot() -> Value {
        json!({"owner":{"slug":"orbit"},"teams":[],"workspaces":[],"issues":[],"links":[],"comments":[],"subscriptions":[],"cursor":0,"serverTime":"2026-10-01T00:00:00Z"})
    }
    #[test]
    fn creator_is_unknown_offline_and_immutable_after_confirmation() {
        let mut s = snapshot();
        project(
            &mut s,
            &json!({"kind":"issue.create","id":"a","data":{"title":"Offline"}}),
        )
        .unwrap();
        assert!(s["issues"][0]["createdBy"].is_null());
        let creator = json!({"id":"agent-a","kind":"agent","name":"Builder","accountable":{"id":"person-a","displayName":"Ann"}});
        apply_event(&mut s, &json!({"entityType":"issue","entityId":"a","entity":{"id":"a","key":"ENG-1","title":"Confirmed","version":1,"createdBy":creator}})).unwrap();
        project(
            &mut s,
            &json!({"kind":"issue.update","id":"a","expectedVersion":1,"data":{"title":"Edited"}}),
        )
        .unwrap();
        assert_eq!(s["issues"][0]["createdBy"], creator);
        let before = s.clone();
        for (kind, id) in [("issue.update", "a"), ("issue.create", "b")] {
            assert!(project(&mut s, &json!({"kind":kind,"id":id,"expectedVersion":2,"data":{"createdBy":{"id":"forged"}}})).is_err());
            assert_eq!(s, before);
        }
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
    fn offline_closure_preserves_reason_until_reopened_or_done() {
        for next_status in ["todo", "done"] {
            let mut s = snapshot();
            project(
                &mut s,
                &json!({"kind":"issue.create","id":"a","data":{"status":"canceled","closeReason":"duplicate"}}),
            )
            .unwrap();
            project(
                &mut s,
                &json!({"kind":"issue.update","id":"a","expectedVersion":1,"data":{"title":"Updated"}}),
            )
            .unwrap();
            assert_eq!(s["issues"][0]["closeReason"], "duplicate");
            project(
                &mut s,
                &json!({"kind":"issue.update","id":"a","expectedVersion":2,"data":{"status":next_status}}),
            )
            .unwrap();
            assert_eq!(s["issues"][0]["status"], next_status);
            assert!(s["issues"][0]["closeReason"].is_null());
            assert_eq!(s["issues"][0]["version"], 3);
            let before = s.clone();
            assert!(project(
                &mut s,
                &json!({"kind":"issue.update","id":"a","expectedVersion":3,"data":{"status":"canceled"}}),
            )
            .is_err());
            assert_eq!(s, before);
            project(
                &mut s,
                &json!({"kind":"issue.update","id":"a","expectedVersion":3,"data":{"status":"canceled","closeReason":"obsolete"}}),
            )
            .unwrap();
            assert_eq!(s["issues"][0]["closeReason"], "obsolete");
            assert_eq!(s["issues"][0]["version"], 4);
        }
    }

    #[test]
    fn offline_invalid_closures_do_not_change_projected_state() {
        for data in [
            json!({"status":"canceled"}),
            json!({"status":"canceled","closeReason":null}),
            json!({"status":"canceled","closeReason":"unknown"}),
            json!({"status":"canceled","closeReason":7}),
            json!({"status":"todo","closeReason":"other"}),
            json!({"closeReason":"other"}),
        ] {
            let mut s = snapshot();
            let before = s.clone();
            assert!(
                project(&mut s, &json!({"kind":"issue.create","id":"a","data":data}),).is_err()
            );
            assert_eq!(s, before);
            s["issues"] = json!([{"id":"a","status":"todo","version":1}]);
            let before = s.clone();
            assert!(
                project(
                    &mut s,
                    &json!({"kind":"issue.update","id":"a","expectedVersion":1,"data":data}),
                )
                .is_err()
            );
            assert_eq!(s, before);
        }
    }

    #[test]
    fn offline_historical_closure_allows_edits_but_not_clearing_reason() {
        let mut s = snapshot();
        s["issues"] = json!([{"id":"a","status":"canceled","version":1}]);
        project(
            &mut s,
            &json!({"kind":"issue.update","id":"a","expectedVersion":1,"data":{"title":"Historical edit"}}),
        )
        .unwrap();
        assert_eq!(s["issues"][0]["title"], "Historical edit");
        assert!(s["issues"][0]["closeReason"].is_null());
        for reason in [Value::Null, json!("invalid")] {
            let before = s.clone();
            assert!(project(
                &mut s,
                &json!({"kind":"issue.update","id":"a","expectedVersion":2,"data":{"closeReason":reason}}),
            )
            .is_err());
            assert_eq!(s, before);
        }
        project(
            &mut s,
            &json!({"kind":"issue.update","id":"a","expectedVersion":2,"data":{"closeReason":"not_planned"}}),
        )
        .unwrap();
        assert_eq!(s["issues"][0]["closeReason"], "not_planned");
        let before = s.clone();
        assert!(project(
            &mut s,
            &json!({"kind":"issue.update","id":"a","expectedVersion":3,"data":{"status":"done","closeReason":"other"}}),
        )
        .is_err());
        assert_eq!(s, before);
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
    fn done_in_a_timeline_blocks_is_not_ready_and_says_where() {
        let now = DateTime::parse_from_rfc3339("2026-10-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut s = snapshot();
        s["issues"] = json!([{"id":"a","status":"todo","claim":null},{"id":"b","status":"todo","claim":null}]);
        s["links"] = json!([{"fromId":"a","toId":"b","kind":"blocks"}]);
        // The server's change, as any replica (old or new) applies it: an unknown status is data.
        let done_in = json!({"id":"tl_1","slug":"search"});
        apply_event(&mut s, &json!({"entityType":"issue","entityId":"a","entity":{"id":"a","key":"ENG-1","status":"done_in_timeline","doneIn":done_in,"claim":null}})).unwrap();
        let a = find(&s, &json!("a")).unwrap().clone();
        let b = find(&s, &json!("b")).unwrap().clone();
        assert!(!ready(&s, &a, now));
        assert!(!ready(&s, &b, now));
        assert!(is_open(&a));
        let shown = Shown(json!({"issue":a,"ancestors":[]})).text();
        assert!(
            shown.contains(
                "Done in timeline search: done on main when it lands; its status is locked here."
            ),
            "{shown}"
        );
        assert!(
            shown.contains("View it there: gm issue show ENG-1 --timeline search"),
            "{shown}"
        );
        // Changing its status here is refused before anything is queued, with the way there.
        for mutation in [
            json!({"kind":"issue.update","id":"a","data":{"status":"todo"}}),
            json!({"kind":"issue.update","id":"a","data":{"status":"done"}}),
            json!({"kind":"issue.claim","id":"a","data":{"agent":"w"}}),
            json!({"kind":"issue.complete","id":"a","data":{}}),
        ] {
            let error = locked_status(&s, &mutation).unwrap_err();
            assert_eq!(error.code, "done_in_timeline");
            assert!(error.message.contains("ENG-1 is done in timeline search; it lands with the timeline, or reopen it there with --timeline search."), "{}", error.message);
            assert_eq!(
                error.hint.as_deref(),
                Some("See it in the timeline: gm issue show ENG-1 --timeline search")
            );
        }
        // Other fields stay editable; other issues aren't affected.
        locked_status(&s, &json!({"kind":"issue.update","id":"a","data":{"title":"x","status":"done_in_timeline"}})).unwrap();
        locked_status(
            &s,
            &json!({"kind":"issue.update","id":"b","data":{"status":"done"}}),
        )
        .unwrap();
        // An ended timeline's view says it's read-only.
        let ended =
            Shown(json!({"issues":[],"timeline":{"slug":"search","status":"abandoned"}})).text();
        assert!(
            ended.starts_with("Timeline search is abandoned: this view is read-only."),
            "{ended}"
        );
        assert_eq!(done_in_text(&json!({"status":"todo"})), "");
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
        // An issue from before the timeline field leaves the choice to the agent.
        assert_eq!(claimed.0["timelineRule"]["use"], "agent_decides");
        assert_eq!(
            claimed.0["context"]["issue"]["timelineUse"],
            "agent_decides"
        );
        assert!(claimed.0["context"]["issue"]["timelinePolicy"].is_null());
        let none = next_result(&s, &json!({"results":[{"id":"pick"}]}));
        assert!(none.0["claimed"].is_null());
        assert!(none.0.get("timelineRule").is_none());
    }
    #[test]
    fn claims_lead_with_the_timeline_rule_from_the_server_issue() {
        let mut s = snapshot();
        s["members"] = json!([]);
        s["agents"] = json!([]);
        s["issues"] =
            json!([{"id":"b","key":"ENG-2","status":"todo","parentId":null,"claim":null}]);
        // The claim's event carries the server's issue, newer than the replica's.
        let response = json!({
            "events":[{"entityType":"issue","entityId":"b","entity":{"id":"b","key":"ENG-2","timelineUse":"required","timelinePolicy":"approval"}}],
            "results":[{"issueId":"b","key":"ENG-2","leaseToken":"secret","expiresAt":"later"}],
        });
        let claimed = next_result(&s, &response);
        assert_eq!(
            claimed.0["timelineRule"],
            json!({"use":"required","policy":"approval","guidance":"Work this issue in a timeline with the approval policy, not on main. Record it: gm issue checkpoint ENG-2 'Timeline: <slug> (approval)'."})
        );
        assert!(
            claimed
                .text()
                .starts_with("Timeline: required (approval). Work this issue")
        );
        let never = timeline_guidance(
            &json!({"key":"ENG-3","timelineUse":"never","timelinePolicy":"auto"}),
        );
        assert!(never["policy"].is_null());
        assert!(never["guidance"].as_str().unwrap().contains("on main"));
        let open = timeline_guidance(&json!({"key":"ENG-4"}));
        assert!(
            open["guidance"]
                .as_str()
                .unwrap()
                .contains("description or PRD")
        );
    }
    #[test]
    fn offline_timeline_rules_match_the_server() {
        let mut s = snapshot();
        project(
            &mut s,
            &json!({"kind":"issue.create","id":"a","data":{"title":"T"}}),
        )
        .unwrap();
        assert_eq!(s["issues"][0]["timelineUse"], "agent_decides");
        assert!(s["issues"][0]["timelinePolicy"].is_null());
        let before = s.clone();
        for data in [
            json!({"timelineUse":"sometimes"}),
            json!({"timelineUse":null}),
            json!({"timelinePolicy":"auto"}),
            json!({"timelineUse":"never","timelinePolicy":"approval"}),
            json!({"timelineUse":"required","timelinePolicy":"manual"}),
        ] {
            assert!(
                project(
                    &mut s,
                    &json!({"kind":"issue.update","id":"a","expectedVersion":1,"data":data})
                )
                .is_err(),
                "{data}"
            );
            assert_eq!(s, before);
        }
        project(&mut s, &json!({"kind":"issue.update","id":"a","expectedVersion":1,"data":{"timelineUse":"required","timelinePolicy":"auto"}})).unwrap();
        assert_eq!(s["issues"][0]["timelinePolicy"], "auto");
        // Leaving required drops the policy, as on the server.
        project(&mut s, &json!({"kind":"issue.update","id":"a","expectedVersion":2,"data":{"timelineUse":"agent_decides"}})).unwrap();
        assert!(s["issues"][0]["timelinePolicy"].is_null());
        assert!(project(&mut s, &json!({"kind":"issue.create","id":"b","data":{"title":"T","timelinePolicy":"auto"}})).is_err());
    }
    #[test]
    fn timeline_flags_build_the_patch() {
        let mut s = snapshot();
        s["issues"] = json!([{"id":"a","key":"ENG-1","version":4}]);
        let flags = |use_: Option<&str>, policy: Option<&str>| TimelineRule {
            timeline_use: use_.map(str::to_string),
            timeline_policy: policy.map(str::to_string),
        };
        let update = issue_patch(
            &s,
            &IssuePatch {
                id: "ENG-1".into(),
                data: Some(r#"{"priority":1}"#.into()),
                timeline: flags(Some("required"), Some("approval")),
            },
        )
        .unwrap();
        assert_eq!(
            update,
            json!({"kind":"issue.update","id":"a","expectedVersion":4,"data":{"priority":1,"timelineUse":"required","timelinePolicy":"approval"}})
        );
        let cleared = issue_patch(
            &s,
            &IssuePatch {
                id: "a".into(),
                data: None,
                timeline: flags(None, Some("none")),
            },
        )
        .unwrap();
        assert_eq!(cleared["data"], json!({"timelinePolicy":null}));
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
    fn the_team_comes_from_the_most_specific_source() {
        use crate::profile::{Defaults, LOCAL_FILE, PROJECT_FILE, Scope as Configured};
        let scoped = |team: Option<&str>, from, under: Option<&str>| Defaults {
            agent: None,
            scope: Configured {
                team: team.map(str::to_owned),
                under: under.map(str::to_owned),
                ..Default::default()
            },
            team_from: from,
            ttl: 900,
            intervention: crate::profile::InterventionMode::Harness,
        };
        let mine = Some("CORE".to_owned());
        let pick =
            |flag, all, configured: Option<&Defaults>, narrowed, preferred: Option<String>| {
                let c = choose_team(flag, all, configured, narrowed, preferred);
                (c.team, c.source)
            };
        let checkout = scoped(Some("WEB"), Some(LOCAL_FILE), None);
        let project = scoped(Some("OPS"), Some(PROJECT_FILE), None);
        let nothing = scoped(None, None, None);
        let under = scoped(None, None, Some("CORE-4"));
        assert_eq!(
            pick(Some("API"), false, Some(&checkout), false, mine.clone()),
            (Some("API".into()), TeamSource::Flag)
        );
        assert_eq!(
            pick(None, false, Some(&checkout), false, mine.clone()),
            (Some("WEB".into()), TeamSource::Checkout)
        );
        assert_eq!(
            pick(None, false, Some(&project), false, mine.clone()),
            (Some("OPS".into()), TeamSource::Project)
        );
        assert_eq!(
            pick(None, false, Some(&nothing), false, mine.clone()),
            (Some("CORE".into()), TeamSource::Default)
        );
        // A parent scope narrows instead; --all-teams ignores every default.
        assert_eq!(
            pick(None, false, Some(&under), true, mine.clone()),
            (None, TeamSource::Narrowed)
        );
        assert_eq!(
            pick(None, true, Some(&checkout), false, mine.clone()),
            (None, TeamSource::AllTeams)
        );
        assert_eq!(
            pick(None, false, None, false, None),
            (None, TeamSource::None)
        );
        let said = choose_team(None, false, None, false, mine).describe("orbit", false);
        assert_eq!(said["key"], "CORE");
        assert_eq!(said["source"], "default");
        assert!(said["why"].as_str().unwrap().contains("web tracker"));
    }
    #[test]
    fn the_default_team_is_read_from_the_cached_preferences() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);")
            .unwrap();
        let r = Replica {
            db,
            config: Config::default(),
            owner: "orbit".into(),
            timeline: None,
        };
        let snapshot =
            json!({"teams":[{"id":"t1","key":"CORE"},{"id":"t2","key":"OLD","archived":true}]});
        assert_eq!(r.preferred_team(&snapshot).unwrap(), None);
        r.set("preferences", "null").unwrap();
        assert_eq!(r.preferred_team(&snapshot).unwrap(), None);
        r.set("preferences", r#"{"teamId":"t1","view":"list","query":""}"#)
            .unwrap();
        assert_eq!(
            r.preferred_team(&snapshot).unwrap().as_deref(),
            Some("CORE")
        );
        // An archived or deleted team is no default at all.
        r.set("preferences", r#"{"teamId":"t2"}"#).unwrap();
        assert_eq!(r.preferred_team(&snapshot).unwrap(), None);
    }
    #[test]
    fn outbox_retains_uncertain_request_and_independent_later_edits() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,operation TEXT UNIQUE,body TEXT,state TEXT,error TEXT);").unwrap();
        let r = Replica {
            db,
            config: Config::default(),
            owner: "orbit".into(),
            timeline: None,
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
    #[test]
    fn a_timeline_view_is_the_servers_projection_plus_changes_queued_for_it() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,operation TEXT UNIQUE,body TEXT,state TEXT,error TEXT);").unwrap();
        let r = Replica {
            db,
            config: Config::default(),
            owner: "orbit".into(),
            timeline: Some("search".into()),
        };
        r.set("snapshot", &snapshot().to_string()).unwrap();
        assert_eq!(r.view().unwrap_err().code, "replica_uninitialized");
        let mut view = snapshot();
        view["timeline"] = json!({"id":"tl_1","slug":"search"});
        view["issues"] = json!([{"id":"a","key":"ENG-1","title":"Made in search","version":1}]);
        r.set("view:search", &view.to_string()).unwrap();
        assert_eq!(
            r.request(json!([]))["timeline"],
            "search",
            "changes are made in the timeline"
        );
        let queue = |operation: &str, timeline: Option<&str>, title: &str| {
            let mut request = json!({"operationId":operation,"mutations":[{"kind":"issue.update","id":"a","expectedVersion":1,"data":{"title":title}}]});
            if let Some(timeline) = timeline {
                request["timeline"] = json!(timeline);
            }
            r.db.execute(
                "INSERT INTO outbox(operation,body,state) VALUES (?,?,'queued')",
                params![operation, request.to_string()],
            )
            .unwrap();
        };
        queue("one", Some("search"), "Search edit");
        queue("two", Some("ranking"), "Ranking edit");
        let shown = r.view().unwrap();
        assert_eq!(shown["timeline"]["slug"], "search");
        assert_eq!(shown["issues"][0]["title"], "Search edit");
    }
}
