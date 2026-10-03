pub mod agent_setup;
pub mod agents;
pub mod ask;
pub mod ci;
pub mod local;
pub mod network;
pub mod pkg;
pub mod release;
pub mod semantic;
pub mod server;
pub mod timeline;
pub mod tracker;
pub mod worktree;
mod worktree_include;

use crate::model::{Change, ConflictReport, OpResult};
use crate::output::{Format, Result};
use crate::repo::{Rebased, Workspace};
use git2::Oid;
use std::path::PathBuf;

pub struct Ctx {
    pub format: Format,
    pub dry_run: bool,
    pub cwd: PathBuf,
    /// The command line, recorded in the operation log.
    pub argv: String,
}

/// What a local mutation reports before it is committed to disk.
pub struct Outcome {
    pub message: String,
    pub changes: Vec<Oid>,
    pub rebased: Rebased,
}

impl Outcome {
    pub fn new(message: impl Into<String>, changes: Vec<Oid>, rebased: Rebased) -> Outcome {
        Outcome {
            message: message.into(),
            changes,
            rebased,
        }
    }
}

/// Run a mutation against the workspace, then either commit it (writing
/// refs, files and an operation) or, for --dry-run, describe and discard it.
pub fn mutate(ctx: &Ctx, run: impl FnOnce(&mut Workspace) -> Result<Outcome>) -> Result<OpResult> {
    let mut ws = Workspace::open(&ctx.cwd)?;
    let outcome = run(&mut ws)?;
    let operation = if ctx.dry_run {
        None
    } else {
        ws.finish(&ctx.argv)?
    };
    let result = report(&ws, outcome, operation, ctx.dry_run)?;
    if ctx.dry_run {
        ws.discard();
    }
    Ok(result)
}

pub fn report(
    ws: &Workspace,
    outcome: Outcome,
    operation: Option<String>,
    dry_run: bool,
) -> Result<OpResult> {
    let mut changes = Vec::new();
    for oid in outcome.changes {
        if ws.repo.find_commit(oid).is_ok() {
            changes.push(Change::load(ws, oid)?);
        }
    }
    Ok(OpResult {
        operation,
        dry_run,
        message: outcome.message,
        working_copy: Change::load(ws, ws.wc())?,
        changes,
        rebased: outcome.rebased.rebased,
        conflicts: outcome
            .rebased
            .conflicts
            .into_iter()
            .map(|(id, paths)| ConflictReport {
                change_id: id[..crate::repo::ids::SHORT_CHANGE].to_string(),
                paths,
            })
            .collect(),
    })
}

pub fn message(parts: &[String]) -> String {
    let text = parts
        .iter()
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    if text.is_empty() {
        text
    } else {
        format!("{text}\n")
    }
}

pub fn short(ws: &Workspace, oid: Oid) -> String {
    ws.commit(oid)
        .map(|c| ws.change_id(&c)[..crate::repo::ids::SHORT_CHANGE].to_string())
        .unwrap_or_else(|_| oid.to_string()[..12].to_string())
}
