//! Commands that only touch the local repository.

use super::{Ctx, Outcome, message, mutate, report, short, steps};
use crate::cli;
use crate::model::{Change, ConflictReport, Diff, FileChange, Log, OpResult, Status, TrunkInfo};
use crate::output::{GmError, Render, Result, exit};
use crate::repo::{Rebased, Workspace, revset, trees};
use git2::{DiffFindOptions, DiffOptions, Oid, Patch};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

// ---- reading ----------------------------------------------------------------

pub fn file_changes(
    ws: &Workspace,
    from: Oid,
    to: Oid,
    paths: &[String],
    patch: bool,
) -> Result<(Vec<FileChange>, Option<String>)> {
    let repo = &ws.repo;
    let mut options = DiffOptions::new();
    for p in paths {
        options.pathspec(p);
    }
    let mut diff = repo.diff_tree_to_tree(
        Some(&repo.find_tree(from)?),
        Some(&repo.find_tree(to)?),
        Some(&mut options),
    )?;
    diff.find_similar(Some(DiffFindOptions::new().renames(true)))?;
    let mut files = Vec::new();
    for (i, delta) in diff.deltas().enumerate() {
        use git2::Delta::*;
        let status = match delta.status() {
            Added => "added",
            Deleted => "deleted",
            Renamed => "renamed",
            Copied => "copied",
            Typechange => "typechange",
            _ => "modified",
        };
        let path = delta
            .new_file()
            .path()
            .or(delta.old_file().path())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let old_path = (delta.status() == Renamed || delta.status() == Copied)
            .then(|| {
                delta
                    .old_file()
                    .path()
                    .map(|p| p.to_string_lossy().into_owned())
            })
            .flatten();
        let (additions, deletions, binary) = match Patch::from_diff(&diff, i)? {
            Some(p) => {
                let (_, add, del) = p.line_stats()?;
                (add, del, delta.flags().is_binary())
            }
            None => (0, 0, true),
        };
        files.push(FileChange {
            path,
            status: status.into(),
            old_path,
            additions,
            deletions,
            binary,
        });
    }
    let patch = if patch {
        let mut text = Vec::new();
        diff.print(git2::DiffFormat::Patch, |_, _, line| {
            if matches!(line.origin(), '+' | '-' | ' ') {
                text.push(line.origin() as u8);
            }
            text.extend_from_slice(line.content());
            true
        })?;
        Some(String::from_utf8_lossy(&text).into_owned())
    } else {
        None
    };
    Ok((files, patch))
}

/// The tree a change's edits apply on top of: its parent's or, for a merge,
/// its parents merged. A merge's diff is then what it adds to that merge
/// (conflict resolutions, say), not everything the other side brought in.
fn parent_tree(ws: &Workspace, oid: Oid) -> Result<Oid> {
    let parents: Vec<Oid> = ws.commit(oid)?.parent_ids().collect();
    Ok(ws.merged_parent_tree(&parents)?.0)
}

/// The first parent's tree: a merge seen from the line it was merged into,
/// as `git revert -m 1` and `git cherry-pick -m 1` see it.
fn first_parent_tree(ws: &Workspace, oid: Oid) -> Result<Oid> {
    Ok(match ws.commit(oid)?.parent(0) {
        Ok(p) => p.tree_id(),
        Err(_) => trees::empty_tree(&ws.repo)?,
    })
}

pub fn conflict_reports(ws: &Workspace) -> Vec<ConflictReport> {
    ws.view
        .conflicts
        .iter()
        .map(|(id, paths)| ConflictReport {
            change_id: id[..crate::repo::ids::SHORT_CHANGE.min(id.len())].to_string(),
            paths: paths.clone(),
        })
        .collect()
}

pub fn status(ctx: &Ctx) -> Result<Status> {
    let ws = Workspace::open(&ctx.cwd)?;
    let wc = ws.wc();
    let commit = ws.commit(wc)?;
    let (files, _) = file_changes(&ws, parent_tree(&ws, wc)?, commit.tree_id(), &[], false)?;
    let parents = commit
        .parent_ids()
        .map(|p| Change::load(&ws, p))
        .collect::<Result<Vec<_>>>()?;
    let trunk = match &ws.trunk {
        Some(trunk) => {
            let graph = ws.graph()?;
            let mut ahead = 0;
            for oid in &graph.topo {
                let below = *oid != wc && ws.repo.graph_descendant_of(wc, *oid)?;
                if below || (*oid == wc && !ws.is_untouched(&ws.commit(wc)?)?) {
                    ahead += 1;
                }
            }
            Some(TrunkInfo {
                name: trunk
                    .refname
                    .trim_start_matches("refs/remotes/")
                    .trim_start_matches("refs/heads/")
                    .to_string(),
                change_id: short(&ws, trunk.oid),
                commit_id: crate::repo::ids::short_commit(trunk.oid),
                ahead,
                up_to_date: wc == trunk.oid || ws.repo.graph_descendant_of(wc, trunk.oid)?,
            })
        }
        None => None,
    };
    Ok(Status {
        working_copy: Change::load(&ws, wc)?,
        parents,
        files,
        trunk,
        conflicts: conflict_reports(&ws),
        snapshot_operation: ws.snapshot_op.clone(),
    })
}

pub fn log(ctx: &Ctx, args: &cli::LogArgs) -> Result<Log> {
    let ws = Workspace::open(&ctx.cwd)?;
    let mut oids: Vec<Oid> = Vec::new();
    let mut truncated = false;
    let walk_from = |ws: &Workspace,
                     push: Oid,
                     hide: Option<Oid>,
                     limit: usize,
                     out: &mut Vec<Oid>|
     -> Result<bool> {
        let mut walk = ws.repo.revwalk()?;
        walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;
        walk.push(push)?;
        if let Some(h) = hide {
            walk.hide(h)?;
        }
        for oid in walk {
            let oid = oid?;
            if out.len() >= limit {
                return Ok(true);
            }
            if !out.contains(&oid) {
                out.push(oid);
            }
        }
        Ok(false)
    };
    match args.revisions.as_deref() {
        None | Some("all") => {
            let graph = ws.graph()?;
            oids.extend(graph.topo.iter().rev());
            // Show what the stacks are built on: trunk, and any older base.
            let mut bases: Vec<Oid> = Vec::new();
            if let Some(trunk) = &ws.trunk {
                bases.push(trunk.oid);
            }
            for oid in &graph.topo {
                for p in ws.commit(*oid)?.parent_ids() {
                    if !graph.children.contains_key(&p)
                        && !graph.topo.contains(&p)
                        && !bases.contains(&p)
                    {
                        bases.push(p);
                    }
                }
            }
            if args.revisions.is_some() {
                if let Some(first) = bases.first().copied() {
                    truncated = walk_from(&ws, first, None, args.limit, &mut oids)?;
                }
            } else {
                for b in bases {
                    if !oids.contains(&b) {
                        oids.push(b);
                    }
                }
            }
        }
        Some(spec) if spec.contains("..") => {
            let (from, to) = spec.split_once("..").unwrap();
            let to = if to.is_empty() {
                ws.wc()
            } else {
                revset::resolve(&ws, to)?
            };
            let from = if from.is_empty() {
                None
            } else {
                Some(revset::resolve(&ws, from)?)
            };
            truncated = walk_from(&ws, to, from, args.limit, &mut oids)?;
        }
        Some(spec) => oids.push(revset::resolve(&ws, spec)?),
    }
    if oids.len() > args.limit {
        oids.truncate(args.limit);
        truncated = true;
    }
    let changes = oids
        .iter()
        .map(|o| Change::load(&ws, *o))
        .collect::<Result<Vec<_>>>()?;
    let (steps, note) = if args.context {
        let (found, note) = steps::lookup(ctx, &ws, &oids);
        let by_change = oids
            .iter()
            .zip(&changes)
            .filter_map(|(oid, c)| Some((c.change_id.clone(), found.get(oid)?.clone())))
            .collect();
        (Some(by_change), note)
    } else {
        (None, None)
    };
    Ok(Log {
        changes,
        truncated,
        steps,
        note,
    })
}

pub fn show(ctx: &Ctx, args: &cli::ShowArgs) -> Result<Diff> {
    let ws = Workspace::open(&ctx.cwd)?;
    let oid = revset::resolve(&ws, &args.revision)?;
    let (files, patch) = file_changes(
        &ws,
        parent_tree(&ws, oid)?,
        ws.commit(oid)?.tree_id(),
        &[],
        !args.stat,
    )?;
    let step = args
        .context
        .then(|| steps::lookup(ctx, &ws, &[oid]).0.remove(&oid));
    Ok(Diff {
        change: Some(Change::load(&ws, oid)?),
        files,
        patch,
        step,
    })
}

pub fn diff(ctx: &Ctx, args: &cli::DiffArgs) -> Result<Diff> {
    let ws = Workspace::open(&ctx.cwd)?;
    let (from, to, change) = if args.from.is_some() || args.to.is_some() {
        let to = revset::resolve(&ws, args.to.as_deref().unwrap_or("@"))?;
        let from = match &args.from {
            Some(f) => ws.commit(revset::resolve(&ws, f)?)?.tree_id(),
            None => parent_tree(&ws, to)?,
        };
        (from, ws.commit(to)?.tree_id(), None)
    } else {
        let oid = revset::resolve(&ws, args.revision.as_deref().unwrap_or("@"))?;
        (
            parent_tree(&ws, oid)?,
            ws.commit(oid)?.tree_id(),
            Some(Change::load(&ws, oid)?),
        )
    };
    let (files, patch) = file_changes(&ws, from, to, &args.paths, !args.stat)?;
    Ok(Diff {
        change,
        files,
        patch,
        step: None,
    })
}

// ---- describing and creating changes ----------------------------------------

pub fn describe(ctx: &Ctx, args: &cli::DescribeArgs) -> Result<OpResult> {
    mutate(ctx, |ws| {
        let oid = revset::resolve(ws, &args.revision)?;
        ws.ensure_mutable(oid)?;
        let commit = ws.commit(oid)?;
        let msg = message(&args.message);
        let new = ws.rewrite_commit(
            &commit,
            &commit.parent_ids().collect::<Vec<_>>(),
            commit.tree_id(),
            Some(&msg),
        )?;
        drop(commit);
        let rebased = ws.rebase_descendants(HashMap::from([(oid, new)]), HashMap::new())?;
        Ok(Outcome::new(
            format!("Described change {}.", short(ws, new)),
            vec![new],
            rebased,
        ))
    })
}

pub fn new(ctx: &Ctx, args: &cli::NewArgs) -> Result<OpResult> {
    mutate(ctx, |ws| {
        let parents = if args.revisions.is_empty() {
            vec![ws.wc()]
        } else {
            revset::resolve_many(ws, &args.revisions)?
        };
        let (tree, conflicts) = ws.merged_parent_tree(&parents)?;
        let new = ws.new_commit(&parents, tree, &message(&args.message))?;
        let mut rebased = Rebased::default();
        if !conflicts.is_empty() {
            let id = ws.change_id(&ws.commit(new)?);
            ws.view.conflicts.insert(id.clone(), conflicts.clone());
            rebased.conflicts.push((id, conflicts));
        }
        ws.set_wc(new)?;
        let on = parents
            .iter()
            .map(|p| short(ws, *p))
            .collect::<Vec<_>>()
            .join(" + ");
        Ok(Outcome::new(
            format!("Started change {} on {on}.", short(ws, new)),
            vec![new],
            rebased,
        ))
    })
}

/// Merge revisions in below the working copy: a merge change with parents
/// `@-` and the revisions goes between `@` and its parent, the way `gm commit`
/// leaves a change below `@`. Edits in progress stay in `@`, on top. Conflicts
/// are recorded on the merge; resolve them in `@`, then `gm squash`.
pub fn merge(ctx: &Ctx, args: &cli::MergeArgs) -> Result<OpResult> {
    mutate(ctx, |ws| {
        let wc = ws.wc();
        let base = wc_base(ws)?;
        let mut parents = vec![base];
        let mut names = Vec::new();
        for spec in &args.revisions {
            let rev = revset::resolve(ws, spec)?;
            if rev == wc || ws.repo.graph_descendant_of(rev, wc)? {
                return Err(GmError::usage(format!(
                    "`{spec}` is the working copy or built on it, so it can't be merged below it."
                ))
                .hint(
                    "Start from the change to merge into instead: `gm new <rev>`, then `gm merge`.",
                ));
            }
            if parents.contains(&rev) || ws.repo.graph_descendant_of(base, rev)? {
                continue;
            }
            parents.push(rev);
            names.push(match (spec.as_str(), &ws.trunk) {
                ("trunk" | "trunk()", Some(trunk)) => trunk.name.clone(),
                _ => spec.clone(),
            });
        }
        if names.is_empty() {
            return Ok(Outcome::new(
                format!(
                    "Nothing to merge: {} already contains {}.",
                    short(ws, base),
                    args.revisions.join(", ")
                ),
                Vec::new(),
                Rebased::default(),
            ));
        }
        let (tree, conflicts) = ws.merged_parent_tree(&parents)?;
        let msg = if args.message.is_empty() {
            format!("Merge {}\n", names.join(", "))
        } else {
            message(&args.message)
        };
        let (new, rebased) = insert_below(ws, &parents, tree, conflicts, &msg)?;
        let mut text = format!(
            "Merged {} into {} as change {}, below the working copy.",
            names.join(", "),
            short(ws, base),
            short(ws, new)
        );
        if !rebased.conflicts.is_empty() {
            text.push_str(" It has conflicts: resolve the markers in @, then `gm squash`.");
        }
        Ok(Outcome::new(text, vec![new], rebased))
    })
}

pub fn commit(ctx: &Ctx, args: &cli::CommitArgs) -> Result<OpResult> {
    // Read and check the step context first: a bad file fails before anything changes.
    let context = match &args.context {
        Some(arg) => Some(steps::parse_context(&steps::read_context_arg(arg)?)?),
        None => None,
    };
    let missing = context.is_none();
    commit_with(ctx, args, context, missing)
}

/// `gm commit` with an already-read context (`gm step` passes one carrying
/// only tests). `no_context` says to warn that the step has no context.
pub fn commit_with(
    ctx: &Ctx,
    args: &cli::CommitArgs,
    context: Option<serde_json::Value>,
    no_context: bool,
) -> Result<OpResult> {
    let mut timeline = None;
    let mut result = mutate(ctx, |ws| {
        timeline = ws.timeline.clone();
        let wc = ws.wc();
        let commit = ws.commit(wc)?;
        let full = commit.tree_id();
        let base = parent_tree(ws, wc)?;
        let selected = trees::with_paths(&ws.repo, base, full, &args.paths)?;
        if !args.paths.is_empty() && selected == base {
            return Err(GmError::new(
                "no_matching_changes",
                "None of the given paths have changes in the working copy.",
            )
            .hint("Run `gm status` to see changed files.")
            .exit(exit::USAGE));
        }
        let msg = message(&args.message);
        let described = ws.rewrite_commit(
            &commit,
            &commit.parent_ids().collect::<Vec<_>>(),
            selected,
            Some(&msg),
        )?;
        drop(commit);
        if let Some(context) = context.clone()
            && !ctx.dry_run
        {
            steps::record(ws, described, context)?;
        }
        let next = ws.new_commit(&[described], full, "")?;
        // Anything built on the old @ now builds on the full contents in the new @.
        let rebased = ws.rebase_descendants(HashMap::from([(wc, next)]), HashMap::new())?;
        ws.view.wc = next.to_string();
        let what = if args.paths.is_empty() {
            String::new()
        } else {
            format!(" ({} path(s))", args.paths.len())
        };
        Ok(Outcome::new(
            format!(
                "Committed change {}{what}; working copy is now {}.",
                short(ws, described),
                short(ws, next)
            ),
            vec![described],
            rebased,
        ))
    })?;
    // In a timeline, an agent's commit is a step: say when it has no context.
    if no_context
        && crate::agent::detect().is_some()
        && let Some(slug) = timeline
    {
        result.warnings.push(format!(
            "This step in timeline {slug} has no context: pass --context with why, instructions and steering (gm commit --help)."
        ));
    }
    Ok(result)
}

// ---- moving edits around -----------------------------------------------------

pub fn squash(ctx: &Ctx, args: &cli::SquashArgs) -> Result<OpResult> {
    mutate(ctx, |ws| {
        let rev = revset::resolve(ws, &args.revision)?;
        ws.ensure_mutable(rev)?;
        let src = ws.commit(rev)?;
        let parent = src
            .parent_id(0)
            .map_err(|_| GmError::usage("That change has no parent to squash into."))?;
        let dest = match &args.into {
            Some(spec) => revset::resolve(ws, spec)?,
            None => parent,
        };
        if dest == rev {
            return Err(GmError::usage("Can't squash a change into itself."));
        }
        ws.ensure_mutable(dest)?;
        if ws.repo.graph_descendant_of(dest, rev)? {
            return Err(GmError::usage("Can't squash into a descendant.").hint(
                "Squash from the descendant instead: `gm squash -r <child> --into <parent>`.",
            ));
        }
        let p_tree = parent_tree(ws, rev)?;
        let s_tree = src.tree_id();
        let selected = trees::with_paths(&ws.repo, p_tree, s_tree, &args.paths)?;
        if selected == p_tree {
            return Err(
                GmError::new("nothing_to_squash", "There are no edits to move.").exit(exit::USAGE),
            );
        }
        let remaining = if args.paths.is_empty() {
            p_tree
        } else {
            trees::with_paths(&ws.repo, s_tree, p_tree, &args.paths)?
        };
        let moves_everything = remaining == p_tree;

        let dest_commit = ws.commit(dest)?;
        let (dest_tree, conflicts) =
            trees::merge(&ws.repo, p_tree, dest_commit.tree_id(), selected)?;
        let src_desc = Workspace::description(&src);
        let dest_desc = Workspace::description(&dest_commit);
        let msg = if !args.message.is_empty() {
            message(&args.message)
        } else if dest_desc.trim().is_empty() {
            src_desc.clone()
        } else if moves_everything && !src_desc.trim().is_empty() {
            format!("{}\n\n{}", dest_desc.trim_end(), src_desc)
        } else {
            dest_desc.clone()
        };
        let new_dest = ws.rewrite_commit(
            &dest_commit,
            &dest_commit.parent_ids().collect::<Vec<_>>(),
            dest_tree,
            Some(&msg),
        )?;
        let mut rewritten = HashMap::from([(dest, new_dest)]);
        let mut abandoned = HashMap::new();
        if moves_everything {
            abandoned.insert(rev, src.parent_ids().collect::<Vec<_>>());
        } else {
            let new_src =
                ws.rewrite_commit(&src, &src.parent_ids().collect::<Vec<_>>(), remaining, None)?;
            rewritten.insert(rev, new_src);
        }
        let dest_id = ws.change_id(&dest_commit);
        drop((src, dest_commit));
        let mut rebased = ws.rebase_descendants(rewritten, abandoned)?;
        if !conflicts.is_empty() {
            ws.view.conflicts.insert(dest_id.clone(), conflicts.clone());
            rebased.conflicts.push((dest_id, conflicts));
        }
        let landed = revset::resolve(ws, &short(ws, new_dest)).unwrap_or(new_dest);
        Ok(Outcome::new(
            format!("Squashed into change {}.", short(ws, landed)),
            vec![landed],
            rebased,
        ))
    })
}

pub fn split(ctx: &Ctx, args: &cli::SplitArgs) -> Result<OpResult> {
    mutate(ctx, |ws| {
        let rev = revset::resolve(ws, &args.revision)?;
        ws.ensure_mutable(rev)?;
        let commit = ws.commit(rev)?;
        let base = parent_tree(ws, rev)?;
        let full = commit.tree_id();
        let selected = trees::with_paths(&ws.repo, base, full, &args.paths)?;
        if selected == base {
            return Err(GmError::new(
                "no_matching_changes",
                "None of the given paths are changed in that change.",
            )
            .exit(exit::USAGE));
        }
        if selected == full {
            return Err(GmError::new(
                "nothing_to_split",
                "Those paths are everything the change touches.",
            )
            .hint("Use `gm describe` to rename the change instead.")
            .exit(exit::USAGE));
        }
        let first = ws.new_commit(
            &commit.parent_ids().collect::<Vec<_>>(),
            selected,
            &message(&args.message),
        )?;
        let rest = ws.rewrite_commit(&commit, &[first], full, None)?;
        drop(commit);
        let rebased = ws.rebase_descendants(HashMap::from([(rev, rest)]), HashMap::new())?;
        Ok(Outcome::new(
            format!(
                "Split {} path(s) into new change {}, before {}.",
                args.paths.len(),
                short(ws, first),
                short(ws, rest)
            ),
            vec![rest, first],
            rebased,
        ))
    })
}

pub fn edit(ctx: &Ctx, args: &cli::EditArgs) -> Result<OpResult> {
    mutate(ctx, |ws| {
        let oid = revset::resolve(ws, &args.revision)?;
        if ws.is_immutable(oid)? {
            return Err(GmError::new(
                "immutable_change",
                "That change is part of trunk and can't be edited.",
            )
            .hint(format!(
                "Start a new change on top of it instead: `gm new {}`.",
                args.revision
            ))
            .exit(exit::CONFLICT));
        }
        ws.set_wc(oid)?;
        Ok(Outcome::new(
            format!("Now editing change {}.", short(ws, oid)),
            vec![oid],
            Rebased::default(),
        ))
    })
}

pub fn abandon(ctx: &Ctx, args: &cli::AbandonArgs) -> Result<OpResult> {
    mutate(ctx, |ws| {
        let specs = if args.revisions.is_empty() {
            vec!["@".to_string()]
        } else {
            args.revisions.clone()
        };
        let oids = revset::resolve_many(ws, &specs)?;
        let mut abandoned = HashMap::new();
        for oid in &oids {
            ws.ensure_mutable(*oid)?;
            abandoned.insert(*oid, ws.commit(*oid)?.parent_ids().collect::<Vec<_>>());
        }
        let names: Vec<String> = oids.iter().map(|o| short(ws, *o)).collect();
        let rebased = ws.rebase_descendants(HashMap::new(), abandoned)?;
        Ok(Outcome::new(
            format!("Abandoned {}.", names.join(", ")),
            Vec::new(),
            rebased,
        ))
    })
}

pub fn restore(ctx: &Ctx, args: &cli::RestoreArgs) -> Result<OpResult> {
    mutate(ctx, |ws| {
        let into = revset::resolve(ws, &args.into)?;
        ws.ensure_mutable(into)?;
        let commit = ws.commit(into)?;
        let from = match &args.from {
            Some(spec) => ws.commit(revset::resolve(ws, spec)?)?.tree_id(),
            None => parent_tree(ws, into)?,
        };
        let tree = if args.paths.is_empty() {
            from
        } else {
            trees::with_paths(&ws.repo, commit.tree_id(), from, &args.paths)?
        };
        if tree == commit.tree_id() {
            return Ok(Outcome::new(
                "Nothing to restore.",
                Vec::new(),
                Rebased::default(),
            ));
        }
        let changed = trees::changed_paths(&ws.repo, commit.tree_id(), tree)?.len();
        let new = ws.rewrite_commit(
            &commit,
            &commit.parent_ids().collect::<Vec<_>>(),
            tree,
            None,
        )?;
        drop(commit);
        let rebased = ws.rebase_descendants(HashMap::from([(into, new)]), HashMap::new())?;
        Ok(Outcome::new(
            format!("Restored {changed} file(s) in change {}.", short(ws, new)),
            vec![new],
            rebased,
        ))
    })
}

/// Rebase one commit onto new parents, keeping its change id.
fn rebase_onto(ws: &Workspace, oid: Oid, parents: &[Oid]) -> Result<(Oid, Vec<String>)> {
    let commit = ws.commit(oid)?;
    let (tree, conflicts) = ws.rebased_tree(&commit, parents)?;
    Ok((ws.rewrite_commit(&commit, parents, tree, None)?, conflicts))
}

fn record_conflicts(
    ws: &mut Workspace,
    oid: Oid,
    conflicts: Vec<String>,
    rebased: &mut Rebased,
) -> Result<()> {
    if !conflicts.is_empty() {
        let id = ws.change_id(&ws.commit(oid)?);
        ws.view.conflicts.insert(id.clone(), conflicts.clone());
        rebased.conflicts.push((id, conflicts));
    }
    Ok(())
}

/// The roots of the mutable stack that `oid` belongs to.
fn stack_roots(ws: &Workspace, oid: Oid) -> Result<Vec<Oid>> {
    let mut roots = Vec::new();
    let mut queue = vec![oid];
    let mut seen = std::collections::HashSet::new();
    while let Some(o) = queue.pop() {
        if !seen.insert(o) {
            continue;
        }
        let mutable_parents: Vec<Oid> = ws
            .commit(o)?
            .parent_ids()
            .filter(|p| !ws.is_immutable(*p).unwrap_or(true))
            .collect();
        if mutable_parents.is_empty() {
            roots.push(o);
        } else {
            queue.extend(mutable_parents);
        }
    }
    Ok(roots)
}

pub fn rebase(ctx: &Ctx, args: &cli::RebaseArgs) -> Result<OpResult> {
    mutate(ctx, |ws| {
        let dest = revset::resolve(ws, &args.destination)?;
        let mut rebased = Rebased::default();
        let mut moved = Vec::new();
        if let Some(spec) = &args.revision {
            let rev = revset::resolve(ws, spec)?;
            ws.ensure_mutable(rev)?;
            if rev == dest || ws.repo.graph_descendant_of(dest, rev)? {
                return Err(GmError::usage(
                    "Can't rebase a change onto itself or its descendant.",
                ));
            }
            let (new, conflicts) = rebase_onto(ws, rev, &ws.parents_onto(rev, dest)?)?;
            let has_children = ws
                .graph()?
                .children
                .get(&rev)
                .map(|c| !c.is_empty())
                .unwrap_or(false);
            let is_wc = rev == ws.wc();
            if has_children {
                let parents = ws.commit(rev)?.parent_ids().collect::<Vec<_>>();
                rebased = ws.rebase_descendants(HashMap::new(), HashMap::from([(rev, parents)]))?;
                ws.add_head(new)?;
                if is_wc {
                    ws.view.wc = new.to_string();
                }
            } else {
                rebased = ws.rebase_descendants(HashMap::from([(rev, new)]), HashMap::new())?;
            }
            record_conflicts(ws, new, conflicts, &mut rebased)?;
            moved.push(new);
        } else {
            let roots = match (&args.source, &args.branch) {
                (Some(spec), _) => vec![revset::resolve(ws, spec)?],
                (None, branch) => {
                    stack_roots(ws, revset::resolve(ws, branch.as_deref().unwrap_or("@"))?)?
                }
            };
            let mut rewritten = HashMap::new();
            let mut root_conflicts = Vec::new();
            for root in &roots {
                ws.ensure_mutable(*root)?;
                if *root == dest || ws.repo.graph_descendant_of(dest, *root)? {
                    return Err(GmError::usage(
                        "Can't rebase a change onto itself or its descendant.",
                    ));
                }
                let parents = ws.parents_onto(*root, dest)?;
                if ws.commit(*root)?.parent_ids().collect::<Vec<_>>() == parents {
                    continue;
                }
                let (new, conflicts) = rebase_onto(ws, *root, &parents)?;
                rewritten.insert(*root, new);
                root_conflicts.push((new, conflicts));
                moved.push(new);
            }
            if rewritten.is_empty() {
                return Ok(Outcome::new(
                    format!("Already on {}.", args.destination),
                    Vec::new(),
                    rebased,
                ));
            }
            // The changes a root moved away from (a merge's first parent, say)
            // stay visible.
            let left: Vec<Oid> = rewritten
                .keys()
                .map(|root| ws.commit(*root).map(|c| c.parent_ids().collect::<Vec<_>>()))
                .collect::<Result<Vec<_>>>()?
                .concat();
            rebased = ws.rebase_descendants(rewritten, HashMap::new())?;
            for parent in left {
                ws.add_head(parent)?;
            }
            for (new, conflicts) in root_conflicts {
                record_conflicts(ws, new, conflicts, &mut rebased)?;
            }
        }
        let moved_ids: Vec<Oid> = moved
            .iter()
            .map(|o| revset::resolve(ws, &short(ws, *o)).unwrap_or(*o))
            .collect();
        Ok(Outcome::new(
            format!(
                "Rebased {} change(s) onto {}.",
                moved.len(),
                args.destination
            ),
            moved_ids,
            rebased,
        ))
    })
}

/// The working copy's (first) parent, which changes inserted below it build on.
fn wc_base(ws: &Workspace) -> Result<Oid> {
    ws.commit(ws.wc())?
        .parent_id(0)
        .map_err(|_| GmError::usage("The working copy has no parent to insert below."))
}

/// Put a new change between `@` and its parent; `@` is rebased on top.
fn insert_below_wc(
    ws: &mut Workspace,
    tree_for: impl FnOnce(&Workspace, Oid) -> Result<(Oid, Vec<String>)>,
    msg: &str,
) -> Result<(Oid, Rebased)> {
    let base = wc_base(ws)?;
    let (tree, conflicts) = tree_for(ws, ws.commit(base)?.tree_id())?;
    insert_below(ws, &[base], tree, conflicts, msg)
}

/// Put a new change with these parents below `@`, which moves on top of it,
/// keeping any other parents `@` has.
fn insert_below(
    ws: &mut Workspace,
    parents: &[Oid],
    tree: Oid,
    conflicts: Vec<String>,
    msg: &str,
) -> Result<(Oid, Rebased)> {
    let wc = ws.wc();
    let new = ws.new_commit(parents, tree, msg)?;
    let (new_wc, wc_conflicts) = rebase_onto(ws, wc, &ws.parents_onto(wc, new)?)?;
    let mut rebased = ws.rebase_descendants(HashMap::from([(wc, new_wc)]), HashMap::new())?;
    record_conflicts(ws, new, conflicts, &mut rebased)?;
    record_conflicts(ws, new_wc, wc_conflicts, &mut rebased)?;
    Ok((new, rebased))
}

pub fn backout(ctx: &Ctx, args: &cli::BackoutArgs) -> Result<OpResult> {
    mutate(ctx, |ws| {
        let rev = revset::resolve(ws, &args.revision)?;
        let target = ws.commit(rev)?;
        let t_tree = target.tree_id();
        let p_tree = first_parent_tree(ws, rev)?;
        let summary = Workspace::description(&target)
            .lines()
            .next()
            .unwrap_or("")
            .to_string();
        let msg = format!(
            "Back out \"{summary}\"\n\nThis backs out change {} (commit {}).\n",
            short(ws, rev),
            &rev.to_string()[..12]
        );
        drop(target);
        let repo_trees = |ws: &Workspace, base: Oid| trees::merge(&ws.repo, t_tree, base, p_tree);
        let (new, rebased) = insert_below_wc(ws, repo_trees, &msg)?;
        Ok(Outcome::new(
            format!(
                "Backed out {} in new change {}, below the working copy.",
                short(ws, rev),
                short(ws, new)
            ),
            vec![new],
            rebased,
        ))
    })
}

pub fn duplicate(ctx: &Ctx, args: &cli::DuplicateArgs) -> Result<OpResult> {
    mutate(ctx, |ws| {
        let rev = revset::resolve(ws, &args.revision)?;
        let src = ws.commit(rev)?;
        let s_tree = src.tree_id();
        let p_tree = first_parent_tree(ws, rev)?;
        let msg = Workspace::description(&src);
        drop(src);
        match &args.destination {
            Some(spec) => {
                let dest = revset::resolve(ws, spec)?;
                let (tree, conflicts) =
                    trees::merge(&ws.repo, p_tree, ws.commit(dest)?.tree_id(), s_tree)?;
                let new = ws.new_commit(&[dest], tree, &msg)?;
                ws.add_head(new)?;
                let mut rebased = Rebased::default();
                record_conflicts(ws, new, conflicts, &mut rebased)?;
                Ok(Outcome::new(
                    format!(
                        "Copied {} onto {} as new change {}.",
                        short(ws, rev),
                        spec,
                        short(ws, new)
                    ),
                    vec![new],
                    rebased,
                ))
            }
            None => {
                let tree_for =
                    |ws: &Workspace, base: Oid| trees::merge(&ws.repo, p_tree, base, s_tree);
                let (new, rebased) = insert_below_wc(ws, tree_for, &msg)?;
                Ok(Outcome::new(
                    format!(
                        "Copied {} below the working copy as new change {}.",
                        short(ws, rev),
                        short(ws, new)
                    ),
                    vec![new],
                    rebased,
                ))
            }
        }
    })
}

// ---- operations ---------------------------------------------------------------

pub fn undo(ctx: &Ctx) -> Result<OpResult> {
    let mut ws = Workspace::open(&ctx.cwd)?;
    let mut ops = ws.store().ops()?;
    let target = ops
        .iter()
        .rposition(|op| {
            op.undone_by.is_none() && op.undoes.is_none() && op.command != "snapshot working copy"
        })
        .ok_or_else(|| {
            GmError::not_found("nothing_to_undo", "There is no operation left to undo.")
        })?;
    let op = ops[target].clone();
    ws.restore_view(op.before.clone(), &op.after)?;
    let label = format!("undo {}", op.id);
    let edits_note = match &ws.snapshot_op {
        Some(snap) => format!(
            " Edits made since then are kept in operation {snap}; `gm op restore {snap}` brings them back."
        ),
        None => String::new(),
    };
    if ctx.dry_run {
        let result = report(
            &ws,
            Outcome::new(
                format!("Would undo `{}`.", op.command),
                Vec::new(),
                Rebased::default(),
            ),
            None,
            true,
        )?;
        ws.discard();
        return Ok(result);
    }
    let id = ws.finish(&label)?;
    if let Some(id) = &id {
        ops = ws.store().ops()?;
        if let Some(entry) = ops.iter_mut().find(|o| o.id == op.id) {
            entry.undone_by = Some(id.clone());
        }
        if let Some(entry) = ops.iter_mut().find(|o| &o.id == id) {
            entry.undoes = Some(op.id.clone());
        }
        ws.store().save_ops(&ops)?;
    }
    report(
        &ws,
        Outcome::new(
            format!("Undid `{}` ({}).{edits_note}", op.command, op.id),
            Vec::new(),
            Rebased::default(),
        ),
        id,
        false,
    )
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct OpEntry {
    pub id: String,
    pub time: String,
    pub command: String,
    pub undone: bool,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct OpLog {
    pub operations: Vec<OpEntry>,
}

impl Render for OpLog {
    fn text(&self) -> String {
        self.operations
            .iter()
            .map(|o| {
                format!(
                    "{} {} {}{}",
                    crate::output::style::commit(&o.id),
                    crate::output::style::dim(&o.time),
                    o.command,
                    if o.undone { " (undone)" } else { "" }
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

pub fn op_log(ctx: &Ctx, limit: usize) -> Result<OpLog> {
    let ws = Workspace::open(&ctx.cwd)?;
    let ops = ws.store().ops()?;
    Ok(OpLog {
        operations: ops
            .iter()
            .rev()
            .take(limit)
            .map(|o| OpEntry {
                id: o.id.clone(),
                time: o.time.clone(),
                command: o.command.clone(),
                undone: o.undone_by.is_some(),
            })
            .collect(),
    })
}

pub fn op_restore(ctx: &Ctx, id: &str) -> Result<OpResult> {
    mutate(ctx, |ws| {
        let ops = ws.store().ops()?;
        let matches: Vec<_> = ops.iter().filter(|o| o.id.starts_with(id)).collect();
        let op = match matches.as_slice() {
            [one] => (*one).clone(),
            [] => {
                return Err(GmError::not_found(
                    "operation_not_found",
                    format!("No operation `{id}`."),
                )
                .hint("Run `gm op log`."));
            }
            _ => {
                return Err(GmError::usage(format!(
                    "Operation prefix `{id}` is ambiguous."
                )));
            }
        };
        ws.restore_operation(op.after.clone())?;
        Ok(Outcome::new(
            format!(
                "Restored the repository to just after `{}` ({}).",
                op.command, op.id
            ),
            Vec::new(),
            Rebased::default(),
        ))
    })
}

// ---- bookmarks and files ---------------------------------------------------------

#[derive(Serialize, schemars::JsonSchema)]
pub struct RemoteBookmark {
    pub commit_id: String,
    /// The local bookmark points at the same commit.
    pub in_sync: bool,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct Bookmark {
    pub name: String,
    /// Null when the bookmark only exists on the server.
    pub change_id: Option<String>,
    pub commit_id: Option<String>,
    /// The server's copy (origin/<name>), if any.
    pub remote: Option<RemoteBookmark>,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct Bookmarks {
    pub bookmarks: Vec<Bookmark>,
}

impl Render for Bookmarks {
    fn text(&self) -> String {
        self.bookmarks
            .iter()
            .map(|b| {
                let local = match (&b.change_id, &b.commit_id) {
                    (Some(c), Some(o)) => format!(
                        "{} {}",
                        crate::output::style::change(c),
                        crate::output::style::commit(o)
                    ),
                    _ => crate::output::style::dim("(remote only)"),
                };
                let remote = match &b.remote {
                    Some(r) if r.in_sync => crate::output::style::dim("  in sync with origin"),
                    Some(r) => {
                        format!("  origin at {}", crate::output::style::commit(&r.commit_id))
                    }
                    None => crate::output::style::dim("  not pushed"),
                };
                format!(
                    "{} {local}{remote}",
                    crate::output::style::bookmark(&b.name)
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

pub fn bookmark_list(ctx: &Ctx) -> Result<Bookmarks> {
    let ws = Workspace::open(&ctx.cwd)?;
    let mut names: Vec<String> = ws.view.bookmarks.keys().cloned().collect();
    let mut remotes = HashMap::new();
    for branch in ws.repo.branches(Some(git2::BranchType::Remote))? {
        let (branch, _) = branch?;
        if let (Some(name), Some(target)) = (branch.name()?, branch.get().target())
            && let Some(short_name) = name.strip_prefix("origin/")
        {
            if short_name == "HEAD" {
                continue;
            }
            remotes.insert(short_name.to_string(), target);
            if !names.contains(&short_name.to_string()) {
                names.push(short_name.to_string());
            }
        }
    }
    names.sort();
    let bookmarks = names
        .into_iter()
        .map(|name| {
            let local = ws
                .view
                .bookmarks
                .get(&name)
                .and_then(|t| Oid::from_str(t).ok());
            let remote = remotes.get(&name).copied();
            Bookmark {
                change_id: local.map(|o| short(&ws, o)),
                commit_id: local.map(crate::repo::ids::short_commit),
                remote: remote.map(|r| RemoteBookmark {
                    commit_id: crate::repo::ids::short_commit(r),
                    in_sync: Some(r) == local,
                }),
                name,
            }
        })
        .collect();
    Ok(Bookmarks { bookmarks })
}

pub fn bookmark_set(ctx: &Ctx, name: &str, revision: &str) -> Result<OpResult> {
    if !git2::Reference::is_valid_name(&format!("refs/heads/{name}")) {
        return Err(GmError::usage(format!(
            "`{name}` is not a valid bookmark name."
        )));
    }
    mutate(ctx, |ws| {
        let oid = revset::resolve(ws, revision)?;
        let moved = ws
            .view
            .bookmarks
            .insert(name.to_string(), oid.to_string())
            .is_some();
        ws.normalize_heads()?;
        Ok(Outcome::new(
            format!(
                "{} bookmark {name} at {}.",
                if moved { "Moved" } else { "Created" },
                short(ws, oid)
            ),
            vec![oid],
            Rebased::default(),
        ))
    })
}

pub fn bookmark_delete_local(ws: &mut Workspace, name: &str) -> Result<()> {
    let target = ws.view.bookmarks.remove(name).ok_or_else(|| {
        GmError::not_found("bookmark_not_found", format!("No bookmark `{name}`."))
    })?;
    // Keep the changes it pointed at visible.
    ws.add_head(Oid::from_str(&target)?)?;
    Ok(())
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct FileShow {
    pub path: String,
    pub revision: String,
    pub size: usize,
    pub binary: bool,
    pub content: Option<String>,
}

impl Render for FileShow {
    fn text(&self) -> String {
        self.content
            .clone()
            .unwrap_or_else(|| format!("(binary file, {} bytes)", self.size))
    }
}

pub fn file_show(ctx: &Ctx, path: &str, revision: &str) -> Result<FileShow> {
    let ws = Workspace::open(&ctx.cwd)?;
    let oid = revset::resolve(&ws, revision)?;
    let tree = ws.commit(oid)?.tree()?;
    let entry = tree.get_path(Path::new(path)).map_err(|_| {
        GmError::not_found("file_not_found", format!("No file `{path}` at {revision}."))
    })?;
    let blob = ws.repo.find_blob(entry.id()).map_err(|_| {
        GmError::usage(format!(
            "`{path}` is a directory; use `gm file list {path}`."
        ))
    })?;
    let binary = blob.is_binary();
    Ok(FileShow {
        path: path.to_string(),
        revision: short(&ws, oid),
        size: blob.size(),
        binary,
        content: (!binary).then(|| String::from_utf8_lossy(blob.content()).into_owned()),
    })
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct FileList {
    pub revision: String,
    pub files: Vec<String>,
}

impl Render for FileList {
    fn text(&self) -> String {
        self.files.join("\n")
    }
}

pub fn file_list(ctx: &Ctx, path: Option<&str>, revision: &str) -> Result<FileList> {
    let ws = Workspace::open(&ctx.cwd)?;
    let oid = revset::resolve(&ws, revision)?;
    let tree = ws.commit(oid)?.tree()?;
    let prefix = path
        .map(|p| p.trim_end_matches('/').to_string())
        .filter(|p| !p.is_empty());
    let mut files = Vec::new();
    tree.walk(git2::TreeWalkMode::PreOrder, |dir, entry| {
        if entry.kind() != Some(git2::ObjectType::Tree) {
            let full = format!("{dir}{}", entry.name().unwrap_or(""));
            if prefix
                .as_ref()
                .is_none_or(|p| full == *p || full.starts_with(&format!("{p}/")))
            {
                files.push(full);
            }
        }
        git2::TreeWalkResult::Ok
    })?;
    Ok(FileList {
        revision: short(&ws, oid),
        files,
    })
}

pub fn init(ctx: &Ctx) -> Result<OpResult> {
    if ctx.dry_run {
        return Err(GmError::usage("`gm init` doesn't support --dry-run."));
    }
    let ws = Workspace::init(&ctx.cwd)?;
    let message = match &ws.trunk {
        Some(t) => format!(
            "gm is set up. Working copy is a new change on {}.",
            t.refname.trim_start_matches("refs/remotes/")
        ),
        None => "gm is set up. Working copy is a new change.".to_string(),
    };
    report(
        &ws,
        Outcome::new(message, Vec::new(), Rebased::default()),
        None,
        false,
    )
}
