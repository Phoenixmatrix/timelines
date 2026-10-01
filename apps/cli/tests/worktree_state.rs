//! Shared git objects and bookmarks must not turn local workspaces into shared state.
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

fn gm(cwd: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_gm"));
    command
        .current_dir(cwd)
        .args(args)
        .env("GM_AGENT", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("XDG_CONFIG_HOME", cwd.join(".git/gm-test-config"));
    command
}

fn success(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn ok(cwd: &Path, args: &[&str]) -> Value {
    success(gm(cwd, args).output().unwrap())
}

fn state(cwd: &Path) -> Value {
    let path = PathBuf::from(git(cwd, &["rev-parse", "--git-path", "gm/view.json"]));
    serde_json::from_slice(&fs::read(cwd.join(path)).unwrap()).unwrap()
}

fn pair() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let main = dir.path().join("main");
    let linked = dir.path().join("linked");
    git(dir.path(), &["init", "-q", "-b", "main", "main"]);
    git(&main, &["config", "user.name", "Test"]);
    git(&main, &["config", "user.email", "test@example.com"]);
    fs::write(main.join("base"), "base\n").unwrap();
    git(&main, &["add", "."]);
    git(&main, &["commit", "-qm", "base"]);
    ok(&main, &["init"]);
    git(
        &main,
        &[
            "worktree",
            "add",
            "--detach",
            linked.to_str().unwrap(),
            "HEAD",
        ],
    );
    fs::create_dir(linked.join("subdir")).unwrap();
    ok(&linked.join("subdir"), &["init"]);
    (dir, main, linked)
}

#[test]
fn linked_workspaces_snapshot_commit_and_undo_independently() {
    let (_dir, main, linked) = pair();
    fs::write(main.join("own"), "main\n").unwrap();
    fs::write(linked.join("own"), "linked\n").unwrap();
    ok(&main, &["commit", "-m", "main change"]);
    let main_before = state(&main);
    ok(&linked.join("subdir"), &["commit", "-m", "linked change"]);
    ok(&linked, &["undo"]);
    assert_eq!(state(&main), main_before);
    assert_eq!(fs::read_to_string(main.join("own")).unwrap(), "main\n");
    assert_eq!(ok(&linked, &["file", "show", "own"])["content"], "linked\n");
    let linked_before = state(&linked);
    ok(&main, &["undo"]);
    assert_eq!(state(&linked), linked_before);
    assert_eq!(ok(&main, &["file", "show", "own"])["content"], "main\n");
}

#[test]
fn undo_preserves_bookmarks_created_moved_and_deleted_elsewhere() {
    let (_dir, main, linked) = pair();
    ok(&main, &["bookmark", "set", "deleted"]);
    ok(&main, &["bookmark", "set", "shared"]);
    let linked_wc = state(&linked)["wc"].as_str().unwrap().to_string();
    ok(&linked, &["bookmark", "set", "shared"]);
    ok(&linked, &["bookmark", "set", "other"]);
    git(&linked, &["branch", "-D", "deleted"]);
    ok(&main, &["undo"]);
    assert_eq!(git(&main, &["rev-parse", "shared"]), linked_wc);
    assert_eq!(git(&main, &["rev-parse", "other"]), linked_wc);
    assert_eq!(git(&main, &["branch", "--list", "deleted"]), "");
    assert_eq!(state(&linked)["wc"], linked_wc);
}

#[test]
fn operation_restore_reverts_local_bookmarks_but_preserves_sibling_changes() {
    let (_dir, main, linked) = pair();
    ok(&main, &["bookmark", "set", "local"]);
    ok(&main, &["bookmark", "set", "shared"]);
    let original = state(&main)["wc"].as_str().unwrap().to_string();
    let op = ok(&main, &["op", "log"])["operations"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    ok(&main, &["describe", "-m", "later local change"]);
    ok(&main, &["bookmark", "set", "later"]);
    assert_ne!(git(&main, &["rev-parse", "local"]), original);
    let sibling = state(&linked)["wc"].as_str().unwrap().to_string();
    ok(&linked, &["bookmark", "set", "shared"]);
    ok(&linked, &["bookmark", "set", "other"]);
    let sibling_state = state(&linked);
    ok(&main, &["op", "restore", &op]);
    assert_eq!(state(&main)["wc"], original);
    assert_eq!(git(&main, &["rev-parse", "local"]), original);
    assert_eq!(git(&main, &["branch", "--list", "later"]), "");
    assert_eq!(git(&main, &["rev-parse", "shared"]), sibling);
    assert_eq!(git(&main, &["rev-parse", "other"]), sibling);
    assert_eq!(state(&linked), sibling_state);
}

#[test]
fn parallel_bookmark_updates_preserve_both_workspaces() {
    let (_dir, main, linked) = pair();
    fs::write(main.join("own"), "main\n").unwrap();
    fs::write(linked.join("own"), "linked\n").unwrap();
    let a = gm(&main, &["bookmark", "set", "one"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let b = gm(&linked, &["bookmark", "set", "two"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    success(a.wait_with_output().unwrap());
    success(b.wait_with_output().unwrap());
    assert_eq!(
        git(&main, &["rev-parse", "one"]),
        state(&main)["wc"].as_str().unwrap()
    );
    assert_eq!(
        git(&linked, &["rev-parse", "two"]),
        state(&linked)["wc"].as_str().unwrap()
    );
    assert_eq!(ok(&main, &["file", "show", "own"])["content"], "main\n");
    assert_eq!(ok(&linked, &["file", "show", "own"])["content"], "linked\n");
}

#[test]
fn git_gc_preserves_unbookmarked_working_copies_and_undo_history() {
    let (_dir, main, linked) = pair();
    for work in [&main, &linked] {
        fs::write(
            work.join("own"),
            work.file_name().unwrap().as_encoded_bytes(),
        )
        .unwrap();
        ok(work, &["status"]);
        ok(work, &["describe", "-m", "before gc"]);
        ok(work, &["describe", "-m", "after gc"]);
    }
    let a = state(&main);
    let b = state(&linked);
    git(&main, &["reflog", "expire", "--expire=now", "--all"]);
    git(&main, &["gc", "--prune=now"]);
    for (work, before) in [(&main, a), (&linked, b)] {
        assert_eq!(
            git(work, &["cat-file", "-t", before["wc"].as_str().unwrap()]),
            "commit"
        );
        ok(work, &["undo"]);
        let restored = state(work);
        assert_eq!(
            git(
                work,
                &[
                    "show",
                    "-s",
                    "--format=%B",
                    restored["wc"].as_str().unwrap()
                ]
            ),
            "before gc"
        );
        assert_eq!(
            ok(work, &["file", "show", "own"])["content"],
            work.file_name().unwrap().to_str().unwrap()
        );
    }
}

#[test]
fn checked_out_plain_git_branch_cannot_be_moved_or_deleted() {
    let (dir, main, linked) = pair();
    let plain = dir.path().join("plain");
    git(
        &main,
        &[
            "worktree",
            "add",
            "-b",
            "plain",
            plain.to_str().unwrap(),
            "HEAD",
        ],
    );
    let old = git(&plain, &["rev-parse", "HEAD"]);
    let output = gm(&linked, &["bookmark", "set", "plain"]).output().unwrap();
    assert!(!output.status.success());
    let output = gm(&linked, &["bookmark", "delete", "plain"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(git(&plain, &["rev-parse", "HEAD"]), old);
    assert_eq!(fs::read_to_string(plain.join("base")).unwrap(), "base\n");
    assert_eq!(git(&plain, &["status", "--porcelain"]), "");
}

#[test]
fn bare_repository_init_is_rejected_without_gm_state() {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "--bare", "-q"]);
    assert!(!gm(dir.path(), &["init"]).output().unwrap().status.success());
    assert!(!dir.path().join("gm").exists());
}
