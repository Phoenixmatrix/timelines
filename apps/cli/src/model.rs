//! The shapes gm prints. Each derives a JSON Schema, which `gm schema`
//! serves so agents know the output before running a command.

use crate::graph::{self, Node};
use crate::output::{Render, style};
use crate::repo::{Workspace, ids};
use git2::Oid;
use schemars::JsonSchema;
use serde::Serialize;

#[derive(Serialize, JsonSchema, Clone)]
pub struct Change {
    /// Stable id of the change, kept across rewrites (shortest form, letters k-z).
    pub change_id: String,
    /// The current git commit for the change (12 hex characters).
    pub commit_id: String,
    /// Full description; empty until described.
    pub description: String,
    pub author: String,
    /// When the change was first created (RFC 3339).
    pub created: String,
    /// Change ids of the parents.
    pub parents: Vec<String>,
    /// Makes no difference to its parent.
    pub empty: bool,
    /// Already part of trunk; can't be rewritten.
    pub immutable: bool,
    /// This is `@`, the change your edits go into.
    pub working_copy: bool,
    pub bookmarks: Vec<String>,
    /// Files with unresolved conflict markers.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub conflicts: Vec<String>,
}

impl Change {
    pub fn load(ws: &Workspace, oid: Oid) -> crate::output::Result<Change> {
        let commit = ws.commit(oid)?;
        let change_id = ws.change_id(&commit);
        let when = commit.author().when();
        let offset = chrono::FixedOffset::east_opt(when.offset_minutes() * 60)
            .unwrap_or(chrono::FixedOffset::east_opt(0).unwrap());
        let created = chrono::DateTime::from_timestamp(when.seconds(), 0)
            .map(|t| t.with_timezone(&offset).to_rfc3339())
            .unwrap_or_default();
        let s = oid.to_string();
        let mut bookmarks: Vec<String> = ws
            .view
            .bookmarks
            .iter()
            .filter(|(_, t)| **t == s)
            .map(|(n, _)| n.clone())
            .collect();
        // Trunk, and main too in a checkout bound to a timeline.
        let lines = ws
            .trunk
            .iter()
            .flat_map(|t| std::iter::once(t).chain(t.main.as_deref()));
        for trunk in lines {
            if trunk.oid == oid && trunk.refname.starts_with("refs/remotes/") {
                let name = trunk
                    .refname
                    .trim_start_matches("refs/remotes/")
                    .to_string();
                if !bookmarks.contains(&name) {
                    bookmarks.push(name);
                }
            }
        }
        let parents = commit
            .parents()
            .map(|p| ws.change_id(&p)[..ids::SHORT_CHANGE].to_string())
            .collect();
        let author = commit.author();
        Ok(Change {
            conflicts: ws.conflicts_of(&change_id),
            change_id: change_id[..ids::SHORT_CHANGE].to_string(),
            commit_id: ids::short_commit(oid),
            description: Workspace::description(&commit).trim_end().to_string(),
            author: format!(
                "{} <{}>",
                author.name().unwrap_or(""),
                author.email().unwrap_or("")
            ),
            created,
            parents,
            empty: ws.is_empty(&commit)?,
            immutable: ws.is_immutable(oid)?,
            working_copy: oid == ws.wc(),
            bookmarks,
        })
    }

    pub fn summary(&self) -> &str {
        self.description.lines().next().unwrap_or("")
    }

    /// One line, jj style: marker, change id, commit id, bookmarks, summary.
    pub fn line(&self) -> String {
        format!("{} {}", self.marker(), self.label())
    }

    /// `@` for the working copy, `◆` for immutable changes, `○` for the rest.
    pub fn marker(&self) -> &'static str {
        if self.working_copy {
            "@"
        } else if self.immutable {
            "◆"
        } else {
            "○"
        }
    }

    /// The line without its marker: change id, commit id, bookmarks, summary.
    pub fn label(&self) -> String {
        let mut parts = vec![
            style::change(&self.change_id),
            style::commit(&self.commit_id),
        ];
        if !self.bookmarks.is_empty() {
            parts.push(style::bookmark(&self.bookmarks.join(" ")));
        }
        if !self.conflicts.is_empty() {
            parts.push(style::bad("(conflict)"));
        }
        if self.empty {
            parts.push(style::dim("(empty)"));
        }
        parts.push(if self.description.is_empty() {
            style::dim("(no description)")
        } else {
            self.summary().to_string()
        });
        parts.join(" ")
    }
}

impl Render for Change {
    fn text(&self) -> String {
        let mut out = self.line();
        let body: Vec<&str> = self.description.lines().skip(1).collect();
        if !body.is_empty() {
            out.push('\n');
            out.push_str(&body.join("\n"));
        }
        out
    }
}

#[derive(Serialize, JsonSchema)]
pub struct ConflictReport {
    pub change_id: String,
    pub paths: Vec<String>,
}

/// What every command that changes the repository returns.
#[derive(Serialize, JsonSchema)]
pub struct OpResult {
    /// Id of the recorded operation (pass to `gm op restore`); null for --dry-run or no-ops.
    pub operation: Option<String>,
    /// True when nothing was written because of --dry-run.
    pub dry_run: bool,
    /// One sentence on what happened.
    pub message: String,
    /// The working-copy change after the operation.
    pub working_copy: Change,
    /// The changes the command created or rewrote, newest first.
    pub changes: Vec<Change>,
    /// Descendants that were rebased automatically.
    pub rebased: usize,
    /// Changes left with conflict markers by the rebase.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub conflicts: Vec<ConflictReport>,
}

impl Render for OpResult {
    fn text(&self) -> String {
        let mut out = String::new();
        if self.dry_run {
            out.push_str(&style::dim("dry run: nothing was changed\n"));
        }
        out.push_str(&self.message);
        out.push('\n');
        for change in &self.changes {
            out.push_str(&format!("  {}\n", change.line()));
        }
        if self.rebased > 0 {
            out.push_str(&format!("Rebased {} descendant change(s).\n", self.rebased));
        }
        for conflict in &self.conflicts {
            out.push_str(&style::bad(&format!(
                "Conflict in {}: {}\n",
                conflict.change_id,
                conflict.paths.join(", ")
            )));
        }
        out.push_str(&format!("Working copy: {}", self.working_copy.line()));
        out
    }
}

#[derive(Serialize, JsonSchema)]
pub struct FileChange {
    pub path: String,
    /// added, modified, deleted, renamed, copied or typechange.
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub additions: usize,
    pub deletions: usize,
    pub binary: bool,
}

#[derive(Serialize, JsonSchema)]
pub struct TrunkInfo {
    /// Remote bookmark, e.g. origin/main.
    pub name: String,
    pub change_id: String,
    pub commit_id: String,
    /// Changes between trunk and `@` (inclusive of `@` when it isn't empty).
    pub ahead: usize,
    /// Whether `@` is built on the latest fetched trunk.
    pub up_to_date: bool,
}

#[derive(Serialize, JsonSchema)]
pub struct Status {
    pub working_copy: Change,
    pub parents: Vec<Change>,
    /// Files `@` changes relative to its parent.
    pub files: Vec<FileChange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trunk: Option<TrunkInfo>,
    /// Every mutable change with unresolved conflicts.
    pub conflicts: Vec<ConflictReport>,
    /// The operation recorded by snapshotting the working copy, if files changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_operation: Option<String>,
}

impl Render for Status {
    fn text(&self) -> String {
        let mut out = String::new();
        if self.files.is_empty() {
            out.push_str("The working copy has no changes.\n");
        } else {
            out.push_str("Working copy changes:\n");
            for f in &self.files {
                let letter = match f.status.as_str() {
                    "added" => style::good("A"),
                    "deleted" => style::bad("D"),
                    "renamed" => "R".to_string(),
                    _ => "M".to_string(),
                };
                out.push_str(&format!("  {letter} {}\n", f.path));
            }
        }
        out.push_str(&format!("Working copy : {}\n", self.working_copy.line()));
        for parent in &self.parents {
            out.push_str(&format!("Parent       : {}\n", parent.line()));
        }
        if let Some(trunk) = &self.trunk {
            let state = if trunk.up_to_date {
                "up to date".to_string()
            } else {
                "behind: run `gm sync`".to_string()
            };
            out.push_str(&format!(
                "Trunk        : {} {} ({} change(s) ahead, {state})\n",
                style::bookmark(&trunk.name),
                style::commit(&trunk.commit_id),
                trunk.ahead
            ));
        }
        for conflict in &self.conflicts {
            out.push_str(&style::bad(&format!(
                "Conflict in {}: {}\n",
                conflict.change_id,
                conflict.paths.join(", ")
            )));
        }
        out
    }
}

#[derive(Serialize, JsonSchema)]
pub struct Log {
    /// Newest first. Mutable changes, then the trunk commit they build on.
    pub changes: Vec<Change>,
    /// More commits exist beyond --limit.
    pub truncated: bool,
}

impl Render for Log {
    fn text(&self) -> String {
        let nodes: Vec<Node> = self
            .changes
            .iter()
            .map(|c| Node {
                id: &c.change_id,
                parents: &c.parents,
                glyph: c.marker(),
                text: c.label(),
            })
            .collect();
        let mut lines = graph::draw(&nodes);
        if self.truncated {
            let hint = style::dim("(more: raise --limit)");
            // Put the hint beside the `~` that already marks the elided history.
            match lines.last_mut() {
                Some(last)
                    if last.contains('~')
                        && last.chars().all(|ch| matches!(ch, '~' | '│' | ' ')) =>
                {
                    last.push_str("  ");
                    last.push_str(&hint);
                }
                _ => lines.push(format!("~  {hint}")),
            }
        }
        lines.join("\n")
    }
}

#[derive(Serialize, JsonSchema)]
pub struct Diff {
    /// The change the diff is for (compared with its first parent), or null for a range.
    pub change: Option<Change>,
    pub files: Vec<FileChange>,
    /// Unified diff; omitted with --stat.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch: Option<String>,
}

impl Render for Diff {
    fn text(&self) -> String {
        let mut out = String::new();
        if let Some(change) = &self.change {
            out.push_str(&change.text());
            out.push_str("\n\n");
        }
        match &self.patch {
            Some(patch) => {
                for line in patch.lines() {
                    let styled = if line.starts_with('+') && !line.starts_with("+++") {
                        style::good(line)
                    } else if line.starts_with('-') && !line.starts_with("---") {
                        style::bad(line)
                    } else if line.starts_with("@@") {
                        style::commit(line)
                    } else {
                        line.to_string()
                    };
                    out.push_str(&styled);
                    out.push('\n');
                }
            }
            None => {
                for f in &self.files {
                    out.push_str(&format!("{} | +{} -{}\n", f.path, f.additions, f.deletions));
                }
            }
        }
        if self.files.is_empty() {
            out.push_str("(no changes)\n");
        }
        out
    }
}

/// Generic JSON value results (server APIs), rendered as pretty JSON for people.
#[derive(Serialize, JsonSchema)]
#[serde(transparent)]
pub struct Json(pub serde_json::Value);

impl Render for Json {
    fn text(&self) -> String {
        serde_json::to_string_pretty(&self.0).unwrap_or_default()
    }
}
