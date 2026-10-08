//! CORE-260: `gm issue update` that moves a leased issue sends the kept lease
//! token online, and never writes it to the replica's durable outbox.
use parking_lot::Mutex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

struct Server {
    origin: String,
    mutations: Arc<Mutex<Vec<Value>>>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn new(snapshot: Value) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let mutations = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&mutations);
        let worker = thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(&mut stream);
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    break;
                }
                let request = line.trim().to_owned();
                let mut length = 0;
                loop {
                    line.clear();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':')
                        && name.eq_ignore_ascii_case("content-length")
                    {
                        length = value.trim().parse().unwrap();
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                drop(reader);
                let reply = if request == "GET /api/session HTTP/1.1" {
                    json!({"viewer":{"id":"person-a"}})
                } else if request.starts_with("GET /api/tracker/orbit/snapshot?") {
                    snapshot.clone()
                } else if request.starts_with("GET /api/tracker/orbit/changes?") {
                    json!({"events":[],"cursor":7,"hasMore":false,"serverTime":"2026-10-08T00:00:00Z"})
                } else if request == "POST /api/tracker/orbit/mutate HTTP/1.1" {
                    let mutation: Value = serde_json::from_slice(&body).unwrap();
                    seen.lock().push(mutation.clone());
                    let mut issue = snapshot["issues"][0].clone();
                    issue["status"] = json!("canceled");
                    issue["closeReason"] = json!("duplicate");
                    issue["version"] = json!(2);
                    json!({"results":[{"id":"a"}],"events":[{"entityType":"issue","entityId":"a","entity":issue}]})
                } else {
                    json!({})
                };
                let reply = reply.to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                    reply.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        Self {
            origin,
            mutations,
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
fn canceling_a_claimed_issue_sends_its_kept_lease_token() {
    let dir = tempfile::tempdir().unwrap();
    let snapshot = json!({
        "owner":{"slug":"orbit"},"teams":[],"workspaces":[],"labels":[],"links":[],"comments":[],
        "subscriptions":[],"requests":[],"members":[{"id":"person-a","displayName":"Ann"}],"agents":[],
        "issues":[{"id":"a","key":"CORE-60","title":"Claimed","version":1,"status":"in_progress",
                   "parentId":null,"claim":{"agent":"worker","expiresAt":"2999-01-01T00:00:00Z"}}],
        "cursor":7,"serverTime":"2026-10-08T00:00:00Z"
    });
    let server = Server::new(snapshot);
    let leases = dir
        .path()
        .join("data/gitmatrix/leases")
        .join(format!("{:x}", Sha256::digest(server.origin.as_bytes())));
    std::fs::create_dir_all(&leases).unwrap();
    std::fs::write(
        leases.join("a.json"),
        json!({"token":"kept-secret","identity":{"kind":"env"},"issue":"CORE-60","expires_at":null})
            .to_string(),
    )
    .unwrap();
    let gm = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_gm"))
            .args(args)
            .args(["--owner", "orbit", "--output", "json"])
            .current_dir(dir.path())
            .env("GM_SERVER", &server.origin)
            .env("GM_TOKEN", "replica-test-token")
            .env("HOME", dir.path())
            .env("XDG_DATA_HOME", dir.path().join("data"))
            .env("XDG_CONFIG_HOME", dir.path().join("config"))
            .output()
            .unwrap()
    };
    let data = r#"{"status":"canceled","closeReason":"duplicate"}"#;
    let synced = gm(&["tracker", "sync"]);
    assert!(
        synced.status.success(),
        "{}",
        String::from_utf8_lossy(&synced.stderr)
    );

    // A dry run shows the request without the token.
    let preview = gm(&["issue", "update", "CORE-60", "--data", data, "--dry-run"]);
    assert!(
        preview.status.success(),
        "{}",
        String::from_utf8_lossy(&preview.stderr)
    );
    assert!(!String::from_utf8_lossy(&preview.stdout).contains("kept-secret"));
    assert!(server.mutations.lock().is_empty());

    let updated = gm(&["issue", "update", "CORE-60", "--data", data]);
    assert!(
        updated.status.success(),
        "{}",
        String::from_utf8_lossy(&updated.stderr)
    );
    let shown: Value = serde_json::from_slice(&updated.stdout).unwrap();
    assert_eq!(shown["queued"], false);
    assert_eq!(shown["entities"][0]["status"], "canceled");
    let sent = server.mutations.lock().clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(
        sent[0]["mutations"][0]["data"],
        json!({"status":"canceled","closeReason":"duplicate","leaseToken":"kept-secret"})
    );

    // Nothing the replica keeps holds the token.
    let tracker = dir.path().join("data/gitmatrix/tracker");
    for entry in walk(&tracker) {
        let bytes = std::fs::read(&entry).unwrap();
        assert!(
            !String::from_utf8_lossy(&bytes).contains("kept-secret"),
            "{} holds the lease token",
            entry.display()
        );
    }
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            files.extend(walk(&path));
        } else {
            files.push(path);
        }
    }
    files
}
