//! Account-wide policy for automatic AI work; never inferred from a repository.
//! With `--site`, the site's defaults (site administrators): today, whether AI
//! Gateway logs keep request and response bodies (CORE-290).

use super::Ctx;
use crate::model::Json;
use crate::output::{GmError, Result, exit};
use crate::remote::{self, Acting, Config};
use clap::{Args, Subcommand};
use serde_json::{Map, Value, json};

#[derive(Subcommand)]
pub enum SettingsCommand {
    /// Automatic AI features and curated models for a person or organization
    #[command(subcommand)]
    Ai(AiCommand),
    /// Installation-wide environment quota and this machine's memory limit
    #[command(subcommand)]
    Environments(EnvironmentCommand),
}

#[derive(Subcommand)]
pub enum EnvironmentCommand {
    /// Show the local cap/authority, or the installation-wide quota with --site
    Show(EnvironmentScope),
    /// Set the local cap/explicit quota authority, or the site maximum (human admin)
    Set(EnvironmentSetArgs),
}

#[derive(Args)]
#[group(required = true, multiple = false)]
pub struct EnvironmentScope {
    /// This OS user's machine, shared across its worktrees.
    #[arg(long)]
    local: bool,
    /// The current gm server's installation-wide quota.
    #[arg(long)]
    site: bool,
}

#[derive(Args)]
pub struct EnvironmentSetArgs {
    #[command(flatten)]
    scope: EnvironmentScope,
    /// Maximum live environments; 0 pauses new allocations. Default: 4.
    #[arg(long, value_parser = clap::value_parser!(u32).range(0..=2147483647))]
    max: Option<u32>,
    /// Explicit shared Gitmatrix quota authority URL (--local only). Every host
    /// managing the same installation must use the same authority.
    #[arg(long, requires = "local", conflicts_with = "site", value_parser = environment_authority)]
    authority: Option<String>,
}

fn environment_authority(value: &str) -> std::result::Result<String, String> {
    let uri: ureq::http::Uri = value
        .parse()
        .map_err(|_| "Use an absolute http(s) authority URL.")?;
    let scheme = uri
        .scheme_str()
        .ok_or("Use an absolute http(s) authority URL.")?;
    let authority = uri
        .authority()
        .ok_or("Use an absolute http(s) authority URL.")?;
    let host = authority.host().to_ascii_lowercase();
    if !matches!(scheme, "http" | "https")
        || host.is_empty()
        || authority.as_str().contains('@')
        || host.contains('*')
        || uri.query().is_some()
        || value.contains('#')
        || uri.path() != "/"
    {
        return Err("Use an http(s) origin without credentials, path, query or fragment.".into());
    }
    let default_port = if scheme == "https" { 443 } else { 80 };
    let port = authority.port_u16().unwrap_or(default_port);
    let text = authority.as_str().to_ascii_lowercase();
    if text != host && text != format!("{host}:{port}") {
        return Err("Use a valid authority host and port.".into());
    }
    Ok(if port == default_port {
        format!("{scheme}://{host}")
    } else {
        format!("{scheme}://{host}:{port}")
    })
}

fn environment_settings(ctx: &Ctx, command: &EnvironmentCommand) -> Result<Json> {
    let (scope, maximum, authority) = match command {
        EnvironmentCommand::Show(scope) => (scope, None, None),
        EnvironmentCommand::Set(args) => {
            if args.max.is_none() && args.authority.is_none() {
                return Err(GmError::usage("Provide --max or --authority."));
            }
            (&args.scope, args.max, args.authority.as_ref())
        }
    };
    if scope.site {
        let mut config = Config::load();
        config.acting = Acting::Person;
        let patch = maximum.map(|maximum| json!({ "maximum": maximum }));
        if ctx.dry_run
            && let Some(patch) = &patch
        {
            return Ok(Json(json!({
                "dry_run": true, "site": true, "method": "PATCH",
                "path": "/admin/environments", "request": patch
            })));
        }
        return Ok(Json(remote::api(
            &config,
            if patch.is_some() { "PATCH" } else { "GET" },
            "/admin/environments",
            patch.as_ref(),
        )?));
    }
    let home = std::env::var_os("HOME").ok_or_else(|| {
        GmError::usage("HOME is required for the per-user machine environment limit.")
    })?;
    let directory = std::path::PathBuf::from(home).join(".local/state/gitmatrix-agent");
    let path = directory.join("limits.json");
    // Share the allocator's lock: concurrent partial updates cannot lose fields.
    let _lock = if matches!(command, EnvironmentCommand::Set(_)) && !ctx.dry_run {
        std::fs::create_dir_all(&directory)?;
        let lock = std::fs::File::create(directory.join("registry.lock"))?;
        lock.lock()?;
        Some(lock)
    } else {
        None
    };
    let mut settings: Value = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => json!({ "maximum": 4 }),
        Err(error) => return Err(error.into()),
    };
    if !settings.is_object()
        || settings["maximum"].as_u64().is_none_or(|n| n > 2147483647)
        || settings
            .get("authority")
            .is_some_and(|v| v.as_str().is_none_or(|s| environment_authority(s).is_err()))
    {
        return Err(GmError::usage(format!(
            "Invalid environment limits in {}; repair the file before allocating environments.",
            path.display()
        )));
    }
    if let Some(maximum) = maximum {
        settings["maximum"] = json!(maximum);
    }
    if let Some(authority) = authority {
        settings["authority"] = json!(authority);
    }
    if matches!(command, EnvironmentCommand::Set(_)) {
        if ctx.dry_run {
            return Ok(Json(
                json!({ "dry_run": true, "local": true, "settings": settings }),
            ));
        }
        std::fs::create_dir_all(&directory)?;
        let temporary = directory.join(format!("limits.{}.tmp", std::process::id()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let result = (|| -> std::io::Result<()> {
            use std::io::Write;
            let mut file = options.open(&temporary)?;
            file.write_all(serde_json::to_string_pretty(&settings)?.as_bytes())?;
            file.sync_all()?;
            std::fs::rename(&temporary, &path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result?;
    }
    Ok(Json(json!({
        "scope": "user-machine", "maximum": settings["maximum"],
        "authority": settings.get("authority"), "path": path,
        "note": "The local cap never overrides the shared installation quota. Configure the same explicit authority on every host; it must expose the environment quota API."
    })))
}

#[derive(Subcommand)]
pub enum AiCommand {
    /// Show policy, published model catalog, gateway body logging and your management permission
    Show {
        /// Account slug; defaults to the signed-in person, never the repository owner.
        #[arg(long, value_parser = account_slug, conflicts_with = "site")]
        owner: Option<String>,
        /// The site's defaults instead (site administrators).
        #[arg(long)]
        site: bool,
    },
    /// Change future jobs only; human account/org owner or site admin required
    Set(Box<AiSetArgs>),
}

#[derive(Args)]
#[group(skip)]
#[command(group(clap::ArgGroup::new("ai_changes").required(true).multiple(true).args([
    "knowledge", "wiki", "atlas", "release_notes", "classification", "fast", "task",
    "knowledge_quiet_minutes", "knowledge_max_wait_minutes", "log_bodies"
])))]
pub struct AiSetArgs {
    /// Account slug; defaults to the signed-in person, never the repository owner.
    #[arg(long, value_parser = account_slug, conflicts_with = "site")]
    owner: Option<String>,
    /// Set the site's defaults (site administrators); only --log-bodies applies.
    #[arg(long, conflicts_with_all = [
        "knowledge", "wiki", "atlas", "release_notes", "classification", "fast", "task",
        "knowledge_quiet_minutes", "knowledge_max_wait_minutes"
    ])]
    site: bool,
    /// Knowledge ingestion and embeddings; off also prevents new wiki and Atlas AI work.
    #[arg(long, value_parser = ["on", "off"])]
    knowledge: Option<String>,
    /// Main wiki and timeline checkpoint pages (requires knowledge on).
    #[arg(long, value_parser = ["on", "off"])]
    wiki: Option<String>,
    /// Paid Atlas descriptions, not deterministic projection (requires knowledge on).
    #[arg(long, value_parser = ["on", "off"])]
    atlas: Option<String>,
    /// Automatic release-note generation.
    #[arg(long, value_parser = ["on", "off"])]
    release_notes: Option<String>,
    /// Classification model: clef, or typesafe:<model> added in Settings → AI providers;
    /// see show for published pricing and release dates.
    #[arg(long, value_parser = classification_model)]
    classification: Option<String>,
    /// Fast generation model: glm-5.3-flash, gemma-4-26b-a4b-it, or openrouter:<model>
    /// added in Settings → AI providers; see show for published pricing and release dates.
    #[arg(long, value_parser = generation_model)]
    fast: Option<String>,
    /// Task generation model (as --fast); does not change running jobs or regenerate cached output.
    #[arg(long, value_parser = generation_model)]
    task: Option<String>,
    /// Knowledge updates start once pushes to main pause this long (0-1440 minutes; 0 = no wait).
    #[arg(long, value_parser = clap::value_parser!(u32).range(0..=1440))]
    knowledge_quiet_minutes: Option<u32>,
    /// …and never later than this after the first pending push (0-1440 minutes).
    #[arg(long, value_parser = clap::value_parser!(u32).range(0..=1440))]
    knowledge_max_wait_minutes: Option<u32>,
    /// Keep AI request and response bodies in gateway logs: on|off|default for every
    /// component, or COMPONENT=on|off|default (repeatable). default follows the site
    /// (with --site: the environment). While on, prompts and replies, including
    /// repository code and assistant conversations, are kept in Cloudflare's AI Gateway
    /// logs, readable in the Cloudflare dashboard, and deleted oldest-first.
    #[arg(long = "log-bodies", value_name = "[COMPONENT=]on|off|default", value_parser = log_bodies_choice)]
    log_bodies: Vec<(Option<String>, Option<bool>)>,
}

/// Components with their own body logging setting (shared/ai.ts AI_LOG_COMPONENTS).
const LOG_COMPONENTS: [&str; 6] = [
    "knowledge",
    "assistant",
    "assistant-titles",
    "avatars",
    "release-notes",
    "merge-queue",
];

/// `on`, `off` or `default`, for every component or (`COMPONENT=…`) one.
fn log_bodies_choice(value: &str) -> std::result::Result<(Option<String>, Option<bool>), String> {
    let (component, choice) = match value.split_once('=') {
        Some((component, choice)) => {
            if !LOG_COMPONENTS.contains(&component) {
                return Err(format!(
                    "Unknown component {component}; use one of: {}.",
                    LOG_COMPONENTS.join(", ")
                ));
            }
            (Some(component.to_string()), choice)
        }
        None => (None, value),
    };
    let choice = match choice {
        "on" => Some(true),
        "off" => Some(false),
        "default" => None,
        _ => return Err("Use on, off or default (optionally COMPONENT=on|off|default).".into()),
    };
    Ok((component, choice))
}

fn account_slug(value: &str) -> std::result::Result<String, String> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("Use an account slug, not a repository or URL.".into());
    }
    Ok(value.to_string())
}

/// A curated model id, or `<provider>:<model>` from the account's own provider
/// (CORE-294); the server checks the account actually added that model.
fn model_choice(
    value: &str,
    curated: &[&str],
    provider: &str,
) -> std::result::Result<String, String> {
    if curated.contains(&value) {
        return Ok(value.to_string());
    }
    match value.split_once(':') {
        Some((kind, model))
            if kind == provider && !model.is_empty() && !model.contains(char::is_whitespace) =>
        {
            Ok(value.to_string())
        }
        _ => Err(format!(
            "Use one of {}, or {provider}:<model> for a model added in Settings → AI providers.",
            curated.join(", ")
        )),
    }
}

fn classification_model(value: &str) -> std::result::Result<String, String> {
    model_choice(value, &["clef"], "typesafe")
}

fn generation_model(value: &str) -> std::result::Result<String, String> {
    model_choice(
        value,
        &["glm-5.3-flash", "gemma-4-26b-a4b-it"],
        "openrouter",
    )
}

impl AiSetArgs {
    fn patch(&self) -> Value {
        let mut features = Map::new();
        for (key, value) in [
            ("knowledge", &self.knowledge),
            ("wiki", &self.wiki),
            ("atlas", &self.atlas),
            ("releaseNotes", &self.release_notes),
        ] {
            if let Some(value) = value {
                features.insert(key.into(), json!(value == "on"));
            }
        }
        let mut models = Map::new();
        for (key, value) in [
            ("classification", &self.classification),
            ("fast", &self.fast),
            ("task", &self.task),
        ] {
            if let Some(value) = value {
                models.insert(key.into(), json!(value));
            }
        }
        let mut patch = Map::new();
        if !features.is_empty() {
            patch.insert("features".into(), Value::Object(features));
        }
        if !models.is_empty() {
            patch.insert("models".into(), Value::Object(models));
        }
        let mut updates = Map::new();
        for (key, value) in [
            ("quietMinutes", self.knowledge_quiet_minutes),
            ("maxWaitMinutes", self.knowledge_max_wait_minutes),
        ] {
            if let Some(value) = value {
                updates.insert(key.into(), json!(value));
            }
        }
        if !updates.is_empty() {
            patch.insert("knowledgeUpdates".into(), Value::Object(updates));
        }
        // Later values win, so `--log-bodies on --log-bodies avatars=off` reads naturally.
        let mut log_bodies = Map::new();
        for (component, choice) in &self.log_bodies {
            let value = choice.map_or(Value::Null, Value::Bool);
            match component {
                Some(component) => {
                    log_bodies.insert(component.clone(), value);
                }
                None => {
                    for component in LOG_COMPONENTS {
                        log_bodies.insert(component.into(), value.clone());
                    }
                }
            }
        }
        if !log_bodies.is_empty() {
            patch.insert("logBodies".into(), Value::Object(log_bodies));
        }
        Value::Object(patch)
    }
}

pub fn run(ctx: &Ctx, command: &SettingsCommand) -> Result<Json> {
    // Like agent management, policy administration uses the person's sign-in.
    // Explicit environment tokens still win; only the backend grants authority.
    let mut config = Config::load();
    config.acting = Acting::Person;
    let command = match command {
        SettingsCommand::Ai(command) => command,
        SettingsCommand::Environments(command) => return environment_settings(ctx, command),
    };
    let (explicit, site, patch) = match command {
        AiCommand::Show { owner, site } => (owner, *site, None),
        AiCommand::Set(args) => (&args.owner, args.site, Some(args.patch())),
    };
    if site {
        let path = "/admin/ai";
        if ctx.dry_run
            && let Some(patch) = &patch
        {
            return Ok(Json(json!({
                "dry_run": true, "site": true, "method": "PATCH", "path": path,
                "request": patch
            })));
        }
        return Ok(Json(remote::api(
            &config,
            if patch.is_some() { "PATCH" } else { "GET" },
            path,
            patch.as_ref(),
        )?));
    }
    let owner = match explicit {
        Some(owner) => owner.clone(),
        None => {
            let session = remote::api(&config, "GET", "/session", None)?;
            session["viewer"]["slug"]
                .as_str()
                .ok_or_else(|| {
                    GmError::new("unauthenticated", "Sign in to manage account AI settings.")
                        .hint("Run `gm auth login`, or pass --owner <account>.")
                        .exit(exit::AUTH)
                })?
                .to_string()
        }
    };
    account_slug(&owner).map_err(GmError::usage)?;
    let path = format!("/accounts/{owner}/settings/ai");
    if ctx.dry_run
        && let Some(patch) = &patch
    {
        return Ok(Json(json!({
            "dry_run": true, "owner": owner, "method": "PATCH", "path": path,
            "request": patch
        })));
    }
    Ok(Json(remote::api(
        &config,
        if patch.is_some() { "PATCH" } else { "GET" },
        &path,
        patch.as_ref(),
    )?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Cli, Command};
    use clap::Parser;

    #[test]
    fn environment_limits_require_explicit_scope_and_safe_values() {
        for argv in [
            vec!["gm", "settings", "environments", "show", "--local"],
            vec!["gm", "settings", "environments", "show", "--site"],
            vec![
                "gm",
                "settings",
                "environments",
                "set",
                "--local",
                "--max",
                "0",
            ],
            vec![
                "gm",
                "settings",
                "environments",
                "set",
                "--site",
                "--max",
                "12",
            ],
            vec![
                "gm",
                "settings",
                "environments",
                "set",
                "--local",
                "--authority",
                "https://gitmatrix.example",
                "--max",
                "8",
            ],
        ] {
            assert!(Cli::try_parse_from(&argv).is_ok(), "rejected {argv:?}");
        }
        for argv in [
            vec!["gm", "settings", "environments", "show"],
            vec![
                "gm",
                "settings",
                "environments",
                "show",
                "--local",
                "--site",
            ],
            vec![
                "gm",
                "settings",
                "environments",
                "set",
                "--site",
                "--authority",
                "https://gitmatrix.example",
            ],
            vec![
                "gm",
                "settings",
                "environments",
                "set",
                "--local",
                "--max",
                "-1",
            ],
            vec![
                "gm",
                "settings",
                "environments",
                "set",
                "--local",
                "--max",
                "2147483648",
            ],
            vec![
                "gm",
                "settings",
                "environments",
                "set",
                "--local",
                "--authority",
                "https://token@gitmatrix.example",
            ],
        ] {
            assert!(Cli::try_parse_from(&argv).is_err(), "accepted {argv:?}");
        }
        assert_eq!(
            environment_authority("http://127.0.0.1:19000/").unwrap(),
            "http://127.0.0.1:19000"
        );
    }

    fn parse_set(flags: &[&str]) -> AiSetArgs {
        let mut argv = vec!["gm", "settings", "ai", "set"];
        argv.extend_from_slice(flags);
        let parsed = Cli::try_parse_from(argv).unwrap();
        let Some(Command::Settings(SettingsCommand::Ai(AiCommand::Set(args)))) = parsed.command
        else {
            panic!("expected settings ai set");
        };
        *args
    }

    #[test]
    fn partial_updates_preserve_omitted_fields_and_false() {
        let args = parse_set(&[
            "--knowledge",
            "off",
            "--release-notes",
            "on",
            "--task",
            "gemma-4-26b-a4b-it",
        ]);
        assert_eq!(
            args.patch(),
            json!({
                "features": {"knowledge": false, "releaseNotes": true},
                "models": {"task": "gemma-4-26b-a4b-it"}
            })
        );
    }

    #[test]
    fn knowledge_update_windows_are_minutes() {
        let args = parse_set(&["--knowledge-quiet-minutes", "0"]);
        assert_eq!(
            args.patch(),
            json!({"knowledgeUpdates": {"quietMinutes": 0}})
        );
        let args = parse_set(&[
            "--knowledge-quiet-minutes",
            "15",
            "--knowledge-max-wait-minutes",
            "60",
        ]);
        assert_eq!(
            args.patch(),
            json!({"knowledgeUpdates": {"quietMinutes": 15, "maxWaitMinutes": 60}})
        );
    }

    #[test]
    fn log_bodies_for_every_component_or_one() {
        let args = parse_set(&["--log-bodies", "on"]);
        let all: Map<String, Value> = LOG_COMPONENTS
            .iter()
            .map(|c| (c.to_string(), json!(true)))
            .collect();
        assert_eq!(args.patch(), json!({"logBodies": all}));
        let args = parse_set(&[
            "--log-bodies",
            "off",
            "--log-bodies",
            "assistant=on",
            "--log-bodies",
            "avatars=default",
        ]);
        let patch = args.patch();
        assert_eq!(patch["logBodies"]["knowledge"], json!(false));
        assert_eq!(patch["logBodies"]["assistant"], json!(true));
        assert_eq!(patch["logBodies"]["avatars"], Value::Null);
        assert_eq!(patch["logBodies"].as_object().unwrap().len(), 6);
        let args = parse_set(&["--log-bodies", "merge-queue=off", "--release-notes", "on"]);
        assert_eq!(
            args.patch(),
            json!({"features": {"releaseNotes": true}, "logBodies": {"merge-queue": false}})
        );
    }

    #[test]
    fn provider_models_are_accepted_for_their_roles() {
        let args = parse_set(&[
            "--classification",
            "typesafe:jev-latest",
            "--fast",
            "openrouter:google/gemini-3-flash",
            "--task",
            "gemma-4-26b-a4b-it",
        ]);
        assert_eq!(
            args.patch(),
            json!({"models": {
                "classification": "typesafe:jev-latest",
                "fast": "openrouter:google/gemini-3-flash",
                "task": "gemma-4-26b-a4b-it"
            }})
        );
    }

    #[test]
    fn site_defaults_take_only_log_bodies() {
        let args = parse_set(&["--site", "--log-bodies", "on"]);
        assert!(args.site);
        assert_eq!(args.patch()["logBodies"]["release-notes"], json!(true));
        let parsed = Cli::try_parse_from(["gm", "settings", "ai", "show", "--site"]).unwrap();
        let Some(Command::Settings(SettingsCommand::Ai(AiCommand::Show { site, owner }))) =
            parsed.command
        else {
            panic!("expected settings ai show");
        };
        assert!(site && owner.is_none());
        for flags in [
            vec!["--site"],
            vec!["--site", "--knowledge", "off"],
            vec!["--site", "--log-bodies", "on", "--owner", "orbit"],
            vec![
                "--site",
                "--log-bodies",
                "on",
                "--task",
                "gemma-4-26b-a4b-it",
            ],
        ] {
            let mut argv = vec!["gm", "settings", "ai", "set"];
            argv.extend(flags);
            assert!(Cli::try_parse_from(&argv).is_err(), "accepted {argv:?}");
        }
        assert!(
            Cli::try_parse_from(["gm", "settings", "ai", "show", "--site", "--owner", "x"])
                .is_err()
        );
    }

    #[test]
    fn invalid_or_empty_updates_fail_at_parse_time() {
        for flags in [
            vec![],
            vec!["--owner", "orbit"],
            vec!["--dry-run"],
            vec!["--knowledge", "false"],
            vec!["--wiki", "ON"],
            vec!["--atlas"],
            vec!["--task", "clef"],
            vec!["--classification", "jev"],
            vec!["--fast", "arbitrary-provider-model"],
            vec!["--fast", "typesafe:jev-latest"],
            vec!["--classification", "openrouter:anthropic/claude-sonnet-5"],
            vec!["--task", "openrouter:"],
            vec!["--release-notes", "off", "--owner", "orbit/repo"],
            vec!["--wiki", "on", "--owner", ""],
            vec!["--indexing", "off"],
            vec!["--knowledge-quiet-minutes", "1441"],
            vec!["--knowledge-max-wait-minutes", "-1"],
            vec!["--knowledge-quiet-minutes", "soon"],
            vec!["--log-bodies"],
            vec!["--log-bodies", "true"],
            vec!["--log-bodies", "ON"],
            vec!["--log-bodies", "atlas=on"],
            vec!["--log-bodies", "assistant-title=on"],
            vec!["--log-bodies", "knowledge="],
        ] {
            let mut argv = vec!["gm", "settings", "ai", "set"];
            argv.extend(flags);
            assert!(Cli::try_parse_from(&argv).is_err(), "accepted {argv:?}");
        }
    }
}
