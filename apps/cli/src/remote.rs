//! Talking to the Gitmatrix server: stored credentials, the JSON API, and
//! git's network commands with the token attached.

use crate::output::{GmError, Result, exit};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

pub const DEFAULT_SERVER: &str = "http://localhost:5180";

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Config {
    pub server: Option<String>,
    pub token: Option<String>,
    pub user: Option<String>,
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
        std::fs::read(config_path())
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> Result<()> {
        let path = config_path();
        std::fs::create_dir_all(path.parent().unwrap())?;
        std::fs::write(&path, serde_json::to_vec_pretty(self)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }

    /// GM_SERVER beats the stored server, which beats the dev default.
    pub fn server(&self) -> String {
        std::env::var("GM_SERVER")
            .ok()
            .or_else(|| self.server.clone())
            .unwrap_or_else(|| DEFAULT_SERVER.to_string())
            .trim_end_matches('/')
            .to_string()
    }

    pub fn token(&self) -> Option<String> {
        std::env::var("GM_TOKEN")
            .ok()
            .filter(|t| !t.is_empty())
            .or_else(|| self.token.clone())
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
    let url = format!("{}/api{}", config.server(), path);
    let agent = agent();
    let token = config.token();
    let auth = token.as_ref().map(|t| format!("Bearer {t}"));
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
            .hint(
                "Sign in: `gm auth login --persona <name>` (dev) or `gm auth login --token gmx_…`.",
            )
            .exit(exit::AUTH),
        403 => GmError::new("forbidden", message).exit(exit::AUTH),
        404 => GmError::not_found("not_found", message),
        409 => GmError::new("conflict", message).exit(exit::CONFLICT),
        _ => GmError::new("server_error", format!("HTTP {status}: {message}")),
    })
}

/// Run git with the stored token sent as a Bearer header to the server only,
/// passed through the environment so it never shows up in `ps`.
pub fn git(config: &Config, cwd: &Path, args: &[&str]) -> Result<std::process::Output> {
    let mut command = Command::new("git");
    command
        .current_dir(cwd)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0");
    let mut entries: Vec<(String, String)> = vec![
        // gm handles auth itself; never block on a credential prompt.
        ("credential.interactive".into(), "false".into()),
    ];
    if let Some(token) = config.token() {
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
    let output = command.output().map_err(|e| {
        GmError::new("git_missing", format!("Could not run git: {e}"))
            .hint("gm uses the git binary for network operations; install git.")
    })?;
    Ok(output)
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
        .hint("Sign in: `gm auth login --persona <name>` (dev) or `gm auth login --token gmx_…`.")
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
