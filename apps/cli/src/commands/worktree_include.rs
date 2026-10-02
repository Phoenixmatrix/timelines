//! Opt-in copying of ignored local configuration into a new worktree.
//!
//! Patterns use gitignore syntax, but a positive match means include. Unlike
//! Claude's traversal optimization, `**` also finds files in wholly ignored
//! directories. Symlinks are rejected rather than copied or dereferenced.

use crate::output::{GmError, Result};
use cap_std::fs::{Dir, OpenOptions};
use ignore::gitignore::GitignoreBuilder;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

fn failure(path: &Path, error: impl std::fmt::Display) -> GmError {
    GmError::new(
        "worktree_include_failed",
        format!("Cannot include '{}': {error}", path.display()),
    )
    .hint("Fix the path or .worktreeinclude pattern, or omit --include. If a worktree was created, it has been retained; inspect it before retrying.")
}

fn root(path: &Path) -> Result<Dir> {
    Dir::open_ambient_dir(path, cap_std::ambient_authority()).map_err(|error| failure(path, error))
}

fn validate(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty()
        || path.components().any(|part| match part {
            Component::Normal(name) => name.to_string_lossy().eq_ignore_ascii_case(".git"),
            _ => true,
        })
    {
        return Err(failure(
            path,
            "expected a relative file path without .git or traversal",
        ));
    }
    Ok(())
}

// Check every component, not just the leaf. Capability-relative opens below
// additionally prevent escape if a component is swapped after this check.
fn regular_file(dir: &Dir, path: &Path) -> Result<()> {
    validate(path)?;
    let mut prefix = PathBuf::new();
    for part in path.components() {
        prefix.push(part);
        let metadata = dir
            .symlink_metadata(&prefix)
            .map_err(|e| failure(path, e))?;
        if metadata.file_type().is_symlink()
            || (prefix != path && !metadata.is_dir())
            || (prefix == path && !metadata.is_file())
        {
            return Err(failure(
                path,
                "only regular files and non-symlink parent directories are supported",
            ));
        }
    }
    Ok(())
}

/// Copied into every new worktree, with or without .worktreeinclude: this
/// checkout's agent (`gm agent setup`), so work in a worktree is attributed to
/// the same agent. It names the agent and its profile; its token stays with
/// gm's credentials, never in the checkout.
pub const ALWAYS: &[&str] = &[".gitmatrix/agent.local.yml"];

/// The files of ALWAYS this checkout has: untracked regular files only (a
/// tracked one arrives with the checkout; anything else is skipped, not copied).
pub fn always(repo: &git2::Repository) -> Result<Vec<PathBuf>> {
    let Some(source) = repo.workdir() else {
        return Ok(Vec::new());
    };
    let dir = root(source)?;
    let index = repo.index().map_err(|e| failure(source, e))?;
    Ok(ALWAYS
        .iter()
        .map(PathBuf::from)
        .filter(|path| {
            !(0..=3).any(|stage| index.get_path(path, stage).is_some())
                && regular_file(&dir, path).is_ok()
        })
        .collect())
}

/// Resolve inclusion before creating a destination, so it cannot include itself.
pub fn plan(repo: &git2::Repository) -> Result<Vec<PathBuf>> {
    let source = repo.workdir().ok_or_else(|| {
        failure(
            Path::new(".worktreeinclude"),
            "a working directory is required",
        )
    })?;
    let dir = root(source)?;
    let include = Path::new(".worktreeinclude");
    match dir.symlink_metadata(include) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(failure(include, e)),
        Ok(_) => regular_file(&dir, include)?,
    }
    let mut text = String::new();
    dir.open(include)
        .map_err(|e| failure(include, e))?
        .read_to_string(&mut text)
        .map_err(|e| failure(include, e))?;
    let mut builder = GitignoreBuilder::new(source);
    for line in text.lines() {
        builder
            .add_line(Some(source.join(include)), line)
            .map_err(|e| failure(include, e))?;
    }
    let patterns = builder.build().map_err(|e| failure(include, e))?;
    if patterns.num_ignores() == 0 {
        return Ok(Vec::new());
    }

    // Git performs ignored/untracked enumeration using the real index and all
    // normal ignore sources. This avoids status/diff work on tracked files and
    // handles ignored directories without an independent whole-repo walker.
    let output = Command::new("git")
        .arg("--git-dir")
        .arg(repo.path())
        .arg("--work-tree")
        .arg(source)
        .args([
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "-z",
        ])
        .env_remove("GIT_INDEX_FILE")
        .current_dir(source)
        .output()
        .map_err(|e| failure(include, e))?;
    if !output.status.success() {
        return Err(failure(include, String::from_utf8_lossy(&output.stderr)));
    }
    // Workspace::open installs a snapshot index that may differ from the
    // native Git index. A file tracked by either index is never an include.
    let index = repo.index().map_err(|e| failure(include, e))?;
    let mut paths = Vec::new();
    for bytes in output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|p| !p.is_empty())
    {
        let path = git_path(bytes)?;
        validate(&path)?;
        if (0..=3).any(|stage| index.get_path(&path, stage).is_some()) {
            continue;
        }
        if patterns
            .matched_path_or_any_parents(&path, false)
            .is_ignore()
        {
            regular_file(&dir, &path)?;
            paths.push(path);
        }
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

#[cfg(unix)]
fn git_path(bytes: &[u8]) -> Result<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    Ok(PathBuf::from(std::ffi::OsStr::from_bytes(bytes)))
}

#[cfg(not(unix))]
fn git_path(bytes: &[u8]) -> Result<PathBuf> {
    std::str::from_utf8(bytes)
        .map(PathBuf::from)
        .map_err(|e| failure(Path::new(".worktreeinclude"), e))
}

/// Copy without replacing any existing entry, including missing tracked files.
/// On failure, already copied files remain for inspection and recovery.
pub fn copy(source: &Path, destination: &Path, paths: &[PathBuf]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let source_dir = root(source)?;
    let destination_dir = root(destination)?;
    let repo = git2::Repository::open(destination).map_err(|e| failure(destination, e))?;
    let index = repo.index().map_err(|e| failure(destination, e))?;
    for path in paths {
        regular_file(&source_dir, path)?;
        if (0..=3).any(|stage| index.get_path(path, stage).is_some()) {
            return Err(failure(
                path,
                "destination path is tracked; refusing to overwrite it",
            ));
        }
        let mut prefix = PathBuf::new();
        if let Some(parent) = path.parent() {
            for part in parent.components() {
                prefix.push(part);
                if (0..=3).any(|stage| index.get_path(&prefix, stage).is_some()) {
                    return Err(failure(
                        path,
                        "destination parent is tracked; refusing to replace it",
                    ));
                }
                match destination_dir.symlink_metadata(&prefix) {
                    Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                    Ok(_) => {
                        return Err(failure(path, "destination parent is not a plain directory"));
                    }
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {
                        destination_dir
                            .create_dir(&prefix)
                            .map_err(|e| failure(path, e))?;
                    }
                    Err(e) => return Err(failure(path, e)),
                }
            }
        }
        let mut input = source_dir
            .open(path)
            .map_err(|e| failure(path, e))?
            .into_std();
        let metadata = input.metadata().map_err(|e| failure(path, e))?;
        if !metadata.is_file() {
            return Err(failure(path, "source is no longer a regular file"));
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        let mut output = destination_dir
            .open_with(path, &options)
            .map_err(|e| failure(path, e))?
            .into_std();
        // Restrict permissions before copying secrets; preserve executable bits.
        output
            .set_permissions(metadata.permissions())
            .map_err(|e| failure(path, e))?;
        io::copy(&mut input, &mut output).map_err(|e| failure(path, e))?;
        // Writing may clear special mode bits on some platforms.
        output
            .set_permissions(metadata.permissions())
            .map_err(|e| failure(path, e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn fixture() -> (TempDir, git2::Repository) {
        let temp = TempDir::new().unwrap();
        let repo = git2::Repository::init(temp.path()).unwrap();
        (temp, repo)
    }

    fn put(root: &Path, path: &str, content: &str) {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn patterns_select_only_ignored_untracked_files() {
        let (temp, repo) = fixture();
        let root = temp.path();
        put(root, ".gitignore", "*.env\ncache/\nsecrets/\n");
        put(
            root,
            ".worktreeinclude",
            "# comment\n\n/root.env\ncache/\n!cache/private.env\nsecrets/**/config.json\nvisible.txt\ntracked.env\n",
        );
        for name in [
            "root.env",
            "nested/root.env",
            "cache/a.env",
            "cache/private.env",
            "cache/deep/file",
            "secrets/deep/config.json",
            "secrets/no.txt",
            "visible.txt",
            "tracked.env",
        ] {
            put(root, name, name);
        }
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("tracked.env")).unwrap();
        index.write().unwrap();
        assert_eq!(
            plan(&repo).unwrap(),
            [
                "cache/a.env",
                "cache/deep/file",
                "root.env",
                "secrets/deep/config.json"
            ]
            .map(PathBuf::from)
        );
    }

    #[test]
    fn snapshot_tracked_files_are_excluded_even_when_native_git_ignores_them() {
        let (temp, repo) = fixture();
        put(temp.path(), ".gitignore", "*.env\n");
        put(temp.path(), ".worktreeinclude", "*.env\n");
        put(temp.path(), "snapshot.env", "tracked only by gm");
        put(temp.path(), "local.env", "untracked");
        assert_eq!(
            plan(&repo).unwrap(),
            ["local.env", "snapshot.env"].map(PathBuf::from)
        );

        let mut index = repo.index().unwrap();
        index.add_path(Path::new("snapshot.env")).unwrap();
        let tree_id = index.write_tree().unwrap();
        let mut snapshot = git2::Index::open(&repo.path().join("gm-test-index")).unwrap();
        snapshot
            .read_tree(&repo.find_tree(tree_id).unwrap())
            .unwrap();
        repo.set_index(&mut snapshot).unwrap();

        assert_eq!(plan(&repo).unwrap(), vec![PathBuf::from("local.env")]);
    }

    #[test]
    fn the_checkouts_agent_is_always_included_unless_tracked_or_absent() {
        let (temp, repo) = fixture();
        assert!(always(&repo).unwrap().is_empty());
        put(temp.path(), ".gitignore", ".gitmatrix/agent.local.yml\n");
        put(temp.path(), ".gitmatrix/agent.local.yml", "name: builder\n");
        assert_eq!(
            always(&repo).unwrap(),
            vec![PathBuf::from(".gitmatrix/agent.local.yml")]
        );
        let mut index = repo.index().unwrap();
        index
            .add_path(Path::new(".gitmatrix/agent.local.yml"))
            .unwrap();
        index.write().unwrap();
        assert!(always(&repo).unwrap().is_empty());
    }

    #[test]
    fn missing_include_is_empty_and_double_star_reaches_ignored_directory() {
        let (temp, repo) = fixture();
        assert!(plan(&repo).unwrap().is_empty());
        put(temp.path(), ".gitignore", "vendor/\n");
        put(temp.path(), ".worktreeinclude", "**/config.json\n");
        put(temp.path(), "vendor/deep/config.json", "secret");
        assert_eq!(
            plan(&repo).unwrap(),
            vec![PathBuf::from("vendor/deep/config.json")]
        );
    }

    #[test]
    fn copying_preserves_content_and_refuses_existing_or_missing_tracked_files() {
        let (source, _) = fixture();
        let (destination, repo) = fixture();
        put(source.path(), "config/local", "secret");
        let paths = vec![PathBuf::from("config/local")];
        copy(source.path(), destination.path(), &paths).unwrap();
        assert_eq!(
            fs::read_to_string(destination.path().join(&paths[0])).unwrap(),
            "secret"
        );
        put(source.path(), "config/local", "replacement");
        assert!(copy(source.path(), destination.path(), &paths).is_err());
        assert_eq!(
            fs::read_to_string(destination.path().join(&paths[0])).unwrap(),
            "secret"
        );
        let mut index = repo.index().unwrap();
        index.add_path(&paths[0]).unwrap();
        index.write().unwrap();
        fs::remove_file(destination.path().join(&paths[0])).unwrap();
        assert!(copy(source.path(), destination.path(), &paths).is_err());
        assert!(!destination.path().join(&paths[0]).exists());
    }

    #[test]
    fn missing_tracked_parent_cannot_be_replaced_with_a_directory() {
        let (source, _) = fixture();
        let (destination, repo) = fixture();
        put(source.path(), "config/local", "secret");
        put(destination.path(), "config", "tracked");
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("config")).unwrap();
        index.write().unwrap();
        fs::remove_file(destination.path().join("config")).unwrap();
        assert!(
            copy(
                source.path(),
                destination.path(),
                &[PathBuf::from("config/local")]
            )
            .is_err()
        );
        assert!(!destination.path().join("config").exists());
    }

    #[test]
    fn traversal_and_metadata_paths_are_rejected() {
        for path in [
            "../secret",
            "/secret",
            ".git/config",
            "nested/.git/config",
            "",
        ] {
            assert!(validate(Path::new(path)).is_err(), "{path}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_escape_either_root_and_modes_are_preserved() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let (source, repo) = fixture();
        let (destination, _) = fixture();
        let outside = TempDir::new().unwrap();
        put(outside.path(), "secret", "outside");
        put(source.path(), ".gitignore", "link\nconfig/\n");
        put(source.path(), ".worktreeinclude", "link\n");
        symlink(outside.path().join("secret"), source.path().join("link")).unwrap();
        assert!(plan(&repo).is_err());
        assert!(copy(source.path(), destination.path(), &[PathBuf::from("link")]).is_err());
        symlink(outside.path(), source.path().join("linked-dir")).unwrap();
        assert!(
            copy(
                source.path(),
                destination.path(),
                &[PathBuf::from("linked-dir/secret")]
            )
            .is_err()
        );
        put(source.path(), "secret", "inside");
        symlink(
            outside.path().join("secret"),
            destination.path().join("secret"),
        )
        .unwrap();
        assert!(
            copy(
                source.path(),
                destination.path(),
                &[PathBuf::from("secret")]
            )
            .is_err()
        );
        put(source.path(), "config/secret", "inside");
        symlink(outside.path(), destination.path().join("config")).unwrap();
        assert!(
            copy(
                source.path(),
                destination.path(),
                &[PathBuf::from("config/secret")]
            )
            .is_err()
        );
        assert_eq!(
            fs::read_to_string(outside.path().join("secret")).unwrap(),
            "outside"
        );
        fs::remove_file(destination.path().join("config")).unwrap();
        fs::set_permissions(
            source.path().join("config/secret"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        copy(
            source.path(),
            destination.path(),
            &[PathBuf::from("config/secret")],
        )
        .unwrap();
        assert_eq!(
            fs::metadata(destination.path().join("config/secret"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
}
