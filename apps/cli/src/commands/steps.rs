//! Step context (CORE-226, CORE-232): what an agent attaches to a commit it
//! makes at a meaningful step: instructions, steering, why, challenges and
//! test results. `gm commit --context` journals it locally with the commit;
//! `gm push` uploads it for the pushed changes; `gm context sync` retries.
//!
//! The journal lives in the repository's shared `gm/steps/` directory, one
//! JSON file per commit, so every worktree of the repository sees it. A commit
//! that amend or rebase replaced keeps no file of its own: it inherits the
//! newest context of its change ID when it's uploaded, as a new version.

use crate::commands::Ctx;
use crate::output::{GmError, Result};
use crate::remote::{self, Config};
use crate::repo::Workspace;
use git2::Oid;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

/// The fields a step's context may carry (shared/steps.ts StepContextBody).
const FIELDS: [&str; 8] = [
    "instructions",
    "steering",
    "why",
    "challenges",
    "tests",
    "coverage",
    "harness",
    "model",
];

/// Where this repository's step journal lives.
pub fn journal_dir(ws: &Workspace) -> PathBuf {
    ws.repo.commondir().join("gm").join("steps")
}

/// Reads `--context`: a path, or `-` for stdin.
pub fn read_context_arg(arg: &str) -> Result<String> {
    if arg == "-" {
        let mut text = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut text)
            .map_err(|e| GmError::usage(format!("Couldn't read the context from stdin: {e}")))?;
        Ok(text)
    } else {
        fs::read_to_string(arg).map_err(|e| {
            GmError::usage(format!("Couldn't read the context file {arg}: {e}"))
                .hint("Pass a JSON or Markdown file, or `-` to read stdin.")
        })
    }
}

/// A context from JSON (the fields above) or Markdown sections:
/// `## Instructions`, `## Steering` (one entry per bullet or paragraph),
/// `## Why`, `## Challenges`. Tests come from `gm test` or JSON.
pub fn parse_context(text: &str) -> Result<Value> {
    let trimmed = text.trim();
    if trimmed.starts_with('{') {
        let value: Value = serde_json::from_str(trimmed).map_err(|e| {
            GmError::usage(format!("The context isn't valid JSON: {e}"))
                .hint("Use JSON with instructions, steering, why, challenges, tests, or Markdown sections.")
        })?;
        let Value::Object(map) = value else {
            return Err(GmError::usage("The context JSON must be an object."));
        };
        let kept: Map<String, Value> = map
            .into_iter()
            .filter(|(key, _)| FIELDS.contains(&key.as_str()))
            .collect();
        return Ok(Value::Object(kept));
    }
    let mut sections: Vec<(String, Vec<String>)> = Vec::new();
    for line in text.lines() {
        if let Some(heading) = line.trim().strip_prefix("## ") {
            sections.push((heading.trim().to_lowercase(), Vec::new()));
        } else if let Some((_, lines)) = sections.last_mut() {
            lines.push(line.to_string());
        }
    }
    let mut out = Map::new();
    for (name, lines) in sections {
        let body = lines.join("\n").trim().to_string();
        if body.is_empty() {
            continue;
        }
        match name.as_str() {
            "instructions" | "instruction" | "prompt" | "prompts" => {
                out.insert("instructions".into(), entries(&lines));
            }
            "steering" => {
                out.insert("steering".into(), entries(&lines));
            }
            "why" => {
                out.insert("why".into(), Value::String(body));
            }
            "challenges" => {
                out.insert("challenges".into(), Value::String(body));
            }
            _ => {}
        }
    }
    if out.is_empty() {
        return Err(GmError::usage(
            "The context has none of: ## Instructions, ## Steering, ## Why, ## Challenges.",
        )
        .hint("Write Markdown with those headings, or JSON."));
    }
    Ok(Value::Object(out))
}

/// One entry per bullet, or per paragraph when there are no bullets.
fn entries(lines: &[String]) -> Value {
    let bullets: Vec<String> = lines
        .iter()
        .filter_map(|line| {
            let t = line.trim_start();
            t.strip_prefix("- ")
                .or_else(|| t.strip_prefix("* "))
                .map(|rest| rest.trim().to_string())
        })
        .filter(|text| !text.is_empty())
        .collect();
    let texts = if bullets.is_empty() {
        lines
            .join("\n")
            .split("\n\n")
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect()
    } else {
        bullets
    };
    Value::Array(
        texts
            .into_iter()
            .map(|text| json!({"text": text, "source": "agent"}))
            .collect(),
    )
}

/// Prefixes of well-known credentials, redacted with what follows them.
const TOKEN_PREFIXES: [&str; 12] = [
    "gmx_",
    "gmj_",
    "ghp_",
    "gho_",
    "ghs_",
    "github_pat_",
    "sk-",
    "sk_live_",
    "xoxb-",
    "xoxp-",
    "AKIA",
    "AIza",
];
/// Names whose `NAME=value` values are secrets.
const SECRET_NAMES: [&str; 6] = [
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASSWD",
    "API_KEY",
    "PRIVATE_KEY",
];

fn token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// Credentials out of text before it leaves the machine: well-known token
/// formats, bearer tokens, private key blocks and secret-looking `NAME=value`
/// assignments. Best effort, like any redaction.
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    // Private key blocks, whole.
    while let Some(start) = rest.find("-----BEGIN ") {
        let block = &rest[start..];
        let is_key = block
            .lines()
            .next()
            .is_some_and(|l| l.contains("PRIVATE KEY"));
        if !is_key {
            out.push_str(&rest[..start + 11]);
            rest = &rest[start + 11..];
            continue;
        }
        out.push_str(&rest[..start]);
        out.push_str("[redacted private key]");
        rest = match block.find("-----END ") {
            Some(end) => {
                let after = &block[end + 9..];
                after.find("-----").map_or("", |close| &after[close + 5..])
            }
            None => "",
        };
    }
    out.push_str(rest);
    let mut text = out;

    // Tokens with known prefixes, and bearer tokens.
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let at_boundary = i == 0 || !token_char(chars[i - 1]);
        let tail: String = chars[i..chars.len().min(i + 12)].iter().collect();
        let prefix = at_boundary
            .then(|| TOKEN_PREFIXES.iter().find(|p| tail.starts_with(**p)))
            .flatten();
        if let Some(prefix) = prefix {
            let mut end = i + prefix.len();
            while end < chars.len() && token_char(chars[end]) {
                end += 1;
            }
            if end - i >= prefix.len() + 8 {
                out.push_str("[redacted]");
                i = end;
                continue;
            }
        }
        let tail_lower = tail.to_lowercase();
        if at_boundary && tail_lower.starts_with("bearer ") {
            let mut end = i + 7;
            while end < chars.len() && (token_char(chars[end]) || chars[end] == '.') {
                end += 1;
            }
            if end - (i + 7) >= 12 {
                out.push_str("Bearer [redacted]");
                i = end;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    text = out;

    // NAME=value where the name says secret.
    text.lines()
        .map(|line| {
            let Some((name, _)) = line.split_once('=') else {
                return line.to_string();
            };
            let key = name.trim().trim_start_matches("export ").trim();
            let upper = key.to_uppercase();
            let looks_like_name = !key.is_empty()
                && key
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.');
            if looks_like_name && SECRET_NAMES.iter().any(|s| upper.contains(s)) {
                format!("{name}=[redacted]")
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(if text.contains('\n') { "\n" } else { "" })
        + if text.ends_with('\n') { "\n" } else { "" }
}

fn redact_value(value: &mut Value) {
    match value {
        Value::String(s) => *s = redact(s),
        Value::Array(items) => items.iter_mut().for_each(redact_value),
        Value::Object(map) => map.values_mut().for_each(redact_value),
        _ => {}
    }
}

/// A journal entry: the upload, and whether the server has it.
fn entry_path(ws: &Workspace, oid: Oid) -> PathBuf {
    journal_dir(ws).join(format!("{oid}.json"))
}

fn commit_time(ws: &Workspace, oid: Oid) -> Result<String> {
    let commit = ws.commit(oid)?;
    let seconds = commit.time().seconds();
    Ok(chrono::DateTime::from_timestamp(seconds, 0)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn summary_of(ws: &Workspace, oid: Oid) -> Result<String> {
    let commit = ws.commit(oid)?;
    Ok(commit
        .message()
        .unwrap_or_default()
        .lines()
        .next()
        .unwrap_or_default()
        .chars()
        .take(500)
        .collect())
}

/// Journals `context` for the commit `oid`: redacted, with the change ID,
/// summary, time, timeline and harness filled in. Coverage defaults to what
/// the context itself contains (`agent`) or `none`.
pub fn record(ws: &Workspace, oid: Oid, context: Value) -> Result<()> {
    let mut context = context;
    redact_value(&mut context);
    let mut upload = match context {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    let has = |key: &str| {
        upload
            .get(key)
            .and_then(Value::as_array)
            .is_some_and(|a| !a.is_empty())
    };
    if !upload.contains_key("coverage") {
        let instructions = if has("instructions") { "agent" } else { "none" };
        let steering = if has("steering") { "agent" } else { "none" };
        upload.insert(
            "coverage".into(),
            json!({"instructions": instructions, "steering": steering}),
        );
    }
    if !upload.contains_key("harness") {
        let harness = crate::agent::detect().map(|h| h.id.to_string());
        upload.insert("harness".into(), json!(harness));
    }
    if !upload.contains_key("model") {
        upload.insert("model".into(), json!(std::env::var("GM_MODEL").ok()));
    }
    upload.insert("changeId".into(), json!(ws.change_id(&ws.commit(oid)?)));
    upload.insert("commitOid".into(), json!(oid.to_string()));
    upload.insert("summary".into(), json!(summary_of(ws, oid)?));
    upload.insert("committedAt".into(), json!(commit_time(ws, oid)?));
    upload.insert("timeline".into(), json!(ws.timeline));
    let dir = journal_dir(ws);
    fs::create_dir_all(&dir)
        .map_err(|e| GmError::new("io", format!("Couldn't create {}: {e}", dir.display())))?;
    let entry = json!({"upload": Value::Object(upload), "uploaded": false});
    let path = entry_path(ws, oid);
    fs::write(&path, serde_json::to_vec_pretty(&entry).unwrap_or_default())
        .map_err(|e| GmError::new("io", format!("Couldn't write {}: {e}", path.display())))?;
    Ok(())
}

fn read_entry(path: &std::path::Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// Every journal entry, newest commit time first.
fn entries_all(ws: &Workspace) -> Vec<(PathBuf, Value)> {
    let Ok(dir) = fs::read_dir(journal_dir(ws)) else {
        return Vec::new();
    };
    let mut all: Vec<(PathBuf, Value)> = dir
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .filter_map(|p| read_entry(&p).map(|v| (p, v)))
        .collect();
    all.sort_by(|a, b| {
        let at = |v: &Value| {
            v["upload"]["committedAt"]
                .as_str()
                .unwrap_or("")
                .to_string()
        };
        at(&b.1).cmp(&at(&a.1))
    });
    all
}

/// The journal entry for `oid`, or one inherited from the newest entry of its
/// change ID (a commit amend or rebase replaced), written as its own entry.
fn entry_for(ws: &Workspace, oid: Oid) -> Result<Option<(PathBuf, Value)>> {
    entry_lookup(ws, oid, true)
}

/// `entry_for`, optionally without writing the inherited entry (for reads).
fn entry_lookup(ws: &Workspace, oid: Oid, persist: bool) -> Result<Option<(PathBuf, Value)>> {
    let path = entry_path(ws, oid);
    if let Some(entry) = read_entry(&path) {
        return Ok(Some((path, entry)));
    }
    let change = ws.change_id(&ws.commit(oid)?);
    let inherited = entries_all(ws)
        .into_iter()
        .find(|(_, entry)| entry["upload"]["changeId"].as_str() == Some(change.as_str()));
    let Some((_, mut entry)) = inherited else {
        return Ok(None);
    };
    entry["upload"]["commitOid"] = json!(oid.to_string());
    entry["upload"]["summary"] = json!(summary_of(ws, oid)?);
    entry["upload"]["committedAt"] = json!(commit_time(ws, oid)?);
    entry["upload"]["timeline"] = json!(ws.timeline);
    entry["uploaded"] = json!(false);
    if persist {
        fs::write(&path, serde_json::to_vec_pretty(&entry).unwrap_or_default())
            .map_err(|e| GmError::new("io", format!("Couldn't write {}: {e}", path.display())))?;
    }
    Ok(Some((path, entry)))
}

/// What an upload attempt did, for the command's result.
#[derive(Default, serde::Serialize, schemars::JsonSchema)]
pub struct Uploads {
    pub uploaded: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub failed: Vec<String>,
}

fn upload_one(
    ctx: &Ctx,
    config: &Config,
    repo: &str,
    path: &PathBuf,
    mut entry: Value,
) -> Result<()> {
    let source = match entry["upload"]["timeline"].as_str() {
        Some(slug) => format!(
            "?source={}",
            super::timeline::work_source(ctx, config, slug)?.id
        ),
        None => String::new(),
    };
    remote::api(
        config,
        "POST",
        &format!("/repos/{repo}/steps{source}"),
        Some(&entry["upload"]),
    )?;
    entry["uploaded"] = json!(true);
    let _ = fs::write(path, serde_json::to_vec_pretty(&entry).unwrap_or_default());
    Ok(())
}

/// Uploads the context of these commits (with inherited context for rewritten
/// ones). Failures are reported, never fatal: `gm context sync` retries.
pub fn upload_commits(
    ctx: &Ctx,
    config: &Config,
    repo: &str,
    ws: &Workspace,
    oids: &[Oid],
) -> Uploads {
    let mut result = Uploads::default();
    for oid in oids {
        let Ok(Some((path, entry))) = entry_for(ws, *oid) else {
            continue;
        };
        if entry["uploaded"].as_bool() == Some(true) {
            continue;
        }
        match upload_one(ctx, config, repo, &path, entry) {
            Ok(()) => result.uploaded += 1,
            Err(e) => result
                .failed
                .push(format!("{}: {}", &oid.to_string()[..12], e.message)),
        }
    }
    result
}

/// Uploads every journal entry the server doesn't have yet.
pub fn upload_pending(ctx: &Ctx, config: &Config, repo: &str, ws: &Workspace) -> Uploads {
    let mut result = Uploads::default();
    for (path, entry) in entries_all(ws) {
        if entry["uploaded"].as_bool() == Some(true) {
            continue;
        }
        let oid = entry["upload"]["commitOid"]
            .as_str()
            .unwrap_or("")
            .to_string();
        match upload_one(ctx, config, repo, &path, entry) {
            Ok(()) => result.uploaded += 1,
            Err(e) => {
                result
                    .failed
                    .push(format!("{}: {}", oid.get(..12).unwrap_or(&oid), e.message))
            }
        }
    }
    result
}

/// The repository's owner/name on the server, from origin.
pub fn repo_slug(ctx: &Ctx) -> Result<String> {
    super::server::current_repo(ctx)
}

// ---- reading steps: gm context show, log --context, show --context ---------------

/// A step's context as a read shows it.
#[derive(Clone, serde::Serialize, schemars::JsonSchema)]
pub struct StepView {
    /// The full change ID.
    pub change_id: String,
    pub commit_oid: String,
    /// `server` (uploaded) or `local` (only in this repository's journal).
    pub origin: String,
    /// A push showed the commit as this change. Local-only steps aren't verified.
    pub verified: bool,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue: Option<String>,
    /// Who uploaded it (an agent and its accountable person); null when local.
    #[schemars(with = "Option<serde_json::Value>")]
    pub author: Option<Value>,
    /// instructions, steering, why, challenges, tests, coverage, harness, model.
    #[schemars(with = "serde_json::Value")]
    pub context: Value,
}

impl StepView {
    /// The step's why, on one line.
    pub fn why(&self) -> Option<String> {
        let why = self.context["why"]
            .as_str()?
            .split_whitespace()
            .collect::<Vec<_>>();
        (!why.is_empty()).then(|| why.join(" "))
    }

    /// The step as text: who, then each part it has.
    pub fn text(&self) -> String {
        let mut out = vec![];
        let who = self
            .author
            .as_ref()
            .and_then(|a| {
                let name = a["name"].as_str()?;
                Some(match a["accountable"]["displayName"].as_str() {
                    Some(person) => format!("{name} (for {person})"),
                    None => name.to_string(),
                })
            })
            .unwrap_or_else(|| "this checkout".into());
        let state = match (self.origin.as_str(), self.verified) {
            ("local", _) => "local, not pushed",
            (_, true) => "verified",
            (_, false) => "uploaded, not yet pushed",
        };
        out.push(crate::output::style::dim(&format!(
            "Step context from {who} · {state}"
        )));
        let list = |key: &str| -> Vec<String> {
            self.context[key]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|e| {
                            let text = e["text"].as_str()?;
                            let source = e["source"].as_str().unwrap_or("agent");
                            Some(format!("  - {text} ({source})"))
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        for (title, key) in [("Instructions", "instructions"), ("Steering", "steering")] {
            let items = list(key);
            if !items.is_empty() {
                out.push(format!("{title}:"));
                out.extend(items);
            }
        }
        for (title, key) in [("Why", "why"), ("Challenges", "challenges")] {
            if let Some(text) = self.context[key].as_str().filter(|t| !t.trim().is_empty()) {
                out.push(format!("{title}:"));
                out.extend(text.trim().lines().map(|l| format!("  {l}")));
            }
        }
        if let Some(tests) = self.context["tests"].as_array().filter(|t| !t.is_empty()) {
            out.push("Tests:".into());
            for t in tests {
                out.push(format!(
                    "  {} {} → exit {}{}",
                    if t["exit"].as_i64() == Some(0) {
                        "✓"
                    } else {
                        "✗"
                    },
                    t["command"].as_str().unwrap_or("?"),
                    t["exit"],
                    t["summary"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(|s| format!(" ({s})"))
                        .unwrap_or_default()
                ));
            }
        }
        let coverage = &self.context["coverage"];
        if coverage["instructions"] == "none" || coverage["steering"] == "none" {
            out.push(crate::output::style::dim(
                "No harness hook recorded this step's prompts or steering; some context may be missing.",
            ));
        }
        out.join("\n")
    }
}

/// Upload fields that describe the step rather than its context.
const META: [&str; 6] = [
    "changeId",
    "commitOid",
    "summary",
    "committedAt",
    "timeline",
    "issue",
];

fn local_view(entry: &Value) -> StepView {
    let upload = &entry["upload"];
    let context: Map<String, Value> = upload
        .as_object()
        .map(|m| {
            m.iter()
                .filter(|(k, _)| !META.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
        .unwrap_or_default();
    let text = |k: &str| upload[k].as_str().map(str::to_string);
    StepView {
        change_id: text("changeId").unwrap_or_default(),
        commit_oid: text("commitOid").unwrap_or_default(),
        origin: "local".into(),
        verified: false,
        summary: text("summary").unwrap_or_default(),
        timeline: text("timeline"),
        issue: text("issue"),
        author: None,
        context: Value::Object(context),
    }
}

fn server_view(step: &Value) -> StepView {
    let text = |k: &str| step[k].as_str().map(str::to_string);
    StepView {
        change_id: text("changeId").unwrap_or_default(),
        commit_oid: text("commitOid").unwrap_or_default(),
        origin: "server".into(),
        verified: step["verified"].as_bool().unwrap_or(false),
        summary: text("summary").unwrap_or_default(),
        timeline: text("timeline"),
        issue: text("issue"),
        author: Some(step["author"].clone()),
        context: step["context"].clone(),
    }
}

/// The context of these commits: what the server has, else this repository's
/// journal (local, unverified). A server that can't be reached leaves a note
/// and the local context.
pub fn lookup(ctx: &Ctx, ws: &Workspace, oids: &[Oid]) -> (HashMap<Oid, StepView>, Option<String>) {
    let mut found = HashMap::new();
    for oid in oids {
        if let Ok(Some((_, entry))) = entry_lookup(ws, *oid, false) {
            found.insert(*oid, local_view(&entry));
        }
    }
    let Ok(repo) = repo_slug(ctx) else {
        return (found, None);
    };
    let config = Config::load();
    let source = match super::timeline::source_query(ctx, &config) {
        Ok(source) => source,
        Err(error) => return (found, Some(error.message)),
    };
    for chunk in oids.chunks(100) {
        let list = chunk
            .iter()
            .map(Oid::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let path = format!("/repos/{repo}/steps?commits={list}&limit=100&{source}");
        match remote::api(&config, "GET", &path, None) {
            Ok(page) => {
                for step in page["steps"].as_array().into_iter().flatten() {
                    let Some(oid) = step["commitOid"]
                        .as_str()
                        .and_then(|s| Oid::from_str(s).ok())
                    else {
                        continue;
                    };
                    // The newest version wins when an author re-uploaded.
                    found
                        .entry(oid)
                        .and_modify(|v: &mut StepView| {
                            if v.origin == "local" {
                                *v = server_view(step);
                            }
                        })
                        .or_insert_with(|| server_view(step));
                }
            }
            Err(e) => {
                return (
                    found,
                    Some(format!(
                        "Couldn't read step context from the server ({}); showing this checkout's.",
                        e.message
                    )),
                );
            }
        }
    }
    (found, None)
}

#[derive(clap::Subcommand)]
pub enum ContextCommand {
    /// Upload step context the server doesn't have yet (after an offline push or a crash)
    Sync,
    /// The context of one step: why, instructions, steering, challenges, tests
    Show {
        /// Revision to show.
        #[arg(default_value = "@-")]
        revision: String,
    },
}

#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct Shown {
    pub change_id: String,
    pub commit_oid: String,
    /// Null when nothing recorded context for this step.
    pub step: Option<StepView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl crate::output::Render for Shown {
    fn text(&self) -> String {
        let mut out = match &self.step {
            Some(step) => format!(
                "{}  {}\n{}",
                crate::output::style::change(&self.change_id[..8.min(self.change_id.len())]),
                step.summary,
                step.text()
            ),
            None => format!(
                "No context was recorded for {}. Agents attach it with `gm commit --context`.",
                &self.change_id[..8.min(self.change_id.len())]
            ),
        };
        if let Some(note) = &self.note {
            out.push_str(&format!("\n{}", crate::output::style::dim(note)));
        }
        out
    }
}

pub fn show(ctx: &Ctx, revision: &str) -> Result<Shown> {
    let ws = Workspace::open(&ctx.cwd)?;
    let oid = crate::repo::revset::resolve(&ws, revision)?;
    let (mut found, note) = lookup(ctx, &ws, &[oid]);
    Ok(Shown {
        change_id: ws.change_id(&ws.commit(oid)?),
        commit_oid: oid.to_string(),
        step: found.remove(&oid),
        note,
    })
}

#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct Synced {
    pub repo: String,
    #[serde(flatten)]
    pub uploads: Uploads,
    pub message: String,
}

impl crate::output::Render for Synced {
    fn text(&self) -> String {
        let mut out = self.message.clone();
        for failure in &self.uploads.failed {
            out.push_str(&format!("\n  failed {failure}"));
        }
        out
    }
}

pub fn sync(ctx: &Ctx) -> Result<Synced> {
    let config = Config::load();
    let ws = Workspace::open(&ctx.cwd)?;
    let repo = repo_slug(ctx)?;
    if ctx.dry_run {
        let pending = entries_all(&ws)
            .iter()
            .filter(|(_, e)| e["uploaded"].as_bool() != Some(true))
            .count();
        return Ok(Synced {
            repo,
            uploads: Uploads::default(),
            message: format!("dry run: {pending} step context(s) would be uploaded"),
        });
    }
    let uploads = upload_pending(ctx, &config, &repo, &ws);
    let message = if uploads.failed.is_empty() {
        format!("Uploaded {} step context(s).", uploads.uploaded)
    } else {
        format!(
            "Uploaded {} step context(s); {} failed (run `gm context sync` again).",
            uploads.uploaded,
            uploads.failed.len()
        )
    };
    Ok(Synced {
        repo,
        uploads,
        message,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_sections_become_fields() {
        let ctx = parse_context(
            "## Instructions\n- Rank by recency\n- Keep it fast\n\n## Steering\nUse the old order as a fallback.\n\n## Why\nRecency matters.\n\n## Challenges\nThe index was missing.\n## Unknown\nignored\n",
        )
        .unwrap();
        assert_eq!(
            ctx["instructions"],
            json!([{"text": "Rank by recency", "source": "agent"}, {"text": "Keep it fast", "source": "agent"}])
        );
        assert_eq!(
            ctx["steering"],
            json!([{"text": "Use the old order as a fallback.", "source": "agent"}])
        );
        assert_eq!(ctx["why"], json!("Recency matters."));
        assert_eq!(ctx["challenges"], json!("The index was missing."));
        assert!(ctx.get("unknown").is_none());
    }

    #[test]
    fn json_keeps_known_fields_only() {
        let ctx = parse_context(r#"{"why": "x", "secret": 1, "tests": []}"#).unwrap();
        assert_eq!(ctx, json!({"why": "x", "tests": []}));
        assert!(parse_context("[1]").is_err());
        assert!(parse_context("just text").is_err());
    }

    #[test]
    fn redaction_removes_credentials() {
        let text = "token gmx_abcdefghijklmnop and Bearer abc.def.ghijklmnopqr\nAPI_KEY=hunter2\nexport GITHUB_TOKEN=xyz\nPATH=/usr/bin\nkeep sk- short";
        let out = redact(text);
        assert!(!out.contains("gmx_abcdefghijklmnop"), "{out}");
        assert!(!out.contains("ghijklmnopqr"), "{out}");
        assert!(out.contains("API_KEY=[redacted]"), "{out}");
        assert!(out.contains("export GITHUB_TOKEN=[redacted]"), "{out}");
        assert!(out.contains("PATH=/usr/bin"), "{out}");
        assert!(out.contains("keep sk- short"), "{out}");
        let key = "before\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\nafter";
        let out = redact(key);
        assert!(!out.contains("abc"), "{out}");
        assert!(out.contains("before") && out.contains("after"), "{out}");
    }
}
