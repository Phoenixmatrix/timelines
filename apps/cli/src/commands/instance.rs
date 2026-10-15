//! Self-hosted instances: a Gitmatrix of your own in a Cloudflare account.
//!
//! `gm instance setup` walks through everything an instance needs, creating
//! what `cf` can create (D1, R2, queues, Artifacts, Secrets Store secrets, AI
//! resources) and explaining, then re-checking, what it can't (signing in to
//! Cloudflare, the Workers Paid plan, a zone, Email Sending, Docker). Every
//! account-wide name is the instance's own (`gitmatrix-<name>-…`), so several
//! instances share an account without touching each other or the canonical
//! deploy. The answers and resource ids go to an instance file in gm's config
//! directory; setup resumes from it, and `gm instance deploy` reads it to ship
//! a checkout (apps/website/vite/instance.ts reads it on cf's side).

use super::Ctx;
use crate::output::{GmError, Render, Result};
use clap::{Args, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::{BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Subcommand)]
pub enum InstanceCommand {
    /// Create (or resume creating) an instance in a Cloudflare account, then deploy it
    Setup(SetupArgs),
    /// Deploy this checkout to an instance: pending D1 migrations, then the Worker
    Deploy(DeployArgs),
    /// Upgrade an instance to a later version of the source (default: upstream main)
    Upgrade(UpgradeArgs),
    /// Instances set up from this machine
    List,
    /// One instance: its address, account and resources
    Show {
        /// Instance name.
        name: String,
    },
}

#[derive(Args)]
pub struct SetupArgs {
    /// Instance name: lowercase letters, digits and hyphens. Resources are named gitmatrix-<name>-….
    pub name: Option<String>,
    /// Cloudflare account id (default: the only account you can use, else asked).
    #[arg(long)]
    pub account: Option<String>,
    /// Hostname the instance answers on, in a zone of the account (e.g. timelines.example.com).
    #[arg(long)]
    pub host: Option<String>,
    /// Who owns the instance: may always sign in, and becomes site administrator.
    #[arg(long)]
    pub owner_email: Option<String>,
    /// Organization created for the owner on their first sign-in.
    #[arg(long)]
    pub owner_org: Option<String>,
    /// Address sign-in codes come from, on an Email Sending domain of the account.
    #[arg(long)]
    pub email_from: Option<String>,
    /// Provision paid AI (Workers AI, AI Gateway, Vectorize, AI Search) for knowledge, wiki and the assistant.
    #[arg(long, conflicts_with = "no_ai")]
    pub ai: bool,
    /// Provision no AI; the app shows its AI-off states.
    #[arg(long)]
    pub no_ai: bool,
    /// Rate-limit namespace id (an account-wide integer); default derived from the name.
    #[arg(long)]
    pub rate_limit_namespace: Option<String>,
    /// The Gitmatrix checkout to deploy from (default: the one containing the current directory).
    #[arg(long, value_name = "DIR")]
    pub source: Option<PathBuf>,
    /// Create resources and deploy without asking for confirmation (required when not interactive).
    #[arg(short, long)]
    pub yes: bool,
}

#[derive(Args)]
pub struct UpgradeArgs {
    /// Instance name (see `gm instance list`).
    pub name: String,
    /// The version to upgrade to: a commit, or a branch of the upstream (default: main).
    #[arg(long, value_name = "REF")]
    pub to: Option<String>,
    /// Where to fetch versions from, a git URL or path (default: the instance's upstream,
    /// recorded at setup from the checkout's origin). Remembered after an upgrade.
    #[arg(long, value_name = "URL")]
    pub from: Option<String>,
    /// Deploy a target that isn't a later version of what's deployed (D1 migrations stay applied).
    #[arg(long)]
    pub allow_downgrade: bool,
    /// Upgrade without asking for confirmation (required when not interactive).
    #[arg(short, long)]
    pub yes: bool,
}

#[derive(Args)]
pub struct DeployArgs {
    /// Instance name (see `gm instance list`).
    pub name: String,
    /// The Gitmatrix checkout to deploy from (default: the one containing the current directory).
    #[arg(long, value_name = "DIR")]
    pub source: Option<PathBuf>,
}

pub fn run(ctx: &Ctx, command: &InstanceCommand) -> Result<Shown> {
    match command {
        InstanceCommand::Setup(args) => setup(ctx, args),
        InstanceCommand::Deploy(args) => deploy_command(ctx, args),
        InstanceCommand::Upgrade(args) => upgrade(ctx, args),
        InstanceCommand::List => list(),
        InstanceCommand::Show { name } => show(name),
    }
}

/// JSON for agents, a short summary for people.
pub struct Shown {
    value: Value,
    text: String,
}

impl Serialize for Shown {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        self.value.serialize(s)
    }
}

impl Render for Shown {
    fn text(&self) -> String {
        self.text.clone()
    }
}

// ---------------------------------------------------------------------------
// The instance file. Field names match apps/website/vite/instance.ts; the
// rest (account, zone, deployed) is gm's own, and cf's side ignores it.

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub version: u32,
    pub name: String,
    pub account_id: String,
    pub zone: Zone,
    pub host: String,
    pub worker: String,
    pub db: Database,
    pub registry_db: Database,
    pub buckets: Buckets,
    pub queues: Queues,
    pub workflows: Workflows,
    pub container: String,
    pub artifacts: String,
    pub ai: Option<Ai>,
    pub secrets: Secrets,
    pub rate_limit_namespace: String,
    pub owner: Owner,
    pub email_from: String,
    /// Where `gm instance upgrade` fetches new versions (a git URL or path).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deployed: Option<Deployed>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Zone {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Database {
    pub name: String,
    /// Empty until setup creates (or finds) the database.
    pub id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Buckets {
    pub registry: String,
    pub avatars: String,
    pub step_artifacts: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Queues {
    pub jobs: String,
    pub registry_jobs: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workflows {
    pub knowledge_build: String,
    pub ci_run: String,
    pub repo_purge: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Ai {
    pub gateway: String,
    pub vectors: String,
    pub search: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Secrets {
    /// The account's Secrets Store (one per account).
    pub store: String,
    pub registry_kek: String,
    pub better_auth: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Owner {
    pub email: String,
    pub org: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Deployed {
    pub commit: String,
    pub at: String,
    /// Deployed from a checkout with uncommitted changes: `commit` is only its base.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub dirty: bool,
}

/// The canonical deploy's account-wide names (apps/website/vite/instance.ts
/// productionInstance) and development's fixed remote ones. An instance must
/// use none. Production's host and D1 ids are its deploy's secrets, not the
/// source's: setup refuses a hostname that already has DNS records, and finds
/// D1 databases by these names.
const RESERVED: &[&str] = &[
    "production",
    "gitmatrix",
    "gitmatrix-site",
    "gitmatrix-registry",
    "gitmatrix-registry-blobs",
    "gitmatrix-avatars",
    "gitmatrix-step-artifacts",
    "gitmatrix-jobs",
    "gitmatrix-registry-jobs",
    "knowledge-build",
    "ci-run",
    "repo-purge",
    "gitmatrix-ci",
    "gitmatrix-knowledge-prod",
    "gitmatrix-prod",
    "gitmatrix-dev",
    "gitmatrix-knowledge",
    "gitmatrix_registry_kek",
    "gitmatrix_better_auth_secret",
    "4401",
    "4402",
];

/// Names a preview or an agent environment owns (tools/preview, tools/agent).
const RESERVED_NAMES: &[&str] = &["production", "preview", "dev", "agent", "site", "registry"];

pub fn valid_name(name: &str) -> std::result::Result<(), String> {
    let ok = name.len() >= 2
        && name.len() <= 32
        && name.starts_with(|c: char| c.is_ascii_lowercase())
        && !name.ends_with('-')
        && !name.contains("--")
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !ok {
        return Err(format!(
            "`{name}` isn't a usable instance name: use 2-32 lowercase letters, digits and single hyphens, starting with a letter."
        ));
    }
    if RESERVED_NAMES.contains(&name) {
        return Err(format!(
            "`{name}` is reserved; choose another instance name."
        ));
    }
    // gitmatrix-preview-* resources belong to timeline previews, whose janitor
    // deletes the ones no live preview owns (tools/preview).
    if name.starts_with("preview-") {
        return Err(
            "Instance names can't start with preview- (timeline previews own those).".into(),
        );
    }
    // Instance `x`'s registry D1 and queue are gitmatrix-x-registry(-jobs).
    if name.ends_with("-registry") {
        return Err(
            "Instance names can't end in -registry (another instance's registry names).".into(),
        );
    }
    Ok(())
}

/// Every resource name an instance called `name` uses. Ids stay empty until setup.
pub fn derive(name: &str) -> Instance {
    let prefix = format!("gitmatrix-{name}");
    let secret = format!("gitmatrix_{}", name.replace('-', "_"));
    Instance {
        version: 1,
        name: name.to_string(),
        account_id: String::new(),
        zone: Zone {
            id: String::new(),
            name: String::new(),
        },
        host: String::new(),
        worker: prefix.clone(),
        db: Database {
            name: prefix.clone(),
            id: String::new(),
        },
        registry_db: Database {
            name: format!("{prefix}-registry"),
            id: String::new(),
        },
        buckets: Buckets {
            registry: format!("{prefix}-registry-blobs"),
            avatars: format!("{prefix}-avatars"),
            step_artifacts: format!("{prefix}-step-artifacts"),
        },
        queues: Queues {
            jobs: format!("{prefix}-jobs"),
            registry_jobs: format!("{prefix}-registry-jobs"),
        },
        workflows: Workflows {
            knowledge_build: format!("{prefix}-knowledge-build"),
            ci_run: format!("{prefix}-ci-run"),
            repo_purge: format!("{prefix}-repo-purge"),
        },
        container: format!("{prefix}-ci"),
        artifacts: prefix.clone(),
        ai: None,
        secrets: Secrets {
            store: String::new(),
            registry_kek: format!("{secret}_registry_kek"),
            better_auth: format!("{secret}_better_auth_secret"),
        },
        rate_limit_namespace: rate_limit_for(name),
        owner: Owner {
            email: String::new(),
            org: String::new(),
        },
        email_from: String::new(),
        upstream: None,
        deployed: None,
    }
}

fn ai_names(name: &str) -> Ai {
    let prefix = format!("gitmatrix-{name}");
    Ai {
        gateway: prefix.clone(),
        vectors: format!("{prefix}-knowledge"),
        search: prefix,
    }
}

/// A stable default in 50000-59999, clear of the ~/dev projects' 1001 and 4x01
/// ids. Stored in the instance file, so it never changes once chosen.
fn rate_limit_for(name: &str) -> String {
    // FNV-1a: stable across gm versions, unlike std's hasher.
    let hash = name.bytes().fold(0xcbf29ce484222325u64, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x100000001b3)
    });
    (50_000 + hash % 10_000).to_string()
}

impl Instance {
    /// The account-wide names an instance shares with the canonical deploy.
    pub fn reserved_names(&self) -> Vec<String> {
        let mut names = vec![
            self.name.clone(),
            self.host.clone(),
            self.worker.clone(),
            self.db.name.clone(),
            self.db.id.clone(),
            self.registry_db.name.clone(),
            self.registry_db.id.clone(),
            self.buckets.registry.clone(),
            self.buckets.avatars.clone(),
            self.buckets.step_artifacts.clone(),
            self.queues.jobs.clone(),
            self.queues.registry_jobs.clone(),
            self.workflows.knowledge_build.clone(),
            self.workflows.ci_run.clone(),
            self.workflows.repo_purge.clone(),
            self.container.clone(),
            self.artifacts.clone(),
            self.secrets.registry_kek.clone(),
            self.secrets.better_auth.clone(),
            self.rate_limit_namespace.clone(),
        ];
        if let Some(ai) = &self.ai {
            names.extend([ai.gateway.clone(), ai.vectors.clone(), ai.search.clone()]);
        }
        names.retain(|n| RESERVED.contains(&n.as_str()));
        names
    }

    fn url(&self) -> String {
        format!("https://{}", self.host)
    }
}

// ---------------------------------------------------------------------------
// Where instance files live: next to gm.json, one per instance.

fn instances_dir() -> PathBuf {
    crate::remote::config_dir().join("instances")
}

fn instance_path(name: &str) -> PathBuf {
    instances_dir().join(format!("{name}.json"))
}

fn load(name: &str) -> Result<Option<Instance>> {
    let path = instance_path(name);
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| {
            GmError::new(
                "invalid_instance",
                format!("{} isn't a valid instance file: {e}", path.display()),
            )
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn save(instance: &Instance) -> Result<PathBuf> {
    let path = instance_path(&instance.name);
    std::fs::create_dir_all(instances_dir())?;
    let temporary = path.with_extension("json.tmp");
    let mut bytes = serde_json::to_vec_pretty(instance)?;
    bytes.push(b'\n');
    std::fs::write(&temporary, bytes)?;
    std::fs::rename(&temporary, &path)?;
    Ok(path)
}

fn all_instances() -> Result<Vec<Instance>> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(instances_dir()) else {
        return Ok(found);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "json")
            && let Some(name) = path.file_stem().and_then(|s| s.to_str())
            && let Some(instance) = load(name)?
        {
            found.push(instance);
        }
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(found)
}

// ---------------------------------------------------------------------------
// The checkout and its cf.

/// The Gitmatrix checkout to deploy from: --source, else the one around cwd.
fn checkout(ctx: &Ctx, source: &Option<PathBuf>) -> Result<PathBuf> {
    let is_checkout = |dir: &Path| {
        dir.join("apps/website/cloudflare.config.ts").is_file()
            && dir.join("apps/website/vite/instance.ts").is_file()
    };
    if let Some(source) = source {
        let dir = ctx.cwd.join(source);
        if is_checkout(&dir) {
            return Ok(dir.canonicalize()?);
        }
        return Err(GmError::usage(format!(
            "{} isn't a Gitmatrix checkout (no apps/website/vite/instance.ts).",
            dir.display()
        )));
    }
    let mut dir = Some(ctx.cwd.as_path());
    while let Some(candidate) = dir {
        if is_checkout(candidate) {
            return Ok(candidate.to_path_buf());
        }
        dir = candidate.parent();
    }
    Err(GmError::new(
        "not_a_checkout",
        "Run this from a Gitmatrix checkout (the repository with apps/website), or pass --source.",
    )
    .hint("git clone the Gitmatrix repository, install its dependencies in it (`pnpm install`, or `vp install` with Vite+), then run `gm instance setup` there."))
}

struct Cf {
    bin: PathBuf,
    website: PathBuf,
    account: Option<String>,
}

/// A cf call's failure: its stderr, and whether Cloudflare said "not found".
struct CfError {
    message: String,
    absent: bool,
}

impl From<CfError> for GmError {
    fn from(error: CfError) -> GmError {
        GmError::new("cloudflare_error", error.message)
    }
}

impl Cf {
    fn new(root: &Path) -> Result<Cf> {
        let website = root.join("apps/website");
        let bin = website.join("node_modules/.bin/cf");
        if !bin.exists() {
            return Err(GmError::new(
                "dependencies_missing",
                format!(
                    "{} has no installed dependencies (apps/website/node_modules/.bin/cf is missing).",
                    root.display()
                ),
            )
            .hint(format!(
                "Run `{}` in {}, then rerun.",
                installer(root).map_or("pnpm install", |i| i.command()),
                root.display()
            )));
        }
        Ok(Cf {
            bin,
            website,
            account: None,
        })
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(&self.bin);
        command
            .args(args)
            .current_dir(&self.website)
            .env("NO_COLOR", "1")
            .stdin(Stdio::null());
        // What a canonical or agent deploy would set must never reach an instance's.
        for key in [
            "GITMATRIX_CI_IMAGE",
            "GITMATRIX_CONTAINER_IMAGES",
            "GITMATRIX_CI_RUNNER",
            "GITMATRIX_PUBLIC_URL",
            "GITMATRIX_AGENT_ID",
            "GITMATRIX_INSTANCE_CONFIG",
            "GITMATRIX_CUTOVER_CHECKPOINT",
            // A production deploy's marker; its exported identifiers stay, so
            // the instance guards (vite/instance.ts sharedWithProduction) can
            // still refuse a config that names production's.
            "GITMATRIX_DEPLOY",
        ] {
            command.env_remove(key);
        }
        if let Some(account) = &self.account {
            command.env("CLOUDFLARE_ACCOUNT_ID", account);
        }
        command
    }

    /// Run cf and parse its JSON output.
    fn try_json(&self, args: &[&str]) -> std::result::Result<Value, CfError> {
        let output = self.command(args).output().map_err(|e| CfError {
            message: format!("couldn't run cf: {e}"),
            absent: false,
        })?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail = [stderr.trim(), stdout.trim()]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            return Err(CfError {
                absent: detail.contains("404 Not Found") || detail.contains("does not exist"),
                message: format!("`cf {}` failed:\n{}", args.join(" "), tail(&detail, 20)),
            });
        }
        let trimmed = stdout.trim();
        if trimmed.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(trimmed).map_err(|_| CfError {
            message: format!(
                "`cf {}` printed something other than JSON:\n{}",
                args.join(" "),
                tail(trimmed, 10)
            ),
            absent: false,
        })
    }

    fn json(&self, args: &[&str]) -> Result<Value> {
        Ok(self.try_json(args)?)
    }

    /// Whether a resource exists: Ok(true) found, Ok(false) Cloudflare said 404.
    fn exists(&self, args: &[&str]) -> Result<bool> {
        match self.try_json(args) {
            Ok(_) => Ok(true),
            Err(error) if error.absent => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    /// Run cf with its output streamed to stderr (stdout is gm's result).
    fn stream(&self, args: &[&str], env: &[(&str, &str)]) -> Result<()> {
        let mut command = self.command(args);
        command.envs(env.iter().copied());
        command.stdout(Stdio::from(std::io::stderr()));
        command.stderr(Stdio::inherit());
        let status = command.status()?;
        if status.success() {
            Ok(())
        } else {
            Err(GmError::new(
                "cloudflare_error",
                format!(
                    "`cf {}` failed ({status}); its output is above.",
                    args.join(" ")
                ),
            ))
        }
    }
}

fn tail(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

/// A JSON list, whether cf printed it bare or under a key (`{buckets: […]}`).
fn items<'a>(value: &'a Value, key: &str) -> Vec<&'a Value> {
    match value {
        Value::Array(items) => items.iter().collect(),
        Value::Object(map) => map
            .get(key)
            .or_else(|| map.get("result"))
            .and_then(Value::as_array)
            .map(|items| items.iter().collect())
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn str_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

// ---------------------------------------------------------------------------
// Talking to the person running setup. Everything goes to stderr; stdout is
// the command's result. Without a terminal (or under an agent) nothing is
// asked: missing answers are errors naming the flag that supplies them.

struct Guide {
    interactive: bool,
}

impl Guide {
    fn new() -> Guide {
        Guide {
            interactive: std::io::stdin().is_terminal()
                && std::io::stderr().is_terminal()
                && crate::agent::detect().is_none(),
        }
    }

    fn say(&self, text: &str) {
        eprintln!("{text}");
    }

    fn step(&self, title: &str) {
        eprintln!("\n▸ {title}");
    }

    fn done(&self, text: &str) {
        eprintln!("  ✓ {text}");
    }

    fn read_line(&self) -> Result<String> {
        let mut line = String::new();
        if std::io::stdin().lock().read_line(&mut line)? == 0 {
            return Err(GmError::new("aborted", "Setup stopped: input closed."));
        }
        Ok(line.trim().to_string())
    }

    /// An answer: the flag's value, else asked (with a default), else an error.
    fn answer(
        &self,
        given: &Option<String>,
        question: &str,
        default: Option<&str>,
        flag: &str,
        check: impl Fn(&str) -> std::result::Result<(), String>,
    ) -> Result<String> {
        if let Some(value) = given {
            let value = value.trim().to_string();
            check(&value).map_err(GmError::usage)?;
            return Ok(value);
        }
        if !self.interactive {
            if let Some(default) = default {
                check(default).map_err(GmError::usage)?;
                return Ok(default.to_string());
            }
            return Err(GmError::usage(format!("{question}: pass {flag}.")));
        }
        loop {
            match default {
                Some(default) => eprint!("  {question} [{default}]: "),
                None => eprint!("  {question}: "),
            }
            std::io::stderr().flush()?;
            let line = self.read_line()?;
            let value = if line.is_empty() {
                default.unwrap_or("").to_string()
            } else {
                line
            };
            match check(&value) {
                Ok(()) => return Ok(value),
                Err(problem) => eprintln!("  {problem}"),
            }
        }
    }

    fn confirm(&self, question: &str, default: bool) -> Result<bool> {
        if !self.interactive {
            return Ok(default);
        }
        eprint!("  {question} [{}]: ", if default { "Y/n" } else { "y/N" });
        std::io::stderr().flush()?;
        let line = self.read_line()?.to_lowercase();
        Ok(match line.as_str() {
            "" => default,
            "y" | "yes" => true,
            _ => false,
        })
    }

    /// Something only the person can do: explain it, then re-check when they
    /// press Enter. Not interactive, it fails with the instructions as its hint.
    fn wait_for(
        &self,
        code: &'static str,
        problem: &str,
        instructions: &[String],
        mut ready: impl FnMut() -> Result<bool>,
    ) -> Result<()> {
        if ready()? {
            return Ok(());
        }
        if !self.interactive {
            return Err(GmError::new(code, problem.to_string()).hint(instructions.join(" ")));
        }
        loop {
            eprintln!("\n  ! {problem}");
            for (i, line) in instructions.iter().enumerate() {
                eprintln!("    {}. {line}", i + 1);
            }
            eprint!("  Press Enter to check again (or Ctrl-C to stop; rerun setup to resume): ");
            std::io::stderr().flush()?;
            self.read_line()?;
            if ready()? {
                return Ok(());
            }
        }
    }
}

// ---------------------------------------------------------------------------
// gm instance setup

fn setup(ctx: &Ctx, args: &SetupArgs) -> Result<Shown> {
    let guide = Guide::new();
    let root = checkout(ctx, &args.source)?;
    let mut cf = Cf::new(&root)?;
    guide.say(&format!(
        "Setting up a Gitmatrix instance from {}.",
        root.display()
    ));

    // 1. Which instance: resume one already started, or a new name.
    let name = guide.answer(
        &args.name,
        "Instance name (resources are named gitmatrix-<name>-…)",
        None,
        "the instance name (`gm instance setup <name>`)",
        valid_name,
    )?;
    let existing = load(&name)?;
    let resuming = existing.is_some();
    let mut instance = existing.unwrap_or_else(|| derive(&name));
    if resuming {
        guide.say(&format!(
            "Resuming instance {name} from {}.",
            instance_path(&name).display()
        ));
    }

    // 2. Signed in to Cloudflare.
    guide.step("Cloudflare sign-in");
    let identity = signed_in(&cf, &guide)?;
    guide.done(&format!(
        "signed in as {}",
        identity["email"].as_str().unwrap_or("(API token)")
    ));

    // 3. The account.
    guide.step("Cloudflare account");
    let accounts: Vec<(String, String)> = items(&identity, "accounts")
        .iter()
        .map(|a| (str_of(a, "id").to_string(), str_of(a, "name").to_string()))
        .collect();
    let account = choose_account(&guide, &instance, args, &accounts)?;
    if resuming && !instance.account_id.is_empty() && instance.account_id != account {
        return Err(GmError::usage(format!(
            "Instance {name} lives in account {}; it can't move to {account}.",
            instance.account_id
        )));
    }
    instance.account_id = account.clone();
    cf.account = Some(account.clone());
    guide.done(&format!(
        "account {}",
        accounts
            .iter()
            .find(|(id, _)| *id == account)
            .map(|(id, name)| format!("{name} ({id})"))
            .unwrap_or(account.clone())
    ));

    // A Worker of this name that gm didn't deploy belongs to someone else. Once
    // setup has created resources, a Worker or record of this name is its own
    // (a deploy may have failed after uploading it).
    let owned = instance.deployed.is_some() || !instance.db.id.is_empty();
    if !owned
        && cf.exists(&[
            "workers",
            "deployments",
            "list",
            "--worker",
            &instance.worker,
        ])?
    {
        return Err(GmError::new(
            "name_taken",
            format!(
                "A Worker named {} already exists in this account, and no instance file says gm deployed it.",
                instance.worker
            ),
        )
        .hint("Choose another instance name."));
    }

    // 4. Workers Paid: Containers (CI) and the CPU limits need it.
    guide.step("Workers plan");
    guide.wait_for(
        "workers_paid_required",
        "The account isn't on the Workers Paid plan, which CI's containers and the Worker's CPU limits need.",
        &[
            "Open https://dash.cloudflare.com → Workers & Pages → Plans.".to_string(),
            "Subscribe to Workers Paid (from $5 a month).".to_string(),
        ],
        || workers_paid(&cf),
    )?;
    guide.done("Workers Paid");

    // R2 is off on a new account until someone enables it in the dashboard.
    guide.step("R2");
    guide.wait_for(
        "r2_disabled",
        "R2 isn't enabled on the account; the package registry, avatars and CI screenshots store files in it.",
        &[
            "Open https://dash.cloudflare.com → R2 Object Storage.".to_string(),
            "Enable R2 (its free tier covers a small instance; usage beyond it is billed to the account).".to_string(),
        ],
        || r2_enabled(&cf),
    )?;
    guide.done("R2 enabled");

    // 5. The hostname, in an active zone of the account.
    guide.step("Hostname");
    let zones = zones(&cf, &account)?;
    let default_host = (zones.len() == 1).then(|| format!("timelines-{name}.{}", zones[0].name));
    let current = (!instance.host.is_empty()).then(|| instance.host.clone());
    let host = guide.answer(
        &args.host.clone().or(current),
        "Hostname the instance answers on",
        default_host.as_deref(),
        "--host",
        valid_host,
    )?;
    if !ctx.dry_run && instance.host != host {
        instance.host = host.clone();
        save(&instance)?;
    }
    let mut zone = zone_for(&host, &zones);
    let apex = host.split('.').skip(1).collect::<Vec<_>>().join(".");
    guide.wait_for(
        "zone_missing",
        &format!("{host} isn't in an active zone of this account."),
        &[
            format!(
                "Add the domain (for example {apex}) to the account: https://dash.cloudflare.com → Add a domain."
            ),
            "Change the domain's nameservers at its registrar to the two Cloudflare shows.".to_string(),
            "Wait until the zone shows Active (minutes to a few hours).".to_string(),
        ],
        || {
            zone = zone_for(&host, &self::zones(&cf, &account)?);
            Ok(zone.is_some())
        },
    )?;
    let zone = zone.expect("waited for the zone");
    if !owned {
        let records = cf.json(&[
            "dns", "records", "list", "--zone", &zone.id, "--name", &host,
        ])?;
        if !items(&records, "result").is_empty() {
            return Err(GmError::new(
                "host_taken",
                format!("{host} already has DNS records; deploying would take it over."),
            )
            .hint("Choose another hostname, or remove its records first."));
        }
    }
    let shared = derive_host_conflict(&instance, &host);
    if let Some(other) = shared {
        return Err(GmError::usage(format!(
            "Instance {other} already uses {host}."
        )));
    }
    instance.host = host.clone();
    instance.zone = zone.clone();
    guide.done(&format!("{host} (zone {})", zone.name));
    // Answers are kept as they come, so a long wait later (a zone, Email
    // Sending) can be stopped and resumed; a dry run writes nothing.
    if !ctx.dry_run {
        save(&instance)?;
    }

    // 6. The owner.
    guide.step("Owner");
    let current = (!instance.owner.email.is_empty()).then(|| instance.owner.email.clone());
    let default_email = identity["email"].as_str().map(str::to_string);
    instance.owner.email = guide.answer(
        &args.owner_email.clone().or(current),
        "Owner's email (signs in first; site administrator)",
        default_email.as_deref(),
        "--owner-email",
        valid_email,
    )?;
    // The owner's own account takes the slug of their email's local part on
    // first sign-in (worker/better-auth.ts freeSlug); the org needs another.
    let personal = user_slug(&instance.owner.email);
    let current = (!instance.owner.org.is_empty()).then(|| instance.owner.org.clone());
    let default_org = if name == personal {
        format!("{name}-org")
    } else {
        name.clone()
    };
    instance.owner.org = guide.answer(
        &args.owner_org.clone().or(current),
        "Organization to create for the owner",
        Some(&default_org),
        "--owner-org",
        |org| {
            valid_org(org)?;
            if org == personal {
                return Err(format!(
                    "`{org}` will be the owner's own username; choose another organization name."
                ));
            }
            Ok(())
        },
    )?;
    guide.done(&format!(
        "{} (org {})",
        instance.owner.email, instance.owner.org
    ));
    if !ctx.dry_run {
        save(&instance)?;
    }

    // 7. Sign-in email: an Email Sending domain in the instance's zone.
    guide.step("Sign-in email");
    let mut sending = sending_domains(&cf, &zone)?;
    if sending.is_empty() {
        let proposed = format!("mail.{}", zone.name);
        // Creating one turns on Email Sending for the zone: never in a dry run,
        // and without a terminal only with --yes.
        let create = if ctx.dry_run {
            false
        } else if guide.interactive {
            guide.confirm(
                &format!(
                    "No Email Sending domain in {}. Create {proposed}?",
                    zone.name
                ),
                true,
            )?
        } else {
            args.yes
        };
        if create {
            match cf.try_json(&[
                "email-sending",
                "subdomains",
                "create",
                "--zone",
                &zone.id,
                "--name",
                &proposed,
            ]) {
                Ok(_) => guide.done(&format!("created Email Sending domain {proposed}")),
                Err(error) => guide.say(&format!("  Couldn't create it: {}", error.message)),
            }
        }
        guide.wait_for(
            "email_sending_missing",
            &format!("{} has no Email Sending domain, so sign-in codes can't be sent.", zone.name),
            &[
                format!(
                    "Open https://dash.cloudflare.com → {} → Email → Email Sending.",
                    zone.name
                ),
                format!("Onboard a sending domain such as {proposed}, and let Cloudflare add its DNS records."),
                "Wait until it shows as enabled.".to_string(),
            ],
            || {
                sending = sending_domains(&cf, &zone)?;
                Ok(!sending.is_empty())
            },
        )?;
    }
    let current = (!instance.email_from.is_empty()).then(|| instance.email_from.clone());
    let default_from = format!("{}@{}", instance.worker, sending[0].name);
    let domains: Vec<String> = sending.iter().map(|d| d.name.clone()).collect();
    instance.email_from = guide.answer(
        &args.email_from.clone().or(current),
        "Send sign-in codes from",
        Some(&default_from),
        "--email-from",
        |value| {
            valid_email(value)?;
            let domain = value.rsplit('@').next().unwrap_or("");
            if domains.iter().any(|d| d == domain) {
                Ok(())
            } else {
                Err(format!(
                    "{domain} isn't an Email Sending domain of {} (have: {}).",
                    zone.name,
                    domains.join(", ")
                ))
            }
        },
    )?;
    // Codes only arrive once the sending domain's DNS records (SPF, DKIM,
    // DMARC, bounce MX) are in place; Cloudflare can add missing ones.
    let domain = instance
        .email_from
        .rsplit('@')
        .next()
        .unwrap_or("")
        .to_string();
    let sender = sending
        .iter()
        .find(|d| d.name == domain)
        .cloned()
        .expect("the address was checked against these domains");
    match email_dns(&cf, &zone, &sender) {
        Ok((true, _)) => {}
        Ok((false, problems)) => {
            let fix = if ctx.dry_run {
                false
            } else if guide.interactive {
                guide.confirm(
                    &format!(
                        "{domain}'s email DNS records aren't ready. Have Cloudflare add them?"
                    ),
                    true,
                )?
            } else {
                args.yes
            };
            if fix {
                match cf.try_json(&[
                    "email-sending",
                    "subdomains",
                    "dns",
                    "fix",
                    &sender.id,
                    "--zone",
                    &zone.id,
                ]) {
                    Ok(_) => guide.done(&format!("asked Cloudflare to add {domain}'s DNS records")),
                    Err(error) => guide.say(&format!("  Couldn't fix them: {}", error.message)),
                }
            }
            let mut instructions = vec![
                format!(
                    "Open https://dash.cloudflare.com → {} → Email → Email Sending → {domain}.",
                    zone.name
                ),
                "Add the DNS records it lists as missing (or use its fix button).".to_string(),
                "Wait until the domain shows as ready.".to_string(),
            ];
            if !problems.is_empty() {
                instructions.push(format!("Cloudflare reports: {}", problems.join("; ")));
            }
            guide.wait_for(
                "email_dns_unready",
                &format!("{domain} isn't ready to send email, so sign-in codes wouldn't arrive."),
                &instructions,
                || {
                    Ok(email_dns(&cf, &zone, &sender)
                        .map(|(ready, _)| ready)
                        .unwrap_or(false))
                },
            )?;
        }
        // Readiness is advice: an API this setup can't read shouldn't block it.
        Err(error) => guide.say(&format!(
            "  ! Couldn't check {domain}'s email DNS records ({}); check them in the dashboard.",
            error.message.lines().last().unwrap_or("")
        )),
    }
    guide.done(&instance.email_from);
    if !ctx.dry_run {
        save(&instance)?;
    }

    // 8. AI is paid, so it's opt-in.
    guide.step("AI");
    let ai = if args.ai {
        true
    } else if args.no_ai {
        false
    } else if resuming {
        instance.ai.is_some()
    } else {
        guide.confirm(
            "Provision paid AI (Knowledge, wiki, assistant, release notes; billed per use)?",
            false,
        )?
    };
    instance.ai = ai.then(|| ai_names(&name));
    guide.done(if ai { "AI on" } else { "AI off" });

    // 9. Rate limits count per account-wide namespace id.
    if let Some(namespace) = &args.rate_limit_namespace {
        if namespace.is_empty()
            || namespace.len() > 10
            || !namespace.chars().all(|c| c.is_ascii_digit())
            || namespace.starts_with('0')
        {
            return Err(GmError::usage(
                "--rate-limit-namespace must be a positive integer.",
            ));
        }
        instance.rate_limit_namespace = namespace.clone();
    }
    if let Some(other) = all_instances()?.into_iter().find(|other| {
        other.name != instance.name
            && other.account_id == instance.account_id
            && other.rate_limit_namespace == instance.rate_limit_namespace
    }) {
        return Err(GmError::usage(format!(
            "Instance {} already uses rate-limit namespace {}; pass --rate-limit-namespace.",
            other.name, instance.rate_limit_namespace
        )));
    }

    let reserved = instance.reserved_names();
    if !reserved.is_empty() {
        return Err(GmError::new(
            "reserved_name",
            format!(
                "These names belong to the canonical deploy: {}.",
                reserved.join(", ")
            ),
        ));
    }

    // 10. Docker builds the CI image on deploy.
    guide.step("Docker");
    guide.wait_for(
        "docker_required",
        "Docker isn't running; deploying builds the CI image (apps/website/ci/Dockerfile) with it.",
        &[
            "Install Docker (https://docs.docker.com/get-docker/) or start its daemon.".to_string(),
            "Check that `docker info` works without sudo.".to_string(),
        ],
        || {
            Ok(Command::new("docker")
                .arg("info")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|s| s.success()))
        },
    )?;
    guide.done("Docker is running");

    // Where later upgrades fetch from: the clone this setup runs in.
    if instance.upstream.is_none() {
        instance.upstream = git(&root, &["remote", "get-url", "origin"]).ok();
    }

    // 11. Confirm what's about to be created.
    let file = instance_path(&name);
    guide.step("Plan");
    for line in plan_lines(&instance) {
        guide.say(&format!("  {line}"));
    }
    guide.say(&format!("  Instance file: {}", file.display()));
    if ctx.dry_run {
        return Ok(Shown {
            text: format!(
                "Dry run: nothing created. Rerun without --dry-run to create instance {name}."
            ),
            value: json!({ "dry_run": true, "instance": instance, "file": file }),
        });
    }
    if !args.yes {
        if !guide.interactive {
            return Err(GmError::usage(
                "Creating Cloudflare resources and deploying needs confirmation: pass --yes.",
            ));
        }
        if !guide.confirm("Create these resources and deploy?", true)? {
            return Err(GmError::new(
                "aborted",
                "Nothing was created. Rerun `gm instance setup` to continue.",
            ));
        }
    }

    // 12. Create what's missing; each step is saved, so a rerun resumes.
    save(&instance)?;
    guide.step("Creating resources");
    let mut created = Vec::new();
    provision(&cf, &guide, &mut instance, &mut created)?;
    save(&instance)?;

    // 13. Migrations, then the Worker.
    let deployed = deploy(&cf, &guide, &root, &mut instance)?;

    let url = instance.url();
    let next = vec![
        format!(
            "Open {url} and sign in as {} (a code is emailed).",
            instance.owner.email
        ),
        format!("gm auth login --server {url}"),
        format!("Later, to update it from this checkout: gm instance deploy {name}"),
    ];
    let mut text = format!("\nInstance {name} is live at {url}.\n\nNext:\n",);
    for (i, line) in next.iter().enumerate() {
        text.push_str(&format!("  {}. {line}\n", i + 1));
    }
    Ok(Shown {
        value: json!({
            "name": name,
            "url": url,
            "file": file,
            "created": created,
            "deployed": deployed,
            "next": next,
        }),
        text,
    })
}

fn signed_in(cf: &Cf, guide: &Guide) -> Result<Value> {
    let check = || -> Result<Option<Value>> {
        let identity = cf.try_json(&["auth", "whoami"]).unwrap_or(Value::Null);
        Ok(
            (identity["authenticated"] == json!(true) && identity["tokenValid"] != json!(false))
                .then_some(identity),
        )
    };
    if let Some(identity) = check()? {
        return Ok(identity);
    }
    let login = login_command(&cf.bin);
    if !guide.interactive {
        return Err(
            GmError::new("cloudflare_signed_out", "cf isn't signed in to Cloudflare.").hint(
                format!("Run `{login}` in the checkout (or set CLOUDFLARE_API_TOKEN), then rerun."),
            ),
        );
    }
    guide.say("  cf isn't signed in. Opening Cloudflare's sign-in in your browser…");
    let status = Command::new(&cf.bin)
        .args(["auth", "login"])
        .current_dir(&cf.website)
        .status()?;
    if !status.success() {
        return Err(
            GmError::new("cloudflare_signed_out", "Cloudflare sign-in didn't finish.")
                .hint(format!("Run `{login}`, then rerun.")),
        );
    }
    check()?.ok_or_else(|| GmError::new("cloudflare_signed_out", "cf still isn't signed in."))
}

/// Signing in runs the checkout's own cf, so the hint names it by path: no
/// package manager (or its shim) stands between the person and cf.
fn login_command(cf: &Path) -> String {
    format!("{} auth login", cf.display())
}

fn choose_account(
    guide: &Guide,
    instance: &Instance,
    args: &SetupArgs,
    accounts: &[(String, String)],
) -> Result<String> {
    let given = args
        .account
        .clone()
        .or_else(|| (!instance.account_id.is_empty()).then(|| instance.account_id.clone()))
        .or_else(|| {
            std::env::var("CLOUDFLARE_ACCOUNT_ID")
                .ok()
                .filter(|v| !v.is_empty())
        });
    if let Some(account) = given {
        // An API token may not list accounts; trust what the person named then.
        if accounts.is_empty() || accounts.iter().any(|(id, _)| *id == account) {
            return Ok(account);
        }
        return Err(GmError::usage(format!(
            "You can't use account {account}; yours are {}.",
            accounts
                .iter()
                .map(|(id, n)| format!("{n} ({id})"))
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }
    match accounts {
        [] => Err(GmError::usage(
            "No Cloudflare account to use: pass --account.",
        )),
        [(id, _)] => Ok(id.clone()),
        _ => {
            if !guide.interactive {
                return Err(GmError::usage(format!(
                    "You can use several accounts; pass --account (one of {}).",
                    accounts
                        .iter()
                        .map(|(id, n)| format!("{id} {n}"))
                        .collect::<Vec<_>>()
                        .join(", ")
                )));
            }
            for (i, (id, name)) in accounts.iter().enumerate() {
                guide.say(&format!("    {}. {name} ({id})", i + 1));
            }
            let choice = guide.answer(&None, "Account number", Some("1"), "--account", |v| {
                v.parse::<usize>()
                    .ok()
                    .filter(|n| (1..=accounts.len()).contains(n))
                    .map(|_| ())
                    .ok_or_else(|| format!("Choose 1 to {}.", accounts.len()))
            })?;
            Ok(accounts[choice.parse::<usize>().unwrap() - 1].0.clone())
        }
    }
}

fn workers_paid(cf: &Cf) -> Result<bool> {
    let subscriptions = cf.json(&["accounts", "subscriptions", "get"])?;
    Ok(items(&subscriptions, "result").iter().any(|s| {
        s["rate_plan"]["id"]
            .as_str()
            .is_some_and(|id| id == "workers_paid" || id.starts_with("workers_enterprise"))
    }))
}

fn zones(cf: &Cf, account: &str) -> Result<Vec<Zone>> {
    let mut zones = Vec::new();
    for page in 1..=40 {
        let page = page.to_string();
        let listed = cf.json(&[
            "zones",
            "list",
            "--account-id",
            account,
            "--per-page",
            "50",
            "--page",
            &page,
        ])?;
        let listed = items(&listed, "result");
        let count = listed.len();
        zones.extend(
            listed
                .into_iter()
                .filter(|z| {
                    z["account"]["id"].as_str().is_none_or(|id| id == account)
                        && str_of(z, "status") == "active"
                })
                .map(|z| Zone {
                    id: str_of(z, "id").to_string(),
                    name: str_of(z, "name").to_string(),
                }),
        );
        if count < 50 {
            break;
        }
    }
    Ok(zones)
}

/// The zone a hostname belongs to: the longest zone name it ends with.
fn zone_for(host: &str, zones: &[Zone]) -> Option<Zone> {
    zones
        .iter()
        .filter(|z| host.ends_with(&format!(".{}", z.name)))
        .max_by_key(|z| z.name.len())
        .cloned()
}

fn derive_host_conflict(instance: &Instance, host: &str) -> Option<String> {
    all_instances()
        .ok()?
        .into_iter()
        .find(|other| other.name != instance.name && other.host == host)
        .map(|other| other.name)
}

#[derive(Clone)]
struct SendingDomain {
    id: String,
    name: String,
}

fn sending_domains(cf: &Cf, zone: &Zone) -> Result<Vec<SendingDomain>> {
    let listed = cf.json(&["email-sending", "subdomains", "list", "--zone", &zone.id])?;
    Ok(items(&listed, "result")
        .into_iter()
        .filter(|d| d["enabled"] != json!(false))
        .map(|d| SendingDomain {
            id: str_of(d, "id").to_string(),
            name: str_of(d, "name").to_string(),
        })
        .filter(|d| !d.name.is_empty() && !d.id.is_empty())
        .collect())
}

/// Whether a sending domain's DNS records are in place ("ready"), and what
/// Cloudflare says is wrong when they aren't.
fn email_dns(
    cf: &Cf,
    zone: &Zone,
    domain: &SendingDomain,
) -> std::result::Result<(bool, Vec<String>), CfError> {
    let status = cf.try_json(&[
        "email-sending",
        "subdomains",
        "dns",
        "status",
        &domain.id,
        "--zone",
        &zone.id,
    ])?;
    let problems = items(&status, "errors")
        .iter()
        .map(|e| match e {
            Value::String(text) => text.clone(),
            other => other
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| other.to_string()),
        })
        .collect();
    Ok((str_of(&status, "status") == "ready", problems))
}

/// Whether R2 is on: an account that hasn't enabled it gets Cloudflare's
/// "enable R2 through the dashboard" error (10042) for any R2 call.
fn r2_enabled(cf: &Cf) -> Result<bool> {
    match cf.try_json(&["r2", "buckets", "list", "--per-page", "1"]) {
        Ok(_) => Ok(true),
        Err(error)
            if error.message.contains("10042")
                || error.message.to_lowercase().contains("enable r2") =>
        {
            Ok(false)
        }
        Err(error) => Err(error.into()),
    }
}

fn valid_host(host: &str) -> std::result::Result<(), String> {
    let labels: Vec<&str> = host.split('.').collect();
    let tld = labels.last().copied().unwrap_or("");
    let ok = labels.len() >= 3
        && host.len() <= 253
        && tld.len() >= 2
        && tld.chars().all(|c| c.is_ascii_lowercase())
        && labels.iter().all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        });
    if !ok {
        return Err(format!(
            "`{host}` isn't a usable hostname: use a lowercase subdomain such as timelines.example.com."
        ));
    }
    Ok(())
}

fn valid_email(email: &str) -> std::result::Result<(), String> {
    let mut parts = email.splitn(2, '@');
    let (local, domain) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    if local.is_empty()
        || !domain.contains('.')
        || domain.contains('@')
        || domain.starts_with('.')
        || domain.ends_with('.')
        || email.contains(char::is_whitespace)
    {
        return Err(format!("`{email}` isn't an email address."));
    }
    Ok(())
}

/// Slugs the app keeps for its own routes (worker/names.ts RESERVED_SLUGS).
const RESERVED_SLUGS: &[&str] = &[
    "agent-work",
    "api",
    "assets",
    "ci",
    "cli-auth",
    "device",
    "highlights",
    "knowledge",
    "needs-you",
    "new",
    "packages",
    "release-notes",
    "settings",
    "signin",
    "signout",
    "timelines",
    "tracker",
    "v2",
    "npm",
    "pypi",
    "maven",
    "cargo",
    "go",
    "helm",
    "apt",
    "rpm",
    "brew",
    "generic",
    "releases",
    "admin",
    "gitmatrix",
    "login",
    "logout",
    "root",
    "support",
];

/// The app's slug rule (worker/names.ts slugProblem): 1-39 lowercase letters,
/// digits or single hyphens, starting and ending with a letter or digit.
fn valid_org(org: &str) -> std::result::Result<(), String> {
    let ok = !org.is_empty()
        && org.len() <= 39
        && !org.starts_with('-')
        && !org.ends_with('-')
        && !org.contains("--")
        && org
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !ok {
        return Err(format!(
            "`{org}` isn't a usable organization: 1-39 lowercase letters, digits or single hyphens."
        ));
    }
    if RESERVED_SLUGS.contains(&org) {
        return Err(format!(
            "`{org}` is reserved by the app; choose another organization name."
        ));
    }
    Ok(())
}

/// The username the owner's account gets on first sign-in (worker/better-auth.ts freeSlug).
fn user_slug(email: &str) -> String {
    let email = email.trim().to_lowercase();
    let mut slug = String::new();
    for c in email.split('@').next().unwrap_or("").chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' {
            if !(c == '-' && slug.ends_with('-')) {
                slug.push(c);
            }
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug: String = slug.trim_matches('-').chars().take(32).collect();
    slug.trim_end_matches('-').to_string()
}

fn plan_lines(instance: &Instance) -> Vec<String> {
    let mut lines = vec![
        format!(
            "Worker      {} on https://{}",
            instance.worker, instance.host
        ),
        format!(
            "D1          {}, {}",
            instance.db.name, instance.registry_db.name
        ),
        format!(
            "R2          {}, {}, {}",
            instance.buckets.registry, instance.buckets.avatars, instance.buckets.step_artifacts
        ),
        format!(
            "Queues      {}, {}",
            instance.queues.jobs, instance.queues.registry_jobs
        ),
        format!(
            "Workflows   {}, {}, {}",
            instance.workflows.knowledge_build,
            instance.workflows.ci_run,
            instance.workflows.repo_purge
        ),
        format!("Container   {} (CI)", instance.container),
        format!("Artifacts   {}", instance.artifacts),
        format!(
            "Secrets     {}, {} (generated)",
            instance.secrets.registry_kek, instance.secrets.better_auth
        ),
        format!("Rate limits namespace {}", instance.rate_limit_namespace),
        format!(
            "Owner       {} (org {})",
            instance.owner.email, instance.owner.org
        ),
        format!("Email from  {}", instance.email_from),
    ];
    match &instance.ai {
        Some(ai) => lines.push(format!(
            "AI          gateway {}, Vectorize {}, AI Search {}",
            ai.gateway, ai.vectors, ai.search
        )),
        None => lines.push("AI          off".to_string()),
    }
    lines
}

/// Find-or-create every resource. Lookups go by name first, so a rerun
/// creates only what an earlier run didn't, and never a second copy.
fn provision(
    cf: &Cf,
    guide: &Guide,
    instance: &mut Instance,
    created: &mut Vec<String>,
) -> Result<()> {
    let mut note = |what: String, made: bool| {
        guide.done(&format!("{what}{}", if made { " (created)" } else { "" }));
        if made {
            created.push(what);
        }
    };

    for database in [&mut instance.db, &mut instance.registry_db] {
        let (id, made) = d1(cf, &database.name)?;
        database.id = id;
        note(format!("D1 {}", database.name), made);
    }
    save(instance)?;

    for bucket in [
        &instance.buckets.registry,
        &instance.buckets.avatars,
        &instance.buckets.step_artifacts,
    ] {
        let listed = cf.json(&["r2", "buckets", "list", "--name-contains", bucket])?;
        let made = !items(&listed, "buckets")
            .iter()
            .any(|b| str_of(b, "name") == bucket);
        if made {
            cf.json(&["r2", "buckets", "create", "--name", bucket])?;
        }
        note(format!("R2 {bucket}"), made);
    }

    let queues = cf.json(&["queues", "list"])?;
    for queue in [&instance.queues.jobs, &instance.queues.registry_jobs] {
        let made = !items(&queues, "result")
            .iter()
            .any(|q| str_of(q, "queue_name") == queue);
        if made {
            cf.json(&["queues", "create", "--queue-name", queue])?;
        }
        note(format!("Queue {queue}"), made);
    }

    let made = !cf.exists(&["artifacts", "namespaces", "get", &instance.artifacts])?;
    if made {
        cf.json(&[
            "artifacts",
            "namespaces",
            "create",
            "--namespace",
            &instance.artifacts,
        ])?;
    }
    note(format!("Artifacts {}", instance.artifacts), made);

    // The Secrets Store: one per account, and cf can't create it.
    if instance.secrets.store.is_empty() {
        let mut store = String::new();
        guide.wait_for(
            "secrets_store_missing",
            "The account has no Secrets Store, and cf can't create one.",
            &[
                "Open https://dash.cloudflare.com → Secrets Store (under Storage & databases)."
                    .to_string(),
                "Create the store (Cloudflare allows one per account).".to_string(),
            ],
            || {
                let stores = cf.json(&["secrets-store", "stores", "list"])?;
                store = items(&stores, "result")
                    .first()
                    .map(|s| str_of(s, "id").to_string())
                    .unwrap_or_default();
                Ok(!store.is_empty())
            },
        )?;
        instance.secrets.store = store;
        save(instance)?;
    }
    for (secret, value, comment) in [
        (
            instance.secrets.registry_kek.clone(),
            base64(&rand::random::<[u8; 32]>()),
            format!("Gitmatrix {}: registry key-encryption key", instance.name),
        ),
        (
            instance.secrets.better_auth.clone(),
            base64(&rand::random::<[u8; 48]>()),
            format!("Gitmatrix {}: session signing", instance.name),
        ),
    ] {
        let listed = cf.json(&[
            "secrets-store",
            "secrets",
            "list",
            "--store-id",
            &instance.secrets.store,
            "--search",
            &secret,
            "--per-page",
            "100",
        ])?;
        let made = !items(&listed, "result")
            .iter()
            .any(|s| str_of(s, "name") == secret);
        if made {
            // The value goes in a private file, never on a command line.
            let body = tempfile::Builder::new().prefix("gm-secret-").tempfile()?;
            std::fs::write(
                body.path(),
                serde_json::to_vec(&json!([{
                    "name": secret,
                    "value": value,
                    "scopes": ["workers"],
                    "comment": comment,
                }]))?,
            )?;
            let argument = format!("@{}", body.path().display());
            cf.json(&[
                "secrets-store",
                "secrets",
                "create",
                &instance.secrets.store,
                "--body",
                &argument,
            ])?;
        }
        note(format!("Secret {secret}"), made);
    }

    if let Some(ai) = instance.ai.clone() {
        let made = !cf.exists(&["ai-gateway", "gateways", "get", &ai.gateway])?;
        if made {
            let body = json!({
                "id": ai.gateway,
                "authentication": true,
                "collect_logs": true,
                "cache_ttl": 0,
                "cache_invalidate_on_update": false,
                "rate_limiting_interval": 0,
                "rate_limiting_limit": 0,
                "workers_ai_billing_mode": "postpaid",
            })
            .to_string();
            cf.json(&["ai-gateway", "gateways", "create", "--body", &body])?;
        }
        note(format!("AI Gateway {}", ai.gateway), made);

        let made = !cf.exists(&["vectorize", "get", &ai.vectors])?;
        if made {
            let description = format!("Gitmatrix {}: knowledge", instance.name);
            cf.json(&[
                "vectorize",
                "create",
                "--name",
                &ai.vectors,
                "--config-dimensions",
                "1024",
                "--config-metric",
                "cosine",
                "--description",
                &description,
            ])?;
        }
        // Checked on every run: a failed run may have created the index but
        // not all of its metadata indexes.
        let listed = cf.json(&[
            "vectorize",
            "metadata-index",
            "list",
            "--index-name",
            &ai.vectors,
        ])?;
        let indexed: Vec<&str> = items(&listed, "metadataIndexes")
            .iter()
            .map(|m| str_of(m, "propertyName"))
            .collect();
        {
            for property in ["repo", "kind", "path"]
                .into_iter()
                .filter(|p| !indexed.contains(p))
            {
                cf.json(&[
                    "vectorize",
                    "metadata-index",
                    "create",
                    &ai.vectors,
                    "--property-name",
                    property,
                    "--index-type",
                    "string",
                ])?;
            }
        }
        note(format!("Vectorize {}", ai.vectors), made);

        let made = !cf.exists(&["ai-search", "namespace", "get", &ai.search])?;
        if made {
            let description = format!("Gitmatrix {}", instance.name);
            cf.json(&[
                "ai-search",
                "namespace",
                "create",
                &ai.search,
                "--description",
                &description,
            ])?;
        }
        let listed = cf.json(&[
            "ai-search",
            "list",
            "--name",
            &ai.search,
            "--per-page",
            "100",
        ])?;
        if !items(&listed, "result")
            .iter()
            .any(|s| str_of(s, "id") == "knowledge")
        {
            let metadata: Vec<Value> = ["repo", "kind", "path", "commit", "lang"]
                .iter()
                .map(|field| json!({ "field_name": field, "data_type": "text" }))
                .collect();
            let body = json!({
                "id": "knowledge",
                "ai_gateway_id": ai.gateway,
                "embedding_model": "@cf/qwen/qwen3-embedding-0.6b",
                "indexing_options": { "keyword_tokenizer": "trigram" },
                "custom_metadata": metadata,
            })
            .to_string();
            cf.json(&[
                "ai-search",
                "create",
                &ai.search,
                "knowledge",
                "--body",
                &body,
            ])?;
        }
        note(format!("AI Search {}", ai.search), made);
    }
    Ok(())
}

/// A D1 database's id, creating it if no database has that name.
fn d1(cf: &Cf, name: &str) -> Result<(String, bool)> {
    let listed = cf.json(&["d1", "list", "--name", name, "--per-page", "100"])?;
    if let Some(found) = items(&listed, "result")
        .iter()
        .find(|d| str_of(d, "name") == name)
    {
        return Ok((str_of(found, "uuid").to_string(), false));
    }
    let made = cf.json(&["d1", "create", "--name", name])?;
    let id = str_of(&made, "uuid").to_string();
    if id.is_empty() {
        return Err(GmError::new(
            "cloudflare_error",
            format!("cf created D1 {name} but returned no id."),
        ));
    }
    Ok((id, true))
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().fold(0u32, |n, b| (n << 8) | u32::from(*b)) << (8 * (3 - chunk.len()));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - 6 * i)) as usize & 63] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// gm instance deploy

fn deploy_command(ctx: &Ctx, args: &DeployArgs) -> Result<Shown> {
    let guide = Guide::new();
    let mut instance = load(&args.name)?.ok_or_else(|| {
        GmError::not_found(
            "instance_not_found",
            format!("No instance named {} on this machine.", args.name),
        )
        .hint("`gm instance list` shows them; `gm instance setup` creates one.")
    })?;
    if instance.db.id.is_empty()
        || instance.registry_db.id.is_empty()
        || instance.secrets.store.is_empty()
    {
        return Err(GmError::new(
            "setup_incomplete",
            format!("Instance {} isn't fully set up yet.", instance.name),
        )
        .hint(format!(
            "Run `gm instance setup {}` to finish it.",
            instance.name
        )));
    }
    let root = checkout(ctx, &args.source)?;
    let mut cf = Cf::new(&root)?;
    cf.account = Some(instance.account_id.clone());
    if ctx.dry_run {
        return Ok(Shown {
            text: format!(
                "Dry run: would apply pending migrations and deploy {} from {} to {}.",
                instance.worker,
                root.display(),
                instance.url()
            ),
            value: json!({ "dry_run": true, "instance": instance.name, "source": root, "url": instance.url() }),
        });
    }
    // A newer version may bind resources an older setup didn't create.
    guide.step("Checking resources");
    let mut created = Vec::new();
    provision(&cf, &guide, &mut instance, &mut created)?;
    let deployed = deploy(&cf, &guide, &root, &mut instance)?;
    Ok(Shown {
        text: format!("Deployed {} to {}.", deployed.commit, instance.url()),
        value: json!({
            "name": instance.name,
            "url": instance.url(),
            "created": created,
            "deployed": deployed,
        }),
    })
}

/// Apply pending migrations to both databases, deploy the Worker with the
/// instance file, and wait for it to answer.
fn deploy(cf: &Cf, guide: &Guide, root: &Path, instance: &mut Instance) -> Result<Deployed> {
    // A hand-edited file must never migrate or deploy over the canonical deploy.
    let reserved = instance.reserved_names();
    if !reserved.is_empty() {
        return Err(GmError::new(
            "reserved_name",
            format!(
                "The instance file names the canonical deploy's {}.",
                reserved.join(", ")
            ),
        ));
    }
    let file = save(instance)?;
    guide.step("Database migrations");
    cf.stream(
        &[
            "d1",
            "migrations",
            "apply",
            &instance.db.id,
            "--dir",
            "migrations",
        ],
        &[],
    )?;
    cf.stream(
        &[
            "d1",
            "migrations",
            "apply",
            &instance.registry_db.id,
            "--dir",
            "registry/migrations",
        ],
        &[],
    )?;
    guide.done("migrations applied");

    guide.step(&format!(
        "Deploying {} (builds the app and the CI image)",
        instance.worker
    ));
    let commit = git(root, &["rev-parse", "HEAD"])?;
    let dirty = !git(root, &["status", "--porcelain"])?.is_empty();
    if dirty {
        guide.say(&format!(
            "  ! {} has uncommitted changes; they deploy too, recorded as modified {}.",
            root.display(),
            &commit[..12]
        ));
    }
    let subject = git(root, &["log", "-1", "--format=%s", "HEAD"]).unwrap_or_default();
    let message: String = subject.chars().take(100).collect();
    let file_value = file.display().to_string();
    let mut deploy_args = vec!["deploy", "--tag", &commit];
    if !message.is_empty() {
        deploy_args.extend(["--message", &message]);
    }
    cf.stream(&deploy_args, &deploy_env(&file_value, &commit))?;
    let deployed = Deployed {
        commit,
        at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        dirty,
    };
    instance.deployed = Some(deployed.clone());
    save(instance)?;

    guide.step("Waiting for the instance to answer");
    wait_until_live(guide, instance);
    Ok(deployed)
}

/// What the Worker deploy adds to cf's environment: the instance file, and the
/// release the Space cutover names. The cutover's prepare accepts only the
/// deployed tagged release (CUTOVER_DEPLOYMENT_CHECKPOINT, which
/// cloudflare.config.ts binds from GITMATRIX_CUTOVER_CHECKPOINT), so it is
/// the commit `--tag` names, as tools/agent/deploy.ts sets it for the
/// canonical deploy.
fn deploy_env<'a>(file: &'a str, commit: &'a str) -> [(&'static str, &'a str); 2] {
    [
        ("GITMATRIX_INSTANCE_CONFIG", file),
        ("GITMATRIX_CUTOVER_CHECKPOINT", commit),
    ]
}

/// Wait for the new hostname to answer. Its DNS record appears as the deploy
/// ends; asking this machine's resolver before Cloudflare publishes it would
/// cache "no such host" for up to half an hour, so public DNS goes first.
fn wait_until_live(guide: &Guide, instance: &Instance) {
    let started = Instant::now();
    let published_url = format!(
        "https://cloudflare-dns.com/dns-query?name={}&type=A",
        instance.host
    );
    let published = || {
        ureq::get(&published_url)
            .header("accept", "application/dns-json")
            .call()
            .ok()
            .and_then(|mut r| r.body_mut().read_json::<Value>().ok())
            .is_some_and(|answer| answer["Answer"].as_array().is_some_and(|a| !a.is_empty()))
    };
    while !published() {
        if started.elapsed() > Duration::from_secs(120) {
            guide.say(&format!(
                "  ! {} isn't in public DNS yet; check the Worker's custom domain in the dashboard.",
                instance.host
            ));
            return;
        }
        std::thread::sleep(Duration::from_secs(3));
    }
    let url = format!("{}/api/session", instance.url());
    loop {
        let answered = ureq::get(&url)
            .call()
            .ok()
            .and_then(|mut r| r.body_mut().read_to_string().ok())
            .is_some_and(|body| body.contains("\"viewer\""));
        if answered {
            guide.done(&format!("{} answers", instance.url()));
            return;
        }
        if started.elapsed() > Duration::from_secs(300) {
            guide.say(&format!(
                "  ! {} is in public DNS but doesn't answer here yet: a new certificate can take a few \
                 more minutes, and this machine may have cached the name as missing (up to 30 minutes).",
                instance.url()
            ));
            return;
        }
        std::thread::sleep(Duration::from_secs(5));
    }
}

fn git(root: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git").args(args).current_dir(root).output()?;
    if !output.status.success() {
        return Err(GmError::new(
            "git_error",
            format!(
                "git {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

// ---------------------------------------------------------------------------
// gm instance upgrade
//
// Without our CI/CD, an instance changes only when its owner says so, to the
// version they choose. Upgrade fetches that version into a clone of gm's own
// (never the person's checkout: installing dependencies there rewrites its
// git hooks), builds it, and has the target's own gm deploy it, since only
// the target knows what resources and instance-file fields it needs.

/// Where the target version sits relative to what's deployed.
#[derive(Debug, PartialEq, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Same,
    Forward,
    Backward,
    Diverged,
    /// The deployed commit isn't in the upstream's history.
    Unknown,
}

/// Whether `target` is later than `base` in `repo`'s history.
pub fn direction(repo: &Path, base: &str, target: &str) -> Direction {
    let known =
        |commit: &str| git(repo, &["cat-file", "-e", &format!("{commit}^{{commit}}")]).is_ok();
    if !known(base) {
        return Direction::Unknown;
    }
    let ancestor = |a: &str, b: &str| {
        Command::new("git")
            .args(["merge-base", "--is-ancestor", a, b])
            .current_dir(repo)
            .status()
            .is_ok_and(|s| s.success())
    };
    let (base_full, target_full) = (
        git(repo, &["rev-parse", base]).unwrap_or_default(),
        git(repo, &["rev-parse", target]).unwrap_or_default(),
    );
    if base_full == target_full {
        Direction::Same
    } else if ancestor(base, target) {
        Direction::Forward
    } else if ancestor(target, base) {
        Direction::Backward
    } else {
        Direction::Diverged
    }
}

const MIGRATIONS: &[&str] = &[
    "apps/website/migrations",
    "apps/website/registry/migrations",
];

/// gm's clone of an upstream, under its cache directory, one per upstream.
fn source_clone(upstream: &str) -> PathBuf {
    let hash = upstream.bytes().fold(0xcbf29ce484222325u64, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x100000001b3)
    });
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("gitmatrix")
        .join("instance-sources")
        .join(format!("{hash:016x}"))
}

/// Run a build tool with its output on stderr (stdout is gm's result).
fn run_tool(dir: &Path, program: &str, args: &[&str], hint: &str) -> Result<()> {
    let status = Command::new(program)
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(std::io::stderr()))
        .stderr(Stdio::inherit())
        .status()
        .map_err(|e| {
            GmError::new("tool_missing", format!("Couldn't run {program}: {e}"))
                .hint(hint.to_string())
        })?;
    if status.success() {
        Ok(())
    } else {
        Err(GmError::new(
            "build_failed",
            format!(
                "`{program} {}` failed ({status}); its output is above.",
                args.join(" ")
            ),
        ))
    }
}

/// What installs a checkout's dependencies. gm assumes no Vite+: pnpm, the
/// repository's package manager, by default. Where `pnpm` on PATH is a shim
/// that can't run on its own (Vite+'s managed pnpm, invoked directly, says
/// "the global target of the pnpm shim points back at the shim"), Vite+'s
/// `vp install` runs pnpm for the same lockfile.
#[derive(Debug, PartialEq)]
enum Installer {
    Pnpm,
    Vp,
}

impl Installer {
    fn program(&self) -> &'static str {
        match self {
            Installer::Pnpm => "pnpm",
            Installer::Vp => "vp",
        }
    }

    fn args(&self) -> [&'static str; 2] {
        ["install", "--frozen-lockfile"]
    }

    fn command(&self) -> &'static str {
        match self {
            Installer::Pnpm => "pnpm install --frozen-lockfile",
            Installer::Vp => "vp install --frozen-lockfile",
        }
    }
}

/// Whether `program --version` runs in `dir`; if not, what it said.
fn probe(dir: &Path, program: &str) -> std::result::Result<(), String> {
    let output = Command::new(program)
        .arg("--version")
        .current_dir(dir)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        return Ok(());
    }
    let said = [&output.stderr, &output.stdout]
        .map(|bytes| String::from_utf8_lossy(bytes).trim().to_string())
        .into_iter()
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Err(if said.is_empty() {
        output.status.to_string()
    } else {
        tail(&said, 3)
    })
}

/// pnpm when it runs, else vp when it does. Probed before installing: a real
/// install's failure (a lockfile that doesn't match) is never retried with
/// the other, which would only hide it.
fn choose_installer(
    pnpm: std::result::Result<(), String>,
    vp: impl FnOnce() -> std::result::Result<(), String>,
) -> Result<Installer> {
    let Err(pnpm) = pnpm else {
        return Ok(Installer::Pnpm);
    };
    match vp() {
        Ok(()) => Ok(Installer::Vp),
        Err(vp) => Err(GmError::new(
            "tool_missing",
            format!(
                "Couldn't install dependencies: pnpm doesn't run ({pnpm}), and neither does Vite+'s vp ({vp})."
            ),
        )
        .hint("Install pnpm (https://pnpm.io/installation), or fix the pnpm on your PATH, then rerun. With Vite+, `vp` on your PATH also works.")),
    }
}

fn installer(dir: &Path) -> Result<Installer> {
    choose_installer(probe(dir, "pnpm"), || probe(dir, "vp"))
}

/// The command that deploys what a dry run reported, flags included: a
/// target that isn't known to be later needs --allow-downgrade.
fn upgrade_command(name: &str, args: &UpgradeArgs, forward: bool) -> String {
    let mut command = format!("gm instance upgrade {name}");
    if let Some(from) = &args.from {
        command.push_str(&format!(" --from {from}"));
    }
    if let Some(to) = &args.to {
        command.push_str(&format!(" --to {to}"));
    }
    if !forward {
        command.push_str(" --allow-downgrade");
    }
    command
}

fn upgrade(ctx: &Ctx, args: &UpgradeArgs) -> Result<Shown> {
    let guide = Guide::new();
    let mut instance = load(&args.name)?.ok_or_else(|| {
        GmError::not_found(
            "instance_not_found",
            format!("No instance named {} on this machine.", args.name),
        )
        .hint("`gm instance list` shows them; `gm instance setup` creates one.")
    })?;
    let Some(deployed) = instance.deployed.clone() else {
        return Err(GmError::new(
            "not_deployed",
            format!("Instance {} hasn't been deployed yet.", instance.name),
        )
        .hint(format!(
            "Finish it with `gm instance setup {}`.",
            instance.name
        )));
    };
    // The upstream: --from, else the instance's, else the origin of the
    // checkout around the current directory.
    let upstream = match args.from.clone().or(instance.upstream.clone()) {
        Some(upstream) => upstream,
        None => checkout(ctx, &None)
            .ok()
            .and_then(|root| git(&root, &["remote", "get-url", "origin"]).ok())
            .ok_or_else(|| {
                GmError::usage(format!(
                    "Instance {} has no upstream to upgrade from: pass --from <git URL>.",
                    instance.name
                ))
            })?,
    };
    // A local path is resolved now, so the instance remembers where it is.
    let upstream = {
        let path = ctx.cwd.join(&upstream);
        if !upstream.contains("://") && !upstream.contains('@') && path.exists() {
            path.canonicalize()?.display().to_string()
        } else {
            upstream
        }
    };
    let reference = args.to.clone().unwrap_or_else(|| "main".to_string());

    // 1. Fetch the upstream into gm's clone, one upgrade at a time.
    guide.step(&format!("Fetching {reference} from {upstream}"));
    let clone = source_clone(&upstream);
    std::fs::create_dir_all(clone.parent().expect("clone has a parent"))?;
    let lock_file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(clone.with_extension("lock"))?;
    let mut lock = fd_lock::RwLock::new(lock_file);
    let _held = lock.try_write().map_err(|_| {
        GmError::new(
            "upgrade_in_progress",
            "Another upgrade is using this upstream's source; try again when it finishes.",
        )
    })?;
    if !clone.join(".git").exists() {
        let parent = clone.parent().expect("clone has a parent");
        let target = clone.display().to_string();
        run_tool(
            parent,
            "git",
            &["clone", "--quiet", "--no-checkout", &upstream, &target],
            "Install git.",
        )?;
    } else {
        git(&clone, &["remote", "set-url", "origin", &upstream])?;
    }
    run_tool(
        &clone,
        "git",
        &[
            "fetch",
            "--quiet",
            "--prune",
            "origin",
            "+refs/heads/*:refs/remotes/origin/*",
        ],
        "Check that the upstream is reachable.",
    )?;
    // A branch name, else a commit (abbreviated or full) the upstream has.
    let target = git(
        &clone,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/remotes/origin/{reference}^{{commit}}"),
        ],
    )
    .or_else(|_| {
        git(
            &clone,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("{reference}^{{commit}}"),
            ],
        )
    })
    .map_err(|_| {
        GmError::not_found(
            "version_not_found",
            format!("{upstream} has no branch or commit {reference}."),
        )
    })?;
    let short = |commit: &str| commit[..commit.len().min(12)].to_string();

    // 2. What changes.
    let direction = direction(&clone, &deployed.commit, &target);
    let range = format!("{}..{target}", deployed.commit);
    let known = direction != Direction::Unknown;
    let commits: Vec<String> = if known {
        git(&clone, &["log", "--format=%h %s", &range])?
            .lines()
            .map(str::to_string)
            .collect()
    } else {
        Vec::new()
    };
    let added = |from: &str, to: &str| -> Vec<String> {
        let mut args = vec!["diff", "--name-only", "--diff-filter=A", from, to, "--"];
        args.extend(MIGRATIONS);
        git(&clone, &args)
            .map(|out| out.lines().map(str::to_string).collect())
            .unwrap_or_default()
    };
    let migrations = if known {
        added(&deployed.commit, &target)
    } else {
        Vec::new()
    };
    let kept = if matches!(direction, Direction::Backward | Direction::Diverged) {
        added(&target, &deployed.commit)
    } else {
        Vec::new()
    };
    let ci_image = known
        && !git(
            &clone,
            &[
                "diff",
                "--name-only",
                &deployed.commit,
                &target,
                "--",
                "apps/website/ci",
            ],
        )?
        .is_empty();
    let supports = git(
        &clone,
        &[
            "cat-file",
            "-e",
            &format!("{target}:apps/cli/src/commands/instance.rs"),
        ],
    )
    .is_ok();

    let mut report = vec![format!(
        "Deployed  {}{} ({})",
        short(&deployed.commit),
        if deployed.dirty {
            " with uncommitted changes"
        } else {
            ""
        },
        deployed.at
    )];
    report.push(format!("Target    {} ({reference})", short(&target)));
    match direction {
        Direction::Same => report.push("Already at this version.".into()),
        Direction::Forward => report.push(format!(
            "{} new commit{}:",
            commits.len(),
            if commits.len() == 1 { "" } else { "s" }
        )),
        Direction::Backward => {
            let behind = git(
                &clone,
                &[
                    "rev-list",
                    "--count",
                    &format!("{target}..{}", deployed.commit),
                ],
            )?;
            report.push(format!(
                "The target is {behind} commit{} behind what's deployed.",
                if behind == "1" { "" } else { "s" }
            ))
        }
        Direction::Diverged => {
            report.push("The target isn't on the deployed version's line of history.".into())
        }
        Direction::Unknown => report.push(format!(
            "{upstream} doesn't have the deployed commit, so the changes can't be listed."
        )),
    }
    if direction == Direction::Forward {
        for line in commits.iter().take(20) {
            report.push(format!("  {line}"));
        }
        if commits.len() > 20 {
            report.push(format!("  … and {} more", commits.len() - 20));
        }
    }
    if !migrations.is_empty() {
        report.push(format!(
            "Database migrations to apply: {}",
            migrations.len()
        ));
        for path in &migrations {
            report.push(format!("  {}", path.rsplit('/').next().unwrap_or(path)));
        }
    }
    if ci_image {
        report.push("The CI image changes (rebuilt with Docker).".into());
    }
    if !kept.is_empty() {
        report.push(format!(
            "These migrations stay applied (D1 doesn't roll back): {}",
            kept.iter()
                .map(|p| p.rsplit('/').next().unwrap_or(p))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if deployed.dirty && known {
        report.push("The deployed build had uncommitted changes; this replaces them.".into());
    }
    guide.step("Upgrade");
    for line in &report {
        guide.say(&format!("  {line}"));
    }
    let summary = json!({
        "name": instance.name,
        "upstream": upstream,
        "from": deployed,
        "to": { "ref": reference, "commit": target },
        "direction": direction,
        "commits": commits,
        "migrations": migrations,
        "migrationsKept": kept,
        "ciImage": ci_image,
    });

    if direction == Direction::Same && !deployed.dirty {
        return Ok(Shown {
            text: format!(
                "Instance {} is already at {}.",
                instance.name,
                short(&target)
            ),
            value: json!({ "upgraded": false, "upgrade": summary }),
        });
    }
    if !supports {
        return Err(GmError::new(
            "version_unsupported",
            format!(
                "{} predates `gm instance`, so it can't deploy itself to an instance.",
                short(&target)
            ),
        ));
    }
    let forward = matches!(direction, Direction::Forward | Direction::Same);
    if ctx.dry_run {
        return Ok(Shown {
            text: format!(
                "Dry run: nothing changed. Run `{}` to deploy {}.",
                upgrade_command(&instance.name, args, forward),
                short(&target)
            ),
            value: json!({ "dry_run": true, "upgrade": summary }),
        });
    }
    if !forward && !args.allow_downgrade {
        return Err(GmError::new(
            "not_an_upgrade",
            format!(
                "{} isn't known to be later than what's deployed ({}).",
                short(&target),
                short(&deployed.commit)
            ),
        )
        .hint("Check the target, or pass --allow-downgrade to deploy it anyway."));
    }
    if !args.yes {
        if !guide.interactive {
            return Err(GmError::usage(
                "Upgrading deploys to the instance and needs confirmation: pass --yes.",
            ));
        }
        if !guide.confirm(
            &format!("Deploy {} to {}?", short(&target), instance.url()),
            true,
        )? {
            return Err(GmError::new("aborted", "Nothing was deployed."));
        }
    }

    // 3. The target's source, exactly: no leftovers from another version.
    guide.step(&format!("Building {}", short(&target)));
    git(
        &clone,
        &["checkout", "--quiet", "--force", "--detach", &target],
    )?;
    git(&clone, &["clean", "--quiet", "-fd"])?;
    let install = installer(&clone)?;
    run_tool(
        &clone,
        install.program(),
        &install.args(),
        "Install pnpm (https://pnpm.io/installation).",
    )?;
    run_tool(
        &clone,
        "cargo",
        &[
            "build",
            "--release",
            "--quiet",
            "--manifest-path",
            "apps/cli/Cargo.toml",
        ],
        "Install a Rust toolchain (https://rustup.rs).",
    )?;
    let new_gm = clone.join("apps/cli/target/release/gm");

    // 4. The target's gm deploys it (and creates what it newly needs).
    instance.upstream = Some(upstream.clone());
    save(&instance)?;
    guide.step(&format!("Deploying {} with its own gm", short(&target)));
    let source = clone.display().to_string();
    let output = Command::new(&new_gm)
        .args([
            "instance",
            "deploy",
            &instance.name,
            "--source",
            &source,
            "-o",
            "json",
        ])
        .stdin(if guide.interactive {
            Stdio::inherit()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .output()?;
    if !output.status.success() {
        return Err(GmError::new(
            "deploy_failed",
            format!(
                "The deploy of {} failed; its output is above. {} is unchanged where the deploy didn't reach.",
                short(&target),
                instance.url()
            ),
        )
        .hint(format!("Fix the cause, then rerun `gm instance upgrade {}`.", instance.name)));
    }
    let result: Value = serde_json::from_slice(&output.stdout).unwrap_or(Value::Null);
    Ok(Shown {
        text: format!(
            "Upgraded {} from {} to {}: {}\nThe gm for this version is {}.",
            instance.name,
            short(&deployed.commit),
            short(&target),
            instance.url(),
            new_gm.display()
        ),
        value: json!({ "upgraded": true, "upgrade": summary, "deploy": result, "gm": new_gm }),
    })
}

// ---------------------------------------------------------------------------
// gm instance list / show

fn list() -> Result<Shown> {
    let instances = all_instances()?;
    let mut text = String::new();
    if instances.is_empty() {
        text.push_str("No instances on this machine. `gm instance setup` creates one.");
    }
    for instance in &instances {
        let state = match &instance.deployed {
            Some(d) => format!(
                "deployed {} at {}",
                &d.commit[..d.commit.len().min(12)],
                d.at
            ),
            None => "setup unfinished".to_string(),
        };
        text.push_str(&format!(
            "{:<16} https://{:<40} {state}\n",
            instance.name, instance.host
        ));
    }
    Ok(Shown {
        value: json!({
            "instances": instances.iter().map(|i| json!({
                "name": i.name,
                "url": i.url(),
                "accountId": i.account_id,
                "worker": i.worker,
                "ai": i.ai.is_some(),
                "deployed": i.deployed,
                "file": instance_path(&i.name),
            })).collect::<Vec<_>>(),
        }),
        text: text.trim_end().to_string(),
    })
}

fn show(name: &str) -> Result<Shown> {
    let instance = load(name)?.ok_or_else(|| {
        GmError::not_found(
            "instance_not_found",
            format!("No instance named {name} on this machine."),
        )
        .hint("`gm instance list` shows them.")
    })?;
    let mut text = format!(
        "{} — {}\nAccount {}\nFile {}\n",
        instance.name,
        instance.url(),
        instance.account_id,
        instance_path(name).display()
    );
    for line in plan_lines(&instance) {
        text.push_str(&format!("{line}\n"));
    }
    match &instance.deployed {
        Some(d) => text.push_str(&format!("Deployed {} at {}", d.commit, d.at)),
        None => text.push_str(&format!("Setup unfinished: gm instance setup {name}")),
    }
    Ok(Shown {
        value: json!({ "instance": instance, "file": instance_path(name) }),
        text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derived_names_are_the_instances_own() {
        for name in ["demo", "acme", "a1", "team-two"] {
            let mut instance = derive(name);
            instance.host = format!("timelines-{name}.example.com");
            instance.ai = Some(ai_names(name));
            assert!(instance.reserved_names().is_empty(), "{name}");
            assert_eq!(instance.worker, format!("gitmatrix-{name}"));
            assert!(instance.queues.registry_jobs.ends_with("-registry-jobs"));
            assert!(!instance.queues.jobs.ends_with("-registry-jobs"));
            assert!(
                instance
                    .secrets
                    .better_auth
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            );
        }
    }

    #[test]
    fn hosts_are_checked() {
        assert!(valid_host("timelines.example.com").is_ok());
        assert!(valid_host("example.com").is_err());
        assert!(valid_host("Timelines.example.com").is_err());
        assert!(valid_host("timelines.example.c0m").is_err());
    }

    #[test]
    fn hosts_find_their_zone() {
        let zones = [
            Zone {
                id: "1".into(),
                name: "example.com".into(),
            },
            Zone {
                id: "2".into(),
                name: "dev.example.com".into(),
            },
        ];
        assert_eq!(zone_for("a.example.com", &zones).unwrap().id, "1");
        assert_eq!(zone_for("a.dev.example.com", &zones).unwrap().id, "2");
        assert!(zone_for("a.example.org", &zones).is_none());
        assert!(zone_for("badexample.com", &zones).is_none());
    }

    #[test]
    fn direction_follows_history() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        let run = |args: &[&str]| {
            let ok = Command::new("git")
                .args(args)
                .current_dir(repo)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@example.com")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@example.com")
                .output()
                .unwrap();
            assert!(ok.status.success(), "{args:?}");
            String::from_utf8(ok.stdout).unwrap().trim().to_string()
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["commit", "-q", "--allow-empty", "-m", "a"]);
        let a = run(&["rev-parse", "HEAD"]);
        run(&["commit", "-q", "--allow-empty", "-m", "b"]);
        let b = run(&["rev-parse", "HEAD"]);
        run(&["checkout", "-q", "--detach", &a]);
        run(&["commit", "-q", "--allow-empty", "-m", "c"]);
        let c = run(&["rev-parse", "HEAD"]);
        assert_eq!(direction(repo, &a, &a), Direction::Same);
        assert_eq!(direction(repo, &a, &b), Direction::Forward);
        assert_eq!(direction(repo, &b, &a), Direction::Backward);
        assert_eq!(direction(repo, &b, &c), Direction::Diverged);
        assert_eq!(
            direction(repo, "0123456789abcdef0123456789abcdef01234567", &b),
            Direction::Unknown
        );
    }

    #[test]
    fn dry_runs_suggest_the_flags_the_upgrade_needs() {
        let args = |to: Option<&str>| UpgradeArgs {
            name: "demo".into(),
            to: to.map(str::to_string),
            from: Some("https://example.com/timelines.git".into()),
            allow_downgrade: false,
            yes: false,
        };
        assert_eq!(
            upgrade_command("demo", &args(None), true),
            "gm instance upgrade demo --from https://example.com/timelines.git"
        );
        assert_eq!(
            upgrade_command("demo", &args(Some("1a2b3c")), false),
            "gm instance upgrade demo --from https://example.com/timelines.git --to 1a2b3c --allow-downgrade"
        );
    }

    #[test]
    fn older_instance_files_still_load() {
        let mut value = serde_json::to_value(derive("demo")).unwrap();
        value.as_object_mut().unwrap().remove("upstream");
        value["deployed"] = json!({ "commit": "abc", "at": "2026-10-13T02:11:37Z" });
        let instance: Instance = serde_json::from_value(value).unwrap();
        assert!(!instance.deployed.unwrap().dirty);
        assert!(instance.upstream.is_none());
    }

    #[test]
    fn deploys_name_their_tagged_commit_as_the_cutover_checkpoint() {
        let commit = "24e5b7af1a7e72ccd971a83cef74ecefa08afa14";
        let env = deploy_env("/tmp/demo.json", commit);
        assert!(env.contains(&("GITMATRIX_CUTOVER_CHECKPOINT", commit)));
        assert!(env.contains(&("GITMATRIX_INSTANCE_CONFIG", "/tmp/demo.json")));
        // Nothing from the operator's shell reaches any other cf call.
        let cf = Cf {
            bin: PathBuf::from("cf"),
            website: PathBuf::from("."),
            account: None,
        };
        let command = cf.command(&["deploy"]);
        let removed: Vec<_> = command
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(key, _)| key.to_string_lossy().into_owned())
            .collect();
        assert!(removed.contains(&"GITMATRIX_CUTOVER_CHECKPOINT".to_string()));
        assert!(removed.contains(&"GITMATRIX_DEPLOY".to_string()));
        // Exported production values stay, so the instance guards can see them.
        assert!(!removed.contains(&"GITMATRIX_PRODUCTION_HOST".to_string()));
    }

    #[test]
    fn installs_use_pnpm_unless_only_vp_runs() {
        let shim = || Err("the global target of the pnpm shim points back at the shim".to_string());
        let unreachable = || -> std::result::Result<(), String> { panic!("vp probed") };
        assert_eq!(
            choose_installer(Ok(()), unreachable).unwrap(),
            Installer::Pnpm
        );
        assert_eq!(choose_installer(shim(), || Ok(())).unwrap(), Installer::Vp);
        let missing = || Err("No such file or directory (os error 2)".to_string());
        assert_eq!(
            choose_installer(missing(), || Ok(())).unwrap(),
            Installer::Vp
        );
        let error = choose_installer(shim(), missing).unwrap_err();
        assert_eq!(error.code, "tool_missing");
        assert!(
            error.message.contains("points back at the shim"),
            "{}",
            error.message
        );
        assert!(error.message.contains("os error 2"), "{}", error.message);
        assert_eq!(Installer::Vp.command(), "vp install --frozen-lockfile");
        assert_eq!(Installer::Pnpm.args(), ["install", "--frozen-lockfile"]);
    }

    #[test]
    fn sign_in_runs_the_checkouts_own_cf() {
        let cf = Path::new("/src/gitmatrix/apps/website/node_modules/.bin/cf");
        assert_eq!(
            login_command(cf),
            "/src/gitmatrix/apps/website/node_modules/.bin/cf auth login"
        );
    }

    #[test]
    fn the_file_round_trips_in_the_shape_vite_reads() {
        let mut instance = derive("demo");
        instance.ai = Some(ai_names("demo"));
        let value = serde_json::to_value(&instance).unwrap();
        // apps/website/vite/instance.ts reads these camelCase fields.
        for path in [
            "/registryDb/name",
            "/buckets/stepArtifacts",
            "/queues/registryJobs",
            "/workflows/knowledgeBuild",
            "/workflows/ciRun",
            "/workflows/repoPurge",
            "/secrets/registryKek",
            "/secrets/betterAuth",
            "/rateLimitNamespace",
            "/owner/org",
            "/emailFrom",
            "/ai/vectors",
        ] {
            assert!(value.pointer(path).is_some(), "{path}");
        }
        let back: Instance = serde_json::from_value(value).unwrap();
        assert_eq!(back, instance);
    }
}
