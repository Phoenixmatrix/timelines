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

    /// Text output, as a person at a terminal would read it.
    fn text(&self, args: &[&str]) -> String {
        let mut args = args.to_vec();
        args.extend(["--output", "text"]);
        let output = Command::new(env!("CARGO_BIN_EXE_gm"))
            .current_dir(self.work())
            .args(&args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("XDG_CONFIG_HOME", self.root.join("config"))
            .output()
            .expect("gm runs");
        assert!(output.status.success(), "gm {args:?} failed");
        String::from_utf8_lossy(&output.stdout).to_string()
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
fn log_text_draws_forks_and_merges() {
    let s = Sandbox::new();
    s.write("a.txt", "one\n");
    s.ok(&["commit", "-m", "Add a"]);
    s.ok(&["new", "trunk", "-m", "Add b"]);
    s.write("b.txt", "two\n");
    let a = s.change("Add a");
    let b = s.change("Add b");
    s.ok(&["new", &a, &b, "-m", "Merge"]);

    // JSON keeps listing each change with its parents.
    let merge = &s.ok(&["log"])["changes"][0];
    assert_eq!(merge["description"], "Merge");
    assert_eq!(merge["parents"], serde_json::json!([a, b]));

    // Text draws the merge's lanes splitting and the fork joining at trunk.
    let text = s.text(&["log"]);
    let rows: Vec<&str> = text.lines().collect();
    // The two sides may be listed in either order; each keeps its own lane.
    let (a_row, b_row) = (format!("○ │  {a} "), format!("│ ○  {b} "));
    let sides = [(&*a_row, "Add a"), (&*b_row, "Add b")];
    let expected = [
        ("@  ", "Merge"),
        ("├─╮", ""),
        sides[0],
        sides[1],
        ("├─╯", ""),
        ("◆  ", "Initial"),
    ];
    assert_eq!(rows.len(), expected.len(), "{text}");
    let side = |row: &str| {
        sides
            .iter()
            .any(|(graph, description)| row.starts_with(graph) && row.ends_with(description))
    };
    for (i, (row, (graph, description))) in rows.iter().zip(expected).enumerate() {
        let ok = if i == 2 || i == 3 {
            side(row)
        } else {
            row.starts_with(graph) && row.ends_with(description)
        };
        assert!(ok, "{row:?} in\n{text}");
    }
    assert_ne!(rows[2], rows[3], "{text}");
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
fn conflicts_resolved_in_a_child_clear_when_squashed() {
    let s = Sandbox::new();
    s.write("README.md", "hello from work\n");
    s.ok(&["commit", "-m", "Work edit"]);
    s.teammate_pushes("README.md", "hello from seed\n", "Seed edit");
    s.ok(&["sync"]);

    // Resolve in the working copy on top of the conflicted change, then fold it in.
    assert!(s.read("README.md").contains("<<<<<<<"));
    s.write("README.md", "hello from both\n");
    s.ok(&["squash"]);
    assert_eq!(s.ok(&["status"])["conflicts"], Value::Array(vec![]));
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

#[test]
fn worktree_creation_snapshots_source_and_includes_only_when_requested() {
    let s = Sandbox::new();
    s.write(".gitignore", ".env\ncache/\n");
    s.write(
        ".worktreeinclude",
        ".env\ncache/\n!cache/private\nREADME.md\n",
    );
    s.write(".env", "TOKEN=local\n");
    s.write("cache/config", "ready\n");
    s.write("cache/private", "do not copy\n");
    s.write("pending.txt", "source edits\n");
    let preview = s.ok(&["worktree", "add", "../preview", "--include", "--dry-run"]);
    assert_eq!(preview["dry_run"], true);
    assert!(!s.root.join("preview").exists());
    let added = s.ok(&["worktree", "add", "../with spaces", "--include"]);
    let target = s.root.join("with spaces");
    assert_eq!(
        fs::read_to_string(target.join("pending.txt")).unwrap(),
        "source edits\n"
    );
    assert_eq!(
        fs::read_to_string(target.join(".env")).unwrap(),
        "TOKEN=local\n"
    );
    assert_eq!(
        fs::read_to_string(target.join("cache/config")).unwrap(),
        "ready\n"
    );
    assert!(!target.join("cache/private").exists());
    assert_eq!(
        added["copied_files"],
        serde_json::json!([".env", "cache/config"])
    );
    let status = s.ok(&["-C", target.to_str().unwrap(), "status"]);
    assert_eq!(status["working_copy"]["empty"], true);
    s.ok(&["worktree", "add", "../without"]);
    assert!(!s.root.join("without/.env").exists());
    let list = s.ok(&["-C", target.to_str().unwrap(), "worktree", "list"]);
    let paths: Vec<_> = list["worktrees"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| (w["path"].as_str().unwrap(), w["current"].as_bool().unwrap()))
        .collect();
    assert!(paths.contains(&(target.to_str().unwrap(), true)));
    assert!(paths.contains(&(s.work().to_str().unwrap(), false)));
}

#[test]
fn worktree_removal_requires_consent_and_retains_snapshotted_history() {
    let s = Sandbox::new();
    s.ok(&["worktree", "add", "../side"]);
    let side = s.root.join("side");
    fs::write(side.join("only-here"), "keep in history\n").unwrap();
    let side_path = side.to_str().unwrap();
    let committed = s.ok(&["-C", side_path, "commit", "-m", "Side work"]);
    let wc = committed["working_copy"]["commit_id"].as_str().unwrap();
    fs::write(side.join("untracked"), "not snapshotted\n").unwrap();
    assert_eq!(
        s.err(&["worktree", "remove", "../side"]).1,
        "worktree_dirty"
    );
    assert_eq!(
        s.err(&["-C", side_path, "worktree", "remove", "."]).1,
        "invalid_argument"
    );
    git(&s.work(), &["worktree", "lock", side_path]);
    assert_eq!(
        s.err(&["worktree", "remove", "../side", "--force"]).1,
        "worktree_locked"
    );
    git(&s.work(), &["worktree", "unlock", side_path]);
    s.ok(&["worktree", "remove", "../side", "--force", "--dry-run"]);
    assert!(side.exists());
    let removed = s.ok(&["worktree", "remove", "../side", "--force"]);
    assert!(!side.exists());
    let archive = Path::new(removed["recovery_path"].as_str().unwrap());
    let view: Value =
        serde_json::from_slice(&fs::read(archive.join("view.json")).unwrap()).unwrap();
    assert!(view["wc"].as_str().unwrap().starts_with(wc));
    git(&s.work(), &["reflog", "expire", "--expire=now", "--all"]);
    git(&s.work(), &["gc", "--prune=now"]);
    let repo = git2::Repository::open(s.work()).unwrap();
    let saved = repo
        .find_commit(git2::Oid::from_str(view["wc"].as_str().unwrap()).unwrap())
        .unwrap();
    let tree = saved.tree().unwrap();
    let blob = repo
        .find_blob(tree.get_name("only-here").unwrap().id())
        .unwrap();
    assert_eq!(blob.content(), b"keep in history\n");
}

#[test]
fn worktree_add_failure_keeps_existing_files_and_dry_run_keeps_state() {
    let s = Sandbox::new();
    let before = fs::read(s.work().join(".git/gm/view.json")).unwrap();
    s.write("pending", "not yet snapshotted\n");
    s.ok(&["worktree", "add", "../preview", "-r", "trunk", "--dry-run"]);
    assert_eq!(
        fs::read(s.work().join(".git/gm/view.json")).unwrap(),
        before
    );
    assert!(!s.root.join("preview").exists());
    assert_eq!(
        s.err(&["worktree", "add", "../invalid", "-r", "zzzzzzzz"])
            .1,
        "revision_not_found"
    );
    assert!(!s.root.join("invalid").exists());
    fs::create_dir(s.root.join("occupied")).unwrap();
    fs::write(s.root.join("occupied/keep"), "untouched\n").unwrap();
    assert_eq!(
        s.err(&["worktree", "add", "../occupied"]).1,
        "directory_not_empty"
    );
    assert_eq!(
        fs::read_to_string(s.root.join("occupied/keep")).unwrap(),
        "untouched\n"
    );
}
