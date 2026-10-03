//! The change model on top of a plain git repository.
//!
//! * The working copy is always a commit (`@`). Every gm command first
//!   snapshots the files on disk into it, so there is no staging area and
//!   nothing is ever "uncommitted".
//! * Each change has a change id that survives rewrites; commit ids don't.
//! * Rewriting a change rebases everything built on it, automatically.
//! * Every command is an operation in a log; `gm undo` restores the view
//!   from before any of them.
//!
//! The repo stays an ordinary git repo: bookmarks are branches, HEAD sits on
//! `@`'s parent (so `git diff` shows the change in progress) and change ids
//! live in a `change-id` commit header, the same one jj uses.

pub mod ids;
pub mod revset;
pub mod trees;
pub mod view;

use crate::output::{GmError, Result, exit};
use git2::{Commit, Index, IndexAddOption, ObjectType, Oid, Repository, Signature};
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::fs::File;
use std::path::Path;
use view::{Operation, Store, View};

pub struct Trunk {
    /// Bookmark name on the remote, e.g. "main".
    pub name: String,
    /// The ref that decides what is immutable, e.g. refs/remotes/origin/main.
    pub refname: String,
    pub oid: Oid,
}

/// The mutable part of the history: everything reachable from `@`, bookmarks
/// and heads that isn't already part of trunk.
pub struct Graph {
    /// Parents before children.
    pub topo: Vec<Oid>,
    pub children: HashMap<Oid, Vec<Oid>>,
}

/// What a rewrite did, reported back to the caller.
#[derive(Default)]
pub struct Rebased {
    pub rebased: usize,
    pub conflicts: Vec<(String, Vec<String>)>,
}

pub struct Workspace {
    pub repo: Repository,
    store: Store,
    _lock: File,
    _repository_lock: File,
    index: Index,
    pub view: View,
    before: View,
    /// Shared refs observed under the repository lock, not the stale stored view.
    git_bookmarks: std::collections::BTreeMap<String, String>,
    /// Last persisted local observation, before opening imports sibling changes.
    initial_bookmarks: std::collections::BTreeMap<String, String>,
    /// The tree the files on disk currently match.
    disk_tree: Oid,
    pub trunk: Option<Trunk>,
    immutable_cache: std::cell::RefCell<HashMap<Oid, bool>>,
    /// Set when the opening snapshot recorded an operation.
    pub snapshot_op: Option<String>,
}

fn not_a_repo() -> GmError {
    GmError::not_found("not_a_repository", "Not inside a git repository.")
        .hint("Run `gm clone <owner>/<repo>` or `gm init` in an existing git repository.")
}

impl Workspace {
    /// Open the workspace around `cwd`, take the lock and snapshot the working copy.
    pub fn open(cwd: &Path) -> Result<Workspace> {
        Self::open_internal(cwd, false)
    }

    /// Read stored state without snapshotting files or persisting imported refs.
    pub fn open_readonly(cwd: &Path) -> Result<Workspace> {
        Self::open_internal(cwd, true)
    }

    /// All gm mutations take the shared lock before any worktree-local lock.
    pub fn lock_repository(repo: &Repository) -> Result<File> {
        let lock = File::create(repo.commondir().join("gm-workspace.lock"))?;
        lock.lock()?;
        Ok(lock)
    }

    fn open_internal(cwd: &Path, readonly: bool) -> Result<Workspace> {
        let repo = Repository::discover(cwd).map_err(|_| not_a_repo())?;
        let repository_lock = Self::lock_repository(&repo)?;
        if repo.workdir().is_none() {
            return Err(GmError::usage(
                "gm needs a repository with a working directory.",
            ));
        }
        let store = Store::new(repo.path());
        if !store.exists() {
            return Err(
                GmError::new("not_initialized", "This git repository isn't using gm yet.")
                    .hint("Run `gm init` here, or `gm clone <owner>/<repo>` for a fresh copy.")
                    .exit(exit::CONFLICT),
            );
        }
        let lock = File::create(store.lock_path())?;
        lock.lock()?;
        let mut index = Index::open(&store.index_path())?;
        repo.set_index(&mut index)?;
        let view = store.load_view()?;
        let disk_tree = repo.find_commit(Oid::from_str(&view.wc)?)?.tree_id();
        let mut ws = Workspace {
            trunk: None,
            repo,
            store,
            _lock: lock,
            _repository_lock: repository_lock,
            index,
            before: view.clone(),
            git_bookmarks: view.bookmarks.clone(),
            initial_bookmarks: view.bookmarks.clone(),
            view,
            disk_tree,
            immutable_cache: Default::default(),
            snapshot_op: None,
        };
        ws.trunk = ws.find_trunk()?;
        if readonly {
            ws.view.bookmarks = ws.git_bookmarks()?;
            ws.git_bookmarks = ws.view.bookmarks.clone();
            ws.before = ws.view.clone();
        } else {
            ws.retain_history()?;
            ws.import_git_changes()?;
            ws.snapshot()?;
            ws.snapshot_op = ws.finish("snapshot working copy")?;
        }
        Ok(ws)
    }

    /// Start using gm in a git repository: `@` becomes a new change on HEAD,
    /// holding whatever is on disk that HEAD doesn't have.
    pub fn init(cwd: &Path) -> Result<Workspace> {
        let repo = Repository::discover(cwd).map_err(|_| not_a_repo())?;
        if repo.workdir().is_none() {
            return Err(GmError::usage(
                "gm needs a repository with a working directory.",
            ));
        }
        let repository_lock = Self::lock_repository(&repo)?;
        let store = Store::new(repo.path());
        if store.exists() {
            return Err(
                GmError::new("already_initialized", "This repository already uses gm.")
                    .hint("Run `gm status` to see the working copy.")
                    .exit(exit::CONFLICT),
            );
        }
        std::fs::create_dir_all(store.dir())?;
        let head = repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_commit().ok())
            .map(|c| c.id());
        let base_tree = match head {
            Some(oid) => repo.find_commit(oid)?.tree_id(),
            None => trees::empty_tree(&repo)?,
        };
        let mut index = Index::open(&store.index_path())?;
        index.read_tree(&repo.find_tree(base_tree)?)?;
        index.write()?;
        drop(index);

        let mut bookmarks = std::collections::BTreeMap::new();
        for branch in repo.branches(Some(git2::BranchType::Local))? {
            let (branch, _) = branch?;
            if let (Some(name), Some(target)) = (branch.name()?, branch.get().target()) {
                bookmarks.insert(name.to_string(), target.to_string());
            }
        }
        let ws_tmp = Workspace::raw_commit(
            &repo,
            &head.into_iter().collect::<Vec<_>>(),
            base_tree,
            "",
            &ids::new_change_id(),
            None,
        )?;
        let view = View {
            wc: ws_tmp.to_string(),
            bookmarks,
            ..Default::default()
        };
        Self::retain_view(&repo, &view)?;
        store.save_view(&view)?;
        drop(repository_lock);
        let ws = Workspace::open(cwd)?;
        ws.sync_git_head(true)?;
        Ok(ws)
    }

    // ---- reading -------------------------------------------------------

    pub fn commit(&self, oid: Oid) -> Result<Commit<'_>> {
        Ok(self.repo.find_commit(oid)?)
    }

    pub fn wc(&self) -> Oid {
        Oid::from_str(&self.view.wc).expect("view holds valid oids")
    }

    pub fn change_id(&self, commit: &Commit) -> String {
        commit
            .header_field_bytes("change-id")
            .ok()
            .and_then(|b| b.as_str().ok().map(str::to_string))
            .filter(|s| ids::is_change_id_prefix(s))
            .unwrap_or_else(|| ids::derived_change_id(commit.id()))
    }

    pub fn description(commit: &Commit) -> String {
        String::from_utf8_lossy(commit.message_bytes()).into_owned()
    }

    /// A change is empty when it makes no difference to its parent, or for a
    /// merge, to its parents merged.
    pub fn is_empty(&self, commit: &Commit) -> Result<bool> {
        Ok(match commit.parent_count() {
            0 => commit.tree_id() == trees::empty_tree(&self.repo)?,
            1 => commit.parent(0)?.tree_id() == commit.tree_id(),
            _ => {
                let parents: Vec<Oid> = commit.parent_ids().collect();
                self.merged_parent_tree(&parents)?.0 == commit.tree_id()
            }
        })
    }

    /// An empty, undescribed change that merges nothing: a placeholder for
    /// edits to come. A merge always counts, even when empty.
    pub fn is_untouched(&self, commit: &Commit) -> Result<bool> {
        Ok(commit.parent_count() <= 1
            && Workspace::description(commit).trim().is_empty()
            && self.is_empty(commit)?)
    }

    pub fn conflicts_of(&self, change_id: &str) -> Vec<String> {
        self.view
            .conflicts
            .get(change_id)
            .cloned()
            .unwrap_or_default()
    }

    fn find_trunk(&self) -> Result<Option<Trunk>> {
        let repo = &self.repo;
        if let Ok(configured) = repo.config()?.get_string("gm.trunk")
            && let Ok(reference) = repo.find_reference(&configured)
            && let Some(oid) = reference.peel_to_commit().ok().map(|c| c.id())
        {
            let name = configured
                .rsplit('/')
                .next()
                .unwrap_or(&configured)
                .to_string();
            return Ok(Some(Trunk {
                name,
                refname: configured,
                oid,
            }));
        }
        let mut candidates = Vec::new();
        if let Ok(head) = repo.find_reference("refs/remotes/origin/HEAD")
            && let Ok(Some(target)) = head.symbolic_target()
        {
            candidates.push(target.to_string());
        }
        candidates
            .extend(["refs/remotes/origin/main", "refs/remotes/origin/master"].map(String::from));
        // A repo with no remote treats its local main branch as trunk.
        if repo.remotes()?.is_empty() {
            candidates.extend(["refs/heads/main", "refs/heads/master"].map(String::from));
        }
        for refname in candidates {
            if let Ok(reference) = repo.find_reference(&refname)
                && let Ok(commit) = reference.peel_to_commit()
            {
                let name = refname.rsplit('/').next().unwrap_or("main").to_string();
                return Ok(Some(Trunk {
                    name,
                    refname,
                    oid: commit.id(),
                }));
            }
        }
        Ok(None)
    }

    pub fn refresh_trunk(&mut self) -> Result<()> {
        self.trunk = self.find_trunk()?;
        self.immutable_cache.borrow_mut().clear();
        Ok(())
    }

    /// Trunk and its history can't be rewritten; everything else can.
    pub fn is_immutable(&self, oid: Oid) -> Result<bool> {
        let Some(trunk) = &self.trunk else {
            return Ok(false);
        };
        if let Some(known) = self.immutable_cache.borrow().get(&oid) {
            return Ok(*known);
        }
        let result = oid == trunk.oid || self.repo.graph_descendant_of(trunk.oid, oid)?;
        self.immutable_cache.borrow_mut().insert(oid, result);
        Ok(result)
    }

    pub fn ensure_mutable(&self, oid: Oid) -> Result<()> {
        if self.is_immutable(oid)? {
            let commit = self.commit(oid)?;
            return Err(GmError::new(
                "immutable_change",
                format!(
                    "Change {} is already part of {}, so it can't be rewritten.",
                    &self.change_id(&commit)[..ids::SHORT_CHANGE],
                    self.trunk.as_ref().map(|t| t.name.as_str()).unwrap_or("trunk")
                ),
            )
            .hint("Make a new change on top instead: `gm new <rev>`, or undo it with `gm backout -r <rev>`.")
            .exit(exit::CONFLICT));
        }
        Ok(())
    }

    fn tips(&self) -> Vec<Oid> {
        let mut tips: Vec<Oid> = self
            .view
            .heads
            .iter()
            .filter_map(|h| Oid::from_str(h).ok())
            .collect();
        tips.push(self.wc());
        tips.extend(
            self.view
                .bookmarks
                .values()
                .filter_map(|b| Oid::from_str(b).ok()),
        );
        let mut seen = HashSet::new();
        tips.retain(|t| seen.insert(*t));
        tips
    }

    /// Walk from every tip down to trunk, collecting the mutable changes.
    pub fn graph(&self) -> Result<Graph> {
        let mut parents: HashMap<Oid, Vec<Oid>> = HashMap::new();
        let mut queue: VecDeque<Oid> = VecDeque::new();
        for tip in self.tips() {
            if !self.is_immutable(tip)? {
                queue.push_back(tip);
            }
        }
        while let Some(oid) = queue.pop_front() {
            if parents.contains_key(&oid) {
                continue;
            }
            let commit = self.commit(oid)?;
            let ps: Vec<Oid> = commit.parent_ids().collect();
            for p in &ps {
                if !parents.contains_key(p) && !self.is_immutable(*p)? {
                    queue.push_back(*p);
                }
            }
            parents.insert(oid, ps);
        }
        let mut children: HashMap<Oid, Vec<Oid>> = HashMap::new();
        let mut pending: HashMap<Oid, usize> = HashMap::new();
        for (oid, ps) in &parents {
            let inside: Vec<&Oid> = ps.iter().filter(|p| parents.contains_key(p)).collect();
            pending.insert(*oid, inside.len());
            for p in inside {
                children.entry(*p).or_default().push(*oid);
            }
        }
        let mut ready: Vec<Oid> = pending
            .iter()
            .filter(|(_, n)| **n == 0)
            .map(|(o, _)| *o)
            .collect();
        ready.sort_by_key(|o| {
            self.repo
                .find_commit(*o)
                .map(|c| c.time().seconds())
                .unwrap_or(0)
        });
        let mut topo = Vec::new();
        let mut queue: VecDeque<Oid> = ready.into();
        while let Some(oid) = queue.pop_front() {
            topo.push(oid);
            for child in children.get(&oid).cloned().unwrap_or_default() {
                let n = pending.get_mut(&child).unwrap();
                *n -= 1;
                if *n == 0 {
                    queue.push_back(child);
                }
            }
        }
        Ok(Graph { topo, children })
    }

    // ---- writing commits -------------------------------------------------

    fn signature(repo: &Repository) -> Signature<'static> {
        repo.signature()
            .unwrap_or_else(|_| Signature::now("gm", "gm@localhost").expect("valid signature"))
    }

    fn raw_commit(
        repo: &Repository,
        parents: &[Oid],
        tree: Oid,
        message: &str,
        change_id: &str,
        author: Option<&Signature>,
    ) -> Result<Oid> {
        let committer = Workspace::signature(repo);
        let author = match author {
            Some(a) => a.to_owned(),
            None => committer.clone(),
        };
        let parent_commits: Vec<Commit> = parents
            .iter()
            .map(|p| repo.find_commit(*p))
            .collect::<std::result::Result<_, _>>()?;
        let refs: Vec<&Commit> = parent_commits.iter().collect();
        let buffer =
            repo.commit_create_buffer(&author, &committer, message, &repo.find_tree(tree)?, &refs)?;
        let text = buffer
            .as_str()
            .map_err(|_| GmError::new("git_error", "Commit is not valid UTF-8."))?;
        let split = text.find("\n\n").unwrap_or(text.len());
        let with_id = format!(
            "{}\nchange-id {}{}",
            &text[..split],
            change_id,
            &text[split..]
        );
        Ok(repo.odb()?.write(ObjectType::Commit, with_id.as_bytes())?)
    }

    /// A brand-new change.
    pub fn new_commit(&self, parents: &[Oid], tree: Oid, message: &str) -> Result<Oid> {
        Workspace::raw_commit(
            &self.repo,
            parents,
            tree,
            message,
            &ids::new_change_id(),
            None,
        )
    }

    /// A new version of an existing change: same change id and author.
    pub fn rewrite_commit(
        &self,
        old: &Commit,
        parents: &[Oid],
        tree: Oid,
        message: Option<&str>,
    ) -> Result<Oid> {
        let message = match message {
            Some(m) => m.to_string(),
            None => Workspace::description(old),
        };
        Workspace::raw_commit(
            &self.repo,
            parents,
            tree,
            &message,
            &self.change_id(old),
            Some(&old.author()),
        )
    }

    /// The tree a set of parents adds up to: what a merge's own edits apply
    /// on top of. Each later parent is merged in against its merge base with
    /// the first.
    pub fn merged_parent_tree(&self, parents: &[Oid]) -> Result<(Oid, Vec<String>)> {
        match parents {
            [] => Ok((trees::empty_tree(&self.repo)?, Vec::new())),
            [only] => Ok((self.commit(*only)?.tree_id(), Vec::new())),
            [first, rest @ ..] => {
                let mut tree = self.commit(*first)?.tree_id();
                let mut conflicts = Vec::new();
                for other in rest {
                    let base = self.repo.merge_base(*first, *other).ok();
                    let base_tree = match base {
                        Some(b) => self.commit(b)?.tree_id(),
                        None => trees::empty_tree(&self.repo)?,
                    };
                    let (merged, c) =
                        trees::merge(&self.repo, base_tree, tree, self.commit(*other)?.tree_id())?;
                    tree = merged;
                    conflicts.extend(c);
                }
                conflicts.sort();
                conflicts.dedup();
                Ok((tree, conflicts))
            }
        }
    }

    // ---- the working copy ------------------------------------------------

    /// Bring git-side changes into the view: branches moved with plain git,
    /// and a HEAD that someone moved with `git commit` or `git checkout`.
    fn import_git_changes(&mut self) -> Result<()> {
        self.view.bookmarks = self.git_bookmarks()?;
        self.git_bookmarks = self.view.bookmarks.clone();

        let wc = self.commit(self.wc())?;
        let expected = wc.parent_ids().next();
        let head = self
            .repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_commit().ok())
            .map(|c| c.id());
        if let Some(head) = head
            && Some(head) != expected
            && head != self.wc()
        {
            let old_wc = self.wc();
            let head_tree = self.commit(head)?.tree_id();
            let discard = self.is_discardable(old_wc)? || wc.tree_id() == head_tree;
            let old_parents: Vec<Oid> = wc.parent_ids().collect();
            drop(wc);
            if !discard {
                self.view.heads.insert(old_wc.to_string());
            } else {
                self.view
                    .heads
                    .extend(old_parents.iter().map(|p| p.to_string()));
            }
            let new_wc = self.new_commit(&[head], head_tree, "")?;
            self.view.wc = new_wc.to_string();
            self.view.heads.insert(head.to_string());
            // git already changed the files; start the snapshot from HEAD.
            self.index.read_tree(&self.repo.find_tree(head_tree)?)?;
            self.index.write()?;
            self.disk_tree = head_tree;
            self.normalize_heads()?;
        }
        Ok(())
    }

    /// Record the files on disk into `@`.
    pub fn snapshot(&mut self) -> Result<bool> {
        self.index.add_all(["*"], IndexAddOption::DEFAULT, None)?;
        self.index.update_all(["*"], None)?;
        let tree = self.index.write_tree_to(&self.repo)?;
        self.index.write()?;
        self.disk_tree = tree;

        let wc_oid = self.wc();
        let wc = self.repo.find_commit(wc_oid)?;
        let change_id = self.change_id(&wc);
        let mut changed = false;
        if wc.tree_id() != tree {
            let new_wc =
                self.rewrite_commit(&wc, &wc.parent_ids().collect::<Vec<_>>(), tree, None)?;
            drop(wc);
            self.rebase_descendants(HashMap::from([(wc_oid, new_wc)]), HashMap::new())?;
            changed = true;
        } else {
            drop(wc);
        }
        self.prune_resolved_conflicts(&change_id, tree)?;
        Ok(changed)
    }

    /// Conflict markers removed from a change's files no longer count.
    fn prune_resolved_conflicts(&mut self, change_id: &str, tree: Oid) -> Result<()> {
        let Some(paths) = self.view.conflicts.get(change_id).cloned() else {
            return Ok(());
        };
        let remaining = self.still_conflicted(tree, paths)?;
        if remaining.is_empty() {
            self.view.conflicts.remove(change_id);
        } else {
            self.view.conflicts.insert(change_id.to_string(), remaining);
        }
        Ok(())
    }

    /// Of `paths`, those whose file in `tree` still has conflict markers.
    pub fn still_conflicted(&self, tree: Oid, paths: Vec<String>) -> Result<Vec<String>> {
        let tree = self.repo.find_tree(tree)?;
        Ok(paths
            .into_iter()
            .filter(|p| {
                tree.get_path(Path::new(p))
                    .ok()
                    .and_then(|e| self.repo.find_blob(e.id()).ok())
                    .map(|b| trees::has_conflict_markers(b.content()))
                    .unwrap_or(false)
            })
            .collect())
    }

    /// An untouched change nothing depends on: safe to drop when `@` moves away.
    fn is_discardable(&self, oid: Oid) -> Result<bool> {
        if !self.is_untouched(&self.commit(oid)?)? {
            return Ok(false);
        }
        let s = oid.to_string();
        if self.view.bookmarks.values().any(|b| *b == s) {
            return Ok(false);
        }
        let graph = self.graph()?;
        Ok(graph
            .children
            .get(&oid)
            .map(|c| c.is_empty())
            .unwrap_or(true))
    }

    /// Point `@` at another commit, dropping the old `@` if it was an
    /// empty, undescribed change.
    pub fn set_wc(&mut self, new_wc: Oid) -> Result<()> {
        let old = self.wc();
        if old == new_wc {
            return Ok(());
        }
        let discard = self.is_discardable(old)? && !self.repo.graph_descendant_of(new_wc, old)?;
        if !discard {
            self.view.heads.insert(old.to_string());
        } else {
            // Dropping the old @ must not hide the changes it was built on.
            let commit = self.repo.find_commit(old)?;
            let change = self.change_id(&commit);
            for parent in commit.parent_ids() {
                self.view.heads.insert(parent.to_string());
            }
            self.view.conflicts.remove(&change);
        }
        self.view.wc = new_wc.to_string();
        self.normalize_heads()
    }

    /// Drop heads that are immutable or already reachable from another tip.
    pub fn normalize_heads(&mut self) -> Result<()> {
        let mut tips: Vec<Oid> = self
            .view
            .heads
            .iter()
            .filter_map(|h| Oid::from_str(h).ok())
            .collect();
        let anchors: Vec<Oid> = std::iter::once(self.wc())
            .chain(
                self.view
                    .bookmarks
                    .values()
                    .filter_map(|b| Oid::from_str(b).ok()),
            )
            .collect();
        let mut keep = BTreeSet::new();
        tips.sort();
        tips.dedup();
        for tip in &tips {
            if self.is_immutable(*tip)? || anchors.contains(tip) {
                continue;
            }
            let mut covered = false;
            for other in tips.iter().chain(anchors.iter()) {
                if other != tip && self.repo.graph_descendant_of(*other, *tip)? {
                    covered = true;
                    break;
                }
            }
            if !covered {
                keep.insert(tip.to_string());
            }
        }
        self.view.heads = keep;
        Ok(())
    }

    // ---- rewriting -------------------------------------------------------

    /// Whether one of `parents` is already an ancestor of another.
    fn has_redundant_parent(&self, parents: &[Oid]) -> Result<bool> {
        Ok(self.without_redundant_parents(parents)?.len() < parents.len())
    }

    /// `parents` without those another of them already contains.
    fn without_redundant_parents(&self, parents: &[Oid]) -> Result<Vec<Oid>> {
        let mut kept = Vec::new();
        for p in parents {
            let mut contained = false;
            for q in parents {
                if q != p && self.repo.graph_descendant_of(*q, *p)? {
                    contained = true;
                    break;
                }
            }
            if !contained {
                kept.push(*p);
            }
        }
        Ok(kept)
    }

    /// The parents a change gets when it moves onto `dest`: `dest` takes the
    /// first parent's place, and whatever a merge brought in stays, unless
    /// `dest` already contains it.
    pub fn parents_onto(&self, oid: Oid, dest: Oid) -> Result<Vec<Oid>> {
        let mut parents = vec![dest];
        for p in self.commit(oid)?.parent_ids().skip(1) {
            if !parents.contains(&p) && !self.repo.graph_descendant_of(dest, p)? {
                parents.push(p);
            }
        }
        Ok(parents)
    }

    /// A change's tree moved onto new parents, and the paths left conflicted.
    /// A conflict between a merge's parents only counts while its markers are
    /// still there: the merge may have resolved it.
    pub fn rebased_tree(&self, commit: &Commit, parents: &[Oid]) -> Result<(Oid, Vec<String>)> {
        let (old_base, _) = self.merged_parent_tree(&commit.parent_ids().collect::<Vec<_>>())?;
        let (new_base, base_conflicts) = self.merged_parent_tree(parents)?;
        let (tree, mut conflicts) = trees::merge(&self.repo, old_base, new_base, commit.tree_id())?;
        conflicts.extend(self.still_conflicted(tree, base_conflicts)?);
        Ok((tree, conflicts))
    }

    /// After some changes were rewritten (`rewritten`: old -> new) or dropped
    /// (`abandoned`: old -> the parents its children should move to), rebase
    /// every descendant and move `@`, bookmarks and heads along.
    pub fn rebase_descendants(
        &mut self,
        mut rewritten: HashMap<Oid, Oid>,
        abandoned: HashMap<Oid, Vec<Oid>>,
    ) -> Result<Rebased> {
        let graph = self.graph()?;
        let mut outcome = Rebased::default();
        let explicit: HashSet<Oid> = rewritten.keys().copied().collect();
        let mut fresh: HashSet<String> = HashSet::new();
        let wc = self.wc();

        fn resolve(
            oid: Oid,
            rewritten: &HashMap<Oid, Oid>,
            abandoned: &HashMap<Oid, Vec<Oid>>,
        ) -> Vec<Oid> {
            if let Some(parents) = abandoned.get(&oid) {
                return parents
                    .iter()
                    .flat_map(|p| resolve(*p, rewritten, abandoned))
                    .collect();
            }
            vec![rewritten.get(&oid).copied().unwrap_or(oid)]
        }

        for oid in &graph.topo {
            if abandoned.contains_key(oid) {
                continue;
            }
            let current = rewritten.get(oid).copied().unwrap_or(*oid);
            let commit = self.commit(current)?;
            let old_parents: Vec<Oid> = commit.parent_ids().collect();
            let mut new_parents: Vec<Oid> = Vec::new();
            for p in &old_parents {
                for r in resolve(*p, &rewritten, &abandoned) {
                    if !new_parents.contains(&r) {
                        new_parents.push(r);
                    }
                }
            }
            // A merge keeps every parent, except one the rewrite made
            // redundant (its side is now in another parent's history). A merge
            // that was redundant to begin with, like `git merge --no-ff`, stays.
            if new_parents.len() > 1 && !self.has_redundant_parent(&old_parents)? {
                new_parents = self.without_redundant_parents(&new_parents)?;
            }
            if new_parents == old_parents {
                continue;
            }
            let (tree, mut conflicts) = self.rebased_tree(&commit, &new_parents)?;
            let change_id = self.change_id(&commit);
            // A merge left with one parent and nothing of its own only recorded
            // bringing in what that parent now has (a `gm merge trunk` that
            // sync rebased past): drop it.
            if old_parents.len() > 1
                && new_parents.len() == 1
                && conflicts.is_empty()
                && *oid != wc
                && !explicit.contains(oid)
                && tree == self.commit(new_parents[0])?.tree_id()
            {
                drop(commit);
                self.view.conflicts.remove(&change_id);
                rewritten.insert(*oid, new_parents[0]);
                continue;
            }
            let new_oid = self.rewrite_commit(&commit, &new_parents, tree, None)?;
            drop(commit);
            if !conflicts.is_empty() {
                conflicts.sort();
                conflicts.dedup();
                self.view
                    .conflicts
                    .insert(change_id.clone(), conflicts.clone());
                fresh.insert(change_id.clone());
                outcome.conflicts.push((change_id, conflicts));
            }
            if !explicit.contains(oid) {
                outcome.rebased += 1;
            }
            rewritten.insert(*oid, new_oid);
        }

        // Move @, bookmarks and heads to the new commits.
        let move_to = |oid: Oid| resolve(oid, &rewritten, &abandoned);
        let new_wc = if abandoned.contains_key(&wc) {
            let parents = move_to(wc);
            let (tree, _) = self.merged_parent_tree(&parents)?;
            self.new_commit(&parents, tree, "")?
        } else {
            move_to(wc)[0]
        };
        self.view.wc = new_wc.to_string();
        let bookmarks = self.view.bookmarks.clone();
        for (name, target) in bookmarks {
            let oid = Oid::from_str(&target)?;
            match move_to(oid).first() {
                Some(new) => {
                    self.view.bookmarks.insert(name, new.to_string());
                }
                None => {
                    self.view.bookmarks.remove(&name);
                }
            }
        }
        let heads: Vec<Oid> = self
            .view
            .heads
            .iter()
            .filter_map(|h| Oid::from_str(h).ok())
            .collect();
        self.view.heads = heads
            .into_iter()
            .flat_map(move_to)
            .map(|o| o.to_string())
            .collect();
        for oid in abandoned.keys() {
            let change = match self.repo.find_commit(*oid) {
                Ok(commit) => self.change_id(&commit),
                Err(_) => continue,
            };
            // A dropped change takes its conflicts with it, unless a rewrite kept the id.
            let kept = rewritten.values().any(|n| {
                self.repo
                    .find_commit(*n)
                    .map(|c| self.change_id(&c) == change)
                    .unwrap_or(false)
            });
            if !kept {
                self.view.conflicts.remove(&change);
            }
        }
        // A rewrite (a squash into a conflicted change, say) can remove the
        // markers from a change other than @; recheck every rewritten change
        // whose conflicts predate this rebase.
        let rewritten_now: Vec<Oid> = rewritten.values().copied().collect();
        for oid in rewritten_now {
            let commit = self.repo.find_commit(oid)?;
            let (change, tree) = (self.change_id(&commit), commit.tree_id());
            drop(commit);
            if !fresh.contains(&change) {
                self.prune_resolved_conflicts(&change, tree)?;
            }
        }
        self.normalize_heads()?;
        Ok(outcome)
    }

    /// Keep a newly created commit visible even when nothing points at it.
    pub fn add_head(&mut self, oid: Oid) -> Result<()> {
        self.view.heads.insert(oid.to_string());
        self.normalize_heads()
    }

    // ---- committing the operation ---------------------------------------

    fn git_bookmarks(&self) -> Result<std::collections::BTreeMap<String, String>> {
        let mut bookmarks = std::collections::BTreeMap::new();
        for branch in self.repo.branches(Some(git2::BranchType::Local))? {
            let (branch, _) = branch?;
            if let (Some(name), Some(target)) = (branch.name()?, branch.get().target()) {
                bookmarks.insert(name.to_string(), target.to_string());
            }
        }
        Ok(bookmarks)
    }

    /// Worktree-scoped anchors in the shared ref namespace: native git GC does
    /// not reliably traverse another worktree's private refs.
    pub fn retention_ref_prefix(repo: &Repository) -> Result<String> {
        if !repo.is_worktree() {
            return Ok("refs/gm/worktrees/main/keep/".to_string());
        }
        let name = repo.path().file_name().ok_or_else(|| {
            GmError::usage("The linked worktree has no administrative directory name.")
        })?;
        // Encode ref-unsafe bytes (including '%' itself) without collisions.
        let mut escaped = String::new();
        for byte in name.as_encoded_bytes() {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_') {
                escaped.push(*byte as char);
            } else {
                use std::fmt::Write;
                write!(&mut escaped, "%{byte:02X}").expect("writing to a string");
            }
        }
        Ok(format!("refs/gm/worktrees/linked/{escaped}/keep/"))
    }

    fn retain_view(repo: &Repository, view: &View) -> Result<()> {
        let prefix = Self::retention_ref_prefix(repo)?;
        for target in std::iter::once(&view.wc)
            .chain(view.heads.iter())
            .chain(view.bookmarks.values())
        {
            let name = format!("{prefix}{target}");
            if repo.find_reference(&name).is_err() {
                repo.reference(&name, Oid::from_str(target)?, false, "gm: retain history")?;
            }
        }
        Ok(())
    }

    /// Upgrade existing stores once; thereafter finish retains every new view.
    fn retain_history(&self) -> Result<()> {
        let marker = self.store.dir().join("reachability-shared-v1");
        if !marker.exists() {
            Self::retain_view(&self.repo, &self.view)?;
            for op in self.store.ops()? {
                Self::retain_view(&self.repo, &op.before)?;
                Self::retain_view(&self.repo, &op.after)?;
            }
            std::fs::write(marker, b"")?;
        }
        Ok(())
    }

    /// Write the view, refs and working directory, and log the operation.
    /// Returns the operation id, or None if nothing changed.
    pub fn finish(&mut self, command: &str) -> Result<Option<String>> {
        Self::retain_view(&self.repo, &self.before)?;
        Self::retain_view(&self.repo, &self.view)?;
        if self.view != self.before {
            self.write_bookmarks()?;
        }
        let wc_tree = self.commit(self.wc())?.tree_id();
        if wc_tree != self.disk_tree {
            trees::checkout(&self.repo, &mut self.index, self.disk_tree, wc_tree)?;
            self.disk_tree = wc_tree;
        }
        if self.view == self.before {
            return Ok(None);
        }
        let before_parent = Oid::from_str(&self.before.wc)
            .ok()
            .and_then(|o| self.repo.find_commit(o).ok())
            .and_then(|c| c.parent_id(0).ok());
        let after_parent = self.commit(self.wc())?.parent_id(0).ok();
        self.sync_git_head(before_parent != after_parent)?;
        self.store.save_view(&self.view)?;
        let op = Operation {
            id: view::new_op_id(),
            time: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            command: command.to_string(),
            before: self.before.clone(),
            after: self.view.clone(),
            undone_by: None,
            undoes: None,
        };
        self.store.append_op(&op)?;
        self.before = self.view.clone();
        self.git_bookmarks = self.view.bookmarks.clone();
        Ok(Some(op.id))
    }

    /// Forget everything done since the last `finish` (for --dry-run).
    pub fn discard(&mut self) {
        self.view = self.before.clone();
    }

    fn write_bookmarks(&self) -> Result<()> {
        // Only write this operation's delta. Lock refs in sorted order and
        // compare under those locks, so plain git cannot be silently overwritten.
        let names: BTreeSet<_> = self
            .git_bookmarks
            .keys()
            .chain(self.view.bookmarks.keys())
            .filter(|name| self.git_bookmarks.get(*name) != self.view.bookmarks.get(*name))
            .collect();
        let mut transaction = self.repo.transaction()?;
        for name in &names {
            transaction.lock_ref(&format!("refs/heads/{name}"))?;
        }
        for name in &names {
            let refname = format!("refs/heads/{name}");
            let actual = match self.repo.find_reference(&refname) {
                Ok(reference) => reference.target().map(|oid| oid.to_string()),
                Err(error) if error.code() == git2::ErrorCode::NotFound => None,
                Err(error) => return Err(error.into()),
            };
            if actual.as_ref() != self.git_bookmarks.get(*name) {
                return Err(GmError::new(
                    "bookmark_changed",
                    format!("Bookmark `{name}` changed outside this operation; retry."),
                )
                .exit(exit::CONFLICT));
            }
            if let Ok(branch) = self.repo.find_branch(name, git2::BranchType::Local)
                && branch.is_head()
            {
                return Err(GmError::new(
                    "bookmark_checked_out",
                    format!("Bookmark `{name}` is checked out; detach it before moving it."),
                )
                .exit(exit::CONFLICT));
            }
            self.ensure_bookmark_not_checked_out(&refname)?;
            match self.view.bookmarks.get(*name) {
                Some(target) => transaction.set_target(
                    &refname,
                    Oid::from_str(target)?,
                    None,
                    "gm: move bookmark",
                )?,
                None => transaction.remove(&refname)?,
            }
        }
        transaction.commit()?;
        Ok(())
    }

    fn ensure_bookmark_not_checked_out(&self, refname: &str) -> Result<()> {
        // HEAD is worktree-local. Inspect all administrative HEADs, including
        // the main checkout when this Workspace belongs to a linked worktree.
        let mut dirs = vec![self.repo.commondir().to_path_buf()];
        let linked = self.repo.commondir().join("worktrees");
        if linked.exists() {
            for entry in std::fs::read_dir(linked)? {
                let entry = entry?;
                if entry.file_type()?.is_dir() {
                    dirs.push(entry.path());
                }
            }
        }
        for dir in dirs {
            let head = match std::fs::read_to_string(dir.join("HEAD")) {
                Ok(head) => head,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            if head.trim().strip_prefix("ref: ") == Some(refname) {
                return Err(GmError::new("bookmark_checked_out",
                    format!("Bookmark `{}` is checked out in a git worktree; detach it before moving it.",
                        refname.trim_start_matches("refs/heads/")))
                    .exit(exit::CONFLICT));
            }
        }
        Ok(())
    }

    /// Keep plain git useful: HEAD on `@`'s parent, the index matching it,
    /// so `git status`/`git diff` show the change in progress.
    fn sync_git_head(&self, reset_index: bool) -> Result<()> {
        let wc = self.commit(self.wc())?;
        if let Ok(parent) = wc.parent_id(0) {
            self.repo.set_head_detached(parent)?;
            if reset_index {
                let mut git_index = Index::open(&self.repo.path().join("index"))?;
                git_index.read_tree(&self.repo.find_tree(self.commit(parent)?.tree_id())?)?;
                git_index.write()?;
            }
        }
        Ok(())
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    /// Restore local state, reversing only uncontested bookmark changes.
    pub fn restore_view(&mut self, view: View, expected: &View) -> Result<()> {
        self.view = self.merge_restored_view(view, &expected.bookmarks)?;
        self.immutable_cache.borrow_mut().clear();
        Ok(())
    }

    /// Restore a historical local view without reverting refs changed elsewhere
    /// since this worktree last observed them.
    pub fn restore_operation(&mut self, view: View) -> Result<()> {
        self.view = self.merge_restored_view(view, &self.initial_bookmarks)?;
        self.immutable_cache.borrow_mut().clear();
        Ok(())
    }

    fn merge_restored_view(
        &self,
        mut view: View,
        expected: &std::collections::BTreeMap<String, String>,
    ) -> Result<View> {
        // Objects can only go missing if git gc pruned them.
        self.repo
            .find_commit(Oid::from_str(&view.wc)?)
            .map_err(|_| {
                GmError::new(
                    "operation_unavailable",
                    "That operation's commits are no longer in the repository.",
                )
            })?;
        let restored = view.bookmarks;
        view.bookmarks = self.view.bookmarks.clone();
        for name in restored
            .keys()
            .chain(expected.keys())
            .collect::<BTreeSet<_>>()
        {
            let target = restored.get(name);
            let old = expected.get(name);
            if target != old && self.view.bookmarks.get(name) == old {
                match target {
                    Some(oid) => {
                        view.bookmarks.insert(name.clone(), oid.clone());
                    }
                    None => {
                        view.bookmarks.remove(name);
                    }
                }
            }
        }
        Ok(view)
    }
}
