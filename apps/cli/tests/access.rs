//! Exercise Access credentials through gm and real HTTP/Git transports.
#![cfg(unix)]

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;

const ACCESS: &str =
    r#"{"cf-access-client-id":"fixture-client","cf-access-client-secret":"fixture-access-secret"}"#;
const PAT: &str = "fixture-pat";

struct Server {
    origin: String,
    stop: Arc<AtomicBool>,
    requests: Arc<AtomicUsize>,
    leaks: Arc<AtomicUsize>,
    worker: Option<JoinHandle<()>>,
}

impl Server {
    fn start(root: Option<PathBuf>, protected: bool, redirect: Option<String>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(AtomicUsize::new(0));
        let leaks = Arc::new(AtomicUsize::new(0));
        let (stopping, received, leaked) = (stop.clone(), requests.clone(), leaks.clone());
        let worker = std::thread::spawn(move || {
            for stream in listener.incoming() {
                if stopping.load(Ordering::Acquire) {
                    break;
                }
                let mut stream = stream.unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(&mut stream);
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
                let path = line
                    .split_whitespace()
                    .nth(1)
                    .unwrap()
                    .split('?')
                    .next()
                    .unwrap()
                    .to_owned();
                let mut client_id = false;
                let mut client_secret = false;
                let mut pat = false;
                loop {
                    line.clear();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some((key, value)) = line.split_once(':') {
                        if key.eq_ignore_ascii_case("cf-access-client-id") {
                            client_id = value.trim() == "fixture-client";
                            if !protected {
                                leaked.fetch_add(1, Ordering::SeqCst);
                            }
                        }
                        if key.eq_ignore_ascii_case("cf-access-client-secret") {
                            client_secret = value.trim() == "fixture-access-secret";
                            if !protected {
                                leaked.fetch_add(1, Ordering::SeqCst);
                            }
                        }
                        if key.eq_ignore_ascii_case("authorization") {
                            pat = value.trim() == format!("Bearer {PAT}");
                        }
                    }
                }
                drop(reader);
                received.fetch_add(1, Ordering::SeqCst);
                let (status, body, location) =
                    if protected && (!client_id || !client_secret || !pat) {
                        (
                            403,
                            b"{\"error\":\"access denied\"}".to_vec(),
                            String::new(),
                        )
                    } else if let Some(target) = &redirect {
                        (302, Vec::new(), format!("Location: {target}{path}\r\n"))
                    } else if path == "/api/protected" {
                        (200, b"{\"authorized\":true}".to_vec(), String::new())
                    } else if let Some(root) = &root {
                        match fs::read(root.join(path.trim_start_matches('/'))) {
                            Ok(bytes) => (200, bytes, String::new()),
                            Err(_) => (404, Vec::new(), String::new()),
                        }
                    } else {
                        (404, Vec::new(), String::new())
                    };
                let header = format!(
                    "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\n{location}Connection: close\r\n\r\n",
                    body.len()
                );
                if stream.write_all(header.as_bytes()).is_ok() {
                    let _ = stream.write_all(&body);
                }
            }
        });
        Self {
            origin,
            stop,
            requests,
            leaks,
            worker: Some(worker),
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = TcpStream::connect(self.origin.trim_start_matches("http://"));
        self.worker.take().unwrap().join().unwrap();
    }
}

struct Sandbox {
    root: tempfile::TempDir,
}
impl Sandbox {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("home")).unwrap();
        Self { root }
    }
    fn gm(&self, server: &str, scope: &str, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_gm"));
        command
            .current_dir(self.root.path())
            .args(args)
            .env("HOME", self.root.path().join("home"))
            .env("XDG_CONFIG_HOME", self.root.path().join("config"))
            .env("GM_SERVER", server)
            .env("GM_TOKEN", PAT)
            .env("GITMATRIX_ACCESS_ORIGIN", scope)
            .env("GITMATRIX_ACCESS_TOKEN", ACCESS)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env_remove("GIT_CONFIG_COUNT")
            .env_remove("GIT_CONFIG_PARAMETERS")
            .env_remove("GM_AGENT")
            .env_remove("SSH_AUTH_SOCK");
        command
    }
    fn repository(&self) -> PathBuf {
        let root = self.root.path().join("served");
        let repo = root.join("owner/repo.git");
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "--bare", "--initial-branch=main"]);
        let source = self.root.path().join("source");
        fs::create_dir(&source).unwrap();
        git(&source, &["init", "--initial-branch=main"]);
        fs::write(source.join("content.txt"), "protected repository content\n").unwrap();
        git(&source, &["add", "."]);
        git(
            &source,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.test",
                "commit",
                "-m",
                "fixture",
            ],
        );
        git(&source, &["push", repo.to_str().unwrap(), "main"]);
        git(&repo, &["update-server-info"]);
        root
    }
}
fn git(dir: &std::path::Path, args: &[&str]) {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}
fn success(out: Output) -> Output {
    assert!(
        out.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!String::from_utf8_lossy(&out.stderr).contains("fixture-access-secret"));
    out
}

#[test]
fn protected_api_and_real_git_clone_preserve_pat_without_persisting_access() {
    let sandbox = Sandbox::new();
    let server = Server::start(Some(sandbox.repository()), true, None);
    let response = success(
        sandbox
            .gm(
                &server.origin,
                &server.origin,
                &["api", "GET", "/protected"],
            )
            .output()
            .unwrap(),
    );
    assert!(String::from_utf8_lossy(&response.stdout).contains("true"));
    success(
        sandbox
            .gm(
                &server.origin,
                &server.origin,
                &["clone", "owner/repo", "checkout"],
            )
            .env("GIT_TRACE_CURL", "1")
            .env("GIT_TRACE", "1")
            .output()
            .unwrap(),
    );
    assert_eq!(
        fs::read_to_string(sandbox.root.path().join("checkout/content.txt")).unwrap(),
        "protected repository content\n"
    );
    let config = fs::read_to_string(sandbox.root.path().join("checkout/.git/config")).unwrap();
    assert!(!config.contains("fixture-access-secret"));
    assert!(!config.to_lowercase().contains("extraheader"));
    assert!(
        !sandbox
            .root
            .path()
            .join("config/gitmatrix/gm.json")
            .exists()
    );
}

#[test]
fn different_origin_never_receives_access_even_when_redirecting_to_scope() {
    let sandbox = Sandbox::new();
    let protected = Server::start(None, true, None);
    let other = Server::start(Some(sandbox.repository()), false, None);
    success(
        sandbox
            .gm(
                &other.origin,
                &protected.origin,
                &["api", "GET", "/protected"],
            )
            .output()
            .unwrap(),
    );
    success(
        sandbox
            .gm(
                &other.origin,
                &protected.origin,
                &["clone", "owner/repo", "checkout"],
            )
            .output()
            .unwrap(),
    );
    assert_eq!(other.leaks.load(Ordering::SeqCst), 0);
    assert_eq!(protected.requests.load(Ordering::SeqCst), 0);
    let redirect = Server::start(None, false, Some(protected.origin.clone()));
    assert!(
        !sandbox
            .gm(
                &redirect.origin,
                &protected.origin,
                &["api", "GET", "/protected"]
            )
            .output()
            .unwrap()
            .status
            .success()
    );
    assert_eq!(redirect.leaks.load(Ordering::SeqCst), 0);
}

#[test]
fn protected_redirects_are_not_followed_by_http_or_git() {
    let sandbox = Sandbox::new();
    let target = Server::start(None, false, None);
    let protected = Server::start(None, true, Some(target.origin.clone()));
    for args in [
        vec!["api", "GET", "/protected"],
        vec!["clone", "owner/repo", "checkout"],
    ] {
        let out = sandbox
            .gm(&protected.origin, &protected.origin, &args)
            .env("GIT_CONFIG_COUNT", "1")
            .env(
                "GIT_CONFIG_KEY_0",
                format!("http.{}/owner/repo.git.followRedirects", protected.origin),
            )
            .env("GIT_CONFIG_VALUE_0", "true")
            .output()
            .unwrap();
        assert!(!out.status.success());
        assert!(!String::from_utf8_lossy(&out.stderr).contains("fixture-access-secret"));
    }
    assert_eq!(target.requests.load(Ordering::SeqCst), 0);
    assert_eq!(target.leaks.load(Ordering::SeqCst), 0);
}

#[test]
fn malformed_or_incomplete_access_fails_before_network_without_disclosing_value() {
    let sandbox = Sandbox::new();
    let server = Server::start(None, false, None);
    for token in [
        "",
        "fixture-access-secret",
        "{}",
        "{\"cf-access-client-id\":\"id\"}",
    ] {
        let out = sandbox
            .gm(
                &server.origin,
                &server.origin,
                &["api", "GET", "/protected"],
            )
            .env("GITMATRIX_ACCESS_TOKEN", token)
            .output()
            .unwrap();
        assert!(!out.status.success());
        assert!(!String::from_utf8_lossy(&out.stderr).contains("fixture-access-secret"));
    }
    for scope in [
        "http://example.com",
        "https://example.com/path",
        "https://*.example.com",
        "https://user@example.com",
        "https://example.com?query",
    ] {
        assert!(
            !sandbox
                .gm(&server.origin, scope, &["api", "GET", "/protected"])
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    assert!(
        !sandbox
            .gm(
                &server.origin,
                &server.origin,
                &["api", "GET", "/protected"]
            )
            .env_remove("GITMATRIX_ACCESS_ORIGIN")
            .output()
            .unwrap()
            .status
            .success()
    );
    assert_eq!(server.requests.load(Ordering::SeqCst), 0);
}
