//! `gm retention` against a stand-in for the retention API (CORE-210): which
//! paths and bodies each command sends, polling a run to its end, and errors.
#![cfg(unix)]

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

type Requests = Arc<Mutex<Vec<(String, String, Value)>>>;

fn policy(id: &str, enabled: bool) -> Value {
    json!({
        "id": id, "scope": "account", "control": "policy", "label": id, "description": "",
        "never": [], "thresholds": [{"key": "days", "label": "Days", "unit": "days", "min": 1, "max": 3650, "default": 30}],
        "enabled": enabled, "enabledFrom": "account", "values": {"days": 30}, "valuesFrom": {"days": "default"},
        "runnable": true, "lastRun": null, "updatedAt": null, "updatedBy": null
    })
}

fn settings(level: &str, enabled: bool) -> Value {
    json!({
        "level": level, "account": if level == "site" { Value::Null } else { json!("ann") },
        "canEdit": true, "changes": [],
        "categories": [policy("ci-logs", enabled), policy("ci-runs", false)]
    })
}

fn run(id: u64, status: &str, dry_run: bool) -> Value {
    let category_status = match status {
        "queued" => "pending",
        other => other,
    };
    json!({
        "id": id, "level": "account", "account": "ann", "trigger": "manual", "actor": "ann",
        "dryRun": dry_run, "status": status, "asOf": "2026-10-04T00:00:00Z",
        "createdAt": "2026-10-04T00:00:00Z", "startedAt": null, "finishedAt": null,
        "items": 3, "bytes": 2048, "error": null,
        "categories": [{"category": "ci-logs", "label": "CI logs", "status": category_status,
            "thresholds": {"days": 30}, "items": 3, "bytes": 2048, "batches": 1,
            "error": if status == "failed" { json!("boom") } else { Value::Null },
            "startedAt": null, "finishedAt": null}]
    })
}

/// The retention API for the person `ann`: run 7 is a dry run that succeeds on
/// its second read, run 8 a real run that fails; `/api/accounts/bob/…` is 403.
struct Api {
    address: SocketAddr,
    requests: Requests,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Api {
    fn new() -> Api {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let requests: Requests = Arc::default();
        let stop = Arc::new(AtomicBool::new(false));
        let (seen, halt) = (Arc::clone(&requests), Arc::clone(&stop));
        let worker = thread::spawn(move || {
            let mut reads_of_7 = 0;
            for stream in listener.incoming() {
                if halt.load(Ordering::Acquire) {
                    break;
                }
                let mut stream = stream.unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(&mut stream);
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let mut parts = line.split_whitespace();
                let method = parts.next().unwrap_or("").to_string();
                let path = parts.next().unwrap_or("").to_string();
                let mut length = 0;
                loop {
                    line.clear();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':')
                        && name.eq_ignore_ascii_case("content-length")
                    {
                        length = value.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                drop(reader);
                let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                seen.lock()
                    .unwrap()
                    .push((method.clone(), path.clone(), body.clone()));
                let (code, reply) = match (method.as_str(), path.as_str()) {
                    ("GET", "/api/session") => (
                        200,
                        json!({"viewer": {"slug": "ann", "isSiteAdmin": false}}),
                    ),
                    ("GET", "/api/accounts/ann/settings/retention") => {
                        (200, settings("account", false))
                    }
                    ("PATCH", "/api/accounts/ann/settings/retention") => {
                        (200, settings("account", true))
                    }
                    ("GET", "/api/admin/retention") => (200, settings("site", false)),
                    (_, p) if p.starts_with("/api/accounts/bob/") => (
                        403,
                        json!({"error": "Only the organization's owners can change its data retention."}),
                    ),
                    ("POST", "/api/accounts/ann/retention/runs") => {
                        if body["dryRun"] == json!(true) {
                            (202, run(7, "queued", true))
                        } else {
                            (202, run(8, "queued", false))
                        }
                    }
                    ("POST", "/api/admin/retention/runs") => (202, run(9, "queued", true)),
                    ("GET", "/api/accounts/ann/retention/runs/7") => {
                        reads_of_7 += 1;
                        let status = if reads_of_7 < 2 {
                            "running"
                        } else {
                            "succeeded"
                        };
                        (200, run(7, status, true))
                    }
                    ("GET", "/api/accounts/ann/retention/runs/8") => (200, run(8, "failed", false)),
                    ("GET", p) if p.starts_with("/api/accounts/ann/retention/runs") => (
                        200,
                        json!({"runs": [run(8, "failed", false), run(7, "succeeded", true)], "next": 7}),
                    ),
                    _ => (404, json!({"error": "Not found"})),
                };
                respond(&mut stream, code, &reply);
            }
        });
        Api {
            address,
            requests,
            stop,
            worker: Some(worker),
        }
    }

    fn requests(&self) -> Vec<(String, String, Value)> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for Api {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = TcpStream::connect(self.address);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn respond(stream: &mut TcpStream, code: u16, body: &Value) {
    let body = body.to_string();
    let _ = write!(
        stream,
        "HTTP/1.1 {code} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
}

struct Env {
    api: Api,
    root: PathBuf,
}

impl Env {
    fn new() -> Env {
        let root = tempfile::tempdir().unwrap().keep();
        Env {
            api: Api::new(),
            root,
        }
    }

    fn gm(&self, args: &[&str]) -> (i32, Value) {
        let output = Command::new(env!("CARGO_BIN_EXE_gm"))
            .current_dir(&self.root)
            .args(args)
            .env("GM_AGENT", "1")
            .env("GM_SERVER", format!("http://{}", self.api.address))
            .env("GM_TOKEN", "test-token")
            .env("XDG_CONFIG_HOME", self.root.join("config"))
            .env("XDG_DATA_HOME", self.root.join("data"))
            .output()
            .expect("gm runs");
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let value = serde_json::from_str(&stdout)
            .or_else(|_| serde_json::from_str(&stderr))
            .unwrap_or(Value::String(format!("{stdout}{stderr}")));
        (output.status.code().unwrap_or(-1), value)
    }
}

#[test]
fn show_and_set_use_the_signed_in_account_or_the_site() {
    let env = Env::new();
    let (code, shown) = env.gm(&["retention", "show"]);
    assert_eq!(code, 0, "{shown}");
    assert_eq!(shown["level"], "account");
    assert_eq!(shown["categories"].as_array().unwrap().len(), 2);

    let (code, one) = env.gm(&["retention", "show", "ci-runs", "--owner", "ann"]);
    assert_eq!(code, 0, "{one}");
    assert_eq!(one["categories"][0]["id"], "ci-runs");
    assert_eq!(one["categories"].as_array().unwrap().len(), 1);

    let (code, missing) = env.gm(&["retention", "show", "auth-hygiene"]);
    assert_eq!(code, 3, "{missing}");
    assert_eq!(missing["error"]["code"], "unknown_category");

    let (code, site) = env.gm(&["retention", "show", "--site"]);
    assert_eq!(code, 0, "{site}");
    assert_eq!(site["level"], "site");

    let (code, set) = env.gm(&[
        "retention",
        "set",
        "ci-logs",
        "--enable",
        "--threshold",
        "days=14",
        "--reset",
        "keepLatest",
    ]);
    assert_eq!(code, 0, "{set}");
    assert_eq!(set["category"]["id"], "ci-logs");
    assert_eq!(set["category"]["enabled"], true);

    let (code, dry) = env.gm(&["retention", "set", "ci-logs", "--disable", "--dry-run"]);
    assert_eq!(code, 0, "{dry}");
    assert_eq!(dry["dry_run"], true);
    assert_eq!(
        dry["request"],
        json!({"categories": {"ci-logs": {"enabled": false}}})
    );

    let (code, refused) = env.gm(&["retention", "set", "ci-logs", "--enable", "--owner", "bob"]);
    assert_ne!(code, 0, "{refused}");
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("owners"),
        "{refused}"
    );

    let requests = env.api.requests();
    let patches: Vec<_> = requests.iter().filter(|r| r.0 == "PATCH").collect();
    // The dry run sends nothing; the server refuses bob's.
    assert_eq!(patches.len(), 2, "{patches:?}");
    assert_eq!(patches[0].1, "/api/accounts/ann/settings/retention");
    assert_eq!(patches[1].1, "/api/accounts/bob/settings/retention");
    assert_eq!(
        patches[0].2,
        json!({"categories": {"ci-logs": {"enabled": true, "thresholds": {"days": 14, "keepLatest": null}}}})
    );
    assert!(requests.iter().any(|r| r.1 == "/api/admin/retention"));
}

#[test]
fn run_previews_waits_and_fails_loudly() {
    let env = Env::new();
    // A real run needs --yes; nothing is sent without it.
    let (code, refused) = env.gm(&["retention", "run", "ci-logs"]);
    assert_eq!(code, 2, "{refused}");
    assert_eq!(refused["error"]["code"], "confirmation_required");
    assert!(env.api.requests().iter().all(|r| r.0 != "POST"));

    // A dry run is a server-side preview, followed to its end.
    let (code, preview) = env.gm(&[
        "retention",
        "run",
        "ci-logs",
        "--threshold",
        "ci-logs.days=7",
        "--dry-run",
    ]);
    assert_eq!(code, 0, "{preview}");
    assert_eq!(preview["id"], 7);
    assert_eq!(preview["status"], "succeeded");
    assert_eq!(preview["dryRun"], true);

    // A real run that fails exits 4 with the category's error.
    let (code, failed) = env.gm(&["retention", "run", "ci-logs", "--yes"]);
    assert_eq!(code, 4, "{failed}");
    assert_eq!(failed["error"]["code"], "run_failed");
    assert!(
        failed["error"]["message"]
            .as_str()
            .unwrap()
            .contains("ci-logs (boom)"),
        "{failed}"
    );

    // --no-wait returns the queued run; the site has its own path.
    let (code, queued) = env.gm(&[
        "retention",
        "run",
        "auth-hygiene",
        "--site",
        "--dry-run",
        "--no-wait",
    ]);
    assert_eq!(code, 0, "{queued}");
    assert_eq!(queued["id"], 9);

    let requests = env.api.requests();
    let posts: Vec<_> = requests.iter().filter(|r| r.0 == "POST").collect();
    assert_eq!(posts.len(), 3);
    assert_eq!(
        posts[0].2,
        json!({"dryRun": true, "categories": ["ci-logs"], "thresholds": {"ci-logs": {"days": 7}}})
    );
    assert_eq!(
        posts[1].2,
        json!({"dryRun": false, "categories": ["ci-logs"]})
    );
    assert_eq!(posts[2].1, "/api/admin/retention/runs");
    let polls_of_7 = requests
        .iter()
        .filter(|r| r.1 == "/api/accounts/ann/retention/runs/7")
        .count();
    assert_eq!(polls_of_7, 2, "polled until it succeeded");
}

#[test]
fn runs_lists_history_and_shows_one_run() {
    let env = Env::new();
    let (code, page) = env.gm(&["retention", "runs", "--before", "9", "--limit", "2"]);
    assert_eq!(code, 0, "{page}");
    assert_eq!(page["runs"].as_array().unwrap().len(), 2);
    assert_eq!(page["next"], 7);
    let (code, one) = env.gm(&["retention", "runs", "8"]);
    assert_eq!(code, 0, "{one}");
    assert_eq!(one["status"], "failed");
    let requests = env.api.requests();
    assert!(
        requests
            .iter()
            .any(|r| r.1 == "/api/accounts/ann/retention/runs?before=9&limit=2"),
        "{requests:?}"
    );
}
