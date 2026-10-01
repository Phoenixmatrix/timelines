//! End-to-end tests: drive the gm binary against throwaway repositories with
//! a local bare remote standing in for Gitmatrix.

use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

struct Sandbox {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

fn git(cwd: &Path, args: &[&str]) {
    let status = Command::new("git")
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
        status.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&status.stderr)
    );
}

impl Sandbox {
    /// A bare remote with one commit on main, a seed clone that can push to
    /// it like a teammate, and a gm-managed clone called `work`.
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

    fn err(&self, args: &[&str]) -> (i32, String) {
        let (code, value, _) = self.run(args);
        assert_ne!(code, 0, "gm {args:?} should fail");
        (
            code,
            value["error"]["code"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
        )
    }

    fn write(&self, path: &str, content: &str) {
        let full = self.work().join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, content).unwrap();
    }

    fn read(&self, path: &str) -> String {
        fs::read_to_string(self.work().join(path)).unwrap_or_default()
    }

    /// Descriptions in `gm log`, newest first.
    fn log(&self) -> Vec<String> {
        self.ok(&["log"])["changes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["description"].as_str().unwrap().to_string())
            .collect()
    }

    fn change(&self, description: &str) -> String {
        self.ok(&["log"])["changes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["description"] == description)
            .unwrap_or_else(|| panic!("no change described {description:?}"))["change_id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn teammate_pushes(&self, path: &str, content: &str, message: &str) {
        let seed = self.root.join("seed");
        git(&seed, &["pull", "-q", "--rebase", "origin", "main"]);
        fs::write(seed.join(path), content).unwrap();
        git(&seed, &["add", "."]);
        git(&seed, &["commit", "-qm", message]);
        git(&seed, &["push", "-q", "origin", "main"]);
    }
}

#[test]
fn edits_are_snapshotted_and_commit_starts_a_new_change() {
    let s = Sandbox::new();
    s.write("a.txt", "one\n");
    let status = s.ok(&["status"]);
    assert_eq!(status["files"][0]["path"], "a.txt");
    assert_eq!(status["files"][0]["status"], "added");

    let result = s.ok(&["commit", "-m", "Add a"]);
    assert_eq!(result["changes"][0]["description"], "Add a");
    assert_eq!(result["working_copy"]["empty"], true);
    assert_eq!(s.log(), vec!["", "Add a", "Initial"]);
}

#[test]
fn change_ids_survive_rewrites_and_descendants_follow() {
    let s = Sandbox::new();
    s.write("a.txt", "one\n");
    s.ok(&["commit", "-m", "Add a"]);
    s.write("b.txt", "two\n");
    s.ok(&["commit", "-m", "Add b"]);
    let a = s.change("Add a");

    s.ok(&["edit", &a]);
    s.write("a.txt", "one, fixed\n");
    s.ok(&["status"]);
    // Same change id after the edit, and "Add b" now carries the fix.
    assert_eq!(s.change("Add a"), a);
    let b = s.change("Add b");
    assert_eq!(
        s.ok(&["file", "show", "a.txt", "-r", &b])["content"],
        "one, fixed\n"
    );
    assert_eq!(
        s.ok(&["file", "show", "b.txt", "-r", &b])["content"],
        "two\n"
    );
}

#[test]
fn squash_and_split_move_edits_between_changes() {
    let s = Sandbox::new();
    s.write("a.txt", "one\n");
    s.ok(&["commit", "-m", "Add a"]);
    s.write("a.txt", "one!\n");
    s.ok(&["squash"]);
    assert_eq!(s.log(), vec!["", "Add a", "Initial"]);
    assert_eq!(
        s.ok(&["file", "show", "a.txt", "-r", "@-"])["content"],
        "one!\n"
    );

    s.write("x.txt", "x\n");
    s.write("y.txt", "y\n");
    s.ok(&["split", "-m", "Add x", "x.txt"]);
    s.ok(&["describe", "-m", "Add y"]);
    assert_eq!(s.log(), vec!["Add y", "Add x", "Add a", "Initial"]);
    let files: Vec<String> = s.ok(&["diff", "--stat"])["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap().into())
        .collect();
    assert_eq!(files, vec!["y.txt"]);
}

#[test]
fn commit_with_paths_leaves_the_rest_in_the_working_copy() {
    let s = Sandbox::new();
    s.write("docs.md", "docs\n");
    s.write("code.rs", "code\n");
    s.ok(&["commit", "-m", "Docs only", "docs.md"]);
    let files: Vec<String> = s.ok(&["status"])["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap().into())
        .collect();
    assert_eq!(files, vec!["code.rs"]);
    assert_eq!(
        s.err(&["commit", "-m", "Nothing", "missing.txt"]).1,
        "no_matching_changes"
    );
}

#[test]
fn undo_reverses_operations_one_by_one() {
    let s = Sandbox::new();
    s.write("a.txt", "one\n");
    s.ok(&["commit", "-m", "Add a"]);
    s.ok(&["describe", "@-", "-m", "Add a, better"]);
    s.ok(&["undo"]);
    assert_eq!(s.log(), vec!["", "Add a", "Initial"]);
    s.ok(&["undo"]);
    // Back before the commit: the edit is in the working copy again.
    assert_eq!(s.log(), vec!["", "Initial"]);
    assert_eq!(s.read("a.txt"), "one\n");
}

#[test]
fn abandon_drops_a_change_and_its_files() {
    let s = Sandbox::new();
    s.write("a.txt", "one\n");
    s.ok(&["commit", "-m", "Add a"]);
    s.write("b.txt", "two\n");
    s.ok(&["commit", "-m", "Add b"]);
    let a = s.change("Add a");
    s.ok(&["abandon", &a]);
    assert_eq!(s.log(), vec!["", "Add b", "Initial"]);
    assert!(!s.work().join("a.txt").exists());
    assert!(s.work().join("b.txt").exists());
}

#[test]
fn dry_run_changes_nothing() {
    let s = Sandbox::new();
    s.write("a.txt", "one\n");
    s.ok(&["commit", "-m", "Add a"]);
    let before = s.log();
    let result = s.ok(&["abandon", "@-", "--dry-run"]);
    assert_eq!(result["dry_run"], true);
    assert_eq!(result["operation"], Value::Null);
    assert_eq!(s.log(), before);
    assert!(s.work().join("a.txt").exists());
}

#[test]
fn push_lands_on_trunk_and_makes_changes_immutable() {
    let s = Sandbox::new();
    s.write("a.txt", "one\n");
    s.ok(&["commit", "-m", "Add a"]);
    let pushed = s.ok(&["push"]);
    assert_eq!(pushed["bookmark"], "main");
    assert_eq!(pushed["pushed"][0]["description"], "Add a");
    assert_eq!(pushed["pushed"][0]["immutable"], true);
    assert_eq!(
        s.err(&["describe", "@-", "-m", "Rewrite history"]).1,
        "immutable_change"
    );
}

#[test]
fn push_refuses_undescribed_work_and_stale_trunk() {
    let s = Sandbox::new();
    s.write("a.txt", "one\n");
    let (code, error) = s.err(&["push"]);
    assert_eq!((code, error.as_str()), (4, "missing_description"));

    s.ok(&["commit", "-m", "Add a"]);
    s.teammate_pushes("README.md", "hello from a teammate\n", "Teammate");
    s.ok(&["fetch"]);
    assert_eq!(s.err(&["push"]), (4, "remote_moved".to_string()));
    let pushed = s.ok(&["push", "--sync"]);
    assert_eq!(pushed["pushed"].as_array().unwrap().len(), 1);
    assert_eq!(s.read("README.md"), "hello from a teammate\n");
}

#[test]
fn conflicts_are_recorded_then_cleared_by_editing() {
    let s = Sandbox::new();
    s.write("README.md", "hello from work\n");
    s.ok(&["commit", "-m", "Work edit"]);
    s.teammate_pushes("README.md", "hello from seed\n", "Seed edit");
    let synced = s.ok(&["sync"]);
    assert_eq!(synced["conflicts"][0]["paths"][0], "README.md");
    assert_eq!(s.err(&["push"]).1, "has_conflicts");

    let conflicted = s.change("Work edit");
    s.ok(&["edit", &conflicted]);
    assert!(s.read("README.md").contains("<<<<<<<"));
    s.write("README.md", "hello from both\n");
    assert_eq!(s.ok(&["status"])["conflicts"], Value::Array(vec![]));
    s.ok(&["new"]);
    s.ok(&["push"]);
}

#[test]
fn backout_and_duplicate_insert_below_the_working_copy() {
    let s = Sandbox::new();
    s.write("a.txt", "one\n");
    s.ok(&["commit", "-m", "Add a"]);
    let a = s.change("Add a");
    s.ok(&["backout", "-r", &a]);
    assert!(!s.work().join("a.txt").exists());
    assert!(s.log()[1].starts_with(&format!("Back out \"Add a\"\n\nThis backs out change {a}")));
    s.ok(&["undo"]);
    s.ok(&["new", "trunk"]);
    s.ok(&["duplicate", &a]);
    assert_eq!(s.read("a.txt"), "one\n");
}

#[test]
fn bookmarks_are_git_branches() {
    let s = Sandbox::new();
    s.write("a.txt", "one\n");
    s.ok(&["commit", "-m", "Add a"]);
    s.ok(&["bookmark", "set", "feature", "-r", "@-"]);
    let list = s.ok(&["bookmark", "list"]);
    assert!(
        list["bookmarks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["name"] == "feature")
    );
    let branch = Command::new("git")
        .current_dir(s.work())
        .args(["rev-parse", "--verify", "refs/heads/feature"])
        .output()
        .unwrap();
    assert!(branch.status.success());
    s.ok(&["push", "-b", "feature"]);
    // A pushed feature bookmark stays rewritable (only trunk is immutable).
    s.ok(&["describe", "@-", "-m", "Add a (reworded)"]);
    s.ok(&["push", "-b", "feature"]);
}

#[test]
fn errors_are_json_with_codes_and_hints() {
    let s = Sandbox::new();
    let (code, value, _) = s.run(&["edit", "zzzzzzzz"]);
    assert_eq!(code, 3);
    assert_eq!(value["error"]["code"], "revision_not_found");
    assert!(value["error"]["hint"].as_str().unwrap().contains("gm log"));
    let (code, value, _) = s.run(&["frobnicate"]);
    assert_eq!(code, 2);
    assert!(
        value["error"]["hint"]
            .as_str()
            .unwrap()
            .contains("gm cli search")
    );
}

#[test]
fn search_and_schema_describe_the_cli() {
    let s = Sandbox::new();
    let hits = s.ok(&["cli", "search", "cherry-pick a commit from another branch"]);
    assert_eq!(hits[0]["command"], "gm duplicate");
    let schema = s.ok(&["schema", "commit"]);
    assert_eq!(schema["command"], "gm commit");
    assert!(schema["output"]["properties"]["working_copy"].is_object());
}
