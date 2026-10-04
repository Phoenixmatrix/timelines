//! Asynchronous main admissions. Reading status never changes local history.
use super::{Ctx, server::current_repo};
use crate::cli::QueueCommand;
use crate::output::{GmError, Render, Result, exit};
use crate::remote::{self, Config};
use serde::{Serialize, Serializer};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::time::{Duration, Instant};

pub struct Shown {
    value: Value,
    text: String,
}
impl Serialize for Shown {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        self.value.serialize(serializer)
    }
}
impl Render for Shown {
    fn text(&self) -> String {
        self.text.clone()
    }
}

fn valid_id(id: &str) -> Result<()> {
    if id.len() != 40
        || !id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(GmError::usage(
            "Queue IDs are full lowercase 40-hex commit IDs.",
        ));
    }
    Ok(())
}

pub(super) fn entry(response: &Value) -> Result<&Value> {
    let entry = &response["entry"];
    let id = entry["id"]
        .as_str()
        .ok_or_else(|| GmError::new("invalid_response", "Queue response has no entry identity."))?;
    if valid_id(id).is_err()
        || !matches!(
            entry["status"].as_str(),
            Some(
                "queued"
                    | "merging"
                    | "testing"
                    | "advancing"
                    | "landed"
                    | "failed"
                    | "cancelled"
                    | "covered"
            )
        )
    {
        return Err(GmError::new(
            "invalid_response",
            "Queue response has an invalid identity or status.",
        ));
    }
    match entry.get("coveredBy") {
        Some(Value::String(cover)) if valid_id(cover).is_ok() => {}
        None | Some(Value::Null) if entry["status"] != "covered" => {}
        _ => {
            return Err(GmError::new(
                "invalid_response",
                "Queue response has invalid coverage evidence.",
            ));
        }
    }
    if !entry["deployRun"].is_null() && entry["deployRun"].as_i64().is_none_or(|n| n <= 0) {
        return Err(GmError::new(
            "invalid_response",
            "Queue response has an invalid main pipeline identity.",
        ));
    }
    Ok(entry)
}

fn line(entry: &Value) -> String {
    let mut text = format!(
        "{}  {}  deployment: {}",
        entry["id"].as_str().unwrap_or("?"),
        entry["status"].as_str().unwrap_or("?"),
        entry["deployStatus"].as_str().unwrap_or("pending")
    );
    if let Some(cover) = entry["coveredBy"].as_str() {
        text.push_str(&format!("\n  Covered by: {cover}"));
    }
    if let Some(reason) = entry["failure"]["reason"].as_str() {
        text.push_str(&format!("\n  Failure: {reason}"));
    }
    if let Some(paths) = entry["failure"]["conflictPaths"].as_array() {
        for path in paths.iter().filter_map(Value::as_str) {
            text.push_str(&format!("\n  Conflict: {path}"));
        }
    }
    if let Some(issue) = entry["remediationIssueId"].as_str() {
        text.push_str(&format!("\n  Remediation: {issue}"));
    }
    if let Some(run) = entry["deployRun"].as_i64() {
        text.push_str(&format!("\n  Main pipeline: #{run}"));
    }
    text
}

fn shown(value: Value) -> Result<Shown> {
    let text = line(entry(&value)?);
    Ok(Shown { value, text })
}

fn fetch(config: &Config, base: &str, id: &str) -> Result<Value> {
    valid_id(id)?;
    let response = remote::api(config, "GET", &format!("{base}/{id}"), None)?;
    if entry(&response)?["id"].as_str() != Some(id) {
        return Err(GmError::new(
            "invalid_response",
            "Queue lookup returned a different entry.",
        ));
    }
    Ok(response)
}

pub fn run(ctx: &Ctx, command: &QueueCommand) -> Result<Shown> {
    let repo = match command {
        QueueCommand::List { repo, .. }
        | QueueCommand::Show { repo, .. }
        | QueueCommand::Wait { repo, .. }
        | QueueCommand::Cancel { repo, .. }
        | QueueCommand::Retry { repo, .. } => repo,
    };
    let repo = match repo {
        Some(repo) => repo.clone(),
        None => current_repo(ctx)?,
    };
    let parts: Vec<_> = repo.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|part| {
            part.is_empty()
                || *part == "."
                || *part == ".."
                || !part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
    {
        return Err(GmError::usage("Name a repository as owner/name."));
    }
    let config = Config::load();
    let base = format!("/repos/{repo}/queue");
    match command {
        QueueCommand::List { status, .. } => {
            let path = match status {
                Some(status) => format!("{base}?status={status}"),
                None => base,
            };
            let value = remote::api(&config, "GET", &path, None)?;
            let entries = value["entries"].as_array().ok_or_else(|| {
                GmError::new("invalid_response", "Queue list response has no entries.")
            })?;
            let text = if entries.is_empty() {
                format!("No queue admissions for {repo}.")
            } else {
                entries.iter().map(line).collect::<Vec<_>>().join("\n")
            };
            Ok(Shown { value, text })
        }
        QueueCommand::Show { id, .. } => shown(fetch(&config, &base, id)?),
        QueueCommand::Wait {
            id,
            timeout,
            deploy,
            ..
        } => wait(&config, &repo, &base, id, *timeout, *deploy),
        QueueCommand::Cancel { id, .. } | QueueCommand::Retry { id, .. } => {
            valid_id(id)?;
            let action = if matches!(command, QueueCommand::Cancel { .. }) {
                "cancel"
            } else {
                "retry"
            };
            if ctx.dry_run {
                return Ok(Shown {
                    value: json!({"dry_run": true, "id": id, "action": action}),
                    text: format!("Would {action} queue admission {id}; nothing changed."),
                });
            }
            let response = remote::api(&config, "POST", &format!("{base}/{id}/{action}"), Some(&json!({})))
                .map_err(|error| error.hint(format!("The response may be uncertain. Inspect `gm queue show {id} -R {repo}` before acting again.")))?;
            shown(response)
        }
    }
}

fn wait(
    config: &Config,
    repo: &str,
    base: &str,
    requested: &str,
    timeout: u64,
    deploy: bool,
) -> Result<Shown> {
    valid_id(requested)?;
    let started = Instant::now();
    'observe: loop {
        // Coverage can be withdrawn when a combined attempt is split. Start
        // every observation at the user's admission, never a cached leader.
        let mut id = requested.to_string();
        let mut seen = HashSet::from([id.clone()]);
        let mut coverage = Vec::new();
        let mut response = loop {
            let response = fetch(config, base, &id)?;
            let current = entry(&response)?;
            let Some(cover) = current["coveredBy"].as_str() else {
                break response;
            };
            coverage.push((id.clone(), cover.to_string()));
            if seen.len() >= 64 || !seen.insert(cover.to_string()) {
                return Err(GmError::new(
                    "queue_coverage_cycle",
                    "Queue coverage is cyclic or exceeds 64 entries.",
                ));
            }
            id = cover.to_string();
            if started.elapsed() >= Duration::from_secs(timeout) {
                return Err(timeout_error(requested, repo, timeout, deploy));
            }
        };
        let current = entry(&response)?;
        let status = current["status"].as_str().unwrap_or("");
        if matches!(status, "failed" | "cancelled" | "landed") {
            // A split can withdraw any intermediate edge, not just the first.
            // Validate back to the requested admission after observing the
            // verdict, for success as well as failure. Restart from the original
            // whenever a link changed, under the same overall deadline.
            for (source, target) in coverage.iter().rev() {
                if started.elapsed() >= Duration::from_secs(timeout) {
                    return Err(timeout_error(requested, repo, timeout, deploy));
                }
                let latest = fetch(config, base, source)?;
                let latest = entry(&latest)?;
                if latest["status"] != "covered"
                    || latest["coveredBy"].as_str() != Some(target.as_str())
                {
                    continue 'observe;
                }
            }
        }
        if matches!(status, "failed" | "cancelled") {
            return Err(GmError::new(if status == "failed" { "queue_failed" } else { "queue_cancelled" }, line(current))
                .hint(format!("Inspect `gm queue show {requested} -R {repo}` and claim its remediation issue using normal fenced tracker commands."))
                .exit(exit::CONFLICT));
        }
        if status == "landed" {
            if !deploy {
                return shown(response);
            }
            if let Some(number) = current["deployRun"].as_i64() {
                let mut number = number;
                let mut runs = HashSet::new();
                loop {
                    if runs.len() >= 64 || !runs.insert(number) {
                        return Err(GmError::new(
                            "queue_coverage_cycle",
                            "Main pipeline coverage is cyclic or exceeds 64 runs.",
                        ));
                    }
                    let run = remote::api(
                        config,
                        "GET",
                        &format!("/repos/{repo}/ci/runs/{number}"),
                        None,
                    )?;
                    if !run["coveredBy"].is_null()
                        && run["coveredBy"].as_i64().is_none_or(|n| n <= 0)
                    {
                        return Err(GmError::new(
                            "invalid_response",
                            "Main pipeline response has invalid coverage evidence.",
                        ));
                    }
                    if let Some(cover) = run["coveredBy"].as_i64() {
                        number = cover;
                        if started.elapsed() >= Duration::from_secs(timeout) {
                            return Err(timeout_error(requested, repo, timeout, deploy));
                        }
                        continue;
                    }
                    match run["status"].as_str() {
                        Some("succeeded") => {
                            response["entry"]["deployRun"] = json!(number);
                            response["entry"]["deployStatus"] = json!("succeeded");
                            return shown(response);
                        }
                        Some("failed" | "cancelled" | "skipped") => return Err(GmError::new("deployment_failed", format!("Queue entry landed, but main pipeline #{number} did not succeed."))
                            .hint(format!("Inspect `gm runs show {number} -R {repo}` and `gm runs logs {number} -R {repo}`. Main has not been rewound."))
                            .exit(exit::CONFLICT)),
                        Some("queued" | "running") => break,
                        _ => return Err(GmError::new("invalid_response", "Main pipeline response has an invalid status.")),
                    }
                }
            } else if matches!(
                current["deployStatus"].as_str(),
                Some("failed" | "cancelled")
            ) {
                return Err(GmError::new("deployment_failed", line(current)).exit(exit::CONFLICT));
            }
        }
        if started.elapsed() >= Duration::from_secs(timeout) {
            return Err(timeout_error(requested, repo, timeout, deploy));
        }
        std::thread::sleep(
            Duration::from_secs(2)
                .min(Duration::from_secs(timeout).saturating_sub(started.elapsed())),
        );
    }
}

fn timeout_error(id: &str, repo: &str, timeout: u64, deploy: bool) -> GmError {
    GmError::new(
        "timeout",
        format!(
            "Queue admission {id} has no final {} verdict after {timeout}s.",
            if deploy { "main pipeline" } else { "landing" }
        ),
    )
    .hint(format!(
        "Continue with `gm queue wait {id} -R {repo}{} --timeout {timeout}`.",
        if deploy { " --deploy" } else { "" }
    ))
}
