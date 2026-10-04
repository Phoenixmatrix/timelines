//! Step context (CORE-232): `gm commit --context` journals it, `gm push`
//! uploads it for the pushed changes, `gm context sync` retries.

use serde_json::{Value, json};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Seed")
        .env("GIT_AUTHOR_EMAIL", "seed@example.com")
        .env("GIT_COMMITTER_NAME", "Seed")
        .env("GIT_COMMITTER_EMAIL", "seed@example.com")
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

/// Records every step upload; answers 500 while `failing` is set.
struct Api {
    address: SocketAddr,
    uploads: Arc<Mutex<Vec<(String, Value)>>>,
    failing: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Api {
    fn new() -> Api {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let uploads: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
        let failing = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let (seen, fail, halt) = (
            Arc::clone(&uploads),
            Arc::clone(&failing),
            Arc::clone(&stop),
        );
        let worker = thread::spawn(move || {
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
                let is_upload = method == "POST" && path.ends_with("/steps");
                let (code, reply) = if is_upload && fail.load(Ordering::Acquire) {
                    (500, json!({"error": "Something went wrong on our side."}))
                } else if is_upload {
                    seen.lock().unwrap().push((path.clone(), body.clone()));
                    (201, json!({"changeId": body["changeId"]}))
                } else {
                    (404, json!({"error": "Not here.", "code": "not_found"}))
                };
                let text = reply.to_string();
                let _ = write!(
                    stream,
                    "HTTP/1.1 {code} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
                    text.len()
                );
            }
        });
        Api {
            address,
            uploads,
            failing,
            stop,
            worker: Some(worker),
        }
    }

    fn uploads(&self) -> Vec<Value> {
        self.uploads
            .lock()
            .unwrap()
            .iter()
            .map(|(_, b)| b.clone())
            .collect()
    }
}

impl Drop for Api {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_secs(3));
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

struct Sandbox {
    _dir: tempfile::TempDir,
    root: PathBuf,
    api: Api,
}

impl Sandbox {
    fn new() -> Sandbox {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        git(&root, &["init", "-q", "--bare", "-b", "main", "remote.git"]);
        git(&root, &["clone", "-q", "remote.git", "seed"]);
        fs::write(root.join("seed/README.md"), "hello\n").unwrap();
        git(&root.join("seed"), &["add", "."]);
        git(&root.join("seed"), &["commit", "-qm", "Initial"]);
        git(&root.join("seed"), &["push", "-q", "origin", "main"]);
        git(&root, &["clone", "-q", "remote.git", "work"]);
        git(&root.join("work"), &["config", "user.name", "Agent"]);
        git(
            &root.join("work"),
            &["config", "user.email", "agent@example.com"],
        );
        let sandbox = Sandbox {
            _dir: dir,
            root,
            api: Api::new(),
        };
        sandbox.ok(&["init"], &[]);
        sandbox
    }

    fn work(&self) -> PathBuf {
        self.root.join("work")
    }

    fn run(&self, args: &[&str], env: &[(&str, &str)]) -> (i32, Value, String) {
        let mut command = Command::new(env!("CARGO_BIN_EXE_gm"));
        command
            .current_dir(self.work())
            .args(args)
            .env("GM_AGENT", "1")
            .env_remove("GM_TIMELINE")
            .env("GM_SERVER", format!("http://{}", self.api.address))
            .env("GM_TOKEN", "test-token")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("XDG_CONFIG_HOME", self.root.join("config"))
            .env("XDG_DATA_HOME", self.root.join("data"));
        for (name, value) in env {
            command.env(name, value);
        }
        let output = command.output().expect("gm runs");
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let value = serde_json::from_str(&stdout)
            .or_else(|_| serde_json::from_str(&stderr))
            .unwrap_or(Value::String(stdout));
        (output.status.code().unwrap_or(-1), value, stderr)
    }

    fn ok(&self, args: &[&str], env: &[(&str, &str)]) -> Value {
        let (code, value, stderr) = self.run(args, env);
        assert_eq!(code, 0, "gm {args:?} failed: {stderr} {value}");
        value
    }

    fn edit(&self, file: &str, text: &str) {
        fs::write(self.work().join(file), text).unwrap();
    }

    fn context_file(&self, text: &str) -> String {
        let path = self.root.join("context.md");
        fs::write(&path, text).unwrap();
        path.to_string_lossy().to_string()
    }
}

const CONTEXT: &str = "## Instructions\n- Rank results by recency\n\n## Steering\n- Keep the old order as a fallback\n\n## Why\nRecency matters more than score.\n\n## Challenges\nThe first index missed updated_at.\n";

#[test]
fn a_pushed_commit_uploads_its_context_once() {
    let s = Sandbox::new();
    s.edit("search.txt", "ranked\n");
    let file = s.context_file(CONTEXT);
    let committed = s.ok(
        &["commit", "-m", "Rank by recency", "--context", &file],
        &[],
    );
    assert!(committed.get("warnings").is_none(), "{committed}");
    assert!(
        s.api.uploads().is_empty(),
        "nothing goes up before the push"
    );

    let pushed = s.ok(&["push"], &[]);
    assert_eq!(pushed["steps"]["uploaded"], json!(1), "{pushed}");
    let uploads = s.api.uploads();
    assert_eq!(uploads.len(), 1);
    let up = &uploads[0];
    let head = git(&s.root.join("remote.git"), &["rev-parse", "main"]);
    assert_eq!(up["commitOid"], json!(head));
    assert_eq!(up["summary"], json!("Rank by recency"));
    assert_eq!(up["why"], json!("Recency matters more than score."));
    assert_eq!(
        up["instructions"],
        json!([{"text": "Rank results by recency", "source": "agent"}])
    );
    assert_eq!(
        up["coverage"],
        json!({"instructions": "agent", "steering": "agent"})
    );
    assert_eq!(up["harness"], json!("custom"));
    assert_eq!(up["changeId"].as_str().unwrap().len(), 32);

    // A later push sends only what's new.
    s.edit("other.txt", "x\n");
    s.ok(&["commit", "-m", "No context here"], &[]);
    s.ok(&["push"], &[]);
    assert_eq!(s.api.uploads().len(), 1);
}

#[test]
fn a_failed_upload_never_fails_the_push_and_sync_retries() {
    let s = Sandbox::new();
    s.edit("a.txt", "a\n");
    let file = s.context_file(CONTEXT);
    s.ok(&["commit", "-m", "Step one", "--context", &file], &[]);
    s.api.failing.store(true, Ordering::Release);
    let pushed = s.ok(&["push"], &[]);
    assert_eq!(pushed["steps"]["uploaded"], json!(0));
    assert!(
        pushed["warnings"][0]
            .as_str()
            .unwrap()
            .contains("gm context sync"),
        "{pushed}"
    );
    s.api.failing.store(false, Ordering::Release);
    let synced = s.ok(&["context", "sync"], &[]);
    assert_eq!(synced["uploaded"], json!(1), "{synced}");
    assert_eq!(s.api.uploads().len(), 1);
    // Nothing left to send.
    assert_eq!(s.ok(&["context", "sync"], &[])["uploaded"], json!(0));
}

#[test]
fn a_rewritten_commit_carries_its_change_context_as_a_new_version() {
    let s = Sandbox::new();
    s.edit("a.txt", "a\n");
    let file = s.context_file(CONTEXT);
    s.ok(&["commit", "-m", "First wording", "--context", &file], &[]);
    // Reword the committed change: a new commit, the same change ID.
    s.ok(&["describe", "@-", "-m", "Better wording"], &[]);
    s.ok(&["push"], &[]);
    let uploads = s.api.uploads();
    assert_eq!(uploads.len(), 1, "{uploads:?}");
    let head = git(&s.root.join("remote.git"), &["rev-parse", "main"]);
    assert_eq!(uploads[0]["commitOid"], json!(head));
    assert_eq!(uploads[0]["summary"], json!("Better wording"));
    assert_eq!(uploads[0]["why"], json!("Recency matters more than score."));
}

#[test]
fn context_is_redacted_before_it_leaves_and_bad_context_changes_nothing() {
    let s = Sandbox::new();
    s.edit("a.txt", "a\n");
    let file = s.context_file("## Why\nUsed gmx_abcdefghijklmnopqrst to test.\nAPI_KEY=hunter2\n");
    s.ok(&["commit", "-m", "Step", "--context", &file], &[]);
    s.ok(&["push"], &[]);
    let why = s.api.uploads()[0]["why"].as_str().unwrap().to_string();
    assert!(!why.contains("gmx_abcdefghijklmnopqrst"), "{why}");
    assert!(why.contains("API_KEY=[redacted]"), "{why}");

    s.edit("b.txt", "b\n");
    let bad = s.context_file("nothing useful");
    let (code, value, _) = s.run(&["commit", "-m", "Nope", "--context", &bad], &[]);
    assert_ne!(code, 0, "{value}");
    // The working copy still holds the edit: nothing was committed.
    let status = s.ok(&["status"], &[]);
    assert!(status.to_string().contains("b.txt"), "{status}");
}

#[test]
fn an_agent_step_in_a_timeline_without_context_warns_but_commits() {
    let s = Sandbox::new();
    s.edit("a.txt", "a\n");
    let (code, value, stderr) = s.run(
        &["commit", "-m", "Quiet step"],
        &[("GM_TIMELINE", "search")],
    );
    assert_eq!(code, 0, "{stderr} {value}");
    assert!(
        value["warnings"][0]
            .as_str()
            .unwrap_or_default()
            .contains("timeline search has no context"),
        "{value}"
    );
    // Outside a timeline, no warning.
    s.edit("b.txt", "b\n");
    let plain = s.ok(&["commit", "-m", "Plain"], &[]);
    assert!(plain.get("warnings").is_none(), "{plain}");
}
