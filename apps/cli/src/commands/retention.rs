//! Data retention (CORE-195): an account's or the site's retention policies and
//! cleanup runs, the same API the Data retention settings pages use.
//!
//! Account level: `/accounts/<owner>/settings/retention` and
//! `/accounts/<owner>/retention/runs`; site level (`--site`, site
//! administrators): `/admin/retention` and `/admin/retention/runs`.

use super::Ctx;
use crate::output::{GmError, Render, Result, exit};
use crate::remote::{self, Acting, Config};
use clap::{Args, Subcommand};
use serde::{Serialize, Serializer};
use serde_json::{Map, Value, json};
use std::io::IsTerminal;
use std::time::{Duration, Instant};

#[derive(Subcommand)]
pub enum RetentionCommand {
    /// Categories with their scope, switch, effective thresholds (and where each comes from) and last run
    Show {
        /// Only this category (e.g. ci-logs).
        category: Option<String>,
        #[command(flatten)]
        level: Level,
    },
    /// Enable, disable or reset a category, or change its thresholds (account owners or site administrators)
    Set(SetArgs),
    /// Clean up now: run categories (add --dry-run to preview what would be deleted), then wait for the result
    Run(RunArgs),
    /// Cleanup run history, newest first, or one run with each category's counts
    Runs {
        /// One run's id; omit to list runs.
        id: Option<u64>,
        /// List runs older than this id (the `next` of the previous page).
        #[arg(long, conflicts_with = "id")]
        before: Option<u64>,
        /// At most this many runs.
        #[arg(long, conflicts_with = "id")]
        limit: Option<u64>,
        #[command(flatten)]
        level: Level,
    },
}

/// Whose retention: an account's (default: the signed-in person) or the site's.
#[derive(Args, Clone, Default)]
pub struct Level {
    /// Account slug; defaults to the signed-in person, never the repository owner.
    #[arg(long, value_parser = account_slug, conflicts_with = "site")]
    owner: Option<String>,
    /// The site level: site categories and site-wide defaults (site administrators).
    #[arg(long)]
    site: bool,
}

#[derive(Args)]
#[command(group(clap::ArgGroup::new("retention_changes").required(true).multiple(true).args([
    "enable", "disable", "inherit", "threshold", "reset"
])))]
pub struct SetArgs {
    /// Category id, e.g. ci-logs (see `gm retention show`).
    category: String,
    /// Turn the category on: scheduled cleanups delete what its policy selects.
    #[arg(long, conflicts_with_all = ["disable", "inherit"])]
    enable: bool,
    /// Turn the category off at this level.
    #[arg(long, conflicts_with = "inherit")]
    disable: bool,
    /// Remove this level's switch, so it inherits (site-wide default, then off).
    #[arg(long)]
    inherit: bool,
    /// Set a threshold: key=value, a whole number (repeatable), e.g. days=60.
    #[arg(long, value_name = "KEY=VALUE", value_parser = threshold)]
    threshold: Vec<(String, i64)>,
    /// Remove this level's value for a threshold, so it inherits (repeatable).
    #[arg(long, value_name = "KEY")]
    reset: Vec<String>,
    #[command(flatten)]
    level: Level,
}

#[derive(Args)]
pub struct RunArgs {
    /// Category ids to clean up (any with a cleanup, enabled or not).
    #[arg(required = true)]
    categories: Vec<String>,
    /// Override a threshold for this run only: category.key=value (repeatable), e.g. ci-logs.days=7.
    #[arg(long, value_name = "CATEGORY.KEY=VALUE", value_parser = run_threshold)]
    threshold: Vec<(String, String, i64)>,
    /// Required for a real run (not --dry-run): confirms deleting what the policy selects.
    #[arg(long)]
    yes: bool,
    /// Return the queued run at once instead of waiting for it to finish.
    #[arg(long)]
    no_wait: bool,
    /// Give up waiting after this many seconds (the run keeps going).
    #[arg(long, default_value_t = 900)]
    timeout: u64,
    #[command(flatten)]
    level: Level,
}

fn account_slug(value: &str) -> std::result::Result<String, String> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("Use an account slug, not a repository or URL.".into());
    }
    Ok(value.to_string())
}

fn number(key: &str, value: &str) -> std::result::Result<i64, String> {
    value
        .trim()
        .parse::<i64>()
        .map_err(|_| format!("{key} must be a whole number, not `{value}`."))
}

fn threshold(value: &str) -> std::result::Result<(String, i64), String> {
    let (key, raw) = value
        .split_once('=')
        .ok_or_else(|| format!("Write a threshold as key=value (e.g. days=60), not `{value}`."))?;
    if key.is_empty() {
        return Err(format!("`{value}` names no threshold."));
    }
    Ok((key.to_string(), number(key, raw)?))
}

fn run_threshold(value: &str) -> std::result::Result<(String, String, i64), String> {
    let (key, raw) = value.split_once('=').ok_or_else(|| {
        format!("Write a run threshold as category.key=value (e.g. ci-logs.days=7), not `{value}`.")
    })?;
    let (category, name) = key
        .split_once('.')
        .filter(|(c, n)| !c.is_empty() && !n.is_empty())
        .ok_or_else(|| {
            format!(
                "Name the category and threshold as category.key (e.g. ci-logs.days), not `{key}`."
            )
        })?;
    Ok((category.to_string(), name.to_string(), number(key, raw)?))
}

impl SetArgs {
    /// The PATCH body: `{categories: {<id>: {enabled?, thresholds?}}}`; null inherits.
    fn patch(&self) -> Value {
        let mut change = Map::new();
        if self.enable {
            change.insert("enabled".into(), json!(true));
        } else if self.disable {
            change.insert("enabled".into(), json!(false));
        } else if self.inherit {
            change.insert("enabled".into(), Value::Null);
        }
        let mut thresholds = Map::new();
        for key in &self.reset {
            thresholds.insert(key.clone(), Value::Null);
        }
        for (key, value) in &self.threshold {
            thresholds.insert(key.clone(), json!(value));
        }
        if !thresholds.is_empty() {
            change.insert("thresholds".into(), Value::Object(thresholds));
        }
        json!({ "categories": { self.category.clone(): change } })
    }
}

impl RunArgs {
    /// The POST body: `{dryRun, categories, thresholds?}`.
    fn request(&self, dry_run: bool) -> Result<Value> {
        let mut thresholds: Map<String, Value> = Map::new();
        for (category, key, value) in &self.threshold {
            if !self.categories.contains(category) {
                return Err(GmError::usage(format!(
                    "--threshold {category}.{key} names {category}, which isn't one of the categories to run."
                )));
            }
            thresholds
                .entry(category.clone())
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .expect("an object")
                .insert(key.clone(), json!(value));
        }
        let mut body = json!({ "dryRun": dry_run, "categories": self.categories });
        if !thresholds.is_empty() {
            body["thresholds"] = Value::Object(thresholds);
        }
        Ok(body)
    }
}

/// Where a level's settings and runs live in the API.
struct Paths {
    level: &'static str,
    owner: Option<String>,
    settings: String,
    runs: String,
}

fn paths(config: &Config, level: &Level) -> Result<Paths> {
    if level.site {
        return Ok(Paths {
            level: "site",
            owner: None,
            settings: "/admin/retention".into(),
            runs: "/admin/retention/runs".into(),
        });
    }
    let owner = match &level.owner {
        Some(owner) => owner.clone(),
        None => {
            let session = remote::api(config, "GET", "/session", None)?;
            session["viewer"]["slug"]
                .as_str()
                .ok_or_else(|| {
                    GmError::new("unauthenticated", "Sign in to manage data retention.")
                        .hint("Run `gm auth login`, or pass --owner <account> (or --site).")
                        .exit(exit::AUTH)
                })?
                .to_string()
        }
    };
    account_slug(&owner).map_err(GmError::usage)?;
    Ok(Paths {
        level: "account",
        settings: format!("/accounts/{owner}/settings/retention"),
        runs: format!("/accounts/{owner}/retention/runs"),
        owner: Some(owner),
    })
}

/// JSON output with a readable text rendering.
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

fn s<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}

fn size(bytes: f64) -> String {
    let units = ["bytes", "KB", "MB", "GB", "TB"];
    let (mut value, mut unit) = (bytes, 0);
    while value >= 1000.0 && unit < units.len() - 1 {
        value /= 1000.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} bytes", value.round())
    } else {
        format!("{value:.1} {}", units[unit])
    }
}

fn category_text(c: &Value) -> String {
    let switch = match (s(c, "control"), c["enabled"].as_bool()) {
        ("policy", Some(true)) => "on",
        ("policy", _) => "off",
        _ => "always",
    };
    let values = c["values"]
        .as_object()
        .map(|values| {
            values
                .iter()
                .map(|(k, v)| {
                    let from = c["valuesFrom"][k].as_str().unwrap_or("default");
                    format!("{k}={v} ({from})")
                })
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let mut line = format!(
        "{:<6} {} [{}] {}  {values}",
        switch,
        s(c, "id"),
        s(c, "scope"),
        s(c, "label")
    );
    if c["runnable"].as_bool() == Some(false) && s(c, "control") == "policy" {
        line.push_str("  (no cleanup)");
    }
    let last = &c["lastRun"];
    if last.is_object() {
        line.push_str(&format!(
            "  last run #{} {}{}: {} items",
            last["runId"],
            s(last, "status"),
            if last["dryRun"].as_bool() == Some(true) {
                " (dry run)"
            } else {
                ""
            },
            last["items"]
        ));
    }
    line
}

fn run_text(run: &Value) -> String {
    let mut out = format!(
        "#{} {} {}{}: {} items, {}{}",
        run["id"],
        s(run, "trigger"),
        if run["dryRun"].as_bool() == Some(true) {
            "dry run "
        } else {
            "run "
        },
        s(run, "status"),
        run["items"],
        size(run["bytes"].as_f64().unwrap_or(0.0)),
        if s(run, "createdAt").is_empty() {
            String::new()
        } else {
            format!(" ({})", s(run, "createdAt"))
        }
    );
    for c in run["categories"].as_array().into_iter().flatten() {
        out.push_str(&format!(
            "\n  {} {}: {} items, {}{}",
            s(c, "category"),
            s(c, "status"),
            c["items"],
            size(c["bytes"].as_f64().unwrap_or(0.0)),
            c["error"]
                .as_str()
                .map(|e| format!(" — {e}"))
                .unwrap_or_default()
        ));
    }
    out
}

pub fn run(ctx: &Ctx, command: &RetentionCommand) -> Result<Shown> {
    // Like account settings, retention is administered with the person's sign-in.
    // Explicit environment tokens still win; only the backend grants authority.
    let mut config = Config::load();
    config.acting = Acting::Person;
    match command {
        RetentionCommand::Show { category, level } => {
            let paths = paths(&config, level)?;
            let mut settings = remote::api(&config, "GET", &paths.settings, None)?;
            if let Some(id) = category {
                let found = settings["categories"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|c| s(c, "id") == id)
                    .cloned()
                    .ok_or_else(|| unknown_category(id, &paths))?;
                settings["categories"] = json!([found]);
            }
            let text = settings["categories"]
                .as_array()
                .into_iter()
                .flatten()
                .map(category_text)
                .collect::<Vec<_>>()
                .join("\n");
            Ok(Shown {
                value: settings,
                text,
            })
        }
        RetentionCommand::Set(args) => {
            let paths = paths(&config, &args.level)?;
            let patch = args.patch();
            if ctx.dry_run {
                return Ok(Shown {
                    text: format!("Would PATCH {} with {patch}.", paths.settings),
                    value: json!({
                        "dry_run": true, "level": paths.level, "owner": paths.owner,
                        "method": "PATCH", "path": paths.settings, "request": patch
                    }),
                });
            }
            let settings = remote::api(&config, "PATCH", &paths.settings, Some(&patch))?;
            let category = settings["categories"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|c| s(c, "id") == args.category)
                .cloned()
                .unwrap_or(Value::Null);
            Ok(Shown {
                text: category_text(&category),
                value: json!({
                    "level": settings["level"], "account": settings["account"],
                    "category": category
                }),
            })
        }
        RetentionCommand::Run(args) => {
            if !ctx.dry_run && !args.yes {
                return Err(GmError::new(
                    "confirmation_required",
                    format!(
                        "Cleaning up {} deletes what its policy selects, for good.",
                        args.categories.join(", ")
                    ),
                )
                .hint(format!(
                    "Preview it with `gm retention run {} --dry-run`, then re-run with --yes.",
                    args.categories.join(" ")
                ))
                .exit(exit::USAGE));
            }
            let body = args.request(ctx.dry_run)?;
            let paths = paths(&config, &args.level)?;
            let started = remote::api(&config, "POST", &paths.runs, Some(&body))?;
            if args.no_wait {
                let id = &started["id"];
                return Ok(Shown {
                    text: format!(
                        "Queued cleanup run #{id}. Follow it with `gm retention runs {id}`."
                    ),
                    value: started,
                });
            }
            wait(ctx, &config, &paths, started, args.timeout)
        }
        RetentionCommand::Runs {
            id,
            before,
            limit,
            level,
        } => {
            let paths = paths(&config, level)?;
            if let Some(id) = id {
                let run = remote::api(&config, "GET", &format!("{}/{id}", paths.runs), None)?;
                return Ok(Shown {
                    text: run_text(&run),
                    value: run,
                });
            }
            let mut query = Vec::new();
            if let Some(before) = before {
                query.push(format!("before={before}"));
            }
            if let Some(limit) = limit {
                query.push(format!("limit={limit}"));
            }
            let path = if query.is_empty() {
                paths.runs.clone()
            } else {
                format!("{}?{}", paths.runs, query.join("&"))
            };
            let page = remote::api(&config, "GET", &path, None)?;
            let runs: Vec<String> = page["runs"]
                .as_array()
                .into_iter()
                .flatten()
                .map(run_text)
                .collect();
            Ok(Shown {
                text: if runs.is_empty() {
                    "No cleanup runs yet.".into()
                } else {
                    runs.join("\n")
                },
                value: page,
            })
        }
    }
}

fn unknown_category(id: &str, paths: &Paths) -> GmError {
    GmError::not_found(
        "unknown_category",
        format!("{id} isn't a retention category at this level."),
    )
    .hint(if paths.level == "site" {
        "`gm retention show --site` lists the site's categories."
    } else {
        "`gm retention show` lists the account's categories; site categories need --site."
    })
}

/// Polls a run until it succeeds or fails, reporting each category's progress on stderr.
fn wait(ctx: &Ctx, config: &Config, paths: &Paths, mut run: Value, timeout: u64) -> Result<Shown> {
    let deadline = Instant::now() + Duration::from_secs(timeout);
    let progress = ctx.format == crate::output::Format::Text || std::io::stderr().is_terminal();
    let id = run["id"].clone();
    let mut seen: Vec<(String, String, String)> = Vec::new();
    loop {
        if progress {
            for c in run["categories"].as_array().into_iter().flatten() {
                let now = (
                    s(c, "category").to_string(),
                    s(c, "status").to_string(),
                    c["items"].to_string(),
                );
                if !seen.contains(&now) {
                    eprintln!("#{id} {}: {} ({} items)", now.0, now.1, now.2);
                    seen.retain(|(name, _, _)| name != &now.0);
                    seen.push(now);
                }
            }
        }
        match s(&run, "status") {
            "succeeded" => {
                return Ok(Shown {
                    text: run_text(&run),
                    value: run,
                });
            }
            "failed" => {
                let failed: Vec<String> = run["categories"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|c| s(c, "status") == "failed")
                    .map(|c| match c["error"].as_str() {
                        Some(e) => format!("{} ({e})", s(c, "category")),
                        None => s(c, "category").to_string(),
                    })
                    .collect();
                let detail = if failed.is_empty() {
                    run["error"]
                        .as_str()
                        .map(|e| format!(": {e}"))
                        .unwrap_or_default()
                } else {
                    format!(": {}", failed.join(", "))
                };
                return Err(GmError::new(
                    "run_failed",
                    format!("Cleanup run #{id} failed{detail}."),
                )
                .hint(format!(
                    "What each category did: `gm retention runs {id}{}`.",
                    level_flag(paths)
                ))
                .exit(exit::CONFLICT));
            }
            status => {
                if Instant::now() > deadline {
                    return Err(GmError::new(
                        "timeout",
                        format!("Cleanup run #{id} is still {status} after {timeout}s."),
                    )
                    .hint(format!(
                        "It keeps going; follow it with `gm retention runs {id}{}`.",
                        level_flag(paths)
                    )));
                }
            }
        }
        std::thread::sleep(Duration::from_secs(1));
        run = remote::api(config, "GET", &format!("{}/{id}", paths.runs), None)?;
    }
}

fn level_flag(paths: &Paths) -> String {
    match &paths.owner {
        Some(owner) => format!(" --owner {owner}"),
        None => " --site".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Cli, Command};
    use clap::Parser;

    fn parse(flags: &[&str]) -> std::result::Result<RetentionCommand, String> {
        let mut argv = vec!["gm", "retention"];
        argv.extend_from_slice(flags);
        match Cli::try_parse_from(argv) {
            Ok(Cli {
                command: Some(Command::Retention(command)),
                ..
            }) => Ok(command),
            Ok(_) => Err("not a retention command".into()),
            Err(e) => Err(e.to_string()),
        }
    }

    #[test]
    fn set_builds_the_patch_with_nulls_for_inherit_and_reset() {
        let Ok(RetentionCommand::Set(args)) = parse(&[
            "set",
            "ci-runs",
            "--enable",
            "--threshold",
            "days=60",
            "--reset",
            "keepLatest",
        ]) else {
            panic!("expected set");
        };
        assert_eq!(
            args.patch(),
            json!({"categories": {"ci-runs": {"enabled": true, "thresholds": {"days": 60, "keepLatest": null}}}})
        );
        let Ok(RetentionCommand::Set(args)) = parse(&["set", "ci-logs", "--inherit", "--site"])
        else {
            panic!("expected set");
        };
        assert_eq!(
            args.patch(),
            json!({"categories": {"ci-logs": {"enabled": null}}})
        );
        assert!(args.level.site);
        let Ok(RetentionCommand::Set(args)) =
            parse(&["set", "previews", "--threshold", "idleDays=3"])
        else {
            panic!("expected set");
        };
        assert_eq!(
            args.patch(),
            json!({"categories": {"previews": {"thresholds": {"idleDays": 3}}}})
        );
    }

    #[test]
    fn invalid_commands_fail_at_parse_time() {
        for flags in [
            vec!["set", "ci-logs"],
            vec!["set", "ci-logs", "--enable", "--disable"],
            vec!["set", "ci-logs", "--disable", "--inherit"],
            vec!["set", "ci-logs", "--threshold", "days"],
            vec!["set", "ci-logs", "--threshold", "days=soon"],
            vec!["set", "ci-logs", "--threshold", "days=1.5"],
            vec!["set", "ci-logs", "--enable", "--owner", "orbit/engine"],
            vec!["set", "ci-logs", "--enable", "--owner", "orbit", "--site"],
            vec!["run"],
            vec!["run", "ci-logs", "--threshold", "days=3"],
            vec!["run", "ci-logs", "--threshold", ".days=3"],
            vec!["show", "--owner", ""],
            vec!["runs", "3", "--before", "2"],
        ] {
            assert!(parse(&flags).is_err(), "accepted {flags:?}");
        }
    }

    #[test]
    fn run_builds_the_request_and_checks_threshold_categories() {
        let Ok(RetentionCommand::Run(args)) = parse(&[
            "run",
            "ci-logs",
            "ci-runs",
            "--threshold",
            "ci-logs.days=7",
            "--threshold",
            "ci-runs.keepLatest=5",
        ]) else {
            panic!("expected run");
        };
        assert_eq!(
            args.request(true).unwrap(),
            json!({"dryRun": true, "categories": ["ci-logs", "ci-runs"],
                   "thresholds": {"ci-logs": {"days": 7}, "ci-runs": {"keepLatest": 5}}})
        );
        let Ok(RetentionCommand::Run(args)) = parse(&["run", "push-log"]) else {
            panic!("expected run");
        };
        assert_eq!(
            args.request(false).unwrap(),
            json!({"dryRun": false, "categories": ["push-log"]})
        );
        let Ok(RetentionCommand::Run(args)) =
            parse(&["run", "push-log", "--threshold", "ci-logs.days=7"])
        else {
            panic!("expected run");
        };
        let error = args.request(true).unwrap_err();
        assert_eq!(error.code, "invalid_argument");
    }

    #[test]
    fn text_shows_switches_values_and_runs() {
        let line = category_text(&json!({
            "id": "ci-logs", "scope": "account", "control": "policy", "label": "CI logs",
            "enabled": true, "runnable": true, "values": {"days": 30}, "valuesFrom": {"days": "site"},
            "lastRun": {"runId": 4, "status": "succeeded", "dryRun": true, "items": 12}
        }));
        assert_eq!(
            line,
            "on     ci-logs [account] CI logs  days=30 (site)  last run #4 succeeded (dry run): 12 items"
        );
        let text = run_text(&json!({
            "id": 4, "trigger": "manual", "dryRun": false, "status": "succeeded", "items": 3,
            "bytes": 2500, "createdAt": "2026-10-04T00:00:00Z",
            "categories": [{"category": "ci-logs", "status": "succeeded", "items": 3, "bytes": 2500, "error": null}]
        }));
        assert_eq!(
            text,
            "#4 manual run succeeded: 3 items, 2.5 KB (2026-10-04T00:00:00Z)\n  ci-logs succeeded: 3 items, 2.5 KB"
        );
    }
}
