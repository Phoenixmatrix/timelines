//! Talking to the Gitmatrix server: stored credentials, the JSON API, and
//! git's network commands with the token attached.

use crate::output::{GmError, Result, exit};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::VecDeque;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

pub const DEFAULT_SERVER: &str = "http://localhost:5180";

/// One server's sign-in, as stored in gm.json under `servers`.
#[derive(Serialize, Deserialize, Default, Clone, PartialEq)]
pub struct Credentials {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_key: Option<String>,
}

/// gm.json. Sign-ins are kept per server, so signing in to one (say,
/// production with GM_SERVER) never replaces another (the local dev server).
/// The flat fields are the sign-in of the server in use: `load` fills them
/// from `servers`, `save` writes them back there.
#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Config {
    /// The default server; GM_SERVER and GITMATRIX_URL override it.
    pub server: Option<String>,
    #[serde(default, skip_serializing)]
    pub token: Option<String>,
    #[serde(default, skip_serializing)]
    pub user: Option<String>,
    /// "ssh" to sign in with an SSH key for every session (see ssh.rs).
    #[serde(default, skip_serializing)]
    pub auth: Option<String>,
    /// Fingerprint of the SSH key to use; any registered key when unset.
    #[serde(default, skip_serializing)]
    pub ssh_key: Option<String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub servers: std::collections::BTreeMap<String, Credentials>,
}

fn normalize_server(server: &str) -> String {
    server.trim_end_matches('/').to_string()
}

fn config_path() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("gitmatrix").join("gm.json")
}

impl Config {
    pub fn load() -> Config {
        let mut config: Config = std::fs::read(config_path())
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let active = config.server();
        config.select(&active);
        config
    }

    /// Fill the flat fields with the sign-in of the server in use. A config
    /// from before per-server sign-ins keeps its flat fields for the server it
    /// was written for (the stored server, else the default).
    fn select(&mut self, active: &str) {
        let legacy = Credentials {
            token: self.token.take(),
            user: self.user.take(),
            auth: self.auth.take(),
            ssh_key: self.ssh_key.take(),
        };
        let legacy_server = normalize_server(self.server.as_deref().unwrap_or(DEFAULT_SERVER));
        if legacy != Credentials::default() && !self.servers.contains_key(&legacy_server) {
            self.servers.insert(legacy_server, legacy);
        }
        let current = self.servers.get(active).cloned().unwrap_or_default();
        self.token = current.token;
        self.user = current.user;
        self.auth = current.auth;
        self.ssh_key = current.ssh_key;
    }

    /// What gm.json holds: every server's sign-in, the one in use updated.
    fn stored(&self, active: &str) -> Config {
        let mut stored = self.clone();
        let current = Credentials {
            token: self.token.clone(),
            user: self.user.clone(),
            auth: self.auth.clone(),
            ssh_key: self.ssh_key.clone(),
        };
        if current == Credentials::default() {
            stored.servers.remove(active);
        } else {
            stored.servers.insert(active.to_string(), current);
        }
        stored
    }

    pub fn save(&self) -> Result<()> {
        let path = config_path();
        std::fs::create_dir_all(path.parent().unwrap())?;
        let stored = self.stored(&self.server());
        std::fs::write(&path, serde_json::to_vec_pretty(&stored)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }

    /// GM_SERVER beats GITMATRIX_URL (set in CI jobs), the stored server and
    /// the dev default.
    pub fn server(&self) -> String {
        env("GM_SERVER")
            .or_else(|| env("GITMATRIX_URL"))
            .or_else(|| self.server.clone())
            .unwrap_or_else(|| DEFAULT_SERVER.to_string())
            .trim_end_matches('/')
            .to_string()
    }

    pub fn token(&self) -> Option<String> {
        env_token().or_else(|| self.token.clone())
    }

    pub fn uses_ssh(&self) -> bool {
        self.auth.as_deref() == Some("ssh")
    }
}

/// The token to send: GM_TOKEN, else an SSH session (signing in when the
/// cached one is missing or ending), else the stored token. The flag says
/// whether it came from SSH.
pub fn credential(config: &Config) -> Result<(Option<String>, bool)> {
    if let Some(token) = env_token() {
        return Ok((Some(token), false));
    }
    if config.uses_ssh() {
        return Ok((Some(crate::ssh::session(config)?.token), true));
    }
    Ok((config.token.clone(), false))
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// GM_TOKEN, else GITMATRIX_TOKEN: inside a CI job, gm acts as the job.
fn env_token() -> Option<String> {
    env("GM_TOKEN").or_else(|| env("GITMATRIX_TOKEN"))
}

/// PUT raw bytes to a registry path (`/generic/<owner>/…`), as the signed-in user.
pub fn upload(config: &Config, path: &str, bytes: Vec<u8>) -> Result<Value> {
    let (token, _) = credential(config)?;
    let url = format!("{}{}", config.server(), path);
    let mut req = agent().put(&url);
    if let Some(t) = &token {
        req = req.header("authorization", &format!("Bearer {t}"));
    }
    let mut response = req.send(&bytes[..]).map_err(|e| {
        GmError::new(
            "server_unreachable",
            format!("Could not reach {}: {e}", config.server()),
        )
    })?;
    let status = response.status().as_u16();
    let text = response.body_mut().read_to_string().unwrap_or_default();
    let value: Value = serde_json::from_str(&text).unwrap_or(Value::String(text.clone()));
    if (200..300).contains(&status) {
        return Ok(value);
    }
    let message = value
        .get("errors")
        .and_then(|e| e.get(0))
        .and_then(|e| e.get("message"))
        .or_else(|| value.get("error"))
        .and_then(Value::as_str)
        .unwrap_or(text.trim())
        .to_string();
    Err(match status {
        401 => GmError::new("unauthenticated", message).exit(exit::AUTH),
        403 => GmError::new("forbidden", message).exit(exit::AUTH),
        409 => GmError::new("conflict", message).exit(exit::CONFLICT),
        _ => GmError::new("server_error", format!("HTTP {status}: {message}")),
    })
}

/// Fetch a registry artifact without following redirects or forwarding credentials.
pub fn artifact(
    config: &Config,
    path: &str,
    head: bool,
) -> Result<ureq::http::Response<ureq::Body>> {
    let url = format!("{}{}", config.server(), path);
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        .build()
        .into();
    let fetch = |token: Option<&str>| {
        let mut request = if head {
            agent.head(&url)
        } else {
            agent.get(&url)
        };
        if let Some(token) = token {
            request = request.header("authorization", &format!("Bearer {token}"));
        }
        request.call().map_err(|error| {
            GmError::new(
                "server_unreachable",
                format!("Could not fetch artifact: {error}"),
            )
        })
    };
    let (token, from_ssh) = credential(config)?;
    let mut response = fetch(token.as_deref())?;
    if response.status().as_u16() == 401 && from_ssh {
        crate::ssh::forget();
        response = fetch(Some(&crate::ssh::session(config)?.token))?;
    }
    match response.status().as_u16() {
        200 => Ok(response),
        401 => Err(
            GmError::new("unauthenticated", "Sign in to download this artifact.").exit(exit::AUTH),
        ),
        403 => Err(GmError::new("forbidden", "You cannot read this artifact.").exit(exit::AUTH)),
        404 => Err(GmError::not_found("not_found", "Artifact not found.")),
        status => Err(GmError::new(
            "artifact_response",
            format!(
                "Expected HTTP 200 for artifact, received {status}. Redirects are not followed."
            ),
        )),
    }
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build()
        .into()
}

/// Call the JSON API. Non-2xx responses become errors carrying the server's message.
pub fn api(config: &Config, method: &str, path: &str, body: Option<&Value>) -> Result<Value> {
    let (token, from_ssh) = credential(config)?;
    match api_with(config, method, path, body, token.as_deref()) {
        // The server ended the session early (key removed, server restarted):
        // sign in with the key again, once.
        Err(e) if from_ssh && e.code == "unauthenticated" => {
            crate::ssh::forget();
            let session = crate::ssh::session(config)?;
            api_with(config, method, path, body, Some(&session.token))
        }
        other => other,
    }
}

/// Call the JSON API with exactly this token (or none).
/// POST JSON and return the status and body as they are, errors included, for
/// protocols that answer with error bodies by design (OAuth device polling).
pub fn post_raw(config: &Config, path: &str, body: &Value) -> Result<(u16, Value)> {
    let url = format!("{}/api{}", config.server(), path);
    let mut response = agent().post(&url).send_json(body.clone()).map_err(|e| {
        GmError::new(
            "server_unreachable",
            format!("Could not reach {}: {e}", config.server()),
        )
    })?;
    let status = response.status().as_u16();
    let text = response.body_mut().read_to_string().unwrap_or_default();
    let value = serde_json::from_str(&text).unwrap_or(Value::String(text));
    Ok((status, value))
}

pub fn api_with(
    config: &Config,
    method: &str,
    path: &str,
    body: Option<&Value>,
    token: Option<&str>,
) -> Result<Value> {
    let url = format!("{}/api{}", config.server(), path);
    let agent = agent();
    let auth = token.map(|t| format!("Bearer {t}"));
    let unreachable = |e: ureq::Error| {
        GmError::new(
            "server_unreachable",
            format!("Could not reach {}: {e}", config.server()),
        )
        .hint(
            "Is the dev server running? Start it with `vp dev` in apps/website, or set GM_SERVER.",
        )
    };
    let mut response = match (method.to_uppercase().as_str(), body) {
        ("GET", _) | ("DELETE", None) => {
            let mut req = if method.eq_ignore_ascii_case("GET") {
                agent.get(&url)
            } else {
                agent.delete(&url)
            };
            if let Some(a) = &auth {
                req = req.header("authorization", a);
            }
            req.call().map_err(unreachable)?
        }
        (m, body) => {
            let mut req = match m {
                "POST" => agent.post(&url),
                "PUT" => agent.put(&url),
                "PATCH" => agent.patch(&url),
                "DELETE" => agent.delete(&url).force_send_body(),
                other => return Err(GmError::usage(format!("Unsupported HTTP method {other}."))),
            };
            if let Some(a) = &auth {
                req = req.header("authorization", a);
            }
            req.send_json(body.cloned().unwrap_or(Value::Object(Default::default())))
                .map_err(unreachable)?
        }
    };
    let status = response.status().as_u16();
    let text = response.body_mut().read_to_string().unwrap_or_default();
    let value: Value = if text.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text).unwrap_or(Value::String(text))
    };
    if (200..300).contains(&status) {
        return Ok(value);
    }
    let message = value
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("Request failed.")
        .to_string();
    Err(match status {
        401 => GmError::new("unauthenticated", message)
            .hint("Sign in: `gm auth login` (in the browser), or `--persona <name>` in dev.")
            .exit(exit::AUTH),
        403 => GmError::new("forbidden", message).exit(exit::AUTH),
        404 => GmError::not_found("not_found", message),
        409 => GmError::new("conflict", message).exit(exit::CONFLICT),
        _ => GmError::new("server_error", format!("HTTP {status}: {message}")),
    })
}

/// Run git with the stored token sent as a Bearer header to the server only,
/// passed through the environment so it never shows up in `ps`.
fn git_command(config: &Config, cwd: &Path, args: &[&str]) -> Result<Command> {
    let mut command = Command::new("git");
    command
        .current_dir(cwd)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0");
    let mut entries: Vec<(String, String)> = vec![
        // gm handles auth itself; never block on a credential prompt.
        ("credential.interactive".into(), "false".into()),
    ];
    if let Some(token) = credential(config)?.0 {
        entries.push((
            format!("http.{}/.extraHeader", config.server()),
            format!("Authorization: Bearer {token}"),
        ));
    }
    command.env("GIT_CONFIG_COUNT", entries.len().to_string());
    for (i, (key, value)) in entries.iter().enumerate() {
        command
            .env(format!("GIT_CONFIG_KEY_{i}"), key)
            .env(format!("GIT_CONFIG_VALUE_{i}"), value);
    }
    Ok(command)
}

pub fn git(config: &Config, cwd: &Path, args: &[&str]) -> Result<Output> {
    git_command(config, cwd, args)?
        .output()
        .map_err(git_missing)
}

fn git_missing(error: std::io::Error) -> GmError {
    GmError::new("git_missing", format!("Could not run git: {error}"))
        .hint("gm uses the git binary for network operations; install git.")
}

/// Clone's stdout belongs to gm's result, not git. Drain progress as it arrives,
/// retaining bounded diagnostics for the normal network-error classification.
pub fn git_progress(
    config: &Config,
    cwd: &Path,
    args: &[&str],
    mut report: impl FnMut(&str),
) -> Result<Output> {
    let mut child = git_command(config, cwd, args)?
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(git_missing)?;
    let stderr = read_git_progress(child.stderr.take().expect("piped stderr"), &mut report);
    if stderr.is_err() {
        let _ = child.kill();
    }
    let status = child.wait()?;
    Ok(Output {
        status,
        stdout: Vec::new(),
        stderr: stderr?,
    })
}

fn read_git_progress(
    mut reader: impl Read,
    report: &mut impl FnMut(&str),
) -> std::io::Result<Vec<u8>> {
    const DIAGNOSTICS: usize = 64 * 1024;
    const RECORD: usize = 8 * 1024;
    let mut diagnostics = VecDeque::with_capacity(DIAGNOSTICS);
    let mut record = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let bytes = &buffer[..count];
        let overflow = (diagnostics.len() + count).saturating_sub(DIAGNOSTICS);
        diagnostics.drain(..overflow);
        diagnostics.extend(bytes);
        // Git redraws progress with CR; diagnostics use LF. Neither should wait
        // for the other delimiter or for the process to finish.
        for part in bytes.split_inclusive(|b| *b == b'\r' || *b == b'\n') {
            record.extend_from_slice(part);
            if matches!(part.last(), Some(b'\r' | b'\n')) || record.len() >= RECORD {
                let text = String::from_utf8_lossy(&record);
                let text = text.trim();
                if !text.is_empty() {
                    report(text);
                }
                record.clear();
            }
        }
    }
    if !record.is_empty() {
        report(String::from_utf8_lossy(&record).trim());
    }
    Ok(diagnostics.into())
}

/// Turn a failed git network command into a useful error.
pub fn git_failure(action: &str, output: &std::process::Output) -> GmError {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let remote: Vec<&str> = stderr
        .lines()
        .filter_map(|l| l.strip_prefix("remote: "))
        .collect();
    let detail = if remote.is_empty() {
        stderr.trim().lines().last().unwrap_or("").to_string()
    } else {
        remote.join(" ")
    };
    if stderr.contains("non-fast-forward")
        || stderr.contains("fetch first")
        || stderr.contains("stale info")
    {
        return GmError::new(
            "remote_moved",
            format!("{action} was rejected: the remote has commits you don't have."),
        )
        .hint("Run `gm sync` (or `gm push --sync`) and try again.")
        .exit(exit::CONFLICT);
    }
    if stderr.contains("Authentication failed")
        || stderr.contains("terminal prompts disabled")
        || stderr.contains("could not read Username")
        || stderr.contains("401")
    {
        return GmError::new(
            "unauthenticated",
            format!("{action} failed: not signed in. {detail}"),
        )
        .hint("Sign in: `gm auth login` (in the browser), or `--persona <name>` in dev.")
        .exit(exit::AUTH);
    }
    if stderr.contains("403")
        || detail.contains("does not have write access")
        || detail.contains("read-only")
    {
        return GmError::new("forbidden", format!("{action} was refused: {detail}"))
            .exit(exit::AUTH);
    }
    if stderr.contains("not found") {
        return GmError::not_found("repository_not_found", format!("{action} failed: {detail}"));
    }
    if stderr.contains("Could not resolve host")
        || stderr.contains("Failed to connect")
        || stderr.contains("Couldn't connect")
    {
        return GmError::new("server_unreachable", format!("{action} failed: {detail}"))
            .hint("Is the Gitmatrix dev server running (`vp dev` in apps/website)?");
    }
    GmError::new(
        "git_failed",
        format!(
            "{action} failed: {}",
            if detail.is_empty() {
                stderr.trim().to_string()
            } else {
                detail
            }
        ),
    )
}

#[cfg(test)]
mod progress_tests {
    use super::read_git_progress;
    use std::io::{Cursor, Read};

    struct Fragmented(Cursor<Vec<u8>>);

    impl Read for Fragmented {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            self.0.read(&mut buffer[..1])
        }
    }

    #[test]
    fn streams_carriage_returns_newlines_and_unterminated_diagnostics() {
        let bytes = b"Receiving objects: 1% (1/100)\rReceiving objects: 100% (100/100)\r\nfatal: lost connection".to_vec();
        let mut records = Vec::new();
        let diagnostics = read_git_progress(Fragmented(Cursor::new(bytes.clone())), &mut |s| {
            records.push(s.to_owned());
        })
        .unwrap();
        assert_eq!(
            records,
            [
                "Receiving objects: 1% (1/100)",
                "Receiving objects: 100% (100/100)",
                "fatal: lost connection",
            ]
        );
        assert_eq!(diagnostics, bytes);
    }

    #[test]
    fn bounds_retained_output_without_losing_final_failure() {
        let mut bytes = vec![b'x'; 128 * 1024];
        bytes.extend_from_slice(b"\nfatal: Authentication failed\n");
        let mut largest = 0;
        let mut last = String::new();
        let diagnostics = read_git_progress(Cursor::new(&bytes), &mut |s| {
            largest = largest.max(s.len());
            last = s.to_owned();
        })
        .unwrap();
        assert!(largest <= 12 * 1024);
        assert_eq!(last, "fatal: Authentication failed");
        assert_eq!(diagnostics, bytes[bytes.len() - 64 * 1024..]);
    }
}

#[cfg(test)]
mod config_tests {
    use super::*;

    fn loaded(json: &str, active: &str) -> Config {
        let mut config: Config = serde_json::from_str(json).unwrap();
        config.select(active);
        config
    }

    #[test]
    fn a_flat_config_belongs_to_the_server_it_was_written_for() {
        let json = r#"{"server":null,"token":"gmx_local","user":"priya"}"#;
        let local = loaded(json, DEFAULT_SERVER);
        assert_eq!(local.token.as_deref(), Some("gmx_local"));
        let prod = loaded(json, "https://gitmatrix.example");
        assert_eq!(prod.token, None);
    }

    #[test]
    fn signing_in_to_one_server_keeps_the_others() {
        let json = r#"{"server":null,"token":"gmx_local","user":"priya"}"#;
        let prod_server = "https://gitmatrix.example";
        let mut prod = loaded(json, prod_server);
        prod.token = Some("gmx_prod".into());
        prod.user = Some("fward".into());
        let stored = prod.stored(prod_server);
        let text = serde_json::to_string(&stored).unwrap();
        // Flat fields are never written; each sign-in sits under its server.
        let value: Value = serde_json::from_str(&text).unwrap();
        assert!(value.get("token").is_none() && value.get("user").is_none());
        let again: Config = serde_json::from_str(&text).unwrap();
        assert_eq!(
            loaded(&text, DEFAULT_SERVER).token.as_deref(),
            Some("gmx_local")
        );
        assert_eq!(loaded(&text, prod_server).user.as_deref(), Some("fward"));
        assert_eq!(again.token, None);
    }

    #[test]
    fn signing_out_clears_only_the_server_in_use() {
        let json = r#"{"servers":{"http://localhost:5180":{"token":"a"},"https://gitmatrix.example":{"token":"b"}}}"#;
        let mut prod = loaded(json, "https://gitmatrix.example");
        prod.token = None;
        let text = serde_json::to_string(&prod.stored("https://gitmatrix.example")).unwrap();
        assert_eq!(loaded(&text, DEFAULT_SERVER).token.as_deref(), Some("a"));
        assert_eq!(loaded(&text, "https://gitmatrix.example").token, None);
    }
}
