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
                // The timeline's owned work source (CORE-255): what `work_source` validates.
                let source = json!({"sourceId": "work_search", "repoId": "r1", "timelineId": "tl_search",
                    "kind": "timeline-work", "ref": "refs/heads/work"});
                if method == "GET" && path.starts_with("/api/tracker/orbit/timelines/search?") {
                    let text = json!({"timeline": {"id": "tl_search", "slug": "search", "status": "active",
                        "repos": [{"id": "r1", "owner": "orbit", "name": "engine", "bookmark": "work", "source": source}]},
                        "events": [], "next": null}).to_string();
                    let _ = write!(
                        stream,
                        "HTTP/1.1 200 Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
                        text.len()
                    );
                    continue;
                }
                if method == "GET" && path == "/api/repos/orbit/engine?source=work_search" {
                    let text = json!({"source": source,
                        "cloneUrl": format!("http://{address}/orbit/engine@search.git")})
                    .to_string();
                    let _ = write!(
                        stream,
                        "HTTP/1.1 200 Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
                        text.len()
                    );
                    continue;
                }
                // A timeline's steps upload names its source (`?source=`).
                let is_upload =
                    method == "POST" && path.split('?').next().unwrap_or("").ends_with("/steps");
                let is_list =
                    method == "GET" && path.contains("/steps?") && !path.contains("/live?");
                let (code, reply) = if (is_upload || is_list) && fail.load(Ordering::Acquire) {
                    (500, json!({"error": "Something went wrong on our side."}))
                } else if method == "GET" && path.contains("/steps/live?") {
                    // A short live feed: two records, then the stream ends.
                    let after = path
                        .split("after=")
                        .nth(1)
                        .and_then(|v| v.split('&').next())
                        .unwrap_or("0")
                        .to_string();
                    let body = if path.contains("timeline=secret") {
                        None
                    } else {
                        Some((1..=3).filter(|n| n.to_string() > after).map(|n| {
                            format!("id: {n}\nevent: step\ndata: {}\n\n", json!({"seq": n, "repo": "x/y", "timeline": "search", "summary": format!("Step {n}"), "commitOid": "a".repeat(40), "author": {"name": "builder"}, "tests": {"passed": 1, "failed": 0}, "why": "Because.", "at": "2026-10-04T12:00:00.000Z"}))
                        }).collect::<String>())
                    };
                    let (code, text, kind) = match body {
                        Some(b) => (200, format!("retry: 5000\n\n{b}"), "text/event-stream"),
                        None => (
                            404,
                            json!({"error": "Not found."}).to_string(),
                            "application/json",
                        ),
                    };
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {code} Fixture\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
                        text.len()
                    );
                    continue;
                } else if is_list {
                    // The server's view: uploaded steps for the asked commits, verified.
                    let commits = path
                        .split("commits=")
                        .nth(1)
                        .unwrap_or("")
                        .split('&')
                        .next()
                        .unwrap_or("")
                        .to_string();
                    let steps: Vec<Value> = seen
                        .lock()
                        .unwrap()
                        .iter()
                        .map(|(_, up)| up)
                        .filter(|up| commits.split(',').any(|c| up["commitOid"] == json!(c)))
                        .map(|up| {
                            let mut context = up.clone();
                            for key in ["changeId", "commitOid", "summary", "committedAt", "timeline", "issue"] {
                                context.as_object_mut().unwrap().remove(key);
                            }
                            json!({
                                "changeId": up["changeId"],
                                "commitOid": up["commitOid"],
                                "summary": up["summary"],
                                "timeline": up["timeline"],
                                "issue": null,
                                "verified": true,
                                "deleted": false,
                                "committedAt": up["committedAt"],
                                "author": {"kind": "agent", "name": "claude-code", "accountable": {"displayName": "Pat"}},
                                "context": context,
                            })
                        })
                        .collect();
                    (200, json!({"steps": steps, "cursor": null}))
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

    fn upload_paths(&self) -> Vec<String> {
        self.uploads
            .lock()
            .unwrap()
            .iter()
            .map(|(p, _)| p.clone())
            .collect()
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
        git(
            &root,
            &["clone", "-q", "--bare", "remote.git", "source.git"],
        );
        git(&root, &["clone", "-q", "remote.git", "work"]);
        git(&root.join("work"), &["config", "user.name", "Agent"]);
        git(
            &root.join("work"),
            &["config", "user.email", "agent@example.com"],
        );
        // origin is the server's canonical URL; a timeline's work goes to its
        // owned source (`@search.git`). Both resolve to local bare repositories.
        let api = Api::new();
        let canonical = format!("http://{}/orbit/engine.git", api.address);
        let scoped = format!("http://{}/orbit/engine@search.git", api.address);
        git(
            &root.join("work"),
            &["remote", "set-url", "origin", &canonical],
        );
        for (local, url) in [("remote.git", &canonical), ("source.git", &scoped)] {
            git(
                &root.join("work"),
                &[
                    "config",
                    &format!("url.{}.insteadOf", root.join(local).display()),
                    url,
                ],
            );
        }
        let sandbox = Sandbox {
            _dir: dir,
            root,
            api,
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

    /// Timeline search's owned work source starts from main (`refs/heads/work`).
    fn start_timeline(&self) {
        git(
            &self.root.join("seed"),
            &[
                "push",
                "-q",
                self.root.join("source.git").to_str().unwrap(),
                "main:refs/heads/work",
            ],
        );
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

#[test]
fn reads_show_local_steps_as_unverified_and_pushed_ones_from_the_server() {
    let s = Sandbox::new();
    s.edit("a.txt", "a\n");
    let file = s.context_file(CONTEXT);
    s.ok(
        &["commit", "-m", "Rank by recency", "--context", &file],
        &[],
    );

    // Local only: from the journal, not verified.
    let shown = s.ok(&["context", "show"], &[]);
    assert_eq!(shown["step"]["origin"], json!("local"), "{shown}");
    assert_eq!(shown["step"]["verified"], json!(false));
    assert_eq!(
        shown["step"]["context"]["why"],
        json!("Recency matters more than score.")
    );
    assert!(shown["step"]["context"].get("commitOid").is_none());
    let change = shown["change_id"].as_str().unwrap().to_string();

    let log = s.ok(&["log", "--context"], &[]);
    let short = &change[..8];
    assert_eq!(log["steps"][short]["origin"], json!("local"), "{log}");
    assert!(s.ok(&["log"], &[]).get("steps").is_none());

    let show = s.ok(&["show", "@-", "--context"], &[]);
    assert_eq!(
        show["step"]["context"]["steering"][0]["text"],
        json!("Keep the old order as a fallback")
    );
    let none = s.ok(&["show", "@", "--context"], &[]);
    assert_eq!(none["step"], Value::Null, "{none}");
    assert!(s.ok(&["show", "@"], &[]).get("step").is_none());

    // Pushed: the server's verified copy, with its author.
    s.ok(&["push"], &[]);
    let shown = s.ok(&["context", "show", "trunk"], &[]);
    assert_eq!(shown["step"]["origin"], json!("server"), "{shown}");
    assert_eq!(shown["step"]["verified"], json!(true));
    assert_eq!(shown["step"]["author"]["name"], json!("claude-code"));

    // Text for people: the why on the log line, the whole context in show.
    let (_, text, _) = s.run(&["log", "--context", "-r", "trunk", "-o", "text"], &[]);
    assert!(
        text.as_str()
            .unwrap_or_default()
            .contains("why: Recency matters more than score."),
        "{text}"
    );
    let (_, text, _) = s.run(&["context", "show", "trunk", "-o", "text"], &[]);
    let text = text.as_str().unwrap_or_default().to_string();
    assert!(text.contains("claude-code (for Pat) · verified"), "{text}");
    assert!(
        text.contains("  - Rank results by recency (agent)"),
        "{text}"
    );

    // The server unreachable: a note, and the journal's copy.
    s.api.failing.store(true, Ordering::Release);
    let shown = s.ok(&["context", "show", "trunk"], &[]);
    assert_eq!(shown["step"]["origin"], json!("local"));
    assert!(
        shown["note"]
            .as_str()
            .unwrap()
            .contains("Couldn't read step context"),
        "{shown}"
    );
}

const CI_YML: &str = "on:\n  push: {}\n  step: {}\njobs:\n  lint:\n    on: step\n    local: true\n    steps: [\"echo checked 3 files\"]\n  unit:\n    on: [push, step]\n    local: true\n    needs: [lint]\n    env: { CODE: \"3\" }\n    steps: [\"echo 2 failed\", \"exit $CODE\"]\n  docs:\n    on: step\n    local: true\n    needs: [unit]\n    steps: [\"echo never\"]\n  deploy:\n    steps: [\"echo not local\"]\n";

#[test]
fn gm_test_runs_local_step_jobs_and_the_next_commit_carries_them() {
    let s = Sandbox::new();
    fs::create_dir_all(s.work().join(".gitmatrix")).unwrap();
    s.edit(".gitmatrix/ci.yml", CI_YML);
    let (code, tested, stderr) = s.run(&["test"], &[]);
    assert_eq!(code, 1, "a failed job fails gm test: {stderr}");
    assert!(
        stderr.contains("checked 3 files"),
        "output streams to stderr: {stderr}"
    );
    let jobs: Vec<(String, String, Value)> = tested["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|j| {
            (
                j["name"].as_str().unwrap().into(),
                j["status"].as_str().unwrap().into(),
                j["exit"].clone(),
            )
        })
        .collect();
    assert_eq!(
        jobs,
        vec![
            ("lint".into(), "passed".into(), json!(0)),
            ("unit".into(), "failed".into(), json!(3)),
            ("docs".into(), "skipped".into(), Value::Null),
        ]
    );
    assert_eq!(tested["jobs"][1]["summary"], json!("2 failed"));
    assert_eq!(
        tested["jobs"][2]["summary"],
        json!("needs unit, which failed")
    );

    // A commit of exactly the tested tree carries the results as its tests.
    let file = s.context_file("## Why\nAdd CI.\n");
    s.ok(&["commit", "-m", "Add CI", "--context", &file], &[]);
    s.ok(&["push"], &[]);
    let tests = s.api.uploads()[0]["tests"].clone();
    assert_eq!(tests.as_array().unwrap().len(), 3, "{tests}");
    assert_eq!(
        tests[1],
        json!({"command": "gm test: unit", "exit": 3, "summary": "2 failed", "durationMs": tests[1]["durationMs"], "origin": "local"})
    );

    // A different tree doesn't get stale results.
    s.edit("other.txt", "x\n");
    s.ok(&["commit", "-m", "Other", "--context", &file], &[]);
    s.ok(&["push"], &[]);
    assert!(
        s.api.uploads()[1].get("tests").is_none(),
        "{}",
        s.api.uploads()[1]
    );
}

#[test]
fn gm_step_works_only_in_a_timeline_and_tests_commits_and_pushes() {
    let s = Sandbox::new();
    let (code, value, _) = s.run(&["step", "-m", "Outside"], &[]);
    assert_ne!(code, 0);
    assert_eq!(value["error"]["code"], json!("not_in_timeline"), "{value}");

    // A timeline's owned work source, and a passing local job.
    s.start_timeline();
    fs::create_dir_all(s.work().join(".gitmatrix")).unwrap();
    s.edit(
        ".gitmatrix/ci.yml",
        "on: [push, step]\njobs:\n  lint:\n    on: step\n    local: true\n    steps: [\"echo lint ok\"]\n",
    );
    s.edit("rank.rs", "fn rank() {}\n");
    let file = s.context_file(CONTEXT);
    let timeline = [("GM_TIMELINE", "search")];
    s.ok(&["sync"], &timeline);
    let stepped = s.ok(
        &["step", "-m", "Rank by recency", "--context", &file],
        &timeline,
    );
    assert_eq!(stepped["tests"]["passed"], json!(1), "{stepped}");
    assert_eq!(
        stepped["push"]["bookmark"],
        json!("timeline/search"),
        "{stepped}"
    );
    assert_eq!(stepped["push"]["steps"]["uploaded"], json!(1), "{stepped}");
    let up = &s.api.uploads()[0];
    assert_eq!(up["why"], json!("Recency matters more than score."));
    assert_eq!(up["tests"][0]["command"], json!("gm test: lint"));
    assert_eq!(up["timeline"], json!("search"));
    // The step went to the work source, never to canonical.
    let tip = git(
        &s.root.join("source.git"),
        &["rev-parse", "refs/heads/work"],
    );
    assert_eq!(up["commitOid"], json!(tip));
    assert_eq!(
        s.api.upload_paths()[0],
        "/api/repos/orbit/engine/steps?source=work_search"
    );
    let canonical = git(
        &s.root.join("remote.git"),
        &["for-each-ref", "--format=%(refname)"],
    );
    assert_eq!(canonical, "refs/heads/main");

    // --no-test, and no context: still a step, with the warning.
    s.edit("rank.rs", "fn rank() { 1 }\n");
    let quiet = s.ok(&["step", "-m", "Tweak", "--no-test"], &timeline);
    assert_eq!(quiet["tests"], Value::Null);
    assert!(
        quiet["commit"]["warnings"][0]
            .as_str()
            .unwrap()
            .contains("has no context"),
        "{quiet}"
    );
}

#[test]
fn gm_steps_lists_and_follows_a_timeline_live() {
    let s = Sandbox::new();
    let (code, value, _) = s.run(&["steps"], &[]);
    assert_ne!(code, 0);
    assert_eq!(value["error"]["code"], json!("not_in_timeline"), "{value}");

    let timeline = [("GM_TIMELINE", "search")];
    let listed = s.ok(&["steps"], &timeline);
    assert_eq!(listed["timeline"], json!("search"), "{listed}");

    // --follow: one JSON object per record, stopping after --count.
    let mut command = Command::new(env!("CARGO_BIN_EXE_gm"));
    command
        .current_dir(s.work())
        .args(["steps", "--follow", "--count", "2"])
        .env("GM_AGENT", "1")
        .env("GM_TIMELINE", "search")
        .env("GM_SERVER", format!("http://{}", s.api.address))
        .env("GM_TOKEN", "test-token")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("XDG_CONFIG_HOME", s.root.join("config"))
        .env("XDG_DATA_HOME", s.root.join("data"));
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let lines: Vec<Value> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(
        lines
            .iter()
            .map(|l| l["summary"].clone())
            .collect::<Vec<_>>(),
        vec![json!("Step 1"), json!("Step 2")]
    );

    // At a terminal: a line of text per step.
    let (code, text, _) = s.run(
        &["steps", "--follow", "--count", "1", "-o", "text"],
        &timeline,
    );
    assert_eq!(code, 0);
    let text = text.as_str().unwrap_or_default().to_string();
    assert!(
        text.contains("builder") && text.contains("Step 1") && text.contains("why: Because."),
        "{text}"
    );

    // A feed the reader can't see is an error, not an endless retry.
    let (code, value, _) = s.run(&["steps", "--follow", "--timeline", "secret"], &[]);
    assert_ne!(code, 0);
    assert_eq!(value["error"]["code"], json!("not_found"), "{value}");
}

/// Runs `gm hook claude-code` with a UserPromptSubmit event on stdin.
fn hook(s: &Sandbox, session: &str, prompt: &str, env: &[(&str, &str)]) -> (i32, String) {
    use std::io::Write as _;
    let mut command = Command::new(env!("CARGO_BIN_EXE_gm"));
    command
        .current_dir(s.work())
        .args(["hook", "claude-code"])
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("XDG_CONFIG_HOME", s.root.join("config"))
        .env("XDG_DATA_HOME", s.root.join("data"))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped());
    for (name, value) in env {
        command.env(name, value);
    }
    let mut child = command.spawn().unwrap();
    let event = json!({
        "session_id": session,
        "hook_event_name": "UserPromptSubmit",
        "cwd": s.work(),
        "prompt": prompt,
    });
    child
        .stdin
        .take()
        .unwrap()
        .write_all(event.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    (
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).to_string(),
    )
}

#[test]
fn codex_and_oh_my_pi_hooks_share_the_contract_and_name_their_harness() {
    let s = Sandbox::new();
    let timeline = [("GM_TIMELINE", "search")];
    let run = |harness: &str, prompt: &str| {
        use std::io::Write as _;
        let mut child = Command::new(env!("CARGO_BIN_EXE_gm"))
            .current_dir(s.work())
            .args(["hook", harness])
            .env("GM_TIMELINE", "search")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let event = json!({"session_id": harness, "cwd": s.work(), "prompt": prompt});
        child
            .stdin
            .take()
            .unwrap()
            .write_all(event.to_string().as_bytes())
            .unwrap();
        let out = child.wait_with_output().unwrap();
        assert_eq!((out.status.code(), out.stdout.len()), (Some(0), 0));
    };
    run("codex", "Add a cache");
    // An unknown harness is ignored, quietly.
    run("nonsense", "Not kept");
    s.start_timeline();
    s.ok(&["sync"], &timeline);
    s.edit("cache.rs", "fn cache() {}\n");
    let file = s.context_file("## Why\nSpeed.\n");
    s.ok(&["commit", "-m", "Cache", "--context", &file], &timeline);
    s.ok(&["push"], &timeline);
    let up = s.api.uploads()[0].clone();
    assert_eq!(up["instructions"][0]["text"], json!("Add a cache"));
    assert_eq!(up["instructions"].as_array().unwrap().len(), 1, "{up}");
    assert_eq!(up["coverage"]["instructions"], json!("hook:codex"));
    // Oh My Pi's extension calls `gm hook pi`.
    run("pi", "Use the pi hook");
    s.edit("cache.rs", "fn cache() { 1 }\n");
    s.ok(&["commit", "-m", "More", "--context", &file], &timeline);
    s.ok(&["push"], &timeline);
    let next = s.api.uploads()[1].clone();
    assert_eq!(next["instructions"][0]["text"], json!("Use the pi hook"));
    assert_eq!(next["coverage"]["instructions"], json!("hook:pi"));
}

#[test]
fn the_claude_code_hook_puts_the_persons_words_on_the_next_step() {
    let s = Sandbox::new();
    let timeline = [("GM_TIMELINE", "search")];
    // Outside a timeline nothing is kept; the hook never prints or fails.
    assert_eq!(hook(&s, "s1", "Not a step", &[]), (0, String::new()));
    // In a timeline: the session's first prompt is an instruction, then steering.
    hook(&s, "s1", "Rank search results by recency", &timeline);
    hook(
        &s,
        "s1",
        "Keep score as the tie-breaker; the key is gmx_abcdefghijklmnopqrst",
        &timeline,
    );
    let (code, out) = hook(&s, "s1", "  ", &timeline);
    assert_eq!((code, out), (0, String::new()));

    s.start_timeline();
    s.ok(&["sync"], &timeline);
    s.edit("rank.rs", "fn rank() {}\n");
    let file = s.context_file("## Why\nRecency matters.\n\n## Steering\n- Noted the tie-breaker\n");
    s.ok(
        &["commit", "-m", "Rank by recency", "--context", &file],
        &timeline,
    );
    s.ok(&["push"], &timeline);
    let up = s.api.uploads()[0].clone();
    assert_eq!(
        up["instructions"],
        json!([{"text": "Rank search results by recency", "source": "hook", "at": up["instructions"][0]["at"]}])
    );
    let steering = up["steering"].as_array().unwrap();
    assert_eq!(steering.len(), 2, "{up}");
    assert_eq!(steering[0]["source"], json!("hook"));
    assert!(
        steering[0]["text"]
            .as_str()
            .unwrap()
            .starts_with("Keep score as the tie-breaker")
    );
    assert!(
        !steering[0]["text"]
            .as_str()
            .unwrap()
            .contains("gmx_abcdefghijklmnopqrst"),
        "redacted"
    );
    assert_eq!(
        steering[1],
        json!({"text": "Noted the tie-breaker", "source": "agent"})
    );
    assert_eq!(
        up["coverage"],
        json!({"instructions": "hook:claude-code", "steering": "hook:claude-code"})
    );

    // The step took them: the next one starts empty, still covered by the hook.
    s.edit("rank.rs", "fn rank() { 1 }\n");
    s.ok(&["commit", "-m", "Tweak", "--context", &file], &timeline);
    s.ok(&["push"], &timeline);
    let next = s.api.uploads()[1].clone();
    assert!(next.get("instructions").is_none(), "{next}");
    assert_eq!(next["coverage"]["steering"], json!("hook:claude-code"));
}
