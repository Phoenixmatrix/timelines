//! Exercise the real git transport and gm output contract without a network service.

use serde_json::Value;
use std::fs;
use std::path::Path;
use std::process::{Command, Output};

fn git(cwd: &Path, args: &[&str]) {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Seed")
        .env("GIT_AUTHOR_EMAIL", "seed@example.com")
        .env("GIT_COMMITTER_NAME", "Seed")
        .env("GIT_COMMITTER_EMAIL", "seed@example.com")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir(root.join("orbit")).unwrap();
    git(root, &["init", "-q", "-b", "main", "seed"]);
    for n in 0..32 {
        fs::write(
            root.join(format!("seed/file-{n}")),
            format!("file {n}\n").repeat(1024),
        )
        .unwrap();
    }
    git(&root.join("seed"), &["add", "."]);
    git(&root.join("seed"), &["commit", "-qm", "Initial"]);
    git(root, &["clone", "-q", "--bare", "seed", "orbit/large.git"]);
    dir
}

fn clone(root: &Path, repo: &str, target: &str, format: &str, quiet: bool) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_gm"));
    command
        .current_dir(root)
        .args(["clone", repo, target, "-o", format])
        .env("GM_SERVER", format!("file://{}", root.display()))
        .env("GM_TOKEN", "fixture-token")
        .env("GM_AGENT", "1")
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Clone")
        .env("GIT_AUTHOR_EMAIL", "clone@example.com")
        .env("GIT_COMMITTER_NAME", "Clone")
        .env("GIT_COMMITTER_EMAIL", "clone@example.com");
    if quiet {
        command.arg("--quiet");
    }
    command.output().unwrap()
}

#[test]
fn agent_progress_keeps_stdout_a_single_result_and_reports_transfer_counts() {
    let dir = fixture();
    let output = clone(dir.path(), "orbit/large", "work", "json", false);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["repository"], "orbit/large");
    assert_eq!(
        fs::read(dir.path().join("work/file-31")).unwrap(),
        fs::read(dir.path().join("seed/file-31")).unwrap()
    );
    let events: Vec<Value> = String::from_utf8(output.stderr)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(
        events
            .iter()
            .all(|event| event["event"] == "clone.progress")
    );
    assert_eq!(events.first().unwrap()["phase"], "connecting");
    assert_eq!(events[events.len() - 2]["phase"], "initializing");
    assert_eq!(events.last().unwrap()["phase"], "complete");
    let received = events
        .iter()
        .find(|e| e["phase"] == "receiving" && e["percent"] == 100)
        .unwrap();
    // Thirty-two distinct blobs, a tree and a commit traverse the file transport.
    assert_eq!(received["current"], 34);
    assert_eq!(received["total"], 34);
}

#[test]
fn human_progress_is_readable_and_quiet_suppresses_it() {
    let dir = fixture();
    let text = clone(dir.path(), "orbit/large", "human", "text", false);
    assert!(text.status.success());
    let stderr = String::from_utf8(text.stderr).unwrap();
    assert!(stderr.contains("Receiving objects:"));
    assert!(!stderr.contains("\"event\""));
    assert!(
        String::from_utf8(text.stdout)
            .unwrap()
            .contains("Working copy:")
    );
    let quiet = clone(dir.path(), "orbit/large", "quiet", "json", true);
    assert!(quiet.status.success());
    assert!(quiet.stderr.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&quiet.stdout).unwrap()["repository"],
        "orbit/large"
    );
}

#[test]
fn failed_clone_reports_an_error_without_success_or_initialization_progress() {
    let dir = fixture();
    let output = clone(dir.path(), "orbit/missing", "failed", "json", false);
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let events: Vec<Value> = String::from_utf8(output.stderr)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(events.last().unwrap()["error"]["code"], "git_failed");
    assert!(
        events
            .iter()
            .all(|event| event["phase"] != "initializing" && event["phase"] != "complete")
    );
    let quiet = clone(dir.path(), "orbit/missing", "quiet-failed", "json", true);
    assert!(!quiet.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&quiet.stderr).unwrap()["error"]["code"],
        "git_failed"
    );
}
