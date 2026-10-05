//! `gm test` and `gm step` (CORE-236): a step's fast checks, run here, and a
//! step in one command.
//!
//! `gm test` runs the repository's local step jobs: the jobs in
//! `.gitmatrix/ci.yml` that join step runs (`on: step`) and say `local: true`
//! (CORE-235). Each runs its steps with bash in the checkout, in `needs` order;
//! output streams to stderr, the result goes to stdout. The results are kept
//! for the working copy's tree, so a `gm commit --context` of exactly that
//! tree carries them as the step's tests (`origin: "local"`).
//!
//! `gm step` is test + commit + context + push, in a timeline only.

use super::{Ctx, local, network, steps};
use crate::cli;
use crate::model::OpResult;
use crate::output::{GmError, Render, Result, exit, style};
use crate::repo::Workspace;
use serde_json::{Value, json};
use serde_yaml_ng::Value as Yaml;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Instant;

const CONFIG_PATH: &str = ".gitmatrix/ci.yml";

/// Environment variables, in order.
type Env = Vec<(String, String)>;

/// A local step job, as `gm test` runs it.
#[derive(Debug, Clone, PartialEq)]
pub struct LocalJob {
    pub name: String,
    pub needs: Vec<String>,
    pub env: Vec<(String, String)>,
    pub steps: Vec<String>,
}

fn names(value: Option<&Yaml>) -> Vec<String> {
    match value {
        Some(Yaml::String(s)) => vec![s.clone()],
        Some(Yaml::Sequence(items)) => items
            .iter()
            .filter_map(|i| i.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

fn env_of(value: Option<&Yaml>) -> Vec<(String, String)> {
    let Some(Yaml::Mapping(map)) = value else {
        return Vec::new();
    };
    map.iter()
        .filter_map(|(k, v)| {
            let value = match v {
                Yaml::String(s) => s.clone(),
                Yaml::Number(n) => n.to_string(),
                Yaml::Bool(b) => b.to_string(),
                _ => return None,
            };
            Some((k.as_str()?.to_string(), value))
        })
        .collect()
}

/// The local step jobs of a ci.yml, in file order, and the pipeline's env.
/// The server validates ci.yml fully on push; this reads what `gm test` needs.
pub fn local_jobs(source: &str) -> Result<(Vec<LocalJob>, Env)> {
    let doc: Yaml = serde_yaml_ng::from_str(source).map_err(|e| {
        GmError::usage(format!("{CONFIG_PATH} isn't valid YAML: {e}"))
            .hint("Fix it, then run `gm test` again.")
    })?;
    let opted_in = match doc.get("on") {
        Some(Yaml::String(s)) => s == "step",
        Some(Yaml::Sequence(items)) => items.iter().any(|i| i.as_str() == Some("step")),
        Some(Yaml::Mapping(map)) => map.contains_key("step"),
        _ => false,
    };
    let mut jobs = Vec::new();
    if let (true, Some(Yaml::Mapping(map))) = (opted_in, doc.get("jobs")) {
        for (name, job) in map {
            let Some(name) = name.as_str() else { continue };
            let on_step = names(job.get("on")).iter().any(|t| t == "step");
            let local = job.get("local").and_then(Yaml::as_bool) == Some(true);
            if !(on_step && local) {
                continue;
            }
            let steps = match job.get("steps") {
                Some(Yaml::Sequence(items)) => items
                    .iter()
                    .filter_map(|s| match s {
                        Yaml::String(run) => Some(run.clone()),
                        other => other.get("run").and_then(Yaml::as_str).map(str::to_string),
                    })
                    .collect(),
                _ => Vec::new(),
            };
            jobs.push(LocalJob {
                name: name.to_string(),
                needs: names(job.get("needs")),
                env: env_of(job.get("env")),
                steps,
            });
        }
    }
    Ok((jobs, env_of(doc.get("env"))))
}

/// One job's result.
#[derive(Clone, serde::Serialize, schemars::JsonSchema)]
pub struct JobResult {
    pub name: String,
    /// `passed`, `failed`, or `skipped` (a job it needs failed or doesn't run locally).
    pub status: String,
    /// The failing step's exit code, 0 when passed; null when skipped.
    pub exit: Option<i32>,
    pub duration_ms: u64,
    /// The last line of output, or why it was skipped.
    pub summary: String,
}

#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct Tested {
    pub jobs: Vec<JobResult>,
    pub passed: usize,
    pub failed: usize,
    /// The working copy's tree the results are for.
    pub tree: String,
    pub message: String,
}

impl Render for Tested {
    fn text(&self) -> String {
        let mut out = Vec::new();
        for job in &self.jobs {
            let mark = match job.status.as_str() {
                "passed" => style::good("✓"),
                "failed" => style::bad("✗"),
                _ => style::dim("-"),
            };
            out.push(format!(
                "{mark} {}  {}",
                job.name,
                style::dim(&format!(
                    "{:.1}s  {}",
                    job.duration_ms as f64 / 1000.0,
                    job.summary
                ))
            ));
        }
        out.push(self.message.clone());
        out.join("\n")
    }
}

/// Runs one shell step in `root`, streaming its output to stderr; the exit
/// code and the last non-empty line.
fn run_step(root: &Path, script: &str, env: &[(String, String)]) -> Result<(i32, String)> {
    let mut child = Command::new("bash")
        .args(["-eo", "pipefail", "-c", script])
        .current_dir(root)
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| GmError::new("io", format!("Couldn't start bash: {e}")))?;
    let last = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let pipes: Vec<Box<dyn std::io::Read + Send>> = vec![
        Box::new(child.stdout.take().expect("piped")),
        Box::new(child.stderr.take().expect("piped")),
    ];
    let readers: Vec<_> = pipes
        .into_iter()
        .map(|pipe| {
            let last = std::sync::Arc::clone(&last);
            std::thread::spawn(move || {
                for line in BufReader::new(pipe).lines().map_while(|l| l.ok()) {
                    let _ = writeln!(std::io::stderr(), "{line}");
                    if !line.trim().is_empty() {
                        *last.lock().expect("lock") = line.trim().to_string();
                    }
                }
            })
        })
        .collect();
    let status = child
        .wait()
        .map_err(|e| GmError::new("io", format!("Couldn't wait for bash: {e}")))?;
    for reader in readers {
        let _ = reader.join();
    }
    let summary: String = last.lock().expect("lock").chars().take(200).collect();
    Ok((status.code().unwrap_or(1), summary))
}

/// Runs the local step jobs of the checkout at `ws`, in needs order.
pub fn run(ws: &Workspace) -> Result<Tested> {
    let root = ws
        .repo
        .workdir()
        .ok_or_else(|| GmError::usage("gm test needs a checkout with files."))?
        .to_path_buf();
    let tree = ws.commit(ws.wc())?.tree_id().to_string();
    let source = std::fs::read_to_string(root.join(CONFIG_PATH)).unwrap_or_default();
    let (jobs, base_env) = local_jobs(&source)?;
    let mut results: Vec<JobResult> = Vec::new();
    let mut done: HashMap<String, bool> = HashMap::new();
    let mut left = jobs.clone();
    // needs order: a job runs once everything it needs has run here.
    while !left.is_empty() {
        let ready = left.iter().position(|job| {
            job.needs
                .iter()
                .all(|n| done.contains_key(n) || !jobs.iter().any(|j| &j.name == n))
        });
        let job = left.remove(ready.unwrap_or(0));
        let missing = job
            .needs
            .iter()
            .find(|n| !jobs.iter().any(|j| &j.name == *n));
        let failed_need = job.needs.iter().find(|n| done.get(*n) == Some(&false));
        if let Some(reason) = missing
            .map(|n| format!("needs {n}, which doesn't run locally"))
            .or_else(|| failed_need.map(|n| format!("needs {n}, which failed")))
        {
            done.insert(job.name.clone(), false);
            results.push(JobResult {
                name: job.name,
                status: "skipped".into(),
                exit: None,
                duration_ms: 0,
                summary: reason,
            });
            continue;
        }
        let mut env = base_env.clone();
        env.extend(job.env.iter().cloned());
        env.extend([
            ("GITMATRIX_TRIGGER".to_string(), "step".to_string()),
            ("GITMATRIX_LOCAL".to_string(), "1".to_string()),
            ("GITMATRIX_JOB".to_string(), job.name.clone()),
        ]);
        let _ = writeln!(std::io::stderr(), "── gm test: {}", job.name);
        let started = Instant::now();
        let mut outcome = (0, String::new());
        for script in &job.steps {
            let (code, last) = run_step(&root, script, &env)?;
            // The job's last line of output, whichever step printed it.
            outcome = (code, if last.is_empty() { outcome.1 } else { last });
            if code != 0 {
                break;
            }
        }
        let passed = outcome.0 == 0;
        done.insert(job.name.clone(), passed);
        results.push(JobResult {
            name: job.name,
            status: if passed { "passed" } else { "failed" }.into(),
            exit: Some(outcome.0),
            duration_ms: started.elapsed().as_millis() as u64,
            summary: outcome.1,
        });
    }
    let passed = results.iter().filter(|r| r.status == "passed").count();
    let failed = results.iter().filter(|r| r.status != "passed").count();
    let message = if results.is_empty() {
        format!("No local step jobs: mark step jobs in {CONFIG_PATH} with `local: true`.")
    } else if failed == 0 {
        format!("{passed} job(s) passed.")
    } else {
        format!(
            "{failed} of {} job(s) failed or were skipped.",
            results.len()
        )
    };
    let tested = Tested {
        jobs: results,
        passed,
        failed,
        tree,
        message,
    };
    steps::record_tests(ws, &tested.tree, &as_step_tests(&tested))?;
    Ok(tested)
}

/// The results as a step's tests (shared/steps.ts StepTest).
pub fn as_step_tests(tested: &Tested) -> Vec<Value> {
    tested
        .jobs
        .iter()
        .map(|job| {
            json!({
                "command": format!("gm test: {}", job.name),
                "exit": job.exit.unwrap_or(-1),
                "summary": job.summary,
                "durationMs": job.duration_ms,
                "origin": "local",
            })
        })
        .collect()
}

pub fn test(ctx: &Ctx) -> Result<Tested> {
    let ws = Workspace::open(&ctx.cwd)?;
    run(&ws)
}

// ---- gm step ----------------------------------------------------------------------

#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct Stepped {
    /// Null with --no-test.
    pub tests: Option<Tested>,
    pub commit: OpResult,
    pub push: network::Pushed,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

impl Render for Stepped {
    fn text(&self) -> String {
        let mut out = Vec::new();
        if let Some(tests) = &self.tests {
            out.push(tests.text());
        }
        out.push(self.commit.text());
        out.push(self.push.text());
        for warning in &self.warnings {
            out.push(format!("warning: {warning}"));
        }
        out.join("\n")
    }
}

pub fn step(ctx: &Ctx, args: &cli::StepArgs) -> Result<Stepped> {
    let ws = Workspace::open(&ctx.cwd)?;
    if ws.timeline.is_none() {
        return Err(GmError::new(
            "not_in_timeline",
            "gm step records a step of a timeline, and this checkout isn't working in one.",
        )
        .hint("Start one with `gm timeline start <slug>` or join one with `gm timeline use <slug>`; outside a timeline, use `gm commit` and `gm push`.")
        .exit(exit::USAGE));
    }
    // Read the context first: a bad file fails before tests run or anything changes.
    let context = match &args.context {
        Some(arg) => Some(steps::parse_context(&steps::read_context_arg(arg)?)?),
        None => None,
    };
    let tests = if args.no_test || ctx.dry_run {
        None
    } else {
        Some(run(&ws)?)
    };
    drop(ws);
    let mut warnings = Vec::new();
    if let Some(t) = &tests
        && t.failed > 0
    {
        warnings.push(format!(
            "{} test job(s) failed or were skipped; the step records them.",
            t.failed
        ));
    }
    // With no context file, the step still carries its tests and what a hook captured.
    let context = context.or_else(|| Some(json!({})));
    let commit = local::commit_with(
        ctx,
        &cli::CommitArgs {
            message: args.message.clone(),
            paths: Vec::new(),
            context: None,
        },
        context,
        args.context.is_none(),
    )?;
    let push = network::push(
        ctx,
        &cli::PushArgs {
            revision: None,
            bookmark: None,
            sync: false,
            queue: false,
            issues: Vec::new(),
        },
    )?;
    Ok(Stepped {
        tests,
        commit,
        push,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_local_step_jobs_of_an_opted_in_pipeline() {
        let yml = "on:\n  push: {}\n  step: {}\nenv:\n  MODE: fast\njobs:\n  lint:\n    on: step\n    local: true\n    env: { STRICT: 1 }\n    steps:\n      - name: Check\n        run: vp check\n  unit:\n    on: [push, step]\n    local: true\n    needs: lint\n    steps: [vp test run]\n  remote:\n    on: step\n    steps: [deploy]\n  build:\n    steps: [vp build]\n";
        let (jobs, env) = local_jobs(yml).unwrap();
        assert_eq!(env, vec![("MODE".to_string(), "fast".to_string())]);
        assert_eq!(
            jobs,
            vec![
                LocalJob {
                    name: "lint".into(),
                    needs: vec![],
                    env: vec![("STRICT".into(), "1".into())],
                    steps: vec!["vp check".into()],
                },
                LocalJob {
                    name: "unit".into(),
                    needs: vec!["lint".into()],
                    env: vec![],
                    steps: vec!["vp test run".into()],
                },
            ]
        );
        // Not opted in: nothing runs locally, whatever the jobs say.
        let (jobs, _) =
            local_jobs("jobs:\n  lint:\n    on: step\n    local: true\n    steps: [x]\n").unwrap();
        assert!(jobs.is_empty());
        assert!(local_jobs("jobs: [").is_err());
    }
}
