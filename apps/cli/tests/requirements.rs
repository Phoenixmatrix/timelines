//! Issue requirements (CORE-32) through the native CLI, against a stand-in for
//! the tracker API: what `--requires`/`--clear-requires` send, what `issue show`
//! says about the acting agent, how `issue next` reports skipped issues, and a
//! refused claim.
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

const GIB: u64 = 1 << 30;

fn snapshot() -> Value {
    json!({
        "owner": {"id": "org-o", "slug": "orbit", "displayName": "Orbit"},
        "canAdmin": false,
        "members": [{"id": "person-a", "slug": "ann", "displayName": "Ann"}],
        "agents": [
            {"id": "agt_b", "name": "builder", "accountable": {"id": "person-a", "slug": "ann", "displayName": "Ann"},
             "capabilities": {"version": 1, "harness": "claude-code", "model": "claude-sonnet-4-5",
                 "environment": {"os": "linux", "arch": "x86_64", "runtime": "host", "cpuCount": 8, "memoryBytes": 8 * GIB},
                 "tags": ["data"], "skills": []},
             "capabilitiesUpdatedAt": "2026-10-01T00:00:00Z", "revokedAt": null},
            {"id": "agt_s", "name": "scout", "accountable": {"id": "person-a", "slug": "ann", "displayName": "Ann"},
             "capabilities": null, "capabilitiesUpdatedAt": null, "revokedAt": null}
        ],
        "teams": [{"id": "team-e", "key": "ENG", "name": "Engineering", "description": "", "memberIds": [], "archived": false, "version": 1}],
        "workspaces": [], "labels": ["data", "frontend", "ux"], "links": [], "comments": [], "requests": [], "subscriptions": [],
        "issues": [
            {"id": "i1", "key": "ENG-1", "teamId": "team-e", "title": "Polish onboarding", "description": "", "acceptance": "",
             "type": "task", "status": "todo", "priority": 2, "assigneeId": null, "parentId": null, "workspaceIds": [],
             "labels": ["ux", "frontend"], "claim": null, "version": 3, "createdAt": "2026-10-01T00:00:00Z", "updatedAt": "2026-10-01T00:00:00Z",
             "requires": {"tags": ["ux"], "minMemory": 16 * GIB}},
            {"id": "i2", "key": "ENG-2", "teamId": "team-e", "title": "Anyone", "description": "", "acceptance": "",
             "type": "task", "status": "todo", "priority": 2, "assigneeId": "agt_b", "parentId": null, "workspaceIds": [],
             "labels": [], "claim": null, "version": 1, "createdAt": "2026-10-01T00:00:00Z", "updatedAt": "2026-10-01T00:00:00Z",
             "requires": {"models": ["claude-opus-*"]}}
        ],
        "cursor": 10,
        "serverTime": "2026-10-04T00:00:00Z"
    })
}

type Requests = Arc<Mutex<Vec<(String, String, Value)>>>;

/// The tracker API for Ann's agent: the session names `agent` (or a person when null).
struct Api {
    address: SocketAddr,
    requests: Requests,
    agent: Arc<Mutex<Value>>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Api {
    fn new() -> Api {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let requests: Requests = Arc::default();
        let agent = Arc::new(Mutex::new(json!({"id": "agt_b", "name": "builder"})));
        let stop = Arc::new(AtomicBool::new(false));
        let (seen, halt, acting) = (Arc::clone(&requests), Arc::clone(&stop), Arc::clone(&agent));
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
                seen.lock()
                    .unwrap()
                    .push((method.clone(), path.clone(), body.clone()));
                let (code, reply) = match (method.as_str(), path.as_str()) {
                    ("GET", "/api/session") => (
                        200,
                        json!({"viewer": {"id": "person-a", "slug": "ann", "agent": acting.lock().unwrap().clone()}}),
                    ),
                    ("GET", "/api/tracker/orbit/snapshot?timelines=1") => (200, snapshot()),
                    ("GET", p) if p.starts_with("/api/tracker/orbit/changes") => (
                        200,
                        json!({"events": [], "cursor": 10, "hasMore": false, "serverTime": "2026-10-04T00:00:00Z"}),
                    ),
                    ("GET", "/api/tracker/orbit/preferences") => {
                        (200, json!({"preferences": null}))
                    }
                    ("POST", "/api/tracker/orbit/mutate") => mutate(&body),
                    ("GET", "/api/tracker/orbit/tags") => (
                        200,
                        json!({"tags": [
                            {"name": "data", "issues": 0, "open": 0},
                            {"name": "frontend", "issues": 1, "open": 1},
                            {"name": "ux", "issues": 1, "open": 1}
                        ]}),
                    ),
                    ("GET", "/api/agents/self") => (200, json!({"agent": agent_record(None)})),
                    ("PUT", "/api/agents/self/capabilities") => {
                        (200, json!({"agent": agent_record(Some(body.clone()))}))
                    }
                    _ => (404, json!({"error": "Not found"})),
                };
                let reply = reply.to_string();
                let _ = write!(
                    stream,
                    "HTTP/1.1 {code} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                    reply.len()
                );
            }
        });
        Api {
            address,
            requests,
            agent,
            stop,
            worker: Some(worker),
        }
    }

    fn mutations(&self) -> Vec<Value> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, p, _)| m == "POST" && p.ends_with("/mutate"))
            .map(|(_, _, body)| body["mutations"][0].clone())
            .collect()
    }
}

/// Ann's agent builder, with the profile it just published when there is one.
fn agent_record(capabilities: Option<Value>) -> Value {
    json!({"id": "agt_b", "name": "builder", "description": null,
           "accountable": {"id": "person-a", "slug": "ann", "displayName": "Ann"},
           "createdAt": "2026-10-01T00:00:00Z", "revokedAt": null, "tokens": [],
           "capabilities": capabilities, "capabilitiesUpdatedAt": null})
}

/// Mutation replies: creates and updates echo the entity, a claim of ENG-1 is
/// refused, `next` claims nothing and reports two skipped issues.
fn mutate(body: &Value) -> (u16, Value) {
    let mutation = &body["mutations"][0];
    let id = mutation["id"].clone();
    match mutation["kind"].as_str().unwrap_or("") {
        "issue.create" | "issue.update" => {
            // An update lands on the issue as the snapshot has it; a create is new.
            let mut entity = snapshot()["issues"]
                .as_array()
                .unwrap()
                .iter()
                .find(|i| i["id"] == id)
                .cloned()
                .unwrap_or_else(|| json!({"id": id, "key": "ENG-9", "version": 0}));
            for (key, value) in mutation["data"].as_object().unwrap() {
                entity[key] = value.clone();
            }
            entity["version"] = json!(entity["version"].as_u64().unwrap_or(0) + 1);
            // Requiring tag:gpu of ENG-1, which builder holds, tightens past it (CORE-272).
            let gpu = mutation["data"]["requires"]["tags"]
                .as_array()
                .is_some_and(|tags| tags.contains(&json!("gpu")));
            let mut result = json!({"id": id});
            if id == "i1" && gpu {
                let released = mutation["data"]["releaseClaim"] == true;
                result["claimEffect"] = json!({"actorId": "agt_b", "agent": "builder", "session": "laptop",
                    "unmet": [{"requirement": "tags", "wanted": "tag:gpu", "reported": "data", "message": "needs tag gpu (it reports tags: data)"}],
                    "released": released});
                entity.as_object_mut().unwrap().remove("releaseClaim");
            }
            (
                200,
                json!({"cursor": 11, "events": [{"cursor": 11, "entityType": "issue", "entityId": id, "entity": entity, "kind": mutation["kind"]}],
                       "results": [result], "serverTime": "2026-10-04T00:00:00Z"}),
            )
        }
        "issue.claim" => (
            409,
            json!({"error": "builder doesn't meet ENG-1's requirements: needs tag ux (it reports tags: data); needs at least 16GiB of memory (it reports 8GiB).",
                   "code": "requirements_unmet",
                   "unmet": [{"requirement": "tags", "wanted": "tag:ux", "reported": "data", "message": "needs tag ux (it reports tags: data)"}]}),
        ),
        "issue.next" => (
            200,
            json!({"cursor": 10, "events": [], "serverTime": "2026-10-04T00:00:00Z",
                   "results": [{"id": id, "skipped": {"requirements": 2, "keys": ["ENG-1", "ENG-2"], "message": "Skipped 2 ready issues whose requirements builder doesn't meet.",
                       "blocking": [{"wanted": "tag:ux", "issues": 1}, {"wanted": "model:claude-opus-*", "issues": 1}]}}]}),
        ),
        _ => (400, json!({"error": "Unexpected mutation"})),
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

struct Env {
    api: Api,
    root: PathBuf,
}

impl Env {
    fn new() -> Env {
        Env {
            api: Api::new(),
            root: tempfile::tempdir().unwrap().keep(),
        }
    }

    fn gm(&self, args: &[&str]) -> (i32, Value) {
        let (code, value, _) = self.gm_with(args, &["--owner", "orbit", "--output", "json"]);
        (code, value)
    }

    /// gm with these trailing flags: its exit code, JSON (or text) output and stderr.
    fn gm_with(&self, args: &[&str], flags: &[&str]) -> (i32, Value, String) {
        let output = Command::new(env!("CARGO_BIN_EXE_gm"))
            .current_dir(&self.root)
            .args(args)
            .args(flags)
            .env("GM_AGENT", "0")
            .env("GM_SERVER", format!("http://{}", self.api.address))
            .env("GM_TOKEN", "test-token")
            .env("HOME", &self.root)
            .env("XDG_CONFIG_HOME", self.root.join("config"))
            .env("XDG_DATA_HOME", self.root.join("data"))
            .output()
            .expect("gm runs");
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let value = serde_json::from_str(&stdout)
            .or_else(|_| serde_json::from_str(&stderr))
            .unwrap_or(Value::String(format!("{stdout}{stderr}")));
        (output.status.code().unwrap_or(-1), value, stderr)
    }
}

#[test]
fn create_and_update_send_normalized_requirements() {
    let env = Env::new();
    let (code, created) = env.gm(&[
        "issue",
        "create",
        "Polish the board",
        "--team",
        "ENG",
        "--requires",
        "Tag:UX tag:gpu,ux model:claude-opus-* memory>=16GiB cpus>=4",
    ]);
    assert_eq!(code, 0, "{created}");
    let sent = &env.api.mutations()[0];
    assert_eq!(sent["kind"], "issue.create");
    assert_eq!(
        sent["data"]["requires"],
        json!({"tags": ["ux", "gpu"], "models": ["claude-opus-*"], "minMemory": 16 * GIB, "minCpus": 4})
    );

    let (code, cleared) = env.gm(&["issue", "update", "ENG-1", "--clear-requires"]);
    assert_eq!(code, 0, "{cleared}");
    let sent = env.api.mutations().pop().unwrap();
    assert_eq!(sent["kind"], "issue.update");
    assert_eq!(sent["id"], "i1");
    assert_eq!(sent["expectedVersion"], 3);
    assert_eq!(sent["data"], json!({"requires": null}));

    let (code, set) = env.gm(&["issue", "update", "ENG-1", "--requires", "os:linux,macos"]);
    assert_eq!(code, 0, "{set}");
    assert_eq!(
        env.api.mutations().pop().unwrap()["data"],
        json!({"requires": {"os": ["linux", "macos"]}})
    );

    // Bad terms never leave the machine, and say what's wrong.
    let before = env.api.mutations().len();
    let (code, bad) = env.gm(&["issue", "update", "ENG-1", "--requires", "gpu memory>=lots"]);
    assert_eq!(code, 2, "{bad}");
    assert!(
        bad["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Unknown requirement \"gpu\""),
        "{bad}"
    );
    assert_eq!(env.api.mutations().len(), before);
}

#[test]
fn show_reports_requirements_and_the_acting_agents_eligibility() {
    let env = Env::new();
    let (code, shown) = env.gm(&["issue", "show", "ENG-1"]);
    assert_eq!(code, 0, "{shown}");
    assert_eq!(shown["issue"]["requiresText"], "tag:ux memory>=16GiB");
    let eligibility = &shown["eligibility"];
    assert_eq!(eligibility["kind"], "agent");
    assert_eq!(eligibility["agent"], "builder");
    assert_eq!(eligibility["eligible"], false);
    let messages: Vec<&str> = eligibility["unmet"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["message"].as_str().unwrap())
        .collect();
    assert_eq!(
        messages,
        [
            "needs tag ux (it reports tags: data)",
            "needs at least 16GiB of memory (it reports 8GiB)",
        ]
    );

    // Assigned to builder: it may claim despite the model, and the mismatch shows.
    let (code, assigned) = env.gm(&["issue", "show", "ENG-2"]);
    assert_eq!(code, 0, "{assigned}");
    assert_eq!(assigned["eligibility"]["eligible"], true);
    assert!(
        assigned["eligibility"]["why"]
            .as_str()
            .unwrap()
            .contains("assigned to it")
    );
    assert_eq!(
        assigned["assigneeMismatch"]["unmet"][0]["message"],
        "needs model claude-opus-* (it reports claude-sonnet-4-5)"
    );

    // An agent that never published capabilities is told to run gm agent setup.
    *env.api.agent.lock().unwrap() = json!({"id": "agt_s", "name": "scout"});
    let (code, scout) = env.gm(&["issue", "show", "ENG-1"]);
    assert_eq!(code, 0, "{scout}");
    assert_eq!(scout["eligibility"]["eligible"], false);
    assert_eq!(
        scout["eligibility"]["unmet"][0]["requirement"],
        "capabilities"
    );
    assert!(
        scout["eligibility"]["why"]
            .as_str()
            .unwrap()
            .contains("gm agent setup")
    );

    // People can always claim.
    *env.api.agent.lock().unwrap() = Value::Null;
    let (code, person) = env.gm(&["issue", "show", "ENG-1"]);
    assert_eq!(code, 0, "{person}");
    assert_eq!(person["eligibility"]["kind"], "person");
    assert_eq!(person["eligibility"]["eligible"], true);
}

#[test]
fn next_reports_skipped_issues_and_a_refused_claim_names_what_is_missing() {
    let env = Env::new();
    let (code, next) = env.gm(&["issue", "next", "--agent", "builder", "--team", "ENG"]);
    assert_eq!(code, 0, "{next}");
    assert!(next["claimed"].is_null(), "{next}");
    assert_eq!(next["skipped"]["requirements"], 2);
    let message = next["message"].as_str().unwrap();
    assert!(message.contains("skipped 2 ready issues"), "{message}");
    assert!(message.contains("ENG-1, ENG-2"), "{message}");
    assert!(message.contains("gm agent setup"), "{message}");
    // CORE-272: which requirements kept the most, and how to change the profile.
    assert!(
        message.contains("Most need tag:ux (1 issue), model:claude-opus-* (1 issue)."),
        "{message}"
    );
    assert!(message.contains("`gm agent setup --tag ux`"), "{message}");

    let (code, refused) = env.gm(&["issue", "claim", "ENG-1", "--agent", "builder"]);
    assert_eq!(code, 4, "{refused}");
    assert_eq!(refused["error"]["code"], "requirements_unmet");
    let message = refused["error"]["message"].as_str().unwrap();
    assert!(message.contains("needs tag ux"), "{message}");
    assert!(message.contains("16GiB"), "{message}");
    assert!(
        refused["error"]["hint"]
            .as_str()
            .unwrap()
            .contains("gm agent setup")
    );
}

/// CORE-271: issue tags are `--tag` (with `--label` kept), `tags` in --data (with
/// `labels` kept), always sent as the stored `labels` field; `issue show` prints them.
#[test]
fn issue_tags_take_new_and_old_spellings() {
    let env = Env::new();
    let (code, text, _) = env.gm_with(
        &["issue", "show", "ENG-1"],
        &["--owner", "orbit", "--output", "text"],
    );
    assert_eq!(code, 0, "{text}");
    assert!(
        text.as_str().unwrap().contains("Tags: ux, frontend\n"),
        "{text}"
    );

    let (code, catalog) = env.gm(&["issue", "tags"]);
    assert_eq!(code, 0, "{catalog}");
    assert_eq!(
        catalog["tags"],
        json!([
            {"name": "data", "issues": 0, "open": 0},
            {"name": "frontend", "issues": 1, "open": 1},
            {"name": "ux", "issues": 1, "open": 1}
        ])
    );
    let (_, text, _) = env.gm_with(
        &["issue", "tags"],
        &["--owner", "orbit", "--output", "text"],
    );
    assert!(
        text.as_str().unwrap().contains("ux        1 issue, 1 open"),
        "{text}"
    );

    for (flag, new) in [("--tag", "api"), ("--label", "web")] {
        let (code, created) = env.gm(&[
            "issue", "create", "Tagged", "--team", "ENG", flag, "ux", flag, new,
        ]);
        assert_eq!(code, 0, "{created}");
        let sent = env.api.mutations().pop().unwrap();
        assert_eq!(sent["data"]["labels"], json!(["ux", new]), "{flag}");
        assert!(sent["data"].get("tags").is_none());
        // A new name joins the catalog, and the result says so.
        assert_eq!(created["tagCatalog"]["added"], json!([new]), "{created}");
    }

    // --tag adds and --drop-tag removes, keeping the issue's other tags.
    let (code, edited) = env.gm(&[
        "issue",
        "update",
        "ENG-1",
        "--tag",
        "data",
        "--drop-tag",
        "FRONTEND",
    ]);
    assert_eq!(code, 0, "{edited}");
    assert_eq!(
        env.api.mutations().pop().unwrap()["data"],
        json!({"labels": ["ux", "data"]})
    );
    // The replica took the server's reply, so the next edit starts from it.
    let (code, _) = env.gm(&["issue", "update", "ENG-1", "--label", "api"]);
    assert_eq!(code, 0);
    assert_eq!(
        env.api.mutations().pop().unwrap()["data"],
        json!({"labels": ["ux", "data", "api"]})
    );

    for data in [
        r#"{"tags":["data"]}"#,
        r#"{"labels":["data"]}"#,
        r#"{"tags":["data"],"labels":["data"]}"#,
    ] {
        let (code, out) = env.gm(&["issue", "update", "ENG-1", "--data", data]);
        assert_eq!(code, 0, "{data}: {out}");
        assert_eq!(
            env.api.mutations().pop().unwrap()["data"],
            json!({"labels": ["data"]})
        );
    }
    let before = env.api.mutations().len();
    let (code, both) = env.gm(&[
        "issue",
        "update",
        "ENG-1",
        "--data",
        r#"{"tags":["a"],"labels":["b"]}"#,
    ]);
    assert_eq!(code, 2, "{both}");
    assert!(
        both["error"]["message"]
            .as_str()
            .unwrap()
            .contains("tags or labels"),
        "{both}"
    );
    let (code, mixed) = env.gm(&[
        "issue",
        "update",
        "ENG-1",
        "--tag",
        "a",
        "--data",
        r#"{"tags":["b"]}"#,
    ]);
    assert_eq!(code, 2, "{mixed}");
    assert_eq!(env.api.mutations().len(), before);
}

/// CORE-271: `tag:` requirements and agent tags come from the tracker's tag catalog;
/// a name it lacks warns with the nearest one and is still sent, never refused.
#[test]
fn unknown_catalog_tags_warn_and_never_fail() {
    let env = Env::new();
    let (code, out, stderr) = env.gm_with(
        &["issue", "update", "ENG-1", "--requires", "tag:uxx tag:data"],
        &["--owner", "orbit", "--output", "json"],
    );
    assert_eq!(code, 0, "{out}");
    assert!(
        stderr.contains(r#"tag "uxx" isn't in orbit's tag catalog (did you mean "ux"?)"#),
        "{stderr}"
    );
    assert!(!stderr.contains(r#"tag "data""#), "{stderr}");
    assert_eq!(
        out["tagCatalog"]["unknownRequired"],
        json!([{"tag": "uxx", "suggestion": "ux"}])
    );
    assert_eq!(
        env.api.mutations().pop().unwrap()["data"]["requires"],
        json!({"tags": ["uxx", "data"]})
    );

    // An agent's tags: the catalog suggests names, and an unknown one is kept with a warning.
    let (code, used, _) = env.gm_with(&["tracker", "use", "orbit"], &["--output", "json"]);
    assert_eq!(code, 0, "{used}");
    let (code, configured, stderr) = env.gm_with(
        &[
            "agent",
            "configure",
            "--tag",
            "frontnd",
            "--tag",
            "ux",
            "--runtime",
            "host",
        ],
        &["--output", "json"],
    );
    assert_eq!(code, 0, "{configured} {stderr}");
    assert!(
        stderr.contains(r#"tag "frontnd" isn't in orbit's tag catalog (did you mean "frontend"?)"#),
        "{stderr}"
    );
    assert_eq!(
        configured["agent"]["capabilities"]["tags"],
        json!(["frontnd", "ux"])
    );
    assert_eq!(
        configured["tagCatalog"]["suggestions"],
        json!(["frontend", "data"])
    );
}

/// CORE-272: tightening requirements on a claimed issue says who's affected and
/// what they miss, keeps the claim unless --release-claim asks to release it, and
/// --require-issue-tags turns the issue's tags into requirements.
#[test]
fn tightening_a_claimed_issue_reports_the_claim_and_can_release_it() {
    let env = Env::new();
    let (code, kept, _) = env.gm_with(
        &["issue", "update", "ENG-1", "--requires", "tag:ux tag:gpu"],
        &["--owner", "orbit", "--output", "json"],
    );
    assert_eq!(code, 0, "{kept}");
    assert_eq!(kept["claimEffect"]["agent"], "builder");
    assert_eq!(kept["claimEffect"]["released"], false);
    assert!(
        env.api.mutations().pop().unwrap()["data"]
            .get("releaseClaim")
            .is_none()
    );
    let (_, text, _) = env.gm_with(
        &["issue", "update", "ENG-1", "--requires", "tag:gpu"],
        &["--owner", "orbit", "--output", "text"],
    );
    let text = text.as_str().unwrap().to_owned();
    assert!(
        text.starts_with("Kept the claim held by builder (session laptop), although the new requirements no longer allow it: it needs tag gpu (it reports tags: data). Rerun with --release-claim"),
        "{text}"
    );

    let (code, released) = env.gm(&[
        "issue",
        "update",
        "ENG-1",
        "--requires",
        "tag:gpu",
        "--release-claim",
    ]);
    assert_eq!(code, 0, "{released}");
    assert_eq!(released["claimEffect"]["released"], true);
    assert_eq!(
        env.api.mutations().pop().unwrap()["data"]["releaseClaim"],
        true
    );

    let before = env.api.mutations().len();
    let (code, alone) = env.gm(&[
        "issue",
        "update",
        "ENG-1",
        "--data",
        r#"{"priority":1}"#,
        "--release-claim",
    ]);
    assert_eq!(code, 2, "{alone}");
    assert!(
        alone["error"]["message"]
            .as_str()
            .unwrap()
            .contains("--release-claim goes with")
    );
    assert_eq!(env.api.mutations().len(), before);
}

#[test]
fn require_issue_tags_adds_the_issues_tags_to_its_requirements() {
    let env = Env::new();
    let (code, out) = env.gm(&["issue", "update", "ENG-2", "--require-issue-tags"]);
    assert_eq!(code, 0, "{out}");
    // ENG-2 has no tags: nothing to add beyond what it requires.
    assert_eq!(
        env.api.mutations().pop().unwrap()["data"],
        json!({"requires": {"models": ["claude-opus-*"]}})
    );
    let (code, out) = env.gm(&["issue", "update", "ENG-1", "--require-issue-tags"]);
    assert_eq!(code, 0, "{out}");
    assert_eq!(
        env.api.mutations().pop().unwrap()["data"],
        json!({"requires": {"tags": ["ux", "frontend"], "minMemory": 16 * GIB}})
    );
}
