//! Commands that talk to the Timelines git endpoint: clone, fetch, sync, push.

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

/// A bound checkout never falls back to canonical main when its source ref is absent.
fn require_timeline(ws: &Workspace) -> Result<()> {
    if let Some(slug) = &ws.timeline
        && !ws.on_timeline()
    {
        return Err(GmError::new(
            "timeline_missing",
            format!("This checkout works in timeline {slug}, but its owned source has not been fetched."),
        )
        .hint(format!(
            "`gm fetch` to fetch the source, or inspect `gm timeline show {slug}`. Explicitly go back to main with `gm timeline use main`."
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
            "Name the repository as space/name, e.g. `gm clone orbit/engine`.",
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
    progress.stage("initializing", "Initializing the Timelines workspace...");
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
    if let Some(slug) = &ws.timeline {
        super::timeline::fetch_work(ctx, &config, slug)?;
    }
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

/// A compact landing admits exact objects, not every revision sharing a change id.
fn sync_ended_source(
    ws: &mut Workspace,
    config: &Config,
    ctx: &Ctx,
    source: &super::timeline::WorkSource,
) -> Result<(String, Vec<Oid>, Rebased)> {
    let slug = ws.timeline.as_deref().expect("bound source");
    let anchor = ws
        .repo
        .find_reference(&format!("refs/remotes/gm-work/timeline/{slug}"))?
        .peel_to_commit()?
        .id();
    let repo = super::server::current_repo(ctx)?;
    let lineage = remote::api(
        config,
        "GET",
        &format!(
            "/repos/{repo}/sources/{}/lineage?commit={anchor}",
            source.id
        ),
        None,
    )?;
    match lineage["status"].as_str() {
        Some("integrated") => {}
        Some("expired") => {
            return Err(GmError::new(
                "source_expired",
                "Source retention has expired; automatic lineage sync is unavailable.",
            )
            .hint("Local work is intact. Recover it explicitly onto a new timeline."));
        }
        _ => {
            return Err(GmError::new(
                "source_lineage_unresolved",
                "No unique exact integration receipt exists for this source anchor.",
            )
            .hint("Local work is intact; inspect the timeline landing before retrying.")
            .exit(exit::CONFLICT));
        }
    }
    let anchor_text = anchor.to_string();
    if !lineage["members"].as_array().is_some_and(|members| {
        members
            .iter()
            .any(|m| m.as_str() == Some(anchor_text.as_str()))
    }) {
        return Err(GmError::new(
            "invalid_response",
            "Lineage response did not admit the requested exact source anchor.",
        ));
    }
    let oid = |field: &serde_json::Value| -> Result<Oid> {
        Oid::from_str(field.as_str().ok_or_else(|| {
            GmError::new(
                "invalid_response",
                "Lineage snapshot is missing its commit.",
            )
        })?)
        .map_err(Into::into)
    };
    let admitted = oid(&lineage["integration"]["source"]["commit"])?;
    let base = oid(&lineage["integration"]["logicalBase"]["commit"])?;
    let canonical = oid(&lineage["canonical"]["commit"])?;
    if lineage["integration"]["source"]["sourceId"].as_str() != Some(source.id.as_str())
        || !(anchor == admitted || ws.repo.graph_descendant_of(admitted, anchor)?)
    {
        return Err(GmError::new(
            "invalid_response",
            "Lineage receipt does not cover this source.",
        ));
    }
    ws.commit(canonical)?;
    let graph = ws.graph()?;
    let mut walk = ws.repo.revwalk()?;
    walk.push(admitted)?;
    walk.hide(base)?;
    let mut exact = HashSet::new();
    let mut revisions: HashMap<String, Vec<Oid>> = HashMap::new();
    for oid in walk {
        let oid = oid?;
        exact.insert(oid);
        revisions
            .entry(ws.change_id(&ws.commit(oid)?))
            .or_default()
            .push(oid);
    }
    // A receipt for the remote tip is not proof that the local stack belongs to
    // it. Refuse a divergent checkout before rewriting any object or bookmark.
    let mut local_walk = ws.repo.revwalk()?;
    local_walk.push(ws.wc())?;
    local_walk.hide(base)?;
    let mut related = ws.wc() == canonical || ws.repo.graph_descendant_of(ws.wc(), canonical)?;
    for oid in local_walk {
        let oid = oid?;
        if oid == canonical
            || exact.contains(&oid)
            || revisions.contains_key(&ws.change_id(&ws.commit(oid)?))
        {
            related = true;
            break;
        }
    }
    if !related {
        return Err(GmError::new(
            "source_lineage_unresolved",
            "The local stack has no admitted source ancestor or revision.",
        )
        .hint("Local work is intact. Explicitly recover it onto a new timeline.")
        .exit(exit::CONFLICT));
    }
    let mut abandoned: HashMap<Oid, Vec<Oid>> =
        exact.iter().map(|oid| (*oid, vec![canonical])).collect();
    let mut expected = HashMap::new();
    let mut rewritten = HashMap::new();
    let mut conflicts = Vec::new();
    for local in &graph.topo {
        if exact.contains(local) {
            continue;
        }
        let commit = ws.commit(*local)?;
        let candidates = revisions.get(&ws.change_id(&commit));
        let original = candidates.filter(|v| v.len() == 1).map(|v| v[0]);
        if let Some(original) = original {
            let tree = ws.landed_tree_on_local_parents(&commit, original)?;
            expected.insert(*local, tree);
            if *local != ws.wc() && tree == commit.tree_id() {
                abandoned.insert(*local, vec![canonical]);
            } else if commit.parent_ids().all(|p| !graph.topo.contains(&p)) {
                let (tree, paths) = ws.rebased_tree_after_landing(&commit, &[canonical], tree)?;
                let new = ws.rewrite_commit(&commit, &[canonical], tree, None)?;
                let change = ws.change_id(&commit);
                drop(commit);
                rewritten.insert(*local, new);
                if !paths.is_empty() {
                    ws.view.conflicts.insert(change.clone(), paths.clone());
                    conflicts.push((change, paths));
                }
            }
        } else if candidates.is_some_and(|v| v.len() > 1) {
            return Err(GmError::new(
                "source_lineage_ambiguous",
                "Several admitted revisions match a local change; no work was discarded.",
            )
            .hint("Recover the local change explicitly using its exact commit."));
        }
    }
    if !ctx.dry_run {
        ws.repo.reference(
            &format!("refs/gm/source-sync/{}/{}", source.id, ws.wc()),
            ws.wc(),
            true,
            "before compact-source sync",
        )?;
    }
    let mut rebased = ws.rebase_descendants_after_landing(rewritten, abandoned, &expected)?;
    rebased.conflicts.extend(conflicts);
    Ok(("Reconciled exact source lineage onto canonical main. The ended-source push guard remains: explicitly start a new timeline or `gm timeline use main`.".into(), vec![ws.wc()], rebased))
}

/// Fetch, then move every stack of changes that was built on trunk onto the
/// new trunk. Changes that landed in trunk meanwhile are dropped, including
/// the ones a landing merge brought in through its other parents.
fn sync_in(ws: &mut Workspace, config: &Config, ctx: &Ctx) -> Result<(String, Vec<Oid>, Rebased)> {
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
    if let Some(slug) = ws.timeline.clone() {
        let source = super::timeline::fetch_work(ctx, config, &slug)?;
        if source.ended {
            ws.refresh_trunk()?;
            return sync_ended_source(ws, config, ctx, &source);
        }
    }
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

    // A matching change id identifies a possible duplicate, not identical work:
    // queued revisions remain mutable and may have acquired unlanded edits.
    let mut landed = HashMap::new();
    if let Some(old) = old_trunk
        && old != new_trunk
    {
        let mut walk = ws.repo.revwalk()?;
        walk.set_sorting(git2::Sort::TOPOLOGICAL)?;
        walk.push(new_trunk)?;
        walk.hide(old)?;
        for oid in walk.take(5000) {
            let commit = ws.commit(oid?)?;
            landed.entry(ws.change_id(&commit)).or_insert(commit.id());
        }
    }

    // A prior fetch may already have moved the remote bookmark. Durable
    // receipts still identify revisions that sync has not reconciled locally.
    let submissions = ws.store().queue_submissions()?;
    let receipts = if submissions.is_empty() {
        None
    } else {
        submissions.get(&queue_repository(
            config,
            &super::server::current_repo(ctx)?,
        )?)
    };
    for submission in receipts.into_iter().flat_map(|entries| entries.values()) {
        for (change, revision) in &submission.revisions {
            let original = Oid::from_str(revision)?;
            if original == new_trunk || ws.repo.graph_descendant_of(new_trunk, original)? {
                match landed.get(change).copied() {
                    Some(previous) if ws.repo.graph_descendant_of(previous, original)? => {}
                    _ => {
                        landed.insert(change.clone(), original);
                    }
                }
            }
        }
    }
    let mut abandoned = HashMap::new();
    let mut roots = roots;
    let graph = ws.graph()?;
    let mut landed_bases = HashMap::new();
    for oid in &graph.topo {
        let commit = ws.commit(*oid)?;
        let parents: Vec<Oid> = commit.parent_ids().collect();
        let root = parents.iter().all(|p| !graph.topo.contains(p));
        let original = landed
            .get(&ws.change_id(&commit))
            .copied()
            .filter(|original| {
                *original != *oid
                    && !ws
                        .repo
                        .graph_descendant_of(*oid, *original)
                        .unwrap_or(false)
            });
        let expected_tree = original
            .map(|original| ws.landed_tree_on_local_parents(&commit, original))
            .transpose()?;
        if let Some(tree) = expected_tree {
            landed_bases.insert(*oid, tree);
        }
        // Never dedup against bare trunk: a parent's later rebase may add
        // content this child intentionally removes. Only an unchanged
        // admitted revision on the actual local parents is a duplicate.
        let already_landed = *oid != ws.wc() && expected_tree == Some(commit.tree_id());
        if already_landed {
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
        let (tree, conflicts) = match landed_bases.get(&root) {
            Some(expected_tree) => ws.rebased_tree_after_landing(&commit, &onto, *expected_tree)?,
            None => ws.rebased_tree(&commit, &onto)?,
        };
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
    let mut rebased = ws.rebase_descendants_after_landing(rewritten, abandoned, &landed_bases)?;
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
        let (message, moved, rebased) = sync_in(ws, &config, ctx)?;
        Ok(Outcome::new(message, moved, rebased))
    })
}

// ---- push ------------------------------------------------------------------------

/// Queue authority is the configured API server, not just a space/name slug.
/// Canonical host/default-port spelling prevents aliases of that authority
/// from escaping a receipt; the path retains any configured API mount prefix.
fn queue_repository(config: &Config, repo: &str) -> Result<String> {
    let server = config.server();
    let uri: ureq::http::Uri = server
        .parse()
        .map_err(|_| GmError::usage("Queue receipts require a valid server URL."))?;
    let scheme = uri
        .scheme_str()
        .ok_or_else(|| GmError::usage("Queue server URL needs a scheme."))?;
    let host = uri
        .host()
        .ok_or_else(|| GmError::usage("Queue server URL needs a host."))?
        .to_ascii_lowercase();
    let port = uri
        .port_u16()
        .unwrap_or(if scheme == "https" { 443 } else { 80 });
    Ok(format!(
        "{scheme}://{host}:{port}{}/{repo}",
        uri.path().trim_end_matches('/')
    ))
}

/// A pending admission can still publish its pinned tree. A rewritten copy
/// must not race it, even through the ordinary direct-push recovery path.
fn protect_pending_rewrites(
    ws: &mut Workspace,
    config: &Config,
    outgoing: &[Oid],
    ctx: &Ctx,
) -> Result<()> {
    let submissions = ws.store().queue_submissions()?;
    if submissions.is_empty() {
        return Ok(());
    }
    let repo = super::server::current_repo(ctx)?;
    let Some(submissions) = submissions.get(&queue_repository(config, &repo)?) else {
        return Ok(());
    };
    for (source, submission) in submissions {
        let source_oid = Oid::from_str(source)?;
        let mut changed = None;
        for oid in outgoing {
            let change = ws.change_id(&ws.commit(*oid)?);
            if let Some(original) = submission.revisions.get(&change)
                && original != &oid.to_string()
                && !ws.repo.graph_descendant_of(*oid, source_oid)?
            {
                let original = ws.commit(Oid::from_str(original)?)?;
                let parents: Vec<Oid> = original.parent_ids().collect();
                let (tree, conflicts) = ws.rebased_tree(&ws.commit(*oid)?, &parents)?;
                if tree != original.tree_id() || !conflicts.is_empty() {
                    changed = Some(change);
                    break;
                }
            }
        }
        let Some(change) = changed else {
            continue;
        };
        // Do not discard a just-snapshotted rewrite when the safety check fails.
        ws.finish(&ctx.argv)?;
        let hint = format!(
            "Change {change} rewrites queue admission {source}. Wait for it to land, then `gm sync`; or explicitly `gm queue cancel {source} -R {repo}` before pushing the rewrite. If admission is uncertain/absent, inspect `gm queue show {source} -R {repo}`, retry that exact source if necessary, then cancel it. Unchanged revisions and independent descendants remain pushable."
        );
        let response = remote::api(
            config,
            "GET",
            &format!("/repos/{repo}/queue/{source}"),
            None,
        )
        .map_err(|error| error.hint(hint.clone()))?;
        let entry = super::queue::entry(&response).map_err(|error| error.hint(hint.clone()))?;
        if entry["id"].as_str() != Some(source.as_str()) {
            return Err(GmError::new(
                "invalid_response",
                "Queue lookup returned a different entry.",
            )
            .hint(hint));
        }
        if !matches!(entry["status"].as_str(), Some("failed" | "cancelled")) {
            return Err(GmError::new(
                "queued_revision_rewritten",
                format!(
                    "Change {change} differs from still-unreconciled queue admission {source}."
                ),
            )
            .hint(hint)
            .exit(exit::CONFLICT));
        }
    }
    Ok(())
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct Pushed {
    pub dry_run: bool,
    /// Target bookmark; queue admission does not update it.
    pub bookmark: String,
    pub remote_ref: String,
    /// Changes the push sent, newest first.
    pub pushed: Vec<Change>,
    pub message: String,
    pub working_copy: Change,
    pub operation: Option<String>,
    /// Accepted asynchronous admission, not proof of landing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue: Option<serde_json::Value>,
    /// Step context uploaded for the pushed changes (CORE-232), when any was journaled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steps: Option<super::steps::Uploads>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
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
        if let Some(steps) = &self.steps
            && steps.uploaded > 0
        {
            out.push_str(&format!(
                "Uploaded context for {} step(s).\n",
                steps.uploaded
            ));
        }
        for warning in &self.warnings {
            out.push_str(&format!("warning: {warning}\n"));
        }
        out.push_str(&format!("Working copy: {}", self.working_copy.line()));
        out
    }
}

pub fn push(ctx: &Ctx, args: &cli::PushArgs) -> Result<Pushed> {
    let config = Config::load();
    let mut ws = Workspace::open(&ctx.cwd)?;
    require_origin(&ws)?;
    if args.queue && ws.timeline.is_some() {
        return Err(GmError::new(
            "timeline_bound",
            "Queued main pushes are not allowed in a timeline.",
        )
        .hint("Use timeline checkpoint/land; explicitly `gm timeline use main` for main work.")
        .exit(exit::CONFLICT));
    }
    let source = ws
        .timeline
        .as_deref()
        .map(|slug| super::timeline::work_source(ctx, &config, slug))
        .transpose()?;
    if source.as_ref().is_some_and(|s| s.ended) {
        return Err(GmError::new("timeline_ended", "This source is read-only; no push was attempted.")
            .hint("Run `gm sync` to recover local work, then explicitly start a new timeline or `gm timeline use main`.")
            .exit(exit::CONFLICT));
    }
    if args.queue {
        let main = ws.main().map(|m| m.name.as_str()).unwrap_or("main");
        if args.bookmark.as_deref().is_some_and(|name| name != main) {
            return Err(GmError::usage(
                "`gm push --queue` targets only the repository's default branch; omit --bookmark.",
            ));
        }
    }
    let mut sync_note = String::new();
    if args.sync {
        let (msg, _, rebased) = sync_in(&mut ws, &config, ctx)?;
        // Sync can rewrite local commits. Preserve that completed operation even
        // when subsequent validation, upload or admission fails.
        if args.queue && !ctx.dry_run {
            ws.finish(&format!("{} (sync)", ctx.argv))?;
        }
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
    if source.is_some() && !to_trunk {
        return Err(GmError::new(
            "timeline_bound",
            "A bound work source accepts only its work bookmark; omit --bookmark.",
        )
        .exit(exit::CONFLICT));
    }
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
    if outgoing.is_empty() && to_trunk && !args.queue {
        let result = Pushed {
            dry_run: ctx.dry_run,
            queue: None,
            bookmark: bookmark.clone(),
            remote_ref: if source.is_some() {
                "refs/heads/work".into()
            } else {
                format!("refs/heads/{bookmark}")
            },
            pushed: Vec::new(),
            message: format!("{sync_note}Nothing to push: {bookmark} already has everything."),
            working_copy: Change::load(&ws, wc)?,
            operation: if ctx.dry_run {
                None
            } else {
                ws.finish(&ctx.argv)?
            },
            steps: None,
            warnings: Vec::new(),
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

    if !ctx.dry_run && to_trunk && !ws.on_timeline() {
        protect_pending_rewrites(&mut ws, &config, &outgoing, ctx)?;
    }

    if args.queue {
        let commit = rev.to_string();
        let source = format!("gitmatrix/queue/{commit}");
        let remote_ref = format!("refs/heads/{source}");
        let pushed = outgoing
            .iter()
            .map(|o| Change::load(&ws, *o))
            .collect::<Result<Vec<_>>>()?;
        let working_copy = Change::load(&ws, ws.wc())?;
        if ctx.dry_run {
            ws.discard();
            return Ok(Pushed {
                dry_run: true,
                bookmark,
                remote_ref,
                pushed,
                working_copy,
                operation: None,
                queue: None,
                steps: None,
                warnings: Vec::new(),
                message: format!(
                    "{sync_note}Would upload {commit} and request queue admission; main would not advance."
                ),
            });
        }
        let repo = super::server::current_repo(ctx)?;
        // Snapshot before any network operation: a lost response must not lose
        // either the admitted commit or the user's unsubmitted working copy.
        let operation = ws.finish(&ctx.argv)?;
        let mut submissions = ws.store().queue_submissions()?;
        let repository = queue_repository(&config, &repo)?;
        let recorded = submissions
            .get(&repository)
            .is_some_and(|entries| entries.contains_key(&commit));
        let repository_hash = Oid::hash_object(git2::ObjectType::Blob, repository.as_bytes())?;
        let receipt_ref = format!("refs/gm/queue/{repository_hash}/{commit}");
        let revisions = outgoing
            .iter()
            .map(|oid| Ok((ws.change_id(&ws.commit(*oid)?), oid.to_string())))
            .collect::<Result<_>>()?;
        // Persist before upload/admission: an uncertain reply remains guarded,
        // and undo cannot erase an already-sent request.
        ws.repo
            .reference(&receipt_ref, rev, true, "retain queue admission")?;
        submissions
            .entry(repository.clone())
            .or_default()
            .entry(commit.clone())
            .or_insert(crate::repo::view::QueueSubmission { revisions });
        ws.store().save_queue_submissions(&submissions)?;
        let mut forget_rejected_submission = || -> Result<()> {
            if !recorded {
                if let Some(entries) = submissions.get_mut(&repository) {
                    entries.remove(&commit);
                    if entries.is_empty() {
                        submissions.remove(&repository);
                    }
                }
                ws.store().save_queue_submissions(&submissions)?;
                ws.repo.find_reference(&receipt_ref)?.delete()?;
            }
            Ok(())
        };
        let hint = format!(
            "Local work is preserved. Admission is not proof of landing. Inspect `gm queue show {commit}`; if absent, retry `gm push --queue -r {commit}` with the same --issue values. Pending step context can be retried with `gm context sync`. Never assume a failed response advanced main."
        );
        let refspec = format!("{commit}:{remote_ref}");
        let output = match remote::git(
            &config,
            workdir(&ws),
            &["push", "--quiet", "origin", &refspec],
        ) {
            Ok(output) => output,
            Err(error) => {
                forget_rejected_submission()?;
                return Err(error.hint(hint));
            }
        };
        if !output.status.success() {
            forget_rejected_submission()?;
            return Err(remote::git_failure("Queue source upload", &output).hint(hint));
        }
        let response = match remote::api(
            &config,
            "POST",
            &format!("/repos/{repo}/queue"),
            Some(&serde_json::json!({"commit": commit, "issues": args.issues})),
        ) {
            Ok(response) => response,
            Err(error) => {
                // These responses reject admission before it can occur. Never
                // erase an earlier uncertain request, nor a 5xx/transport error.
                if matches!(error.code, "not_found" | "unauthenticated" | "forbidden") {
                    forget_rejected_submission()?;
                }
                return Err(error.hint(hint));
            }
        };
        let entry = super::queue::entry(&response).map_err(|error| error.hint(hint.clone()))?;
        if entry["id"].as_str() != Some(commit.as_str()) {
            return Err(GmError::new(
                "invalid_response",
                "Queue admission returned a different commit identity.",
            )
            .hint(hint));
        }
        let (steps, warnings) = upload_push_context(ctx, &config, &ws, &outgoing);
        return Ok(Pushed {
            dry_run: false,
            bookmark,
            remote_ref,
            pushed,
            working_copy,
            operation,
            queue: Some(entry.clone()),
            steps,
            warnings,
            message: format!(
                "{sync_note}Queue admission accepted: {commit} ({}). Acceptance is not proof of landing; `gm queue wait {commit} --deploy` observes the final verdict.",
                entry["status"].as_str().unwrap_or("unknown")
            ),
        });
    }

    let remote_tracking = if source.is_some() {
        format!("refs/remotes/gm-work/{bookmark}")
    } else {
        format!("refs/remotes/origin/{bookmark}")
    };
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
            queue: None,
            bookmark: bookmark.clone(),
            remote_ref: if source.is_some() {
                "refs/heads/work".into()
            } else {
                format!("refs/heads/{bookmark}")
            },
            pushed,
            message: summary.replace("Pushed", "Would push"),
            working_copy,
            operation: None,
            steps: None,
            warnings: Vec::new(),
        });
    }

    let remote_ref = if source.is_some() {
        "refs/heads/work".to_string()
    } else {
        format!("refs/heads/{bookmark}")
    };
    let refspec = format!("{rev}:{remote_ref}");
    let lease = format!(
        "--force-with-lease={remote_ref}:{}",
        remote_oid.map(|o| o.to_string()).unwrap_or_default()
    );
    let destination = source.as_ref().map(|s| s.url.as_str()).unwrap_or("origin");
    let mut git_args = vec!["push", "--quiet", destination, refspec.as_str()];
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
    let (steps, warnings) = upload_push_context(ctx, &config, &ws, &outgoing);
    Ok(Pushed {
        dry_run: false,
        queue: None,
        bookmark: bookmark.clone(),
        remote_ref,
        pushed,
        message: summary,
        working_copy: Change::load(&ws, ws.wc())?,
        operation,
        steps,
        warnings,
    })
}

// Context follows a successful push/admission, without changing its verdict or
// making staged queue commits immutable. Failed uploads remain in the journal.
fn upload_push_context(
    ctx: &Ctx,
    config: &Config,
    ws: &Workspace,
    outgoing: &[Oid],
) -> (Option<super::steps::Uploads>, Vec<String>) {
    let mut warnings = Vec::new();
    let steps = if super::steps::journal_dir(ws).exists() {
        match super::steps::repo_slug(ctx) {
            Ok(repo) => {
                let uploads = super::steps::upload_commits(ctx, config, &repo, ws, outgoing);
                if !uploads.failed.is_empty() {
                    warnings.push(format!(
                        "{} step context(s) weren't uploaded; run `gm context sync` to retry.",
                        uploads.failed.len()
                    ));
                }
                Some(uploads)
            }
            Err(e) => {
                warnings.push(format!("Step context wasn't uploaded: {}", e.message));
                None
            }
        }
    } else {
        None
    };
    (steps, warnings)
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
