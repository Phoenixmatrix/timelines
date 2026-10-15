//! Refresh and recover a current SQLite replica without rewriting its durable outbox.
use parking_lot::Mutex;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

struct Server {
    origin: String,
    snapshot: Arc<Mutex<Value>>,
    requests: Arc<Mutex<Vec<String>>>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn new(snapshot: Value) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let snapshot = Arc::new(Mutex::new(snapshot));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let state = Arc::clone(&snapshot);
        let seen = Arc::clone(&requests);
        let worker = thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(&mut stream);
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    break;
                }
                let request = line.trim().to_owned();
                loop {
                    line.clear();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                }
                drop(reader);
                seen.lock().push(request.clone());
                let body = if request == "GET /api/session HTTP/1.1" {
                    json!({"viewer":{"id":"person-a"}})
                } else if request == "GET /api/spaces/orbit HTTP/1.1" {
                    json!({"contractVersion":4,"migrationEpoch":1,"space":{"id":"space-orbit","slug":"orbit","displayName":"Orbit","organizationId":"org-o",
                        "organization":{"id":"org-o","slug":"orbit-company","displayName":"Orbit Company","kind":"company"}}})
                } else if request == "GET /api/tracker/orbit/snapshot?timelines=1 HTTP/1.1" {
                    state.lock().clone()
                } else if request
                    == "GET /api/tracker/orbit/changes?after=468&limit=200&timelines=1&spaceId=space-orbit&migrationEpoch=1&directory=1 HTTP/1.1"
                {
                    json!({"contractVersion":4,"spaceId":"space-orbit","migrationEpoch":1,"events":[],"cursor":468,"hasMore":false,"serverTime":"2026-10-03T01:00:00Z"})
                } else {
                    panic!("Unexpected tracker request: {request}");
                };
                let body = body.to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        Self {
            origin,
            snapshot,
            requests,
            worker: Some(worker),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = TcpStream::connect(self.origin.trim_start_matches("http://"));
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}

#[test]
fn current_replica_refreshes_creators_once_without_rewriting_outbox() {
    let dir = tempfile::tempdir().unwrap();
    let creator = json!({"id":"person-a","kind":"unknown","name":null,"accountable":null});
    let mut snapshot = json!({
        "contractVersion":4,"spaceId":"space-orbit","migrationEpoch":1,
        "space":{"id":"space-orbit","slug":"orbit","displayName":"Orbit","organizationId":"org-o",
            "organization":{"id":"org-o","slug":"orbit-company","displayName":"Orbit Company","kind":"company"}},
        "teams":[],"projects":[],"links":[],"comments":[],
        "subscriptions":[],"requests":[],"members":[{"id":"person-a","displayName":"Ann"}],"agents":[],
        "issues":[{"id":"a","key":"CORE-60","title":"Server title","version":1,"status":"todo","createdBy":creator},
                  {"id":"b","key":"CORE-31","title":"No surviving creation event","version":1,"createdBy":null}],
        "cursor":468,"serverTime":"2026-10-03T01:00:00Z"
    });
    let server = Server::new(snapshot.clone());
    snapshot["issues"][0]
        .as_object_mut()
        .unwrap()
        .remove("createdBy");
    snapshot["issues"][1]
        .as_object_mut()
        .unwrap()
        .remove("createdBy");
    let partition = format!(
        "{:x}",
        Sha256::digest(format!("{}\ntoken:replica-test-token", server.origin))
    );
    let root = dir.path().join("data/gitmatrix/tracker").join(partition);
    std::fs::create_dir_all(&root).unwrap();
    let db = Connection::open(root.join("orbit.v4.sqlite")).unwrap();
    db.execute_batch("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,operation TEXT UNIQUE NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL,error TEXT);").unwrap();
    db.execute(
        "INSERT INTO meta VALUES ('snapshot', ?)",
        [snapshot.to_string()],
    )
    .unwrap();
    // A current replica with an invalidated snapshot marker must refresh its base.
    // This is not a legacy contract conversion.
    for (operation, state, data, version) in [
        ("rejected", "conflict", json!({"title":"Local title"}), 1),
        (
            "uncertain",
            "sending",
            json!({"description":"Uncertain edit"}),
            2,
        ),
        ("later", "queued", json!({"acceptance":"Later edit"}), 3),
    ] {
        let body = json!({"contractVersion":4,"spaceId":"space-orbit","migrationEpoch":1,"operationId":operation,"mutations":[{"kind":"issue.update","id":"a","expectedVersion":version,"data":data}]}).to_string();
        db.execute(
            "INSERT INTO outbox(operation,body,state,error) VALUES (?,?,?,?)",
            params![
                operation,
                body,
                state,
                if state == "conflict" {
                    Some("Version conflict")
                } else {
                    None
                }
            ],
        )
        .unwrap();
    }
    let outbox = || -> Vec<(i64, String, String, String, Option<String>)> {
        db.prepare("SELECT seq,operation,body,state,error FROM outbox ORDER BY seq")
            .unwrap()
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };
    let before = outbox();
    let gm = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_gm"))
            .args(args)
            .args(["--space", "orbit", "--output", "json"])
            .current_dir(dir.path())
            .env("GM_SERVER", &server.origin)
            .env("GM_TOKEN", "replica-test-token")
            .env("HOME", dir.path())
            .env("XDG_DATA_HOME", dir.path().join("data"))
            .env("XDG_CONFIG_HOME", dir.path().join("config"))
            .output()
            .unwrap()
    };
    let old = gm(&["issue", "show", "CORE-60", "--offline"]);
    assert!(
        old.status.success(),
        "{}",
        String::from_utf8_lossy(&old.stderr)
    );
    assert!(serde_json::from_slice::<Value>(&old.stdout).unwrap()["issue"]["createdBy"].is_null());

    // A failed refresh must leave both the old snapshot and all outbox bytes intact.
    let authoritative = server.snapshot.lock().clone();
    *server.snapshot.lock() = json!({"issues":[]});
    let failed = gm(&["tracker", "conflicts"]);
    assert!(!failed.status.success());
    assert_eq!(outbox(), before);
    let cached: String = db
        .query_row("SELECT value FROM meta WHERE key='snapshot'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&cached).unwrap(), snapshot);

    *server.snapshot.lock() = authoritative;
    let refreshed = gm(&["tracker", "conflicts"]);
    assert!(
        refreshed.status.success(),
        "{}",
        String::from_utf8_lossy(&refreshed.stderr)
    );
    let result: Value = serde_json::from_slice(&refreshed.stdout).unwrap();
    assert_eq!(result["remote"]["issues"][0]["createdBy"], creator);
    assert_eq!(result["remote"]["cursor"], 468);
    assert_eq!(result["local"]["issues"][0]["title"], "Local title");
    assert_eq!(
        result["local"]["issues"][0]["description"],
        "Uncertain edit"
    );
    assert_eq!(result["local"]["issues"][0]["acceptance"], "Later edit");
    assert_eq!(result["local"]["issues"][0]["version"], 4);
    assert_eq!(outbox(), before);
    let offline = gm(&["issue", "show", "CORE-60", "--offline"]);
    assert!(offline.status.success());
    let offline: Value = serde_json::from_slice(&offline.stdout).unwrap();
    assert_eq!(offline["issue"]["createdBy"], creator);
    assert_ne!(offline["issue"]["creatorDisplay"], "Unknown");

    // Even genuinely unknown creators must not cause another full snapshot on each pull.
    let next = gm(&["tracker", "conflicts"]);
    assert!(
        next.status.success(),
        "{}",
        String::from_utf8_lossy(&next.stderr)
    );
    assert_eq!(outbox(), before);
    let requests = server.requests.lock();
    assert_eq!(
        requests.iter().filter(|r| r.contains("/snapshot?")).count(),
        2
    );
    assert_eq!(
        requests.iter().filter(|r| r.contains("/changes?")).count(),
        1
    );
    drop(requests);

    // Credential recovery imports current ordered intent without replacing the confirmed base.
    let source_path = dir.path().join("retained.sqlite");
    db.execute("VACUUM INTO ?", [source_path.to_str().unwrap()])
        .unwrap();
    let source = Connection::open(&source_path).unwrap();
    source
        .execute(
            "UPDATE meta SET value=? WHERE key='snapshot'",
            [snapshot.to_string()],
        )
        .unwrap();
    db.execute("DELETE FROM outbox", []).unwrap();
    let recovered = gm(&["tracker", "recover", source_path.to_str().unwrap()]);
    assert!(
        recovered.status.success(),
        "{}",
        String::from_utf8_lossy(&recovered.stderr)
    );
    let recovered_outbox = outbox();
    assert_eq!(
        recovered_outbox
            .iter()
            .map(|row| (&row.1, &row.2, &row.3, &row.4))
            .collect::<Vec<_>>(),
        before
            .iter()
            .map(|row| (&row.1, &row.2, &row.3, &row.4))
            .collect::<Vec<_>>()
    );
    let refreshed = gm(&["tracker", "conflicts"]);
    assert!(
        refreshed.status.success(),
        "{}",
        String::from_utf8_lossy(&refreshed.stderr)
    );
    let refreshed: Value = serde_json::from_slice(&refreshed.stdout).unwrap();
    assert_eq!(refreshed["remote"]["issues"][0]["createdBy"], creator);
    assert_eq!(refreshed["local"]["issues"][0]["title"], "Local title");
    assert_eq!(outbox(), recovered_outbox);
}

#[test]
fn legacy_replica_is_refused_and_exported_without_relabeling_intent() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::new(json!({}));
    let partition = format!(
        "{:x}",
        Sha256::digest(format!("{}\ntoken:replica-test-token", server.origin))
    );
    let root = dir.path().join("data/gitmatrix/tracker").join(partition);
    std::fs::create_dir_all(&root).unwrap();
    let source = root.join("orbit.sqlite");
    let db = Connection::open(&source).unwrap();
    db.execute_batch("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,operation TEXT UNIQUE NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL,error TEXT);").unwrap();
    let snapshot = json!({"owner":{"id":"legacy-orbit","slug":"orbit"},"workspaces":[],"issues":[],"cursor":468});
    db.execute(
        "INSERT INTO meta VALUES ('snapshot_schema','3'),('snapshot',?)",
        [snapshot.to_string()],
    )
    .unwrap();
    for (operation, state) in [("uncertain", "sending"), ("later", "queued")] {
        let body = json!({"operationId":operation,"mutations":[{"kind":"workspace.create","id":operation,"data":{"slug":operation,"name":operation}}]});
        db.execute(
            "INSERT INTO outbox(operation,body,state) VALUES (?,?,?)",
            params![operation, body.to_string(), state],
        )
        .unwrap();
    }
    drop(db);
    let original = std::fs::read(&source).unwrap();
    let gm = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_gm"))
            .args(args)
            .args(["--space", "orbit", "--output", "json"])
            .current_dir(dir.path())
            .env("GM_SERVER", &server.origin)
            .env("GM_TOKEN", "replica-test-token")
            .env("HOME", dir.path())
            .env("XDG_DATA_HOME", dir.path().join("data"))
            .env("XDG_CONFIG_HOME", dir.path().join("config"))
            .output()
            .unwrap()
    };
    for args in [
        &["tracker", "sync"][..],
        &["issue", "list", "--offline"][..],
    ] {
        let refused = gm(args);
        assert!(!refused.status.success());
        let error: Value = serde_json::from_slice(&refused.stdout)
            .or_else(|_| serde_json::from_slice(&refused.stderr))
            .unwrap();
        assert_eq!(error["error"]["code"], "export_required");
        assert_eq!(std::fs::read(&source).unwrap(), original);
    }
    let archive = dir.path().join("archive.sqlite");
    let exported = gm(&[
        "tracker",
        "export",
        source.to_str().unwrap(),
        "--destination",
        archive.to_str().unwrap(),
    ]);
    assert!(
        exported.status.success(),
        "{}",
        String::from_utf8_lossy(&exported.stderr)
    );
    assert_eq!(std::fs::read(&source).unwrap(), original);
    let archived = Connection::open(&archive).unwrap();
    let schema: String = archived
        .query_row(
            "SELECT value FROM meta WHERE key='snapshot_schema'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(schema, "3");
    let archived_snapshot: String = archived
        .query_row("SELECT value FROM meta WHERE key='snapshot'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&archived_snapshot).unwrap(),
        snapshot
    );
    let rows: Vec<(String, String, String)> = archived
        .prepare("SELECT operation,body,state FROM outbox ORDER BY seq")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(rows.len(), 2);
    for ((operation, body, state), (expected_operation, expected_state)) in rows
        .iter()
        .zip([("uncertain", "sending"), ("later", "queued")])
    {
        assert_eq!(operation, expected_operation);
        assert_eq!(state, expected_state);
        assert_eq!(
            serde_json::from_str::<Value>(body).unwrap(),
            json!({"operationId":expected_operation,"mutations":[{"kind":"workspace.create","id":expected_operation,"data":{"slug":expected_operation,"name":expected_operation}}]})
        );
    }
    assert!(!root.join("orbit.v4.sqlite").exists());
    assert!(server.requests.lock().is_empty());
}
