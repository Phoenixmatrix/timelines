//! Account-wide policy for automatic AI work; never inferred from a repository.

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
}

#[derive(Subcommand)]
pub enum AiCommand {
    /// Show policy, published model catalog and your management permission
    Show {
        /// Account slug; defaults to the signed-in person, never the repository owner.
        #[arg(long, value_parser = account_slug)]
        owner: Option<String>,
    },
    /// Change future jobs only; human account/org owner or site admin required
    Set(AiSetArgs),
}

#[derive(Args)]
#[group(skip)]
#[command(group(clap::ArgGroup::new("ai_changes").required(true).multiple(true).args([
    "knowledge", "wiki", "atlas", "release_notes", "classification", "fast", "task",
    "knowledge_quiet_minutes", "knowledge_max_wait_minutes"
])))]
pub struct AiSetArgs {
    /// Account slug; defaults to the signed-in person, never the repository owner.
    #[arg(long, value_parser = account_slug)]
    owner: Option<String>,
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
    /// Classification model; see show for published pricing and release dates.
    #[arg(long, value_parser = ["clef"])]
    classification: Option<String>,
    /// Fast generation model; see show for published pricing and release dates.
    #[arg(long, value_parser = ["glm-5.3-flash", "gemma-4-26b-a4b-it"])]
    fast: Option<String>,
    /// Task generation model; does not change running jobs or regenerate cached output.
    #[arg(long, value_parser = ["glm-5.3-flash", "gemma-4-26b-a4b-it"])]
    task: Option<String>,
    /// Knowledge updates start once pushes to main pause this long (0-1440 minutes; 0 = no wait).
    #[arg(long, value_parser = clap::value_parser!(u32).range(0..=1440))]
    knowledge_quiet_minutes: Option<u32>,
    /// …and never later than this after the first pending push (0-1440 minutes).
    #[arg(long, value_parser = clap::value_parser!(u32).range(0..=1440))]
    knowledge_max_wait_minutes: Option<u32>,
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
        Value::Object(patch)
    }
}

pub fn run(ctx: &Ctx, command: &SettingsCommand) -> Result<Json> {
    // Like agent management, policy administration uses the person's sign-in.
    // Explicit environment tokens still win; only the backend grants authority.
    let mut config = Config::load();
    config.acting = Acting::Person;
    let SettingsCommand::Ai(command) = command;
    let (explicit, patch) = match command {
        AiCommand::Show { owner } => (owner, None),
        AiCommand::Set(args) => (&args.owner, Some(args.patch())),
    };
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

    fn parse_set(flags: &[&str]) -> AiSetArgs {
        let mut argv = vec!["gm", "settings", "ai", "set"];
        argv.extend_from_slice(flags);
        let parsed = Cli::try_parse_from(argv).unwrap();
        let Some(Command::Settings(SettingsCommand::Ai(AiCommand::Set(args)))) = parsed.command
        else {
            panic!("expected settings ai set");
        };
        args
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
            vec!["--release-notes", "off", "--owner", "orbit/repo"],
            vec!["--wiki", "on", "--owner", ""],
            vec!["--indexing", "off"],
            vec!["--knowledge-quiet-minutes", "1441"],
            vec!["--knowledge-max-wait-minutes", "-1"],
            vec!["--knowledge-quiet-minutes", "soon"],
        ] {
            let mut argv = vec!["gm", "settings", "ai", "set"];
            argv.extend(flags);
            assert!(Cli::try_parse_from(&argv).is_err(), "accepted {argv:?}");
        }
    }
}
