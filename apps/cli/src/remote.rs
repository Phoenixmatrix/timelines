//! Talking to the Timelines server: stored credentials, the JSON API, and
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
    /// Tokens of your agents set up on this machine (`gm agent setup`), by name.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub agents: std::collections::BTreeMap<String, String>,
}

/// Whose token a request uses.
#[derive(Clone, Default, PartialEq)]
pub enum Acting {
    /// GM_TOKEN, else this checkout's agent when a harness drives gm, else you.
    #[default]
    Auto,
    /// GM_TOKEN, else you: managing agents is a person's job.
    Person,
    /// Exactly this token.
    Token(String),
}

/// Who a request acts as. Recorded with each lease gm keeps, so work started
/// under one identity is finished under it after gm switches (say, when a
/// checkout gets its own agent); new work always uses the current one.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Identity {
    /// The signed-in person (a stored token or SSH key).
    Person,
    /// One of the person's agents, by name; its token is kept in gm.json.
    Agent { name: String },
    /// GM_TOKEN (or GITMATRIX_TOKEN): usable again only while it's set.
    Env,
}

impl Identity {
    pub fn describe(&self) -> String {
        match self {
            Identity::Person => "you".into(),
            Identity::Agent { name } => format!("your agent {name}"),
            Identity::Env => "GM_TOKEN".into(),
        }
    }
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
    #[serde(skip)]
    pub acting: Acting,
}

fn normalize_server(server: &str) -> String {
    server.trim_end_matches('/').to_string()
}

/// gm's per-user configuration directory: $XDG_CONFIG_HOME/gitmatrix, else ~/.config/gitmatrix.
pub fn config_dir() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("gitmatrix")
}

fn config_path() -> PathBuf {
    config_dir().join("gm.json")
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
            agents: Default::default(),
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
            agents: self.agent_tokens().clone(),
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

    pub fn token(&self) -> Result<Option<String>> {
        if let Acting::Token(token) = &self.acting {
            return Ok(Some(token.clone()));
        }
        if let Some(token) = env_token() {
            return Ok(Some(token));
        }
        Ok(self.agent_token()?.or_else(|| self.token.clone()))
    }

    /// Your agents' tokens on the server in use.
    pub fn agent_tokens(&self) -> &std::collections::BTreeMap<String, String> {
        static EMPTY: std::collections::BTreeMap<String, String> =
            std::collections::BTreeMap::new();
        self.servers
            .get(&self.server())
            .map_or(&EMPTY, |c| &c.agents)
    }

    pub fn set_agent_token(&mut self, name: &str, token: String) {
        let server = self.server();
        self.servers
            .entry(server)
            .or_default()
            .agents
            .insert(name.to_string(), token);
    }

    /// The token this request acts with when not GM_TOKEN: an explicit one, or
    /// this checkout's agent when a harness drives gm (`gm agent setup`). An
    /// agent the checkout names but this machine holds no token for gets one
    /// now, so its work is never quietly attributed to its person.
    fn agent_token(&self) -> Result<Option<String>> {
        match &self.acting {
            Acting::Token(token) => Ok(Some(token.clone())),
            Acting::Person => Ok(None),
            Acting::Auto => match crate::profile::acting_agent() {
                None => Ok(None),
                Some(name) => match self.agent_tokens().get(&name) {
                    Some(token) => Ok(Some(token.clone())),
                    None => provision_agent(self, &name),
                },
            },
        }
    }

    /// The identity requests use now.
    pub fn identity(&self) -> Result<Identity> {
        if matches!(self.acting, Acting::Token(_)) || env_token().is_some() {
            return Ok(Identity::Env);
        }
        if matches!(self.acting, Acting::Auto)
            && let Some(name) = crate::profile::acting_agent()
            && self.agent_token()?.is_some()
        {
            return Ok(Identity::Agent { name });
        }
        Ok(Identity::Person)
    }

    /// The identity requests would use, without provisioning: None when the
    /// checkout names an agent this machine holds no token for yet.
    pub fn known_identity(&self) -> Option<Identity> {
        if matches!(self.acting, Acting::Token(_)) || env_token().is_some() {
            return Some(Identity::Env);
        }
        if matches!(self.acting, Acting::Auto)
            && let Some(name) = crate::profile::acting_agent()
        {
            return self
                .agent_tokens()
                .contains_key(&name)
                .then_some(Identity::Agent { name });
        }
        Some(Identity::Person)
    }

    /// This configuration, acting as `identity` instead.
    pub fn acting_as(&self, identity: &Identity) -> Result<Config> {
        let mut config = self.clone();
        match identity {
            Identity::Person => config.acting = Acting::Person,
            Identity::Agent { name } => {
                let token = self.agent_tokens().get(name).cloned().ok_or_else(|| {
                    GmError::new(
                        "identity_gone",
                        format!("This lease was taken as your agent {name}, whose token is no longer on this machine."),
                    )
                    .hint("Run `gm agent setup --name NAME` to restore it, or ask a tracker owner to `gm issue claim --force`.")
                    .exit(exit::AUTH)
                })?;
                config.acting = Acting::Token(token);
            }
            Identity::Env => {
                if env_token().is_none() {
                    return Err(GmError::new(
                        "identity_gone",
                        "This lease was taken with GM_TOKEN, which isn't set now.",
                    )
                    .hint("Set GM_TOKEN to that token again, or pass --lease-token.")
                    .exit(exit::AUTH));
                }
            }
        }
        Ok(config)
    }

    pub fn uses_ssh(&self) -> bool {
        self.auth.as_deref() == Some("ssh")
    }
}

/// What `gm agent setup` does for its identity, on the first command that
/// needs it: with its person's sign-in, find or create this checkout's agent,
/// mint it a token and keep it with gm's credentials. None when nobody is
/// signed in, as there is no person to act for.
fn provision_agent(config: &Config, name: &str) -> Result<Option<String>> {
    use std::sync::{Mutex, OnceLock};
    // One process may look the token up many times; mint it once.
    static MINTED: OnceLock<Mutex<std::collections::BTreeMap<String, String>>> = OnceLock::new();
    let minted = MINTED.get_or_init(Default::default);
    let key = format!("{}\u{0}{name}", config.server());
    if let Some(token) = minted.lock().ok().and_then(|m| m.get(&key).cloned()) {
        return Ok(Some(token));
    }
    let mut person = config.clone();
    person.acting = Acting::Person;
    if person.token.is_none() && !person.uses_ssh() {
        return Ok(None);
    }
    let agents = api(&person, "GET", "/agents", None)?["agents"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let agent = match agents.into_iter().find(|a| a["name"] == name) {
        Some(agent) if !agent["revokedAt"].is_null() => {
            return Err(GmError::new(
                "revoked",
                format!("This checkout's agent {name} was revoked."),
            )
            .hint("Name another agent in .gitmatrix/agent.local.yml, then run `gm agent setup`.")
            .exit(exit::AUTH));
        }
        Some(agent) => agent,
        None => api(
            &person,
            "POST",
            "/agents",
            Some(&serde_json::json!({ "name": name })),
        )?["agent"]
            .clone(),
    };
    let id = agent["id"].as_str().unwrap_or_default();
    let label = format!("gm on {}", chrono::Utc::now().format("%Y-%m-%d"));
    let secret = api(
        &person,
        "POST",
        &format!("/agents/{id}/tokens"),
        Some(&serde_json::json!({ "name": label, "scope": "write" })),
    )?["secret"]
        .as_str()
        .ok_or_else(|| GmError::new("protocol_error", "The server didn't return a token."))?
        .to_string();
    let mut kept = config.clone();
    kept.set_agent_token(name, secret.clone());
    kept.save()?;
    if let Ok(mut m) = minted.lock() {
        m.insert(key, secret.clone());
    }
    eprintln!(
        "gm: acting as your agent {name}; it had no token on this machine, so gm minted one (`gm agent setup` also publishes its profile)."
    );
    Ok(Some(secret))
}

/// The token to send: GM_TOKEN, else this checkout's agent, else an SSH
/// session (signing in when the cached one is missing or ending), else the
/// stored token. The flag says whether it came from SSH.
pub fn credential(config: &Config) -> Result<(Option<String>, bool)> {
    // An explicit token (a lease's recorded identity, a probe) is exactly who acts.
    if let Acting::Token(token) = &config.acting {
        return Ok((Some(token.clone()), false));
    }
    if let Some(token) = env_token() {
        return Ok((Some(token), false));
    }
    if let Some(token) = config.agent_token()? {
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
    let mut req = agent(&url, false)?.put(&url);
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
        409 if value.get("code").and_then(Value::as_str) == Some("requirements_unmet") => {
            requirements_unmet(message)
        }
        409 => GmError::new("conflict", message).exit(exit::CONFLICT),
        // A tracker change feed pruned past the replica's cursor: start over.
        410 if value.get("code").and_then(Value::as_str) == Some("cursor_expired") => {
            GmError::new("cursor_expired", message)
        }
        _ => GmError::new("server_error", format!("HTTP {status}: {message}")),
    })
}

/// An agent refused an issue it doesn't meet the requirements of (CORE-32); the
/// message lists each unmet requirement.
fn requirements_unmet(message: String) -> GmError {
    GmError::new("requirements_unmet", message)
        .exit(exit::CONFLICT)
        .hint("See what it needs with `gm issue show <key>`; publish this agent's capabilities with `gm agent setup` (e.g. --tag ux); or a person can claim it, or assign it to this agent.")
}

/// Fetch a registry artifact without following redirects or forwarding credentials.
pub fn artifact(
    config: &Config,
    path: &str,
    head: bool,
) -> Result<ureq::http::Response<ureq::Body>> {
    let url = format!("{}{}", config.server(), path);
    let agent = agent(&url, true)?;
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

// Provenance hint only: authentication still comes from the credential.
fn cli_source(
    mut request: ureq::http::Request<ureq::SendBody>,
    next: ureq::middleware::MiddlewareNext,
) -> std::result::Result<ureq::http::Response<ureq::Body>, ureq::Error> {
    request.headers_mut().insert(
        "x-gitmatrix-source",
        ureq::http::HeaderValue::from_static("cli"),
    );
    // App JSON contracts are versioned; native Git and registry paths are not.
    if request.uri().path().starts_with("/api/") {
        request.headers_mut().insert(
            "x-gitmatrix-content-version",
            ureq::http::HeaderValue::from_static("4"),
        );
    }
    next.handle(request)
}

// Access credentials are deliberately not part of Config: they belong only to
// this process and one explicitly named origin.
struct Access {
    origin: String,
    client_id: ureq::http::HeaderValue,
    client_secret: ureq::http::HeaderValue,
}

fn access_error() -> GmError {
    GmError::usage(
        "Set both GITMATRIX_ACCESS_TOKEN (JSON with nonempty cf-access-client-id and cf-access-client-secret strings) and GITMATRIX_ACCESS_ORIGIN (an exact HTTPS origin; HTTP is allowed only on localhost).",
    )
}

fn origin(url: &str) -> Option<String> {
    let uri: ureq::http::Uri = url.parse().ok()?;
    let scheme = uri.scheme_str()?;
    let authority = uri.authority()?;
    let host = authority.host().to_ascii_lowercase();
    if authority.as_str().contains('@')
        || host.contains('*')
        || !matches!(scheme, "https" | "http")
        || (scheme == "http" && !matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]"))
    {
        return None;
    }
    let port = authority
        .port_u16()
        .unwrap_or(if scheme == "https" { 443 } else { 80 });
    let authority_text = authority.as_str().to_ascii_lowercase();
    if authority_text != host && authority_text != format!("{host}:{port}") {
        return None;
    }
    Some(format!("{scheme}://{host}:{port}"))
}

impl Access {
    fn load() -> Result<Option<Self>> {
        let token = std::env::var_os("GITMATRIX_ACCESS_TOKEN");
        let scoped = std::env::var_os("GITMATRIX_ACCESS_ORIGIN");
        let (token, scoped) = match (token, scoped) {
            (None, None) => return Ok(None),
            (Some(token), Some(scoped)) => (
                token.into_string().map_err(|_| access_error())?,
                scoped.into_string().map_err(|_| access_error())?,
            ),
            _ => return Err(access_error()),
        };
        let uri: ureq::http::Uri = scoped.parse().map_err(|_| access_error())?;
        if uri.path() != "/" || uri.query().is_some() || scoped.contains('#') {
            return Err(access_error());
        }
        let origin = origin(&scoped).ok_or_else(access_error)?;
        let value: Value = serde_json::from_str(&token).map_err(|_| access_error())?;
        let object = value.as_object().ok_or_else(access_error)?;
        if object.len() != 2
            || ["cf-access-client-id", "cf-access-client-secret"]
                .iter()
                .any(|key| {
                    object
                        .get(*key)
                        .and_then(Value::as_str)
                        .is_none_or(|v| v.trim().is_empty())
                })
        {
            return Err(access_error());
        }
        let header = |key: &str| -> Result<ureq::http::HeaderValue> {
            let mut header =
                ureq::http::HeaderValue::from_str(object[key].as_str().ok_or_else(access_error)?)
                    .map_err(|_| access_error())?;
            header.set_sensitive(true);
            Ok(header)
        };
        Ok(Some(Self {
            origin,
            client_id: header("cf-access-client-id")?,
            client_secret: header("cf-access-client-secret")?,
        }))
    }
}

/// How long gm waits to reach the server (name lookup, then connecting), so a
/// dropped network fails instead of hanging.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
/// How long gm waits for a response to start, so a stuck request ends with an
/// error instead of a hang. Writes can take a while (forking a timeline's
/// sources); reads less so. Streams count only until their headers arrive.
const RESPONSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);
#[cfg(not(test))]
const READ_RESPONSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
#[cfg(test)]
const READ_RESPONSE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(300);
/// Waits before retrying a read that failed in transit or met a gateway error:
/// Cloudflare in front of the server is sometimes briefly unavailable. Writes
/// are never retried here, since a lost reply doesn't mean nothing happened.
#[cfg(not(test))]
const READ_RETRY_DELAYS: [std::time::Duration; 2] = [
    std::time::Duration::from_millis(500),
    std::time::Duration::from_secs(2),
];
#[cfg(test)]
const READ_RETRY_DELAYS: [std::time::Duration; 2] = [
    std::time::Duration::from_millis(10),
    std::time::Duration::from_millis(20),
];

/// A gateway that couldn't reach the server, or a server briefly unavailable.
fn retryable_status(status: u16) -> bool {
    matches!(status, 502..=504)
}

/// A failure in transit: no answer came, so asking again is safe for a read.
/// A timeout isn't one: the server may still be working on the request, and
/// asking again only adds to its load.
fn retryable_error(error: &ureq::Error) -> bool {
    matches!(
        error,
        ureq::Error::Io(_) | ureq::Error::HostNotFound | ureq::Error::ConnectionFailed
    )
}

/// GET `url`, retrying failures in transit and gateway errors after
/// READ_RETRY_DELAYS; the last attempt's answer or error is returned.
fn get_with_retries(
    agent: &ureq::Agent,
    url: &str,
    auth: Option<&str>,
) -> std::result::Result<ureq::http::Response<ureq::Body>, ureq::Error> {
    let mut delays = READ_RETRY_DELAYS.iter();
    loop {
        let mut req = agent
            .get(url)
            .config()
            .timeout_recv_response(Some(READ_RESPONSE_TIMEOUT))
            .build();
        if let Some(a) = auth {
            req = req.header("authorization", a);
        }
        let outcome = req.call();
        let retry = match &outcome {
            Ok(response) => retryable_status(response.status().as_u16()),
            Err(error) => retryable_error(error),
        };
        match delays.next() {
            Some(delay) if retry => std::thread::sleep(*delay),
            _ => return outcome,
        }
    }
}

fn agent(url: &str, no_redirects: bool) -> Result<ureq::Agent> {
    let access = Access::load()?.filter(|access| origin(url).as_deref() == Some(&access.origin));
    let protected = access.is_some();
    let mut builder = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_resolve(Some(CONNECT_TIMEOUT))
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .timeout_recv_response(Some(RESPONSE_TIMEOUT))
        .middleware(cli_source);
    if let Some(access) = access {
        builder = builder.middleware(
            move |mut request: ureq::http::Request<ureq::SendBody>,
                  next: ureq::middleware::MiddlewareNext| {
                request
                    .headers_mut()
                    .insert("cf-access-client-id", access.client_id.clone());
                request
                    .headers_mut()
                    .insert("cf-access-client-secret", access.client_secret.clone());
                next.handle(request)
            },
        );
    }
    // ureq must never replay a custom credential on a redirect. Protected
    // requests require the canonical endpoint, including same-origin redirects.
    if protected || no_redirects {
        builder = builder.max_redirects(0);
    }
    Ok(builder.build().into())
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

/// Resolve the persisted personal default through the authorized Space directory.
/// A person's slug is never a content scope.
pub fn default_space(config: &Config) -> Result<String> {
    let session = api(config, "GET", "/session", None)?;
    default_space_from_viewer(&session["viewer"])
}

fn default_space_from_viewer(viewer: &Value) -> Result<String> {
    let id = viewer["defaultSpaceId"]
        .as_str()
        .ok_or_else(|| GmError::usage("No default Space is available; pass --space <handle>."))?;
    viewer["spaces"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|space| space["id"].as_str() == Some(id))
        .and_then(|space| space["slug"].as_str())
        .filter(|slug| !slug.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            GmError::usage("Your default Space is not accessible; pass --space <handle>.")
        })
}

/// Call the JSON API with exactly this token (or none).
/// POST JSON and return the status and body as they are, errors included, for
/// protocols that answer with error bodies by design (OAuth device polling).
pub fn post_raw(config: &Config, path: &str, body: &Value) -> Result<(u16, Value)> {
    let url = format!("{}/api{}", config.server(), path);
    let mut response = agent(&url, false)?
        .post(&url)
        .send_json(body.clone())
        .map_err(|e| {
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
    api_at(&config.server(), method, path, body, token)
}

/// `api_with` against exactly `server`.
fn api_at(
    server: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
    token: Option<&str>,
) -> Result<Value> {
    let url = format!("{server}/api{path}");
    let agent = agent(&url, false)?;
    let auth = token.map(|t| format!("Bearer {t}"));
    let unreachable = |e: ureq::Error| match e {
        ureq::Error::Timeout(_) => GmError::new(
            "server_timeout",
            format!("{server} didn't answer in time: {e}"),
        )
        .hint("The server is slow or stuck; try again shortly."),
        e => GmError::new(
            "server_unreachable",
            format!("Could not reach {server}: {e}"),
        )
        .hint(
            "Is the dev server running? Start it with `vp dev` in apps/website, or set GM_SERVER.",
        ),
    };
    let response = match (method.to_uppercase().as_str(), body) {
        ("GET", _) => get_with_retries(&agent, &url, auth.as_deref()).map_err(unreachable)?,
        ("DELETE", None) => {
            let mut req = agent.delete(&url);
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
    reply(response)
}

/// A JSON API reply: the body, or the server's error.
fn reply(mut response: ureq::http::Response<ureq::Body>) -> Result<Value> {
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
    Err(status_error(status, &value))
}

/// GET `path` once, giving up after `wait`: for hooks that run inside an
/// agent's tool calls, where a slow or unreachable server must never hold the
/// agent up (no read retries, no long timeouts).
pub fn get_briefly(config: &Config, path: &str, wait: std::time::Duration) -> Result<Value> {
    let (token, _) = credential(config)?;
    let server = config.server();
    let url = format!("{server}/api{path}");
    let mut req = agent(&url, false)?
        .get(&url)
        .config()
        .timeout_global(Some(wait))
        .build();
    if let Some(token) = token {
        req = req.header("authorization", format!("Bearer {token}"));
    }
    let response = req.call().map_err(|e| {
        GmError::new(
            "server_unreachable",
            format!("Could not reach {server}: {e}"),
        )
    })?;
    reply(response)
}

/// POST JSON and hand each line of the streamed response to `on_line` as it
/// arrives (newline-delimited JSON, e.g. `gm ask`).
pub fn stream_lines(
    config: &Config,
    path: &str,
    body: &Value,
    mut on_line: impl FnMut(&str) -> Result<()>,
) -> Result<()> {
    use std::io::BufRead;
    let (token, _) = credential(config)?;
    let url = format!("{}/api{}", config.server(), path);
    let mut req = agent(&url, false)?.post(&url);
    if let Some(t) = &token {
        req = req.header("authorization", format!("Bearer {t}"));
    }
    let mut response = req.send_json(body.clone()).map_err(|e| {
        GmError::new(
            "server_unreachable",
            format!("Could not reach {}: {e}", config.server()),
        )
    })?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let text = response.body_mut().read_to_string().unwrap_or_default();
        let value = serde_json::from_str(&text).unwrap_or(Value::String(text));
        return Err(status_error(status, &value));
    }
    let reader = std::io::BufReader::new(response.body_mut().as_reader());
    for line in reader.lines() {
        let line = line.map_err(|e| {
            GmError::new("stream_interrupted", format!("The response stopped: {e}"))
        })?;
        if !line.trim().is_empty() {
            on_line(&line)?;
        }
    }
    Ok(())
}

/// GET a streamed API response and hand over every line as it arrives, blank
/// ones included (Server-Sent Events separate events with them). Returns when
/// the server ends the stream.
pub fn stream_get(
    config: &Config,
    path: &str,
    mut on_line: impl FnMut(&str) -> Result<()>,
) -> Result<()> {
    use std::io::BufRead;
    let (token, _) = credential(config)?;
    let url = format!("{}/api{}", config.server(), path);
    let mut req = agent(&url, false)?
        .get(&url)
        .header("accept", "text/event-stream");
    if let Some(t) = &token {
        req = req.header("authorization", format!("Bearer {t}"));
    }
    let mut response = req.call().map_err(|e| {
        GmError::new(
            "server_unreachable",
            format!("Could not reach {}: {e}", config.server()),
        )
    })?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let text = response.body_mut().read_to_string().unwrap_or_default();
        let value = serde_json::from_str(&text).unwrap_or(Value::String(text));
        return Err(status_error(status, &value));
    }
    let reader = std::io::BufReader::new(response.body_mut().as_reader());
    for line in reader.lines() {
        let line = line.map_err(|e| {
            GmError::new("stream_interrupted", format!("The response stopped: {e}"))
        })?;
        on_line(&line)?;
    }
    Ok(())
}

/// A non-2xx API response as an error carrying the server's message.
fn status_error(status: u16, value: &Value) -> GmError {
    let message = value
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("Request failed.")
        .to_string();
    match status {
        401 => GmError::new("unauthenticated", message)
            .hint("Sign in: `gm auth login` (in the browser), or `--persona <name>` in dev.")
            .exit(exit::AUTH),
        403 => GmError::new("forbidden", message).exit(exit::AUTH),
        410 if value.get("code").and_then(Value::as_str) == Some("source_expired") => {
            GmError::new("source_expired", message)
                .hint("Source retention expired. Local work remains; recover it explicitly into a new timeline.")
        }
        409 if value.get("code").and_then(Value::as_str) == Some("source_migration_required") => {
            GmError::new("source_migration_required", message)
                .hint("Run `gm timeline migrate`, then renew checkpoint and approval.")
                .exit(exit::CONFLICT)
        }
        409 if value.get("code").and_then(Value::as_str) == Some("source_busy") => {
            GmError::new("source_busy", message)
                .hint("Inspect `gm timeline pushes`; retry recovery with the same exact operation ID. Do not force-push.")
                .exit(exit::CONFLICT)
        }
        // Retention (CORE-203) says when and why it removed an issue or timeline.
        404 if value.get("code").and_then(Value::as_str) == Some("removed_by_retention") => {
            GmError::not_found("removed_by_retention", message)
        }
        404 => GmError::not_found("not_found", message),
        409 if value.get("code").and_then(Value::as_str) == Some("requirements_unmet") => {
            requirements_unmet(message)
        }
        409 => GmError::new("conflict", message).exit(exit::CONFLICT),
        // A tracker change feed pruned past the replica's cursor: start over.
        410 if value.get("code").and_then(Value::as_str) == Some("cursor_expired") => {
            GmError::new("cursor_expired", message)
        }
        _ => GmError::new("server_error", format!("HTTP {status}: {message}")),
    }
}

fn hide_git_access(command: &mut Command) {
    command.env_remove("GIT_CONFIG_PARAMETERS");
    command.env_remove("GITMATRIX_ACCESS_TOKEN");
    // Git/curl traces can print arbitrary custom headers and config values.
    for (name, _) in std::env::vars_os() {
        if name
            .to_str()
            .is_some_and(|name| name.starts_with("GIT_TRACE") || name == "GIT_CURL_VERBOSE")
        {
            command.env_remove(name);
        }
    }
    for name in ["GIT_TRACE2", "GIT_TRACE2_EVENT", "GIT_TRACE2_PERF"] {
        command.env(name, "0");
    }
}

/// Run git with the stored token sent as a Bearer header to the server only,
/// passed through the environment so it never shows up in `ps`.
fn git_command(config: &Config, cwd: &Path, args: &[&str]) -> Result<Command> {
    let access = Access::load()?;
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
    if let Some(access) = access {
        hide_git_access(&mut command);
        let mut inspect = Command::new("git");
        hide_git_access(&mut inspect);
        let redirect_keys = inspect
            .current_dir(cwd)
            .args([
                "config",
                "--name-only",
                "--get-regexp",
                r"^http\..*followredirects$",
            ])
            .output()
            .map_err(git_missing)?;
        if !redirect_keys.status.success() && redirect_keys.status.code() != Some(1) {
            return Err(GmError::usage(
                "Could not inspect Git redirect configuration safely.",
            ));
        }
        for key in String::from_utf8_lossy(&redirect_keys.stdout).lines() {
            entries.push((key.to_owned(), "false".into()));
        }
        entries.push((
            format!("http.{}/.extraHeader", access.origin),
            format!(
                "CF-Access-Client-Id: {}",
                access.client_id.to_str().map_err(|_| access_error())?
            ),
        ));
        entries.push((
            format!("http.{}/.extraHeader", access.origin),
            format!(
                "CF-Access-Client-Secret: {}",
                access.client_secret.to_str().map_err(|_| access_error())?
            ),
        ));
        // Git scopes extraHeader to the initial URL, not redirect targets.
        // Override existing URL-specific redirect rules too: Git gives them
        // precedence over the unscoped setting regardless of config source.
        entries.push(("http.followRedirects".into(), "false".into()));
        entries.push((
            format!("http.{}/.followRedirects", access.origin),
            "false".into(),
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

/// HTTP status numbers are meaningful only in Git's diagnostic records, not
/// object counts, transfer rates or repository URLs retained with progress.
fn has_http_error(stderr: &str, status: &str) -> bool {
    stderr.split(['\r', '\n']).any(|line| {
        if !line.starts_with("fatal: ") && !line.starts_with("error: ") {
            return false;
        }
        line.split_once("The requested URL returned error: ")
            .or_else(|| line.split_once("RPC failed; HTTP "))
            .is_some_and(|(_, detail)| detail.split_ascii_whitespace().next() == Some(status))
    })
}

/// Only emit recognized transport facts, never URLs, remote bodies or trace text.
fn git_diagnostic(stderr: &str) -> String {
    let mut facts = Vec::new();
    for line in stderr.split(['\r', '\n']) {
        if !line.starts_with("fatal: ") && !line.starts_with("error: ") {
            continue;
        }
        if let Some((_, detail)) = line
            .split_once("The requested URL returned error: ")
            .or_else(|| line.split_once("RPC failed; HTTP "))
            && let Some(status) = detail.split_ascii_whitespace().next()
            && status.len() == 3
            && status.bytes().all(|b| b.is_ascii_digit())
            && matches!(status.as_bytes()[0], b'4' | b'5')
        {
            let fact = format!("HTTP {status}");
            if !facts.contains(&fact) {
                facts.push(fact);
            }
        }
        for fact in [
            "early EOF",
            "Could not resolve host",
            "Failed to connect",
            "Couldn't connect",
            "Connection timed out",
            "Operation timed out",
            "Connection reset by peer",
            "SSL certificate problem",
            "TLS connection was non-properly terminated",
            "remote end hung up unexpectedly",
            "unexpected disconnect",
            "HTTP/2 stream",
        ] {
            if line.contains(fact) && !facts.iter().any(|existing| existing == fact) {
                facts.push(fact.to_string());
            }
        }
    }
    if facts.is_empty() {
        "Git transport failed; no safe diagnostic was available".to_string()
    } else {
        facts.join("; ")
    }
}

/// Turn a failed git network command into a useful error.
pub fn git_failure(action: &str, output: &std::process::Output) -> GmError {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = git_diagnostic(&stderr);
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
        || stderr.contains("unable to get password from user")
        || has_http_error(&stderr, "401")
    {
        return GmError::new(
            "unauthenticated",
            format!("{action} failed: not signed in. {detail}"),
        )
        .hint("Sign in: `gm auth login` (in the browser), or `--persona <name>` in dev.")
        .exit(exit::AUTH);
    }
    if has_http_error(&stderr, "403")
        || stderr.contains("does not have write access")
        || stderr.contains("read-only")
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
            .hint("Is the Timelines dev server running (`vp dev` in apps/website)?");
    }
    GmError::new("git_failed", format!("{action} failed: {detail}"))
}

#[cfg(test)]
mod failure_tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::process::ExitStatusExt;
    #[cfg(windows)]
    use std::os::windows::process::ExitStatusExt;

    #[test]
    fn personal_default_requires_matching_authorized_space() {
        let viewer = serde_json::json!({
            "slug": "person",
            "defaultSpaceId": "space-1",
            "spaces": [{"id": "space-1", "slug": "private-work"}]
        });
        assert_eq!(default_space_from_viewer(&viewer).unwrap(), "private-work");
        assert!(
            default_space_from_viewer(&serde_json::json!({
                "slug": "person", "defaultSpaceId": "revoked",
                "spaces": [{"id": "space-1", "slug": "private-work"}]
            }))
            .is_err()
        );
        assert!(
            default_space_from_viewer(&serde_json::json!({
                "slug": "person", "spaces": []
            }))
            .is_err()
        );
    }

    fn failure(stderr: &str) -> GmError {
        git_failure(
            "Clone",
            &Output {
                status: std::process::ExitStatus::from_raw(1),
                stdout: Vec::new(),
                stderr: stderr.as_bytes().to_vec(),
            },
        )
    }

    #[test]
    fn transport_status_survives_generic_final_line_without_echoing_secrets() {
        for status in ["409", "500", "502"] {
            let error = failure(&format!(
                "remote: private server body token=secret\n\
                 fatal: unable to access 'https://user:password@example.test/repo?token=secret': The requested URL returned error: {status}\n\
                 fatal: the remote end hung up unexpectedly\n"
            ));
            assert_eq!(error.code, "git_failed");
            assert!(error.message.contains(&format!("HTTP {status}")));
            assert!(error.message.contains("remote end hung up unexpectedly"));
            for secret in ["password", "secret", "example.test", "private server body"] {
                assert!(!error.message.contains(secret));
            }
        }
    }

    #[test]
    fn bodies_traces_and_unrecognized_errors_are_not_reprinted() {
        for stderr in [
            "remote: HTTP 500 password=secret\nfatal: unknown secret",
            "=> Send header: Authorization: Bearer secret\nfatal: unknown secret",
            "fatal: Authentication failed for 'https://user:secret@example.test/'",
            "fatal: unable to access 'https://user:secret@example.test/': Could not resolve host: private.internal",
        ] {
            let error = failure(stderr);
            assert!(!error.message.contains("secret"));
            assert!(!error.message.contains("private.internal"));
            assert!(!error.message.contains("example.test"));
        }
        assert!(
            !failure("remote: HTTP 500\nfatal: unknown")
                .message
                .contains("HTTP 500")
        );
    }

    #[test]
    fn object_counts_do_not_turn_early_eof_into_an_auth_error() {
        for count in [401, 403] {
            let error = failure(&format!(
                "Receiving objects: 40% ({count}/1000)\rfatal: early EOF\n"
            ));
            assert_eq!(error.code, "git_failed", "{count}");
            assert_eq!(error.exit, exit::ERROR, "{count}");
            assert!(error.message.contains("early EOF"));
            assert!(error.hint.is_none());
        }
    }

    #[test]
    fn explicit_http_errors_keep_auth_classification_despite_progress_counts() {
        for (status, count, code) in [(401, 403, "unauthenticated"), (403, 401, "forbidden")] {
            for diagnostic in [
                format!(
                    "fatal: unable to access 'https://example.test/repo.git/': The requested URL returned error: {status}"
                ),
                format!(
                    "error: RPC failed; HTTP {status} curl 22 The requested URL returned error: {status}"
                ),
            ] {
                let error = failure(&format!(
                    "Receiving objects: 40% ({count}/1000)\r{diagnostic}\n"
                ));
                assert_eq!(error.code, code, "{diagnostic}");
                assert_eq!(error.exit, exit::AUTH);
            }
        }
    }

    #[test]
    fn unrelated_numbers_and_longer_http_codes_are_not_auth_failures() {
        for diagnostic in [
            "fatal: unable to access 'https://example.test/401/403.git/': Could not resolve host: example.test",
            "fatal: The requested URL returned error: 4010",
            "error: RPC failed; HTTP 4030 curl 22",
        ] {
            let error = failure(diagnostic);
            assert_ne!(error.exit, exit::AUTH, "{diagnostic}");
        }
    }

    #[test]
    fn credential_and_permission_diagnostics_still_classify_correctly() {
        for (diagnostic, code) in [
            (
                "fatal: Authentication failed for 'https://example.test/repo.git/'",
                "unauthenticated",
            ),
            (
                "fatal: could not read Username: terminal prompts disabled",
                "unauthenticated",
            ),
            ("fatal: unable to get password from user", "unauthenticated"),
            ("remote: user does not have write access", "forbidden"),
            ("remote: repository is read-only", "forbidden"),
        ] {
            let error = failure(diagnostic);
            assert_eq!(error.code, code);
            assert_eq!(error.exit, exit::AUTH);
        }
    }
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

#[cfg(test)]
mod retry_tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// A server answering each request with the next status in `statuses`
    /// (then 200), recording each request's method.
    fn serve(statuses: Vec<u16>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (record, mut statuses) = (Arc::clone(&seen), statuses.into_iter());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                record
                    .lock()
                    .unwrap()
                    .push(line.split(' ').next().unwrap_or("").to_string());
                let mut length = 0;
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    if header.trim().is_empty() {
                        break;
                    }
                    if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:")
                    {
                        length = value.trim().parse().unwrap_or(0);
                    }
                }
                std::io::Read::read_exact(&mut reader, &mut vec![0; length]).unwrap();
                let status = statuses.next().unwrap_or(200);
                let body = format!(r#"{{"status":{status}}}"#);
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        (url, seen)
    }

    #[test]
    fn a_read_retries_gateway_errors_until_the_server_answers() {
        let (url, seen) = serve(vec![503, 502]);
        let value = api_at(&url, "GET", "/thing", None, None).unwrap();
        assert_eq!(value["status"], 200);
        assert_eq!(*seen.lock().unwrap(), ["GET", "GET", "GET"]);
    }

    #[test]
    fn a_read_gives_up_after_its_retries_with_the_last_answer() {
        let (url, seen) = serve(vec![504, 503, 502, 200]);
        let error = api_at(&url, "GET", "/thing", None, None).unwrap_err();
        assert!(error.message.contains("502"), "{}", error.message);
        assert_eq!(seen.lock().unwrap().len(), 3);
    }

    #[test]
    fn writes_and_ordinary_errors_are_never_retried() {
        let (url, seen) = serve(vec![503, 500]);
        let body = serde_json::json!({});
        assert!(api_at(&url, "POST", "/thing", Some(&body), None).is_err());
        assert!(api_at(&url, "GET", "/thing", None, None).is_err());
        assert_eq!(*seen.lock().unwrap(), ["POST", "GET"]);
    }

    #[test]
    fn a_dropped_connection_is_retried_then_reported() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let accepted = Arc::new(Mutex::new(0));
        let count = Arc::clone(&accepted);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                *count.lock().unwrap() += 1;
                drop(stream);
            }
        });
        let error = api_at(&url, "GET", "/thing", None, None).unwrap_err();
        assert_eq!(error.code, "server_unreachable");
        assert_eq!(*accepted.lock().unwrap(), 3);
    }

    #[test]
    fn a_read_that_times_out_is_reported_not_retried() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let accepted = Arc::new(Mutex::new(0));
        let count = Arc::clone(&accepted);
        std::thread::spawn(move || {
            let mut held = Vec::new();
            for stream in listener.incoming() {
                *count.lock().unwrap() += 1;
                // Never answer: hold the connection open.
                held.push(stream);
            }
        });
        let error = api_at(&url, "GET", "/thing", None, None).unwrap_err();
        assert_eq!(error.code, "server_timeout");
        assert_eq!(*accepted.lock().unwrap(), 1);
    }
}

/// The pause between polls of a long-running server operation. Debug builds only
/// (so `cargo test`, never a release gm) honour `GM_POLL_MS`, a test-only knob that
/// replaces `default` so integration tests need not wait out real poll intervals.
pub fn poll_interval(default: std::time::Duration) -> std::time::Duration {
    #[cfg(debug_assertions)]
    if let Some(ms) = std::env::var("GM_POLL_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
    {
        return std::time::Duration::from_millis(ms);
    }
    default
}
