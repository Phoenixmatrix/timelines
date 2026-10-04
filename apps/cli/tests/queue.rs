//! Queue admission is not a main push: exercise the compiled CLI, real Git
//! objects/refs, and a stateful HTTP authority in an isolated checkout.
#![cfg(unix)]

use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env_remove("GIT_CONFIG_COUNT")
        .env_remove("GIT_CONFIG_PARAMETERS")
        .env("GIT_AUTHOR_NAME", "Fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@example.test")
        .env("GIT_COMMITTER_NAME", "Fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@example.test")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

#[derive(Clone, Copy, Default)]
enum Admission {
    #[default]
    Accept,
    Reject,
    NoQueueApi,
    Unavailable,
    // The authority commits admission, but the response is lost.
    LoseReply,
}

#[derive(Default)]
struct State {
    admission: Admission,
    entries: BTreeMap<String, Value>,
    transitions: BTreeMap<String, VecDeque<Value>>,
    writes: usize,
    runs: BTreeMap<i64, Value>,
    reads: usize,
}

fn entry(id: &str, status: &str) -> Value {
    json!({
        "id": id, "repo": {"id": "repo", "owner": "orbit", "name": "engine"},
        "commit": id, "branch": "main", "sourceBranch": format!("gitmatrix/queue/{id}"),
        "candidateBranch": format!("gitmatrix/landing/queue-{id}"), "status": status,
        "base": null, "candidate": null, "mergeRun": null, "gateRun": null,
        "deployRun": null, "deployStatus": null, "coveredBy": null,
        "issueIds": [], "remediationIssueId": null, "failure": null, "decision": null,
        "attempts": 1, "createdAt": "2026-10-04T00:00:00Z", "updatedAt": "2026-10-04T00:00:00Z"
    })
}

struct Api {
    address: SocketAddr,
    state: Arc<Mutex<State>>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Api {
    fn new(remote: PathBuf) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let state = Arc::new(Mutex::new(State::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let (shared, halt) = (state.clone(), stop.clone());
        let worker = thread::spawn(move || {
            let owner = remote
                .parent()
                .unwrap()
                .file_name()
                .unwrap()
                .to_str()
                .unwrap();
            let name = remote.file_stem().unwrap().to_str().unwrap();
            let prefix = format!("/api/repos/{owner}/{name}/queue");
            for stream in listener.incoming() {
                if halt.load(Ordering::Acquire) {
                    break;
                }
                let mut stream = stream.unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut reader = BufReader::new(&mut stream);
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
                let mut parts = line.split_whitespace();
                let method = parts.next().unwrap().to_owned();
                let path = parts.next().unwrap().to_owned();
                let mut length = 0;
                loop {
                    line.clear();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some((key, value)) = line.split_once(':')
                        && key.eq_ignore_ascii_case("content-length")
                    {
                        length = value.trim().parse().unwrap();
                    }
                }
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                drop(reader);
                let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                let mut state = shared.lock();
                let (code, reply) = if method == "POST" && path == prefix {
                    state.writes += 1;
                    let id = body["commit"].as_str().unwrap();
                    // Rejecting an upload that doesn't really exist catches fake/local-only staging.
                    assert_eq!(
                        git(
                            &remote,
                            &["rev-parse", &format!("refs/heads/gitmatrix/queue/{id}")]
                        ),
                        id
                    );
                    if matches!(state.admission, Admission::Reject) {
                        (
                            409,
                            json!({"error": "queue_rejected", "message": "Admission rejected"}),
                        )
                    } else if matches!(state.admission, Admission::NoQueueApi) {
                        (404, json!({"error": "not_found"}))
                    } else if matches!(state.admission, Admission::Unavailable) {
                        (503, json!({"error": "unavailable"}))
                    } else {
                        let e = state
                            .entries
                            .entry(id.to_owned())
                            .or_insert_with(|| entry(id, "queued"))
                            .clone();
                        if matches!(state.admission, Admission::LoseReply) {
                            continue;
                        }
                        (201, json!({"entry": e}))
                    }
                } else if method == "POST"
                    && path.starts_with(&format!("{prefix}/"))
                    && path.ends_with("/cancel")
                {
                    let id = path
                        .strip_prefix(&format!("{prefix}/"))
                        .unwrap()
                        .strip_suffix("/cancel")
                        .unwrap();
                    match state.entries.get_mut(id) {
                        Some(e) => {
                            e["status"] = json!("cancelled");
                            (200, json!({"entry": e.clone()}))
                        }
                        None => (404, json!({"error": "not_found"})),
                    }
                } else if method == "GET" && path.starts_with(&format!("{prefix}/")) {
                    state.reads += 1;
                    let id = path.strip_prefix(&format!("{prefix}/")).unwrap();
                    if let Some(next) = state.transitions.get_mut(id).and_then(VecDeque::pop_front)
                    {
                        state.entries.insert(id.to_owned(), next);
                    }
                    match state.entries.get(id) {
                        Some(e) => (200, json!({"entry": e})),
                        None => (404, json!({"error": "not_found"})),
                    }
                } else if method == "GET"
                    && path.starts_with(&format!("/api/repos/{owner}/{name}/ci/runs/"))
                {
                    let number: i64 = path.rsplit('/').next().unwrap().parse().unwrap();
                    match state.runs.get(&number) {
                        Some(run) => (200, run.clone()),
                        None => (404, json!({"error": "not_found"})),
                    }
                } else {
                    (404, json!({"error": "unexpected_request", "path": path}))
                };
                drop(state);
                let text = reply.to_string();
                let _ = write!(
                    stream,
                    "HTTP/1.1 {code} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
                    text.len()
                );
            }
        });
        Self {
            address,
            state,
            stop,
            worker: Some(worker),
        }
    }

    fn set(&self, e: Value) {
        self.state
            .lock()
            .entries
            .insert(e["id"].as_str().unwrap().to_owned(), e);
    }
}

impl Drop for Api {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_secs(3));
        if let Some(worker) = self.worker.take() {
            let result = worker.join();
            if !thread::panicking() {
                result.unwrap();
            }
        }
    }
}

struct Sandbox {
    // Drop the HTTP worker before deleting its repository.
    api: Api,
    root: tempfile::TempDir,
}

impl Sandbox {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("orbit")).unwrap();
        git(
            root.path(),
            &["init", "-q", "--bare", "-b", "main", "orbit/engine.git"],
        );
        git(root.path(), &["clone", "-q", "orbit/engine.git", "seed"]);
        fs::write(root.path().join("seed/README.md"), "initial\n").unwrap();
        git(&root.path().join("seed"), &["add", "."]);
        git(&root.path().join("seed"), &["commit", "-qm", "Initial"]);
        git(&root.path().join("seed"), &["push", "-q", "origin", "main"]);
        git(root.path(), &["clone", "-q", "orbit/engine.git", "work"]);
        git(&root.path().join("work"), &["config", "user.name", "Agent"]);
        git(
            &root.path().join("work"),
            &["config", "user.email", "agent@example.test"],
        );
        let api = Api::new(root.path().join("orbit/engine.git"));
        let s = Self { api, root };
        s.ok(&["init"]);
        s
    }

    fn work(&self) -> PathBuf {
        self.root.path().join("work")
    }
    fn remote(&self, args: &[&str]) -> String {
        git(&self.root.path().join("orbit/engine.git"), args)
    }

    fn run(&self, args: &[&str]) -> (i32, Value) {
        self.run_with_api(args, &self.api)
    }

    fn run_with_api(&self, args: &[&str], api: &Api) -> (i32, Value) {
        let mut child = Command::new(env!("CARGO_BIN_EXE_gm"))
            .current_dir(self.work())
            .args(args)
            .env("GM_AGENT", "1")
            .env_remove("GM_TIMELINE")
            .env_remove("GITMATRIX_ACCESS_TOKEN")
            .env_remove("GITMATRIX_ACCESS_ORIGIN")
            .env("GM_SERVER", format!("http://{}", api.address))
            .env("GM_TOKEN", "fixture-token")
            .env("HOME", self.root.path().join("home"))
            .env("XDG_CONFIG_HOME", self.root.path().join("config"))
            .env("XDG_DATA_HOME", self.root.path().join("data"))
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env_remove("GIT_CONFIG_COUNT")
            .env_remove("GIT_CONFIG_PARAMETERS")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while child.try_wait().unwrap().is_none() {
            if Instant::now() >= deadline {
                let _ = child.kill();
                let output = child.wait_with_output().unwrap();
                panic!(
                    "gm {args:?} did not terminate: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            thread::sleep(Duration::from_millis(10));
        }
        let output = child.wait_with_output().unwrap();
        let value = serde_json::from_slice(&output.stdout)
            .or_else(|_| serde_json::from_slice(&output.stderr))
            .unwrap_or_else(|_| json!({"stdout": String::from_utf8_lossy(&output.stdout), "stderr": String::from_utf8_lossy(&output.stderr)}));
        (output.status.code().unwrap_or(-1), value)
    }

    fn ok(&self, args: &[&str]) -> Value {
        let (code, value) = self.run(args);
        assert_eq!(code, 0, "gm {args:?}: {value}");
        value
    }

    fn fails(&self, args: &[&str]) -> Value {
        let (code, value) = self.run(args);
        assert_ne!(code, 0, "gm {args:?} falsely succeeded: {value}");
        value
    }

    fn commit(&self, file: &str, description: &str) {
        fs::write(self.work().join(file), format!("{description}\n")).unwrap();
        self.ok(&["commit", "-m", description]);
    }

    fn change(&self, description: &str) -> Value {
        self.ok(&["log"])["changes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["description"] == description)
            .unwrap_or_else(|| panic!("lost change {description}"))
            .clone()
    }

    fn submit(&self) -> String {
        self.ok(&["push", "--queue"])["queue"]["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }
}

#[test]
fn queued_work_stays_mutable_and_next_submission_does_not_advance_main() {
    let s = Sandbox::new();
    let main = s.remote(&["rev-parse", "main"]);
    s.commit("first.txt", "First");
    let first = s.submit();
    assert_eq!(
        s.remote(&["rev-parse", &format!("refs/heads/gitmatrix/queue/{first}")]),
        first
    );
    assert_eq!(s.remote(&["rev-parse", "main"]), main);
    assert_eq!(
        git(&s.work(), &["rev-parse", "refs/remotes/origin/main"]),
        main
    );
    assert_eq!(s.change("First")["immutable"], false);
    s.ok(&["describe", "@-", "-m", "First revised"]);
    s.commit("second.txt", "Second");
    let second = s.submit();
    assert_ne!(first, second);
    assert_eq!(s.remote(&["rev-parse", "main"]), main);
    assert_eq!(s.change("First revised")["immutable"], false);
    assert_eq!(s.change("Second")["immutable"], false);
    assert_eq!(s.remote(&["show", &format!("{second}:first.txt")]), "First");
    assert_eq!(
        s.remote(&["show", &format!("{second}:second.txt")]),
        "Second"
    );
}

#[test]
fn rejected_and_uncertain_admission_preserve_work_and_allow_direct_recovery() {
    for admission in [Admission::Reject, Admission::LoseReply] {
        let s = Sandbox::new();
        let main = s.remote(&["rev-parse", "main"]);
        s.api.state.lock().admission = admission;
        // Deliberately unsnapshotted edits: the failed network path must persist them too.
        fs::write(s.work().join("saved.txt"), "durable work\n").unwrap();
        s.ok(&["describe", "-m", "Saved"]);
        fs::write(s.work().join("later.txt"), "not previously snapshotted\n").unwrap();
        s.fails(&["push", "--queue"]);
        assert_eq!(s.remote(&["rev-parse", "main"]), main);
        let sources = s.remote(&[
            "for-each-ref",
            "--format=%(objectname)",
            "refs/heads/gitmatrix/queue/",
        ]);
        assert_eq!(sources.lines().count(), 1);
        assert_eq!(
            s.remote(&["show", &format!("{sources}:later.txt")]),
            "not previously snapshotted"
        );
        assert_eq!(s.change("Saved")["immutable"], false);
        s.ok(&["describe", "-m", "Saved after failure"]);
        s.ok(&["new"]);
        s.commit("next.txt", "Next");
        s.ok(&["push"]);
        assert_eq!(s.remote(&["show", "main:saved.txt"]), "durable work");
        assert_eq!(
            s.remote(&["show", "main:later.txt"]),
            "not previously snapshotted"
        );
        assert_eq!(s.remote(&["show", "main:next.txt"]), "Next");
    }
}

#[test]
fn sync_after_real_merge_preserves_unlanded_descendants() {
    let s = Sandbox::new();
    s.commit("first.txt", "First");
    let first = s.submit();
    s.commit("second.txt", "Second");
    let second_change = s.change("Second")["change_id"].clone();
    let seed = s.root.path().join("seed");
    git(&seed, &["fetch", "-q", "origin"]);
    git(&seed, &["merge", "--no-ff", "-m", "Queue merge", &first]);
    git(&seed, &["push", "-q", "origin", "main"]);
    s.ok(&["sync"]);
    assert_eq!(s.ok(&["show", &first])["change"]["immutable"], true);
    assert_eq!(s.change("Second")["immutable"], false);
    assert_eq!(s.change("Second")["change_id"], second_change);
    assert_eq!(
        fs::read_to_string(s.work().join("second.txt")).unwrap(),
        "Second\n"
    );
    let second = s.submit();
    assert_ne!(second, first);
    assert_eq!(
        s.remote(&["show", &format!("{second}:second.txt")]),
        "Second"
    );
    s.ok(&["push"]);
    assert_eq!(s.remote(&["show", "main:second.txt"]), "Second");
}

#[test]
fn sync_preserves_content_added_to_a_mutable_queued_revision() {
    for edit_older in [false, true] {
        let s = Sandbox::new();
        fs::write(s.work().join("first.txt"), "admitted work\n").unwrap();
        s.ok(&["describe", "-m", "Admitted"]);
        let change_id = s.change("Admitted")["change_id"]
            .as_str()
            .unwrap()
            .to_owned();
        let admitted = s.submit();
        if edit_older {
            s.ok(&["new"]);
            s.commit("descendant.txt", "Descendant");
            s.ok(&["edit", &change_id]);
        }
        fs::write(s.work().join("later.txt"), "unlanded addition\n").unwrap();
        if edit_older {
            // Rewrite the older change in place. `commit` instead inserts a
            // fresh unnamed working-copy child underneath its descendants.
            s.ok(&["describe", "-m", "Revised"]);
        } else {
            s.ok(&["commit", "-m", "Revised"]);
        }
        assert_eq!(s.change("Revised")["change_id"], change_id);
        if edit_older {
            let descendant = s.change("Descendant")["change_id"]
                .as_str()
                .unwrap()
                .to_owned();
            s.ok(&["edit", &descendant]);
            s.ok(&["new"]);
        }
        // Land the pinned admission, never its newer local rewrite.
        let seed = s.root.path().join("seed");
        git(&seed, &["fetch", "-q", "origin"]);
        git(&seed, &["merge", "--no-ff", "-m", "Queue merge", &admitted]);
        git(&seed, &["push", "-q", "origin", "main"]);
        s.ok(&["sync"]);
        assert_eq!(
            fs::read_to_string(s.work().join("later.txt")).unwrap(),
            "unlanded addition\n"
        );
        assert_eq!(s.change("Revised")["immutable"], false);
        assert_eq!(s.change("Revised")["change_id"], change_id);
        s.ok(&["push"]);
        assert_eq!(s.remote(&["show", "main:later.txt"]), "unlanded addition");
        assert_eq!(s.remote(&["show", "main:first.txt"]), "admitted work");
        if edit_older {
            assert_eq!(s.remote(&["show", "main:descendant.txt"]), "Descendant");
        }
    }
}

#[test]
fn sync_retains_conflicting_edits_to_a_queued_revision() {
    let s = Sandbox::new();
    fs::write(s.work().join("README.md"), "admitted revision\n").unwrap();
    s.ok(&["commit", "-m", "Admitted"]);
    let admitted = s.submit();
    s.ok(&["edit", "@-"]);
    fs::write(s.work().join("README.md"), "later local revision\n").unwrap();
    s.ok(&["commit", "-m", "Revised"]);
    let seed = s.root.path().join("seed");
    git(&seed, &["fetch", "-q", "origin"]);
    git(&seed, &["merge", "--no-ff", "-m", "Queue merge", &admitted]);
    fs::write(seed.join("README.md"), "newer main revision\n").unwrap();
    git(&seed, &["add", "."]);
    git(&seed, &["commit", "-qm", "Concurrent main edit"]);
    git(&seed, &["push", "-q", "origin", "main"]);
    let synced = s.ok(&["sync"]);
    assert_eq!(synced["conflicts"][0]["paths"][0], "README.md");
    assert!(
        fs::read_to_string(s.work().join("README.md"))
            .unwrap()
            .contains("later local revision")
    );
    assert_eq!(s.fails(&["push"])["error"]["code"], "has_conflicts");
}

#[test]
fn sync_deduplicates_equivalent_queued_rewrites_but_keeps_descendants() {
    let s = Sandbox::new();
    s.commit("first.txt", "Admitted");
    let admitted = s.submit();
    s.ok(&["describe", "@-", "-m", "Equivalent local rewrite"]);
    s.commit("later.txt", "Descendant");
    let seed = s.root.path().join("seed");
    git(&seed, &["fetch", "-q", "origin"]);
    git(&seed, &["merge", "--no-ff", "-m", "Queue merge", &admitted]);
    git(&seed, &["push", "-q", "origin", "main"]);
    s.ok(&["sync"]);
    let log = s.ok(&["log"]);
    assert!(
        !log["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|change| change["description"] == "Equivalent local rewrite")
    );
    assert_eq!(s.change("Descendant")["immutable"], false);
    s.ok(&["push"]);
    assert_eq!(s.remote(&["show", "main:first.txt"]), "Admitted");
    assert_eq!(s.remote(&["show", "main:later.txt"]), "Descendant");
}

#[test]
fn dry_run_and_timeline_refusal_do_not_stage_or_admit() {
    let s = Sandbox::new();
    s.commit("first.txt", "First");
    let refs = s.remote(&["show-ref"]);
    s.ok(&["push", "--queue", "--dry-run"]);
    assert_eq!(s.remote(&["show-ref"]), refs);
    assert_eq!(s.api.state.lock().writes, 0);
    assert_eq!(s.change("First")["immutable"], false);
    s.remote(&["update-ref", "refs/heads/timeline/search", "main"]);
    fs::create_dir_all(s.work().join(".gitmatrix")).unwrap();
    fs::write(
        s.work().join(".gitmatrix/agent.local.yml"),
        "timeline: search\n",
    )
    .unwrap();
    let refs = s.remote(&["show-ref"]);
    s.fails(&["push", "--queue"]);
    assert_eq!(s.remote(&["show-ref"]), refs);
    assert_eq!(s.api.state.lock().writes, 0);
}

#[test]
fn wait_distinguishes_landing_failure_cancellation_and_timeout() {
    let s = Sandbox::new();
    let id = "a".repeat(40);
    s.api.set(entry(&id, "queued"));
    assert_eq!(
        s.fails(&["queue", "wait", &id, "--timeout", "0"])["error"]["code"],
        "timeout"
    );
    for status in ["failed", "cancelled"] {
        s.api.set(entry(&id, status));
        assert_eq!(
            s.fails(&["queue", "wait", &id, "--timeout", "1"])["error"]["code"],
            format!("queue_{status}")
        );
    }
    s.api.state.lock().transitions.insert(
        id.clone(),
        VecDeque::from([entry(&id, "testing"), entry(&id, "landed")]),
    );
    s.ok(&["queue", "wait", &id, "--timeout", "10"]);
}

#[test]
fn coverage_uses_final_verdict_and_rejects_cycles_or_missing_targets() {
    let s = Sandbox::new();
    let first = "a".repeat(40);
    let second = "b".repeat(40);
    let mut covered = entry(&first, "covered");
    covered["coveredBy"] = json!(second);
    s.api.set(covered.clone());
    s.api.set(entry(&second, "failed"));
    s.fails(&["queue", "wait", &first, "--timeout", "1"]);
    s.api.set(entry(&second, "landed"));
    s.ok(&["queue", "wait", &first, "--timeout", "1"]);
    let mut cycle = entry(&second, "covered");
    cycle["coveredBy"] = json!(first);
    s.api.set(cycle);
    let before = s.api.state.lock().reads;
    s.fails(&["queue", "wait", &first, "--timeout", "10"]);
    assert!(
        s.api.state.lock().reads - before <= 65,
        "coverage cycle was polled instead of rejected"
    );
    for target in [Value::Null, json!(""), json!(42), json!("not-an-id")] {
        covered["coveredBy"] = target;
        s.api.set(covered.clone());
        s.fails(&["queue", "wait", &first, "--timeout", "1"]);
    }
}

#[test]
fn landing_alone_does_not_satisfy_deployment_wait() {
    let s = Sandbox::new();
    let id = "a".repeat(40);
    let mut e = entry(&id, "landed");
    e["deployStatus"] = json!("running");
    s.api.set(e.clone());
    s.ok(&["queue", "wait", &id, "--timeout", "1"]);
    assert_eq!(
        s.fails(&["queue", "wait", &id, "--deploy", "--timeout", "0"])["error"]["code"],
        "timeout"
    );
    for status in ["failed", "cancelled"] {
        e["deployStatus"] = json!(status);
        s.api.set(e.clone());
        s.fails(&["queue", "wait", &id, "--deploy", "--timeout", "1"]);
    }
    e["deployRun"] = json!(1);
    e["deployStatus"] = json!("succeeded");
    s.api.set(e);
    // A green original run is not proof when its covering run failed.
    s.api.state.lock().runs.insert(
        1,
        json!({"number": 1, "status": "succeeded", "coveredBy": 2}),
    );
    s.api.state.lock().runs.insert(
        2,
        json!({"number": 2, "status": "failed", "coveredBy": null}),
    );
    assert_eq!(
        s.fails(&["queue", "wait", &id, "--deploy", "--timeout", "1"])["error"]["code"],
        "deployment_failed"
    );
    s.api.state.lock().runs.insert(
        2,
        json!({"number": 2, "status": "succeeded", "coveredBy": null}),
    );
    let result = s.ok(&["queue", "wait", &id, "--deploy", "--timeout", "1"]);
    assert_eq!(result["entry"]["deployRun"], 2);
    s.api.state.lock().runs.insert(
        2,
        json!({"number": 2, "status": "succeeded", "coveredBy": 1}),
    );
    s.fails(&["queue", "wait", &id, "--deploy", "--timeout", "1"]);
    for target in [json!("two"), json!(0), json!(-1)] {
        s.api.state.lock().runs.insert(
            1,
            json!({"number": 1, "status": "succeeded", "coveredBy": target}),
        );
        s.fails(&["queue", "wait", &id, "--deploy", "--timeout", "1"]);
    }
}

#[test]
fn rejected_admission_after_sync_preserves_rebased_work() {
    let s = Sandbox::new();
    s.commit("local.txt", "Local");
    let change = s.change("Local")["change_id"].clone();
    let seed = s.root.path().join("seed");
    fs::write(seed.join("teammate.txt"), "remote work\n").unwrap();
    git(&seed, &["add", "."]);
    git(&seed, &["commit", "-qm", "Teammate"]);
    git(&seed, &["push", "-q", "origin", "main"]);
    let main = s.remote(&["rev-parse", "main"]);
    s.api.state.lock().admission = Admission::Reject;
    s.fails(&["push", "--queue", "--sync"]);
    assert_eq!(s.remote(&["rev-parse", "main"]), main);
    assert_eq!(s.change("Local")["change_id"], change);
    assert_eq!(s.change("Local")["immutable"], false);
    assert_eq!(
        fs::read_to_string(s.work().join("local.txt")).unwrap(),
        "Local\n"
    );
    assert_eq!(
        fs::read_to_string(s.work().join("teammate.txt")).unwrap(),
        "remote work\n"
    );
    s.ok(&["push"]);
    assert_eq!(s.remote(&["show", "main:local.txt"]), "Local");
    assert_eq!(s.remote(&["show", "main:teammate.txt"]), "remote work");
}

#[test]
fn wait_follows_released_submission_after_covering_group_fails() {
    let s = Sandbox::new();
    let original = "a".repeat(40);
    let leader = "b".repeat(40);
    let mut covered = entry(&original, "covered");
    covered["coveredBy"] = json!(leader);
    s.api.state.lock().transitions.insert(
        leader.clone(),
        VecDeque::from([entry(&leader, "testing"), entry(&leader, "failed")]),
    );
    // The scheduler releases the original after the combined attempt fails.
    // Its identity subsequently receives a fresh independent landing verdict.
    s.api.state.lock().transitions.insert(
        original.clone(),
        VecDeque::from([
            covered,
            entry(&original, "queued"),
            entry(&original, "landed"),
        ]),
    );
    let result = s.ok(&["queue", "wait", &original, "--timeout", "10"]);
    assert_eq!(result["entry"]["id"], original);
    assert_eq!(result["entry"]["status"], "landed");
}

#[test]
fn wait_revalidates_intermediate_coverage_before_any_terminal_verdict() {
    for stale_status in ["failed", "landed"] {
        let s = Sandbox::new();
        let original = "a".repeat(40);
        let middle = "b".repeat(40);
        let stale = "c".repeat(40);
        let mut a = entry(&original, "covered");
        a["coveredBy"] = json!(middle);
        s.api.set(a);
        let mut b = entry(&middle, "covered");
        b["coveredBy"] = json!(stale);
        s.api.state.lock().transitions.insert(
            middle.clone(),
            VecDeque::from([
                b,
                entry(&middle, "queued"),
                entry(&middle, "testing"),
                entry(&middle, "landed"),
            ]),
        );
        s.api.set(entry(&stale, stale_status));
        let result = s.ok(&["queue", "wait", &original, "--timeout", "10"]);
        assert_eq!(result["entry"]["id"], middle);
        assert_eq!(result["entry"]["status"], "landed");
    }
}

#[test]
fn sync_replays_post_admission_removals_without_reverting_new_main_work() {
    for descendant in [false, true] {
        for fetch_first in [false, true] {
            let s = Sandbox::new();
            if descendant {
                s.commit("parent.txt", "Parent");
            }
            fs::write(s.work().join("remove.txt"), "admitted addition\n").unwrap();
            fs::write(s.work().join("README.md"), "initial\nadmitted line\n").unwrap();
            s.ok(&["commit", "-m", "Admitted"]);
            let change = s.change("Admitted")["change_id"]
                .as_str()
                .unwrap()
                .to_owned();
            let admitted = s.submit();
            if descendant {
                let parent = s.change("Parent")["change_id"].as_str().unwrap().to_owned();
                s.ok(&["edit", &parent]);
                fs::write(s.work().join("local-parent.txt"), "unlanded parent edit\n").unwrap();
                s.ok(&["status"]);
            }
            s.ok(&["edit", &change]);
            fs::remove_file(s.work().join("remove.txt")).unwrap();
            fs::write(s.work().join("README.md"), "initial\n").unwrap();
            s.ok(&["commit", "-m", "Remove admitted work"]);
            let seed = s.root.path().join("seed");
            git(&seed, &["fetch", "-q", "origin"]);
            git(&seed, &["merge", "--no-ff", "-m", "Queue merge", &admitted]);
            fs::write(seed.join("new-main.txt"), "unrelated newer main work\n").unwrap();
            git(&seed, &["add", "."]);
            git(&seed, &["commit", "-qm", "New main work"]);
            git(&seed, &["push", "-q", "origin", "main"]);
            if fetch_first {
                s.ok(&["fetch"]);
            }
            s.ok(&["sync"]);
            assert!(!s.work().join("remove.txt").exists());
            assert_eq!(
                fs::read_to_string(s.work().join("README.md")).unwrap(),
                "initial\n"
            );
            assert_eq!(
                fs::read_to_string(s.work().join("new-main.txt")).unwrap(),
                "unrelated newer main work\n"
            );
            if descendant {
                assert_eq!(
                    fs::read_to_string(s.work().join("local-parent.txt")).unwrap(),
                    "unlanded parent edit\n"
                );
            }
            // Repeated sync must not replay the old receipt a second time.
            s.ok(&["sync"]);
            s.submit();
            s.ok(&["push"]);
            assert!(
                s.remote(&["ls-tree", "--name-only", "main", "remove.txt"])
                    .is_empty()
            );
            assert_eq!(s.remote(&["show", "main:README.md"]), "initial");
            assert_eq!(
                s.remote(&["show", "main:new-main.txt"]),
                "unrelated newer main work"
            );
            if descendant {
                assert_eq!(
                    s.remote(&["show", "main:local-parent.txt"]),
                    "unlanded parent edit"
                );
            }
        }
    }
}

#[test]
fn pending_rewritten_content_requires_explicit_cancellation_before_either_push_mode() {
    for queued in [false, true] {
        let s = Sandbox::new();
        let main = s.remote(&["rev-parse", "main"]);
        s.commit("remove.txt", "Admitted");
        let admitted = s.submit();
        s.ok(&["edit", "@-"]);
        fs::remove_file(s.work().join("remove.txt")).unwrap();
        fs::write(s.work().join("replacement.txt"), "replacement work\n").unwrap();
        s.ok(&["commit", "-m", "Replacement"]);
        let args: &[&str] = if queued {
            &["push", "--queue"]
        } else {
            &["push"]
        };
        assert_eq!(s.fails(args)["error"]["code"], "queued_revision_rewritten");
        assert_eq!(s.remote(&["rev-parse", "main"]), main);
        assert_eq!(s.api.state.lock().writes, 1);
        assert_eq!(
            fs::read_to_string(s.work().join("replacement.txt")).unwrap(),
            "replacement work\n"
        );
        s.ok(&["queue", "cancel", &admitted]);
        s.ok(args);
        s.ok(&["push"]);
        assert!(
            s.remote(&["ls-tree", "--name-only", "main", "remove.txt"])
                .is_empty()
        );
        assert_eq!(
            s.remote(&["show", "main:replacement.txt"]),
            "replacement work"
        );
    }
}

#[test]
fn queue_receipts_do_not_block_unchanged_direct_recovery_or_independent_descendants() {
    let s = Sandbox::new();
    s.commit("admitted.txt", "Admitted");
    let admitted = s.submit();
    // No status authority is available. Neither unchanged source nor a new
    // descendant depends on withdrawing that source's admission.
    s.api.state.lock().entries.remove(&admitted);
    s.commit("next.txt", "Independent descendant");
    s.ok(&["push"]);
    assert_eq!(s.remote(&["show", "main:admitted.txt"]), "Admitted");
    assert_eq!(
        s.remote(&["show", "main:next.txt"]),
        "Independent descendant"
    );
    assert_eq!(s.api.state.lock().reads, 0);
}

#[test]
fn uncertain_admission_blocks_only_its_rewritten_content_with_actionable_identity() {
    let s = Sandbox::new();
    s.commit("admitted.txt", "Admitted");
    let admitted = s.submit();
    s.ok(&["edit", "@-"]);
    fs::remove_file(s.work().join("admitted.txt")).unwrap();
    s.ok(&["commit", "-m", "Remove admitted"]);
    let change = s.change("Remove admitted")["change_id"]
        .as_str()
        .unwrap()
        .to_owned();
    s.api.state.lock().entries.remove(&admitted);
    let error = s.fails(&["push"]);
    let hint = error["error"]["hint"].as_str().unwrap();
    assert!(hint.contains(&admitted));
    assert!(hint.contains(&change));
    assert!(!s.work().join("admitted.txt").exists());
    // Selecting the exact earlier source remains a direct recovery path.
    s.ok(&["push", "-r", &admitted]);
    assert_eq!(s.remote(&["show", "main:admitted.txt"]), "Admitted");
}

#[test]
fn definitive_admission_rejection_allows_rewrite_but_server_uncertainty_does_not() {
    for admission in [Admission::NoQueueApi, Admission::Unavailable] {
        let s = Sandbox::new();
        s.commit("admitted.txt", "Admitted");
        s.api.state.lock().admission = admission;
        s.fails(&["push", "--queue"]);
        let source = s.remote(&[
            "for-each-ref",
            "--format=%(objectname)",
            "refs/heads/gitmatrix/queue/",
        ]);
        s.ok(&["edit", "@-"]);
        fs::remove_file(s.work().join("admitted.txt")).unwrap();
        fs::write(s.work().join("replacement.txt"), "replacement\n").unwrap();
        s.ok(&["commit", "-m", "Replacement"]);
        if matches!(admission, Admission::NoQueueApi) {
            s.ok(&["push"]);
            assert_eq!(s.remote(&["show", "main:replacement.txt"]), "replacement");
            assert!(
                s.remote(&["ls-tree", "--name-only", "main", "admitted.txt"])
                    .is_empty()
            );
        } else {
            let error = s.fails(&["push"]);
            assert!(error["error"]["hint"].as_str().unwrap().contains(&source));
            assert!(!s.work().join("admitted.txt").exists());
        }
    }
}

#[test]
fn terminal_failed_admission_releases_rewritten_source_for_both_push_modes() {
    for queued in [false, true] {
        let s = Sandbox::new();
        s.commit("admitted.txt", "Admitted");
        let admitted = s.submit();
        s.ok(&["edit", "@-"]);
        fs::remove_file(s.work().join("admitted.txt")).unwrap();
        fs::write(s.work().join("replacement.txt"), "replacement\n").unwrap();
        s.ok(&["commit", "-m", "Replacement"]);
        s.api.set(entry(&admitted, "failed"));
        if queued {
            s.submit();
        }
        s.ok(&["push"]);
        assert_eq!(s.remote(&["show", "main:replacement.txt"]), "replacement");
        assert!(
            s.remote(&["ls-tree", "--name-only", "main", "admitted.txt"])
                .is_empty()
        );
    }
}

#[test]
fn sync_preserves_child_edits_that_undo_rewritten_parent_content() {
    for (main_removes_original_child, restore_parent_deletion) in
        [(false, false), (true, false), (false, true), (true, true)]
    {
        let s = Sandbox::new();
        s.commit("parent.txt", "Parent");
        s.commit("child.txt", "Child");
        let child = s.change("Child")["change_id"].as_str().unwrap().to_owned();
        let parent = s.change("Parent")["change_id"].as_str().unwrap().to_owned();
        let admitted = s.submit();
        s.ok(&["edit", &parent]);
        if restore_parent_deletion {
            fs::remove_file(s.work().join("README.md")).unwrap();
        } else {
            fs::write(s.work().join("parent-addition.txt"), "later parent work\n").unwrap();
        }
        s.ok(&["describe", "-m", "Rewritten parent"]);
        s.ok(&["edit", &child]);
        if restore_parent_deletion {
            fs::write(s.work().join("README.md"), "initial\n").unwrap();
        } else {
            fs::remove_file(s.work().join("parent-addition.txt")).unwrap();
        }
        if !main_removes_original_child {
            fs::remove_file(s.work().join("child.txt")).unwrap();
        }
        s.ok(&["describe", "-m", "Child removes parent work"]);
        s.ok(&["new"]);
        let seed = s.root.path().join("seed");
        git(&seed, &["fetch", "-q", "origin"]);
        git(
            &seed,
            &["merge", "--no-ff", "-m", "Land original stack", &admitted],
        );
        if main_removes_original_child {
            git(&seed, &["rm", "child.txt"]);
            git(
                &seed,
                &["commit", "-qm", "Main removes original child addition"],
            );
        }
        git(&seed, &["push", "-q", "origin", "main"]);
        s.ok(&["sync"]);
        assert!(!s.work().join("parent-addition.txt").exists());
        assert!(!s.work().join("child.txt").exists());
        assert_eq!(
            fs::read_to_string(s.work().join("parent.txt")).unwrap(),
            "Parent\n"
        );
        assert_eq!(
            fs::read_to_string(s.work().join("README.md")).unwrap(),
            "initial\n"
        );
        s.ok(&["push"]);
        assert!(
            s.remote(&[
                "ls-tree",
                "--name-only",
                "main",
                "parent-addition.txt",
                "child.txt"
            ])
            .is_empty()
        );
        assert_eq!(s.remote(&["show", "main:parent.txt"]), "Parent");
        assert_eq!(s.remote(&["show", "main:README.md"]), "initial");
    }
}

#[test]
fn ambiguous_landed_parent_evolution_fails_without_replacing_local_content() {
    let s = Sandbox::new();
    s.commit("parent.txt", "Parent");
    fs::write(s.work().join("README.md"), "original child edit\n").unwrap();
    s.ok(&["commit", "-m", "Child"]);
    let child = s.change("Child")["change_id"].as_str().unwrap().to_owned();
    let parent = s.change("Parent")["change_id"].as_str().unwrap().to_owned();
    let admitted = s.submit();
    s.ok(&["edit", &parent]);
    fs::write(s.work().join("README.md"), "rewritten parent edit\n").unwrap();
    s.ok(&["describe", "-m", "Rewritten parent"]);
    s.ok(&["edit", &child]);
    fs::write(s.work().join("README.md"), "explicit local resolution\n").unwrap();
    s.ok(&["describe", "-m", "Resolved child"]);
    s.ok(&["new"]);
    let local = s.change("Resolved child")["commit_id"].clone();
    let seed = s.root.path().join("seed");
    git(&seed, &["fetch", "-q", "origin"]);
    git(
        &seed,
        &["merge", "--no-ff", "-m", "Land original stack", &admitted],
    );
    git(&seed, &["push", "-q", "origin", "main"]);
    let error = s.fails(&["sync"]);
    assert_eq!(error["error"]["code"], "ambiguous_landed_rewrite");
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("README.md")
    );
    assert_eq!(
        fs::read_to_string(s.work().join("README.md")).unwrap(),
        "explicit local resolution\n"
    );
    assert_eq!(s.change("Resolved child")["commit_id"], local);
}

#[test]
fn same_commit_receipts_are_scoped_to_repository_and_server() {
    for same_slug in [false, true] {
        for reject_second in [false, true] {
            let s = Sandbox::new();
            s.commit("admitted.txt", "Admitted");
            let admitted = s.submit();
            let other = tempfile::tempdir().unwrap();
            fs::create_dir(other.path().join("orbit")).unwrap();
            let relative = if same_slug {
                "orbit/engine.git"
            } else {
                "orbit/fork.git"
            };
            let remote = other.path().join(relative);
            git(
                other.path(),
                &[
                    "clone",
                    "-q",
                    "--bare",
                    s.root.path().join("orbit/engine.git").to_str().unwrap(),
                    relative,
                ],
            );
            let api = Api::new(remote.clone());
            if reject_second {
                api.state.lock().admission = Admission::NoQueueApi;
            }
            git(
                &s.work(),
                &["remote", "set-url", "origin", remote.to_str().unwrap()],
            );
            let (code, response) = s.run_with_api(&["push", "--queue"], &api);
            if reject_second {
                assert_ne!(code, 0);
            } else {
                assert_eq!(code, 0, "{response}");
                assert_eq!(response["queue"]["id"], admitted);
            }
            s.ok(&["edit", "@-"]);
            fs::remove_file(s.work().join("admitted.txt")).unwrap();
            fs::write(s.work().join("replacement.txt"), "replacement\n").unwrap();
            s.ok(&["commit", "-m", "Replacement"]);
            if !reject_second {
                for args in [&["push"][..], &["push", "--queue"][..]] {
                    let (code, error) = s.run_with_api(args, &api);
                    assert_ne!(code, 0);
                    assert_eq!(error["error"]["code"], "queued_revision_rewritten");
                }
                api.set(entry(&admitted, "cancelled"));
            }
            let (code, response) = s.run_with_api(&["push"], &api);
            assert_eq!(code, 0, "{response}");
            assert_eq!(
                git(&remote, &["show", "main:replacement.txt"]),
                "replacement"
            );
            // Rejection/cancellation for the second authority must not erase
            // or release the first authority's still-pending receipt.
            git(
                &s.work(),
                &[
                    "remote",
                    "set-url",
                    "origin",
                    s.root.path().join("orbit/engine.git").to_str().unwrap(),
                ],
            );
            s.ok(&["fetch"]);
            assert_eq!(
                s.fails(&["push"])["error"]["code"],
                "queued_revision_rewritten"
            );
        }
    }
}
