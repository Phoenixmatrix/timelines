//! `gm why <path:line>`: why did these lines change (CORE-85)?
//!
//! Blame runs here, in the checkout: it sees the working copy and local
//! rewrites the server has never seen, and reads each commit's `change-id`
//! header. The server's `GET /api/repos/:owner/:name/why?commit=<oid>:<change>`
//! resolves the rest of the chain from the change id (the timelines it came
//! through, its issues, checkpoints, approval and landing), so a locally
//! rebased commit still finds the history its change has on the server.
//! The output is the server's `WhyResponse` with the local blame in `blame`.

use super::Ctx;
use super::semantic::encode_into;
use super::server::current_repo;
use crate::cli::WhyArgs;
use crate::output::{GmError, Render, Result};
use crate::remote::{self, Config};
use crate::repo::{Workspace, ids, revset};
use git2::{BlameOptions, Oid, Repository};
use serde::{Serialize, Serializer};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::fmt::Write;
use std::path::Path;

/// Lines one call may ask about, as the server allows.
const MAX_LINES: u32 = 200;
/// Commits per server request, as the server allows.
const COMMITS_PER_REQUEST: usize = 20;

#[derive(Debug, PartialEq, Eq)]
pub struct Target {
    pub path: String,
    pub start: u32,
    pub end: u32,
}

/// `12` or `12-20` (either order).
fn parse_range(text: &str) -> Option<(u32, u32)> {
    let (a, b) = match text.split_once('-') {
        Some((a, b)) => (a.parse::<u32>().ok()?, b.parse::<u32>().ok()?),
        None => {
            let n = text.parse::<u32>().ok()?;
            (n, n)
        }
    };
    (a >= 1 && b >= 1).then(|| (a.min(b), a.max(b)))
}

/// `path:12`, `path:12-20`, or `path` with `--line`.
pub fn parse_target(spec: &str, line: Option<&str>) -> Result<Target> {
    let (path, range) = match (spec.rsplit_once(':'), line) {
        (_, Some(line)) => (spec, Some(line)),
        (Some((path, suffix)), None) if parse_range(suffix).is_some() => (path, Some(suffix)),
        _ => (spec, None),
    };
    let range = range
        .ok_or_else(|| GmError::usage("Name a line: `gm why src/app.ts:12`, or `--line 12-20`."))?;
    let (start, end) = parse_range(range).ok_or_else(|| {
        GmError::usage(format!(
            "`{range}` isn't a line or a range like 12-20 (lines count from 1)."
        ))
    })?;
    if end - start + 1 > MAX_LINES {
        return Err(GmError::usage(format!(
            "Ask about at most {MAX_LINES} lines at once."
        )));
    }
    let path = path.trim_start_matches("./").trim_end_matches('/');
    if path.is_empty() {
        return Err(GmError::usage("Name a file: `gm why src/app.ts:12`."));
    }
    Ok(Target {
        path: path.to_string(),
        start,
        end,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlamedLine {
    pub line: u32,
    pub commit: String,
    pub original_line: u32,
}

#[derive(Debug, Clone)]
pub struct LocalCommit {
    pub oid: String,
    /// The `change-id` header, when the commit has one (not a derived id).
    pub change_id: Option<String>,
    pub summary: Value,
}

#[derive(Debug)]
pub struct LocalBlame {
    pub end: u32,
    pub lines: Vec<BlamedLine>,
    /// In the order of the first line each explains.
    pub commits: Vec<LocalCommit>,
}

/// A path as given, relative to the repository root even when gm runs in a subdirectory.
fn repo_path(root: &Path, cwd: &Path, path: &str) -> String {
    if let (Ok(abs), Ok(root)) = (cwd.join(path).canonicalize(), root.canonicalize())
        && let Ok(relative) = abs.strip_prefix(&root)
    {
        return relative.to_string_lossy().replace('\\', "/");
    }
    path.to_string()
}

/// Blame lines `start`–`end` of `path` at `head`, the way `git blame` does.
pub fn blame(repo: &Repository, head: Oid, path: &str, start: u32, end: u32) -> Result<LocalBlame> {
    let tree = repo.find_commit(head)?.tree()?;
    let missing = || GmError::not_found("file_not_found", format!("No file `{path}` there."));
    let entry = tree.get_path(Path::new(path)).map_err(|_| missing())?;
    let blob = repo.find_blob(entry.id()).map_err(|_| missing())?;
    let content = blob.content();
    let content = content.strip_suffix(b"\n").unwrap_or(content);
    let count = content.split(|b| *b == b'\n').count() as u32;
    if start > count {
        return Err(GmError::usage(format!("`{path}` has {count} lines.")));
    }
    let end = end.min(count);
    let mut options = BlameOptions::new();
    options
        .newest_commit(head)
        .min_line(start as usize)
        .max_line(end as usize);
    let blamed = repo.blame_file(Path::new(path), Some(&mut options))?;
    let mut lines = Vec::new();
    let mut commits: Vec<LocalCommit> = Vec::new();
    for hunk in blamed.iter() {
        let oid = hunk.final_commit_id();
        let first = hunk.final_start_line() as u32;
        let original = hunk.orig_start_line() as u32;
        for offset in 0..hunk.lines_in_hunk() as u32 {
            let line = first + offset;
            if line < start || line > end {
                continue;
            }
            lines.push(BlamedLine {
                line,
                commit: oid.to_string(),
                original_line: original + offset,
            });
        }
        if !commits.iter().any(|c| c.oid == oid.to_string()) {
            let commit = repo.find_commit(oid)?;
            let change_id = commit
                .header_field_bytes("change-id")
                .ok()
                .and_then(|b| b.as_str().ok().map(str::to_string))
                .filter(|id| ids::is_change_id_prefix(id));
            let author = commit.author();
            commits.push(LocalCommit {
                oid: oid.to_string(),
                change_id,
                summary: json!({
                    "oid": oid.to_string(),
                    "message": Workspace::description(&commit).trim_end_matches('\n'),
                    "authorName": author.name().unwrap_or(""),
                    "authorEmail": author.email().unwrap_or(""),
                    "authoredAt": author.when().seconds(),
                    "parents": commit.parent_ids().map(|p| p.to_string()).collect::<Vec<_>>(),
                }),
            });
        }
    }
    lines.sort_by_key(|l| l.line);
    // Order commits by the first line each explains.
    commits.sort_by_key(|c| {
        lines
            .iter()
            .find(|l| l.commit == c.oid)
            .map(|l| l.line)
            .unwrap_or(u32::MAX)
    });
    Ok(LocalBlame {
        end,
        lines,
        commits,
    })
}

fn repo_api_base(repo: &str) -> Result<String> {
    let (owner, name) = repo
        .split_once('/')
        .filter(|(o, n)| {
            [o, n]
                .iter()
                .all(|p| !p.is_empty() && !matches!(**p, "." | "..") && !p.contains('/'))
        })
        .ok_or_else(|| GmError::usage("Name the repository with --repo owner/name."))?;
    let mut path = String::from("/repos/");
    encode_into(&mut path, owner);
    path.push('/');
    encode_into(&mut path, name);
    Ok(path)
}

/// The server request resolving these commits' chains.
pub fn request_path(repo: &str, path: &str, commits: &[LocalCommit]) -> Result<String> {
    let mut url = repo_api_base(repo)?;
    url.push_str("/why?path=");
    encode_into(&mut url, path);
    for commit in commits {
        url.push_str("&commit=");
        url.push_str(&commit.oid);
        if let Some(change) = &commit.change_id {
            url.push_str("%3A");
            encode_into(&mut url, change);
        }
    }
    Ok(url)
}

/// The output: the server's chains, with the local blame, each chain's lines,
/// and the commit details for commits only this checkout has.
pub fn assemble(
    target: &Target,
    rev: &str,
    head: Oid,
    local: &LocalBlame,
    responses: Vec<Value>,
) -> Value {
    let mut repo = Value::Null;
    let mut tracker = Value::Null;
    let mut people = Map::new();
    let mut chains = Vec::new();
    for response in responses {
        if repo.is_null() {
            repo = response["repo"].clone();
            tracker = response["tracker"].clone();
        }
        if let Some(found) = response["people"].as_object() {
            people.extend(found.clone());
        }
        chains.extend(response["chains"].as_array().cloned().unwrap_or_default());
    }
    for chain in &mut chains {
        let oid = chain["oid"].as_str().unwrap_or("").to_string();
        let lines: Vec<u32> = local
            .lines
            .iter()
            .filter(|l| l.commit == oid)
            .map(|l| l.line)
            .collect();
        chain["lines"] = json!(lines);
        chain["onServer"] = json!(!chain["commit"].is_null());
        if chain["commit"].is_null()
            && let Some(commit) = local.commits.iter().find(|c| c.oid == oid)
        {
            chain["commit"] = commit.summary.clone();
        }
    }
    json!({
        "repo": repo,
        "tracker": tracker,
        "blame": {
            "source": "local",
            "path": target.path,
            "rev": rev,
            "head": head.to_string(),
            "start": target.start,
            "end": local.end,
            "lines": local.lines,
            "truncated": false,
        },
        "chains": chains,
        "people": people,
    })
}

pub struct Why {
    value: Value,
}

impl Serialize for Why {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        self.value.serialize(serializer)
    }
}

impl Render for Why {
    fn text(&self) -> String {
        why_text(&self.value)
    }
}

fn s<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}

fn short(oid: &str) -> &str {
    &oid[..oid.len().min(8)]
}

fn day(at: &str) -> &str {
    &at[..at.len().min(10)]
}

fn ref_name(r: &str) -> &str {
    r.strip_prefix("refs/heads/")
        .or_else(|| r.strip_prefix("refs/tags/"))
        .unwrap_or(r)
}

fn lines_label(lines: &[Value]) -> String {
    let lines: Vec<u64> = lines.iter().filter_map(Value::as_u64).collect();
    match lines.as_slice() {
        [] => String::new(),
        [one] => format!("line {one}"),
        [first, .., last] if lines.windows(2).all(|w| w[1] == w[0] + 1) => {
            format!("lines {first}-{last}")
        }
        many => format!(
            "lines {}",
            many.iter()
                .map(u64::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

pub fn why_text(value: &Value) -> String {
    let blame = &value["blame"];
    let mut out = format!(
        "{}:{}-{} at {} ({})\n",
        s(blame, "path"),
        blame["start"],
        blame["end"],
        short(s(blame, "head")),
        s(blame, "rev"),
    );
    if value["tracker"]["readable"] == json!(false) {
        let _ = writeln!(
            out,
            "(You can't read {}'s tracker: timelines, checkpoints and approvals are hidden.)",
            s(&value["tracker"], "owner")
        );
    }
    let people = &value["people"];
    let who = |id: &Value| -> String {
        match id.as_str() {
            Some(id) => people[id]["name"].as_str().unwrap_or(id).to_string(),
            None => "someone".into(),
        }
    };
    for chain in value["chains"].as_array().into_iter().flatten() {
        let commit = &chain["commit"];
        let message = s(commit, "message").lines().next().unwrap_or("");
        let _ = writeln!(
            out,
            "\n{}  {}  {}{}",
            lines_label(chain["lines"].as_array().map(Vec::as_slice).unwrap_or(&[])),
            short(s(chain, "oid")),
            message,
            if chain["onServer"] == json!(false) {
                "  (not on the server)"
            } else {
                ""
            },
        );
        match chain["changeId"].as_str() {
            Some(change) => {
                let rewritten = chain["refs"]
                    .as_array()
                    .is_some_and(|refs| refs.iter().any(|r| r["rewritten"] == json!(true)));
                let _ = writeln!(
                    out,
                    "  change      {change}{}",
                    if rewritten {
                        " (rewritten since first pushed)"
                    } else {
                        ""
                    }
                );
            }
            None => out.push_str("  change      none (not made with gm, or never pushed)\n"),
        }
        for r in chain["refs"].as_array().into_iter().flatten() {
            let update = &r["firstUpdate"];
            let by = match (update["agent"].as_str(), update["actor"].as_str()) {
                (Some(agent), Some(actor)) => format!(" by {agent} for {actor}"),
                (None, Some(actor)) => format!(" by {actor}"),
                _ => String::new(),
            };
            let _ = writeln!(
                out,
                "  {}  {} {}{by}",
                if r["afterLanding"] == json!(true) {
                    "carried to "
                } else {
                    "reached    "
                },
                ref_name(s(r, "ref")),
                day(s(r, "firstSeenAt")),
            );
        }
        for timeline in chain["timelines"].as_array().into_iter().flatten() {
            let _ = writeln!(
                out,
                "  timeline    {} \"{}\" ({}{})",
                s(timeline, "slug"),
                s(timeline, "name"),
                s(timeline, "status"),
                if timeline["experimental"] == json!(true) {
                    ", experimental"
                } else {
                    ""
                },
            );
        }
        for issue in chain["issues"].as_array().into_iter().flatten() {
            let _ = writeln!(
                out,
                "  issue       {} {} [{}]{}",
                s(issue, "key"),
                s(issue, "title"),
                s(issue, "status"),
                if s(issue, "source") == "timeline" {
                    " (worked on in the timeline)"
                } else {
                    ""
                },
            );
        }
        for checkpoint in chain["checkpoints"].as_array().into_iter().flatten() {
            let pinned = s(checkpoint, "commit");
            let _ = writeln!(
                out,
                "  checkpoint  #{} of {}{}{}",
                checkpoint["number"],
                s(checkpoint, "timeline"),
                checkpoint["approval"]["state"]
                    .as_str()
                    .map(|state| format!(" ({state})"))
                    .unwrap_or_default(),
                if pinned != s(chain, "oid") {
                    format!(" as {}", short(pinned))
                } else {
                    String::new()
                },
            );
        }
        let approval = &chain["approval"];
        if approval.is_object() {
            let _ = writeln!(
                out,
                "  approval    {} by {}{} (checkpoint #{} of {}){}",
                s(approval, "state"),
                who(&approval["by"]),
                approval["at"]
                    .as_str()
                    .map(|at| format!(" {}", day(at)))
                    .unwrap_or_default(),
                approval["number"],
                s(approval, "timeline"),
                approval["note"]
                    .as_str()
                    .map(|n| format!(": \"{n}\""))
                    .unwrap_or_default(),
            );
        }
        let landing = &chain["landing"];
        if landing.is_object() {
            let _ = writeln!(
                out,
                "  landed      {}{}{} {}",
                ref_name(s(landing, "ref")),
                if s(landing, "via") == "queue" {
                    format!(" via queue {}", s(&landing["queue"], "id"))
                } else {
                    String::new()
                },
                landing["timeline"]
                    .as_str()
                    .map(|t| format!(" with {t}"))
                    .unwrap_or_default(),
                day(s(landing, "at")),
            );
            let queue = &landing["queue"];
            if queue.is_object() {
                let requested = &queue["requestedBy"];
                let _ = writeln!(
                    out,
                    "              checkpoint #{} ({}) · requested by {} for {} · {}",
                    queue["checkpointNumber"],
                    s(queue, "checkpointId"),
                    who(if requested["agentId"].is_string() {
                        &requested["agentId"]
                    } else {
                        &requested["actorId"]
                    }),
                    who(&requested["accountableId"]),
                    s(queue, "trigger"),
                );
                for (field, label) in [("mergeRun", "merge run"), ("gateRun", "gates")] {
                    let run = &queue[field];
                    if run.is_object() {
                        let _ = writeln!(
                            out,
                            "              {label} #{} ({})",
                            run["number"],
                            s(run, "id")
                        );
                    } else if field == "gateRun" {
                        let _ = writeln!(out, "              no gates run");
                    }
                }
            }
        } else {
            let _ = writeln!(
                out,
                "  landed      not on {} yet",
                value["repo"]["defaultBranch"].as_str().unwrap_or("main")
            );
        }
        step_text(&mut out, chain);
        let _ = writeln!(out, "  discussion  {}", s(&chain["discussions"], "reason"));
    }
    out
}

/// The step behind a chain's commit (CORE-243): its why first.
fn step_text(out: &mut String, chain: &Value) {
    let step = &chain["step"];
    if !step.is_object() {
        // Only timeline work records steps: say so where one was expected.
        if chain["timelines"].as_array().is_some_and(|t| !t.is_empty()) {
            let _ = writeln!(out, "  step        no context recorded");
        }
        return;
    }
    let context = &step["context"];
    let first = |key: &str| {
        context[key]
            .as_str()
            .and_then(|t| t.lines().find(|l| !l.trim().is_empty()))
            .map(str::trim)
            .unwrap_or("")
            .to_string()
    };
    let author = &step["author"];
    let by = match (
        author["name"].as_str(),
        author["accountable"]["displayName"].as_str(),
    ) {
        (Some(name), Some(person)) if author["kind"] == "agent" => format!("{name} for {person}"),
        (Some(name), _) => name.to_string(),
        _ => "someone".into(),
    };
    let elsewhere = s(step, "commitOid") != s(chain, "oid");
    let _ = writeln!(
        out,
        "  step        {}{}",
        if step["deleted"] == true {
            "context removed by an admin".to_string()
        } else {
            format!("by {by}")
        },
        if elsewhere {
            format!(
                ", recorded on {} before a rebase",
                s(step, "commitOid").get(..12).unwrap_or("")
            )
        } else {
            String::new()
        }
    );
    for (label, key) in [("why", "why"), ("challenges", "challenges")] {
        let text = first(key);
        if !text.is_empty() {
            let _ = writeln!(out, "              {label}: {text}");
        }
    }
    for (label, key) in [("instructions", "instructions"), ("steering", "steering")] {
        if let Some(entries) = context[key].as_array().filter(|e| !e.is_empty()) {
            let _ = writeln!(
                out,
                "              {label}: {} ({})",
                entries.len(),
                s(&context["coverage"], key)
            );
        }
    }
    if let Some(tests) = context["tests"].as_array().filter(|t| !t.is_empty()) {
        let failed = tests.iter().filter(|t| t["exit"] != 0).count();
        let _ = writeln!(
            out,
            "              tests: {} passed, {failed} failed",
            tests.len() - failed
        );
    }
}

pub fn run(ctx: &Ctx, args: &WhyArgs) -> Result<Why> {
    let mut target = parse_target(&args.target, args.line.as_deref())?;
    let ws = Workspace::open(&ctx.cwd)?;
    let root = ws
        .repo
        .workdir()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| ctx.cwd.clone());
    target.path = repo_path(&root, &ctx.cwd, &target.path);
    let head = revset::resolve(&ws, &args.revision)?;
    let local = blame(&ws.repo, head, &target.path, target.start, target.end)?;
    let repo = match &args.repo {
        Some(repo) => repo.clone(),
        None => current_repo(ctx)?,
    };
    let config = Config::load();
    let mut responses = Vec::new();
    for batch in local.commits.chunks(COMMITS_PER_REQUEST) {
        let path = request_path(&repo, &target.path, batch)?;
        responses.push(remote::api(&config, "GET", &path, None)?);
    }
    // Commits the server answered for, by oid, keep the local order.
    let order: BTreeMap<&str, usize> = local
        .commits
        .iter()
        .enumerate()
        .map(|(i, c)| (c.oid.as_str(), i))
        .collect();
    let mut value = assemble(&target, &args.revision, head, &local, responses);
    if let Some(chains) = value["chains"].as_array_mut() {
        chains.sort_by_key(|c| order.get(c["oid"].as_str().unwrap_or("")).copied());
    }
    Ok(Why { value })
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Signature;

    #[test]
    fn targets_take_a_line_or_a_range() {
        let t = |spec: &str, line: Option<&str>| parse_target(spec, line);
        assert_eq!(
            t("src/app.ts:12", None).unwrap(),
            Target {
                path: "src/app.ts".into(),
                start: 12,
                end: 12
            }
        );
        assert_eq!(
            t("./src/app.ts:20-12", None).unwrap(),
            Target {
                path: "src/app.ts".into(),
                start: 12,
                end: 20
            }
        );
        assert_eq!(t("src/app.ts", Some("3-4")).unwrap().end, 4);
        // A colon that isn't a line belongs to the path.
        assert_eq!(t("a:b.ts", Some("1")).unwrap().path, "a:b.ts");
        assert!(t("src/app.ts", None).is_err());
        assert!(t("src/app.ts:0", None).is_err());
        assert!(t("src/app.ts:1-500", None).is_err());
        assert!(t(":3", None).is_err());
    }

    fn commit(
        repo: &Repository,
        parents: &[Oid],
        text: &str,
        message: &str,
        change: Option<&str>,
    ) -> Oid {
        let mut index = git2::Index::new().unwrap();
        let blob = repo.blob(text.as_bytes()).unwrap();
        let mut entry = git2::IndexEntry {
            ctime: git2::IndexTime::new(0, 0),
            mtime: git2::IndexTime::new(0, 0),
            dev: 0,
            ino: 0,
            mode: 0o100644,
            uid: 0,
            gid: 0,
            file_size: text.len() as u32,
            id: blob,
            flags: 0,
            flags_extended: 0,
            path: b"src/app.ts".to_vec(),
        };
        entry.flags = entry.path.len() as u16;
        index.add(&entry).unwrap();
        let tree = repo.find_tree(index.write_tree_to(repo).unwrap()).unwrap();
        let sig = Signature::new(
            "Ann Lee",
            "ann@example.com",
            &git2::Time::new(1_790_000_000, 0),
        )
        .unwrap();
        let parents: Vec<_> = parents
            .iter()
            .map(|p| repo.find_commit(*p).unwrap())
            .collect();
        let refs: Vec<_> = parents.iter().collect();
        let buffer = repo
            .commit_create_buffer(&sig, &sig, message, &tree, &refs)
            .unwrap();
        let text = buffer.as_str().unwrap().to_string();
        let text = match change {
            Some(id) => {
                let split = text.find("\n\n").unwrap();
                format!("{}\nchange-id {id}{}", &text[..split], &text[split..])
            }
            None => text,
        };
        repo.odb()
            .unwrap()
            .write(git2::ObjectType::Commit, text.as_bytes())
            .unwrap()
    }

    #[test]
    fn a_chain_shows_the_step_behind_its_commit() {
        let chain = json!({
            "oid": "b".repeat(40),
            "timelines": [{"slug": "search"}],
            "step": {
                "commitOid": "a".repeat(40),
                "deleted": false,
                "author": {"kind": "agent", "name": "bot", "accountable": {"displayName": "Ann"}},
                "context": {
                    "why": "Titles match what people type.\nMore detail.",
                    "challenges": "",
                    "instructions": [{"text": "Rank by title", "source": "hook"}],
                    "steering": [],
                    "tests": [{"command": "vp test", "exit": 0}, {"command": "cargo test", "exit": 1}],
                    "coverage": {"instructions": "hook:claude-code", "steering": "hook:claude-code"}
                }
            }
        });
        let mut out = String::new();
        step_text(&mut out, &chain);
        assert_eq!(
            out,
            format!(
                "  step        by bot for Ann, recorded on {} before a rebase\n              why: Titles match what people type.\n              instructions: 1 (hook:claude-code)\n              tests: 1 passed, 1 failed\n",
                "a".repeat(12)
            )
        );
        // A timeline commit with nothing recorded says so; main's says nothing.
        let mut out = String::new();
        step_text(
            &mut out,
            &json!({"oid": "c", "timelines": [{"slug": "x"}], "step": null}),
        );
        assert_eq!(out, "  step        no context recorded\n");
        let mut out = String::new();
        step_text(
            &mut out,
            &json!({"oid": "c", "timelines": [], "step": null}),
        );
        assert_eq!(out, "");
    }

    #[test]
    fn blames_locally_and_reads_change_ids_from_headers() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let root = commit(&repo, &[], "a\nb\nc\n", "Start", None);
        let edit = commit(
            &repo,
            &[root],
            "a\nB\nc\n",
            "Rank search (CORE-7)",
            Some("kpqrstuvkpqrstuv"),
        );
        let local = blame(&repo, edit, "src/app.ts", 1, 9).unwrap();
        assert_eq!(local.end, 3);
        let lines: Vec<_> = local
            .lines
            .iter()
            .map(|l| (l.line, l.commit.clone()))
            .collect();
        assert_eq!(
            lines,
            vec![
                (1, root.to_string()),
                (2, edit.to_string()),
                (3, root.to_string())
            ]
        );
        assert_eq!(local.commits[0].oid, root.to_string());
        // No header: no change id is sent (a derived one never reached the server).
        assert_eq!(local.commits[0].change_id, None);
        assert_eq!(
            local.commits[1].change_id.as_deref(),
            Some("kpqrstuvkpqrstuv")
        );
        assert_eq!(local.commits[1].summary["message"], "Rank search (CORE-7)");
        assert!(blame(&repo, edit, "src/app.ts", 4, 4).is_err());
        assert!(blame(&repo, edit, "src/nope.ts", 1, 1).is_err());

        let path = request_path("orbit/app", "src/app.ts", &local.commits).unwrap();
        assert_eq!(
            path,
            format!(
                "/repos/orbit/app/why?path=src%2Fapp.ts&commit={root}&commit={edit}%3Akpqrstuvkpqrstuv"
            )
        );
        assert!(request_path("orbit", "x", &local.commits).is_err());
    }

    #[test]
    fn output_is_the_server_chain_with_the_local_blame() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let root = commit(&repo, &[], "a\nb\n", "Start", None);
        let edit = commit(
            &repo,
            &[root],
            "a\nB\n",
            "Rank search (CORE-7)",
            Some("kpqrstuvkpqrstuv"),
        );
        let local = blame(&repo, edit, "src/app.ts", 1, 2).unwrap();
        let target = Target {
            path: "src/app.ts".into(),
            start: 1,
            end: 2,
        };
        // What the server sends in commit mode: the edit isn't pushed (a local rebase),
        // but its change id found the change's history.
        let server = json!({
            "repo": {"owner": "orbit", "name": "app", "defaultBranch": "main"},
            "tracker": {"owner": "orbit", "readable": true},
            "blame": null,
            "chains": [
                {"oid": root.to_string(), "commit": {"oid": root.to_string(), "message": "Start"},
                 "lines": [], "changeId": null, "changeSource": null, "refs": [], "timelines": [],
                 "merges": [], "issues": [], "checkpoints": [], "approval": null, "landing": null,
                 "discussions": {"available": false, "reason": "Discussions (CORE-51) aren't available yet.", "threads": []}},
                {"oid": edit.to_string(), "commit": null, "lines": [], "changeId": "kpqrstuvkpqrstuv",
                 "changeSource": "client",
                 "refs": [{"ref": "refs/heads/timeline/search", "kind": "timeline", "rewritten": true,
                           "afterLanding": false, "firstSeenAt": "2026-10-03T01:00:00Z",
                           "firstUpdate": {"actor": "ann", "agent": "bot"}}],
                 "timelines": [{"slug": "search", "name": "Search v2", "status": "landed", "experimental": false}],
                 "merges": [], "issues": [{"key": "CORE-7", "title": "Rank search", "status": "done", "source": "commit"}],
                 "checkpoints": [{"number": 1, "timeline": "search", "commit": "abc", "approval": {"state": "approved"}}],
                 "approval": {"state": "approved", "by": "ann", "at": "2026-10-03T02:00:00Z", "note": null, "number": 1, "timeline": "search"},
                 "landing": {"ref": "refs/heads/main", "at": "2026-10-03T03:00:00Z", "timeline": "search", "via": "queue",
                  "queue": {"id": "ld_search", "checkpointId": "cp_1", "checkpointNumber": 1, "trigger": "approval",
                    "requestedBy": {"actorId": "ann", "accountableId": "ann", "agentId": null},
                    "mergeRun": {"id": "run_merge", "number": 2}, "gateRun": {"id": "run_gates", "number": 3}}},
                 "discussions": {"available": false, "reason": "Discussions (CORE-51) aren't available yet.", "threads": []}}
            ],
            "people": {"ann": {"name": "Ann", "kind": "person"}}
        });
        let value = assemble(&target, "@", edit, &local, vec![server]);
        let keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, ["blame", "chains", "people", "repo", "tracker"]);
        assert_eq!(value["blame"]["source"], "local");
        assert_eq!(value["blame"]["head"], edit.to_string());
        assert_eq!(
            value["blame"]["lines"][1],
            json!({"line": 2, "commit": edit.to_string(), "originalLine": 2})
        );
        let chain = &value["chains"][1];
        assert_eq!(chain["lines"], json!([2]));
        assert_eq!(chain["onServer"], false);
        // The local commit fills in what the server didn't have.
        assert_eq!(chain["commit"]["message"], "Rank search (CORE-7)");
        assert_eq!(chain["commit"]["authorName"], "Ann Lee");
        assert_eq!(value["chains"][0]["onServer"], true);
    }
}
