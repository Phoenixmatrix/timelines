//! How coding agents work on a repository (`gm agent setup`):
//!
//! - `.gitmatrix/agents.yml`, committed: the tracker and scope agents work in,
//!   lease length, the instruction file agents read, and how work ships before
//!   it's completed.
//! - `.gitmatrix/agent.local.yml`, not committed: this checkout's agent — its
//!   name, harness, model and tags, and any scope of its own.
//!
//! The agent's token lives with gm's other credentials (gm.json), never here;
//! its advisory capability profile lives on the server (`gm agent configure`).
//! When an agent harness drives gm in a checkout with a local profile, gm acts
//! as that agent; the person typing in their own terminal stays themselves.

use crate::output::{GmError, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const PROJECT_FILE: &str = ".gitmatrix/agents.yml";
pub const LOCAL_FILE: &str = ".gitmatrix/agent.local.yml";
/// The skill every agent gets, managed by `gm agent setup`.
pub const GRAPH_SKILL: &str = "gitmatrix-graph-work";
pub const DEFAULT_TTL: u32 = 900;

/// How gm guides an agent when work needs a human. Existing/unconfigured
/// checkouts retain their harness's behavior; new setups opt into autonomy.
#[derive(Serialize, Deserialize, Default, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InterventionMode {
    Autonomous,
    #[default]
    Harness,
}

impl std::str::FromStr for InterventionMode {
    type Err = String;

    fn from_str(value: &str) -> std::result::Result<Self, String> {
        match value {
            "autonomous" => Ok(Self::Autonomous),
            "harness" => Ok(Self::Harness),
            other => Err(format!("{other} isn't one of autonomous, harness")),
        }
    }
}

impl std::fmt::Display for InterventionMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Autonomous => "autonomous",
            Self::Harness => "harness",
        })
    }
}

impl InterventionMode {
    pub fn guidance(self) -> &'static str {
        match self {
            Self::Autonomous => concat!(
                "Minimize interactive prompts. Resolve questions from available code, docs and issue context first; ",
                "make safe, reversible decisions within the user's authorization. If human input is necessary, ",
                "checkpoint what you tried and open a durable request on the issue with `gm issue ask`, ",
                "rather than stopping the whole session for a chat reply. Use `--kind decision` with repeated ",
                "`--choice` options for multiple choice, `--kind question` for an answer or blocker, ",
                "`--kind approval` for permission, or `--kind credential --secret space/repo:NAME` for a secret. ",
                "Include the blocker, its impact, options/tradeoffs and the specific action needed; never include secrets. ",
                "Check existing requests to avoid duplicate asks. Link dependency blockers with `gm issue link BLOCKER ISSUE`; ",
                "a link alone does not request human action. Requests go to your accountable person's Needs you panel ",
                "and park your held lease. Do not release that parked claim. Continue independent work only within ",
                "the user's requested scope; do not widen it. At the next work boundary or later invocation, ",
                "check `gm request list --status answered`; inspect all requests with ",
                "`gm request list --issue ISSUE --status all` and `gm issue resume ISSUE` ",
                "when all its requests are resolved. If nothing authorized is actionable, checkpoint and stop cleanly; ",
                "do not busy-poll or repeatedly prompt. This mode never grants permissions or bypasses required approvals."
            ),
            Self::Harness => concat!(
                "Use the agent or harness's normal human-intervention behavior, including its own interactive prompts ",
                "or software-factory workflow. gm does not require asynchronous requests or continuing other work. ",
                "Durable `gm issue ask` requests remain available when that workflow chooses them; they appear in the ",
                "accountable person's Needs you panel and park a held lease until the requests are resolved. ",
                "This setting never grants permissions or bypasses required approvals."
            ),
        }
    }
}

pub fn intervention(project: &Project, local: &Local) -> InterventionMode {
    local
        .intervention
        .or(project.intervention)
        .unwrap_or_default()
}

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    /// Immutable global Space handle.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space: Option<String>,
    /// Team key `gm issue next` picks from, e.g. CORE.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    /// Only work under this issue (a project or other parent), e.g. CORE-4.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub under: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Instructions {
    /// The instruction file that gets gm's managed section; otherwise the
    /// harness's own (AGENTS.md, CLAUDE.md, GEMINI.md), else AGENTS.md.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    /// How work ships before an issue is completed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ship: Option<String>,
}

/// `.gitmatrix/agents.yml`.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Project {
    #[serde(default)]
    pub tracker: Scope,
    /// Seconds a lease lasts before it must be renewed (30 to 86400).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl: Option<u32>,
    /// Default human-intervention behavior; a checkout may override it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intervention: Option<InterventionMode>,
    #[serde(default, skip_serializing_if = "is_default")]
    pub instructions: Instructions,
}

/// Which discovered skills an agent's profile publishes (CORE-104). Profiles
/// are visible to members of your trackers, and skills in your home directory
/// can say a lot about your private tools, so only the repository's skills are
/// published unless you opt in.
#[derive(Serialize, Deserialize, Default, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Publish {
    /// The repository's own skills (.agents/skills, .claude/skills… up to its root).
    #[default]
    Repo,
    /// Those and your user-level skills (~/.claude/skills, ~/.agents/skills…).
    All,
    /// No discovered skills; declared ones (`--skill`) still are.
    None,
}

impl std::str::FromStr for Publish {
    type Err = String;
    fn from_str(value: &str) -> std::result::Result<Self, String> {
        match value {
            "repo" => Ok(Publish::Repo),
            "all" => Ok(Publish::All),
            "none" => Ok(Publish::None),
            other => Err(format!("{other} isn't one of repo, all, none")),
        }
    }
}

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SkillPolicy {
    #[serde(default)]
    pub publish: Publish,
    /// Skills published whatever the scope (say, one personal skill worth sharing).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allow: Vec<String>,
    /// Skills never published; wins over everything else.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deny: Vec<String>,
}

impl SkillPolicy {
    /// Whether a discovered skill is published: `user` when found outside the repository.
    pub fn publishes(&self, name: &str, user: bool) -> bool {
        if self.deny.iter().any(|d| d == name) {
            return false;
        }
        if self.allow.iter().any(|a| a == name) {
            return true;
        }
        match self.publish {
            Publish::All => true,
            Publish::Repo => !user,
            Publish::None => false,
        }
    }
}

/// `.gitmatrix/agent.local.yml`.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Local {
    /// The agent identity's name (yours, accountable to you).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// claude-code, codex, cursor-agent…
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness: Option<String>,
    /// The model it runs, as you declare it (never inferred).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Published in its capability profile.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// Overrides the project's scope for this checkout.
    #[serde(default, skip_serializing_if = "is_default")]
    pub scope: Scope,
    /// Which discovered skills its profile publishes (default: the repository's).
    #[serde(default, skip_serializing_if = "is_default")]
    pub skills: SkillPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intervention: Option<InterventionMode>,
    /// The timeline this checkout works in (`gm timeline use`): pushes go to
    /// its bookmark `timeline/<slug>`, never to trunk. Worktrees inherit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeline: Option<String>,
}

fn is_default<T: Default + PartialEq>(value: &T) -> bool {
    *value == T::default()
}

/// The header gm writes above `.gitmatrix/agent.local.yml`.
pub const LOCAL_HEADER: &str = "\
# This checkout's agent, written by `gm agent setup`. Not committed.
# Edit and rerun `gm agent setup` to republish its profile. Its token is kept
# with gm's credentials, not here.
\n";

/// Save this checkout's agent profile.
pub fn write_local(root: &Path, local: &Local) -> Result<()> {
    let text = serde_yaml_ng::to_string(local)
        .map_err(|e| GmError::new("invalid_config", e.to_string()))?;
    std::fs::write(root.join(LOCAL_FILE), format!("{LOCAL_HEADER}{text}"))?;
    Ok(())
}

/// The model a harness says it runs, from its own documented setting. Never
/// inferred from which harness it is: no setting, no model.
pub fn declared_model(harness: Option<&str>) -> Option<String> {
    let variable = match harness? {
        "claude-code" => "ANTHROPIC_MODEL",
        "gemini-agent" => "GEMINI_MODEL",
        _ => return None,
    };
    std::env::var(variable)
        .ok()
        .map(|model| model.trim().to_string())
        .filter(|model| !model.is_empty() && model.chars().count() <= 120)
}

/// The model a step was made with (CORE-397), as declared, never inferred:
/// GM_MODEL; else, for a step an agent's harness made, this checkout's agent
/// profile (`gm agent configure --model`), then the harness's own setting.
pub fn step_model(harness: Option<&str>) -> Option<String> {
    let local = harness.map(|_| current().1);
    pick_model(
        std::env::var("GM_MODEL").ok(),
        harness,
        local.map(|local| (local.harness, local.model)),
        declared_model,
    )
}

/// [`step_model`]'s choice, from what it was given. The profile's model counts
/// only for the harness it was set up for (or one it doesn't name).
fn pick_model(
    env: Option<String>,
    harness: Option<&str>,
    profile: Option<(Option<String>, Option<String>)>,
    declared: impl Fn(Option<&str>) -> Option<String>,
) -> Option<String> {
    let profile = profile.and_then(|(set_for, model)| {
        set_for
            .as_deref()
            .is_none_or(|set_for| Some(set_for) == harness)
            .then_some(model)?
    });
    let clean = |model: String| {
        let model = model.trim().to_string();
        (!model.is_empty() && model.chars().count() <= 120).then_some(model)
    };
    env.and_then(clean).or_else(|| {
        harness?;
        profile.and_then(clean).or_else(|| declared(harness))
    })
}

/// When an agent drives gm in a checkout whose agent has no model on record:
/// what to tell it, so it records the model it knows it runs.
pub fn model_notice() -> Option<String> {
    let harness = crate::agent::detect()?;
    let (_, local) = current();
    let name = local.name.as_ref()?;
    if local.model.is_some()
        || declared_model(local.harness.as_deref().or(Some(harness.id))).is_some()
    {
        return None;
    }
    Some(format!(
        "Your agent profile ({name}) doesn't say which model you are. Record it once, with your exact model id: gm agent configure --model <model-id>"
    ))
}

/// Where a harness reads instructions and skills.
pub struct Layout {
    /// Instruction files it reads, preferred first.
    pub instructions: &'static [&'static str],
    /// Skill directories it loads, relative to the repository root.
    pub skills: &'static [&'static str],
}

pub fn layout(harness: &str) -> Layout {
    match harness {
        "claude-code" => Layout {
            instructions: &["AGENTS.md", "CLAUDE.md"],
            skills: &[".agents/skills", ".claude/skills"],
        },
        "gemini-agent" => Layout {
            instructions: &["AGENTS.md", "GEMINI.md"],
            skills: &[".agents/skills"],
        },
        _ => Layout {
            instructions: &["AGENTS.md"],
            skills: &[".agents/skills"],
        },
    }
}

/// The directory gm was run in (`-C` included), set once at startup.
static DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn set_dir(dir: &Path) {
    let _ = DIR.set(dir.to_path_buf());
}

/// The repository root above `dir`: the nearest directory with `.git` or `.gitmatrix`.
pub fn root_from(dir: &Path) -> Option<PathBuf> {
    dir.ancestors()
        .find(|d| d.join(".git").exists() || d.join(".gitmatrix").is_dir())
        .map(Path::to_path_buf)
}

pub fn root() -> Option<PathBuf> {
    let dir = DIR
        .get()
        .cloned()
        .or_else(|| std::env::current_dir().ok())?;
    root_from(&dir)
}

fn read<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    // A file with only comments is an empty configuration.
    let empty = text
        .lines()
        .all(|l| l.trim().is_empty() || l.trim_start().starts_with('#'));
    serde_yaml_ng::from_str(if empty { "{}" } else { &text })
        .map(Some)
        .map_err(|e| {
            GmError::new("invalid_config", format!("{}: {e}", path.display()))
                .hint("Use tracker.space (or scope.space) and project instead of owner/workspace after verifying the mapped Space. Fix the file and rerun; do not discard queued replica data.")
        })
}

pub fn project_at(root: &Path) -> Result<Option<Project>> {
    read(&root.join(PROJECT_FILE))
}

pub fn local_at(root: &Path) -> Result<Option<Local>> {
    read(&root.join(LOCAL_FILE))
}

/// Validate scope before commands can use advisory defaults from `current`.
pub fn validate_current() -> Result<()> {
    if let Some(root) = root() {
        project_at(&root)?;
        local_at(&root)?;
    }
    Ok(())
}
/// This checkout's configuration, if any; a broken file counts as none here
/// (`gm agent setup` reports the error).
pub fn current() -> (Project, Local) {
    let Some(root) = root() else {
        return Default::default();
    };
    (
        project_at(&root).ok().flatten().unwrap_or_default(),
        local_at(&root).ok().flatten().unwrap_or_default(),
    )
}

/// Whether `slug` names a timeline: lowercase letters and digits joined by
/// single hyphens (the server's rule). `main` names main, not a timeline.
pub fn is_timeline_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug != "main"
        && slug.len() <= 64
        && slug.split('-').all(|w| {
            !w.is_empty()
                && w.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

/// The timeline gm works in for the checkout at `root`: `GM_TIMELINE` when
/// set (`main` or empty: none), else the checkout's binding in
/// `.gitmatrix/agent.local.yml`. Everything timeline-aware (pushes, trunk,
/// tracker tagging) reads it from here.
pub fn timeline_at(root: Option<&Path>) -> Option<String> {
    if let Ok(value) = std::env::var(TIMELINE_ENV) {
        let value = value.trim().to_string();
        return is_timeline_slug(&value).then_some(value);
    }
    bound_timeline(root?)
}

/// The variable that names the timeline for one command, over the checkout's binding.
pub const TIMELINE_ENV: &str = "GM_TIMELINE";

/// The timeline this checkout is bound to in its local file, ignoring `GM_TIMELINE`.
pub fn bound_timeline(root: &Path) -> Option<String> {
    local_at(root)
        .ok()
        .flatten()
        .and_then(|local| local.timeline)
        .filter(|slug| is_timeline_slug(slug))
}

/// The timeline gm works in here (see [`timeline_at`]).
pub fn timeline() -> Option<String> {
    timeline_at(root().as_deref())
}

/// The agent gm acts as here: only when a harness is driving and this checkout
/// was set up for an agent.
pub fn acting_agent() -> Option<String> {
    crate::agent::detect()?;
    current().1.name
}

/// Defaults for `gm issue next` and friends: this checkout's, then the project's.
pub struct Defaults {
    pub agent: Option<String>,
    pub scope: Scope,
    /// The file `scope.team` came from: [`LOCAL_FILE`] or [`PROJECT_FILE`].
    pub team_from: Option<&'static str>,
    pub ttl: u32,
    pub intervention: InterventionMode,
}

pub fn defaults() -> Defaults {
    let (project, local) = current();
    resolve(&project, &local)
}

fn resolve(project: &Project, local: &Local) -> Defaults {
    let pick = |mine: &Option<String>, shared: &Option<String>| mine.clone().or(shared.clone());
    let team_from = if local.scope.team.is_some() {
        Some(LOCAL_FILE)
    } else if local.scope.under.is_none() && project.tracker.team.is_some() {
        Some(PROJECT_FILE)
    } else {
        None
    };
    Defaults {
        team_from,
        agent: local.name.clone(),
        scope: Scope {
            space: pick(&local.scope.space, &project.tracker.space),
            // A checkout scoped under an issue isn't also limited by the project's team.
            team: if local.scope.under.is_some() {
                local.scope.team.clone()
            } else {
                pick(&local.scope.team, &project.tracker.team)
            },
            under: pick(&local.scope.under, &project.tracker.under),
            project: pick(&local.scope.project, &project.tracker.project),
        },
        ttl: local.ttl.or(project.ttl).unwrap_or(DEFAULT_TTL),
        intervention: intervention(project, local),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_steps_model_is_declared_never_inferred() {
        let declared = |h: Option<&str>| (h == Some("claude-code")).then(|| "from-env".to_string());
        let profile = |harness: Option<&str>, model: &str| {
            Some((harness.map(str::to_string), Some(model.to_string())))
        };
        // GM_MODEL wins, for anyone.
        assert_eq!(
            pick_model(Some(" opus-x ".into()), None, profile(None, "p"), declared).as_deref(),
            Some("opus-x")
        );
        // A person's own commit (no harness) carries no model.
        assert_eq!(pick_model(None, None, profile(None, "p"), declared), None);
        // An agent's: its profile, then its harness's own setting.
        assert_eq!(
            pick_model(
                None,
                Some("codex"),
                profile(Some("codex"), "gpt-y"),
                declared
            )
            .as_deref(),
            Some("gpt-y")
        );
        assert_eq!(
            pick_model(None, Some("codex"), profile(None, "gpt-y"), declared).as_deref(),
            Some("gpt-y")
        );
        assert_eq!(
            pick_model(None, Some("claude-code"), None, declared).as_deref(),
            Some("from-env")
        );
        assert_eq!(
            pick_model(None, Some("codex"), profile(Some("codex"), "  "), declared),
            None
        );
        // A profile set up for another harness says nothing about this one.
        assert_eq!(
            pick_model(
                None,
                Some("codex"),
                profile(Some("claude-code"), "opus"),
                declared
            ),
            None
        );
        assert_eq!(
            pick_model(
                None,
                Some("claude-code"),
                profile(Some("codex"), "gpt-y"),
                declared
            )
            .as_deref(),
            Some("from-env")
        );
    }

    #[test]
    fn a_checkout_overrides_the_project() {
        let project: Project = serde_yaml_ng::from_str(
            "tracker:\n  space: orbit\n  team: CORE\nttl: 3600\ninstructions:\n  ship: gm push\n",
        )
        .unwrap();
        let local: Local =
            serde_yaml_ng::from_str("name: builder\nscope:\n  under: CORE-4\n").unwrap();
        let d = resolve(&project, &local);
        assert_eq!(d.agent.as_deref(), Some("builder"));
        assert_eq!(d.scope.space.as_deref(), Some("orbit"));
        // Under an issue, the project's team no longer narrows it.
        assert_eq!(
            (d.scope.under.as_deref(), d.scope.team),
            (Some("CORE-4"), None)
        );
        assert_eq!(d.team_from, None);
        assert_eq!(
            resolve(&project, &Local::default()).team_from,
            Some(PROJECT_FILE)
        );
        let pinned: Local = serde_yaml_ng::from_str("scope:\n  team: WEB\n").unwrap();
        assert_eq!(resolve(&project, &pinned).team_from, Some(LOCAL_FILE));
        assert_eq!(d.ttl, 3600);
        assert_eq!(
            resolve(&Project::default(), &Local::default()).ttl,
            DEFAULT_TTL
        );
        // Unknown keys are mistakes, not silently ignored settings.
        assert!(serde_yaml_ng::from_str::<Project>("tracker:\n  teem: CORE\n").is_err());
        let text = serde_yaml_ng::to_string(&local).unwrap();
        assert_eq!(serde_yaml_ng::from_str::<Local>(&text).unwrap(), local);
    }

    #[test]
    fn legacy_scope_is_rejected_instead_of_broadening_selection() {
        for text in [
            "tracker:\n  owner: orbit\n",
            "tracker:\n  workspace: launch\n",
            "tracker:\n  space: orbit\n  owner: other\n",
        ] {
            assert!(serde_yaml_ng::from_str::<Project>(text).is_err());
        }
        assert!(serde_yaml_ng::from_str::<Local>("scope:\n  owner: orbit\n").is_err());
        assert!(serde_yaml_ng::from_str::<Local>("scope:\n  workspace: launch\n").is_err());
        let config: Project =
            serde_yaml_ng::from_str("tracker:\n  space: orbit\n  project: launch\n").unwrap();
        assert_eq!(config.tracker.space.as_deref(), Some("orbit"));
        assert_eq!(config.tracker.project.as_deref(), Some("launch"));
    }

    #[test]
    fn intervention_overrides_do_not_change_other_checkouts() {
        let project: Project = serde_yaml_ng::from_str("intervention: autonomous\n").unwrap();
        let local: Local = serde_yaml_ng::from_str("intervention: harness\n").unwrap();
        assert_eq!(
            resolve(&project, &local).intervention,
            InterventionMode::Harness
        );
        assert_eq!(
            resolve(&project, &Local::default()).intervention,
            InterventionMode::Autonomous
        );
        assert_eq!(
            resolve(&Project::default(), &Local::default()).intervention,
            InterventionMode::Harness
        );
        let text = serde_yaml_ng::to_string(&local).unwrap();
        assert_eq!(serde_yaml_ng::from_str::<Local>(&text).unwrap(), local);
        assert!(serde_yaml_ng::from_str::<Project>("intervention: interactive\n").is_err());
        assert!(serde_yaml_ng::from_str::<Local>("intervention: unattended\n").is_err());
        assert!("interactive".parse::<InterventionMode>().is_err());
    }

    #[test]
    fn a_checkout_names_its_timeline() {
        let local: Local = serde_yaml_ng::from_str("name: builder\ntimeline: search-v2\n").unwrap();
        assert_eq!(local.timeline.as_deref(), Some("search-v2"));
        assert!(is_timeline_slug("search-v2") && is_timeline_slug("a1"));
        for bad in ["main", "", "Search", "a--b", "-a", "a-", "a/b", "a_b"] {
            assert!(!is_timeline_slug(bad), "{bad:?}");
        }
    }

    #[test]
    fn each_harness_reads_its_own_files() {
        assert!(layout("claude-code").skills.contains(&".claude/skills"));
        assert_eq!(layout("codex").instructions, ["AGENTS.md"]);
        assert_eq!(layout("anything").skills, [".agents/skills"]);
    }
}
