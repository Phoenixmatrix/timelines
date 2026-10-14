//! `gm timeline`: parallel lines of work.
//!
//! A timeline is a Space-wide tracker record with one owned work repository
//! per canonical repository. Canonical origin stays unchanged; bound operations
//! fetch and push the source-addressed Timelines endpoint.
//!
//! - `use` writes `timeline: <slug>` to `.gitmatrix/agent.local.yml` (which new
//!   worktrees copy) and moves `@` onto the source's work ref. A bound checkout
//!   treats it as trunk. Ended sources retain the push guard until an explicit
//!   new timeline or `use main`.
//! - `merge` merges main or another timeline into the bound one with
//!   `gm merge`, so the merge is an ordinary change to push.
//!
//! - `checkpoint` records the timeline's commits now, with a summary, as an
//!   immutable checkpoint (CORE-76); approval requests pin one
//!   (`gm issue ask --kind approval --checkpoint`), and an approval only counts
//!   while the checkpoint is still the timeline's head. `checkpoints` lists
//!   them with their CI runs, previews and approvals.
//! - `revive` rebuilds a checkpoint's preview (CORE-79): Timelines starts a
//!   preview `create` run in each repository whose ci.yml opts in, at the
//!   checkpoint's commits, and what it records is marked rebuilt.
//! - `pages` lists the wiki pages a timeline affects, written for each
//!   checkpoint (CORE-84) in each of its repositories; `--write` asks for them
//!   at the bookmarks' tips now, and `--page` prints one in full.
//!
//! - `land` queues the head checkpoint for a compact, one-parent tree landing
//!   onto canonical main after its gates pass. Progress objects stay in the
//!   source. Late sync follows exact integration receipts, preserving local edits.
//!
//! `GM_TIMELINE` overrides the binding for one command (`profile::timeline`).

use super::{Ctx, local, network, server};
use crate::cli;
use crate::model::OpResult;
use crate::output::{GmError, Render, Result, exit};
use crate::profile;
use crate::remote::{self, Config};
use crate::repo::Workspace;
use clap::{Args, Subcommand};
use serde::{Serialize, Serializer};
use serde_json::{Map, Value, json};
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Subcommand)]
pub enum TimelineCommand {
    /// Start a timeline forked from main (or another timeline), then work in it here
    Start(StartArgs),
    /// List the tracker's timelines, newest first
    #[command(visible_alias = "ls")]
    List(ListArgs),
    /// Show a timeline (default: this checkout's) and its events
    Show(ShowArgs),
    /// Work in a timeline here: pushes go to its bookmark, never to main (`use main` to go back)
    Use(UseArgs),
    /// Merge main or another timeline into this checkout's timeline, below the working copy
    Merge(MergeArgs),
    /// End a timeline and archive its work sources; keep this checkout's push guard
    Abandon(AbandonArgs),
    /// Record a checkpoint: the timeline's pushed commits now, with a summary, for a person to approve
    Checkpoint(CheckpointArgs),
    /// List a timeline's checkpoints, newest first, with CI runs, previews and approvals
    Checkpoints(CheckpointsArgs),
    /// Revive a checkpoint's preview (default: the newest): rebuild it from its commits in CI
    Revive(ReviveArgs),
    /// The wiki pages a timeline affects, written at its checkpoints (or now, with --write)
    Pages(PagesArgs),
    /// Land the approved source tree compactly onto main after gates pass
    Land(LandArgs),
    /// Rename a timeline (default: this checkout's), or flag it experimental or clear the flag
    #[command(visible_alias = "flag")]
    Update(UpdateArgs),
    /// Convert a legacy timeline to owned work sources; renew its checkpoint and approval afterward
    Migrate(MigrateArgs),
    /// List pending source pushes, or inspect one exact operation (including terminal outcomes)
    Pushes(PushesArgs),
    /// Recover one interrupted source push without changing this checkout; never force-push
    RecoverPush(RecoverPushArgs),
}

#[derive(Clone, Copy, clap::ValueEnum)]
pub enum MigrationResolution {
    /// Cancel a stopped landing that has not advanced any canonical repository
    CancelUnadvanced,
    /// Preserve successful partial receipts and abandon the entire legacy timeline
    AcceptPartialAndAbandon,
}

#[derive(Args)]
pub struct MigrateArgs {
    /// Timeline slug (default: this checkout's).
    pub slug: Option<String>,
    /// Resolve a stopped legacy landing instead of converting; inspect `timeline show` first.
    #[arg(long, value_enum, requires_all = ["expected_version", "note"])]
    pub resolve: Option<MigrationResolution>,
    /// Exact landing version observed by the operator; stale versions are rejected.
    #[arg(long, requires = "resolve")]
    pub expected_version: Option<u64>,
    /// Audit reason for resolving the legacy landing.
    #[arg(long, requires = "resolve")]
    pub note: Option<String>,
    #[command(flatten)]
    pub space: Space,
}

#[derive(Args)]
pub struct PushSelection {
    /// Timeline slug (default: this checkout's binding).
    #[arg(long)]
    pub timeline: Option<String>,
    /// Canonical repository space/name (default: this checkout's origin).
    #[arg(long)]
    pub repo: Option<String>,
}

#[derive(Args)]
pub struct PushesArgs {
    /// Exact operation ID; omit to list pending operations.
    pub operation: Option<String>,
    #[command(flatten)]
    pub selection: PushSelection,
}

#[derive(Args)]
pub struct RecoverPushArgs {
    /// Exact operation ID from `gm timeline pushes`; retries are idempotent.
    pub operation: String,
    #[command(flatten)]
    pub selection: PushSelection,
}

#[derive(Args)]
pub struct CheckpointArgs {
    /// The timeline's slug (default: the one this checkout works in).
    pub slug: Option<String>,
    /// Summary in Markdown: what it holds and why (repeat for paragraphs; '-' reads stdin, '@path' a file).
    #[arg(short, long)]
    pub message: Vec<String>,
    /// Renew this checkpoint's logical base to current canonical main after merging main and pushing.
    /// Does not merge Git commits or change allocation metadata; requires no timeline dependencies.
    #[arg(long)]
    pub sync_main: bool,
    #[command(flatten)]
    pub space: Space,
}

#[derive(Args)]
pub struct ReviveArgs {
    /// The timeline's slug (default: the one this checkout works in).
    pub slug: Option<String>,
    /// The checkpoint: its number in the timeline or its id (default: the newest).
    #[arg(short, long)]
    pub checkpoint: Option<String>,
    #[command(flatten)]
    pub space: Space,
}

#[derive(Args)]
pub struct CheckpointsArgs {
    /// The timeline's slug (default: the one this checkout works in).
    pub slug: Option<String>,
    #[command(flatten)]
    pub space: Space,
}

#[derive(Args)]
pub struct PagesArgs {
    /// The timeline's slug (default: the one this checkout works in).
    pub slug: Option<String>,
    /// Only the pages written for this checkpoint (its number or id).
    #[arg(long)]
    pub checkpoint: Option<String>,
    /// Write the pages at each bookmark's tip now (uses AI; asking twice at one commit is one set).
    #[arg(long, conflicts_with_all = ["checkpoint", "page"])]
    pub write: bool,
    /// Print one page in full, by its wiki slug (e.g. components/src-web or glossary).
    #[arg(long)]
    pub page: Option<String>,
    #[command(flatten)]
    pub space: Space,
}

#[derive(Args)]
pub struct LandArgs {
    /// The timeline's slug (default: the one this checkout works in).
    pub slug: Option<String>,
    #[command(flatten)]
    pub space: Space,
}

#[derive(Args)]
pub struct Space {
    /// Tracker Space (default: .gitmatrix/agents.yml's, else origin's space, else `gm tracker use`).
    #[arg(long)]
    pub space: Option<String>,
}

#[derive(Clone, Copy, clap::ValueEnum)]
pub enum Policy {
    /// Lands when its gates pass.
    Auto,
    /// Lands after a person approves a checkpoint.
    Approval,
}

#[derive(Args)]
pub struct StartArgs {
    /// Lowercase letters and digits joined by hyphens; work lives in an owned source.
    pub slug: String,
    /// A readable name (default: the slug).
    #[arg(long)]
    pub name: Option<String>,
    /// How it lands: auto (when gates pass) or approval (after a person approves).
    #[arg(long, value_enum)]
    pub policy: Option<Policy>,
    /// Mark it as not expected to land (a marker, not a restriction).
    #[arg(long)]
    pub experimental: bool,
    /// What it forks from: main, or another timeline's slug.
    #[arg(long, default_value = "main")]
    pub from: String,
    /// Repositories it touches, space/name (repeatable). Default: this checkout's
    /// repository, or the parent timeline's repositories with --from <timeline>.
    #[arg(long = "repo")]
    pub repos: Vec<String>,
    /// Only create it; don't bind this checkout to it.
    #[arg(long)]
    pub no_use: bool,
    #[command(flatten)]
    pub space: Space,
}

#[derive(Args)]
pub struct ListArgs {
    /// Only timelines with this status (active, idle, waiting, landing, partly_landed, landed, abandoned).
    #[arg(long)]
    pub status: Option<String>,
    /// Only open timelines with no push for the Space's idle period; experimental ones,
    /// which aren't expected to land, are left out.
    #[arg(long)]
    pub stalled: bool,
    #[command(flatten)]
    pub space: Space,
}

#[derive(Args)]
pub struct ShowArgs {
    /// The timeline's slug (default: the one this checkout works in).
    pub slug: Option<String>,
    /// Events after this sequence number (page with the `next` of the previous answer).
    #[arg(long, default_value_t = 0)]
    pub after: u64,
    /// Events per page.
    #[arg(long, default_value_t = 200)]
    pub limit: u32,
    #[command(flatten)]
    pub space: Space,
}

#[derive(Args)]
pub struct UseArgs {
    /// The timeline's slug, or `main` to stop working in a timeline.
    pub slug: String,
    #[command(flatten)]
    pub space: Space,
}

#[derive(Args)]
pub struct MergeArgs {
    /// `main`, or the slug of another timeline to bring into this one.
    pub from: String,
    /// Description for the merge (default "Merge <from> into timeline/<slug>").
    #[arg(short, long)]
    pub message: Vec<String>,
}

#[derive(Args)]
pub struct AbandonArgs {
    /// The timeline's slug (default: the one this checkout works in).
    pub slug: Option<String>,
    #[command(flatten)]
    pub space: Space,
}

#[derive(Args)]
pub struct UpdateArgs {
    /// The timeline's slug (default: the one this checkout works in).
    pub slug: Option<String>,
    /// A new readable name.
    #[arg(long)]
    pub name: Option<String>,
    /// Mark it as not expected to land, so stalled views leave it out. A marker, not a
    /// restriction: its work still merges anywhere, and it can still land.
    #[arg(long, conflicts_with = "no_experimental")]
    pub experimental: bool,
    /// Clear the experimental flag.
    #[arg(long)]
    pub no_experimental: bool,
    #[command(flatten)]
    pub space: Space,
}

/// JSON for agents, text for people.
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

pub fn run(ctx: &Ctx, command: &TimelineCommand) -> Result<Shown> {
    match command {
        TimelineCommand::Start(a) => start(ctx, a),
        TimelineCommand::List(a) => list(ctx, a),
        TimelineCommand::Show(a) => show(ctx, a),
        TimelineCommand::Use(a) => use_timeline(ctx, &a.slug, a.space.space.clone()),
        TimelineCommand::Merge(a) => merge(ctx, a),
        TimelineCommand::Abandon(a) => abandon(ctx, a),
        TimelineCommand::Checkpoint(a) => checkpoint(ctx, a),
        TimelineCommand::Checkpoints(a) => checkpoints(ctx, a),
        TimelineCommand::Revive(a) => revive(ctx, a),
        TimelineCommand::Pages(a) => pages(ctx, a),
        TimelineCommand::Land(a) => land(ctx, a),
        TimelineCommand::Update(a) => update(ctx, a),
        TimelineCommand::Migrate(a) => migrate(ctx, a),
        TimelineCommand::Pushes(a) => source_push(ctx, &a.selection, a.operation.as_deref(), false),
        TimelineCommand::RecoverPush(a) => source_push(ctx, &a.selection, Some(&a.operation), true),
    }
}

// ---- where -------------------------------------------------------------------

fn slug_arg(slug: &str) -> Result<&str> {
    if profile::is_timeline_slug(slug) {
        return Ok(slug);
    }
    Err(GmError::usage(format!(
        "`{slug}` isn't a timeline slug: lowercase letters and digits joined by hyphens."
    ))
    .hint(if slug == "main" {
        "`main` names main, not a timeline."
    } else {
        "For example `gm timeline start search-v2`."
    }))
}

/// The checkout gm was run in: its working directory, where the binding lives.
fn checkout(ctx: &Ctx) -> Option<PathBuf> {
    git2::Repository::discover(&ctx.cwd)
        .ok()?
        .workdir()
        .map(Path::to_path_buf)
}

fn require_checkout(ctx: &Ctx, what: &str) -> Result<PathBuf> {
    checkout(ctx).ok_or_else(|| {
        GmError::usage(format!(
            "{what} works on a checkout; run it inside one (or pass -C <dir>)."
        ))
    })
}

/// The tracker Space timelines live in: explicit, the checkout's
/// configured tracker, origin's space (a timeline touches its own Space's
/// repositories), else the selected tracker.
fn space(ctx: &Ctx, config: &Config, explicit: Option<String>) -> Result<String> {
    let found = explicit
        .or_else(|| profile::defaults().scope.space)
        .or_else(|| {
            server::current_repo(ctx)
                .ok()
                .and_then(|repo| repo.split_once('/').map(|(space, _)| space.to_string()))
        });
    match found {
        Some(space) => {
            if space.is_empty()
                || !space
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            {
                return Err(GmError::usage(format!(
                    "`{space}` isn't a Space handle; pass --space SPACE."
                )));
            }
            Ok(space)
        }
        None => super::tracker::selected_space(config, None),
    }
}

fn base(space: &str) -> String {
    format!("/tracker/{space}/timelines")
}

/// The timeline gm works in here (binding or GM_TIMELINE).
fn current() -> Option<String> {
    profile::timeline()
}

fn named_or_current(slug: &Option<String>, command: &str) -> Result<String> {
    match slug {
        Some(slug) => Ok(slug_arg(slug)?.to_string()),
        None => current().ok_or_else(|| {
            GmError::usage("This checkout doesn't work in a timeline; name one.").hint(format!(
                "`gm timeline {command} <slug>`; `gm timeline list` shows them."
            ))
        }),
    }
}

fn fetch_record(config: &Config, space: &str, slug: &str) -> Result<Value> {
    let detail = remote::api(
        config,
        "GET",
        &format!("{}/{slug}?limit=1", base(space)),
        None,
    )?;
    Ok(detail["timeline"].clone())
}

fn ended(record: &Value) -> Option<&str> {
    record["status"]
        .as_str()
        .filter(|s| matches!(*s, "landed" | "abandoned"))
}

// ---- text ----------------------------------------------------------------------

fn line(t: &Value, bound: Option<&str>) -> String {
    let slug = t["slug"].as_str().unwrap_or("?");
    let mark = if Some(slug) == bound { "*" } else { " " };
    let mut flags = vec![t["policy"].as_str().unwrap_or("?").to_string()];
    if t["experimental"].as_bool() == Some(true) {
        flags.push("experimental".into());
    }
    let repos = t["repos"]
        .as_array()
        .map(|r| {
            r.iter()
                .map(|r| {
                    format!(
                        "{}/{}",
                        r["space"].as_str().unwrap_or("?"),
                        r["name"].as_str().unwrap_or("?")
                    )
                })
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let name = t["name"].as_str().filter(|n| *n != slug);
    format!(
        "{mark} {slug:<24} {:<13} {:<22} {}{}",
        t["status"].as_str().unwrap_or("?"),
        flags.join(", "),
        repos,
        name.map(|n| format!("  ({n})")).unwrap_or_default()
    )
}

fn describe(t: &Value) -> String {
    let slug = t["slug"].as_str().unwrap_or("?");
    let mut out = format!(
        "Timeline {slug}: {}\nStatus   : {}{}\nPolicy   : {}\n",
        t["name"].as_str().unwrap_or(slug),
        t["status"].as_str().unwrap_or("?"),
        if t["experimental"].as_bool() == Some(true) {
            " (experimental)"
        } else {
            ""
        },
        t["policy"].as_str().unwrap_or("?"),
    );
    for repo in t["repos"].as_array().into_iter().flatten() {
        out.push_str(&format!(
            "Repo     : {}/{} on {}\n",
            repo["space"].as_str().unwrap_or("?"),
            repo["name"].as_str().unwrap_or("?"),
            repo["bookmark"].as_str().unwrap_or("?")
        ));
    }
    if let Some(pushed) = t["pushedAt"].as_str() {
        out.push_str(&format!("Pushed   : {pushed}\n"));
    }
    out
}

/// A timeline's issues (CORE-74): those it worked on, and whether each is done there.
fn issues_text(timeline: &Value, issues: &Value) -> String {
    let Some(issues) = issues.as_array().filter(|i| !i.is_empty()) else {
        return String::new();
    };
    let mut out = String::from("Issues   :\n");
    for issue in issues {
        let status = match issue["status"].as_str().unwrap_or("?") {
            "done_in_timeline" if issue["doneIn"]["id"] == timeline["id"] => {
                "done here, not landed".to_string()
            }
            "done_in_timeline" => format!(
                "done in {}",
                issue["doneIn"]["slug"]
                    .as_str()
                    .unwrap_or("another timeline")
            ),
            // An abandoned timeline's issues keep the status they had in it.
            "done" if timeline["status"] == "abandoned" => "done here, abandoned".to_string(),
            status => status.replace('_', " "),
        };
        out.push_str(&format!(
            "  {:<10} {:<24} {}\n",
            issue["key"].as_str().unwrap_or("?"),
            status,
            issue["title"].as_str().unwrap_or("")
        ));
    }
    out
}

fn event_line(e: &Value) -> String {
    let at = e["createdAt"].as_str().unwrap_or("");
    let what = match e["kind"].as_str().unwrap_or("?") {
        "fork" => format!(
            "fork from {}",
            e["parentId"]
                .as_str()
                .map_or("main".to_string(), |p| format!("timeline {p}"))
        ),
        "merge" => format!(
            "merge {} -> {} at {}",
            e["fromId"].as_str().unwrap_or("main"),
            e["intoId"].as_str().unwrap_or("main"),
            e["commit"]
                .as_str()
                .map(|c| &c[..c.len().min(12)])
                .unwrap_or("?")
        ),
        "checkpoint" => format!(
            "checkpoint #{} {}",
            e["number"],
            e["checkpointId"].as_str().unwrap_or("?")
        ),
        "approval" => format!(
            "checkpoint #{} {}",
            e["number"],
            e["outcome"].as_str().unwrap_or("?")
        ),
        "landing" => format!(
            "landing checkpoint #{}: {}{}",
            e["number"],
            e["outcome"].as_str().unwrap_or("?").replace('_', " "),
            e["note"]
                .as_str()
                .map(|n| format!(" ({n})"))
                .unwrap_or_default()
        ),
        kind => kind.to_string(),
    };
    format!("  #{:<5} {at}  {what}", e["seq"])
}

/// The bookmark results of a fork or an abandon, as text.
fn bookmarks_text(bookmarks: &Value) -> String {
    bookmarks
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| b["ok"].as_bool() != Some(true))
        .map(|b| {
            format!(
                "  {} in {}: {}\n",
                b["ref"].as_str().unwrap_or("?"),
                b["repoId"].as_str().unwrap_or("?"),
                b["reason"].as_str().unwrap_or("failed")
            )
        })
        .collect()
}

/// An OpResult with this command's own fields next to it.
fn with(op: &OpResult, extra: Value) -> Result<Value> {
    let mut value = serde_json::to_value(op)?;
    if let (Some(map), Value::Object(more)) = (value.as_object_mut(), extra) {
        map.extend(more);
    }
    Ok(value)
}

// ---- list / show ------------------------------------------------------------------

fn list(ctx: &Ctx, args: &ListArgs) -> Result<Shown> {
    let config = Config::load();
    let space = space(ctx, &config, args.space.space.clone())?;
    let mut query = Vec::new();
    if let Some(status) = &args.status {
        if !status.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') {
            return Err(GmError::usage(format!(
                "`{status}` isn't a timeline status."
            )));
        }
        query.push(format!("status={status}"));
    }
    if args.stalled {
        query.push("stalled=true".into());
    }
    let mut path = base(&space);
    if !query.is_empty() {
        path.push_str(&format!("?{}", query.join("&")));
    }
    let mut value = remote::api(&config, "GET", &path, None)?;
    let bound = current();
    let text = match value["timelines"].as_array() {
        Some(all) if !all.is_empty() => all
            .iter()
            .map(|t| line(t, bound.as_deref()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ if args.stalled => format!(
            "No timeline in {space} has stalled (no push for {} days); experimental ones aren't counted.",
            value["idleDays"].as_u64().unwrap_or(7)
        ),
        _ => format!("{space} has no timelines. Start one with `gm timeline start <slug>`."),
    };
    value["space"] = json!(space);
    value["current"] = json!(bound);
    Ok(Shown { value, text })
}

fn show(ctx: &Ctx, args: &ShowArgs) -> Result<Shown> {
    let config = Config::load();
    let space = space(ctx, &config, args.space.space.clone())?;
    let slug = named_or_current(&args.slug, "show")?;
    let mut value = remote::api(
        &config,
        "GET",
        &format!(
            "{}/{slug}?after={}&limit={}",
            base(&space),
            args.after,
            args.limit
        ),
        None,
    )?;
    let mut text = describe(&value["timeline"]);
    text.push_str(&issues_text(&value["timeline"], &value["issues"]));
    let events = value["events"].as_array().cloned().unwrap_or_default();
    if !events.is_empty() {
        text.push_str("Events   :\n");
        for e in &events {
            text.push_str(&event_line(e));
            text.push('\n');
        }
    }
    if let Some(next) = value["next"].as_u64() {
        text.push_str(&format!("More events: --after {next}\n"));
    }
    // Its newest landing (CORE-77); a server without the landing queue has none.
    if let Ok(landing) = remote::api(
        &config,
        "GET",
        &format!("{}/{slug}/landing", base(&space)),
        None,
    ) && landing["landing"].is_object()
    {
        text.push_str(&landing_text(&landing["landing"]));
        value["landing"] = landing["landing"].clone();
    }
    value["current"] = json!(current().as_deref() == Some(slug.as_str()));
    Ok(Shown { value, text })
}

// ---- landing -----------------------------------------------------------------------

/// A landing (CORE-77) as text: its state, each repository's merge, and why it stopped.
fn landing_text(l: &Value) -> String {
    let state = match l["state"].as_str().unwrap_or("?") {
        "merging" => "merging into main",
        "testing" => "testing the merge",
        "advancing" => "advancing main",
        "conflict" => "stopped: conflicts with main, needs a sync",
        "failed" => "stopped",
        "landed" => "landed",
        other => other,
    };
    let mut out = format!(
        "Landing  : checkpoint #{} ({}), {state}\n",
        l["checkpointNumber"],
        l["trigger"].as_str().unwrap_or("?")
    );
    for r in l["repos"].as_array().into_iter().flatten() {
        let runs = [("merge", &r["mergeRun"]), ("gates", &r["gateRun"])]
            .iter()
            .filter_map(|(what, run)| {
                run["number"]
                    .as_u64()
                    .filter(|n| *n > 0)
                    .map(|n| format!("{what} run #{n}"))
            })
            .collect::<Vec<_>>();
        out.push_str(&format!(
            "  {}/{:<20} {:<9} {} onto {}{}{}\n",
            r["space"].as_str().unwrap_or("?"),
            r["name"].as_str().unwrap_or("?"),
            r["state"].as_str().unwrap_or("?"),
            short(&r["commit"]),
            short(&r["base"]),
            if r["merge"].is_string() {
                format!(" as {}", short(&r["merge"]))
            } else {
                String::new()
            },
            if runs.is_empty() {
                String::new()
            } else {
                format!("  ({})", runs.join(", "))
            },
        ));
    }
    if let Some(reason) = l["reason"].as_str() {
        out.push_str(&format!("  {reason}\n"));
    }
    out
}

fn land(ctx: &Ctx, args: &LandArgs) -> Result<Shown> {
    let slug = named_or_current(&args.slug, "land")?;
    let config = Config::load();
    let space = space(ctx, &config, args.space.space.clone())?;
    if ctx.dry_run {
        let record = fetch_record(&config, &space, &slug)?;
        if let Some(status) = ended(&record) {
            return Err(GmError::new(
                "timeline_ended",
                format!("Timeline {slug} is already {status}."),
            )
            .exit(exit::CONFLICT));
        }
        return Ok(Shown {
            text: format!(
                "dry run: nothing was changed\nWould queue timeline {slug}'s head checkpoint to land in {}: merge it into main, test the merge, then advance main.\nThe server checks it can land ({} policy).",
                repo_names(Some(&record)),
                record["policy"].as_str().unwrap_or("?")
            ),
            value: json!({"dry_run": true, "space": space, "timeline": record}),
        });
    }
    let result = remote::api(
        &config,
        "POST",
        &format!("{}/{slug}/land", base(&space)),
        Some(&json!({})),
    )?;
    let landing = &result["landing"];
    let mut text = if result["queued"].as_bool() == Some(true) {
        format!("Queued timeline {slug} to land.\n")
    } else if landing["state"] == "landed" {
        format!("Timeline {slug} landed.\n")
    } else {
        format!("Timeline {slug} is already landing.\n")
    };
    text.push_str(&landing_text(landing));
    if matches!(
        landing["state"].as_str(),
        Some("merging" | "testing" | "advancing")
    ) {
        text.push_str(&format!(
            "Main moves once every merge passes its gates; follow it with `gm timeline show {slug}`.\n"
        ));
    }
    Ok(Shown {
        value: json!({"space": space, "landing": landing, "queued": result["queued"]}),
        text,
    })
}

// ---- checkpoints -------------------------------------------------------------------

fn short(oid: &Value) -> &str {
    oid.as_str().map(|c| &c[..c.len().min(12)]).unwrap_or("?")
}

/// A checkpoint view (CORE-76) as text: number, state, summary, then per
/// repository its commit, main's, changes, CI runs and previews.
pub fn checkpoint_text(v: &Value) -> String {
    let c = &v["checkpoint"];
    let state = match (v["current"].as_bool(), v["approval"]["state"].as_str()) {
        (Some(false), _) => "superseded: new commits since",
        (_, Some("approved")) => "approved",
        (_, Some("rejected")) => "rejected",
        (_, Some("superseded")) => "superseded: its request was withdrawn",
        (_, Some("pending")) => "awaiting approval",
        _ => "not yet asked about",
    };
    let mut out = format!(
        "Checkpoint #{} of {} ({}) {}  [{state}]\n",
        c["number"],
        v["timeline"]["slug"].as_str().unwrap_or("?"),
        c["createdAt"].as_str().unwrap_or(""),
        c["id"].as_str().unwrap_or("?"),
    );
    if let Some(summary) = c["summary"].as_str().filter(|s| !s.is_empty()) {
        for line in summary.lines() {
            out.push_str(&format!("    {line}\n"));
        }
    }
    for repo in c["repos"].as_array().into_iter().flatten() {
        let id = &repo["id"];
        let runs: Vec<String> = v["runs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|r| r["repoId"] == *id)
            .map(|r| {
                format!(
                    "CI #{} {}",
                    r["number"],
                    r["status"].as_str().unwrap_or("?")
                )
            })
            .collect();
        let previews: Vec<String> = v["previews"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| p["repoId"] == *id)
            .map(|p| {
                let status = p["status"].as_str().unwrap_or("?");
                let rebuilt = if p["revived"].as_bool() == Some(true) {
                    ", rebuilt"
                } else {
                    ""
                };
                match p["url"].as_str() {
                    Some(url) => format!("{url} ({status}{rebuilt})"),
                    None => format!("preview {status}{rebuilt}"),
                }
            })
            .collect();
        out.push_str(&format!(
            "  {}/{} {} onto main {} · {} change(s) · {}{}\n",
            repo["space"].as_str().unwrap_or("?"),
            repo["name"].as_str().unwrap_or("?"),
            short(&repo["commit"]),
            short(&repo["base"]),
            repo["changes"].as_array().map_or(0, Vec::len),
            if runs.is_empty() {
                "no CI run".to_string()
            } else {
                runs.join(", ")
            },
            if previews.is_empty() {
                String::new()
            } else {
                format!(" · {}", previews.join(", "))
            },
        ));
        if let Some(set) = v["knowledge"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|k| k["repoId"] == *id)
        {
            out.push_str(&format!("    wiki pages: {}\n", set_brief(set)));
        }
    }
    out
}

// ---- wiki pages (CORE-84) ------------------------------------------------------------

/// Percent-encode a query value.
fn query(value: &str) -> String {
    let mut out = String::new();
    super::semantic::encode_into(&mut out, value);
    out
}

/// A page set in one line: its state and pages.
fn set_brief(set: &Value) -> String {
    let state = set["state"].as_str().unwrap_or("?");
    let pages = set["pages"].as_array().cloned().unwrap_or_default();
    match state {
        "queued" | "writing" => format!("{state}…"),
        "failed" => format!("failed: {}", set["error"].as_str().unwrap_or("?")),
        _ if pages.is_empty() => format!("{state}, none affected"),
        _ => format!(
            "{state}: {}",
            pages
                .iter()
                .map(|p| p["slug"].as_str().unwrap_or("?"))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

/// A page set as text: what it was written for, then each page and its opening.
fn set_text(repo: &str, set: &Value) -> String {
    let at = match set["checkpoint"]["number"].as_u64() {
        Some(n) => format!("checkpoint #{n}"),
        None => format!("{} (on demand)", short(&set["commit"])),
    };
    let mut out = format!("{repo} · {at} · {}\n", set["state"].as_str().unwrap_or("?"));
    if let Some(error) = set["error"].as_str() {
        out.push_str(&format!("  error: {error}\n"));
    }
    for page in set["pages"].as_array().into_iter().flatten() {
        let label = match (page["outcome"].as_str(), page["change"].as_str()) {
            (Some("kept"), _) => "main's holds",
            (_, Some("added")) => "new",
            _ => "changed",
        };
        out.push_str(&format!(
            "  {label:<12} {} ({})\n",
            page["title"].as_str().unwrap_or("?"),
            page["slug"].as_str().unwrap_or("?"),
        ));
        if let Some(excerpt) = page["excerpt"].as_str().filter(|e| !e.is_empty()) {
            out.push_str(&format!("               {excerpt}\n"));
        }
    }
    if let Some(n) = set["skipped"].as_u64().filter(|n| *n > 0) {
        out.push_str(&format!("  {n} more page(s) left out by the cost caps\n"));
    }
    out
}

fn pages(ctx: &Ctx, args: &PagesArgs) -> Result<Shown> {
    let config = Config::load();
    let space = space(ctx, &config, args.space.space.clone())?;
    let slug = named_or_current(&args.slug, "pages")?;
    let reference = query(&format!("timeline/{slug}"));
    // Pages for one checkpoint come with it.
    if let Some(checkpoint) = &args.checkpoint {
        let view = remote::api(
            &config,
            "GET",
            &format!("{}/{slug}/checkpoints/{}", base(&space), query(checkpoint)),
            None,
        )?;
        let id = view["checkpoint"]["id"].as_str().unwrap_or("").to_string();
        let repos = view["checkpoint"]["repos"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let name_of = |repo_id: &Value| {
            repos
                .iter()
                .find(|r| r["id"] == *repo_id)
                .map(|r| {
                    format!(
                        "{}/{}",
                        r["space"].as_str().unwrap_or("?"),
                        r["name"].as_str().unwrap_or("?")
                    )
                })
                .unwrap_or_else(|| "?".to_string())
        };
        if let Some(page) = &args.page {
            let set = view["knowledge"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|s| {
                    s["pages"]
                        .as_array()
                        .is_some_and(|p| p.iter().any(|p| p["slug"] == json!(page)))
                })
                .ok_or_else(|| {
                    GmError::not_found(
                        "not_found",
                        format!("Checkpoint {checkpoint} of {slug} has no page {page}."),
                    )
                })?;
            return one_page(
                &config,
                &name_of(&set["repoId"]),
                &reference,
                page,
                Some(&id),
                set["sourceId"].as_str().unwrap_or("canonical"),
            );
        }
        let sets = view["knowledge"].as_array().cloned().unwrap_or_default();
        let text = if sets.is_empty() {
            format!("No wiki pages were asked for at checkpoint {checkpoint} of {slug}.")
        } else {
            sets.iter()
                .map(|set| set_text(&name_of(&set["repoId"]), set))
                .collect::<String>()
        };
        let repos_out: Vec<Value> = sets
            .iter()
            .map(|set| json!({"repo": name_of(&set["repoId"]), "sets": [set]}))
            .collect();
        return Ok(Shown {
            value: json!({"space": space, "timeline": slug, "checkpoint": id, "repos": repos_out}),
            text,
        });
    }
    let detail = remote::api(
        &config,
        "GET",
        &format!("{}/{slug}?limit=1", base(&space)),
        None,
    )?;
    let names: Vec<String> = detail["timeline"]["repos"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| {
            format!(
                "{}/{}",
                r["space"].as_str().unwrap_or("?"),
                r["name"].as_str().unwrap_or("?")
            )
        })
        .collect();
    let sources: Vec<&str> = detail["timeline"]["repos"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| {
            r["source"]["sourceId"].as_str().ok_or_else(|| {
                GmError::new(
                    "source_migration_required",
                    "Timeline page reads require explicit source metadata.",
                )
            })
        })
        .collect::<Result<_>>()?;
    if let Some(page) = &args.page {
        let mut last = None;
        for (name, source) in names.iter().zip(&sources) {
            match one_page(&config, name, &reference, page, None, source) {
                Ok(shown) => return Ok(shown),
                Err(e) if e.code == "not_found" => last = Some(e),
                Err(e) => return Err(e),
            }
        }
        return Err(last.unwrap_or_else(|| {
            GmError::not_found("not_found", format!("{slug} has no repositories."))
        }));
    }
    if args.write && ctx.dry_run {
        return Ok(Shown {
            text: format!(
                "dry run: nothing was changed\nWould write {slug}'s wiki pages at its bookmarks' tips in {}.",
                names.join(", ")
            ),
            value: json!({"dry_run": true, "space": space, "timeline": slug, "repos": names}),
        });
    }
    let mut repos = Vec::new();
    let mut text = String::new();
    for (name, source) in names.iter().zip(&sources) {
        let path = format!(
            "/repos/{name}/knowledge/overlay/pages?ref={reference}&source={}",
            query(source)
        );
        if args.write {
            let set = remote::api(&config, "POST", &path, None)?;
            text.push_str(&set_text(name, &set));
            repos.push(json!({"repo": name, "sets": [set]}));
        } else {
            let listed = remote::api(&config, "GET", &path, None)?;
            let sets = listed["sets"].as_array().cloned().unwrap_or_default();
            if sets.is_empty() {
                text.push_str(&format!("{name} · no wiki pages yet\n"));
            }
            for set in &sets {
                text.push_str(&set_text(name, set));
            }
            repos.push(json!({"repo": name, "ended": listed["ended"], "sets": sets}));
        }
    }
    let next = if args.write {
        format!("gm timeline pages {slug}  # see them once written")
    } else {
        format!("gm timeline pages {slug} --page <slug>  # one page in full")
    };
    text.push_str(&format!("Next: {next}\n"));
    let mut value = json!({"space": space, "timeline": slug, "repos": repos, "next": next});
    if args.write {
        value["dry_run"] = json!(false);
    }
    Ok(Shown { value, text })
}

/// One timeline page in full, from the repository's knowledge API.
fn one_page(
    config: &Config,
    repo: &str,
    reference: &str,
    page: &str,
    set: Option<&str>,
    source: &str,
) -> Result<Shown> {
    let mut path = format!(
        "/repos/{repo}/knowledge/overlay/page?ref={reference}&slug={}",
        query(page)
    );
    path.push_str(&format!("&source={}", query(source)));
    if let Some(set) = set {
        path.push_str(&format!("&set={}", query(set)));
    }
    let mut value = remote::api(config, "GET", &path, None)?;
    let text = if value["outcome"] == "kept" {
        format!(
            "{} ({repo}): main's page still holds for this timeline.\n",
            value["title"].as_str().unwrap_or("?")
        )
    } else {
        format!(
            "# {} ({repo}, at {})\n\n{}\n",
            value["title"].as_str().unwrap_or("?"),
            short(&value["generatedIn"]),
            value["body"].as_str().unwrap_or("")
        )
    };
    value["repo"] = json!(repo);
    Ok(Shown { value, text })
}

fn summary(message: &[String]) -> Result<String> {
    let parts = message
        .iter()
        .map(|m| match m.as_str() {
            "-" => {
                let mut s = String::new();
                std::io::stdin().take(1_048_577).read_to_string(&mut s)?;
                Ok(s)
            }
            m => match m.strip_prefix('@') {
                Some(path) => Ok(std::fs::read_to_string(path)?),
                None => Ok(m.to_string()),
            },
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(parts.join("\n\n").trim().to_string())
}

fn checkpoint(ctx: &Ctx, args: &CheckpointArgs) -> Result<Shown> {
    let config = Config::load();
    let space = space(ctx, &config, args.space.space.clone())?;
    let slug = named_or_current(&args.slug, "checkpoint")?;
    let summary = summary(&args.message)?;
    let mut body = json!({ "summary": summary });
    if args.sync_main {
        body["syncMain"] = json!(true);
    }
    if ctx.dry_run {
        return Ok(Shown {
            text: format!(
                "dry run: nothing was changed\nWould record a checkpoint of {slug}'s pushed commits.{}",
                if args.sync_main {
                    "\nWould renew only this checkpoint's logical base to current canonical main, which must already be merged and pushed; no Git merge or allocation metadata change."
                } else {
                    ""
                }
            ),
            value: json!({"dry_run": true, "space": space, "timeline": slug, "request": body}),
        });
    }
    let mut value = remote::api(
        &config,
        "POST",
        &format!("{}/{slug}/checkpoints", base(&space)),
        Some(&body),
    )?;
    let id = value["checkpoint"]["id"]
        .as_str()
        .unwrap_or("?")
        .to_string();
    let next = format!(
        "gm issue ask <ISSUE> --kind approval --checkpoint {id} --prompt '…'  # a person approves exactly these commits"
    );
    let text = format!(
        "{}Recorded from what's pushed: push first to include newer work.\nNext: {next}",
        checkpoint_text(&value)
    );
    value["dry_run"] = json!(false);
    value["next"] = json!(next);
    Ok(Shown { value, text })
}

fn checkpoints(ctx: &Ctx, args: &CheckpointsArgs) -> Result<Shown> {
    let config = Config::load();
    let space = space(ctx, &config, args.space.space.clone())?;
    let slug = named_or_current(&args.slug, "checkpoints")?;
    let mut value = remote::api(
        &config,
        "GET",
        &format!("{}/{slug}/checkpoints", base(&space)),
        None,
    )?;
    let text = match value["checkpoints"].as_array() {
        Some(all) if !all.is_empty() => all
            .iter()
            .map(checkpoint_text)
            .collect::<Vec<_>>()
            .join("\n"),
        _ => format!("{slug} has no checkpoints. Record one with `gm timeline checkpoint -m '…'`."),
    };
    value["space"] = json!(space);
    value["timeline"] = json!(slug);
    Ok(Shown { value, text })
}

/// What a revival started, per repository, as text.
fn revival_text(value: &Value) -> String {
    let view = &value["checkpoint"];
    let name = |id: &Value| {
        view["checkpoint"]["repos"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|r| r["id"] == *id)
            .map(|r| {
                format!(
                    "{}/{}",
                    r["space"].as_str().unwrap_or("?"),
                    r["name"].as_str().unwrap_or("?")
                )
            })
            .unwrap_or_else(|| id.as_str().unwrap_or("?").to_string())
    };
    let mut out = format!(
        "Reviving the preview of checkpoint #{} of {}:\n",
        view["checkpoint"]["number"],
        view["timeline"]["slug"].as_str().unwrap_or("?"),
    );
    for run in value["runs"].as_array().into_iter().flatten() {
        match run["number"].as_u64() {
            Some(n) => out.push_str(&format!(
                "  {}: CI #{n} builds it (gm runs wait, then gm deploy list --timeline {})\n",
                name(&run["repoId"]),
                view["timeline"]["slug"].as_str().unwrap_or("?"),
            )),
            None => out.push_str(&format!(
                "  {}: not started: {}\n",
                name(&run["repoId"]),
                run["skipped"].as_str().unwrap_or("?")
            )),
        }
    }
    out.push_str("The preview it records is marked rebuilt: it can differ from the original if the toolchain or seed changed since.\n");
    out
}

fn revive(ctx: &Ctx, args: &ReviveArgs) -> Result<Shown> {
    let config = Config::load();
    let space = space(ctx, &config, args.space.space.clone())?;
    let slug = named_or_current(&args.slug, "revive")?;
    let checkpoint = match &args.checkpoint {
        Some(reference) => reference.trim().to_string(),
        None => {
            let list = remote::api(
                &config,
                "GET",
                &format!("{}/{slug}/checkpoints", base(&space)),
                None,
            )?;
            list["checkpoints"][0]["checkpoint"]["id"]
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| {
                    GmError::usage(format!("{slug} has no checkpoints to revive.")).hint(
                        "Record one with `gm timeline checkpoint -m '…'`; it builds a preview on its own.",
                    )
                })?
        }
    };
    if checkpoint.is_empty() || checkpoint.contains('/') {
        return Err(GmError::usage(format!(
            "`{checkpoint}` isn't a checkpoint: use its number or id (`gm timeline checkpoints`)."
        )));
    }
    let path = format!("{}/{slug}/checkpoints/{checkpoint}/revive", base(&space));
    if ctx.dry_run {
        return Ok(Shown {
            text: format!(
                "dry run: nothing was changed\nWould revive the preview of checkpoint {checkpoint} of {slug}."
            ),
            value: json!({"dry_run": true, "space": space, "timeline": slug, "checkpoint": checkpoint, "path": path}),
        });
    }
    let mut value = remote::api(&config, "POST", &path, None)?;
    let text = revival_text(&value);
    value["dry_run"] = json!(false);
    value["space"] = json!(space);
    Ok(Shown { value, text })
}

// ---- start -----------------------------------------------------------------------

fn start(ctx: &Ctx, args: &StartArgs) -> Result<Shown> {
    let slug = slug_arg(&args.slug)?.to_string();
    let parent = if args.from == "main" {
        None
    } else {
        Some(slug_arg(&args.from)?.to_string())
    };
    let config = Config::load();
    let space = space(ctx, &config, args.space.space.clone())?;
    let here = server::current_repo(ctx).ok();
    let repos: Vec<String> = if !args.repos.is_empty() {
        args.repos.clone()
    } else if parent.is_none() {
        vec![here.clone().ok_or_else(|| {
            GmError::usage("Name the repositories it touches: --repo space/name.")
                .hint("Inside a checkout, its own repository is the default.")
        })?]
    } else {
        Vec::new()
    };
    let mut body = Map::new();
    body.insert("slug".into(), json!(slug));
    if let Some(name) = &args.name {
        body.insert("name".into(), json!(name));
    }
    if let Some(policy) = args.policy {
        body.insert(
            "policy".into(),
            json!(match policy {
                Policy::Auto => "auto",
                Policy::Approval => "approval",
            }),
        );
    }
    if args.experimental {
        body.insert("experimental".into(), json!(true));
    }
    if let Some(parent) = &parent {
        body.insert("parent".into(), json!(parent));
    }
    if !repos.is_empty() {
        body.insert("repos".into(), json!(repos));
    }
    let body = Value::Object(body);
    let binds = !args.no_use && checkout(ctx).is_some();
    let from = parent
        .as_deref()
        .map_or("main".to_string(), |p| format!("timeline {p}"));

    if ctx.dry_run {
        let text = format!(
            "dry run: nothing was changed\nWould start timeline {slug} in {space}, forked from {from}{}{}.",
            if repos.is_empty() {
                String::new()
            } else {
                format!(" in {}", repos.join(", "))
            },
            if binds { ", and work in it here" } else { "" }
        );
        return Ok(Shown {
            value: json!({
                "dry_run": true,
                "space": space,
                "request": body,
                "use": binds,
            }),
            text,
        });
    }

    let created = remote::api(&config, "POST", &base(&space), Some(&body))?;
    let mut text = format!(
        "Started timeline {slug} in {space}, forked from {from}.\n{}",
        bookmarks_text(&created["bookmarks"])
    );
    let mut value = json!({
        "dry_run": false,
        "space": space,
        "timeline": created["timeline"],
        "bookmarks": created["bookmarks"],
    });
    if binds {
        // This checkout's repository may not be one of the timeline's (--repo
        // elsewhere): then there's nothing to bind, which isn't a failure.
        match use_timeline(ctx, &slug, Some(space.clone())) {
            Ok(used) => {
                text.push_str(&used.text);
                value["use"] = used.value;
            }
            Err(e) => {
                text.push_str(&format!("Not working in it here: {}", e.message));
                value["use"] = json!({ "error": e });
            }
        }
    } else {
        text.push_str(&format!("Work in it with `gm timeline use {slug}`."));
    }
    Ok(Shown { value, text })
}

// ---- use -----------------------------------------------------------------------

/// Main's name as a revision gm resolves (`origin/main`).
fn main_revision(ws: &Workspace) -> Result<String> {
    let main = ws.main().ok_or_else(|| {
        GmError::not_found(
            "no_trunk",
            "This repository has no main line yet (no origin/main).",
        )
    })?;
    Ok(main
        .refname
        .trim_start_matches("refs/remotes/")
        .trim_start_matches("refs/heads/")
        .to_string())
}

/// Source identity is obtained from the canonical account API, never a provider URL.
pub(crate) struct WorkSource {
    pub id: String,
    pub url: String,
    pub ended: bool,
}

pub(crate) fn work_source(ctx: &Ctx, config: &Config, slug: &str) -> Result<WorkSource> {
    slug_arg(slug)?;
    let space = space(ctx, config, None)?;
    let name = server::current_repo(ctx)?;
    selected_work_source(ctx, config, slug, &space, &name)
}

fn selected_work_source(
    ctx: &Ctx,
    config: &Config,
    slug: &str,
    space: &str,
    name: &str,
) -> Result<WorkSource> {
    let record = fetch_record(config, space, slug)?;
    let entry = record["repos"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|r| {
            format!(
                "{}/{}",
                r["space"].as_str().unwrap_or(""),
                r["name"].as_str().unwrap_or("")
            ) == name
        })
        .ok_or_else(|| {
            GmError::not_found(
                "timeline_not_here",
                "This timeline does not include this repository.",
            )
        })?;
    let source = &entry["source"];
    let id = source["sourceId"].as_str().filter(|id| {
        id.starts_with("work_") && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    }).filter(|_| source["kind"] == "timeline-work" && source["ref"] == "refs/heads/work"
        && source["repoId"] == entry["id"] && source["timelineId"] == record["id"])
        .ok_or_else(|| GmError::new("source_migration_required", "Timeline has no validated owned work source.")
            .hint("Migrate the timeline before using it; canonical timeline bookmarks are not a write fallback.")
            .exit(exit::CONFLICT))?;
    let detail = remote::api(config, "GET", &format!("/repos/{name}?source={id}"), None)?;
    let expected = format!(
        "{}/{name}@{slug}.git",
        config.server().trim_end_matches('/')
    );
    if record["slug"] != slug
        || detail["source"] != *source
        || detail["cloneUrl"].as_str() != Some(expected.as_str())
    {
        return Err(GmError::new(
            "invalid_source",
            "The server's Git URL or source identity does not match this timeline.",
        ));
    }
    if server::current_repo(ctx).ok().as_deref() == Some(name)
        && let Ok(checkout) = git2::Repository::discover(&ctx.cwd)
        && let Ok(pinned) = checkout
            .config()?
            .get_string(&format!("gitmatrix.source-{slug}"))
        && pinned != id
    {
        return Err(GmError::new(
            "invalid_source",
            "This timeline no longer matches the checkout's pinned source.",
        ));
    }
    Ok(WorkSource {
        id: id.to_string(),
        url: expected,
        ended: ended(&record).is_some(),
    })
}

// Recovery is API-only: do not open a Workspace, fetch, rewrite bindings or push.
fn source_push(
    ctx: &Ctx,
    selection: &PushSelection,
    operation: Option<&str>,
    recover: bool,
) -> Result<Shown> {
    if let Some(operation) = operation
        && (operation.is_empty()
            || !operation
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
    {
        return Err(GmError::usage(
            "Use an exact push operation ID from `gm timeline pushes`.",
        ));
    }
    let slug = selection.timeline.clone().or_else(current).ok_or_else(|| {
        GmError::usage("This checkout doesn't work in a timeline.")
            .hint("Pass --timeline SLUG and, outside a checkout, --repo OWNER/NAME.")
    })?;
    slug_arg(&slug)?;
    let name = match &selection.repo {
        Some(name) => std::borrow::Cow::Borrowed(name.as_str()),
        None => std::borrow::Cow::Owned(server::current_repo(ctx)?),
    };
    let (repo_owner, repo_name) = name
        .split_once('/')
        .ok_or_else(|| GmError::usage("Name a canonical repository as OWNER/NAME."))?;
    if [repo_owner, repo_name].into_iter().any(|part| {
        part.is_empty()
            || part == "."
            || part == ".."
            || !part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    }) {
        return Err(GmError::usage("Name a canonical repository as OWNER/NAME."));
    }
    let config = Config::load();
    let account = if selection.repo.is_some() {
        repo_owner.to_owned()
    } else {
        space(ctx, &config, None)?
    };
    let source = selected_work_source(ctx, &config, &slug, &account, &name)?;
    let mut path = format!("/repos/{name}/sources/{}/pushes", source.id);
    if let Some(operation) = operation {
        path.push('/');
        path.push_str(operation);
    }
    if recover {
        path.push_str("/recover");
        if ctx.dry_run {
            return Ok(Shown {
                value: json!({"dry_run": true, "sourceId": source.id, "operationId": operation,
                    "timeline": slug, "repo": name, "request": {}}),
                text: format!(
                    "Would recover push {} on {name} / {slug}. No provider or local changes were made.",
                    operation.unwrap_or("")
                ),
            });
        }
    }
    let body = recover.then(|| json!({}));
    let mut value = remote::api(
        &config,
        if recover { "POST" } else { "GET" },
        &path,
        body.as_ref(),
    )?;
    let text = if recover {
        let next = if value["syncRequired"] == true {
            format!(
                "Recovery introduced a same-tree fence commit. In the checkout bound to {slug} for {name}, run `gm sync` before retrying publication. Do not force-push."
            )
        } else {
            "The established push outcome is recorded. No local changes were made; inspect the outcome before retrying publication.".to_string()
        };
        value["next"] = json!(next);
        format!(
            "Push {}: {}\nSource: {}\nRecovery: {}\nProven head: {}\nFence commit: {}\n{next}",
            value["operationId"].as_str().unwrap_or("?"),
            value["state"].as_str().unwrap_or("?"),
            source.id,
            value["recoveryId"].as_str().unwrap_or("none"),
            value["head"].as_str().unwrap_or("none"),
            value["fenceCommit"].as_str().unwrap_or("none")
        )
    } else {
        serde_json::to_string_pretty(&value)?
    };
    Ok(Shown { value, text })
}

pub(crate) fn source_query(ctx: &Ctx, config: &Config) -> Result<String> {
    match current() {
        Some(slug) => Ok(format!("source={}", work_source(ctx, config, &slug)?.id)),
        None => Ok("source=canonical".into()),
    }
}

pub(crate) fn fetch_work(ctx: &Ctx, config: &Config, slug: &str) -> Result<WorkSource> {
    let source = work_source(ctx, config, slug)?;
    let root = require_checkout(ctx, "fetch timeline source")?;
    let refspec = format!("+refs/heads/work:refs/remotes/gm-work/timeline/{slug}");
    let output = remote::git(
        config,
        &root,
        &["fetch", "--quiet", "--no-tags", &source.url, &refspec],
    )?;
    if !output.status.success() {
        let repo = git2::Repository::discover(&root)?;
        let commit = repo
            .find_reference(&format!("refs/remotes/gm-work/timeline/{slug}"))
            .ok()
            .and_then(|r| r.target())
            .unwrap_or(git2::Oid::ZERO_SHA1);
        let name = server::current_repo(ctx)?;
        match remote::api(
            config,
            "GET",
            &format!(
                "/repos/{name}/sources/{}/lineage?commit={commit}",
                source.id
            ),
            None,
        ) {
            Ok(lineage) if lineage["status"] == "expired" => {
                return Err(GmError::new("source_expired", "The timeline work source has expired its retention period.")
                    .hint("Local work is preserved. Explicitly recover it into a new timeline or use main."));
            }
            Err(error) if error.code == "source_expired" => return Err(error),
            _ => {}
        }
        return Err(remote::git_failure("Fetch timeline source", &output)
            .hint("The source may have expired its retention period. Local work is preserved; inspect `gm timeline show`."));
    }
    git2::Repository::discover(&root)?
        .config()?
        .set_str(&format!("gitmatrix.source-{slug}"), &source.id)?;
    Ok(source)
}

/// Bind (or unbind) the checkout in its local file.
fn bind(root: &Path, slug: Option<&str>) -> Result<()> {
    let mut local = profile::local_at(root)?.unwrap_or_default();
    local.timeline = slug.map(str::to_string);
    if local == profile::Local::default() {
        // Nothing else in it: no file is the same as an empty one.
        let path = root.join(profile::LOCAL_FILE);
        if path.exists() {
            std::fs::remove_file(path)?;
        }
        return Ok(());
    }
    std::fs::create_dir_all(root.join(".gitmatrix"))?;
    keep_out_of_changes(root)?;
    profile::write_local(root, &local)
}

/// The local file is this checkout's, never part of a change: where no
/// .gitignore says so (`gm agent setup` adds that line), the repository's own
/// exclude file does, for every worktree.
fn keep_out_of_changes(root: &Path) -> Result<()> {
    let repo = git2::Repository::discover(root)?;
    if repo.status_should_ignore(Path::new(profile::LOCAL_FILE))? {
        return Ok(());
    }
    let exclude = repo.commondir().join("info").join("exclude");
    std::fs::create_dir_all(exclude.parent().expect("info/exclude has a parent"))?;
    let mut text = std::fs::read_to_string(&exclude).unwrap_or_default();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&format!(
        "# This checkout's agent and timeline (gm timeline use)\n/{}\n",
        profile::LOCAL_FILE
    ));
    std::fs::write(exclude, text)?;
    Ok(())
}

/// Bind the checkout to `slug` (or `main`) and move `@` onto its line.
fn use_timeline(ctx: &Ctx, slug: &str, explicit_owner: Option<String>) -> Result<Shown> {
    let root = require_checkout(ctx, "`gm timeline use`")?;
    let to_main = slug == "main";
    let slug = if to_main {
        None
    } else {
        Some(slug_arg(slug)?.to_string())
    };
    let previous = profile::bound_timeline(&root);
    let config = Config::load();
    let record = match &slug {
        Some(slug) => {
            let space = space(ctx, &config, explicit_owner)?;
            let record = fetch_record(&config, &space, slug)?;
            if let Some(status) = ended(&record) {
                return Err(GmError::new(
                    "timeline_ended",
                    format!("Timeline {slug} is {status}; it takes no new work."),
                )
                .hint("Start another with `gm timeline start <slug>`, or `gm timeline use main`.")
                .exit(exit::CONFLICT));
            }
            Some(record)
        }
        None => None,
    };

    // What the timeline being left had on origin, before a fetch can prune it:
    // that work lives there, not in this checkout's own stacks.
    let leaving = previous
        .as_ref()
        .filter(|prev| slug.as_ref() != Some(*prev))
        .and_then(|prev| {
            let repo = git2::Repository::discover(&ctx.cwd).ok()?;
            let tip = repo
                .find_reference(&format!("refs/remotes/gm-work/timeline/{prev}"))
                .ok()?
                .peel_to_commit()
                .ok()?
                .id();
            Some((format!("timeline/{prev}"), tip))
        });

    // Fetch, so the bookmark (and main) are current, then find where @ goes.
    if let Some(slug) = &slug {
        fetch_work(ctx, &config, slug)?;
    }
    // Explicitly leaving an expired source must not require fetching that source.
    let output = remote::git(&config, &root, &["fetch", "origin", "--prune", "--quiet"])?;
    if !output.status.success() {
        return Err(remote::git_failure("Fetch", &output));
    }
    let (target, target_name, old_wc, stale) = {
        let ws = Workspace::open(&ctx.cwd)?;
        let (target, name) = match &slug {
            Some(slug) => {
                let name = format!("timeline/{slug}");
                let refname = format!("refs/remotes/gm-work/{name}");
                let oid = ws
                    .repo
                    .find_reference(&refname)
                    .ok()
                    .and_then(|r| r.peel_to_commit().ok())
                    .map(|c| c.id())
                    .ok_or_else(|| {
                        GmError::not_found(
                            "timeline_not_here",
                            format!("This repository has no {name} on origin."),
                        )
                        .hint(format!(
                            "Timeline {slug} touches {}; work in it from one of those checkouts.",
                            repo_names(record.as_ref())
                        ))
                    })?;
                (oid, format!("gm-work/{name}"))
            }
            None => {
                let main = main_revision(&ws)?;
                (crate::repo::revset::resolve(&ws, &main)?, main)
            }
        };
        let wc = ws.wc();
        let commit = ws.commit(wc)?;
        let untouched = ws.is_untouched(&commit)?;
        // Already there. Work built on a timeline's head stays where it is and
        // goes to the timeline with the next push (a timeline just forked
        // from main's tip takes the work started on it). So does this
        // checkout's own work built on main (CORE-224), even an older main:
        // `gm push --sync` rebases it onto the bookmark, as it would onto a
        // main that moved. Going back to main, only a fresh @ on main's head
        // stays: anything else may hold the timeline's work, which must not
        // reach main by a plain push.
        let (here, stale) = match &slug {
            Some(_) if wc == target || ws.repo.graph_descendant_of(wc, target)? => (true, None),
            Some(_) => match local_work_on_main(&ws, wc, untouched)? {
                Some(work) => (true, Some(super::short(&ws, work))),
                None => (false, None),
            },
            None => (untouched && commit.parent_ids().eq([target]), None),
        };
        let kept = (!here && !untouched).then(|| super::short(&ws, wc));
        (if here { None } else { Some(target) }, name, kept, stale)
    };

    if !ctx.dry_run {
        bind(&root, slug.as_deref())?;
    }
    let op = match target {
        Some(target) => super::mutate(ctx, |ws| {
            let tree = ws.commit(target)?.tree_id();
            let new = ws.new_commit(&[target], tree, "")?;
            ws.set_wc(new)?;
            if let Some((bookmark, tip)) = &leaving {
                forget_pushed(ws, bookmark, *tip)?;
            }
            Ok(super::Outcome::new(
                format!("Started change {} on {target_name}.", super::short(ws, new)),
                vec![new],
                Default::default(),
            ))
        })?,
        None => {
            let ws = Workspace::open(&ctx.cwd)?;
            crate::commands::report(
                &ws,
                super::Outcome::new("", Vec::new(), Default::default()),
                None,
                ctx.dry_run,
            )?
        }
    };

    let mut message = match (&slug, &previous) {
        (Some(slug), Some(prev)) if prev == slug => format!(
            "This checkout already works in timeline {slug}; `gm push` goes to timeline/{slug}."
        ),
        (Some(slug), _) => format!(
            "This checkout works in timeline {slug} now: `gm push` goes to timeline/{slug}, never to main."
        ),
        (None, Some(prev)) => {
            format!("This checkout works on main again (it was in timeline {prev}).")
        }
        (None, None) => "This checkout works on main.".to_string(),
    };
    message.push(' ');
    message.push_str(&match (target, &stale) {
        (Some(_), _) => format!("Started a new working copy on {target_name}."),
        (None, Some(work)) => format!(
            "The working copy stays on your change {work}, built on main and not on {target_name} yet: `gm push --sync` rebases it onto the timeline and pushes it."
        ),
        (None, None) => format!("The working copy is already on {target_name}."),
    });
    if let Some(kept) = &old_wc {
        message.push_str(&match &slug {
            Some(_) => format!(
                " Your previous working copy {kept} stays where it was; bring it along with `gm rebase -s {kept} -d @-` if it belongs in the timeline."
            ),
            None => format!(" Your previous working copy {kept} stays where it was."),
        });
    }
    let env = std::env::var(profile::TIMELINE_ENV).ok();
    if let Some(env) = env.as_deref()
        && env != slug.as_deref().unwrap_or("main")
    {
        message.push_str(&format!(
            " Note: {} is set to `{env}`, which overrides this checkout's binding while it's set.",
            profile::TIMELINE_ENV
        ));
    }
    if ctx.dry_run {
        message = format!("Would bind: {message}");
    }
    let op = OpResult { message, ..op };
    let value = with(
        &op,
        json!({
            "timeline": slug,
            "previous": previous,
            "bookmark": slug.as_ref().map(|s| format!("timeline/{s}")),
            "file": root.join(profile::LOCAL_FILE),
            "record": record,
        }),
    )?;
    Ok(Shown {
        text: op.text(),
        value,
    })
}

/// The change `@` stands for (`@-` when `@` is untouched) when it heads a stack
/// of this checkout's own work built on main's history: none of it is on main
/// or on any other bookmark origin has (another timeline's work, or work
/// already pushed somewhere). That work belongs wherever this checkout pushes.
fn local_work_on_main(ws: &Workspace, wc: git2::Oid, untouched: bool) -> Result<Option<git2::Oid>> {
    let Some(main) = ws.main().map(|m| m.oid) else {
        return Ok(None);
    };
    let work = if untouched {
        match ws.commit(wc)?.parent_id(0) {
            Ok(parent) => parent,
            Err(_) => return Ok(None),
        }
    } else {
        wc
    };
    let count = |hide_remote: bool| -> Result<usize> {
        let mut walk = ws.repo.revwalk()?;
        walk.push(work)?;
        walk.hide(main)?;
        if hide_remote {
            walk.hide_glob("refs/remotes/origin/*")?;
        }
        let mut n = 0;
        for oid in walk.take(1001) {
            oid?;
            n += 1;
        }
        Ok(n)
    };
    let stack = count(false)?;
    Ok((stack > 0 && stack <= 1000 && count(true)? == stack).then_some(work))
}

/// After leaving a timeline, what was pushed to it (up to `tip`) stays on its
/// bookmark rather than showing up here as local work: the local bookmark
/// `gm push` left and heads inside it go, while anything built on top stays.
fn forget_pushed(ws: &mut Workspace, bookmark: &str, tip: git2::Oid) -> Result<()> {
    let inside = |ws: &Workspace, oid: &str| -> bool {
        git2::Oid::from_str(oid)
            .is_ok_and(|oid| oid == tip || ws.repo.graph_descendant_of(tip, oid).unwrap_or(false))
    };
    if let Some(target) = ws.view.bookmarks.get(bookmark).cloned()
        && inside(ws, &target)
    {
        ws.view.bookmarks.remove(bookmark);
    }
    let pushed: Vec<String> = ws
        .view
        .heads
        .iter()
        .filter(|head| inside(ws, head))
        .cloned()
        .collect();
    for head in pushed {
        ws.view.heads.remove(&head);
    }
    ws.normalize_heads()
}

fn repo_names(record: Option<&Value>) -> String {
    let names: Vec<String> = record
        .and_then(|r| r["repos"].as_array())
        .into_iter()
        .flatten()
        .map(|r| {
            format!(
                "{}/{}",
                r["space"].as_str().unwrap_or("?"),
                r["name"].as_str().unwrap_or("?")
            )
        })
        .collect();
    if names.is_empty() {
        "other repositories".into()
    } else {
        names.join(", ")
    }
}

// ---- merge ---------------------------------------------------------------------

fn merge(ctx: &Ctx, args: &MergeArgs) -> Result<Shown> {
    require_checkout(ctx, "`gm timeline merge`")?;
    let slug = current().ok_or_else(|| {
        GmError::usage(
            "This checkout doesn't work in a timeline, so there's nothing to merge into.",
        )
        .hint("`gm timeline use <slug>` first, or `gm merge <rev>` for a plain merge.")
    })?;
    let from_main = args.from == "main";
    if !from_main {
        slug_arg(&args.from)?;
        if args.from == slug {
            return Err(
                GmError::usage(format!("This checkout already works in timeline {slug}."))
                    .hint("Name main or another timeline to merge in."),
            );
        }
    }
    network::fetch(ctx)?;
    if !from_main {
        fetch_work(ctx, &Config::load(), &args.from)?;
    }
    let (revision, label) = {
        let ws = Workspace::open(&ctx.cwd)?;
        if !ws.on_timeline() {
            return Err(GmError::new(
                "timeline_missing",
                format!("Origin has no timeline/{slug}."),
            )
            .hint(format!(
                "It may have been abandoned: `gm timeline show {slug}`. Go back to main with `gm timeline use main`."
            ))
            .exit(exit::CONFLICT));
        }
        if from_main {
            let main = main_revision(&ws)?;
            let name = ws.main().map(|m| m.name.clone()).unwrap_or("main".into());
            (main, name)
        } else {
            let name = format!("timeline/{}", args.from);
            if ws
                .repo
                .find_reference(&format!("refs/remotes/gm-work/{name}"))
                .is_err()
            {
                return Err(GmError::not_found(
                    "timeline_not_here",
                    format!("This repository has no {name} on origin."),
                )
                .hint("`gm timeline list` shows the timelines and the repositories they touch."));
            }
            (format!("gm-work/{name}"), name)
        }
    };
    let message = if args.message.is_empty() {
        vec![format!("Merge {label} into timeline/{slug}")]
    } else {
        args.message.clone()
    };
    let op = local::merge(
        ctx,
        &cli::MergeArgs {
            revisions: vec![revision],
            message,
        },
    )?;
    let mut text = op.text();
    if !op.changes.is_empty() && !ctx.dry_run {
        text.push_str(&format!(
            "\nPush it to the timeline with `gm push` (timeline/{slug})."
        ));
    }
    let value = with(
        &op,
        json!({ "timeline": slug, "from": args.from, "merged": label }),
    )?;
    Ok(Shown { value, text })
}

// ---- abandon ---------------------------------------------------------------------

fn abandon(ctx: &Ctx, args: &AbandonArgs) -> Result<Shown> {
    let slug = named_or_current(&args.slug, "abandon")?;
    let config = Config::load();
    let space = space(ctx, &config, args.space.space.clone())?;
    let root = checkout(ctx);
    let bound_here = root
        .as_deref()
        .and_then(profile::bound_timeline)
        .is_some_and(|b| b == slug);
    if ctx.dry_run {
        let record = fetch_record(&config, &space, &slug)?;
        if let Some(status) = ended(&record) {
            return Err(GmError::new(
                "timeline_ended",
                format!("Timeline {slug} is already {status}."),
            )
            .exit(exit::CONFLICT));
        }
        let text = format!(
            "dry run: nothing was changed\nWould abandon timeline {slug} and archive its work sources in {}{}.\nOnly its accountable person or the agent that started it may; the server checks.",
            repo_names(Some(&record)),
            if bound_here {
                "; this checkout keeps its ended-source push guard"
            } else {
                ""
            }
        );
        return Ok(Shown {
            value: json!({
                "dry_run": true,
                "space": space,
                "timeline": record,
                "unbind": false,
            }),
            text,
        });
    }
    let result = remote::api(
        &config,
        "POST",
        &format!("{}/{slug}/abandon", base(&space)),
        Some(&json!({})),
    )?;
    if result["cancelled"] == true {
        return Ok(Shown {
            text: format!(
                "Cancelled reserved timeline {slug}; its owned source cleanup is scheduled."
            ),
            value: json!({
                "dry_run": false,
                "space": space,
                "cancelled": true,
                "slug": result["slug"],
                "bookmarks": result["bookmarks"],
            }),
        });
    }
    let mut text = format!(
        "Abandoned timeline {slug}; its events stay.\n{}",
        bookmarks_text(&result["bookmarks"])
    );
    let value = json!({
        "dry_run": false,
        "space": space,
        "timeline": result["timeline"],
        "bookmarks": result["bookmarks"],
    });
    if bound_here {
        text.push_str("This checkout remains bound and cannot push. Explicitly start a new timeline or `gm timeline use main`.");
    }
    Ok(Shown { value, text })
}

fn migrate(ctx: &Ctx, args: &MigrateArgs) -> Result<Shown> {
    let config = Config::load();
    let space = space(ctx, &config, args.space.space.clone())?;
    let slug = named_or_current(&args.slug, "migrate")?;
    if let Some(resolution) = args.resolve {
        let action = match resolution {
            MigrationResolution::CancelUnadvanced => "cancel-unadvanced",
            MigrationResolution::AcceptPartialAndAbandon => "accept-partial-and-abandon",
        };
        let note = args.note.as_deref().unwrap_or("").trim();
        if note.is_empty() {
            return Err(GmError::usage(
                "Legacy landing resolution requires a nonempty --note.",
            ));
        }
        let version = args
            .expected_version
            .ok_or_else(|| GmError::usage("Pass the observed landing --expected-version."))?;
        let body = json!({"expectedVersion": version, "action": action, "note": note});
        if ctx.dry_run {
            return Ok(Shown {
                value: json!({"dry_run":true,"timeline":slug,"request":body}),
                text: format!(
                    "Would resolve {slug}'s stopped legacy landing with {action} at version {version}. No conversion requested."
                ),
            });
        }
        let value = remote::api(
            &config,
            "POST",
            &format!("{}/{slug}/migration/resolve", base(&space)),
            Some(&body),
        )?;
        let next = match resolution {
            MigrationResolution::CancelUnadvanced => format!(
                "Run `gm timeline migrate {slug}` to convert, then renew checkpoint and approval."
            ),
            MigrationResolution::AcceptPartialAndAbandon => format!(
                "Successful partial receipts were preserved and the legacy timeline abandoned. Run `gm timeline migrate {slug}` for historical conversion; start a fresh timeline for new work."
            ),
        };
        return Ok(Shown {
            value,
            text: format!("Resolved legacy landing. {next}"),
        });
    }
    if ctx.dry_run {
        return Ok(Shown {
            value: json!({"dry_run": true, "timeline": slug}),
            text: format!(
                "Would migrate {slug} to owned work sources; unresolved landings block conversion."
            ),
        });
    }
    let value = remote::api(
        &config,
        "POST",
        &format!("{}/{slug}/migrate", base(&space)),
        Some(&json!({})),
    )?;
    let next = if ended(&value).is_some() {
        "Historical source provenance is recorded. Start a fresh timeline for new work.".to_string()
    } else {
        format!(
            "Run `gm timeline use {slug}` to fetch its owned source, then create a new checkpoint and renew approval."
        )
    };
    Ok(Shown {
        value,
        text: format!("Migrated {slug}. {next}"),
    })
}

// ---- update ----------------------------------------------------------------------

/// The fields `update` sends: a name, and the experimental flag set or cleared.
fn update_body(args: &UpdateArgs) -> Result<Map<String, Value>> {
    let mut body = Map::new();
    if let Some(name) = &args.name {
        if name.trim().is_empty() {
            return Err(GmError::usage("A timeline's name can't be empty."));
        }
        body.insert("name".into(), json!(name.trim()));
    }
    if args.experimental || args.no_experimental {
        body.insert("experimental".into(), json!(args.experimental));
    }
    if body.is_empty() {
        return Err(GmError::usage("Nothing to change.")
            .hint("Pass --name, --experimental or --no-experimental."));
    }
    Ok(body)
}

fn update_text(slug: &str, body: &Map<String, Value>) -> String {
    let mut lines = Vec::new();
    if let Some(name) = body.get("name").and_then(Value::as_str) {
        lines.push(format!("Timeline {slug} is now named {name}."));
    }
    match body.get("experimental").and_then(Value::as_bool) {
        Some(true) => lines.push(format!(
            "Timeline {slug} is experimental: not expected to land, so stalled views leave it out. Its work still merges anywhere."
        )),
        Some(false) => lines.push(format!(
            "Timeline {slug} is no longer experimental: stalled views count it again."
        )),
        None => {}
    }
    lines.join("\n")
}

fn update(ctx: &Ctx, args: &UpdateArgs) -> Result<Shown> {
    let slug = named_or_current(&args.slug, "update")?;
    let body = update_body(args)?;
    let config = Config::load();
    let space = space(ctx, &config, args.space.space.clone())?;
    if ctx.dry_run {
        let record = fetch_record(&config, &space, &slug)?;
        return Ok(Shown {
            text: format!(
                "dry run: nothing was changed\nWould update:\n{}",
                update_text(&slug, &body)
            ),
            value: json!({ "dry_run": true, "space": space, "timeline": record, "request": body }),
        });
    }
    let timeline = remote::api(
        &config,
        "PATCH",
        &format!("{}/{slug}", base(&space)),
        Some(&Value::Object(body.clone())),
    )?;
    Ok(Shown {
        text: update_text(&slug, &body),
        value: json!({ "dry_run": false, "space": space, "timeline": timeline }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revivals_say_what_started_and_that_it_is_a_rebuild() {
        let value = json!({
            "checkpoint": {
                "checkpoint": {
                    "number": 3,
                    "repos": [
                        {"id": "r1", "space": "orbit", "name": "app"},
                        {"id": "r2", "space": "orbit", "name": "lib"}
                    ]
                },
                "timeline": {"slug": "search-v2"}
            },
            "runs": [
                {"repoId": "r1", "number": 41, "runId": "x"},
                {"repoId": "r2", "skipped": "doesn't opt in to previews (on: preview)."}
            ]
        });
        let text = revival_text(&value);
        assert!(text.starts_with("Reviving the preview of checkpoint #3 of search-v2:"));
        assert!(text.contains("orbit/app: CI #41 builds it"));
        assert!(text.contains("orbit/lib: not started: doesn't opt in"));
        assert!(text.contains("marked rebuilt"));
    }

    #[test]
    fn checkpoints_mark_rebuilt_previews() {
        let view = json!({
            "checkpoint": {"number": 1, "id": "cp_1", "repos": [{"id": "r1", "space": "o", "name": "a", "commit": "abc", "base": null, "changes": []}]},
            "timeline": {"slug": "s"},
            "runs": [],
            "previews": [
                {"repoId": "r1", "url": "https://p.example", "status": "active", "revived": true},
                {"repoId": "r1", "url": null, "status": "expired", "revived": false}
            ]
        });
        let text = checkpoint_text(&view);
        assert!(text.contains("https://p.example (active, rebuilt)"));
        assert!(text.contains("preview expired"));
    }

    #[test]
    fn landings_read_as_their_state_and_merges() {
        let l = json!({
            "checkpointNumber": 3, "trigger": "approval", "state": "conflict",
            "reason": "Checkpoint #3 conflicts with orbit/app's main.",
            "repos": [{
                "space": "orbit", "name": "app", "state": "conflict",
                "commit": "a".repeat(40), "base": "b".repeat(40), "merge": null,
                "mergeRun": {"id": "r", "number": 12}, "gateRun": null,
            }],
        });
        let text = landing_text(&l);
        assert!(
            text.starts_with("Landing  : checkpoint #3 (approval), stopped: conflicts with main"),
            "{text}"
        );
        assert!(text.contains("orbit/app"), "{text}");
        assert!(
            text.contains("aaaaaaaaaaaa onto bbbbbbbbbbbb  (merge run #12)"),
            "{text}"
        );
        assert!(text.contains("conflicts with orbit/app's main"));
        let e = json!({"kind": "landing", "seq": 9, "number": 3, "outcome": "partly_landed", "note": null, "createdAt": "t"});
        assert!(event_line(&e).ends_with("landing checkpoint #3: partly landed"));
    }

    #[test]
    fn lists_mark_the_current_timeline() {
        let t = json!({
            "slug": "search-v2", "name": "Search v2", "status": "active", "policy": "approval",
            "experimental": true, "repos": [{"space": "orbit", "name": "engine", "bookmark": "timeline/search-v2"}],
        });
        let text = line(&t, Some("search-v2"));
        assert!(text.starts_with("* search-v2"), "{text}");
        assert!(text.contains("approval, experimental"));
        assert!(text.contains("orbit/engine") && text.contains("(Search v2)"));
        assert!(line(&t, None).starts_with("  search-v2"));
        assert!(describe(&t).contains("Repo     : orbit/engine on timeline/search-v2"));
    }

    #[test]
    fn issues_say_where_they_are_done() {
        let t = json!({"id": "tl_1", "slug": "search"});
        let issues = json!([
            {"key": "ENG-1", "title": "Index", "status": "done_in_timeline",
             "doneIn": {"id": "tl_1", "slug": "search"}},
            {"key": "ENG-2", "title": "Rank", "status": "done_in_timeline",
             "doneIn": {"id": "tl_2", "slug": "ui"}},
            {"key": "ENG-3", "title": "Own", "status": "in_progress", "doneIn": null},
        ]);
        let text = issues_text(&t, &issues);
        assert!(text.starts_with("Issues   :\n"), "{text}");
        assert!(text.contains("ENG-1      done here, not landed"), "{text}");
        assert!(text.contains("ENG-2      done in ui"), "{text}");
        assert!(text.contains("ENG-3      in progress"), "{text}");
        // Older servers send no issues.
        assert_eq!(issues_text(&t, &Value::Null), "");
        let abandoned = json!({"id": "tl_1", "slug": "search", "status": "abandoned"});
        let issues = json!([{"key": "ENG-1", "title": "Index", "status": "done", "doneIn": null}]);
        assert!(issues_text(&abandoned, &issues).contains("ENG-1      done here, abandoned"));
    }

    #[test]
    fn events_read_as_a_history() {
        let fork = json!({"seq": 3, "kind": "fork", "parentId": null, "createdAt": "2026-10-02"});
        assert!(event_line(&fork).contains("fork from main"));
        let merge = json!({"seq": 9, "kind": "merge", "fromId": null, "intoId": "tl_1",
            "commit": "0123456789abcdef0123", "createdAt": "2026-10-03"});
        assert!(event_line(&merge).contains("merge main -> tl_1 at 0123456789ab"));
        let superseded = json!({"seq": 12, "kind": "approval", "number": 2,
            "outcome": "superseded", "createdAt": "2026-10-03"});
        assert!(event_line(&superseded).contains("checkpoint #2 superseded"));
    }

    #[test]
    fn update_sends_only_what_changes() {
        let args = |name: Option<&str>, on: bool, off: bool| UpdateArgs {
            slug: None,
            name: name.map(str::to_string),
            experimental: on,
            no_experimental: off,
            space: Space { space: None },
        };
        let flagged = update_body(&args(None, true, false)).unwrap();
        assert_eq!(
            Value::Object(flagged.clone()),
            json!({"experimental": true})
        );
        assert!(update_text("probe", &flagged).contains("stalled views leave it out"));
        let cleared = update_body(&args(Some(" Probe "), false, true)).unwrap();
        assert_eq!(
            Value::Object(cleared.clone()),
            json!({"name": "Probe", "experimental": false})
        );
        assert!(update_text("probe", &cleared).contains("no longer experimental"));
        assert_eq!(
            update_body(&args(None, false, false)).unwrap_err().code,
            "invalid_argument"
        );
        assert!(update_body(&args(Some("  "), false, false)).is_err());
    }

    #[test]
    fn slugs_follow_the_servers_rule() {
        assert!(slug_arg("search-v2").is_ok());
        assert_eq!(slug_arg("main").unwrap_err().code, "invalid_argument");
        assert!(slug_arg("Search").is_err());
    }
}
