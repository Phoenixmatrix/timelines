//! Signing in with SSH keys, over HTTPS.
//!
//! Gitmatrix runs on Workers, which speak HTTP, not SSH. So instead of an SSH
//! handshake gm proves it holds a registered key by signing a one-time
//! challenge (an SSHSIG, as `ssh-keygen -Y sign` makes), and gets a session
//! token that git and the API use like any other token.
//!
//! Keys are found the way ssh finds them: the agent named by `IdentityAgent`
//! in ~/.ssh/config (how 1Password and similar agents are wired up), then
//! `SSH_AUTH_SOCK`, then `IdentityFile`s and the default key files. Signing
//! goes through the agent when the key is there, so its approval prompts work
//! as usual; key files are read directly, asking for a passphrase at a
//! terminal.

use crate::output::{GmError, Result, exit};
use crate::remote::{self, Config};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ssh_key::{Algorithm, HashAlg, LineEnding, PrivateKey, PublicKey, Signature, SshSig};
use std::io::{IsTerminal, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The SSHSIG namespace for sign-in challenges; gm signs nothing else.
pub const NAMESPACE: &str = "gitmatrix-auth";
const MESSAGE_PREFIX: &str = "gitmatrix-ssh-auth\n";
/// Re-authenticate when the session has less than this left.
const RENEW_BEFORE_SECONDS: i64 = 5 * 60;

// ---- ~/.ssh/config ---------------------------------------------------------

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[derive(Default, Debug, PartialEq)]
pub struct SshConfig {
    /// `IdentityAgent`, resolved: None when unset or `none`.
    pub identity_agent: Option<PathBuf>,
    pub agent_disabled: bool,
    pub identity_files: Vec<PathBuf>,
}

fn glob(pattern: &str, text: &str) -> bool {
    fn go(p: &[u8], t: &[u8]) -> bool {
        match (p.first(), t.first()) {
            (None, None) => true,
            (Some(b'*'), _) => go(&p[1..], t) || (!t.is_empty() && go(p, &t[1..])),
            (Some(b'?'), Some(_)) => go(&p[1..], &t[1..]),
            (Some(a), Some(b)) if a.eq_ignore_ascii_case(b) => go(&p[1..], &t[1..]),
            _ => false,
        }
    }
    go(pattern.as_bytes(), text.as_bytes())
}

fn host_matches(patterns: &[&str], host: &str) -> bool {
    let mut matched = false;
    for pattern in patterns {
        if let Some(negated) = pattern.strip_prefix('!') {
            if glob(negated, host) {
                return false;
            }
        } else if glob(pattern, host) {
            matched = true;
        }
    }
    matched
}

fn expand(value: &str, host: &str) -> String {
    let home = home();
    let home = home.to_string_lossy();
    let mut out = if let Some(rest) = value.strip_prefix("~/") {
        format!("{home}/{rest}")
    } else {
        value.to_string()
    };
    out = out
        .replace("%d", &home)
        .replace("%h", host)
        .replace("%u", &std::env::var("USER").unwrap_or_default())
        .replace("%%", "%");
    // ${VAR}
    while let Some(start) = out.find("${") {
        let Some(len) = out[start..].find('}') else {
            break;
        };
        let name = &out[start + 2..start + len];
        let value = std::env::var(name).unwrap_or_default();
        out.replace_range(start..=start + len, &value);
    }
    out
}

/// The settings ssh would use for `host`: Host blocks match by glob (with
/// `!` negation); `Match` blocks other than `Match all` are skipped. As in ssh,
/// the first `IdentityAgent` wins and `IdentityFile`s accumulate.
pub fn parse_ssh_config(text: &str, host: &str) -> SshConfig {
    let mut config = SshConfig::default();
    let mut agent_seen = false;
    let mut active = true;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (keyword, rest) = match line.find(|c: char| c.is_whitespace() || c == '=') {
            Some(i) => (
                &line[..i],
                line[i..].trim_start_matches(|c: char| c.is_whitespace() || c == '='),
            ),
            None => (line, ""),
        };
        let args: Vec<&str> = rest
            .split_whitespace()
            .map(|a| a.trim_matches('"'))
            .collect();
        match keyword.to_ascii_lowercase().as_str() {
            "host" => active = host_matches(&args, host),
            "match" => active = args.first().is_some_and(|a| a.eq_ignore_ascii_case("all")),
            "identityagent" if active && !agent_seen => {
                agent_seen = true;
                let value = rest.trim().trim_matches('"');
                if value.eq_ignore_ascii_case("none") {
                    config.agent_disabled = true;
                } else if value == "SSH_AUTH_SOCK" {
                    config.identity_agent = std::env::var_os("SSH_AUTH_SOCK").map(PathBuf::from);
                } else if let Some(var) = value.strip_prefix('$') {
                    config.identity_agent = std::env::var_os(var).map(PathBuf::from);
                } else {
                    config.identity_agent = Some(PathBuf::from(expand(value, host)));
                }
            }
            "identityfile" if active => {
                if let Some(path) = args.first() {
                    config
                        .identity_files
                        .push(PathBuf::from(expand(path, host)));
                }
            }
            _ => {}
        }
    }
    config
}

fn ssh_config(host: &str) -> SshConfig {
    std::fs::read_to_string(home().join(".ssh").join("config"))
        .map(|text| parse_ssh_config(&text, host))
        .unwrap_or_default()
}

// ---- the agent protocol (draft-miller-ssh-agent) ------------------------------

const AGENTC_REQUEST_IDENTITIES: u8 = 11;
const AGENT_IDENTITIES_ANSWER: u8 = 12;
const AGENTC_SIGN_REQUEST: u8 = 13;
const AGENT_SIGN_RESPONSE: u8 = 14;
const AGENT_RSA_SHA2_512: u32 = 4;

struct Agent {
    stream: UnixStream,
}

fn put_string(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
}

struct Cursor<'a>(&'a [u8]);

impl Cursor<'_> {
    fn u32(&mut self) -> Option<u32> {
        let (head, rest) = self.0.split_at_checked(4)?;
        self.0 = rest;
        Some(u32::from_be_bytes(head.try_into().ok()?))
    }
    fn string(&mut self) -> Option<Vec<u8>> {
        let len = self.u32()? as usize;
        let (head, rest) = self.0.split_at_checked(len)?;
        self.0 = rest;
        Some(head.to_vec())
    }
}

impl Agent {
    fn connect(path: &Path) -> std::io::Result<Agent> {
        let stream = UnixStream::connect(path)?;
        // Agents like 1Password wait for the person to approve a signature.
        stream.set_read_timeout(Some(Duration::from_secs(300)))?;
        Ok(Agent { stream })
    }

    fn request(&mut self, kind: u8, payload: &[u8]) -> std::io::Result<(u8, Vec<u8>)> {
        let mut message = ((payload.len() + 1) as u32).to_be_bytes().to_vec();
        message.push(kind);
        message.extend_from_slice(payload);
        self.stream.write_all(&message)?;
        let mut len = [0u8; 4];
        self.stream.read_exact(&mut len)?;
        let len = u32::from_be_bytes(len) as usize;
        if len == 0 || len > 256 * 1024 {
            return Err(std::io::Error::other("bad agent response"));
        }
        let mut body = vec![0u8; len];
        self.stream.read_exact(&mut body)?;
        Ok((body[0], body[1..].to_vec()))
    }

    fn identities(&mut self) -> std::io::Result<Vec<(Vec<u8>, String)>> {
        let (kind, body) = self.request(AGENTC_REQUEST_IDENTITIES, &[])?;
        if kind != AGENT_IDENTITIES_ANSWER {
            return Err(std::io::Error::other("the agent refused to list keys"));
        }
        let mut cursor = Cursor(&body);
        let count = cursor.u32().unwrap_or(0);
        let mut out = Vec::new();
        for _ in 0..count {
            let (Some(blob), Some(comment)) = (cursor.string(), cursor.string()) else {
                break;
            };
            out.push((blob, String::from_utf8_lossy(&comment).into_owned()));
        }
        Ok(out)
    }

    fn sign(&mut self, blob: &[u8], data: &[u8], flags: u32) -> std::io::Result<Option<Vec<u8>>> {
        let mut payload = Vec::new();
        put_string(&mut payload, blob);
        put_string(&mut payload, data);
        payload.extend_from_slice(&flags.to_be_bytes());
        let (kind, body) = self.request(AGENTC_SIGN_REQUEST, &payload)?;
        if kind != AGENT_SIGN_RESPONSE {
            return Ok(None);
        }
        Ok(Cursor(&body).string())
    }
}

// ---- identities ---------------------------------------------------------------

#[derive(Clone, Debug)]
pub enum Source {
    Agent(PathBuf),
    File(PathBuf),
    /// Listed by and signed with the ssh tools git is configured to use.
    Git {
        signer: Signer,
        label: String,
    },
}

#[derive(Clone, Debug)]
pub struct Identity {
    pub public: PublicKey,
    pub comment: String,
    pub source: Source,
}

impl Identity {
    pub fn fingerprint(&self) -> String {
        self.public.fingerprint(HashAlg::Sha256).to_string()
    }

    pub fn openssh(&self) -> String {
        let mut key = self.public.clone();
        key.set_comment(self.comment.clone());
        key.to_openssh().unwrap_or_default()
    }

    pub fn to_json(&self) -> Value {
        json!({
            "fingerprint": self.fingerprint(),
            "type": self.public.algorithm().as_str(),
            "comment": self.comment,
            "source": match &self.source {
                Source::Agent(path) => format!("agent {}", path.display()),
                Source::File(path) => format!("file {}", path.display()),
                Source::Git { label, .. } => label.clone(),
            },
        })
    }
}

/// Key types the server accepts.
fn supported(algorithm: &Algorithm) -> bool {
    match algorithm {
        Algorithm::Ed25519 | Algorithm::Rsa { .. } => true,
        Algorithm::Ecdsa { curve } => curve.as_str() != "nistp521",
        _ => false,
    }
}

pub struct Discovery {
    pub identities: Vec<Identity>,
    /// Agents or tools that were configured but failed, for error hints.
    pub problems: Vec<String>,
}

/// Every usable key, in the order ssh would try them. When git is set up to
/// use another ssh (e.g. Windows OpenSSH from WSL), only its keys count, as
/// they're the ones git itself would use.
pub fn discover(host: &str) -> Discovery {
    if let Some(git) = git_ssh() {
        return discover_git(&git);
    }
    let config = ssh_config(host);
    let mut agents: Vec<PathBuf> = Vec::new();
    if !config.agent_disabled {
        agents.extend(config.identity_agent.clone());
        if let Some(sock) = std::env::var_os("SSH_AUTH_SOCK").map(PathBuf::from)
            && !agents.contains(&sock)
        {
            agents.push(sock);
        }
    }
    let mut identities: Vec<Identity> = Vec::new();
    let mut problems = Vec::new();
    let known = |list: &[Identity], key: &PublicKey| {
        list.iter().any(|i| i.public.key_data() == key.key_data())
    };
    for path in agents {
        let listed = Agent::connect(&path).and_then(|mut agent| agent.identities());
        match listed {
            Ok(keys) => {
                for (blob, comment) in keys {
                    let Ok(public) = PublicKey::from_bytes(&blob) else {
                        continue;
                    };
                    if supported(&public.algorithm()) && !known(&identities, &public) {
                        identities.push(Identity {
                            public,
                            comment,
                            source: Source::Agent(path.clone()),
                        });
                    }
                }
            }
            Err(e) => problems.push(format!("SSH agent at {}: {e}", path.display())),
        }
    }
    let ssh_dir = home().join(".ssh");
    let mut files = config.identity_files.clone();
    for name in ["id_rsa", "id_ecdsa", "id_ed25519"] {
        let path = ssh_dir.join(name);
        if !files.contains(&path) {
            files.push(path);
        }
    }
    for path in files {
        let public = PublicKey::read_openssh_file(
            &path.with_extension(
                path.extension()
                    .map(|e| format!("{}.pub", e.to_string_lossy()))
                    .unwrap_or_else(|| "pub".into()),
            ),
        )
        // Without a .pub, the private key file carries the public key in clear.
        .or_else(|_| PrivateKey::read_openssh_file(&path).map(|k| k.public_key().clone()));
        let Ok(public) = public else { continue };
        if supported(&public.algorithm()) && !known(&identities, &public) {
            let comment = public.comment().to_string();
            identities.push(Identity {
                public,
                comment,
                source: Source::File(path),
            });
        }
    }
    Discovery {
        identities,
        problems,
    }
}

/// Narrow to the key a person named: a fingerprint, a path, or part of a comment.
pub fn select(identities: Vec<Identity>, wanted: Option<&str>) -> Vec<Identity> {
    let Some(wanted) = wanted else {
        return identities;
    };
    identities
        .into_iter()
        .filter(|i| {
            i.fingerprint() == wanted
                || i.fingerprint().trim_start_matches("SHA256:") == wanted
                || matches!(&i.source, Source::File(p) if p == Path::new(wanted) || p.with_extension("pub") == Path::new(wanted))
                || (!i.comment.is_empty() && i.comment.contains(wanted))
        })
        .collect()
}

/// Sign `message` as an armored SSHSIG.
pub fn sign(identity: &Identity, namespace: &str, message: &[u8]) -> Result<String> {
    let failed =
        |e: ssh_key::Error| GmError::new("ssh_sign_failed", format!("Could not sign: {e}"));
    let sig = match &identity.source {
        Source::Git { signer, .. } => {
            return sign_with_program(signer, identity, namespace, message);
        }
        Source::Agent(path) => {
            let data = SshSig::signed_data(namespace, HashAlg::Sha512, message).map_err(failed)?;
            let blob = identity.public.to_bytes().map_err(failed)?;
            let flags = if matches!(identity.public.algorithm(), Algorithm::Rsa { .. }) {
                AGENT_RSA_SHA2_512
            } else {
                0
            };
            let signature = Agent::connect(path)
                .and_then(|mut agent| agent.sign(&blob, &data, flags))
                .map_err(|e| {
                    GmError::new(
                        "ssh_agent_failed",
                        format!("The SSH agent at {} failed: {e}", path.display()),
                    )
                })?
                .ok_or_else(|| {
                    GmError::new(
                        "ssh_sign_refused",
                        "The SSH agent declined to sign (was the request approved?).",
                    )
                    .exit(exit::AUTH)
                })?;
            let signature = Signature::try_from(signature.as_slice()).map_err(failed)?;
            SshSig::new(
                identity.public.key_data().clone(),
                namespace,
                HashAlg::Sha512,
                signature,
            )
            .map_err(failed)?
        }
        Source::File(path) => {
            let mut key = PrivateKey::read_openssh_file(path).map_err(|e| {
                GmError::new(
                    "ssh_key_unreadable",
                    format!("Could not read {}: {e}", path.display()),
                )
            })?;
            if key.is_encrypted() {
                if !std::io::stdin().is_terminal() {
                    return Err(GmError::new(
                        "ssh_key_encrypted",
                        format!("{} is protected by a passphrase.", path.display()),
                    )
                    .hint(format!(
                        "Add it to your SSH agent first: `ssh-add {}`.",
                        path.display()
                    ))
                    .exit(exit::AUTH));
                }
                let passphrase = rpassword::prompt_password(format!(
                    "Enter passphrase for key '{}': ",
                    path.display()
                ))?;
                key = key.decrypt(passphrase).map_err(|_| {
                    GmError::new(
                        "ssh_key_passphrase",
                        "That passphrase didn't unlock the key.",
                    )
                    .exit(exit::AUTH)
                })?;
            }
            key.sign(namespace, HashAlg::Sha512, message)
                .map_err(failed)?
        }
    };
    sig.to_pem(LineEnding::LF).map_err(|e| {
        GmError::new(
            "ssh_sign_failed",
            format!("Could not encode the signature: {e}"),
        )
    })
}

// ---- the ssh git is set up to use ----------------------------------------------

/// A program that makes SSHSIG signatures the way git signs commits:
/// `<program> -Y sign -n <namespace> -f <public key file> <file>` → `<file>.sig`.
#[derive(Clone, Debug)]
pub struct Signer {
    pub program: PathBuf,
    /// Windows programs run from WSL need Windows paths (via `wslpath -w`).
    pub windows_paths: bool,
}

/// The ssh tools git uses, when that isn't plain OpenSSH on this system: e.g.
/// `core.sshCommand = ssh.exe` in WSL, where Windows OpenSSH reaches
/// 1Password's agent. Keys are listed with that ssh's `ssh-add -L` (plus
/// `user.signingKey`), and signed like git signs commits: with
/// `gpg.ssh.program` when set, else that ssh's `ssh-keygen -Y sign`.
/// `gitmatrix.sshCommand` in git config overrides the ssh for gm alone.
#[derive(Clone, Debug)]
pub struct GitSsh {
    /// The setting that chose it, e.g. "core.sshCommand = ssh.exe".
    pub origin: String,
    pub ssh_add: Option<PathBuf>,
    pub signer: Signer,
    pub signing_key: Option<PublicKey>,
}

fn which(name: &str) -> Option<PathBuf> {
    if name.contains('/') {
        let path = PathBuf::from(expand(name, ""));
        return path.is_file().then_some(path);
    }
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths).find_map(|dir| {
        let path = dir.join(name);
        path.is_file().then_some(path)
    })
}

/// The program word of a shell-ish command line (`"C:/x/ssh.exe" -v` → the path).
fn program_of(command: &str) -> &str {
    let command = command.trim();
    match command.chars().next() {
        Some(q @ ('"' | '\'')) => command[1..].split(q).next().unwrap_or(""),
        _ => command.split_whitespace().next().unwrap_or(""),
    }
}

/// `user.signingKey` as git reads it for SSH: a key (`key::` optional) or a path.
fn signing_key(value: &str) -> Option<PublicKey> {
    let value = value.trim().trim_start_matches("key::");
    if value.starts_with("ssh-") || value.starts_with("ecdsa-") {
        return PublicKey::from_openssh(value).ok();
    }
    let path = PathBuf::from(expand(value, ""));
    PublicKey::read_openssh_file(&path)
        .or_else(|_| PrivateKey::read_openssh_file(&path).map(|k| k.public_key().clone()))
        .ok()
}

pub fn git_ssh() -> Option<GitSsh> {
    let config = git2::Config::open_default().ok();
    let get = |key: &str| {
        config
            .as_ref()
            .and_then(|c| c.get_string(key).ok())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let env = std::env::var("GIT_SSH_COMMAND")
        .ok()
        .filter(|v| !v.trim().is_empty());
    let (command, origin, explicit) = if let Some(c) = get("gitmatrix.sshCommand") {
        (c, "gitmatrix.sshCommand", true)
    } else if let Some(c) = env {
        (c, "GIT_SSH_COMMAND", false)
    } else {
        (get("core.sshCommand")?, "core.sshCommand", false)
    };
    let word = program_of(&command);
    let program = which(word).or_else(|| which(&format!("{word}.exe")))?;
    let base = program.file_name()?.to_str()?.to_string();
    // Plain OpenSSH on this system: gm talks to its agent and keys directly.
    if !explicit && base == "ssh" {
        return None;
    }
    let sibling = |tool: &str| {
        let path = program.with_file_name(base.replacen("ssh", tool, 1));
        path.is_file().then_some(path)
    };
    let windows = base.ends_with(".exe") && which("wslpath").is_some();
    let signer = match get("gpg.ssh.program") {
        // git hands its signing program Linux paths, so gm does too.
        Some(p) => Signer {
            program: which(&p).or_else(|| which(&format!("{p}.exe")))?,
            windows_paths: false,
        },
        None => Signer {
            program: sibling("ssh-keygen")?,
            windows_paths: windows,
        },
    };
    Some(GitSsh {
        origin: format!("{origin} = {command}"),
        ssh_add: sibling("ssh-add"),
        signer,
        signing_key: get("user.signingKey").as_deref().and_then(signing_key),
    })
}

fn discover_git(git: &GitSsh) -> Discovery {
    let mut identities: Vec<Identity> = Vec::new();
    let mut problems = Vec::new();
    let signer_name = git
        .signer
        .program
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut add = |public: PublicKey, comment: String, listed_by: &str| {
        if supported(&public.algorithm())
            && !identities
                .iter()
                .any(|i| i.public.key_data() == public.key_data())
        {
            identities.push(Identity {
                public,
                comment,
                source: Source::Git {
                    signer: git.signer.clone(),
                    label: format!("{listed_by}, signed by {signer_name} ({})", git.origin),
                },
            });
        }
    };
    if let Some(key) = &git.signing_key {
        add(key.clone(), key.comment().to_string(), "user.signingKey");
    }
    match &git.ssh_add {
        Some(ssh_add) => {
            let name = ssh_add
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            match std::process::Command::new(ssh_add).arg("-L").output() {
                Ok(out) if out.status.success() => {
                    for line in String::from_utf8_lossy(&out.stdout).lines() {
                        if let Ok(public) = PublicKey::from_openssh(line.trim()) {
                            let comment = public.comment().to_string();
                            add(public, comment, &name);
                        }
                    }
                }
                Ok(out) => {
                    let said = format!(
                        "{}{}",
                        String::from_utf8_lossy(&out.stdout),
                        String::from_utf8_lossy(&out.stderr)
                    );
                    problems.push(format!("`{name} -L` said: {}", said.trim()));
                }
                Err(e) => problems.push(format!("Could not run {}: {e}", ssh_add.display())),
            }
        }
        None => problems.push(format!(
            "No ssh-add next to the ssh from {}; set user.signingKey to name your key",
            git.origin
        )),
    }
    Discovery {
        identities,
        problems,
    }
}

fn wsl_path(path: &Path) -> Result<String> {
    let out = std::process::Command::new("wslpath")
        .arg("-w")
        .arg(path)
        .output()?;
    if !out.status.success() {
        return Err(GmError::new(
            "ssh_sign_failed",
            format!("wslpath could not translate {}.", path.display()),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Sign through an external program, exactly as git signs commits with it.
fn sign_with_program(
    signer: &Signer,
    identity: &Identity,
    namespace: &str,
    message: &[u8],
) -> Result<String> {
    use std::os::unix::fs::PermissionsExt;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let dir = std::env::temp_dir().join(format!("gm-sign-{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    let key = dir.join("key.pub");
    let file = dir.join("challenge");
    let result = (|| -> Result<String> {
        std::fs::write(&key, format!("{}\n", identity.openssh()))?;
        std::fs::write(&file, message)?;
        let arg = |path: &Path| -> Result<String> {
            if signer.windows_paths {
                wsl_path(path)
            } else {
                Ok(path.display().to_string())
            }
        };
        let output = std::process::Command::new(&signer.program)
            .args([
                "-Y",
                "sign",
                "-n",
                namespace,
                "-f",
                &arg(&key)?,
                &arg(&file)?,
            ])
            .stdin(std::process::Stdio::inherit())
            .output()
            .map_err(|e| {
                GmError::new(
                    "ssh_sign_failed",
                    format!("Could not run {}: {e}", signer.program.display()),
                )
            })?;
        let signature = std::fs::read_to_string(dir.join("challenge.sig"));
        match signature {
            Ok(sig) if output.status.success() && sig.contains("BEGIN SSH SIGNATURE") => Ok(sig),
            _ => {
                let said = String::from_utf8_lossy(&output.stderr).trim().to_string();
                Err(GmError::new(
                    "ssh_sign_refused",
                    format!(
                        "{} didn't sign{}",
                        signer.program.display(),
                        if said.is_empty() { ".".to_string() } else { format!(": {said}") }
                    ),
                )
                .hint("If 1Password asked, approve the request; check that it's unlocked with the SSH agent on.")
                .exit(exit::AUTH))
            }
        }
    })();
    let _ = std::fs::remove_dir_all(&dir);
    result
}

// ---- sessions -----------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Session {
    pub server: String,
    pub fingerprint: String,
    pub token: String,
    pub expires_at: String,
    pub user: String,
    pub scope: String,
}

fn session_path() -> PathBuf {
    std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".cache"))
        .join("gitmatrix")
        .join("ssh-session.json")
}

fn load_session() -> Option<Session> {
    serde_json::from_slice(&std::fs::read(session_path()).ok()?).ok()
}

fn save_session(session: &Session) -> Result<()> {
    let path = session_path();
    std::fs::create_dir_all(path.parent().expect("a parent"))?;
    std::fs::write(&path, serde_json::to_vec_pretty(session)?)?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

/// Drop the cached session, e.g. after the server stops accepting it.
pub fn forget() {
    let _ = std::fs::remove_file(session_path());
}

fn fresh(session: &Session, server: &str) -> bool {
    session.server == server
        && chrono::DateTime::parse_from_rfc3339(&session.expires_at)
            .map(|at| (at.timestamp() - chrono::Utc::now().timestamp()) > RENEW_BEFORE_SECONDS)
            .unwrap_or(false)
}

pub fn server_host(server: &str) -> String {
    let rest = server.split("://").nth(1).unwrap_or(server);
    rest.split(['/', ':']).next().unwrap_or(rest).to_string()
}

/// A session token for `config`'s server, reusing a cached one while it lasts.
pub fn session(config: &Config) -> Result<Session> {
    let server = config.server();
    if let Some(session) = load_session()
        && fresh(&session, &server)
        && config
            .ssh_key
            .as_deref()
            .is_none_or(|k| k == session.fingerprint)
    {
        return Ok(session);
    }
    let (session, _) = login(config, config.ssh_key.as_deref()).map_err(|e| match &config.ssh_key {
        Some(pinned) if e.code == "no_ssh_keys" => GmError::new(
            "ssh_key_missing",
            format!("gm is signed in with SSH key {pinned}, but that key is no longer in your agent or ~/.ssh."),
        )
        .hint("Load it again (`ssh-add`, or unlock 1Password), or sign in with another key: `gm auth login --ssh`.")
        .exit(exit::AUTH),
        _ => e,
    })?;
    Ok(session)
}

/// Prove a key to the server and get a session: offer every usable key (or
/// the one named), sign the challenge for the one the server knows.
pub fn login(config: &Config, wanted: Option<&str>) -> Result<(Session, Identity)> {
    let server = config.server();
    let found = discover(&server_host(&server));
    let identities = select(found.identities, wanted);
    if identities.is_empty() {
        let mut error = GmError::new(
            "no_ssh_keys",
            match wanted {
                Some(w) => format!("No SSH key matching `{w}` was found."),
                None => "No SSH keys found in an agent or ~/.ssh.".to_string(),
            },
        )
        .exit(exit::AUTH);
        error = if !found.problems.is_empty() {
            error.hint(format!(
                "{}. Is the agent running (for 1Password: unlocked, with the SSH agent enabled)?",
                found.problems.join("; ")
            ))
        } else {
            error.hint("Create one with `ssh-keygen -t ed25519`, or load one into your agent with `ssh-add`.")
        };
        return Err(error);
    }

    // The sign-in endpoints take no credentials.
    let anonymous = Config {
        token: None,
        auth: None,
        ..config.clone()
    };
    let fingerprints: Vec<String> = identities.iter().map(Identity::fingerprint).collect();
    let challenge = remote::api_with(
        &anonymous,
        "POST",
        "/auth/ssh/challenge",
        Some(&json!({ "fingerprints": fingerprints })),
        None,
    )
    .map_err(|e| {
        if e.code == "unauthenticated" {
            GmError::new(
                "ssh_key_unknown",
                format!("{} doesn't know any of these keys: {}.", server, fingerprints.join(", ")),
            )
            .hint("Register one while signed in: `gm auth ssh-key add` (or under SSH keys in the web app).")
            .exit(exit::AUTH)
        } else {
            e
        }
    })?;
    let fingerprint = challenge["fingerprint"].as_str().unwrap_or_default();
    let message = challenge["message"].as_str().unwrap_or_default();
    let nonce = challenge["nonce"].as_str().unwrap_or_default();
    // Sign only a sign-in challenge, for this server, in our namespace: a
    // rogue server can't get a signature it could use for anything else.
    let expected = format!("{MESSAGE_PREFIX}{server}\n{nonce}\n{fingerprint}\n");
    if challenge["namespace"].as_str() != Some(NAMESPACE) || message != expected {
        return Err(GmError::new(
            "ssh_challenge_invalid",
            "The server sent a challenge gm won't sign.",
        )
        .exit(exit::AUTH));
    }
    let identity = identities
        .iter()
        .find(|i| i.fingerprint() == fingerprint)
        .cloned()
        .ok_or_else(|| {
            GmError::new(
                "ssh_challenge_invalid",
                "The server picked a key gm didn't offer.",
            )
        })?;
    let signature = sign(&identity, NAMESPACE, message.as_bytes())?;
    let reply = remote::api_with(
        &anonymous,
        "POST",
        "/auth/ssh/token",
        Some(&json!({ "nonce": nonce, "signature": signature })),
        None,
    )?;
    let session = Session {
        server,
        fingerprint: fingerprint.to_string(),
        token: reply["token"].as_str().unwrap_or_default().to_string(),
        expires_at: reply["expiresAt"].as_str().unwrap_or_default().to_string(),
        user: reply["user"]["slug"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        scope: reply["scope"].as_str().unwrap_or_default().to_string(),
    };
    save_session(&session)?;
    Ok((session, identity))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_identity_agent_like_ssh() {
        let config = parse_ssh_config(
            "Host kittybot\n  IdentityFile ~/.ssh/kitty\n\nHost *\n\tIdentityAgent ~/.1password/agent.sock\n  IdentityFile ~/.ssh/main\n",
            "gitmatrix.example.com",
        );
        assert_eq!(
            config.identity_agent,
            Some(home().join(".1password/agent.sock"))
        );
        assert_eq!(config.identity_files, vec![home().join(".ssh/main")]);
    }

    #[test]
    fn first_identity_agent_wins_and_negation_excludes() {
        let text = "Host *.internal !build.internal\n  IdentityAgent /tmp/a.sock\nHost *\n  IdentityAgent none\n";
        assert_eq!(
            parse_ssh_config(text, "git.internal").identity_agent,
            Some(PathBuf::from("/tmp/a.sock"))
        );
        let excluded = parse_ssh_config(text, "build.internal");
        assert!(excluded.agent_disabled && excluded.identity_agent.is_none());
    }

    #[test]
    fn reads_the_program_of_an_ssh_command() {
        assert_eq!(program_of("ssh.exe"), "ssh.exe");
        assert_eq!(program_of("ssh -o IdentitiesOnly=yes"), "ssh");
        assert_eq!(
            program_of("\"/mnt/c/Program Files/OpenSSH/ssh.exe\" -v"),
            "/mnt/c/Program Files/OpenSSH/ssh.exe"
        );
    }

    #[test]
    fn server_host_strips_scheme_and_port() {
        assert_eq!(server_host("http://localhost:5180"), "localhost");
        assert_eq!(server_host("https://git.example.com/"), "git.example.com");
    }
}
