//! Real subprocess and HTTP regressions; no shared credentials or registry state.
#![cfg(unix)]

use parking_lot::Mutex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const TOKEN: &str = "isolated-artifact-test-token";

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Clone)]
struct Response {
    status: u16,
    body: Vec<u8>,
    checksum: Option<String>,
    length: usize,
    location: Option<String>,
}

impl Response {
    fn bytes(body: &[u8]) -> Self {
        Self {
            status: 200,
            body: body.to_vec(),
            checksum: Some(sha256(body)),
            length: body.len(),
            location: None,
        }
    }

    fn status(status: u16) -> Self {
        Self {
            status,
            ..Self::bytes(b"{}")
        }
    }
}

type Routes = Arc<Mutex<HashMap<(String, String), Response>>>;

struct Registry {
    address: SocketAddr,
    routes: Routes,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Registry {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let routes: Routes = Arc::new(Mutex::new(HashMap::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let worker_routes = Arc::clone(&routes);
        let worker_stop = Arc::clone(&stop);
        let worker = thread::spawn(move || {
            for stream in listener.incoming() {
                if worker_stop.load(Ordering::Acquire) {
                    break;
                }
                let mut stream = stream.unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut reader = BufReader::new(&mut stream);
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                let mut parts = line.split_whitespace();
                let method = parts.next().unwrap_or("").to_owned();
                let path = parts.next().unwrap_or("").to_owned();
                let mut authenticated = false;
                let mut complete = false;
                for _ in 0..100 {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                    if line == "\r\n" {
                        complete = true;
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':')
                        && name.eq_ignore_ascii_case("authorization")
                    {
                        authenticated = value.trim() == format!("Bearer {TOKEN}");
                    }
                }
                if !complete {
                    continue;
                }
                drop(reader);
                let response = if authenticated {
                    worker_routes
                        .lock()
                        .get(&(method.clone(), path))
                        .cloned()
                        .unwrap_or_else(|| Response::status(404))
                } else {
                    Response::status(401)
                };
                let mut headers = format!(
                    "HTTP/1.1 {} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n",
                    response.status, response.length
                );
                if let Some(checksum) = response.checksum {
                    headers.push_str(&format!("x-checksum-sha256: {checksum}\r\n"));
                }
                if let Some(location) = response.location {
                    headers.push_str(&format!("Location: {location}\r\n"));
                }
                headers.push_str("\r\n");
                // A rejected response may be closed before its body is consumed.
                if stream.write_all(headers.as_bytes()).is_ok() && method != "HEAD" {
                    let _ = stream.write_all(&response.body);
                }
            }
        });
        Self {
            address,
            routes,
            stop,
            worker: Some(worker),
        }
    }

    fn route(&self, method: &str, path: &str, response: Response) {
        self.routes
            .lock()
            .insert((method.into(), path.into()), response);
    }

    fn latest(&self, version: &str) {
        self.route(
            "GET",
            "/api/packages/publisher/generic/tool",
            Response::bytes(&serde_json::to_vec(&json!({"package": {"latest": version}})).unwrap()),
        );
    }
}

impl Drop for Registry {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        // Wake blocking accept; individual connections also have finite timeouts.
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_secs(3));
        if let Some(worker) = self.worker.take() {
            let result = worker.join();
            if !thread::panicking() {
                result.unwrap();
            }
        }
    }
}

struct Sandbox {
    root: tempfile::TempDir,
    registry: Registry,
}

impl Sandbox {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::new();
        registry.route(
            "GET",
            "/api/session",
            Response::bytes(
                &serde_json::to_vec(&json!({"viewer": {
                    "id": "person-author",
                    "slug": "author",
                    "defaultSpaceId": "space-publisher",
                    "spaces": [{"id": "space-publisher", "slug": "publisher"}]
                }}))
                .unwrap(),
            ),
        );
        fs::create_dir_all(root.path().join("home")).unwrap();
        fs::create_dir_all(root.path().join("config/gitmatrix")).unwrap();
        fs::write(
            root.path().join("config/gitmatrix/gm.json"),
            serde_json::to_vec(&json!({
                "server": format!("http://{}", registry.address),
                "token": TOKEN,
                "user": "author"
            }))
            .unwrap(),
        )
        .unwrap();
        Self { root, registry }
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.root.path().join(relative)
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_gm"))
            .current_dir(self.root.path())
            .env_clear()
            .env("HOME", self.path("home"))
            .env("XDG_CONFIG_HOME", self.path("config"))
            .env("PATH", "/usr/bin:/bin")
            .env("GM_AGENT", "1")
            .args(args)
            .output()
            .expect("gm runs")
    }

    fn ok(&self, args: &[&str]) -> Value {
        let output = self.run(args);
        assert!(
            output.status.success(),
            "gm {args:?}: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).expect("JSON command result")
    }

    fn fails(&self, args: &[&str]) -> Output {
        let output = self.run(args);
        assert!(
            !output.status.success(),
            "gm {args:?} unexpectedly succeeded"
        );
        output
    }
}

fn text(path: &Path) -> &str {
    path.to_str().unwrap()
}

fn assert_result(value: &Value, version: &str, bytes: &[u8], installed: bool) {
    assert_eq!(value["version"], version);
    assert_eq!(value["sha256"], sha256(bytes));
    assert_eq!(value["size"], bytes.len() as u64);
    assert_eq!(value["dry_run"], false);
    assert_eq!(value["installed"], installed);
}

#[test]
fn authenticated_download_resolves_current_latest_and_requires_overwrite_opt_in() {
    let s = Sandbox::new();
    let first = b"\0first release\xff\n";
    let second = b"\0second release\xfe\n";
    s.registry.latest("v1");
    s.registry.route(
        "GET",
        "/generic/publisher/tool/v1/nested/tool.bin",
        Response::bytes(first),
    );
    s.registry.route(
        "GET",
        "/generic/publisher/tool/v2/nested/tool.bin",
        Response::bytes(second),
    );
    let args = [
        "pkg",
        "download",
        "tool/latest/nested/tool.bin",
        "--space",
        "publisher",
    ];
    let result = s.ok(&args);
    assert_result(&result, "v1", first, false);
    assert_eq!(fs::read(s.path("tool.bin")).unwrap(), first);
    assert!(Path::new(result["path"].as_str().unwrap()).ends_with("tool.bin"));

    s.registry.latest("v2");
    s.fails(&args);
    assert_eq!(fs::read(s.path("tool.bin")).unwrap(), first);
    let result = s.ok(&[
        "pkg",
        "download",
        "tool/latest/nested/tool.bin",
        "--space",
        "publisher",
        "--force",
    ]);
    assert_result(&result, "v2", second, false);
    assert_eq!(fs::read(s.path("tool.bin")).unwrap(), second);
}

#[test]
fn failed_downloads_preserve_destinations_and_refuse_symlinks() {
    let s = Sandbox::new();
    let output_dir = s.path("outputs");
    fs::create_dir(&output_dir).unwrap();
    let destination = output_dir.join("tool");
    let original = b"previous verified artifact";
    let valid = b"replacement artifact";
    fs::write(&destination, original).unwrap();
    let args = [
        "pkg",
        "download",
        "tool/v1/tool",
        "--dest",
        text(&destination),
        "--force",
    ];
    let route = "/generic/publisher/tool/v1/tool";
    let mut corrupt = Response::bytes(valid);
    corrupt.body[0] ^= 1;
    s.registry.route("GET", route, corrupt);
    s.fails(&args);
    assert_eq!(fs::read(&destination).unwrap(), original);
    assert_eq!(
        fs::read_dir(&output_dir).unwrap().count(),
        1,
        "temporary download cleaned up"
    );

    let mut truncated = Response::bytes(valid);
    truncated.body.truncate(4);
    s.registry.route("GET", route, truncated);
    s.fails(&args);
    assert_eq!(fs::read(&destination).unwrap(), original);
    assert_eq!(fs::read_dir(&output_dir).unwrap().count(), 1);

    let mut missing_checksum = Response::bytes(valid);
    missing_checksum.checksum = None;
    s.registry.route("GET", route, missing_checksum);
    s.fails(&args);
    assert_eq!(fs::read(&destination).unwrap(), original);

    s.registry.route("GET", route, Response::bytes(valid));
    fs::remove_file(&destination).unwrap();
    let target = s.path("untouched");
    fs::write(&target, original).unwrap();
    symlink(&target, &destination).unwrap();
    s.fails(&args);
    assert!(
        fs::symlink_metadata(&destination)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(fs::read(&target).unwrap(), original);

    fs::remove_file(&destination).unwrap();
    fs::create_dir(&destination).unwrap();
    s.fails(&args);
    assert!(destination.is_dir());
}

#[test]
fn dry_run_checks_remote_metadata_without_creating_download_or_install_directories() {
    let s = Sandbox::new();
    let bytes = b"#!/bin/sh\nprintf 'verified executable\\n'\n";
    s.registry.latest("v3");
    // Only HEAD is available: dry-run must not fetch the executable body.
    s.registry.route(
        "HEAD",
        "/generic/publisher/tool/v3/custom/tool",
        Response::bytes(bytes),
    );
    let destination = s.path("absent/nested/tool");
    let result = s.ok(&[
        "--dry-run",
        "pkg",
        "download",
        "tool/latest/custom/tool",
        "--dest",
        text(&destination),
    ]);
    assert_eq!(result["version"], "v3");
    assert_eq!(result["sha256"], sha256(bytes));
    assert_eq!(result["dry_run"], true);
    assert!(!s.path("absent").exists());

    let platform = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
    s.registry.route(
        "HEAD",
        &format!("/generic/publisher/tool/v3/{platform}/tool"),
        Response::bytes(bytes),
    );
    let result = s.ok(&["pkg", "install", "tool", "--dry-run"]);
    assert_eq!(result["version"], "v3");
    assert_eq!(result["dry_run"], true);
    assert!(!s.path("home/.local").exists());

    let mut missing_checksum = Response::bytes(bytes);
    missing_checksum.checksum = None;
    s.registry.route(
        "HEAD",
        "/generic/publisher/tool/v3/custom/tool",
        missing_checksum,
    );
    s.fails(&[
        "pkg",
        "download",
        "tool/v3/custom/tool",
        "--dest",
        text(&destination),
        "--dry-run",
    ]);
    assert!(!s.path("absent").exists());
}

#[test]
fn install_is_executable_and_failed_replacement_preserves_working_binary() {
    let s = Sandbox::new();
    let bytes = b"#!/bin/sh\nprintf 'verified executable\\n'\n";
    let platform = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
    // There is no package metadata route: pinned installs must not resolve latest.
    s.registry.route(
        "GET",
        &format!("/generic/publisher/tool/v1/{platform}/tool"),
        Response::bytes(bytes),
    );
    let result = s.ok(&["pkg", "install", "tool", "--version", "v1"]);
    assert_result(&result, "v1", bytes, true);
    assert_eq!(result["platform"], platform);
    let binary = s.path("home/.local/bin/tool");
    assert_eq!(Path::new(result["path"].as_str().unwrap()), binary);
    assert_eq!(
        fs::metadata(&binary).unwrap().permissions().mode() & 0o777,
        0o755
    );
    let executed = Command::new(&binary).env_clear().output().unwrap();
    assert!(executed.status.success());
    assert_eq!(executed.stdout, b"verified executable\n");

    let replacement = b"#!/bin/sh\nprintf 'new executable\\n'\n";
    let mut truncated = Response::bytes(replacement);
    truncated.body.truncate(5);
    s.registry.route(
        "GET",
        "/generic/publisher/tool/v2/custom-executable",
        truncated,
    );
    let bin_dir = s.path("home/.local/bin");
    let args = [
        "pkg",
        "install",
        "tool",
        "--version",
        "v2",
        "--file",
        "custom-executable",
        "--bin-dir",
        text(&bin_dir),
    ];
    s.fails(&args);
    let mut forced = args.to_vec();
    forced.push("--force");
    s.fails(&forced);
    assert_eq!(fs::read(&binary).unwrap(), bytes);
    assert_eq!(
        fs::metadata(&binary).unwrap().permissions().mode() & 0o777,
        0o755
    );
    assert_eq!(fs::read_dir(&bin_dir).unwrap().count(), 1);

    s.registry.route(
        "GET",
        "/generic/publisher/tool/v2/custom-executable",
        Response::bytes(replacement),
    );
    s.fails(&args);
    assert_eq!(fs::read(&binary).unwrap(), bytes);
    assert_result(&s.ok(&forced), "v2", replacement, true);
    let executed = Command::new(&binary).env_clear().output().unwrap();
    assert!(executed.status.success());
    assert_eq!(executed.stdout, b"new executable\n");
    assert_eq!(
        fs::metadata(&binary).unwrap().permissions().mode() & 0o777,
        0o755
    );
}

#[test]
fn missing_auth_and_redirect_failures_never_replace_destination() {
    let s = Sandbox::new();
    let destination = s.path("tool");
    fs::write(&destination, b"keep me").unwrap();
    let args = [
        "pkg",
        "download",
        "tool/v1/tool",
        "--dest",
        text(&destination),
        "--force",
    ];
    let route = "/generic/publisher/tool/v1/tool";
    assert_eq!(s.fails(&args).status.code(), Some(3));
    for status in [401, 403] {
        s.registry.route("GET", route, Response::status(status));
        assert_eq!(s.fails(&args).status.code(), Some(5));
        assert_eq!(fs::read(&destination).unwrap(), b"keep me");
    }
    s.registry.route(
        "GET",
        "/redirect-target",
        Response::bytes(b"must not follow redirect"),
    );
    let mut redirect = Response::status(302);
    redirect.location = Some(format!("http://{}/redirect-target", s.registry.address));
    s.registry.route("GET", route, redirect);
    s.fails(&args);
    assert_eq!(fs::read(&destination).unwrap(), b"keep me");
}

#[test]
fn inaccessible_default_space_does_not_fall_back_to_person_identity() {
    let s = Sandbox::new();
    s.registry.route(
        "GET",
        "/api/session",
        Response::bytes(
            &serde_json::to_vec(&json!({"viewer": {
                "id": "person-author", "slug": "author",
                "defaultSpaceId": "space-revoked",
                "spaces": [{"id": "space-publisher", "slug": "publisher"}]
            }}))
            .unwrap(),
        ),
    );
    for space in ["author", "publisher"] {
        s.registry.route(
            "GET",
            &format!("/generic/{space}/tool/v1/tool"),
            Response::bytes(b"must not choose another scope"),
        );
    }
    let destination = s.path("absent/tool");
    assert_eq!(
        s.fails(&[
            "pkg",
            "download",
            "tool/v1/tool",
            "--dest",
            text(&destination)
        ])
        .status
        .code(),
        Some(2)
    );
    assert!(!s.path("absent").exists());
}
