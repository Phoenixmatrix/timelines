//! Commands for the Gitmatrix server itself: sign-in, repositories, raw API.

use super::Ctx;
use crate::cli::{AuthCommand, MirrorCommand, RepoCommand};
use crate::model::Json;
use crate::output::{GmError, Result, exit};
use crate::remote::{self, Config};
use serde_json::{Value, json};
use std::io::Read;

pub fn auth(ctx: &Ctx, command: &AuthCommand) -> Result<Json> {
    let mut config = Config::load();
    match command {
        AuthCommand::Login {
            ssh,
            key,
            persona,
            token,
            server,
        } => {
            if let Some(server) = server {
                config.server = Some(server.trim_end_matches('/').to_string());
            }
            if *ssh {
                return login_ssh(ctx, config, key.as_deref());
            }
            let secret = match (persona, token) {
                (_, Some(token)) => token.clone(),
                (Some(persona), None) => {
                    let unsigned = Config {
                        token: None,
                        auth: None,
                        ..config.clone()
                    };
                    let created = remote::api_with(
                        &unsigned,
                        "POST",
                        "/dev/tokens",
                        Some(&json!({ "persona": persona, "name": "gm CLI" })),
                        None,
                    )?;
                    created["secret"]
                        .as_str()
                        .map(str::to_string)
                        .ok_or_else(|| {
                            GmError::new("server_error", "The server returned no token.")
                        })?
                }
                (None, None) => {
                    return Err(GmError::usage(
                        "Pass --ssh (SSH key), --token gmx_… or --persona <name> (dev).",
                    )
                    .hint("Dev personas: `gm api GET /personas` lists them."));
                }
            };
            if ctx.dry_run {
                return Ok(Json(json!({ "dry_run": true, "server": config.server() })));
            }
            config.token = Some(secret);
            config.auth = None;
            config.ssh_key = None;
            let session = remote::api(&config, "GET", "/session", None)?;
            let viewer = session.get("viewer").cloned().unwrap_or(Value::Null);
            if viewer.is_null() {
                return Err(
                    GmError::new("unauthenticated", "That token was not accepted.")
                        .exit(exit::AUTH),
                );
            }
            config.user = viewer["slug"].as_str().map(str::to_string);
            config.save()?;
            crate::ssh::forget();
            Ok(Json(json!({
                "server": config.server(),
                "method": "token",
                "user": { "slug": viewer["slug"], "displayName": viewer["displayName"], "isSiteAdmin": viewer["isSiteAdmin"] },
                "message": format!("Signed in to {} as {}.", config.server(), viewer["slug"].as_str().unwrap_or("?")),
            })))
        }
        AuthCommand::SshKey(command) => ssh_key(ctx, &config, command),
        AuthCommand::GitCredential { .. } => unreachable!("handled in main"),
        AuthCommand::Status => {
            if config.token().is_none() && !config.uses_ssh() {
                return Ok(Json(
                    json!({ "server": config.server(), "user": null, "hint": "Sign in with `gm auth login --ssh`, or `--persona <name>` in dev." }),
                ));
            }
            let session = remote::api(&config, "GET", "/session", None)?;
            let mut out = json!({ "server": config.server(), "user": session["viewer"], "method": if config.uses_ssh() { "ssh" } else { "token" } });
            if config.uses_ssh()
                && let Ok(ssh) = crate::ssh::session(&config)
            {
                out["ssh"] = json!({ "key": ssh.fingerprint, "scope": ssh.scope, "sessionExpiresAt": ssh.expires_at });
            }
            Ok(Json(out))
        }
        AuthCommand::Logout => {
            if !ctx.dry_run {
                config.token = None;
                config.user = None;
                config.auth = None;
                config.ssh_key = None;
                config.save()?;
                crate::ssh::forget();
            }
            Ok(Json(
                json!({ "server": config.server(), "signed_out": true }),
            ))
        }
    }
}

fn login_ssh(ctx: &Ctx, mut config: Config, key: Option<&str>) -> Result<Json> {
    if ctx.dry_run {
        let found = crate::ssh::discover(&crate::ssh::server_host(&config.server()));
        return Ok(Json(json!({
            "dry_run": true,
            "server": config.server(),
            "keys": crate::ssh::select(found.identities, key).iter().map(|i| i.to_json()).collect::<Vec<_>>(),
        })));
    }
    crate::ssh::forget();
    let (session, identity) = crate::ssh::login(&config, key)?;
    config.auth = Some("ssh".into());
    // Pin the key that worked only when one was asked for; otherwise any
    // registered key will do next time too.
    config.ssh_key = key.map(|_| session.fingerprint.clone());
    config.token = None;
    config.user = Some(session.user.clone());
    config.save()?;
    let server = config.server();
    Ok(Json(json!({
        "server": server,
        "method": "ssh",
        "user": { "slug": session.user },
        "key": identity.to_json(),
        "scope": session.scope,
        "sessionExpiresAt": session.expires_at,
        "message": format!("Signed in to {server} as {} with SSH key {}. gm signs in again with the key when the session ends.", session.user, session.fingerprint),
        "git": format!("To let plain git use it too: git config --global credential.{server}.helper '!gm auth git-credential'"),
    })))
}

fn ssh_key(ctx: &Ctx, config: &Config, command: &crate::cli::SshKeyCommand) -> Result<Json> {
    use crate::cli::SshKeyCommand;
    match command {
        SshKeyCommand::List => {
            let registered = remote::api(config, "GET", "/ssh-keys", None)?;
            let found = crate::ssh::discover(&crate::ssh::server_host(&config.server()));
            let known: Vec<String> = registered["keys"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|k| k["fingerprint"].as_str().map(str::to_string))
                .collect();
            let local: Vec<Value> = found
                .identities
                .iter()
                .map(|i| {
                    let mut v = i.to_json();
                    v["registered"] = json!(known.contains(&i.fingerprint()));
                    v
                })
                .collect();
            Ok(Json(json!({
                "registered": registered["keys"],
                "local": local,
                "problems": found.problems,
                "gitSsh": crate::ssh::git_ssh().map(|g| g.origin),
            })))
        }
        SshKeyCommand::Add {
            key,
            title,
            read_only,
        } => {
            let found = crate::ssh::discover(&crate::ssh::server_host(&config.server()));
            let identity = crate::ssh::select(found.identities, key.as_deref())
                .into_iter()
                .next()
                .ok_or_else(|| {
                    GmError::not_found(
                        "no_ssh_keys",
                        match key {
                            Some(k) => format!("No SSH key matching `{k}` in your agent or ~/.ssh."),
                            None => "No SSH keys in your agent or ~/.ssh.".to_string(),
                        },
                    )
                    .hint("`gm auth ssh-key list` shows the keys gm can see; create one with `ssh-keygen -t ed25519`.")
                })?;
            let body = json!({
                "title": title.clone().unwrap_or_else(|| identity.comment.clone()),
                "key": identity.openssh(),
                "scope": if *read_only { "read" } else { "write" },
            });
            if ctx.dry_run {
                return Ok(Json(
                    json!({ "dry_run": true, "key": identity.to_json(), "request": body }),
                ));
            }
            let mut created = remote::api(config, "POST", "/ssh-keys", Some(&body))?;
            created["next"] = json!("Sign in with it: `gm auth login --ssh`.");
            Ok(Json(created))
        }
        SshKeyCommand::Remove { key } => {
            let registered = remote::api(config, "GET", "/ssh-keys", None)?;
            let wanted = key.trim_start_matches("SHA256:");
            let id = registered["keys"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|k| {
                    k["id"].as_str() == Some(key)
                        || k["fingerprint"]
                            .as_str()
                            .map(|f| f.trim_start_matches("SHA256:"))
                            == Some(wanted)
                })
                .and_then(|k| k["id"].as_str().map(str::to_string))
                .ok_or_else(|| {
                    GmError::not_found("ssh_key_not_found", format!("No registered key `{key}`."))
                })?;
            if ctx.dry_run {
                return Ok(Json(json!({ "dry_run": true, "would_remove": id })));
            }
            remote::api(config, "DELETE", &format!("/ssh-keys/{id}"), None)?;
            Ok(Json(json!({ "removed": id })))
        }
    }
}

/// git's credential helper protocol: answer `get` for this server with the
/// signed-in user and a token (an SSH session when signed in with a key).
/// Helpers print nothing for hosts they don't know, so git carries on.
pub fn git_credential(operation: &str) {
    let mut input = String::new();
    let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut input);
    let fields: std::collections::HashMap<&str, &str> =
        input.lines().filter_map(|l| l.split_once('=')).collect();
    let config = Config::load();
    let server = config.server();
    let asked = format!(
        "{}://{}",
        fields.get("protocol").copied().unwrap_or(""),
        fields.get("host").copied().unwrap_or("")
    );
    if asked != server {
        return;
    }
    match operation {
        "get" => match remote::credential(&config) {
            Ok((Some(token), _)) => {
                println!("username={}", config.user.as_deref().unwrap_or("gm"));
                println!("password={token}");
            }
            Ok((None, _)) => {}
            Err(e) => eprintln!("gm: {}", e.message),
        },
        // git reports a rejected password: the session may have ended early.
        "erase" if config.uses_ssh() => crate::ssh::forget(),
        _ => {}
    }
}

/// owner/name of the repository in the current directory, from its origin URL.
pub(crate) fn current_repo(ctx: &Ctx) -> Result<String> {
    let repo = git2::Repository::discover(&ctx.cwd)
        .map_err(|_| GmError::usage("Name a repository: owner/name."))?;
    let url = repo
        .find_remote("origin")
        .ok()
        .and_then(|r| r.url().ok().map(str::to_string))
        .ok_or_else(|| GmError::usage("This repository has no origin; name one: owner/name."))?;
    let path = url.trim_end_matches('/').trim_end_matches(".git");
    let mut parts = path.rsplit('/');
    match (parts.next(), parts.next()) {
        (Some(name), Some(owner)) => Ok(format!("{owner}/{name}")),
        _ => Err(GmError::usage(format!(
            "Can't tell the repository from origin `{url}`."
        ))),
    }
}

pub fn repo(ctx: &Ctx, command: &RepoCommand) -> Result<Json> {
    let config = Config::load();
    match command {
        RepoCommand::List => Ok(Json(remote::api(&config, "GET", "/repos", None)?)),
        RepoCommand::Create {
            name,
            owner,
            description,
            public,
            import,
        } => {
            let owner = match owner {
                Some(o) => o.clone(),
                None => {
                    let session = remote::api(&config, "GET", "/session", None)?;
                    session["viewer"]["slug"]
                        .as_str()
                        .map(str::to_string)
                        .ok_or_else(|| {
                            GmError::new("unauthenticated", "Sign in to create repositories.")
                                .hint("`gm auth login --persona <name>`")
                                .exit(exit::AUTH)
                        })?
                }
            };
            let body = json!({
                "owner": owner,
                "name": name,
                "description": description.clone().unwrap_or_default(),
                "visibility": if *public { "public" } else { "private" },
                "importUrl": import.clone().unwrap_or_default(),
            });
            if ctx.dry_run {
                return Ok(Json(json!({ "dry_run": true, "request": body })));
            }
            let mut created = remote::api(&config, "POST", "/repos", Some(&body))?;
            created["clone"] = json!(format!("gm clone {owner}/{name}"));
            Ok(Json(created))
        }
        RepoCommand::Mirror(command) => mirror(ctx, &config, command),
        RepoCommand::View { repository } => {
            let repository = match repository {
                Some(r) => r.clone(),
                None => current_repo(ctx)?,
            };
            Ok(Json(remote::api(
                &config,
                "GET",
                &format!("/repos/{repository}"),
                None,
            )?))
        }
        RepoCommand::Delete { repository, yes } => {
            if !yes {
                return Err(GmError::new(
                    "confirmation_required",
                    format!(
                        "Deleting {repository} is permanent: its history and branches go for good."
                    ),
                )
                .hint(format!(
                    "Re-run with --yes: `gm repo delete {repository} --yes`."
                ))
                .exit(exit::USAGE));
            }
            if ctx.dry_run {
                return Ok(Json(json!({ "dry_run": true, "would_delete": repository })));
            }
            remote::api(&config, "DELETE", &format!("/repos/{repository}"), None)?;
            Ok(Json(json!({ "deleted": repository })))
        }
    }
}

pub fn api(ctx: &Ctx, method: &str, path: &str, data: Option<&str>) -> Result<Json> {
    let config = Config::load();
    let body = data
        .map(serde_json::from_str::<Value>)
        .transpose()
        .map_err(|e| GmError::usage(format!("--data is not valid JSON: {e}")))?;
    let path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    let path = path
        .strip_prefix("/api")
        .map(str::to_string)
        .unwrap_or(path);
    if ctx.dry_run && !method.eq_ignore_ascii_case("GET") {
        return Ok(Json(
            json!({ "dry_run": true, "method": method.to_uppercase(), "url": format!("{}/api{path}", config.server()), "body": body }),
        ));
    }
    Ok(Json(remote::api(&config, method, &path, body.as_ref())?))
}

fn mirror(ctx: &Ctx, config: &Config, command: &MirrorCommand) -> Result<Json> {
    let repo_of = |repo: &Option<String>| match repo {
        Some(r) => Ok(r.clone()),
        None => current_repo(ctx),
    };
    match command {
        MirrorCommand::Show { repo } => {
            let repo = repo_of(repo)?;
            Ok(Json(remote::api(
                config,
                "GET",
                &format!("/repos/{repo}/mirror"),
                None,
            )?))
        }
        MirrorCommand::Set {
            url,
            repo,
            token_stdin,
            username,
            prune,
            no_prune,
            disable,
            enable,
        } => {
            let repo = repo_of(repo)?;
            let mut body = serde_json::Map::new();
            if let Some(url) = url {
                body.insert("url".into(), json!(url));
            }
            if let Some(username) = username {
                body.insert("username".into(), json!(username));
            }
            if *prune || *no_prune {
                body.insert("prune".into(), json!(*prune));
            }
            if *disable || *enable {
                body.insert("enabled".into(), json!(*enable));
            }
            if *token_stdin {
                let mut token = String::new();
                std::io::stdin().read_to_string(&mut token)?;
                let token = token.trim();
                if token.is_empty() {
                    return Err(GmError::usage(
                        "--token-stdin read nothing; pipe the token in.",
                    ));
                }
                body.insert("token".into(), json!(token));
            }
            if ctx.dry_run {
                body.remove("token");
                return Ok(Json(
                    json!({ "dry_run": true, "repo": repo, "request": body }),
                ));
            }
            Ok(Json(remote::api(
                config,
                "PUT",
                &format!("/repos/{repo}/mirror"),
                Some(&serde_json::Value::Object(body)),
            )?))
        }
        MirrorCommand::Sync { repo } => {
            let repo = repo_of(repo)?;
            if ctx.dry_run {
                return Ok(Json(json!({ "dry_run": true, "sync": repo })));
            }
            Ok(Json(remote::api(
                config,
                "POST",
                &format!("/repos/{repo}/mirror/sync"),
                None,
            )?))
        }
        MirrorCommand::Remove { repo } => {
            let repo = repo_of(repo)?;
            if ctx.dry_run {
                return Ok(Json(json!({ "dry_run": true, "remove": repo })));
            }
            remote::api(config, "DELETE", &format!("/repos/{repo}/mirror"), None)?;
            Ok(Json(json!({ "removed": repo })))
        }
    }
}
