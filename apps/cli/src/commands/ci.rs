//! CI/CD: pipeline runs on the server, their logs, repository secrets, and
//! `gm runner`, which executes queued jobs on this machine (the dev server
//! queues jobs for local runners instead of starting Cloudflare Sandboxes).

use super::Ctx;
use super::server::current_repo;
use crate::cli::{RunnerArgs, RunsCommand, SecretCommand};
use crate::output::{GmError, Render, Result, exit};
use crate::remote::{self, Config};
use crate::repo::{Workspace, revset};
use serde::{Serialize, Serializer};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// JSON for agents, a purpose-made text rendering for people.
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

const TERMINAL: &[&str] = &["succeeded", "failed", "cancelled", "skipped"];
const SETUP_STEP: i64 = -1;

fn repo_arg(ctx: &Ctx, repo: &Option<String>) -> Result<String> {
    match repo {
        Some(r) => Ok(r.clone()),
        None => current_repo(ctx),
    }
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}

fn icon(status: &str) -> &'static str {
    match status {
        "succeeded" => "✓",
        "failed" => "✗",
        "cancelled" => "⊘",
        "skipped" => "-",
        "running" => "●",
        _ => "○",
    }
}

fn run_line(run: &Value) -> String {
    format!(
        "{} #{:<4} {:<10} {:<16} {}  {}",
        icon(s(run, "status")),
        run["number"],
        s(run, "status"),
        s(run, "ref"),
        s(run, "commit").get(..10).unwrap_or(""),
        s(run, "title"),
    )
}

fn detail_text(run: &Value) -> String {
    let mut out = format!(
        "Run #{} {} — {} on {} ({})\n{}\n",
        run["number"],
        s(run, "status"),
        s(run, "trigger"),
        s(run, "ref"),
        s(run, "commit").get(..12).unwrap_or(""),
        s(run, "title"),
    );
    if let Some(error) = run["configError"].as_str() {
        out.push_str(&format!("\nConfiguration error: {error}\n"));
    }
    for job in run["jobs"].as_array().into_iter().flatten() {
        out.push_str(&format!(
            "\n{} {} ({}{})\n",
            icon(s(job, "status")),
            s(job, "name"),
            s(job, "status"),
            job["claimedBy"]
                .as_str()
                .map(|c| format!(", on {c}"))
                .unwrap_or_default(),
        ));
        if let Some(error) = job["error"].as_str() {
            out.push_str(&format!("    {error}\n"));
        }
        for step in job["steps"].as_array().into_iter().flatten() {
            out.push_str(&format!(
                "    {} {}{}\n",
                icon(s(step, "status")),
                s(step, "name"),
                step["exitCode"]
                    .as_i64()
                    .filter(|c| *c != 0)
                    .map(|c| format!(" (exit {c})"))
                    .unwrap_or_default(),
            ));
        }
    }
    out
}

fn latest_run(config: &Config, repo: &str) -> Result<Value> {
    let list = remote::api(config, "GET", &format!("/repos/{repo}/ci"), None)?;
    list["runs"].get(0).cloned().ok_or_else(|| {
        GmError::not_found("no_runs", format!("{repo} has no CI runs yet."))
            .hint("Add .gitmatrix/ci.yml and push, or `gm runs start`.")
    })
}

fn run_detail(config: &Config, repo: &str, number: i64) -> Result<Value> {
    remote::api(
        config,
        "GET",
        &format!("/repos/{repo}/ci/runs/{number}"),
        None,
    )
}

fn number_or_latest(config: &Config, repo: &str, number: Option<i64>) -> Result<i64> {
    match number {
        Some(n) => Ok(n),
        None => Ok(latest_run(config, repo)?["number"].as_i64().unwrap_or(0)),
    }
}

/// A commit id from a revision in the local workspace, or a full hash as is.
fn commit_of(ctx: &Ctx, spec: &str) -> Result<String> {
    if spec.len() == 40 && spec.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(spec.to_string());
    }
    let ws = Workspace::open(&ctx.cwd)?;
    let oid = revset::resolve(&ws, spec)?;
    Ok(oid.to_string())
}

pub fn runs(ctx: &Ctx, command: &RunsCommand) -> Result<Shown> {
    let config = Config::load();
    match command {
        RunsCommand::List { repo, limit } => {
            let repo = repo_arg(ctx, repo)?;
            let mut list = remote::api(&config, "GET", &format!("/repos/{repo}/ci"), None)?;
            if let Some(runs) = list["runs"].as_array_mut() {
                runs.truncate(*limit);
            }
            let text = match list["runs"].as_array() {
                Some(runs) if !runs.is_empty() => {
                    runs.iter().map(run_line).collect::<Vec<_>>().join("\n")
                }
                _ => format!("No runs yet for {repo}."),
            };
            Ok(Shown { value: list, text })
        }
        RunsCommand::Show { number, repo } => {
            let repo = repo_arg(ctx, repo)?;
            let number = number_or_latest(&config, &repo, *number)?;
            let run = run_detail(&config, &repo, number)?;
            Ok(Shown {
                text: detail_text(&run),
                value: run,
            })
        }
        RunsCommand::Logs {
            number,
            job,
            repo,
            follow,
        } => {
            let repo = repo_arg(ctx, repo)?;
            let number = number_or_latest(&config, &repo, *number)?;
            logs(ctx, &config, &repo, number, job.as_deref(), *follow)
        }
        RunsCommand::Wait {
            number,
            commit,
            repo,
            timeout,
        } => {
            let repo = repo_arg(ctx, repo)?;
            wait(ctx, &config, &repo, *number, commit.as_deref(), *timeout)
        }
        RunsCommand::Start { r#ref, repo } => {
            let repo = repo_arg(ctx, repo)?;
            let body = json!({ "ref": r#ref });
            if ctx.dry_run {
                return Ok(Shown {
                    text: format!(
                        "Would start a run of {repo} on {}.",
                        r#ref.as_deref().unwrap_or("the default branch")
                    ),
                    value: json!({ "dry_run": true, "repo": repo, "request": body }),
                });
            }
            let started = remote::api(
                &config,
                "POST",
                &format!("/repos/{repo}/ci/runs"),
                Some(&body),
            )?;
            Ok(Shown {
                text: format!(
                    "Started run #{}. Follow it with `gm runs wait {}`.",
                    started["number"], started["number"]
                ),
                value: started,
            })
        }
        RunsCommand::Cancel { number, repo } => {
            let repo = repo_arg(ctx, repo)?;
            if ctx.dry_run {
                return Ok(Shown {
                    text: format!("Would cancel run #{number}."),
                    value: json!({ "dry_run": true, "cancel": number }),
                });
            }
            remote::api(
                &config,
                "POST",
                &format!("/repos/{repo}/ci/runs/{number}/cancel"),
                None,
            )?;
            Ok(Shown {
                text: format!("Cancelled run #{number}."),
                value: json!({ "cancelled": number }),
            })
        }
        RunsCommand::Rerun { number, repo } => {
            let repo = repo_arg(ctx, repo)?;
            if ctx.dry_run {
                return Ok(Shown {
                    text: format!("Would re-run #{number}."),
                    value: json!({ "dry_run": true, "rerun": number }),
                });
            }
            let started = remote::api(
                &config,
                "POST",
                &format!("/repos/{repo}/ci/runs/{number}/rerun"),
                None,
            )?;
            Ok(Shown {
                text: format!("Started run #{} (re-run of #{number}).", started["number"]),
                value: started,
            })
        }
    }
}

/// Every log chunk of a job after `after`.
fn job_logs(config: &Config, repo: &str, job: &str, after: i64) -> Result<(Vec<Value>, i64, bool)> {
    let mut chunks = Vec::new();
    let mut next = after;
    loop {
        let page = remote::api(
            config,
            "GET",
            &format!("/repos/{repo}/ci/jobs/{job}/logs?after={next}"),
            None,
        )?;
        let got = page["chunks"].as_array().cloned().unwrap_or_default();
        next = page["next"].as_i64().unwrap_or(next);
        let done = page["done"].as_bool().unwrap_or(true);
        let full = got.len() >= 500;
        chunks.extend(got);
        if !full {
            return Ok((chunks, next, done));
        }
    }
}

fn step_name(job: &Value, step: i64) -> String {
    if step == SETUP_STEP {
        return "Set up".into();
    }
    job["steps"]
        .as_array()
        .and_then(|steps| steps.iter().find(|s| s["position"].as_i64() == Some(step)))
        .map(|s| s["name"].as_str().unwrap_or("").to_string())
        .unwrap_or_else(|| format!("step {step}"))
}

/// Terminal output without escape sequences (colors, cursor moves, titles).
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.next() {
            // CSI: parameters, then one final byte in @..~.
            Some('[') => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            // OSC: up to BEL or ESC \.
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\x07' || (c == '\x1b' && chars.next_if_eq(&'\\').is_some()) {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// Text of chunks with a header whenever the step changes.
fn render_chunks(
    job: &Value,
    chunks: &[Value],
    last_step: &mut Option<i64>,
    color: bool,
) -> String {
    let mut out = String::new();
    for chunk in chunks {
        let step = chunk["step"].as_i64().unwrap_or(0);
        if *last_step != Some(step) {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(&format!(
                "── {} / {}\n",
                s(job, "name"),
                step_name(job, step)
            ));
            *last_step = Some(step);
        }
        let text = chunk["text"].as_str().unwrap_or("");
        out.push_str(&if color {
            text.to_string()
        } else {
            strip_ansi(text)
        });
    }
    out
}

fn logs(
    ctx: &Ctx,
    config: &Config,
    repo: &str,
    number: i64,
    only: Option<&str>,
    follow: bool,
) -> Result<Shown> {
    let run = run_detail(config, repo, number)?;
    let jobs: Vec<Value> = run["jobs"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|j| only.is_none_or(|name| s(j, "name") == name))
        .collect();
    if jobs.is_empty() {
        return Err(match only {
            Some(name) => {
                GmError::not_found("no_such_job", format!("Run #{number} has no job `{name}`."))
            }
            None => GmError::not_found("no_jobs", format!("Run #{number} has no jobs.")),
        });
    }
    let streaming = follow && ctx.format == crate::output::Format::Text;
    // Keep colors only for a person at a terminal.
    let color = std::io::stdout().is_terminal();
    let mut value = Vec::new();
    let mut text = String::new();
    for job in &jobs {
        let id = s(job, "id").to_string();
        let mut last_step = None;
        let (mut chunks, mut next, mut done) = job_logs(config, repo, &id, 0)?;
        if streaming {
            print!("{}", render_chunks(job, &chunks, &mut last_step, color));
            let _ = std::io::stdout().flush();
            while !done {
                std::thread::sleep(Duration::from_millis(1000));
                let (more, n, d) = job_logs(config, repo, &id, next)?;
                // Step names may have changed state; refresh the job for headers.
                print!("{}", render_chunks(job, &more, &mut last_step, color));
                let _ = std::io::stdout().flush();
                chunks.extend(more);
                next = n;
                done = d;
            }
        } else {
            text.push_str(&render_chunks(job, &chunks, &mut last_step, color));
            if !text.ends_with('\n') {
                text.push('\n');
            }
        }
        let log = strip_ansi(
            &chunks
                .iter()
                .map(|c| c["text"].as_str().unwrap_or(""))
                .collect::<String>(),
        );
        value.push(
            json!({ "job": s(job, "name"), "status": s(job, "status"), "done": done, "log": log }),
        );
    }
    Ok(Shown {
        value: json!({ "run": number, "jobs": value }),
        text: if streaming { String::new() } else { text },
    })
}

fn wait(
    ctx: &Ctx,
    config: &Config,
    repo: &str,
    number: Option<i64>,
    commit: Option<&str>,
    timeout: u64,
) -> Result<Shown> {
    let deadline = Instant::now() + Duration::from_secs(timeout);
    let progress = ctx.format == crate::output::Format::Text || std::io::stderr().is_terminal();
    // Find the run: by number, or the newest run for a commit (default: trunk),
    // which may take a moment to appear after a push.
    let number = match number {
        Some(n) => n,
        None => {
            let spec = commit.unwrap_or("trunk");
            let sha = match commit_of(ctx, spec) {
                Ok(sha) => Some(sha),
                Err(_) if commit.is_none() => None,
                Err(e) => return Err(e),
            };
            match sha {
                None => number_or_latest(config, repo, None)?,
                Some(sha) => {
                    let started = Instant::now();
                    loop {
                        let statuses = remote::api(
                            config,
                            "GET",
                            &format!("/repos/{repo}/ci/status?commits={sha}"),
                            None,
                        )?;
                        if let Some(n) = statuses[&sha]["number"].as_i64() {
                            break n;
                        }
                        if started.elapsed() > Duration::from_secs(30) || Instant::now() > deadline
                        {
                            return Err(GmError::not_found(
                                "no_run",
                                format!("No CI run started for {}.", &sha[..12]),
                            )
                            .hint("Is there a .gitmatrix/ci.yml, and does on.push.branches include this branch? `gm runs list` shows recent runs."));
                        }
                        std::thread::sleep(Duration::from_secs(1));
                    }
                }
            }
        }
    };

    let mut seen: HashMap<String, String> = HashMap::new();
    loop {
        let run = run_detail(config, repo, number)?;
        if progress {
            for job in run["jobs"].as_array().into_iter().flatten() {
                let (name, status) = (s(job, "name").to_string(), s(job, "status").to_string());
                if seen.get(&name) != Some(&status) {
                    eprintln!("{} #{number} {name}: {status}", icon(&status));
                    seen.insert(name, status);
                }
            }
        }
        let status = s(&run, "status").to_string();
        if TERMINAL.contains(&status.as_str()) {
            if status == "succeeded" {
                return Ok(Shown {
                    text: detail_text(&run),
                    value: run,
                });
            }
            let failed: Vec<&str> = run["jobs"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|j| s(j, "status") == "failed")
                .map(|j| s(j, "name"))
                .collect();
            let mut error = GmError::new(
                if status == "cancelled" {
                    "run_cancelled"
                } else {
                    "run_failed"
                },
                format!(
                    "Run #{number} {status}{}.",
                    if failed.is_empty() {
                        String::new()
                    } else {
                        format!(": {}", failed.join(", "))
                    }
                ),
            );
            if let Some(job) = failed.first() {
                error = error.hint(format!(
                    "Read the output with `gm runs logs {number} --job {job}`."
                ));
            } else if let Some(config_error) = run["configError"].as_str() {
                error = error.hint(config_error.to_string());
            }
            return Err(error.exit(exit::CONFLICT));
        }
        if Instant::now() > deadline {
            return Err(GmError::new(
                "timeout",
                format!("Run #{number} is still {status} after {timeout}s."),
            )
            .hint(format!("Keep waiting with `gm runs wait {number}`.")));
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

pub fn secret(ctx: &Ctx, command: &SecretCommand) -> Result<Shown> {
    let config = Config::load();
    match command {
        SecretCommand::List { repo } => {
            let repo = repo_arg(ctx, repo)?;
            let list = remote::api(&config, "GET", &format!("/repos/{repo}/ci/secrets"), None)?;
            let text = match list.as_array() {
                Some(items) if !items.is_empty() => items
                    .iter()
                    .map(|i| format!("{}  (updated {})", s(i, "name"), s(i, "updatedAt")))
                    .collect::<Vec<_>>()
                    .join("\n"),
                _ => format!("{repo} has no secrets."),
            };
            Ok(Shown {
                value: json!({ "secrets": list }),
                text,
            })
        }
        SecretCommand::Set { name, value, repo } => {
            let repo = repo_arg(ctx, repo)?;
            let value = match value {
                Some(v) => v.clone(),
                None => {
                    let mut buffer = String::new();
                    std::io::stdin().read_to_string(&mut buffer)?;
                    buffer.trim_end_matches(['\n', '\r']).to_string()
                }
            };
            if value.is_empty() {
                return Err(GmError::usage(
                    "Give the secret a value with --value, or pipe it on stdin.",
                ));
            }
            if ctx.dry_run {
                return Ok(Shown {
                    text: format!("Would set {name} on {repo}."),
                    value: json!({ "dry_run": true, "secret": name }),
                });
            }
            remote::api(
                &config,
                "PUT",
                &format!("/repos/{repo}/ci/secrets/{name}"),
                Some(&json!({ "value": value })),
            )?;
            Ok(Shown {
                text: format!(
                    "Set {name} on {repo}. Jobs get it when they list it under `secrets:`."
                ),
                value: json!({ "set": name }),
            })
        }
        SecretCommand::Delete { name, repo } => {
            let repo = repo_arg(ctx, repo)?;
            if ctx.dry_run {
                return Ok(Shown {
                    text: format!("Would delete {name} from {repo}."),
                    value: json!({ "dry_run": true, "delete": name }),
                });
            }
            remote::api(
                &config,
                "DELETE",
                &format!("/repos/{repo}/ci/secrets/{name}"),
                None,
            )?;
            Ok(Shown {
                text: format!("Deleted {name} from {repo}."),
                value: json!({ "deleted": name }),
            })
        }
    }
}

// ---- the local runner -------------------------------------------------------

fn runner_dir(args: &RunnerArgs) -> PathBuf {
    args.workdir.clone().unwrap_or_else(|| {
        std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
            .unwrap_or_else(std::env::temp_dir)
            .join("gitmatrix")
            .join("runner")
    })
}

fn default_name() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|h| h.trim().to_string())
        })
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "local".into())
}

/// Sends output and step changes to the server in batches.
struct Reporter<'a> {
    config: &'a Config,
    job: String,
    pending: Vec<Value>,
    last_flush: Instant,
    cancelled: bool,
}

impl Reporter<'_> {
    fn send(&mut self, mut body: Value) -> Result<()> {
        let logs = std::mem::take(&mut self.pending);
        if !logs.is_empty() {
            body["logs"] = Value::Array(logs);
        }
        self.last_flush = Instant::now();
        let response = remote::api(
            self.config,
            "POST",
            &format!("/ci/runner/jobs/{}", self.job),
            Some(&body),
        )?;
        if response["cancelled"].as_bool() == Some(true) {
            self.cancelled = true;
        }
        Ok(())
    }
    fn log(&mut self, step: i64, text: String) {
        if let Some(last) = self.pending.last_mut()
            && last["step"].as_i64() == Some(step)
        {
            let joined = format!("{}{}", last["text"].as_str().unwrap_or(""), text);
            last["text"] = Value::String(joined);
        } else {
            self.pending.push(json!({ "step": step, "text": text }));
        }
    }
    fn tick(&mut self) -> Result<()> {
        let size: usize = self
            .pending
            .iter()
            .map(|p| p["text"].as_str().map_or(0, str::len))
            .sum();
        if !self.pending.is_empty()
            && (self.last_flush.elapsed() > Duration::from_secs(1) || size > 32 * 1024)
        {
            self.send(json!({}))?;
        }
        Ok(())
    }
}

enum Ended {
    Exit(i32),
    TimedOut,
    Cancelled,
}

/// Run one script with bash, streaming combined output to the reporter.
fn execute(
    reporter: &mut Reporter,
    step: i64,
    script: &str,
    cwd: &Path,
    env: &serde_json::Map<String, Value>,
    deadline: Instant,
    echo: bool,
) -> Result<Ended> {
    use std::os::unix::process::CommandExt;
    let (reader, writer) = std::io::pipe()?;
    let mut command = Command::new("bash");
    command
        .args(["-eo", "pipefail", "-c", script])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(writer.try_clone()?)
        .stderr(writer)
        // Its own process group, so a kill reaches everything it started.
        .process_group(0);
    for (key, value) in env {
        command.env(key, value.as_str().unwrap_or(""));
    }
    let mut child = command.spawn()?;
    drop(command);

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let pump = std::thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0u8; 8192];
        while let Ok(n) = reader.read(&mut buffer) {
            if n == 0 || tx.send(buffer[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    // Signal the whole process group (`--`, or procps reads `-<pgid>` as an option).
    let kill = |signal: &str, pid: u32| {
        let _ = Command::new("kill")
            .args([signal, "--", &format!("-{pid}")])
            .status();
    };
    let mut ended: Option<Ended> = None;
    let mut status = None;
    let mut stopping: Option<Instant> = None;
    loop {
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes).into_owned();
                if echo {
                    eprint!("{text}");
                }
                reporter.log(step, text);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if status.is_none() {
            status = child.try_wait()?;
        }
        reporter.tick()?;
        if ended.is_none() && reporter.cancelled {
            ended = Some(Ended::Cancelled);
            kill("-TERM", child.id());
            stopping = Some(Instant::now());
        }
        if ended.is_none() && Instant::now() > deadline {
            reporter.log(step, "\n[gitmatrix] Timed out; stopping.\n".into());
            ended = Some(Ended::TimedOut);
            kill("-TERM", child.id());
            stopping = Some(Instant::now());
        }
        // Whatever ignores SIGTERM for 10s gets SIGKILL.
        if stopping.is_some_and(|at| at.elapsed() > Duration::from_secs(10)) {
            kill("-KILL", child.id());
            stopping = None;
        }
    }
    let _ = pump.join();
    let status = match status {
        Some(s) => s,
        None => child.wait()?,
    };
    Ok(ended.unwrap_or(Ended::Exit(status.code().unwrap_or(128))))
}

fn run_job(config: &Config, job: &Value, root: &Path, echo: bool) -> Result<&'static str> {
    let id = s(job, "id").to_string();
    let mut reporter = Reporter {
        config,
        job: id.clone(),
        pending: Vec::new(),
        last_flush: Instant::now(),
        cancelled: false,
    };
    let deadline =
        Instant::now() + Duration::from_secs(job["timeoutMinutes"].as_u64().unwrap_or(20) * 60);
    let dir = root.join(&id);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let checkout = dir.join("repo");

    let outcome = (|| -> Result<(&'static str, Option<i32>, Option<String>)> {
        reporter.log(
            SETUP_STEP,
            format!(
                "Running on {} (local runner)\nChecking out {} at {}…\n",
                default_name(),
                s(job, "ref"),
                &s(job, "commit")[..12.min(s(job, "commit").len())]
            ),
        );
        let url = format!("{}/{}.git", config.server(), s(job, "repo"));
        let clone = remote::git(
            config,
            &dir,
            &[
                "clone",
                "--quiet",
                "--depth",
                "50",
                "--single-branch",
                "--branch",
                s(job, "ref"),
                &url,
                "repo",
            ],
        )?;
        let commit = s(job, "commit");
        let checked_out = clone.status.success()
            && (remote::git(config, &checkout, &["checkout", "--quiet", commit])?
                .status
                .success()
                || (remote::git(
                    config,
                    &checkout,
                    &["fetch", "--quiet", "--depth", "1", "origin", commit],
                )?
                .status
                .success()
                    && remote::git(config, &checkout, &["checkout", "--quiet", commit])?
                        .status
                        .success()));
        if !checked_out {
            reporter.log(
                SETUP_STEP,
                String::from_utf8_lossy(&clone.stderr).into_owned(),
            );
            return Ok(("failed", None, Some("Checkout failed.".into())));
        }
        let empty = serde_json::Map::new();
        let env = job["env"].as_object().unwrap_or(&empty);
        for step in job["steps"].as_array().into_iter().flatten() {
            let position = step["position"].as_i64().unwrap_or(0);
            if echo {
                eprintln!("── {} / {}", s(job, "name"), s(step, "name"));
            }
            reporter.send(json!({ "steps": [{ "position": position, "status": "running" }] }))?;
            if reporter.cancelled {
                return Ok(("cancelled", None, None));
            }
            match execute(
                &mut reporter,
                position,
                s(step, "run"),
                &checkout,
                env,
                deadline,
                echo,
            )? {
                Ended::Exit(0) => {
                    reporter.send(json!({ "steps": [{ "position": position, "status": "succeeded", "exitCode": 0 }] }))?;
                }
                Ended::Exit(code) => {
                    reporter.send(json!({ "steps": [{ "position": position, "status": "failed", "exitCode": code }] }))?;
                    return Ok((
                        "failed",
                        Some(code),
                        Some(format!("{} exited with {code}.", s(step, "name"))),
                    ));
                }
                Ended::TimedOut => {
                    return Ok(("failed", Some(124), Some("The job timed out.".into())));
                }
                Ended::Cancelled => return Ok(("cancelled", None, None)),
            }
        }
        Ok(("succeeded", Some(0), None))
    })();

    let (status, code, error) = match outcome {
        Ok(result) => result,
        Err(e) => (
            "failed",
            None,
            Some(format!("The runner failed: {}", e.message)),
        ),
    };
    reporter.send(json!({ "done": { "status": status, "exitCode": code, "error": error } }))?;
    let _ = std::fs::remove_dir_all(&dir);
    Ok(status)
}

pub fn runner(ctx: &Ctx, args: &RunnerArgs) -> Result<Shown> {
    let config = Config::load();
    if config.token().is_none() && !config.uses_ssh() {
        return Err(
            GmError::new("unauthenticated", "The runner needs to sign in.")
                .hint("`gm auth login --persona <name>` (dev) or `gm auth login --token gmx_…`.")
                .exit(exit::AUTH),
        );
    }
    let root = runner_dir(args);
    std::fs::create_dir_all(&root)?;
    let name = args.name.clone().unwrap_or_else(default_name);
    let text = ctx.format == crate::output::Format::Text;
    let echo = text && args.verbose;
    if text {
        eprintln!(
            "gm runner `{name}` waiting for jobs on {}{}. Ctrl-C to stop.",
            config.server(),
            args.repo
                .as_ref()
                .map(|r| format!(" ({r})"))
                .unwrap_or_default()
        );
    }
    let mut ran = Vec::new();
    loop {
        let claimed = remote::api(
            &config,
            "POST",
            "/ci/runner/claim",
            Some(&json!({ "name": name, "repo": args.repo })),
        );
        let job = match claimed {
            Ok(Value::Null) => None,
            Ok(job) => Some(job),
            // Keep serving through a dev-server restart.
            Err(e) if e.code == "server_unreachable" && !args.once => {
                std::thread::sleep(Duration::from_secs(args.poll.max(1)));
                continue;
            }
            Err(e) => return Err(e),
        };
        match job {
            Some(job) => {
                let label = format!(
                    "{} #{} {}",
                    s(&job, "repo"),
                    job["runNumber"],
                    s(&job, "name")
                );
                if text {
                    eprintln!("● {label}");
                }
                let status = run_job(&config, &job, &root, echo)?;
                let result = json!({ "repo": s(&job, "repo"), "run": job["runNumber"], "job": s(&job, "name"), "status": status });
                if text {
                    eprintln!("{} {label}: {status}", icon(status));
                } else if !args.once {
                    // A long-running runner reports each job as one JSON line.
                    println!("{result}");
                }
                ran.push(result);
                if args.once {
                    break;
                }
            }
            None if args.once => break,
            None => std::thread::sleep(Duration::from_secs(args.poll.max(1))),
        }
    }
    Ok(Shown {
        text: if ran.is_empty() {
            "No queued jobs.".into()
        } else {
            String::new()
        },
        value: json!({ "jobs": ran }),
    })
}

#[cfg(test)]
mod tests {
    use super::strip_ansi;

    #[test]
    fn strips_escape_sequences() {
        assert_eq!(strip_ansi("\x1b[32mok\x1b[0m done"), "ok done");
        assert_eq!(strip_ansi("\x1b[38;2;225;80;80;1m×\x1b[0m x"), "× x");
        assert_eq!(strip_ansi("\x1b]0;title\x07plain"), "plain");
        assert_eq!(strip_ansi("no escapes"), "no escapes");
    }
}
