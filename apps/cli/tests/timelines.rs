//! `gm timeline` end to end against a local bare remote and a stand-in for
//! the timelines API (CORE-69), which creates and deletes the bookmarks the
//! way the server does.
#![cfg(unix)]

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

type Requests = Arc<Mutex<Vec<(String, String, Value)>>>;

/// The timelines API for one timeline, `search`, in the account `orbit`.
struct Api {
    address: SocketAddr,
    requests: Requests,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

/// A checkpoint view as the API returns it (CORE-76).
fn checkpoint_view(summary: &Value) -> Value {
    json!({
        "checkpoint": {
            "id": "cp_1", "timelineId": "tl_search", "number": 1, "summary": summary,
            "repos": [{"id": "r1", "owner": "orbit", "name": "engine", "commit": "a".repeat(40),
                       "base": "b".repeat(40), "changes": [{"changeId": "kxyz", "commit": "a".repeat(40)}]}],
            "actorId": "agt_bot", "accountableId": "ann", "createdAt": "2026-10-03T00:00:00Z"
        },
        "current": true, "approval": {"requestId": "req", "state": "pending", "by": null, "at": null, "note": null},
        "approved": false,
        "timeline": {"id": "tl_search", "slug": "search", "name": "Search", "policy": "approval"},
        "runs": [{"repoId": "r1", "number": 4, "status": "succeeded", "commit": "a".repeat(40), "createdAt": "2026-10-03T00:00:00Z"}],
        "previews": [{"repoId": "r1", "id": 1, "environment": "timeline/search", "url": "https://preview.example", "status": "active", "commit": "a".repeat(40)}],
        "knowledge": [page_set("cp_1", "succeeded")]
    })
}

/// A timeline's wiki page set as the knowledge API returns it (CORE-84).
fn page_set(key: &str, state: &str) -> Value {
    let checkpoint = if key == "cp_1" {
        json!({"id": "cp_1", "number": 1})
    } else {
        Value::Null
    };
    let pages = if state == "succeeded" {
        json!([
            {"slug": "components/src-web", "title": "Web", "section": "src", "kind": "component",
             "change": "changed", "outcome": "written", "nodeId": "component:src/web",
             "excerpt": "Serves refunds.", "model": "m", "updatedAt": "2026-10-03T00:00:00Z"},
            {"slug": "glossary", "title": "Glossary", "section": "Reference", "kind": "glossary",
             "change": "changed", "outcome": "written", "nodeId": null, "excerpt": "",
             "model": null, "updatedAt": "2026-10-03T00:00:00Z"}
        ])
    } else {
        json!([])
    };
    json!({
        "repoId": "r1", "ref": "timeline/search", "timeline": "search", "key": key,
        "checkpoint": checkpoint, "commit": "a".repeat(40), "baseCommit": "b".repeat(40),
        "state": state, "counts": {"component": {"added": 0, "changed": 1, "removed": 0}},
        "pages": pages, "skipped": 0, "error": null,
        "requestedAt": "2026-10-03T00:00:00Z", "finishedAt": null
    })
}

fn record(status: &str) -> Value {
    json!({
        "id": "tl_search", "slug": "search", "name": "Search", "policy": "approval",
        "experimental": false, "parentId": null, "status": status,
        "repos": [{"id": "r1", "owner": "orbit", "name": "engine", "bookmark": "timeline/search"}],
    })
}

impl Api {
    fn new(remote: PathBuf) -> Api {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let requests: Requests = Arc::default();
        let stop = Arc::new(AtomicBool::new(false));
        let (seen, halt) = (Arc::clone(&requests), Arc::clone(&stop));
        let worker = thread::spawn(move || {
            let mut status = "none";
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
                let bookmark = "refs/heads/timeline/search";
                let (code, reply) = match (method.as_str(), path.as_str()) {
                    ("POST", "/api/tracker/orbit/timelines") => {
                        git(&remote, &["update-ref", bookmark, "refs/heads/main"]);
                        status = "active";
                        (
                            201,
                            json!({"timeline": record(status), "bookmarks": [{"repoId": "r1", "ref": bookmark, "ok": true}]}),
                        )
                    }
                    ("GET", "/api/tracker/orbit/timelines") => {
                        (200, json!({"timelines": [record(status)]}))
                    }
                    ("GET", p) if p.starts_with("/api/tracker/orbit/timelines/search?") => (
                        200,
                        json!({"timeline": record(status), "events": [
                            {"id": "e1", "seq": 1, "kind": "fork", "timelineId": "tl_search", "parentId": null, "createdAt": "2026-10-02T00:00:00Z"}
                        ], "next": null}),
                    ),
                    ("POST", "/api/tracker/orbit/timelines/search/checkpoints") => {
                        (201, checkpoint_view(&body["summary"]))
                    }
                    ("GET", "/api/tracker/orbit/timelines/search/checkpoints") => (
                        200,
                        json!({"checkpoints": [checkpoint_view(&json!("Ranking v2"))]}),
                    ),
                    ("GET", "/api/tracker/orbit/timelines/search/checkpoints/1") => {
                        (200, checkpoint_view(&json!("Ranking v2")))
                    }
                    (
                        "GET",
                        "/api/repos/orbit/engine/knowledge/overlay/pages?ref=timeline%2Fsearch",
                    ) => (
                        200,
                        json!({"ref": "timeline/search", "timeline": "search", "ended": false,
                               "sets": [page_set("cp_1", "succeeded")]}),
                    ),
                    (
                        "POST",
                        "/api/repos/orbit/engine/knowledge/overlay/pages?ref=timeline%2Fsearch",
                    ) => (202, page_set(&format!("commit:{}", "a".repeat(40)), "queued")),
                    ("GET", p)
                        if p.starts_with(
                            "/api/repos/orbit/engine/knowledge/overlay/page?ref=timeline%2Fsearch&slug=components%2Fsrc-web",
                        ) =>
                    {
                        (
                            200,
                            json!({"slug": "components/src-web", "title": "Web", "body": "Serves refunds.",
                                   "generatedIn": "a".repeat(40), "outcome": "written", "timeline": "search",
                                   "set": {"key": "cp_1"}}),
                        )
                    }
                    ("POST", "/api/tracker/orbit/timelines/search/abandon") => {
                        git(&remote, &["update-ref", "-d", bookmark]);
                        status = "abandoned";
                        (
                            200,
                            json!({"timeline": record(status), "bookmarks": [{"repoId": "r1", "ref": bookmark, "ok": true}]}),
                        )
                    }
                    _ => (
                        404,
                        json!({"error": "No timeline here.", "code": "not_found"}),
                    ),
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
            requests,
            stop,
            worker: Some(worker),
        }
    }

    fn requests(&self, method: &str) -> Vec<(String, Value)> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _, _)| m == method)
            .map(|(_, p, b)| (p.clone(), b.clone()))
            .collect()
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
        let api = Api::new(root.join("remote.git"));
        let sandbox = Sandbox {
            _dir: dir,
            root,
            api,
        };
        sandbox.ok(&["init"]);
        sandbox
    }

    fn work(&self) -> PathBuf {
        self.root.join("work")
    }

    fn remote(&self, args: &[&str]) -> String {
        git(&self.root.join("remote.git"), args)
    }

    fn run_with(&self, args: &[&str], env: &[(&str, &str)]) -> (i32, Value, String) {
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

    fn ok(&self, args: &[&str]) -> Value {
        let (code, value, stderr) = self.run_with(args, &[]);
        assert_eq!(code, 0, "gm {args:?} failed: {stderr}");
        value
    }

    fn err(&self, args: &[&str]) -> String {
        let (code, value, _) = self.run_with(args, &[]);
        assert_ne!(code, 0, "gm {args:?} should fail: {value}");
        value["error"]["code"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    }

    fn binding(&self) -> String {
        fs::read_to_string(self.work().join(".gitmatrix/agent.local.yml")).unwrap_or_default()
    }

    fn commit(&self, file: &str, message: &str) {
        fs::write(self.work().join(file), format!("{message}\n")).unwrap();
        self.ok(&["commit", "-m", message]);
    }

    /// A teammate pushes a commit to `branch` with plain git.
    fn teammate(&self, branch: &str, file: &str) -> String {
        let seed = self.root.join("seed");
        git(&seed, &["fetch", "-q", "origin"]);
        git(
            &seed,
            &["checkout", "-q", "-B", branch, &format!("origin/{branch}")],
        );
        fs::write(seed.join(file), "teammate\n").unwrap();
        git(&seed, &["add", "."]);
        git(&seed, &["commit", "-qm", &format!("Teammate on {branch}")]);
        git(&seed, &["push", "-q", "origin", branch]);
        git(&seed, &["rev-parse", "HEAD"])
    }
}

#[test]
fn a_checkout_in_a_timeline_pushes_to_its_bookmark_and_never_to_main() {
    let s = Sandbox::new();
    let main = s.remote(&["rev-parse", "main"]);

    // --dry-run sends nothing and binds nothing.
    let dry = s.ok(&[
        "timeline",
        "start",
        "search",
        "-O",
        "orbit",
        "--repo",
        "orbit/engine",
        "--dry-run",
    ]);
    assert_eq!(dry["dry_run"], true);
    assert_eq!(dry["request"]["slug"], "search");
    assert!(s.api.requests("POST").is_empty());
    assert!(s.binding().is_empty());

    let started = s.ok(&[
        "timeline",
        "start",
        "search",
        "-O",
        "orbit",
        "--repo",
        "orbit/engine",
        "--policy",
        "approval",
    ]);
    let posted = s.api.requests("POST");
    assert_eq!(posted[0].0, "/api/tracker/orbit/timelines");
    assert_eq!(
        posted[0].1,
        json!({"slug": "search", "policy": "approval", "repos": ["orbit/engine"]})
    );
    assert_eq!(started["timeline"]["slug"], "search");
    assert_eq!(started["use"]["timeline"], "search");
    assert!(s.binding().contains("timeline: search"), "{}", s.binding());

    // Work goes to timeline/search; main doesn't move.
    s.commit("feature.txt", "Timeline work");
    let pushed = s.ok(&["push"]);
    assert_eq!(pushed["bookmark"], "timeline/search");
    let tip = s.remote(&["rev-parse", "timeline/search"]);
    assert_ne!(tip, main);
    let files = s.remote(&["ls-tree", "-r", "--name-only", "timeline/search"]);
    assert!(
        !files.contains(".gitmatrix"),
        "the binding is never pushed: {files}"
    );
    assert_eq!(s.remote(&["rev-parse", "main"]), main);
    // Pushed work is the timeline's now: immutable here.
    assert_eq!(
        s.err(&["describe", "@-", "-m", "Rewritten"]),
        "immutable_change"
    );

    // Main is refused while bound.
    assert_eq!(s.err(&["push", "-b", "main"]), "timeline_bound");
    assert_eq!(s.remote(&["rev-parse", "main"]), main);

    // Main moves; the timeline takes it only through an explicit merge.
    let teammate = s.teammate("main", "main.txt");
    s.ok(&["sync"]);
    assert!(
        !s.work().join("main.txt").exists(),
        "sync must not bring main in"
    );
    assert_eq!(s.err(&["timeline", "merge", "search"]), "invalid_argument");
    let dry = s.ok(&["timeline", "merge", "main", "--dry-run"]);
    assert_eq!(dry["dry_run"], true);
    let merged = s.ok(&["timeline", "merge", "main"]);
    assert_eq!(merged["merged"], "main");
    assert_eq!(
        merged["changes"][0]["description"],
        "Merge main into timeline/search"
    );
    assert!(s.work().join("main.txt").exists());
    // Main's new commit is immutable, not unpushed work.
    let log = s.ok(&["log"]);
    for change in log["changes"].as_array().unwrap() {
        if change["description"]
            .as_str()
            .unwrap()
            .starts_with("Teammate")
        {
            assert_eq!(change["immutable"], true);
        }
    }
    let pushed = s.ok(&["push"]);
    assert_eq!(pushed["pushed"].as_array().unwrap().len(), 1, "{pushed}");
    let tip = s.remote(&["rev-parse", "timeline/search"]);
    assert_eq!(
        s.remote(&["rev-parse", &format!("{tip}^2")]),
        teammate,
        "the merge's second parent is main"
    );
    assert_eq!(s.remote(&["rev-parse", "main"]), teammate);

    // Someone else pushes to the timeline: sync follows it.
    s.commit("more.txt", "More work");
    let theirs = s.teammate("timeline/search", "theirs.txt");
    let synced = s.ok(&["sync"]);
    assert_eq!(synced["changes"].as_array().unwrap().len(), 1, "{synced}");
    assert!(s.work().join("theirs.txt").exists());
    let pushed = s.ok(&["push"]);
    assert_eq!(pushed["bookmark"], "timeline/search");
    assert_eq!(
        s.remote(&["rev-parse", "timeline/search^"]),
        theirs,
        "pushed on top of theirs"
    );

    // Listing and showing know which timeline this checkout is in.
    let list = s.ok(&["timeline", "list", "-O", "orbit"]);
    assert_eq!(list["current"], "search");
    let text = s.ok(&["timeline", "list", "-O", "orbit", "-o", "text"]);
    assert!(text.as_str().unwrap().starts_with("* search"), "{text}");
    let shown = s.ok(&["timeline", "show", "-O", "orbit"]);
    assert_eq!(shown["current"], true);
    assert_eq!(shown["events"][0]["kind"], "fork");

    // New worktrees inherit the binding.
    s.ok(&["worktree", "add", "../wt"]);
    let wt = s.root.join("wt").to_string_lossy().into_owned();
    let status = s.ok(&["-C", &wt, "status"]);
    assert_eq!(
        status["trunk"]["name"], "origin/timeline/search",
        "{status}"
    );
    s.ok(&["worktree", "remove", "../wt", "--force"]);

    // Back to main: unbound, and @ starts on main.
    let dry = s.ok(&["timeline", "use", "main", "--dry-run"]);
    assert_eq!(dry["dry_run"], true);
    assert!(s.binding().contains("timeline: search"));
    let used = s.ok(&["timeline", "use", "main"]);
    assert_eq!(used["timeline"], Value::Null);
    assert_eq!(used["previous"], "search");
    assert!(!s.binding().contains("timeline"));
    assert!(!s.work().join("feature.txt").exists());
    // What was pushed to the timeline stays there, not as local work here.
    let log = s.ok(&["log"]);
    for change in log["changes"].as_array().unwrap() {
        assert!(
            change["immutable"] == true || change["working_copy"] == true,
            "left behind as local work: {change}"
        );
    }
    let nothing = s.ok(&["push"]);
    assert_eq!(nothing["bookmark"], "main");
    assert_eq!(s.remote(&["rev-parse", "main"]), teammate);

    // GM_TIMELINE works in a timeline for one command.
    let (code, value, _) = s.run_with(&["push", "-b", "main"], &[("GM_TIMELINE", "search")]);
    assert_eq!(code, 4, "{value}");
    assert_eq!(value["error"]["code"], "timeline_bound");

    // Back in, then abandon: the checkout returns to main.
    s.ok(&["timeline", "use", "search", "-O", "orbit"]);
    assert!(s.work().join("feature.txt").exists());
    let dry = s.ok(&["timeline", "abandon", "-O", "orbit", "--dry-run"]);
    assert_eq!(dry["unbind"], true);
    assert_eq!(s.api.requests("POST").len(), 1);
    let abandoned = s.ok(&["timeline", "abandon", "-O", "orbit"]);
    assert_eq!(abandoned["timeline"]["status"], "abandoned");
    assert_eq!(
        s.api.requests("POST")[1].0,
        "/api/tracker/orbit/timelines/search/abandon"
    );
    assert_eq!(abandoned["use"]["previous"], "search");
    assert!(!s.binding().contains("timeline"));
    assert_eq!(
        s.err(&["timeline", "use", "search", "-O", "orbit"]),
        "timeline_ended"
    );
}

#[test]
fn a_bound_checkout_without_its_bookmark_refuses_to_push_or_sync() {
    let s = Sandbox::new();
    fs::create_dir_all(s.work().join(".gitmatrix")).unwrap();
    fs::write(
        s.work().join(".gitmatrix/agent.local.yml"),
        "timeline: gone\n",
    )
    .unwrap();
    s.commit("work.txt", "Work");
    let main = s.remote(&["rev-parse", "main"]);
    assert_eq!(s.err(&["push"]), "timeline_missing");
    assert_eq!(s.err(&["sync"]), "timeline_missing");
    assert_eq!(s.err(&["timeline", "merge", "main"]), "timeline_missing");
    assert_eq!(s.remote(&["rev-parse", "main"]), main);
}

#[test]
fn checkpoints_pin_the_pushed_commits_with_a_summary() {
    let s = Sandbox::new();
    s.ok(&[
        "timeline",
        "start",
        "search",
        "-O",
        "orbit",
        "--repo",
        "orbit/engine",
    ]);
    // The bound timeline is the default; paragraphs join with a blank line.
    let made = s.ok(&[
        "timeline",
        "checkpoint",
        "-O",
        "orbit",
        "-m",
        "Ranking v2",
        "-m",
        "Ready for review.",
    ]);
    let posted = s.api.requests("POST");
    let (path, body) = posted.last().unwrap();
    assert_eq!(path, "/api/tracker/orbit/timelines/search/checkpoints");
    assert_eq!(body, &json!({"summary": "Ranking v2\n\nReady for review."}));
    assert_eq!(made["checkpoint"]["id"], "cp_1");
    assert!(
        made["next"]
            .as_str()
            .unwrap()
            .contains("--kind approval --checkpoint cp_1"),
        "{made}"
    );

    let listed = s.ok(&["timeline", "checkpoints", "-O", "orbit"]);
    assert_eq!(listed["timeline"], "search");
    assert_eq!(listed["checkpoints"][0]["runs"][0]["number"], 4);

    // People read the same as text: commits, CI, preview, approval state.
    let (code, value, _) = s.run_with(
        &["timeline", "checkpoints", "-O", "orbit", "-o", "text"],
        &[],
    );
    assert_eq!(code, 0);
    let text = value.as_str().unwrap_or_default().to_string();
    assert!(text.contains("Checkpoint #1 of search"), "{text}");
    assert!(text.contains("[awaiting approval]"), "{text}");
    assert!(text.contains("CI #4 succeeded"), "{text}");
    assert!(text.contains("https://preview.example (active)"), "{text}");
    assert!(
        text.contains("wiki pages: succeeded: components/src-web, glossary"),
        "{text}"
    );
}

#[test]
fn pages_lists_writes_and_shows_a_timelines_wiki_pages() {
    let s = Sandbox::new();
    s.ok(&[
        "timeline",
        "start",
        "search",
        "-O",
        "orbit",
        "--repo",
        "orbit/engine",
    ]);
    // Every repository of the bound timeline, newest set first.
    let listed = s.ok(&["timeline", "pages", "-O", "orbit"]);
    assert_eq!(listed["timeline"], "search");
    assert_eq!(listed["repos"][0]["repo"], "orbit/engine");
    assert_eq!(
        listed["repos"][0]["sets"][0]["pages"][0]["slug"],
        "components/src-web"
    );
    let (code, value, _) = s.run_with(&["timeline", "pages", "-O", "orbit", "-o", "text"], &[]);
    assert_eq!(code, 0);
    let text = value.as_str().unwrap_or_default().to_string();
    assert!(
        text.contains("orbit/engine · checkpoint #1 · succeeded"),
        "{text}"
    );
    assert!(text.contains("Serves refunds."), "{text}");

    // One checkpoint's pages come with the checkpoint.
    let one = s.ok(&["timeline", "pages", "-O", "orbit", "--checkpoint", "1"]);
    assert_eq!(one["checkpoint"], "cp_1");
    assert_eq!(one["repos"][0]["sets"][0]["key"], "cp_1");

    // A page in full, from the newest set that has it.
    let page = s.ok(&[
        "timeline",
        "pages",
        "-O",
        "orbit",
        "--page",
        "components/src-web",
    ]);
    assert_eq!(page["body"], "Serves refunds.");
    assert_eq!(page["repo"], "orbit/engine");

    // Writing now: a dry run asks nothing; the real one queues a set per repository.
    let before = s.api.requests("POST").len();
    let dry = s.ok(&["timeline", "pages", "-O", "orbit", "--write", "--dry-run"]);
    assert_eq!(dry["dry_run"], true);
    assert_eq!(s.api.requests("POST").len(), before);
    let wrote = s.ok(&["timeline", "pages", "-O", "orbit", "--write"]);
    assert_eq!(wrote["repos"][0]["sets"][0]["state"], "queued");
    let (path, _) = s.api.requests("POST").pop().unwrap();
    assert_eq!(
        path,
        "/api/repos/orbit/engine/knowledge/overlay/pages?ref=timeline%2Fsearch"
    );
}

/// The change `@` sits on (`@-`), and whether `@` is an empty change on it.
fn parent_of_working_copy(s: &Sandbox) -> (String, bool) {
    let log = s.ok(&["log"]);
    let changes = log["changes"].as_array().unwrap();
    let wc = changes
        .iter()
        .find(|c| c["working_copy"] == true)
        .expect("a working copy");
    let parent = wc["parents"][0].as_str().unwrap().to_string();
    let description = changes
        .iter()
        .find(|c| c["change_id"] == parent.as_str())
        .map(|c| c["description"].as_str().unwrap().trim().to_string())
        .unwrap_or_default();
    (description, wc["empty"] == true)
}

/// CORE-224: a change built on an older main than the timeline's fork point
/// is this checkout's work, so starting the timeline keeps `@` on it and a
/// push sends it to the timeline, rebased onto the bookmark first.
#[test]
fn work_on_an_older_main_goes_to_a_newly_started_timeline() {
    let s = Sandbox::new();
    s.commit("stale.txt", "Stale-base work");
    // Main moves on before the timeline forks from it.
    let teammate = s.teammate("main", "main.txt");
    let started = s.ok(&[
        "timeline",
        "start",
        "search",
        "-O",
        "orbit",
        "--repo",
        "orbit/engine",
    ]);
    assert_eq!(s.remote(&["rev-parse", "timeline/search"]), teammate);
    let said = started["use"]["message"].as_str().unwrap_or_default();
    assert!(said.contains("stays on your change"), "{started}");
    assert!(said.contains("gm push --sync"), "{started}");
    // @ is still the empty change on the work, not a fresh one on the bookmark.
    assert_eq!(
        parent_of_working_copy(&s),
        ("Stale-base work".to_string(), true)
    );

    // Like a push to main that moved: refused, with --sync as the way on.
    assert_eq!(s.err(&["push"]), "remote_moved");
    assert_eq!(s.remote(&["rev-parse", "timeline/search"]), teammate);

    // --sync rebases the stack onto the bookmark, @ along with it, and pushes.
    let pushed = s.ok(&["push", "--sync"]);
    assert_eq!(pushed["bookmark"], "timeline/search");
    let sent = pushed["pushed"].as_array().unwrap();
    assert_eq!(sent.len(), 1, "{pushed}");
    assert_eq!(
        sent[0]["description"].as_str().unwrap().trim(),
        "Stale-base work"
    );
    assert_eq!(
        s.remote(&["rev-parse", "timeline/search^"]),
        teammate,
        "pushed on top of the bookmark"
    );
    assert_eq!(
        s.remote(&["log", "-1", "--format=%s", "timeline/search"]),
        "Stale-base work"
    );
    assert_eq!(
        parent_of_working_copy(&s),
        ("Stale-base work".to_string(), true),
        "@ stays on top of the pushed stack"
    );
    assert!(s.work().join("stale.txt").exists());
    assert!(s.work().join("main.txt").exists());
    assert_eq!(s.remote(&["rev-parse", "main"]), teammate);

    // Now it really is there.
    let again = s.ok(&["push"]);
    assert!(again["pushed"].as_array().unwrap().is_empty(), "{again}");
    assert!(
        again["message"]
            .as_str()
            .unwrap()
            .contains("Nothing to push: timeline/search already has everything."),
        "{again}"
    );
}

/// CORE-224: `gm push --sync` keeps `@` on top of the rebased stack when the
/// checkout was already bound and the bookmark then moved.
#[test]
fn push_sync_in_a_timeline_keeps_the_working_copy_on_the_stack() {
    let s = Sandbox::new();
    s.ok(&[
        "timeline",
        "start",
        "search",
        "-O",
        "orbit",
        "--repo",
        "orbit/engine",
    ]);
    s.commit("one.txt", "First");
    s.commit("two.txt", "Second");
    fs::write(s.work().join("draft.txt"), "draft\n").unwrap();
    let theirs = s.teammate("timeline/search", "theirs.txt");
    assert_eq!(s.err(&["push", "-r", "@-"]), "remote_moved");

    let pushed = s.ok(&["push", "--sync", "-r", "@-"]);
    assert_eq!(pushed["pushed"].as_array().unwrap().len(), 2, "{pushed}");
    assert_eq!(s.remote(&["rev-parse", "timeline/search~2"]), theirs);
    // @ still holds the draft, on top of what was pushed.
    let (parent, empty) = parent_of_working_copy(&s);
    assert_eq!(parent, "Second");
    assert!(!empty);
    assert_eq!(
        fs::read_to_string(s.work().join("draft.txt")).unwrap(),
        "draft\n"
    );
    assert!(s.work().join("theirs.txt").exists());
}

/// Outside timelines nothing changes: a stale trunk is refused, and --sync
/// rebases and pushes to main with `@` on top.
#[test]
fn trunk_pushes_on_an_older_main_are_unchanged() {
    let s = Sandbox::new();
    s.commit("stale.txt", "Stale-base work");
    let teammate = s.teammate("main", "main.txt");
    s.ok(&["fetch"]);
    assert_eq!(s.err(&["push"]), "remote_moved");
    let pushed = s.ok(&["push", "--sync"]);
    assert_eq!(pushed["bookmark"], "main");
    assert_eq!(pushed["pushed"].as_array().unwrap().len(), 1, "{pushed}");
    assert_eq!(s.remote(&["rev-parse", "main^"]), teammate);
    assert_eq!(
        parent_of_working_copy(&s),
        ("Stale-base work".to_string(), true)
    );
    let again = s.ok(&["push"]);
    assert!(
        again["message"]
            .as_str()
            .unwrap()
            .contains("Nothing to push: main already has everything."),
        "{again}"
    );
}

/// Work that origin already has on another bookmark isn't this checkout's to
/// bring along: starting a timeline still begins a fresh `@` on its bookmark.
#[test]
fn work_on_another_remote_bookmark_stays_behind_when_a_timeline_starts() {
    let s = Sandbox::new();
    let seed = s.root.join("seed");
    git(&seed, &["checkout", "-q", "-b", "other"]);
    fs::write(seed.join("other.txt"), "other\n").unwrap();
    git(&seed, &["add", "."]);
    git(&seed, &["commit", "-qm", "Other line"]);
    git(&seed, &["push", "-q", "origin", "other"]);
    git(&seed, &["checkout", "-q", "main"]);
    s.ok(&["fetch"]);
    s.ok(&["new", "origin/other"]);
    s.commit("mine.txt", "Built on other");
    let teammate = s.teammate("main", "main.txt");
    s.ok(&[
        "timeline",
        "start",
        "search",
        "-O",
        "orbit",
        "--repo",
        "orbit/engine",
    ]);
    assert_eq!(
        parent_of_working_copy(&s),
        ("Teammate on main".to_string(), true)
    );
    assert_eq!(s.remote(&["rev-parse", "timeline/search"]), teammate);
    assert!(!s.work().join("other.txt").exists());
}
