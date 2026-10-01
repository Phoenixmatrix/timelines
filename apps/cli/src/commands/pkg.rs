//! Packages: what an owner publishes, each package's history (queried like
//! the web console), housekeeping, the repositories allowed to publish, and
//! setting up package tools on this machine. In a CI job gm acts as the job
//! (GITMATRIX_URL / GITMATRIX_TOKEN), so `gm pkg upload` needs no setup there.

use super::Ctx;
use super::server::current_repo;
use crate::cli::{PkgAction, PkgCommand};
use crate::output::{GmError, Render, Result};
use crate::remote::{self, Config};
use serde::{Serialize, Serializer};
use serde_json::{Value, json};
use std::io::Write;
use std::process::{Command, Stdio};

pub struct Shown {
    value: Value,
    text: String,
}

impl Serialize for Shown {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        self.value.serialize(s)
    }
}

impl Render for Shown {
    fn text(&self) -> String {
        self.text.clone()
    }
}

const FORMATS: &[&str] = &[
    "npm", "oci", "pypi", "maven", "cargo", "go", "helm", "apt", "rpm", "brew", "generic",
    "releases",
];

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}

/// Percent-encode everything but unreserved characters (one path segment).
fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// `npm/@orbit/web` → ("npm", "@orbit/web"). `docker/` is accepted for `oci/`.
fn split_package(package: &str) -> Result<(String, String)> {
    let (format, name) = package.split_once('/').ok_or_else(|| {
        GmError::usage(format!(
            "Name the package as <format>/<name>, like npm/{package} or oci/{package}."
        ))
    })?;
    let format = if format == "docker" { "oci" } else { format };
    if !FORMATS.contains(&format) || name.is_empty() {
        return Err(GmError::usage(format!(
            "`{format}` isn't a package format. Use one of: {}.",
            FORMATS.join(", ")
        )));
    }
    Ok((format.to_string(), name.to_string()))
}

/// --owner, else the CI job's owner, else this repository's, else you.
fn owner(ctx: &Ctx, config: &Config, explicit: &Option<String>) -> Result<String> {
    if let Some(o) = explicit {
        return Ok(o.clone());
    }
    if let Ok(o) = std::env::var("GITMATRIX_OWNER")
        && !o.is_empty()
    {
        return Ok(o);
    }
    if let Ok(repo) = current_repo(ctx)
        && let Some((o, _)) = repo.split_once('/')
    {
        return Ok(o.to_string());
    }
    let session = remote::api(config, "GET", "/session", None)?;
    session["viewer"]["slug"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| GmError::usage("Name the owner with --owner, or sign in."))
}

fn base(owner: &str, format: &str, name: &str) -> String {
    format!("/packages/{owner}/{format}/{}", encode(name))
}

fn publish_line(row: &Value) -> String {
    let status = s(row, "status");
    let source = match (row["repo"].as_str(), row["commit"].as_str()) {
        (Some(repo), Some(commit)) => format!("{repo}@{}", commit.get(..7).unwrap_or(commit)),
        _ => s(row, "actor").to_string(),
    };
    let tags = row["tags"]
        .as_array()
        .map(|t| {
            t.iter()
                .filter_map(Value::as_str)
                .map(|t| format!(" [{t}]"))
                .collect::<String>()
        })
        .unwrap_or_default();
    format!(
        "{:<36} {:<24} {:<20} {:<7} {}{}{}",
        s(row, "version"),
        source,
        row["ref"].as_str().unwrap_or("-"),
        row["runNumber"]
            .as_i64()
            .map(|n| format!("#{n}"))
            .unwrap_or_default(),
        s(row, "at").get(..16).unwrap_or("").replace('T', " "),
        if status == "active" {
            String::new()
        } else {
            format!(" ({status})")
        },
        tags,
    )
}

pub fn pkg(ctx: &Ctx, command: &PkgCommand) -> Result<Shown> {
    let config = Config::load();
    match command {
        PkgCommand::List { owner: o } => {
            let owner = owner(ctx, &config, o)?;
            let value = remote::api(&config, "GET", &format!("/packages/{owner}"), None)?;
            let packages = value["packages"].as_array().cloned().unwrap_or_default();
            let text = if packages.is_empty() {
                format!("{owner} hasn't published anything you can see.")
            } else {
                packages
                    .iter()
                    .map(|p| {
                        format!(
                            "{:<8} {:<32} {:<36} {:>6} today  {}",
                            s(p, "format"),
                            s(p, "name"),
                            p["latest"].as_str().unwrap_or("-"),
                            p["publishes24h"],
                            p["sources"]
                                .as_array()
                                .map(|s| s
                                    .iter()
                                    .filter_map(Value::as_str)
                                    .collect::<Vec<_>>()
                                    .join(", "))
                                .unwrap_or_default(),
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            Ok(Shown { value, text })
        }
        PkgCommand::Show { package, owner: o } => {
            let (format, name) = split_package(package)?;
            let owner = owner(ctx, &config, o)?;
            let value = remote::api(&config, "GET", &base(&owner, &format, &name), None)?;
            let p = &value["package"];
            let mut text = format!(
                "{} ({format}) in {owner}\nlatest {}  ·  {} installable  ·  {} publishes  ·  {} today\n",
                s(p, "name"),
                p["latest"].as_str().unwrap_or("-"),
                p["versions"],
                value["totals"]["publishes"],
                p["publishes24h"],
            );
            if let Some(tags) = value["tags"].as_object()
                && !tags.is_empty()
            {
                text.push_str("tags ");
                text.push_str(
                    &tags
                        .iter()
                        .map(|(t, v)| format!("{t}={}", v.as_str().unwrap_or("")))
                        .collect::<Vec<_>>()
                        .join("  "),
                );
                text.push('\n');
            }
            let sources = value["sources"].as_array().cloned().unwrap_or_default();
            text.push_str(&format!(
                "published from {}\n",
                if sources.is_empty() {
                    "no repository yet".to_string()
                } else {
                    sources
                        .iter()
                        .map(|s| s["repo"].as_str().unwrap_or("(deleted)").to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                }
            ));
            Ok(Shown { value, text })
        }
        PkgCommand::Versions {
            package,
            query,
            limit,
            offset,
            owner: o,
        } => {
            let (format, name) = split_package(package)?;
            let owner = owner(ctx, &config, o)?;
            let value = remote::api(
                &config,
                "GET",
                &format!(
                    "{}/publishes?q={}&limit={limit}&offset={offset}",
                    base(&owner, &format, &name),
                    encode(query)
                ),
                None,
            )?;
            let rows = value["rows"].as_array().cloned().unwrap_or_default();
            let mut text = format!(
                "{} publishes match `{query}`{}\n",
                value["total"],
                if rows.len() < value["total"].as_u64().unwrap_or(0) as usize {
                    format!(" (showing {}–{})", offset + 1, offset + rows.len())
                } else {
                    String::new()
                }
            );
            text.push_str(&rows.iter().map(publish_line).collect::<Vec<_>>().join("\n"));
            Ok(Shown { value, text })
        }
        PkgCommand::Delete(a) => act(ctx, &config, "delete", a, None),
        PkgCommand::Yank(a) => act(ctx, &config, "yank", a, None),
        PkgCommand::Restore(a) => act(ctx, &config, "unyank", a, None),
        PkgCommand::Deprecate(a) => act(ctx, &config, "deprecate", a, None),
        PkgCommand::Tag {
            package,
            version,
            tag,
            owner: o,
        } => {
            let action = PkgAction {
                package: package.clone(),
                versions: vec![version.clone()],
                query: None,
                reason: None,
                owner: o.clone(),
            };
            act(ctx, &config, "tag", &action, Some(tag))
        }
        PkgCommand::Sources { package, owner: o } => {
            let (format, name) = split_package(package)?;
            let owner = owner(ctx, &config, o)?;
            let detail = remote::api(&config, "GET", &base(&owner, &format, &name), None)?;
            let value = json!({ "sources": detail["sources"] });
            Ok(Shown {
                text: sources_text(&value["sources"]),
                value,
            })
        }
        PkgCommand::Grant {
            package,
            repo,
            owner: o,
        } => {
            let (format, name) = split_package(package)?;
            let owner = owner(ctx, &config, o)?;
            if ctx.dry_run {
                return Ok(Shown {
                    text: format!("Would let {repo} publish {package}."),
                    value: json!({ "dry_run": true, "grant": repo }),
                });
            }
            let value = remote::api(
                &config,
                "POST",
                &format!("{}/sources", base(&owner, &format, &name)),
                Some(&json!({ "repo": repo })),
            )?;
            Ok(Shown {
                text: sources_text(&value["sources"]),
                value,
            })
        }
        PkgCommand::Revoke {
            package,
            repo,
            owner: o,
        } => {
            let (format, name) = split_package(package)?;
            let owner = owner(ctx, &config, o)?;
            let path = base(&owner, &format, &name);
            let detail = remote::api(&config, "GET", &path, None)?;
            let wanted = if repo.contains('/') {
                repo.clone()
            } else {
                format!("{owner}/{repo}")
            };
            let id = detail["sources"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|s| s["repo"].as_str() == Some(&wanted))
                .and_then(|s| s["repoId"].as_str())
                .ok_or_else(|| {
                    GmError::not_found(
                        "not_a_source",
                        format!("{wanted} isn't a source of {package}."),
                    )
                })?
                .to_string();
            if ctx.dry_run {
                return Ok(Shown {
                    text: format!("Would stop {wanted} publishing {package}."),
                    value: json!({ "dry_run": true, "revoke": wanted }),
                });
            }
            let value = remote::api(&config, "DELETE", &format!("{path}/sources/{id}"), None)?;
            Ok(Shown {
                text: sources_text(&value["sources"]),
                value,
            })
        }
        PkgCommand::Published { run, commit, repo } => {
            let repo = match repo {
                Some(r) => r.clone(),
                None => std::env::var("GITMATRIX_REPOSITORY")
                    .ok()
                    .filter(|r| !r.is_empty())
                    .map_or_else(|| current_repo(ctx), Ok)?,
            };
            let selector = match (run, commit) {
                (Some(n), _) => format!("run={n}"),
                (None, Some(c)) => format!("commit={c}"),
                // Inside a CI job: this run.
                (None, None)
                    if std::env::var("GITMATRIX_RUN_NUMBER").is_ok_and(|n| !n.is_empty()) =>
                {
                    format!(
                        "run={}",
                        std::env::var("GITMATRIX_RUN_NUMBER").unwrap_or_default()
                    )
                }
                (None, None) => {
                    let runs = remote::api(&config, "GET", &format!("/repos/{repo}/ci"), None)?;
                    let n = runs["runs"][0]["number"].as_i64().ok_or_else(|| {
                        GmError::not_found("no_runs", format!("{repo} has no CI runs yet."))
                    })?;
                    format!("run={n}")
                }
            };
            let value = remote::api(
                &config,
                "GET",
                &format!("/packages/-/published?repo={}&{selector}", encode(&repo)),
                None,
            )?;
            let rows = value["rows"].as_array().cloned().unwrap_or_default();
            let text = if rows.is_empty() {
                format!("Nothing published ({selector}).")
            } else {
                rows.iter()
                    .map(|r| {
                        format!(
                            "{:<8} {:<32} {}{}",
                            s(r, "format"),
                            s(r, "package"),
                            s(r, "version"),
                            if s(r, "status") == "active" {
                                String::new()
                            } else {
                                format!(" ({})", s(r, "status"))
                            }
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            Ok(Shown { value, text })
        }
        PkgCommand::Upload {
            file,
            target,
            owner: o,
        } => {
            let owner = owner(ctx, &config, o)?;
            let mut parts: Vec<&str> = target.split('/').filter(|p| !p.is_empty()).collect();
            if parts.len() < 2 {
                return Err(GmError::usage(
                    "Name where it goes as <name>/<version>[/<path>], like app/1.4.0.",
                ));
            }
            let file_name = file
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| GmError::usage("That isn't a file."))?
                .to_string();
            if parts.len() == 2 {
                parts.push(&file_name);
            }
            let path = format!(
                "/generic/{owner}/{}",
                parts
                    .iter()
                    .map(|p| encode(p))
                    .collect::<Vec<_>>()
                    .join("/")
            );
            let bytes = std::fs::read(file)?;
            if ctx.dry_run {
                return Ok(Shown {
                    text: format!("Would upload {} bytes to {path}.", bytes.len()),
                    value: json!({ "dry_run": true, "path": path, "size": bytes.len() }),
                });
            }
            let value = remote::upload(&config, &path, bytes)?;
            Ok(Shown {
                text: format!(
                    "Uploaded {}",
                    value["downloadUri"].as_str().unwrap_or(&path)
                ),
                value,
            })
        }
        PkgCommand::Setup { owner: o, write } => setup(ctx, &config, o, write),
    }
}

fn sources_text(sources: &Value) -> String {
    let list = sources.as_array().cloned().unwrap_or_default();
    if list.is_empty() {
        return "No repository publishes it yet; the first CI job to publish it claims it.".into();
    }
    list.iter()
        .map(|s| {
            format!(
                "{:<32} {} publishes",
                s["repo"].as_str().unwrap_or("(deleted repository)"),
                s["publishes"]
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn act(
    ctx: &Ctx,
    config: &Config,
    action: &str,
    a: &PkgAction,
    tag: Option<&String>,
) -> Result<Shown> {
    let (format, name) = split_package(&a.package)?;
    let owner = owner(ctx, config, &a.owner)?;
    if a.versions.is_empty() && a.query.is_none() {
        return Err(GmError::usage(
            "Name the versions, or select them with --query (e.g. -q \"branch:feature/* since:30d\").",
        ));
    }
    let mut body = if let Some(q) = &a.query {
        json!({ "action": action, "query": q })
    } else {
        json!({ "action": action, "versions": a.versions })
    };
    if let Some(reason) = &a.reason {
        body["reason"] = json!(reason);
    }
    if let Some(tag) = tag {
        body["tag"] = json!(tag);
    }
    let path = format!("{}/actions", base(&owner, &format, &name));
    if ctx.dry_run {
        let what = match &a.query {
            Some(q) => {
                let page = remote::api(
                    config,
                    "GET",
                    &format!(
                        "{}/publishes?q={}&limit=1",
                        base(&owner, &format, &name),
                        encode(q)
                    ),
                    None,
                )?;
                format!(
                    "the versions among {} publishes matching `{q}`",
                    page["total"]
                )
            }
            None => a.versions.join(", "),
        };
        return Ok(Shown {
            text: format!("Would {action} {what} of {}.", a.package),
            value: json!({ "dry_run": true, "request": body }),
        });
    }
    let value = remote::api(config, "POST", &path, Some(&body))?;
    let done = value["done"].as_array().map_or(0, Vec::len);
    let mut text = format!("{action}: {done} version(s) of {}", a.package);
    for f in value["failed"].as_array().into_iter().flatten() {
        text.push_str(&format!("\n  {}: {}", s(f, "version"), s(f, "error")));
    }
    if let Some(n) = value["remaining"].as_u64().filter(|n| *n > 0) {
        text.push_str(&format!("\n{n} more match; run it again to continue."));
    }
    Ok(Shown { value, text })
}

/// Client configuration for an owner's registries on this machine.
fn setup(ctx: &Ctx, config: &Config, o: &Option<String>, write: &[String]) -> Result<Shown> {
    let owner = owner(ctx, config, o)?;
    let server = config.server();
    let host = server
        .split("://")
        .nth(1)
        .unwrap_or(&server)
        .trim_end_matches('/')
        .to_string();
    let (token, _) = remote::credential(config)?;
    let token = token.ok_or_else(|| {
        GmError::new("unauthenticated", "Sign in first: `gm auth login`.")
            .exit(crate::output::exit::AUTH)
    })?;
    let npmrc = format!(
        "@{owner}:registry={server}/npm/{owner}/\n//{host}/npm/{owner}/:_authToken={token}\n"
    );
    let value = json!({
        "owner": owner,
        "npmrc": npmrc,
        "docker": { "registry": host, "imagePrefix": format!("{host}/{owner}") },
        "pip": { "indexUrl": format!("{server}/pypi/{owner}/simple/") },
        "cargo": { "index": format!("sparse+{server}/cargo/{owner}/index/") },
        "goproxy": format!("{server}/go/{owner}"),
        "maven": format!("{server}/maven/{owner}/"),
        "helm": format!("{server}/helm/{owner}"),
        "generic": format!("{server}/generic/{owner}/"),
    });
    let mut text = format!(
        "Registries for {owner} on {server}\n\n\
         npm      add to ~/.npmrc (or run with --write npm):\n{}\n\
         docker   echo $TOKEN | docker login {host} -u {owner} --password-stdin   (or --write docker)\n\
         \x20        images are {host}/{owner}/<name>:<tag>\n\
         pip/uv   --index-url {server}/pypi/{owner}/simple/\n\
         cargo    [registries.{owner}] index = \"sparse+{server}/cargo/{owner}/index/\"\n\
         go       GOPROXY={server}/go/{owner},https://proxy.golang.org,direct\n\
         maven    {server}/maven/{owner}/\n\
         helm     helm repo add {owner} {server}/helm/{owner}\n\
         files    gm pkg upload <file> <name>/<version>\n",
        npmrc
            .lines()
            .map(|l| format!("         {l}"))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    if ctx.dry_run {
        return Ok(Shown { value, text });
    }
    for target in write {
        match target.as_str() {
            "npm" => {
                let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
                let path = std::path::Path::new(&home).join(".npmrc");
                let existing = std::fs::read_to_string(&path).unwrap_or_default();
                let kept: String = existing
                    .lines()
                    .filter(|l| {
                        !l.starts_with(&format!("@{owner}:registry="))
                            && !l.starts_with(&format!("//{host}/npm/{owner}/:"))
                    })
                    .map(|l| format!("{l}\n"))
                    .collect();
                std::fs::write(&path, format!("{kept}{npmrc}"))?;
                text.push_str(&format!(
                    "\nWrote the {owner} registry to {}.",
                    path.display()
                ));
            }
            "docker" => {
                let mut child = Command::new("docker")
                    .args(["login", &host, "-u", &owner, "--password-stdin"])
                    .stdin(Stdio::piped())
                    .stdout(Stdio::null())
                    .stderr(Stdio::piped())
                    .spawn()
                    .map_err(|e| {
                        GmError::new("docker_missing", format!("Can't run docker: {e}"))
                    })?;
                child
                    .stdin
                    .take()
                    .expect("piped")
                    .write_all(token.as_bytes())?;
                let out = child.wait_with_output()?;
                if !out.status.success() {
                    return Err(GmError::new(
                        "docker_login_failed",
                        String::from_utf8_lossy(&out.stderr).trim().to_string(),
                    ));
                }
                text.push_str(&format!("\nDocker is signed in to {host}."));
            }
            other => {
                return Err(GmError::usage(format!(
                    "--write takes npm and docker, not `{other}`."
                )));
            }
        }
    }
    Ok(Shown { value, text })
}
