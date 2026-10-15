//! Merge changes end to end: creating them with `gm merge`, rewriting them
//! with both parents kept, and pushing them to a local bare remote.

use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

struct Sandbox {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Seed")
        .env("GIT_AUTHOR_EMAIL", "seed@example.com")
        .env("GIT_COMMITTER_NAME", "Seed")
        .env("GIT_COMMITTER_EMAIL", "seed@example.com")
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

impl Sandbox {
    /// A bare remote with one commit on main, a seed clone that pushes like a
    /// teammate, and a gm-managed clone called `work`.
    fn new() -> Sandbox {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        git(&root, &["init", "-q", "--bare", "-b", "main", "remote.git"]);
        git(&root, &["clone", "-q", "remote.git", "seed"]);
        fs::write(root.join("seed/README.md"), "hello\n").unwrap();
        git(&root.join("seed"), &["add", "."]);
        git(&root.join("seed"), &["commit", "-qm", "Initial"]);
        git(&root.join("seed"), &["push", "-q", "origin", "main"]);
        git(&root, &["clone", "-q", "remote.git", "work"]);
        git(&root.join("work"), &["config", "user.name", "Agent"]);
        git(
            &root.join("work"),
            &["config", "user.email", "agent@example.com"],
        );
        let sandbox = Sandbox { _dir: dir, root };
        sandbox.ok(&["init"]);
        sandbox
    }

    fn work(&self) -> PathBuf {
        self.root.join("work")
    }

    fn run(&self, args: &[&str]) -> (i32, Value, String) {
        let output = Command::new(env!("CARGO_BIN_EXE_gm"))
            .current_dir(self.work())
            .args(args)
            .env("GM_AGENT", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("XDG_CONFIG_HOME", self.root.join("config"))
            .output()
            .expect("gm runs");
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let value = serde_json::from_str(&stdout)
            .or_else(|_| serde_json::from_str(&stderr))
            .unwrap_or(Value::Null);
        (output.status.code().unwrap_or(-1), value, stderr)
    }

    fn ok(&self, args: &[&str]) -> Value {
        let (code, value, stderr) = self.run(args);
        assert_eq!(code, 0, "gm {args:?} failed: {stderr}");
        value
    }

    fn err(&self, args: &[&str]) -> String {
        let (code, value, _) = self.run(args);
        assert_ne!(code, 0, "gm {args:?} should fail");
        value["error"]["code"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    }

    fn write(&self, path: &str, content: &str) {
        fs::write(self.work().join(path), content).unwrap();
    }

    fn read(&self, path: &str) -> String {
        fs::read_to_string(self.work().join(path)).unwrap_or_default()
    }

    /// The change with this description in `gm log`.
    fn find(&self, description: &str) -> Value {
        self.ok(&["log"])["changes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["description"] == description)
            .unwrap_or_else(|| panic!("no change described {description:?}"))
            .clone()
    }

    fn change(&self, description: &str) -> String {
        self.find(description)["change_id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    /// Change ids of a change's parents, in order.
    fn parents(&self, description: &str) -> Vec<String> {
        self.find(description)["parents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap().to_string())
            .collect()
    }

    fn descriptions(&self) -> Vec<String> {
        self.ok(&["log"])["changes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["description"].as_str().unwrap().to_string())
            .collect()
    }

    /// How many parents the remote's main has.
    fn remote_main_parents(&self) -> usize {
        git(
            &self.root.join("remote.git"),
            &["rev-list", "--parents", "-n", "1", "main"],
        )
        .split_whitespace()
        .count()
            - 1
    }

    fn teammate_pushes(&self, path: &str, content: &str, message: &str) {
        let seed = self.root.join("seed");
        git(&seed, &["pull", "-q", "--rebase", "origin", "main"]);
        fs::write(seed.join(path), content).unwrap();
        git(&seed, &["add", "."]);
        git(&seed, &["commit", "-qm", message]);
        git(&seed, &["push", "-q", "origin", "main"]);
    }

    /// Two lines off trunk: "Add a" (where `@` ends up) and "Add b" on the
    /// `side` bookmark.
    fn two_lines(&self) -> (String, String) {
        self.write("b.txt", "b\n");
        self.ok(&["commit", "-m", "Add b"]);
        self.ok(&["bookmark", "set", "side", "-r", "@-"]);
        self.ok(&["new", "trunk"]);
        self.write("a.txt", "a\n");
        self.ok(&["commit", "-m", "Add a"]);
        (self.change("Add a"), self.change("Add b"))
    }
}

#[test]
fn merge_creates_a_change_with_both_parents_below_the_working_copy() {
    let s = Sandbox::new();
    let (a, b) = s.two_lines();
    s.write("wip.txt", "in progress\n");
    let merged = s.ok(&["merge", "side"]);
    let merge = merged["changes"][0].clone();
    assert_eq!(merge["description"], "Merge side");
    assert_eq!(merge["parents"], serde_json::json!([a, b]));
    // A clean merge adds nothing of its own; both sides are on disk.
    assert_eq!(merge["empty"], true);
    assert_eq!(s.read("a.txt"), "a\n");
    assert_eq!(s.read("b.txt"), "b\n");
    // Edits in progress stay in @, now on top of the merge.
    let status = s.ok(&["status"]);
    assert_eq!(status["parents"][0]["change_id"], merge["change_id"]);
    let files: Vec<&str> = status["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap())
        .collect();
    assert_eq!(files, vec!["wip.txt"]);
    // Its diff is what it adds to the merged parents: nothing.
    let id = merge["change_id"].as_str().unwrap();
    assert_eq!(s.ok(&["show", id])["files"], serde_json::json!([]));

    // Merging something already merged is a no-op.
    let again = s.ok(&["merge", &b]);
    assert!(
        again["message"]
            .as_str()
            .unwrap()
            .starts_with("Nothing to merge")
    );
    // The working copy can't be merged below itself.
    assert_eq!(s.err(&["merge", "@"]), "invalid_argument");
}

#[test]
fn rewrites_keep_every_parent_of_a_merge() {
    let s = Sandbox::new();
    let (a, b) = s.two_lines();
    s.ok(&["merge", "side"]);
    let merge = s.change("Merge side");

    // Describing the merge keeps its parents and change id.
    s.ok(&["describe", &merge, "-m", "Join a and b"]);
    assert_eq!(s.change("Join a and b"), merge);
    assert_eq!(s.parents("Join a and b"), vec![a.clone(), b.clone()]);

    // Rewriting a parent rebases the merge onto the new version of it.
    s.ok(&["describe", &a, "-m", "Add a, reworded"]);
    assert_eq!(s.parents("Join a and b"), vec![a.clone(), b.clone()]);

    // Inserting below the merge's first parent keeps the second.
    s.ok(&["new", "trunk"]);
    s.write("c.txt", "c\n");
    s.ok(&["commit", "-m", "Add c"]);
    let c = s.change("Add c");
    s.ok(&["rebase", "-s", &merge, "-d", &c]);
    assert_eq!(s.parents("Join a and b"), vec![c.clone(), b.clone()]);
    // The first parent it moved off stays visible.
    assert_eq!(s.change("Add a, reworded"), a);
    s.ok(&["edit", &merge]);
    assert_eq!(s.read("c.txt"), "c\n");
    assert_eq!(s.read("b.txt"), "b\n");
    assert_eq!(s.read("a.txt"), "");

    // A sync onto a moved trunk rebases both lines; the merge follows both.
    s.teammate_pushes("t.txt", "teammate\n", "Teammate");
    let synced = s.ok(&["sync"]);
    assert!(synced["conflicts"].as_array().is_none_or(Vec::is_empty));
    assert_eq!(s.parents("Join a and b"), vec![c, b]);
    assert_eq!(s.read("t.txt"), "teammate\n");

    // Abandoning a parent hands the merge that parent's parents.
    s.ok(&["abandon", "side"]);
    assert_eq!(s.parents("Join a and b").len(), 1);
}

#[test]
fn merges_push_to_trunk_with_both_parents() {
    let s = Sandbox::new();
    s.two_lines();
    s.ok(&["merge", "side"]);
    let pushed = s.ok(&["push"]);
    let descriptions: Vec<&str> = pushed["pushed"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["description"].as_str().unwrap())
        .collect();
    assert_eq!(descriptions.len(), 3);
    assert_eq!(descriptions[0], "Merge side");
    assert!(descriptions.contains(&"Add a") && descriptions.contains(&"Add b"));
    assert_eq!(s.remote_main_parents(), 2);
    assert_eq!(s.find("Merge side")["immutable"], true);
}

#[test]
fn a_conflicted_merge_is_recorded_and_refused_at_push() {
    let s = Sandbox::new();
    s.write("README.md", "hello from b\n");
    s.ok(&["commit", "-m", "Theirs"]);
    s.ok(&["bookmark", "set", "side", "-r", "@-"]);
    s.ok(&["new", "trunk"]);
    s.write("README.md", "hello from a\n");
    s.ok(&["commit", "-m", "Ours"]);

    let merged = s.ok(&["merge", "side"]);
    let merge = merged["changes"][0]["change_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(merged["conflicts"][0]["change_id"], merge);
    assert_eq!(merged["conflicts"][0]["paths"][0], "README.md");
    assert!(s.read("README.md").contains("<<<<<<<"));
    assert_eq!(s.ok(&["status"])["conflicts"][0]["change_id"], merge);
    assert_eq!(s.err(&["push"]), "has_conflicts");

    // Resolve in @, fold the fix into the merge, and it pushes.
    s.write("README.md", "hello from both\n");
    s.ok(&["squash"]);
    assert_eq!(s.ok(&["status"])["conflicts"], serde_json::json!([]));
    assert_eq!(s.find("Merge side")["empty"], false);
    s.ok(&["push"]);
    assert_eq!(s.remote_main_parents(), 2);
    assert_eq!(
        git(&s.root.join("remote.git"), &["show", "main:README.md"]),
        "hello from both\n"
    );
}

#[test]
fn sync_keeps_a_merge_of_trunk_until_trunk_moves_past_it() {
    let s = Sandbox::new();
    s.write("a.txt", "a\n");
    s.ok(&["commit", "-m", "Add a"]);
    s.teammate_pushes("t.txt", "one\n", "Teammate one");
    s.ok(&["fetch"]);
    s.ok(&["merge", "trunk"]);
    assert_eq!(s.parents("Merge main").len(), 2);

    // The stack already has the latest trunk: sync leaves the merge alone,
    // and push lands it as a merge.
    s.ok(&["sync"]);
    assert_eq!(s.parents("Merge main").len(), 2);
    s.ok(&["push", "--dry-run"]);

    // Once trunk moves on, sync rebases the stack; the merge brought in
    // nothing the new base lacks, so it goes away.
    s.teammate_pushes("t.txt", "two\n", "Teammate two");
    s.ok(&["sync"]);
    assert_eq!(s.descriptions(), vec!["", "Add a", "Teammate two"]);
    assert_eq!(s.read("t.txt"), "two\n");
    s.ok(&["push"]);
    assert_eq!(s.remote_main_parents(), 1);
}

#[test]
fn sync_treats_a_landing_merge_as_landing_the_timeline() {
    let s = Sandbox::new();
    s.write("a.txt", "a\n");
    s.ok(&["commit", "-m", "Add a"]);
    s.write("b.txt", "b\n");
    s.ok(&["commit", "-m", "Add b"]);
    s.ok(&["push", "-b", "timeline/feature"]);
    // Work after the checkpoint stays in the timeline, not yet landed.
    s.write("c.txt", "c\n");
    s.ok(&["commit", "-m", "Add c"]);

    // Main moves, then the checkpoint lands as a real merge.
    s.teammate_pushes("t.txt", "teammate\n", "Teammate");
    let seed = s.root.join("seed");
    git(&seed, &["fetch", "-q", "origin"]);
    git(
        &seed,
        &[
            "merge",
            "-q",
            "--no-ff",
            "-m",
            "Land timeline/feature",
            "origin/timeline/feature",
        ],
    );
    git(&seed, &["push", "-q", "origin", "main"]);

    // Sync sees the merge's second parent as landed: the checkpoint's
    // changes are part of trunk, and the work after it follows trunk.
    s.ok(&["sync"]);
    assert_eq!(s.descriptions(), vec!["", "Add c", "Land timeline/feature"]);
    assert_eq!(s.parents("Add c"), vec![s.change("Land timeline/feature")]);
    assert_eq!(s.read("t.txt"), "teammate\n");
    assert_eq!(s.read("c.txt"), "c\n");

    // It pushes as one more commit on top of the landing.
    s.ok(&["push"]);
    assert_eq!(
        git(
            &s.root.join("remote.git"),
            &["log", "-1", "--format=%s", "main"]
        )
        .trim(),
        "Add c"
    );
}

#[test]
fn sync_drops_changes_a_landing_merged_as_rewritten_copies() {
    let s = Sandbox::new();
    s.write("a.txt", "a\n");
    s.ok(&["commit", "-m", "Add a"]);
    let a = s.change("Add a");
    s.ok(&["push", "-b", "timeline/feature"]);
    // Here, the timeline is reworded after the checkpoint was pushed, and our
    // copy keeps the old commit: same change, another commit id.
    s.ok(&["describe", &a, "-m", "Add a, reworded"]);
    s.ok(&["push", "-b", "timeline/feature"]);
    s.ok(&["describe", &a, "-m", "Add a, local wording"]);

    s.teammate_pushes("t.txt", "teammate\n", "Teammate");
    let seed = s.root.join("seed");
    git(&seed, &["fetch", "-q", "origin"]);
    git(
        &seed,
        &[
            "merge",
            "-q",
            "--no-ff",
            "-m",
            "Land timeline/feature",
            "origin/timeline/feature",
        ],
    );
    git(&seed, &["push", "-q", "origin", "main"]);

    // The landed copy arrived through the merge's second parent; ours is a
    // duplicate of it, so sync drops it and @ follows trunk.
    let synced = s.ok(&["sync"]);
    assert!(
        synced["message"]
            .as_str()
            .unwrap()
            .contains("Dropped 1 change(s) that already landed")
    );
    assert!(
        !s.descriptions()
            .contains(&"Add a, local wording".to_string())
    );
    assert_eq!(
        s.ok(&["status"])["parents"][0]["change_id"],
        s.change("Land timeline/feature")
    );
}
