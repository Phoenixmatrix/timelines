//! Naming revisions.
//!
//! A revision is a base followed by any number of `-` (parent) or `+`
//! (only child) steps. Bases, in the order they're tried:
//!   `@`                the working-copy change
//!   `trunk`            the remote's main line (origin/main)
//!   `<bookmark>`       a local bookmark (git branch), `origin/<name>` for remote ones
//!   `<change id>`      any unique prefix, letters k-z (e.g. `kxmq`)
//!   `<commit id>`      any unique hex prefix of 4+ characters
//!   `<tag>`            a git tag
//! Ranges (for `gm log -r`): `A..B` is what B has that A doesn't; `all` is
//! every visible change.

use super::{Workspace, ids};
use crate::output::{GmError, Result, exit};
use git2::Oid;

fn unknown(spec: &str) -> GmError {
    GmError::not_found(
        "revision_not_found",
        format!("No change, commit or bookmark matches `{spec}`."),
    )
    .hint("Run `gm log` to list changes; change ids are letters k-z, commit ids are hex.")
}

pub fn resolve(ws: &Workspace, spec: &str) -> Result<Oid> {
    let spec = spec.trim();
    let base_end = spec.trim_end_matches(['-', '+']).len();
    let (base, steps) = spec.split_at(base_end);
    if base.is_empty() {
        return Err(GmError::usage(format!("`{spec}` is not a revision.")));
    }
    let mut oid = resolve_base(ws, base).ok_or_else(|| unknown(spec))??;
    for step in steps.chars() {
        oid = match step {
            '-' => ws.commit(oid)?.parent_id(0).map_err(|_| {
                GmError::not_found(
                    "revision_not_found",
                    format!("`{spec}` goes past the first commit."),
                )
            })?,
            _ => {
                let graph = ws.graph()?;
                match graph.children.get(&oid).map(Vec::as_slice) {
                    Some([only]) => *only,
                    Some([]) | None => {
                        return Err(GmError::not_found(
                            "revision_not_found",
                            format!("`{spec}`: that change has no children."),
                        ));
                    }
                    Some(_) => {
                        return Err(GmError::new(
                            "ambiguous_revision",
                            format!("`{spec}`: that change has several children."),
                        )
                        .hint("Name the child by its change id instead.")
                        .exit(exit::USAGE));
                    }
                }
            }
        };
    }
    Ok(oid)
}

fn resolve_base(ws: &Workspace, base: &str) -> Option<Result<Oid>> {
    if base == "@" {
        return Some(Ok(ws.wc()));
    }
    if base == "trunk" || base == "trunk()" {
        return Some(ws.trunk.as_ref().map(|t| t.oid).ok_or_else(|| {
            GmError::not_found("no_trunk", "This repository has no trunk yet (no origin/main).")
                .hint("Push something first with `gm push`, or set one: `git config gm.trunk refs/remotes/origin/<branch>`.")
        }));
    }
    if let Some(target) = ws.view.bookmarks.get(base) {
        return Some(Oid::from_str(target).map_err(Into::into));
    }
    for refname in [format!("refs/remotes/{base}"), format!("refs/tags/{base}")] {
        if let Ok(reference) = ws.repo.find_reference(&refname)
            && let Ok(commit) = reference.peel_to_commit()
        {
            return Some(Ok(commit.id()));
        }
    }
    if ids::is_change_id_prefix(base) {
        return find_change(ws, base).transpose();
    }
    if ids::is_commit_prefix(base) {
        return match ws.repo.find_commit_by_prefix(base) {
            Ok(commit) => Some(Ok(commit.id())),
            Err(e) if e.code() == git2::ErrorCode::Ambiguous => Some(Err(GmError::new(
                "ambiguous_revision",
                format!("Commit prefix `{base}` matches several commits."),
            )
            .hint("Use more characters.")
            .exit(exit::USAGE))),
            Err(_) => None,
        };
    }
    None
}

/// Change ids are looked up among visible changes, then recent trunk history.
fn find_change(ws: &Workspace, prefix: &str) -> Result<Option<Oid>> {
    let mut found: Vec<Oid> = Vec::new();
    let graph = ws.graph()?;
    for oid in &graph.topo {
        if ws.change_id(&ws.commit(*oid)?).starts_with(prefix) {
            found.push(*oid);
        }
    }
    if found.is_empty()
        && let Some(trunk) = &ws.trunk
    {
        let mut walk = ws.repo.revwalk()?;
        walk.push(trunk.oid)?;
        for oid in walk.take(10_000) {
            let oid = oid?;
            if ws.change_id(&ws.commit(oid)?).starts_with(prefix) {
                found.push(oid);
            }
        }
    }
    match found.len() {
        0 => Ok(None),
        1 => Ok(Some(found[0])),
        _ => {
            // Several commits of one change (a divergent change) or several changes.
            Err(GmError::new(
                "ambiguous_revision",
                format!("Change prefix `{prefix}` matches {} commits.", found.len()),
            )
            .hint("Use a longer prefix, or a commit id.")
            .exit(exit::USAGE))
        }
    }
}

/// Resolve several revisions, keeping order and dropping duplicates.
pub fn resolve_many(ws: &Workspace, specs: &[String]) -> Result<Vec<Oid>> {
    let mut out = Vec::new();
    for spec in specs {
        let oid = resolve(ws, spec)?;
        if !out.contains(&oid) {
            out.push(oid);
        }
    }
    Ok(out)
}
