//! Tree arithmetic: merging, moving selected paths between trees, and
//! writing a tree into the working directory.

use crate::output::Result;
use git2::{Index, IndexEntry, MergeFileOptions, Oid, Pathspec, PathspecFlags, Repository};
use std::fs;
use std::path::Path;

const STAGE_MASK: u16 = 0x3000;

fn tree<'r>(repo: &'r Repository, oid: Oid) -> Result<git2::Tree<'r>> {
    Ok(repo.find_tree(oid)?)
}

pub fn empty_tree(repo: &Repository) -> Result<Oid> {
    Ok(repo.treebuilder(None)?.write()?)
}

/// git2's IndexEntry isn't Clone.
fn copy_entry(e: &IndexEntry) -> IndexEntry {
    IndexEntry {
        ctime: git2::IndexTime::new(e.ctime.seconds(), e.ctime.nanoseconds()),
        mtime: git2::IndexTime::new(e.mtime.seconds(), e.mtime.nanoseconds()),
        dev: e.dev,
        ino: e.ino,
        mode: e.mode,
        uid: e.uid,
        gid: e.gid,
        file_size: e.file_size,
        id: e.id,
        flags: e.flags,
        flags_extended: e.flags_extended,
        path: e.path.clone(),
    }
}

fn entry_path(entry: &IndexEntry) -> String {
    String::from_utf8_lossy(&entry.path).into_owned()
}

/// Three-way merge of trees. Conflicting files are written with conflict
/// markers (jj-style: the result is still a commit you can keep working on)
/// and their paths are returned.
pub fn merge(repo: &Repository, base: Oid, ours: Oid, theirs: Oid) -> Result<(Oid, Vec<String>)> {
    if ours == theirs || theirs == base {
        return Ok((ours, Vec::new()));
    }
    if ours == base {
        return Ok((theirs, Vec::new()));
    }
    let mut index = repo.merge_trees(
        &tree(repo, base)?,
        &tree(repo, ours)?,
        &tree(repo, theirs)?,
        None,
    )?;
    if !index.has_conflicts() {
        return Ok((index.write_tree_to(repo)?, Vec::new()));
    }

    let conflicts: Vec<_> = index.conflicts()?.collect::<std::result::Result<_, _>>()?;
    let empty_blob = repo.blob(b"")?;
    let mut paths = Vec::new();
    for conflict in conflicts {
        let any = conflict
            .our
            .as_ref()
            .or(conflict.their.as_ref())
            .or(conflict.ancestor.as_ref())
            .expect("a conflict has at least one side");
        let path = entry_path(any);
        index.conflict_remove(Path::new(&path))?;
        match (&conflict.ancestor, &conflict.our, &conflict.their) {
            (ancestor, Some(our), Some(their)) => {
                let ancestor = match ancestor {
                    Some(a) => copy_entry(a),
                    None => IndexEntry {
                        id: empty_blob,
                        ..copy_entry(our)
                    },
                };
                let mut options = MergeFileOptions::new();
                options
                    .ancestor_label("base")
                    .our_label("destination")
                    .their_label("change");
                let merged =
                    repo.merge_file_from_index(&ancestor, our, their, Some(&mut options))?;
                let blob = repo.blob(merged.content())?;
                let mut entry = copy_entry(our);
                entry.id = blob;
                entry.flags &= !STAGE_MASK;
                index.add(&entry)?;
            }
            // Modified on one side, deleted on the other: keep the edit.
            (_, Some(kept), None) | (_, None, Some(kept)) => {
                let mut entry = copy_entry(kept);
                entry.flags &= !STAGE_MASK;
                index.add(&entry)?;
            }
            (_, None, None) => {}
        }
        paths.push(path);
    }
    paths.sort();
    paths.dedup();
    Ok((index.write_tree_to(repo)?, paths))
}

/// `base` with every path matching `paths` replaced by its version in
/// `from` (or removed, where `from` lacks it).
pub fn with_paths(repo: &Repository, base: Oid, from: Oid, paths: &[String]) -> Result<Oid> {
    if paths.is_empty() {
        return Ok(from);
    }
    let spec = Pathspec::new(paths.iter())?;
    let matches = |entry: &IndexEntry| {
        spec.matches_path(Path::new(&entry_path(entry)), PathspecFlags::DEFAULT)
    };

    let mut result = Index::new()?;
    result.read_tree(&tree(repo, base)?)?;
    let doomed: Vec<String> = result
        .iter()
        .filter(|e| matches(e))
        .map(|e| entry_path(&e))
        .collect();
    for path in doomed {
        result.remove(Path::new(&path), 0)?;
    }
    let mut source = Index::new()?;
    source.read_tree(&tree(repo, from)?)?;
    for entry in source.iter().filter(|e| matches(e)) {
        result.add(&entry)?;
    }
    Ok(result.write_tree_to(repo)?)
}

/// Every path that differs between two trees.
pub fn changed_paths(repo: &Repository, from: Oid, to: Oid) -> Result<Vec<String>> {
    let diff = repo.diff_tree_to_tree(Some(&tree(repo, from)?), Some(&tree(repo, to)?), None)?;
    Ok(diff
        .deltas()
        .filter_map(|d| {
            d.new_file()
                .path()
                .or(d.old_file().path())
                .map(|p| p.to_string_lossy().into_owned())
        })
        .collect())
}

/// Make the working directory go from `from` to `to`, touching only the
/// paths that differ, and keep gm's stat cache (`index`) in step.
pub fn checkout(repo: &Repository, index: &mut Index, from: Oid, to: Oid) -> Result<()> {
    if from == to {
        return Ok(());
    }
    let workdir = repo
        .workdir()
        .expect("gm needs a working directory")
        .to_path_buf();
    let diff = repo.diff_tree_to_tree(Some(&tree(repo, from)?), Some(&tree(repo, to)?), None)?;

    let mut removals = Vec::new();
    let mut writes = Vec::new();
    for delta in diff.deltas() {
        use git2::Delta::*;
        match delta.status() {
            Deleted => removals.push(delta.old_file().path().unwrap().to_path_buf()),
            Added | Modified | Typechange | Renamed | Copied => {
                if delta.status() == Typechange || delta.status() == Renamed {
                    removals.push(delta.old_file().path().unwrap().to_path_buf());
                }
                let file = delta.new_file();
                writes.push((
                    file.path().unwrap().to_path_buf(),
                    file.id(),
                    u32::from(file.mode()),
                ));
            }
            _ => {}
        }
    }

    for rel in &removals {
        let path = workdir.join(rel);
        if fs::symlink_metadata(&path).is_ok() {
            fs::remove_file(&path).or_else(|_| fs::remove_dir_all(&path))?;
        }
        let _ = index.remove_path(rel);
        let mut dir = path.parent();
        while let Some(d) = dir {
            if d == workdir || fs::remove_dir(d).is_err() {
                break;
            }
            dir = d.parent();
        }
    }

    for (rel, oid, mode) in &writes {
        let path = workdir.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        if let Ok(meta) = fs::symlink_metadata(&path) {
            if meta.is_dir() && !meta.file_type().is_symlink() {
                fs::remove_dir_all(&path)?;
            } else {
                fs::remove_file(&path)?;
            }
        }
        match mode {
            0o160000 => {
                fs::create_dir_all(&path)?;
                continue;
            }
            0o120000 => {
                let target = String::from_utf8_lossy(repo.find_blob(*oid)?.content()).into_owned();
                #[cfg(unix)]
                std::os::unix::fs::symlink(target, &path)?;
                #[cfg(not(unix))]
                fs::write(&path, target)?;
            }
            _ => {
                fs::write(&path, repo.find_blob(*oid)?.content())?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let perms = if *mode == 0o100755 { 0o755 } else { 0o644 };
                    fs::set_permissions(&path, fs::Permissions::from_mode(perms))?;
                }
            }
        }
        index.add_path(rel)?;
    }
    index.write()?;
    Ok(())
}

/// Whether a file's contents still carry conflict markers.
pub fn has_conflict_markers(content: &[u8]) -> bool {
    content
        .split(|b| *b == b'\n')
        .any(|line| line.starts_with(b"<<<<<<< ") || line == b"<<<<<<<")
}
