//! Packages: what a Space publishes, each package's history (queried like
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
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::Path;
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
pub(crate) fn encode(text: &str) -> String {
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

/// --space, else the CI job's Space, this repository's, or the authorized personal default.
fn space(ctx: &Ctx, config: &Config, explicit: &Option<String>) -> Result<String> {
    if let Some(o) = explicit {
        return Ok(o.clone());
    }
    if let Ok(o) = std::env::var("GITMATRIX_SPACE")
        && !o.is_empty()
    {
        return Ok(o);
    }
    if let Ok(repo) = current_repo(ctx)
        && let Some((o, _)) = repo.split_once('/')
    {
        return Ok(o.to_string());
    }
    remote::default_space(config)
}

fn base(space: &str, format: &str, name: &str) -> String {
    format!("/packages/{space}/{format}/{}", encode(name))
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
        PkgCommand::List { space: o } => {
            let space = space(ctx, &config, o)?;
            let value = remote::api(&config, "GET", &format!("/packages/{space}"), None)?;
            let packages = value["packages"].as_array().cloned().unwrap_or_default();
            let text = if packages.is_empty() {
                format!("{space} hasn't published anything you can see.")
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
        PkgCommand::Show { package, space: o } => {
            let (format, name) = split_package(package)?;
            let space = space(ctx, &config, o)?;
            let value = remote::api(&config, "GET", &base(&space, &format, &name), None)?;
            let p = &value["package"];
            let mut text = format!(
                "{} ({format}) in {space}\nlatest {}  ·  {} installable  ·  {} publishes  ·  {} today\n",
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
            space: o,
        } => {
            let (format, name) = split_package(package)?;
            let space = space(ctx, &config, o)?;
            let value = remote::api(
                &config,
                "GET",
                &format!(
                    "{}/publishes?q={}&limit={limit}&offset={offset}",
                    base(&space, &format, &name),
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
            space: o,
        } => {
            let action = PkgAction {
                package: package.clone(),
                versions: vec![version.clone()],
                query: None,
                reason: None,
                space: o.clone(),
            };
            act(ctx, &config, "tag", &action, Some(tag))
        }
        PkgCommand::Sources { package, space: o } => {
            let (format, name) = split_package(package)?;
            let space = space(ctx, &config, o)?;
            let detail = remote::api(&config, "GET", &base(&space, &format, &name), None)?;
            let value = json!({ "sources": detail["sources"] });
            Ok(Shown {
                text: sources_text(&value["sources"]),
                value,
            })
        }
        PkgCommand::Grant {
            package,
            repo,
            space: o,
        } => {
            let (format, name) = split_package(package)?;
            let space = space(ctx, &config, o)?;
            if ctx.dry_run {
                return Ok(Shown {
                    text: format!("Would let {repo} publish {package}."),
                    value: json!({ "dry_run": true, "grant": repo }),
                });
            }
            let value = remote::api(
                &config,
                "POST",
                &format!("{}/sources", base(&space, &format, &name)),
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
            space: o,
        } => {
            let (format, name) = split_package(package)?;
            let space = space(ctx, &config, o)?;
            let path = base(&space, &format, &name);
            let detail = remote::api(&config, "GET", &path, None)?;
            let wanted = if repo.contains('/') {
                repo.clone()
            } else {
                format!("{space}/{repo}")
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
            space: o,
        } => {
            let space = space(ctx, &config, o)?;
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
                "/generic/{space}/{}",
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
        PkgCommand::Download {
            target,
            space: o,
            dest,
            force,
        } => {
            let space = space(ctx, &config, o)?;
            let destination = dest
                .clone()
                .unwrap_or_else(|| target.rsplit('/').next().unwrap_or("").into());
            save_artifact(
                ctx,
                &config,
                &space,
                target,
                &ctx.cwd.join(destination),
                *force,
                false,
            )
        }
        PkgCommand::Install {
            name,
            space: o,
            version,
            file,
            bin_dir,
            force,
        } => {
            path_segment(name)?;
            let space = space(ctx, &config, o)?;
            let platform = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
            let file = file.clone().unwrap_or_else(|| format!("{platform}/{name}"));
            let directory = match bin_dir {
                Some(directory) => directory.clone(),
                None => std::env::var_os("HOME")
                    .filter(|home| !home.is_empty())
                    .map(|home| std::path::PathBuf::from(home).join(".local/bin"))
                    .ok_or_else(|| GmError::usage("Set HOME or choose --bin-dir."))?,
            };
            let destination = ctx.cwd.join(directory).join(name);
            let mut shown = save_artifact(
                ctx,
                &config,
                &space,
                &format!("{name}/{version}/{file}"),
                &destination,
                *force,
                true,
            )?;
            shown.value["platform"] = json!(platform);
            if !std::env::var_os("PATH").is_some_and(|paths| {
                std::env::split_paths(&paths).any(|path| path == destination.parent().unwrap())
            }) {
                shown.text.push_str(&format!(
                    "\nAdd {} to PATH to run {name} by name.",
                    destination.parent().unwrap().display()
                ));
            }
            Ok(shown)
        }
        PkgCommand::Setup { space: o, write } => setup(ctx, &config, o, write),
    }
}

fn path_segment(segment: &str) -> Result<()> {
    if segment.is_empty()
        || segment == "."
        || segment == ".."
        || segment.contains(['/', '\\', '\0'])
    {
        return Err(GmError::usage(
            "Artifact names and path segments must be nonempty, without traversal or separators.",
        ));
    }
    Ok(())
}

fn check_destination(path: &Path, force: bool) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_file() => Err(GmError::new(
            "unsafe_destination",
            format!("Refusing non-regular destination {}.", path.display()),
        )),
        Ok(_) if !force => Err(GmError::new(
            "already_exists",
            format!(
                "{} already exists; use --force to replace it.",
                path.display()
            ),
        )
        .exit(crate::output::exit::CONFLICT)),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn save_artifact(
    ctx: &Ctx,
    config: &Config,
    space: &str,
    target: &str,
    destination: &Path,
    force: bool,
    install: bool,
) -> Result<Shown> {
    use std::os::unix::fs::PermissionsExt;
    path_segment(space)?;
    let mut segments = target.splitn(3, '/');
    let name = segments.next().unwrap_or("");
    let requested = segments.next().unwrap_or("");
    let file = segments.next().ok_or_else(|| {
        GmError::usage("Use <name>/<version>/<path>, such as gm/latest/linux-x86_64/gm.")
    })?;
    for segment in [name, requested].into_iter().chain(file.split('/')) {
        path_segment(segment)?;
    }
    check_destination(destination, force)?;
    let version = if requested == "latest" {
        let detail = remote::api(config, "GET", &base(&encode(space), "generic", name), None)?;
        detail["package"]["latest"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| {
                GmError::not_found("not_found", "This package has no published version.")
            })?
            .to_string()
    } else {
        requested.to_string()
    };
    path_segment(&version)?;
    let path = format!(
        "/generic/{}/{}/{}/{}",
        encode(space),
        encode(name),
        encode(&version),
        file.split('/').map(encode).collect::<Vec<_>>().join("/")
    );
    let mut response = remote::artifact(config, &path, ctx.dry_run)?;
    let expected = response
        .headers()
        .get("x-checksum-sha256")
        .and_then(|v| v.to_str().ok())
        .filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| {
            GmError::new(
                "missing_checksum",
                "Artifact has no valid SHA-256 checksum; refusing to save it.",
            )
        })?
        .to_ascii_lowercase();
    let mut size = response
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if !ctx.dry_run {
        let parent = destination
            .parent()
            .ok_or_else(|| GmError::usage("Choose a destination file."))?;
        if install {
            std::fs::create_dir_all(parent)?;
        }
        let mut temporary = tempfile::Builder::new()
            .prefix(".gm-download-")
            .tempfile_in(parent)?;
        let mut reader = response.body_mut().as_reader();
        let mut hash = Sha256::new();
        let mut count = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let n = reader.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            temporary.write_all(&buffer[..n])?;
            hash.update(&buffer[..n]);
            count += n as u64;
        }
        let actual = format!("{:x}", hash.finalize());
        if actual != expected || size.is_some_and(|size| size != count) {
            return Err(GmError::new(
                "checksum_mismatch",
                "Artifact content does not match its checksum or size; destination was not changed.",
            ));
        }
        size = Some(count);
        if install {
            temporary
                .as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o755))?;
        }
        temporary.as_file().sync_all()?;
        check_destination(destination, force)?;
        let persisted = if force {
            temporary.persist(destination)
        } else {
            temporary.persist_noclobber(destination)
        };
        persisted.map_err(|error| GmError::from(error.error))?;
    }
    Ok(Shown {
        value: json!({
            "path": destination.to_string_lossy(), "version": version, "sha256": expected,
            "size": size, "dry_run": ctx.dry_run, "installed": install && !ctx.dry_run,
        }),
        text: format!(
            "{} {} to {} (version {version}, SHA-256 {expected}).",
            if ctx.dry_run {
                "Would save"
            } else if install {
                "Installed"
            } else {
                "Downloaded"
            },
            name,
            destination.display()
        ),
    })
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
    let space = space(ctx, config, &a.space)?;
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
    let path = format!("{}/actions", base(&space, &format, &name));
    if ctx.dry_run {
        let what = match &a.query {
            Some(q) => {
                let page = remote::api(
                    config,
                    "GET",
                    &format!(
                        "{}/publishes?q={}&limit=1",
                        base(&space, &format, &name),
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

/// Client configuration for a Space's registries on this machine.
fn setup(ctx: &Ctx, config: &Config, o: &Option<String>, write: &[String]) -> Result<Shown> {
    let space = space(ctx, config, o)?;
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
        "@{space}:registry={server}/npm/{space}/\n//{host}/npm/{space}/:_authToken={token}\n"
    );
    let value = json!({
        "space": space,
        "npmrc": npmrc,
        "docker": { "registry": host, "imagePrefix": format!("{host}/{space}") },
        "pip": { "indexUrl": format!("{server}/pypi/{space}/simple/") },
        "cargo": { "index": format!("sparse+{server}/cargo/{space}/index/") },
        "goproxy": format!("{server}/go/{space}"),
        "maven": format!("{server}/maven/{space}/"),
        "helm": format!("{server}/helm/{space}"),
        "generic": format!("{server}/generic/{space}/"),
    });
    let mut text = format!(
        "Registries for {space} on {server}\n\n\
         npm      add to ~/.npmrc (or run with --write npm):\n{}\n\
         docker   echo $TOKEN | docker login {host} -u {space} --password-stdin   (or --write docker)\n\
         \x20        images are {host}/{space}/<name>:<tag>\n\
         pip/uv   --index-url {server}/pypi/{space}/simple/\n\
         cargo    [registries.{space}] index = \"sparse+{server}/cargo/{space}/index/\"\n\
         go       GOPROXY={server}/go/{space},https://proxy.golang.org,direct\n\
         maven    {server}/maven/{space}/\n\
         helm     helm repo add {space} {server}/helm/{space}\n\
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
                        !l.starts_with(&format!("@{space}:registry="))
                            && !l.starts_with(&format!("//{host}/npm/{space}/:"))
                    })
                    .map(|l| format!("{l}\n"))
                    .collect();
                std::fs::write(&path, format!("{kept}{npmrc}"))?;
                text.push_str(&format!(
                    "\nWrote the {space} registry to {}.",
                    path.display()
                ));
            }
            "docker" => {
                let mut child = Command::new("docker")
                    .args(["login", &host, "-u", &space, "--password-stdin"])
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
