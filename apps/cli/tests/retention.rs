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

fn policy(id: &str, scope: &str, enabled: bool) -> Value {
    let mut policy = json!({
        "id": id, "scope": scope, "control": "policy", "label": id, "description": "",
        "never": [], "thresholds": [{"key": "days", "label": "Days", "unit": "days", "min": 1, "max": 3650, "default": 30}],
        "enabled": enabled, "enabledFrom": scope, "values": {"days": 30}, "valuesFrom": {"days": "default"},
        "runnable": true, "lastRun": null, "updatedAt": null, "updatedBy": null
    });
    if id == "ci-runs" {
        policy["thresholds"].as_array_mut().unwrap().push(json!({
            "key": "keepLatest", "label": "Runs kept per ref", "unit": "runs",
            "min": 1, "max": 10000, "default": 20
        }));
        policy["values"]["keepLatest"] = json!(20);
        policy["valuesFrom"]["keepLatest"] = json!("default");
    } else if id == "auth-hygiene" {
        policy["control"] = json!("fixed");
    }
    policy
}

fn settings(scope: &str, enabled: bool) -> Value {
    let (id, categories) = match scope {
        "person" => (
            "person-ann",
            vec![policy("assistant-chats", scope, enabled)],
        ),
        "instance" => ("", vec![policy("auth-hygiene", scope, enabled)]),
        _ => (
            "space-studio",
            vec![
                policy("ci-logs", scope, enabled),
                policy("ci-runs", scope, enabled),
            ],
        ),
    };
    json!({
        "target": {"kind": scope, "id": id},
        "canEdit": true, "changes": [],
        "categories": categories
    })
}

fn run(id: u64, status: &str, dry_run: bool) -> Value {
    let category_status = match status {
        "queued" => "pending",
        other => other,
    };
    let (scope, target, category) = match id {
        9 => ("instance", "", "auth-hygiene"),
        10 => ("person", "person-ann", "assistant-chats"),
        _ => ("space", "space-studio", "ci-logs"),
    };
    json!({
        "id": id, "target": {"kind": scope, "id": target}, "trigger": "manual", "actor": "ann",
        "dryRun": dry_run, "status": status, "asOf": "2026-10-04T00:00:00Z",
        "createdAt": "2026-10-04T00:00:00Z", "startedAt": null, "finishedAt": null,
        "items": 3, "bytes": 2048, "error": null,
        "categories": [{"category": category, "label": category, "status": category_status,
            "thresholds": {"days": 30}, "items": 3, "bytes": 2048, "batches": 1,
            "error": if status == "failed" { json!("boom") } else { Value::Null },
            "startedAt": null, "finishedAt": null}]
    })
}

/// Ann has an explicit admin grant to studio and a member grant to shared.
/// Person retention is self-only; Instance access uses a separate operator token.
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
                let mut operator = false;
                loop {
                    line.clear();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':') {
                        if name.eq_ignore_ascii_case("content-length") {
                            length = value.trim().parse().unwrap_or(0);
                        } else if name.eq_ignore_ascii_case("authorization") {
                            operator = value.trim() == "Bearer operator-token";
                        }
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
                        json!({"viewer": {
                            "id": "person-ann", "slug": "ann", "isSiteAdmin": operator,
                            "defaultSpaceId": "space-studio",
                            "spaces": [
                                {"id": "space-studio", "slug": "studio"},
                                {"id": "space-shared", "slug": "shared"}
                            ]
                        }}),
                    ),
                    ("GET", "/api/spaces/studio/retention") => (200, settings("space", false)),
                    ("PATCH", "/api/spaces/studio/retention") => (200, settings("space", true)),
                    ("GET", "/api/accounts/ann/retention") => (200, settings("person", false)),
                    ("PATCH", "/api/accounts/ann/retention") => (200, settings("person", true)),
                    (_, p) if p.starts_with("/api/accounts/bob/") => {
                        (404, json!({"error": "No such person retention."}))
                    }
                    (_, p) if p.starts_with("/api/spaces/shared/") => (
                        403,
                        json!({"error": "Only Space administrators manage retention."}),
                    ),
                    (_, p) if p.starts_with("/api/admin/retention") && !operator => (
                        403,
                        json!({"error": "Only Instance administrators manage Instance retention."}),
                    ),
                    ("GET", "/api/admin/retention") => (200, settings("instance", false)),
                    ("POST", "/api/accounts/ann/retention/runs") => (202, run(10, "queued", true)),
                    ("POST", "/api/spaces/studio/retention/runs") => {
                        if body["dryRun"] == json!(true) {
                            (202, run(7, "queued", true))
                        } else {
                            (202, run(8, "queued", false))
                        }
                    }
                    ("POST", "/api/admin/retention/runs") => (202, run(9, "queued", true)),
                    ("GET", "/api/spaces/studio/retention/runs/7") => {
                        reads_of_7 += 1;
                        let status = if reads_of_7 < 2 {
                            "running"
                        } else {
                            "succeeded"
                        };
                        (200, run(7, status, true))
                    }
                    ("GET", "/api/spaces/studio/retention/runs/8") => {
                        (200, run(8, "failed", false))
                    }
                    ("GET", p) if p.starts_with("/api/spaces/studio/retention/runs") => (
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
        self.gm_with_token(args, "test-token")
    }

    fn gm_with_token(&self, args: &[&str], token: &str) -> (i32, Value) {
        let output = Command::new(env!("CARGO_BIN_EXE_gm"))
            .current_dir(&self.root)
            .args(args)
            .env_clear()
            .env("HOME", &self.root)
            .env("PATH", "/usr/bin:/bin")
            .env("GM_AGENT", "1")
            .env("GM_SERVER", format!("http://{}", self.api.address))
            .env("GM_TOKEN", token)
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
fn show_and_set_use_authorized_space_or_instance_scope() {
    let env = Env::new();
    let (code, shown) = env.gm(&["retention", "show"]);
    assert_eq!(code, 0, "{shown}");
    assert_eq!(
        shown["target"],
        json!({"kind": "space", "id": "space-studio"})
    );
    assert_eq!(shown["categories"].as_array().unwrap().len(), 2);

    let (code, one) = env.gm(&["retention", "show", "ci-runs", "--space", "studio"]);
    assert_eq!(code, 0, "{one}");
    assert_eq!(one["categories"][0]["id"], "ci-runs");
    assert_eq!(one["categories"].as_array().unwrap().len(), 1);

    let (code, missing) = env.gm(&["retention", "show", "auth-hygiene"]);
    assert_eq!(code, 3, "{missing}");
    assert_eq!(missing["error"]["code"], "unknown_category");

    let (code, site) = env.gm_with_token(&["retention", "show", "--site"], "operator-token");
    assert_eq!(code, 0, "{site}");
    assert_eq!(site["target"], json!({"kind": "instance", "id": ""}));

    let (code, set) = env.gm(&[
        "retention",
        "set",
        "ci-runs",
        "--enable",
        "--threshold",
        "days=14",
        "--reset",
        "keepLatest",
    ]);
    assert_eq!(code, 0, "{set}");
    assert_eq!(set["category"]["id"], "ci-runs");
    assert_eq!(set["category"]["enabled"], true);

    let (code, dry) = env.gm(&["retention", "set", "ci-logs", "--disable", "--dry-run"]);
    assert_eq!(code, 0, "{dry}");
    assert_eq!(dry["dry_run"], true);
    assert_eq!(
        dry["request"],
        json!({"categories": {"ci-logs": {"enabled": false}}})
    );

    let (code, refused) = env.gm(&[
        "retention",
        "set",
        "ci-logs",
        "--enable",
        "--space",
        "shared",
    ]);
    assert_eq!(code, 5, "{refused}");

    let requests = env.api.requests();
    let patches: Vec<_> = requests.iter().filter(|r| r.0 == "PATCH").collect();
    assert_eq!(patches.len(), 2, "{patches:?}");
    assert_eq!(patches[0].1, "/api/spaces/studio/retention");
    assert_eq!(patches[1].1, "/api/spaces/shared/retention");
    assert_eq!(
        patches[0].2,
        json!({"categories": {"ci-runs": {"enabled": true, "thresholds": {"days": 14, "keepLatest": null}}}})
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

    // --no-wait returns the queued run; Instance cleanup requires operator authority.
    let (code, queued) = env.gm_with_token(
        &[
            "retention",
            "run",
            "auth-hygiene",
            "--site",
            "--dry-run",
            "--no-wait",
        ],
        "operator-token",
    );
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
        .filter(|r| r.1 == "/api/spaces/studio/retention/runs/7")
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
            .any(|r| r.1 == "/api/spaces/studio/retention/runs?before=9&limit=2"),
        "{requests:?}"
    );
}

#[test]
fn personal_retention_and_instance_authority_do_not_grant_space_admin_access() {
    let env = Env::new();
    let (code, personal) = env.gm(&["retention", "show", "--person", "ann"]);
    assert_eq!(code, 0, "{personal}");
    assert_eq!(
        personal["target"],
        json!({"kind": "person", "id": "person-ann"})
    );
    assert_eq!(personal["categories"][0]["id"], "assistant-chats");

    let (code, queued) = env.gm(&[
        "retention",
        "run",
        "assistant-chats",
        "--person",
        "ann",
        "--dry-run",
        "--no-wait",
    ]);
    assert_eq!(code, 0, "{queued}");
    assert_eq!(queued["target"], personal["target"]);
    assert_eq!(queued["status"], "queued");

    let (code, denied) = env.gm(&["retention", "show", "--person", "bob"]);
    assert_eq!(code, 3, "{denied}");
    let (code, denied) = env.gm(&["retention", "show", "--site"]);
    assert_eq!(code, 5, "{denied}");
    let (code, denied) = env.gm_with_token(
        &[
            "retention",
            "set",
            "ci-logs",
            "--enable",
            "--space",
            "shared",
        ],
        "operator-token",
    );
    assert_eq!(code, 5, "{denied}");
    let (code, denied) =
        env.gm_with_token(&["retention", "show", "--person", "bob"], "operator-token");
    assert_eq!(code, 3, "{denied}");

    let requests = env.api.requests();
    assert!(
        requests
            .iter()
            .any(|r| { r.0 == "POST" && r.1 == "/api/accounts/ann/retention/runs" })
    );
    assert!(!requests.iter().any(|r| r.1 == "/api/spaces/ann/retention"));
}
