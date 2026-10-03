//! Commands that talk to the Gitmatrix git endpoint: clone, fetch, sync, push.

mod progress;

use super::{Ctx, Outcome, mutate, report, short};
use crate::cli;
use crate::model::{Change, Json, OpResult};
use crate::output::{GmError, Render, Result, exit};
use crate::remote::{self, Config};
use crate::repo::{Graph, Rebased, Workspace, revset};
use git2::Oid;
use serde::Serialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::Path;

fn workdir(ws: &Workspace) -> &Path {
    ws.repo
        .workdir()
        .expect("gm repos have a working directory")
}

fn require_origin(ws: &Workspace) -> Result<()> {
    if ws.repo.find_remote("origin").is_err() {
        return Err(GmError::new("no_remote", "This repository has no `origin` remote.")
            .hint("Add one: `git remote add origin <server>/<owner>/<repo>.git`, or create the repo with `gm repo create`.")
            .exit(exit::CONFLICT));
    }
    Ok(())
}

fn fetch_origin(ws: &Workspace, config: &Config) -> Result<()> {
    require_origin(ws)?;
    let output = remote::git(
        config,
        workdir(ws),
        &["fetch", "origin", "--prune", "--quiet"],
    )?;
    if !output.status.success() {
        return Err(remote::git_failure("Fetch", &output));
    }
    Ok(())
}

/// A checkout bound to a timeline works on its bookmark. If origin doesn't
/// have it (abandoned, landed and removed, or not fetched yet), syncing or
/// pushing would aim at main instead, so both stop and say why.
fn require_timeline(ws: &Workspace) -> Result<()> {
    if let Some(slug) = &ws.timeline
        && !ws.on_timeline()
    {
        return Err(GmError::new(
            "timeline_missing",
            format!("This checkout works in timeline {slug}, but origin has no timeline/{slug}."),
        )
        .hint(format!(
            "`gm fetch` if it's new. Otherwise it may have been abandoned: `gm timeline show {slug}`. Go back to main with `gm timeline use main`."
        ))
        .exit(exit::CONFLICT));
    }
    Ok(())
}

// ---- clone ------------------------------------------------------------------

#[derive(Serialize, schemars::JsonSchema)]
pub struct Cloned {
    pub repository: String,
    pub directory: String,
    pub url: String,
    pub working_copy: Change,
}

impl Render for Cloned {
    fn text(&self) -> String {
        format!(
            "Cloned {} into {}.\nWorking copy: {}",
            self.repository,
            self.directory,
            self.working_copy.line()
        )
    }
}

pub fn clone(ctx: &Ctx, args: &cli::CloneArgs) -> Result<Cloned> {
    let config = Config::load();
    let repository = args.repository.trim_end_matches(".git").trim_matches('/');
    let Some((_, name)) = repository.split_once('/') else {
        return Err(GmError::usage(
            "Name the repository as owner/name, e.g. `gm clone orbit/engine`.",
        ));
    };
    let url = format!("{}/{}.git", config.server(), repository);
    let directory = args.directory.clone().unwrap_or_else(|| name.into());
    let target = ctx.cwd.join(&directory);
    if target.exists() && std::fs::read_dir(&target)?.next().is_some() {
        return Err(GmError::new(
            "directory_not_empty",
            format!("{} already exists and isn't empty.", target.display()),
        )
        .hint("Pass another directory: `gm clone <owner>/<name> <dir>`.")
        .exit(exit::CONFLICT));
    }
    if ctx.dry_run {
        return Err(GmError::usage("`gm clone` doesn't support --dry-run."));
    }
    let mut progress = progress::Progress::new(ctx.format, args.quiet);
    progress.stage(
        "connecting",
        &format!("Cloning {repository} into {}...", target.display()),
    );
    let output = remote::git_progress(
        &config,
        &ctx.cwd,
        &[
            "clone",
            if args.quiet { "--quiet" } else { "--progress" },
            &url,
            &target.to_string_lossy(),
        ],
        |message| progress.git(message),
    )?;
    if !output.status.success() {
        return Err(remote::git_failure("Clone", &output));
    }
    progress.stage("initializing", "Initializing the Gitmatrix workspace...");
    let ws = Workspace::init(&target)?;
    let cloned = Cloned {
        repository: repository.to_string(),
        directory: target.to_string_lossy().into_owned(),
        url,
        working_copy: Change::load(&ws, ws.wc())?,
    };
    progress.stage("complete", "Clone complete.");
    Ok(cloned)
}

// ---- fetch / sync -------------------------------------------------------------

pub fn fetch(ctx: &Ctx) -> Result<Json> {
    let config = Config::load();
    let mut ws = Workspace::open(&ctx.cwd)?;
    let before = ws.trunk.as_ref().map(|t| t.oid);
    fetch_origin(&ws, &config)?;
    ws.refresh_trunk()?;
    let after = ws.trunk.as_ref().map(|t| t.oid);
    Ok(Json(json!({
        "trunk": after.map(|a| json!({
            "name": ws.trunk.as_ref().map(|t| t.refname.trim_start_matches("refs/remotes/").to_string()),
            "before": before.map(crate::repo::ids::short_commit),
            "after": crate::repo::ids::short_commit(a),
            "moved": before != Some(a),
        })),
        "hint": if before != after { Some("Run `gm sync` to rebase your changes onto the new trunk.") } else { None },
    })))
}

/// Fetch, then move every stack of changes that was built on trunk onto the
/// new trunk. Changes that landed in trunk meanwhile are dropped, including
/// the ones a landing merge brought in through its other parents.
fn sync_in(ws: &mut Workspace, config: &Config) -> Result<(String, Vec<Oid>, Rebased)> {
    let old_trunk = ws.trunk.as_ref().map(|t| t.oid);
    let old_graph = ws.graph()?;
    let roots: Vec<Oid> = old_graph
        .topo
        .iter()
        .copied()
        .filter(|o| {
            ws.commit(*o)
                .map(|c| c.parent_ids().all(|p| !old_graph.topo.contains(&p)))
                .unwrap_or(false)
        })
        .collect();
    fetch_origin(ws, config)?;
    ws.refresh_trunk()?;
    require_timeline(ws)?;
    let Some(trunk) = ws.trunk.as_ref().map(|t| (t.oid, t.name.clone())) else {
        return Ok((
            "Fetched; the remote has no trunk yet.".into(),
            Vec::new(),
            Rebased::default(),
        ));
    };
    let (new_trunk, trunk_name) = trunk;

    // Change ids that arrived in trunk: our copies of them are now duplicates.
    let mut landed = HashSet::new();
    if let Some(old) = old_trunk
        && old != new_trunk
    {
        let mut walk = ws.repo.revwalk()?;
        walk.push(new_trunk)?;
        walk.hide(old)?;
        for oid in walk.take(5000) {
            landed.insert(ws.change_id(&ws.commit(oid?)?));
        }
    }

    let mut abandoned = HashMap::new();
    let mut roots = roots;
    let graph = ws.graph()?;
    for oid in &graph.topo {
        let commit = ws.commit(*oid)?;
        let parents: Vec<Oid> = commit.parent_ids().collect();
        let root = parents.iter().all(|p| !graph.topo.contains(p));
        if landed.contains(&ws.change_id(&commit)) && *oid != ws.wc() {
            // What was built on a landed root of trunk's history follows trunk
            // to where the change landed, not back to the base it started from.
            let on_trunk = parents
                .iter()
                .all(|p| ws.repo.graph_descendant_of(new_trunk, *p).unwrap_or(false));
            let onto = if root && on_trunk {
                ws.parents_onto(*oid, new_trunk)?
            } else {
                parents
            };
            abandoned.insert(*oid, onto);
        } else if root && !roots.contains(oid) {
            // A landing merge brings a timeline's commits into trunk as they
            // are, so they turn immutable: what was built on them is a stack
            // on trunk's history now, like any other.
            roots.push(*oid);
        }
    }

    let mut rewritten = HashMap::new();
    let mut moved = Vec::new();
    let mut root_conflicts = Vec::new();
    for root in roots {
        if ws.is_immutable(root)? || abandoned.contains_key(&root) {
            continue;
        }
        let commit = ws.commit(root)?;
        let parents: Vec<Oid> = commit.parent_ids().collect();
        let onto = ws.parents_onto(root, new_trunk)?;
        if parents == onto {
            continue;
        }
        // Only stacks that were built on trunk's history follow trunk.
        let on_trunk = parents.iter().all(|p| {
            *p == new_trunk || ws.repo.graph_descendant_of(new_trunk, *p).unwrap_or(false)
        });
        if !on_trunk || merged_trunk(ws, &graph, root, new_trunk)? {
            continue;
        }
        let (tree, conflicts) = ws.rebased_tree(&commit, &onto)?;
        let new = ws.rewrite_commit(&commit, &onto, tree, None)?;
        let change_id = ws.change_id(&commit);
        drop(commit);
        if !conflicts.is_empty() {
            ws.view
                .conflicts
                .insert(change_id.clone(), conflicts.clone());
            root_conflicts.push((change_id, conflicts));
        }
        rewritten.insert(root, new);
        moved.push(new);
    }
    let dropped = abandoned.len();
    let mut rebased = ws.rebase_descendants(rewritten, abandoned)?;
    rebased.conflicts.extend(root_conflicts);

    // A local trunk bookmark follows the remote one when it can fast-forward.
    if let Some(local) = ws
        .view
        .bookmarks
        .get(&trunk_name)
        .and_then(|t| Oid::from_str(t).ok())
        && local != new_trunk
        && ws.repo.graph_descendant_of(new_trunk, local)?
    {
        ws.view
            .bookmarks
            .insert(trunk_name.clone(), new_trunk.to_string());
    }
    ws.normalize_heads()?;

    let mut message = match old_trunk {
        Some(old) if old == new_trunk => format!("Fetched; {trunk_name} hasn't moved."),
        Some(old) => format!(
            "Fetched; {trunk_name} moved {} -> {}.",
            &old.to_string()[..12],
            &new_trunk.to_string()[..12]
        ),
        None => format!(
            "Fetched; {trunk_name} is at {}.",
            &new_trunk.to_string()[..12]
        ),
    };
    if !moved.is_empty() {
        message.push_str(&format!(" Rebased {} stack(s) onto it.", moved.len()));
    }
    if dropped > 0 {
        message.push_str(&format!(
            " Dropped {dropped} change(s) that already landed."
        ));
    }
    let moved = moved
        .iter()
        .map(|o| revset::resolve(ws, &short(ws, *o)).unwrap_or(*o))
        .collect();
    Ok((message, moved, rebased))
}

/// Whether every line built on `root` already merged `trunk` in (`gm merge
/// trunk`): such a stack is up to date, and sync leaves its merges alone.
fn merged_trunk(ws: &Workspace, graph: &Graph, root: Oid, trunk: Oid) -> Result<bool> {
    let mut queue = vec![root];
    let mut seen = HashSet::new();
    while let Some(oid) = queue.pop() {
        if !seen.insert(oid) {
            continue;
        }
        match graph.children.get(&oid).filter(|c| !c.is_empty()) {
            Some(children) => queue.extend(children),
            None => {
                if !ws.repo.graph_descendant_of(oid, trunk)? {
                    return Ok(false);
                }
            }
        }
    }
    Ok(true)
}

pub fn sync(ctx: &Ctx) -> Result<OpResult> {
    let config = Config::load();
    mutate(ctx, |ws| {
        let (message, moved, rebased) = sync_in(ws, &config)?;
        Ok(Outcome::new(message, moved, rebased))
    })
}

// ---- push ------------------------------------------------------------------------

#[derive(Serialize, schemars::JsonSchema)]
pub struct Pushed {
    pub dry_run: bool,
    /// Bookmark that was updated on the server.
    pub bookmark: String,
    pub remote_ref: String,
    /// Changes the push sent, newest first.
    pub pushed: Vec<Change>,
    pub message: String,
    pub working_copy: Change,
    pub operation: Option<String>,
}

impl Render for Pushed {
    fn text(&self) -> String {
        let mut out = String::new();
        if self.dry_run {
            out.push_str("dry run: nothing was pushed\n");
        }
        out.push_str(&self.message);
        out.push('\n');
        for c in &self.pushed {
            out.push_str(&format!("  {}\n", c.line()));
        }
        out.push_str(&format!("Working copy: {}", self.working_copy.line()));
        out
    }
}

pub fn push(ctx: &Ctx, args: &cli::PushArgs) -> Result<Pushed> {
    let config = Config::load();
    let mut ws = Workspace::open(&ctx.cwd)?;
    require_origin(&ws)?;
    let mut sync_note = String::new();
    if args.sync {
        let (msg, _, rebased) = sync_in(&mut ws, &config)?;
        if !rebased.conflicts.is_empty() {
            if !ctx.dry_run {
                ws.finish(&format!("{} (sync)", ctx.argv))?;
            }
            return Err(GmError::new(
                "has_conflicts",
                "Syncing onto the latest trunk left conflicts; nothing was pushed.",
            )
            .hint("Resolve the conflict markers shown by `gm status`, then `gm push`.")
            .exit(exit::CONFLICT));
        }
        sync_note = format!("{msg} ");
    }
    // In a checkout bound to a timeline, trunk is the timeline's bookmark:
    // a plain `gm push` goes there, and main is never pushed to directly.
    require_timeline(&ws)?;
    let trunk_name = ws
        .trunk
        .as_ref()
        .map(|t| t.name.clone())
        .unwrap_or_else(|| "main".into());
    let bookmark = args.bookmark.clone().unwrap_or_else(|| trunk_name.clone());
    let to_trunk = bookmark == trunk_name;
    if let Some(slug) = &ws.timeline {
        let main = ws.main().map(|m| m.name.as_str()).unwrap_or("main");
        if bookmark == main {
            return Err(GmError::new(
                "timeline_bound",
                format!("This checkout works in timeline {slug}, so it never pushes to {main}."),
            )
            .hint(format!(
                "`gm push` sends your changes to timeline/{slug}; they reach {main} when the timeline lands. To work on {main} instead, `gm timeline use main`."
            ))
            .exit(exit::CONFLICT));
        }
    }

    let wc = ws.wc();
    let rev = match &args.revision {
        Some(spec) => revset::resolve(&ws, spec)?,
        None => {
            let c = ws.commit(wc)?;
            match (ws.is_untouched(&c)?, c.parent_id(0)) {
                (true, Ok(parent)) => parent,
                _ => wc,
            }
        }
    };

    // What goes out: rev and its ancestors that aren't in trunk yet.
    let mut outgoing = Vec::new();
    let mut walk = ws.repo.revwalk()?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL)?;
    walk.push(rev)?;
    if let Some(t) = &ws.trunk {
        walk.hide(t.oid)?;
        if let Some(main) = &t.main {
            walk.hide(main.oid)?;
        }
    }
    for oid in walk.take(1000) {
        outgoing.push(oid?);
    }
    if outgoing.is_empty() && to_trunk {
        let result = Pushed {
            dry_run: ctx.dry_run,
            bookmark: bookmark.clone(),
            remote_ref: format!("refs/heads/{bookmark}"),
            pushed: Vec::new(),
            message: format!("{sync_note}Nothing to push: {bookmark} already has everything."),
            working_copy: Change::load(&ws, wc)?,
            operation: if ctx.dry_run {
                None
            } else {
                ws.finish(&ctx.argv)?
            },
        };
        return Ok(result);
    }
    let mut undescribed = Vec::new();
    let mut conflicted = Vec::new();
    for oid in &outgoing {
        let c = ws.commit(*oid)?;
        if Workspace::description(&c).trim().is_empty() {
            undescribed.push(short(&ws, *oid));
        }
        if !ws.conflicts_of(&ws.change_id(&c)).is_empty() {
            conflicted.push(short(&ws, *oid));
        }
    }
    if !undescribed.is_empty() {
        let first = &undescribed[0];
        return Err(GmError::new(
            "missing_description",
            format!(
                "These changes have no description: {}.",
                undescribed.join(", ")
            ),
        )
        .hint(
            if outgoing[0] == wc && undescribed.contains(&short(&ws, wc)) {
                "Commit the working copy: `gm commit -m \"...\"`.".to_string()
            } else {
                format!("Describe them first: `gm describe {first} -m \"...\"`.")
            },
        )
        .exit(exit::CONFLICT));
    }
    if !conflicted.is_empty() {
        return Err(GmError::new(
            "has_conflicts",
            format!(
                "These changes still have conflict markers: {}.",
                conflicted.join(", ")
            ),
        )
        .hint("Resolve them (`gm status` lists the files), then push again.")
        .exit(exit::CONFLICT));
    }

    let remote_tracking = format!("refs/remotes/origin/{bookmark}");
    let remote_oid = ws
        .repo
        .find_reference(&remote_tracking)
        .ok()
        .and_then(|r| r.target());
    if to_trunk
        && let Some(remote) = remote_oid
        && remote != rev
        && !ws.repo.graph_descendant_of(rev, remote)?
    {
        return Err(GmError::new("remote_moved", format!("{bookmark} has changes you don't have yet, so this push wouldn't be a fast-forward."))
                    .hint("Run `gm push --sync` to rebase onto it and push, or `gm sync` first.")
                    .exit(exit::CONFLICT));
    }

    let pushed: Vec<Change> = outgoing
        .iter()
        .map(|o| Change::load(&ws, *o))
        .collect::<Result<_>>()?;
    let summary = format!(
        "{sync_note}Pushed {} change(s) to {bookmark}.",
        pushed.len()
    );
    if ctx.dry_run {
        let working_copy = Change::load(&ws, wc)?;
        ws.discard();
        return Ok(Pushed {
            dry_run: true,
            bookmark: bookmark.clone(),
            remote_ref: format!("refs/heads/{bookmark}"),
            pushed,
            message: summary.replace("Pushed", "Would push"),
            working_copy,
            operation: None,
        });
    }

    let refspec = format!("{rev}:refs/heads/{bookmark}");
    let lease = format!(
        "--force-with-lease=refs/heads/{bookmark}:{}",
        remote_oid.map(|o| o.to_string()).unwrap_or_default()
    );
    let mut git_args = vec!["push", "--quiet", "origin", refspec.as_str()];
    if !to_trunk {
        git_args.insert(1, lease.as_str());
    }
    let output = remote::git(&config, workdir(&ws), &git_args)?;
    if !output.status.success() {
        return Err(remote::git_failure("Push", &output));
    }

    ws.repo.reference(&remote_tracking, rev, true, "gm push")?;
    if ws.repo.find_reference("refs/remotes/origin/HEAD").is_err() && to_trunk && !ws.on_timeline()
    {
        let _ = ws.repo.reference_symbolic(
            "refs/remotes/origin/HEAD",
            &remote_tracking,
            true,
            "gm push",
        );
    }
    ws.view.bookmarks.insert(bookmark.clone(), rev.to_string());
    ws.refresh_trunk()?;
    // What's on trunk is immutable now; keep working in a fresh change on top.
    if ws.is_immutable(wc)? {
        let tree = ws.commit(wc)?.tree_id();
        let next = ws.new_commit(&[wc], tree, "")?;
        ws.view.wc = next.to_string();
    }
    ws.normalize_heads()?;
    let operation = ws.finish(&ctx.argv)?;
    let pushed = outgoing
        .iter()
        .map(|o| Change::load(&ws, *o))
        .collect::<Result<_>>()?;
    Ok(Pushed {
        dry_run: false,
        bookmark: bookmark.clone(),
        remote_ref: format!("refs/heads/{bookmark}"),
        pushed,
        message: summary,
        working_copy: Change::load(&ws, ws.wc())?,
        operation,
    })
}

pub fn bookmark_delete(ctx: &Ctx, name: &str, remote: bool) -> Result<OpResult> {
    let config = Config::load();
    let mut ws = Workspace::open(&ctx.cwd)?;
    let has_local = ws.view.bookmarks.contains_key(name);
    if has_local {
        super::local::bookmark_delete_local(&mut ws, name)?;
    } else if !remote {
        return Err(GmError::not_found(
            "bookmark_not_found",
            format!("No bookmark `{name}`."),
        ));
    }
    let mut message = format!("Deleted bookmark {name}");
    if remote && !ctx.dry_run {
        require_origin(&ws)?;
        let refspec = format!(":refs/heads/{name}");
        let output = remote::git(
            &config,
            workdir(&ws),
            &["push", "--quiet", "origin", &refspec],
        )?;
        if !output.status.success() {
            return Err(remote::git_failure("Deleting the remote bookmark", &output));
        }
        if let Ok(mut r) = ws
            .repo
            .find_reference(&format!("refs/remotes/origin/{name}"))
        {
            r.delete()?;
        }
        message.push_str(" here and on the server");
    }
    message.push('.');
    let operation = if ctx.dry_run {
        None
    } else {
        ws.finish(&ctx.argv)?
    };
    let result = report(
        &ws,
        Outcome::new(message, Vec::new(), Rebased::default()),
        operation,
        ctx.dry_run,
    )?;
    if ctx.dry_run {
        ws.discard();
    }
    Ok(result)
}
