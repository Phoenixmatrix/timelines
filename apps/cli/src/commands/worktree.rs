//! Linked Git worktrees with independent gm working copies.

use super::{Ctx, worktree_include};
use crate::cli::WorktreeCommand;
use crate::output::{GmError, Render, Result, exit};
use crate::repo::{Workspace, revset, view::Store};
use git2::Repository;
use schemars::JsonSchema;
use serde::Serialize;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Default, Serialize, JsonSchema)]
pub struct WorktreeInfo {
    pub path: PathBuf,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub bare: bool,
    pub locked: Option<String>,
    pub prunable: Option<String>,
    pub current: bool,
    pub initialized: bool,
    pub working_copy: Option<String>,
}

#[derive(Serialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum WorktreeResult {
    List {
        worktrees: Vec<WorktreeInfo>,
    },
    Add {
        path: PathBuf,
        base: String,
        working_copy: Option<String>,
        copied_files: Vec<PathBuf>,
        dry_run: bool,
    },
    Remove {
        path: PathBuf,
        recovery_path: Option<PathBuf>,
        recovery_ref_prefix: Option<String>,
        dry_run: bool,
    },
}

impl Render for WorktreeResult {
    fn text(&self) -> String {
        match self {
            Self::List { worktrees } => worktrees
                .iter()
                .map(|w| {
                    format!(
                        "{} {}  {}{}{}{}",
                        if w.current { "*" } else { " " },
                        w.path.display(),
                        w.branch
                            .as_deref()
                            .unwrap_or(if w.bare { "bare" } else { "detached" }),
                        if w.initialized { " [gm]" } else { "" },
                        if w.locked.is_some() { " [locked]" } else { "" },
                        if w.prunable.is_some() {
                            " [prunable]"
                        } else {
                            ""
                        }
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"),
            Self::Add {
                path,
                base,
                copied_files,
                dry_run,
                ..
            } => format!(
                "{} worktree {} on {} ({} included files).",
                if *dry_run { "Would create" } else { "Created" },
                path.display(),
                base,
                copied_files.len()
            ),
            Self::Remove {
                path,
                recovery_path,
                dry_run,
                ..
            } => {
                let mut message = format!(
                    "{} worktree {}.",
                    if *dry_run { "Would remove" } else { "Removed" },
                    path.display()
                );
                if let Some(recovery) = recovery_path {
                    message.push_str(&format!("\nSaved gm history: {}", recovery.display()));
                }
                message
            }
        }
    }
}

fn git(cwd: &Path, args: &[&OsStr]) -> Result<Vec<u8>> {
    let output = Command::new("git").current_dir(cwd).args(args).output()?;
    if !output.status.success() {
        return Err(GmError::new(
            "worktree_git_error",
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        )
        .exit(exit::CONFLICT));
    }
    Ok(output.stdout)
}

fn discover(cwd: &Path) -> Result<Repository> {
    Repository::discover(cwd)
        .map_err(|_| GmError::not_found("not_a_repository", "Not inside a git repository."))
}

fn list(cwd: &Path, repo: &Repository) -> Result<Vec<WorktreeInfo>> {
    let bytes = git(
        cwd,
        &[
            "worktree".as_ref(),
            "list".as_ref(),
            "--porcelain".as_ref(),
            "-z".as_ref(),
        ],
    )?;
    let text = std::str::from_utf8(&bytes).map_err(|_| {
        GmError::new(
            "invalid_worktree_path",
            "Worktree paths must be valid UTF-8 for JSON output.",
        )
    })?;
    let current = repo.workdir().map(fs::canonicalize).transpose()?;
    let mut result = Vec::new();
    let mut entry = WorktreeInfo::default();
    for field in text.split('\0') {
        if field.is_empty() {
            if entry.path.as_os_str().is_empty() {
                continue;
            }
            entry.current = current
                .as_ref()
                .is_some_and(|p| fs::canonicalize(&entry.path).ok().as_ref() == Some(p));
            if !entry.bare
                && let Ok(worktree) = Repository::open(&entry.path)
            {
                let store = Store::new(worktree.path());
                entry.initialized = store.exists();
                if entry.initialized {
                    entry.working_copy = Some(store.load_view()?.wc);
                }
            }
            result.push(std::mem::take(&mut entry));
        } else if let Some(path) = field.strip_prefix("worktree ") {
            entry.path = path.into();
        } else if let Some(head) = field.strip_prefix("HEAD ") {
            entry.head = Some(head.into());
        } else if let Some(branch) = field.strip_prefix("branch ") {
            entry.branch = Some(branch.into());
        } else if field == "bare" {
            entry.bare = true;
        } else if field == "locked" {
            entry.locked = Some(String::new());
        } else if let Some(reason) = field.strip_prefix("locked ") {
            entry.locked = Some(reason.into());
        } else if field == "prunable" {
            entry.prunable = Some(String::new());
        } else if let Some(reason) = field.strip_prefix("prunable ") {
            entry.prunable = Some(reason.into());
        }
    }
    Ok(result)
}

pub fn run(ctx: &Ctx, command: &WorktreeCommand) -> Result<WorktreeResult> {
    match command {
        WorktreeCommand::List => {
            let repo = discover(&ctx.cwd)?;
            let _lock = Workspace::lock_repository(&repo)?;
            Ok(WorktreeResult::List {
                worktrees: list(&ctx.cwd, &repo)?,
            })
        }
        WorktreeCommand::Add {
            path,
            revision,
            include,
        } => add(ctx, path, revision, *include),
        WorktreeCommand::Remove { path, force } => remove(ctx, path, *force),
    }
}

fn add(ctx: &Ctx, path: &Path, revision: &str, include: bool) -> Result<WorktreeResult> {
    let target = std::path::absolute(ctx.cwd.join(path))?;
    if target.symlink_metadata().is_ok()
        && (!target.is_dir() || fs::read_dir(&target)?.next().is_some())
    {
        return Err(GmError::new(
            "directory_not_empty",
            format!(
                "{} already exists and isn't an empty directory.",
                target.display()
            ),
        )
        .exit(exit::CONFLICT));
    }
    let ws = if ctx.dry_run {
        Workspace::open_readonly(&ctx.cwd)?
    } else {
        Workspace::open(&ctx.cwd)?
    };
    let base = revset::resolve(&ws, revision)?.to_string();
    let mut paths = if include {
        worktree_include::plan(&ws.repo)?
    } else {
        Vec::new()
    };
    paths.extend(worktree_include::always(&ws.repo)?);
    paths.sort();
    paths.dedup();
    let source = ws
        .repo
        .workdir()
        .expect("workspace has workdir")
        .to_path_buf();
    if ctx.dry_run {
        return Ok(WorktreeResult::Add {
            path: target,
            base,
            working_copy: None,
            copied_files: paths,
            dry_run: true,
        });
    }
    git(
        &ctx.cwd,
        &[
            "worktree".as_ref(),
            "add".as_ref(),
            "--detach".as_ref(),
            "--".as_ref(),
            target.as_os_str(),
            base.as_ref(),
        ],
    )?;
    // Initialization takes the same repository lock: release the source first.
    drop(ws);
    let setup = || -> Result<String> {
        let target_ws = Workspace::init(&target)?;
        worktree_include::copy(&source, &target, &paths)?;
        Ok(target_ws.view.wc.clone())
    };
    let wc = setup().map_err(|error| GmError::new("worktree_setup_failed", format!("Created {}, but setup failed: {}", target.display(), error.message))
        .hint("The worktree was kept. Inspect it with `gm worktree list`; fix setup manually or remove it with `gm worktree remove <path> --force`."))?;
    Ok(WorktreeResult::Add {
        path: fs::canonicalize(target)?,
        base,
        working_copy: Some(wc),
        copied_files: paths,
        dry_run: false,
    })
}

fn remove(ctx: &Ctx, path: &Path, force: bool) -> Result<WorktreeResult> {
    let repo = discover(&ctx.cwd)?;
    let _lock = Workspace::lock_repository(&repo)?;
    let target = fs::canonicalize(ctx.cwd.join(path))?;
    let entry = list(&ctx.cwd, &repo)?
        .into_iter()
        .find(|w| fs::canonicalize(&w.path).ok().as_ref() == Some(&target))
        .ok_or_else(|| {
            GmError::not_found(
                "worktree_not_found",
                "That directory is not a worktree of this repository.",
            )
        })?;
    let target_repo = Repository::open(&target)?;
    if !target_repo.is_worktree() || fs::canonicalize(&ctx.cwd)?.starts_with(&target) {
        return Err(GmError::usage(
            "Cannot remove the main checkout or the worktree containing the current directory.",
        ));
    }
    if entry.locked.is_some() {
        return Err(GmError::new("worktree_locked", "The worktree is locked; unlock it with `git worktree unlock <path>` before removing it.").exit(exit::CONFLICT));
    }
    // Git itself allows deleting ignored files. Require explicit consent for them too.
    if !force
        && !git(
            &target,
            &[
                "status".as_ref(),
                "--porcelain=v1".as_ref(),
                "-z".as_ref(),
                "--untracked-files=all".as_ref(),
                "--ignored=matching".as_ref(),
            ],
        )?
        .is_empty()
    {
        return Err(GmError::new("worktree_dirty", "Worktree contains modified, untracked or ignored files.")
            .hint("Keep needed files elsewhere, then use `gm worktree remove <path> --force` to discard them.").exit(exit::CONFLICT));
    }
    if ctx.dry_run {
        return Ok(WorktreeResult::Remove {
            path: target,
            recovery_path: None,
            recovery_ref_prefix: None,
            dry_run: true,
        });
    }
    let (recovery_path, recovery_ref_prefix) = archive(&target_repo)?;
    let retained = Workspace::retention_ref_prefix(&target_repo)?;
    drop(target_repo);
    let mut args = vec![OsStr::new("worktree"), OsStr::new("remove")];
    if force {
        args.push(OsStr::new("--force"));
    }
    args.extend([OsStr::new("--"), target.as_os_str()]);
    git(&ctx.cwd, &args)?;
    if recovery_path.is_some() {
        for reference in repo.references_glob(&format!("{retained}*"))? {
            reference?.delete()?;
        }
    }
    Ok(WorktreeResult::Remove {
        path: target,
        recovery_path,
        recovery_ref_prefix,
        dry_run: false,
    })
}

/// Keep the gm log and shared object anchors together after removing its directory.
/// Read recorded views too, so older worktrees need not be opened before removal.
fn archive(repo: &Repository) -> Result<(Option<PathBuf>, Option<String>)> {
    let store = Store::new(repo.path());
    if !store.exists() {
        return Ok((None, None));
    }
    let id = crate::repo::view::new_op_id();
    let directory = repo.commondir().join("gm/removed-worktrees").join(&id);
    fs::create_dir_all(&directory)?;
    for name in ["view.json", "ops.jsonl"] {
        let source = store.dir().join(name);
        if source.exists() {
            fs::copy(source, directory.join(name))?;
        }
    }
    let prefix = format!("refs/gm/removed-worktrees/{id}/");
    let mut commits = std::collections::BTreeSet::new();
    let mut retain = |view: crate::repo::view::View| {
        commits.insert(view.wc);
        commits.extend(view.heads);
        commits.extend(view.bookmarks.into_values());
    };
    retain(store.load_view()?);
    for operation in store.ops()? {
        retain(operation.before);
        retain(operation.after);
    }
    for target in commits {
        let oid = git2::Oid::from_str(&target)?;
        repo.reference(
            &format!("{prefix}{oid}"),
            oid,
            false,
            "gm: retain removed worktree history",
        )?;
    }
    Ok((Some(directory), Some(prefix)))
}
