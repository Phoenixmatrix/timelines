//! Deployment records: Gitmatrix deploys nothing, so jobs and outside systems
//! tell it where code went (`gm deploy record`), and it shows them next to CI
//! runs, commits and timelines. Inside a CI job gm records as the job (its
//! GITMATRIX_TOKEN): the server fills in the repository's run, commit and
//! branch. Elsewhere it records as you, for an explicit commit.

use super::Ctx;
use super::ci::commit_of;
use super::semantic::encode_into;
use super::server::current_repo;
use crate::output::{GmError, Render, Result};
use crate::remote::{self, Config};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use clap::{Args, Subcommand, ValueEnum};
use serde::{Serialize, Serializer};
use serde_json::{Map, Value, json};

#[derive(Subcommand)]
pub enum DeployCommand {
    /// Record a deployment: where a commit is deployed (from a CI job, or with --commit)
    Record(RecordArgs),
    /// Deployments, newest first, filtered by environment, timeline, commit, run or status
    List(ListArgs),
    /// Change a deployment's status, URL or expiry (e.g. mark a torn-down preview expired)
    Update(UpdateArgs),
}

#[derive(Clone, Copy, ValueEnum)]
pub enum Status {
    Active,
    Sleeping,
    Expired,
    Failed,
}

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Status::Active => "active",
            Status::Sleeping => "sleeping",
            Status::Expired => "expired",
            Status::Failed => "failed",
        }
    }
}

#[derive(Args)]
pub struct RecordArgs {
    /// Where the deployment answers (http or https). Only a failed deployment may omit it.
    #[arg(long)]
    pub url: Option<String>,
    /// Environment: `production`, `timeline/<slug>` or a name of your own. Default: the
    /// timeline's; in CI, from the branch (default branch: production; timeline/<slug>: its
    /// timeline); otherwise production.
    #[arg(short, long)]
    pub environment: Option<String>,
    /// Timeline slug (default: $GITMATRIX_TIMELINE).
    #[arg(long)]
    pub timeline: Option<String>,
    /// Checkpoint id (default: $GITMATRIX_CHECKPOINT).
    #[arg(long)]
    pub checkpoint: Option<String>,
    /// Status (default: active).
    #[arg(long, value_enum)]
    pub status: Option<Status>,
    /// When the deployment expires: an ISO time, a duration from now (`30m`, `12h`, `2d`),
    /// or `never`. Default: none, except timeline previews (the account's idle period).
    #[arg(long)]
    pub expires: Option<String>,
    /// Deployed revision or full commit hash (default in CI: the job's commit). Required outside CI.
    #[arg(short, long)]
    pub commit: Option<String>,
    /// Repository as owner/name (default: $GITMATRIX_REPOSITORY, then this repository's origin).
    #[arg(short = 'R', long)]
    pub repo: Option<String>,
}

#[derive(Args)]
pub struct ListArgs {
    #[arg(short, long)]
    pub environment: Option<String>,
    /// Timeline slug.
    #[arg(long)]
    pub timeline: Option<String>,
    /// Revision or full commit hash.
    #[arg(short, long)]
    pub commit: Option<String>,
    /// CI run number.
    #[arg(long)]
    pub run: Option<u64>,
    #[arg(long, value_enum)]
    pub status: Option<Status>,
    #[arg(short = 'n', long, default_value_t = 20)]
    pub limit: usize,
    #[arg(short = 'R', long)]
    pub repo: Option<String>,
}

#[derive(Args)]
pub struct UpdateArgs {
    /// Deployment id (from `gm deploy record` or `gm deploy list`).
    pub id: u64,
    #[arg(long, value_enum)]
    pub status: Option<Status>,
    /// New URL, or an empty string to clear it (failed deployments only).
    #[arg(long)]
    pub url: Option<String>,
    /// An ISO time, a duration from now (`2d`), or `never`.
    #[arg(long)]
    pub expires: Option<String>,
    #[arg(short = 'R', long)]
    pub repo: Option<String>,
}

/// JSON for agents, a short summary for people.
pub struct Shown {
    value: Value,
    text: String,
}

impl Serialize for Shown {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        self.value.serialize(s)
    }
}

impl Render for Shown {
    fn text(&self) -> String {
        self.text.clone()
    }
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn repo_arg(ctx: &Ctx, repo: &Option<String>) -> Result<String> {
    let repo = match repo.clone().or_else(|| env("GITMATRIX_REPOSITORY")) {
        Some(repo) => repo,
        None => current_repo(ctx)?,
    };
    match repo.split_once('/') {
        Some((owner, name)) if !owner.is_empty() && !name.is_empty() && !name.contains('/') => {
            let mut path = String::from("/repos/");
            encode_into(&mut path, owner);
            path.push('/');
            encode_into(&mut path, name);
            Ok(path)
        }
        _ => Err(GmError::usage(
            "Name the repository with --repo owner/name.",
        )),
    }
}

/// An expiry for the API: an ISO time, `now + duration`, or null for `never`.
pub fn expiry(spec: &str, now: DateTime<Utc>) -> Result<Value> {
    let spec = spec.trim();
    if spec.eq_ignore_ascii_case("never") || spec.eq_ignore_ascii_case("none") {
        return Ok(Value::Null);
    }
    if let Ok(time) = DateTime::parse_from_rfc3339(spec) {
        return Ok(json!(
            time.with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Secs, true)
        ));
    }
    let unit = spec.chars().last().unwrap_or(' ');
    let amount: i64 = spec[..spec.len() - unit.len_utf8().min(spec.len())]
        .parse()
        .map_err(|_| bad_expiry(spec))?;
    let span = match unit {
        'm' => Duration::minutes(amount),
        'h' => Duration::hours(amount),
        'd' => Duration::days(amount),
        'w' => Duration::weeks(amount),
        _ => return Err(bad_expiry(spec)),
    };
    if amount <= 0 {
        return Err(bad_expiry(spec));
    }
    Ok(json!(
        (now + span).to_rfc3339_opts(SecondsFormat::Secs, true)
    ))
}

fn bad_expiry(spec: &str) -> GmError {
    GmError::usage(format!("Can't read the expiry `{spec}`.")).hint(
        "Use an ISO time (2026-10-09T12:00:00Z), a duration from now (30m, 12h, 2d, 1w) or `never`.",
    )
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}

fn line(d: &Value) -> String {
    format!(
        "#{:<5} {:<9} {:<24} {}  {}{}",
        d["id"],
        s(d, "status"),
        s(d, "environment"),
        s(d, "commit").get(..10).unwrap_or(""),
        d["url"].as_str().unwrap_or("(no url)"),
        d["run"]
            .as_i64()
            .map(|n| format!("  run #{n}"))
            .unwrap_or_default(),
    )
}

/// The CI job's own credential, when gm runs inside a job.
fn job_token() -> Option<String> {
    env("GITMATRIX_TOKEN").filter(|t| t.starts_with("gmj_"))
}

fn in_ci() -> bool {
    job_token().is_some()
}

/// Inside a CI job, act as the job even when a personal GM_TOKEN is also set,
/// so the record carries its run; elsewhere, as you.
fn call(config: &Config, method: &str, path: &str, body: Option<&Value>) -> Result<Value> {
    match job_token() {
        Some(token) => remote::api_with(config, method, path, body, Some(&token)),
        None => remote::api(config, method, path, body),
    }
}

pub fn run(ctx: &Ctx, command: &DeployCommand) -> Result<Shown> {
    let config = Config::load();
    match command {
        DeployCommand::Record(args) => record(ctx, &config, args),
        DeployCommand::List(args) => {
            let base = repo_arg(ctx, &args.repo)?;
            let mut query = format!("?limit={}", args.limit.clamp(1, 100));
            let mut add = |key: &str, value: &str| {
                query.push('&');
                query.push_str(key);
                query.push('=');
                encode_into(&mut query, value);
            };
            if let Some(e) = &args.environment {
                add("environment", e);
            }
            if let Some(t) = &args.timeline {
                add("timeline", t);
            }
            if let Some(c) = &args.commit {
                add("commit", &commit_of(ctx, c)?);
            }
            if let Some(r) = args.run {
                add("run", &r.to_string());
            }
            if let Some(st) = args.status {
                add("status", st.as_str());
            }
            let value = call(&config, "GET", &format!("{base}/deployments{query}"), None)?;
            let list = value["deployments"].as_array().cloned().unwrap_or_default();
            let text = if list.is_empty() {
                "No deployments recorded.\n".to_string()
            } else {
                list.iter().map(|d| line(d) + "\n").collect()
            };
            Ok(Shown { value, text })
        }
        DeployCommand::Update(args) => {
            let base = repo_arg(ctx, &args.repo)?;
            let mut body = Map::new();
            if let Some(st) = args.status {
                body.insert("status".into(), json!(st.as_str()));
            }
            if let Some(url) = &args.url {
                body.insert("url".into(), json!(url));
            }
            if let Some(spec) = &args.expires {
                body.insert("expiresAt".into(), expiry(spec, Utc::now())?);
            }
            if body.is_empty() {
                return Err(GmError::usage(
                    "Change something: --status, --url or --expires.",
                ));
            }
            let path = format!("{base}/deployments/{}", args.id);
            if ctx.dry_run {
                let value =
                    json!({ "dryRun": true, "method": "PATCH", "path": path, "body": body });
                return Ok(Shown {
                    text: format!(
                        "Would update deployment #{}: {}\n",
                        args.id,
                        Value::Object(body)
                    ),
                    value,
                });
            }
            let value = call(&config, "PATCH", &path, Some(&Value::Object(body)))?;
            Ok(Shown {
                text: format!("Updated {}\n", line(&value)),
                value,
            })
        }
    }
}

fn record(ctx: &Ctx, config: &Config, args: &RecordArgs) -> Result<Shown> {
    let base = repo_arg(ctx, &args.repo)?;
    let mut body = Map::new();
    let commit = match &args.commit {
        Some(spec) => Some(commit_of(ctx, spec)?),
        None => env("GITMATRIX_COMMIT"),
    };
    match commit {
        Some(commit) => {
            body.insert("commit".into(), json!(commit));
        }
        None if in_ci() => {}
        None => {
            return Err(GmError::usage(
                "Outside a CI job, name the deployed commit with --commit <revision or hash>.",
            ));
        }
    }
    let mut put = |key: &str, value: Option<String>| {
        if let Some(v) = value {
            body.insert(key.into(), json!(v));
        }
    };
    put("url", args.url.clone());
    put("environment", args.environment.clone());
    put(
        "timeline",
        args.timeline.clone().or_else(|| env("GITMATRIX_TIMELINE")),
    );
    put(
        "checkpoint",
        args.checkpoint
            .clone()
            .or_else(|| env("GITMATRIX_CHECKPOINT")),
    );
    put("status", args.status.map(|st| st.as_str().to_string()));
    if let Some(spec) = &args.expires {
        body.insert("expiresAt".into(), expiry(spec, Utc::now())?);
    }
    if args.url.is_none() && !matches!(args.status, Some(Status::Failed)) {
        return Err(GmError::usage(
            "Give the deployment's address with --url (only --status failed may omit it).",
        ));
    }
    let path = format!("{base}/deployments");
    if ctx.dry_run {
        let value = json!({ "dryRun": true, "method": "POST", "path": path, "body": body });
        return Ok(Shown {
            text: format!("Would record: {}\n", Value::Object(body)),
            value,
        });
    }
    let value = call(config, "POST", &path, Some(&Value::Object(body)))?;
    Ok(Shown {
        text: format!("Recorded {}\n", line(&value)),
        value,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_expiries() {
        let now = DateTime::parse_from_rfc3339("2026-10-03T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(expiry("never", now).unwrap(), Value::Null);
        assert_eq!(expiry("2d", now).unwrap(), json!("2026-10-05T00:00:00Z"));
        assert_eq!(expiry("90m", now).unwrap(), json!("2026-10-03T01:30:00Z"));
        assert_eq!(expiry("1w", now).unwrap(), json!("2026-10-10T00:00:00Z"));
        assert_eq!(
            expiry("2026-10-09T12:00:00+02:00", now).unwrap(),
            json!("2026-10-09T10:00:00Z")
        );
        for bad in ["", "d", "0d", "-1h", "2y", "soon", "日"] {
            assert!(expiry(bad, now).is_err(), "{bad} should not parse");
        }
    }
}
