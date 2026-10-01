//! Commands for the Gitmatrix server itself: sign-in, repositories, raw API.

use super::Ctx;
use crate::cli::{AuthCommand, RepoCommand};
use crate::model::Json;
use crate::output::{GmError, Result, exit};
use crate::remote::{self, Config};
use serde_json::{Value, json};

pub fn auth(ctx: &Ctx, command: &AuthCommand) -> Result<Json> {
    let mut config = Config::load();
    match command {
        AuthCommand::Login {
            persona,
            token,
            server,
        } => {
            if let Some(server) = server {
                config.server = Some(server.trim_end_matches('/').to_string());
            }
            let secret = match (persona, token) {
                (_, Some(token)) => token.clone(),
                (Some(persona), None) => {
                    let unsigned = Config {
                        token: None,
                        ..config.clone()
                    };
                    let created = remote::api(
                        &unsigned,
                        "POST",
                        "/dev/tokens",
                        Some(&json!({ "persona": persona, "name": "gm CLI" })),
                    )?;
                    created["secret"]
                        .as_str()
                        .map(str::to_string)
                        .ok_or_else(|| {
                            GmError::new("server_error", "The server returned no token.")
                        })?
                }
                (None, None) => {
                    return Err(
                        GmError::usage("Pass --persona <name> (dev) or --token gmx_….")
                            .hint("Dev personas: `gm api GET /personas` lists them."),
                    );
                }
            };
            if ctx.dry_run {
                return Ok(Json(json!({ "dry_run": true, "server": config.server() })));
            }
            config.token = Some(secret);
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
            Ok(Json(json!({
                "server": config.server(),
                "user": { "slug": viewer["slug"], "displayName": viewer["displayName"], "isSiteAdmin": viewer["isSiteAdmin"] },
                "message": format!("Signed in to {} as {}.", config.server(), viewer["slug"].as_str().unwrap_or("?")),
            })))
        }
        AuthCommand::Status => {
            if config.token().is_none() {
                return Ok(Json(
                    json!({ "server": config.server(), "user": null, "hint": "Sign in with `gm auth login --persona <name>`." }),
                ));
            }
            let session = remote::api(&config, "GET", "/session", None)?;
            Ok(Json(
                json!({ "server": config.server(), "user": session["viewer"] }),
            ))
        }
        AuthCommand::Logout => {
            if !ctx.dry_run {
                config.token = None;
                config.user = None;
                config.save()?;
            }
            Ok(Json(
                json!({ "server": config.server(), "signed_out": true }),
            ))
        }
    }
}

/// owner/name of the repository in the current directory, from its origin URL.
fn current_repo(ctx: &Ctx) -> Result<String> {
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
