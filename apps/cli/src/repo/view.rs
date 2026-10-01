//! What gm remembers beside git's own refs, and the operation log that makes
//! every command undoable.
//!
//! Lives in `.git/gm/`: `view.json` (the current view), `ops.jsonl` (one
//! operation per line, newest last) and `index` (gm's stat cache for
//! snapshotting the working copy).

use super::super::output::Result;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Everything an operation can change. Restoring a view restores the repo.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct View {
    /// The working-copy commit (`@`).
    pub wc: String,
    /// Tips of the visible change graph that no bookmark or `@` keeps alive.
    pub heads: BTreeSet<String>,
    /// Local bookmarks (git branches) and the commits they point at.
    pub bookmarks: BTreeMap<String, String>,
    /// Paths still holding conflict markers, by change id.
    #[serde(default)]
    pub conflicts: BTreeMap<String, Vec<String>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Operation {
    pub id: String,
    pub time: String,
    pub command: String,
    pub before: View,
    pub after: View,
    /// Set on operations that a later `gm undo` reversed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undone_by: Option<String>,
    /// For undo/restore operations: the operation they reversed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undoes: Option<String>,
}

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(git_dir: &Path) -> Store {
        Store {
            dir: git_dir.join("gm"),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn exists(&self) -> bool {
        self.dir.join("view.json").exists()
    }

    pub fn index_path(&self) -> PathBuf {
        self.dir.join("index")
    }

    pub fn lock_path(&self) -> PathBuf {
        self.dir.join("lock")
    }

    pub fn load_view(&self) -> Result<View> {
        Ok(serde_json::from_slice(&fs::read(
            self.dir.join("view.json"),
        )?)?)
    }

    pub fn save_view(&self, view: &View) -> Result<()> {
        fs::create_dir_all(&self.dir)?;
        let tmp = self.dir.join("view.json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(view)?)?;
        fs::rename(tmp, self.dir.join("view.json"))?;
        Ok(())
    }

    pub fn append_op(&self, op: &Operation) -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join("ops.jsonl"))?;
        writeln!(file, "{}", serde_json::to_string(op)?)?;
        Ok(())
    }

    pub fn ops(&self) -> Result<Vec<Operation>> {
        let path = self.dir.join("ops.jsonl");
        if !path.exists() {
            return Ok(Vec::new());
        }
        fs::read_to_string(path)?
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| Ok(serde_json::from_str(line)?))
            .collect()
    }

    /// Rewrite the log, used only to mark an operation as undone.
    pub fn save_ops(&self, ops: &[Operation]) -> Result<()> {
        let tmp = self.dir.join("ops.jsonl.tmp");
        let mut body = String::new();
        for op in ops {
            body.push_str(&serde_json::to_string(op)?);
            body.push('\n');
        }
        fs::write(&tmp, body)?;
        fs::rename(tmp, self.dir.join("ops.jsonl"))?;
        Ok(())
    }
}

pub fn new_op_id() -> String {
    rand::random::<[u8; 6]>()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
