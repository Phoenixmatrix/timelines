//! `gm agent setup`: configure a checkout so a coding agent works through the
//! issue graph with nothing but `gm issue next`.
//!
//! It detects the harness, keeps a managed section of the instruction file
//! (AGENTS.md…) and the graph-work skill current where that harness reads them,
//! records the tracker scope and lease length in .gitmatrix/, and gives the
//! agent its own identity: created if needed, its token kept with gm's
//! credentials (never printed), and its advisory capability profile published
//! (`gm agent configure`). Rerunning it updates everything; `--check` reports
//! what's stale without changing anything.

use super::Ctx;
use super::agents::Shown;
use crate::agent::capabilities::{self, AgentCapabilities};
use crate::cli::CapabilityArgs;
use crate::output::{GmError, Result, exit};
use crate::profile::{self, Local, Project};
use crate::remote::{self, Acting, Config};
use serde_json::{Value, json};
use std::path::Path;

const SKILL: &str = include_str!("../../assets/graph-work-skill.md");
const SECTION: &str = include_str!("../../assets/agents-section.md");
pub const BEGIN: &str = "<!-- gm:agents begin: managed by `gm agent setup` from .gitmatrix/agents.yml; edit that and rerun -->";
pub const END: &str = "<!-- gm:agents end -->";

#[derive(Default)]
pub struct Options {
    pub name: Option<String>,
    pub harness: Option<String>,
    pub model: Option<String>,
    pub tags: Vec<String>,
    pub drop_tags: Vec<String>,
    pub space: Option<String>,
    pub team: Option<String>,
    pub project: Option<String>,
    pub under: Option<String>,
    pub ttl: Option<u32>,
    pub intervention: Option<profile::InterventionMode>,
    pub no_identity: bool,
    pub check: bool,
    pub publish_skills: Option<profile::Publish>,
    pub allow_skills: Vec<String>,
    pub deny_skills: Vec<String>,
}

/// A file setup manages, and what it should contain.
struct Planned {
    path: String,
    content: String,
    /// Differs from (or is missing on) disk.
    stale: bool,
    exists: bool,
    /// Per checkout: never reported by --check.
    local: bool,
}

fn plan(root: &Path, path: &str, content: String, local: bool) -> Planned {
    let current = std::fs::read_to_string(root.join(path)).ok();
    Planned {
        path: path.to_string(),
        stale: current.as_deref() != Some(content.as_str()),
        exists: current.is_some(),
        content,
        local,
    }
}

/// "matrixorg, team CORE": the tracker and scope agents work in.
fn scope(project: &Project, local: &Local) -> String {
    let pick = |mine: &Option<String>, shared: &Option<String>| mine.clone().or(shared.clone());
    let space = pick(&local.scope.space, &project.tracker.space)
        .unwrap_or_else(|| "this repository's tracker".into());
    let context = match (
        pick(&local.scope.under, &project.tracker.under),
        pick(&local.scope.team, &project.tracker.team),
    ) {
        (Some(under), _) => format!("{space}, under {under}"),
        (None, Some(team)) => format!("{space}, team {team}"),
        _ => space,
    };
    match pick(&local.scope.project, &project.tracker.project) {
        Some(project) => format!("{context}, project {project}"),
        None => context,
    }
}

fn duration(seconds: u32) -> String {
    match seconds {
        3600 => "1 hour".into(),
        s if s % 3600 == 0 => format!("{} hours", s / 3600),
        s if s % 60 == 0 => format!("{} minutes", s / 60),
        s => format!("{s} seconds"),
    }
}

fn render(template: &str, project: &Project, local: &Local) -> String {
    let ttl = local.ttl.or(project.ttl).unwrap_or(profile::DEFAULT_TTL);
    template
        .replace("{{SCOPE}}", &scope(project, local))
        .replace("{{TTL}}", &duration(ttl))
        .replace(
            "{{INTERVENTION}}",
            profile::intervention(project, local).guidance(),
        )
        .replace(
            "{{SHIP}}",
            project
                .instructions
                .ship
                .as_deref()
                .unwrap_or("push it and confirm CI"),
        )
}

/// `text` with gm's section replaced (or appended), between its markers.
pub fn upsert_section(text: &str, section: &str) -> String {
    // Blank lines around the section: what Markdown formatters produce anyway.
    let block = format!("{BEGIN}\n\n{}\n\n{END}", section.trim_end());
    // Found by the markers' stable prefixes, so rewording them never duplicates
    // the section; extra copies (from an older gm) are removed.
    let span = |text: &str, from: usize| {
        let start = from + text[from..].find("<!-- gm:agents begin")?;
        let end = start + text[start..].find(END)? + END.len();
        Some((start, end))
    };
    if let Some((start, end)) = span(text, 0) {
        let mut rest = text[end..].to_string();
        while let Some((s, e)) = span(&rest, 0) {
            rest = format!("{}{}", rest[..s].trim_end(), &rest[e..]);
        }
        return format!("{}{block}{rest}", &text[..start]);
    }
    if text.trim().is_empty() {
        return format!("{block}\n");
    }
    format!("{}\n\n{block}\n", text.trim_end())
}

/// The Space in origin's URL: https://host/SPACE/name(.git) or host:SPACE/name.
fn origin_space(root: &Path) -> Option<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["remote", "get-url", "origin"])
        .output()
        .ok()?;
    let url = String::from_utf8(out.stdout).ok()?;
    let path = url.trim().trim_end_matches('/').trim_end_matches(".git");
    let mut parts = path.rsplit(['/', ':']);
    parts.next()?;
    parts.next().filter(|o| !o.is_empty()).map(str::to_string)
}

/// Memorable names, independent of the harness. Registration checks the person's
/// namespace as well: a random collision must never adopt an existing identity.
fn agent_name() -> String {
    const ADJECTIVES: &[&str] = &[
        "able", "agile", "amber", "bold", "brave", "bright", "calm", "clever", "cosmic", "crisp",
        "curious", "daring", "eager", "gentle", "golden", "happy", "jolly", "kind", "lively",
        "lucky", "merry", "nimble", "patient", "quiet", "rapid", "sharp", "silver", "steady",
        "sunny", "swift", "vivid", "wise",
    ];
    const NOUNS: &[&str] = &[
        "badger", "bear", "beaver", "bison", "crane", "deer", "dolphin", "eagle", "falcon",
        "finch", "fox", "gecko", "heron", "ibis", "jaguar", "koala", "lark", "lemur", "lynx",
        "marten", "otter", "owl", "panda", "puffin", "raven", "robin", "seal", "sparrow", "tiger",
        "turtle", "whale", "wolf",
    ];
    let [adjective, noun] = rand::random::<[u8; 2]>();
    format!(
        "{}-{}",
        ADJECTIVES[adjective as usize % ADJECTIVES.len()],
        NOUNS[noun as usize % NOUNS.len()]
    )
}

fn merged(base: &[String], add: &[String], drop: &[String]) -> Vec<String> {
    let drop: Vec<&str> = drop.iter().map(|d| d.trim()).collect();
    let mut all: Vec<String> = base
        .iter()
        .chain(add)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty() && !drop.contains(&v.as_str()))
        .collect();
    all.sort();
    all.dedup();
    all
}

const PROJECT_HEADER: &str = "\
# How coding agents work on this repository. Shared: commit it.
# `gm agent setup` reads this, keeps the instruction file's gm section and the
# graph-work skill current, and records each checkout's agent (name, harness,
# model, tags) in .gitmatrix/agent.local.yml, which isn't committed.
#
# tracker:       space, and the default scope for `gm issue next`:
#                team: CORE, or under: CORE-4 for one project
# ttl:           seconds per lease (renew before it ends)
# intervention: autonomous (new setups) or harness (keep the harness's behavior)
# instructions:  file: AGENTS.md (default: the harness's own)
#                ship: how work ships before an issue is completed
\n";

pub fn setup(ctx: &Ctx, o: &Options) -> Result<Shown> {
    let root = profile::root_from(&ctx.cwd)
        .ok_or_else(|| GmError::usage("Run `gm agent setup` inside a repository checkout."))?;
    let existing_project = profile::project_at(&root)?;
    let creating_project = existing_project.is_none();
    let mut project = existing_project.unwrap_or_default();
    let mut local = profile::local_at(&root)?.unwrap_or_default();

    // A new project file takes the scope flags; afterwards they're this checkout's.
    if creating_project {
        project.tracker.space = o.space.clone().or_else(|| origin_space(&root));
        project.tracker.team = o.team.clone();
        project.tracker.project = o.project.clone();
        project.tracker.under = o.under.clone();
        project.ttl = o.ttl;
        project.intervention = Some(
            o.intervention
                .unwrap_or(profile::InterventionMode::Autonomous),
        );
    } else {
        let set = |slot: &mut Option<String>, flag: &Option<String>| {
            if flag.is_some() {
                *slot = flag.clone();
            }
        };
        set(&mut local.scope.space, &o.space);
        set(&mut local.scope.team, &o.team);
        set(&mut local.scope.project, &o.project);
        set(&mut local.scope.under, &o.under);
        if o.ttl.is_some() {
            local.ttl = o.ttl;
        }
        if o.intervention.is_some() {
            local.intervention = o.intervention;
        }
    }

    // GM_AGENT=1 says an agent drives gm, not which harness: keep the one we know.
    let detected = crate::agent::detect()
        .map(|h| h.id.to_string())
        .filter(|h| h != "custom");
    let harness = o.harness.clone().or(detected).or(local.harness.clone());
    local.harness = harness.clone();
    if o.model.is_some() {
        local.model = o.model.clone();
    }
    local.tags = merged(&local.tags, &o.tags, &o.drop_tags);
    // Skill publishing, saved for this checkout: allowing a skill lifts a deny
    // on it, and denying one drops it from the allow list.
    if let Some(publish) = o.publish_skills {
        local.skills.publish = publish;
    }
    local.skills.allow = merged(&local.skills.allow, &o.allow_skills, &o.deny_skills);
    local.skills.deny = merged(&local.skills.deny, &o.deny_skills, &o.allow_skills);
    let generated = o.name.is_none() && local.name.is_none();
    let mut name = o
        .name
        .clone()
        .or(local.name.clone())
        .unwrap_or_else(agent_name);

    // The files.
    let layout = profile::layout(harness.as_deref().unwrap_or(""));
    let instructions = project.instructions.file.clone().unwrap_or_else(|| {
        layout
            .instructions
            .iter()
            .find(|f| root.join(f).is_file())
            .unwrap_or(&"AGENTS.md")
            .to_string()
    });
    let current = std::fs::read_to_string(root.join(&instructions)).unwrap_or_default();
    let mut files = vec![plan(
        &root,
        &instructions,
        upsert_section(&current, &render(SECTION, &project, &local)),
        false,
    )];
    for dir in layout.skills {
        files.push(plan(
            &root,
            &format!("{dir}/{}/SKILL.md", profile::GRAPH_SKILL),
            render(SKILL, &project, &local),
            false,
        ));
    }
    // The harness's prompts reach the step journal through its hook (CORE-241,
    // CORE-242): Claude Code and Codex settings, Oh My Pi's extension.
    let hook_file = |path: &str, add: fn(&str) -> String| {
        let current = std::fs::read_to_string(root.join(path)).unwrap_or_default();
        plan(&root, path, add(&current), false)
    };
    match harness.as_deref() {
        Some("claude-code") => files.push(hook_file(
            ".claude/settings.json",
            super::hooks::with_claude_hook,
        )),
        Some("codex") => files.push(hook_file(
            ".codex/hooks.json",
            super::hooks::with_codex_hook,
        )),
        Some("pi") => {
            files.push(plan(
                &root,
                ".omp/extensions/gitmatrix-steps.ts",
                super::hooks::OMP_EXTENSION.to_string(),
                false,
            ));
            for (path, content) in [
                (
                    "index.ts",
                    include_str!("../../assets/claude-code-mod/hooks/omp.ts").to_string(),
                ),
                // OMP's entry and helper are peers, unlike Claude's hooks/ folder.
                (
                    "identity.ts",
                    include_str!("../../assets/claude-code-mod/hooks/identity.ts").replacen(
                        "from \"../types\"",
                        "from \"./types\"",
                        1,
                    ),
                ),
                (
                    "types/index.d.ts",
                    include_str!("../../assets/claude-code-mod/types/index.d.ts").to_string(),
                ),
            ] {
                files.push(plan(
                    &root,
                    &format!(".omp/extensions/gitmatrix-agent/{path}"),
                    content,
                    false,
                ));
            }
        }
        _ => {}
    }
    let gitignore = std::fs::read_to_string(root.join(".gitignore")).unwrap_or_default();
    if !gitignore.lines().any(|l| l.trim() == profile::LOCAL_FILE) {
        let sep = if gitignore.is_empty() || gitignore.ends_with('\n') {
            ""
        } else {
            "\n"
        };
        files.push(plan(
            &root,
            ".gitignore",
            format!(
                "{gitignore}{sep}\n# This checkout's agent (gm agent setup)\n{}\n",
                profile::LOCAL_FILE
            ),
            false,
        ));
    }
    if creating_project {
        files.push(plan(
            &root,
            profile::PROJECT_FILE,
            format!("{PROJECT_HEADER}{}", yaml(&project)?),
            false,
        ));
    }

    if o.check {
        let stale: Vec<&str> = files
            .iter()
            .filter(|f| f.stale && !f.local)
            .map(|f| f.path.as_str())
            .collect();
        if !stale.is_empty() {
            return Err(GmError::new(
                "stale",
                format!("Agent setup is out of date: {}.", stale.join(", ")),
            )
            .hint("Run `gm agent setup` to update them.")
            .exit(exit::CONFLICT));
        }
        return Ok(Shown::new(
            json!({ "upToDate": true, "intervention": profile::intervention(&project, &local), "files": report(&files) }),
            "Agent setup is up to date.".into(),
        ));
    }

    let write = |files: &[Planned]| -> Result<()> {
        for f in files.iter().filter(|f| f.stale) {
            let path = root.join(&f.path);
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::write(path, &f.content)?;
        }
        Ok(())
    };
    // Shared files first, so the published profile finds the skill just installed.
    if !ctx.dry_run {
        write(&files)?;
    }

    // The identity: with GM_TOKEN set to an agent's token, that agent is who
    // this checkout is, whatever the profile said.
    let identity = if o.no_identity || ctx.dry_run {
        Value::Null
    } else {
        let (identity, resolved) = identity(&root, &name, generated, &local)?;
        name = resolved;
        identity
    };
    local.name = Some(name.clone());
    files.push(plan(
        &root,
        profile::LOCAL_FILE,
        format!("{}{}", profile::LOCAL_HEADER, yaml(&local)?),
        true,
    ));

    if !ctx.dry_run {
        write(&files[files.len() - 1..])?;
    }

    let report = report(&files);
    let intervention = profile::intervention(&project, &local);
    // Agent tags come from the tracker's tag catalog (CORE-271): warn, never refuse.
    let tag_check = if o.no_identity {
        Value::Null
    } else {
        let space = local.scope.space.clone().or(project.tracker.space.clone());
        super::agents::tag_check(&Config::load(), space.as_deref(), &local.tags)
    };
    let value = json!({
        "dryRun": ctx.dry_run,
        "agent": name,
        "harness": harness,
        "model": local.model,
        "tags": local.tags,
        "tagCatalog": tag_check,
        "scope": scope(&project, &local),
        "intervention": intervention,
        "identity": identity,
        "files": report,
        "next": "The agent runs `gm issue next` here. Rerun `gm agent setup` after editing .gitmatrix/, or with --tag/--model, to update.",
    });
    let mut text = format!(
        "{} {name}{} · {}\n  scope: {}\n  intervention: {}\n",
        if ctx.dry_run { "Would set up" } else { "Agent" },
        identity["accountable"]
            .as_str()
            .map(|p| format!(" (for {p})"))
            .unwrap_or_default(),
        harness.as_deref().unwrap_or("any harness"),
        scope(&project, &local),
        intervention,
    );
    if let Some(profile) = identity["profile"].as_str() {
        text.push_str(&format!("  profile: {profile}\n"));
    }
    if !local.tags.is_empty() {
        text.push_str(&format!("  tags: {}\n", local.tags.join(", ")));
    }
    text.push_str(&super::agents::tag_check_text(&tag_check));
    if let Some(skills) = identity["skills"].as_array() {
        let names: Vec<&str> = skills.iter().filter_map(Value::as_str).collect();
        text.push_str(&format!(
            "  skills published ({}): {}\n",
            match local.skills.publish {
                profile::Publish::Repo => "the repository's; --publish-skills all adds yours",
                profile::Publish::All => "the repository's and yours",
                profile::Publish::None => "declared only",
            },
            if names.is_empty() {
                "none".to_string()
            } else {
                names.join(", ")
            }
        ));
    }
    if let Some(token) = identity["token"].as_str() {
        text.push_str(&format!("  token: {token}\n"));
    }
    for f in &report {
        text.push_str(&format!(
            "  {:<9} {}\n",
            f["status"].as_str().unwrap_or(""),
            f["path"].as_str().unwrap_or("")
        ));
    }
    text.push_str("Next: the agent runs `gm issue next` here.");
    Ok(Shown::new(value, text))
}

fn report(files: &[Planned]) -> Vec<Value> {
    files
        .iter()
        .map(|f| {
            json!({
                "path": f.path,
                "status": if !f.stale { "unchanged" } else if f.exists { "updated" } else { "created" },
            })
        })
        .collect()
}

fn yaml(value: &impl serde::Serialize) -> Result<String> {
    serde_yaml_ng::to_string(value).map_err(|e| GmError::new("invalid_config", e.to_string()))
}

/// The advisory profile to publish: detected now, with this checkout's
/// harness, model and tags declared (`gm agent configure` semantics).
fn profile_report(root: &Path, local: &Local, previous: &Value) -> Result<AgentCapabilities> {
    let previous: Option<AgentCapabilities> = Some(previous)
        .filter(|p| !p.is_null())
        .map(|p| serde_json::from_value(p.clone()))
        .transpose()?;
    let args = CapabilityArgs {
        harness: local.harness.clone(),
        model: local.model.clone(),
        tags: local.tags.clone(),
        publish_skills: Some(local.skills.publish),
        allow_skills: local.skills.allow.clone(),
        deny_skills: local.skills.deny.clone(),
        ..Default::default()
    };
    capabilities::detect(&args, previous.as_ref(), root)
}

/// The skill names a profile publishes, for setup's report.
fn published_names(report: &AgentCapabilities) -> Vec<String> {
    report.skills.iter().map(|s| s.name.clone()).collect()
}

/// The agent this checkout works as: created and given a kept token if
/// needed, with its capability profile republished. Returns it and its name.
fn identity(root: &Path, name: &str, generated: bool, local: &Local) -> Result<(Value, String)> {
    let mut config = Config::load();
    let session = remote::api(&config, "GET", "/session", None).map_err(|e| {
        e.hint("Sign in first (`gm auth login`), or pass --no-identity to only write the files.")
    })?;
    let viewer = &session["viewer"];
    if viewer.is_null() {
        return Err(
            GmError::new("unauthenticated", "Sign in before setting up an agent.")
                .hint("`gm auth login`, or pass --no-identity to only write the files.")
                .exit(exit::AUTH),
        );
    }
    let person = viewer["displayName"].as_str().unwrap_or("").to_string();

    // Already acting as an agent (GM_TOKEN, or this checkout's kept token):
    // it can only refresh its own profile.
    if let Some(agent) = viewer["agent"].as_object() {
        let own = agent["name"].as_str().unwrap_or(name).to_string();
        let current = remote::api(&config, "GET", "/agents/self", None)?["agent"].clone();
        let report = profile_report(root, local, &current["capabilities"])?;
        let skills = published_names(&report);
        remote::api(
            &config,
            "PUT",
            "/agents/self/capabilities",
            Some(&serde_json::to_value(&report)?),
        )?;
        return Ok((
            json!({
                "id": agent["id"], "name": own, "accountable": person, "created": false,
                "token": "in use (GM_TOKEN or this checkout's)", "profile": "published",
                "skills": skills, "publishing": local.skills.publish,
            }),
            own,
        ));
    }

    // A person may reuse an explicit or saved name, but generated names always
    // create a new identity. /agents lists only this authenticated person's agents.
    config.acting = Acting::Person;
    let agents = remote::api(&config, "GET", "/agents", None)?["agents"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let existing = agents.iter().find(|a| !generated && a["name"] == name);
    if existing.as_ref().is_some_and(|a| !a["revokedAt"].is_null()) {
        return Err(
            GmError::new("revoked", format!("Your agent {name} was revoked."))
                .hint("Pick another name with --name."),
        );
    }
    let created = existing.is_none();
    let previous = existing
        .as_ref()
        .map(|a| a["capabilities"].clone())
        .unwrap_or(Value::Null);
    let detected = profile_report(root, local, &previous)?;
    let skills = published_names(&detected);
    let report = serde_json::to_value(detected)?;
    let agent = match existing {
        Some(agent) => {
            remote::api(
                &config,
                "PUT",
                &format!(
                    "/agents/{}/capabilities",
                    agent["id"].as_str().unwrap_or("")
                ),
                Some(&report),
            )?;
            agent.clone()
        }
        None => {
            let mut candidate = name.to_string();
            let mut registered = None;
            for _ in 0..64 {
                if generated && agents.iter().any(|a| a["name"] == candidate) {
                    candidate = format!("{}-{:08x}", agent_name(), rand::random::<u32>());
                    continue;
                }
                match remote::api(
                    &config,
                    "POST",
                    "/agents",
                    Some(&json!({ "name": candidate, "capabilities": report })),
                ) {
                    Ok(response) => {
                        registered = Some(response["agent"].clone());
                        break;
                    }
                    // Another checkout may have registered this name since the
                    // list was read. Try a new name, never adopt that identity.
                    Err(error) if generated && error.code == "conflict" => {
                        candidate = format!("{}-{:08x}", agent_name(), rand::random::<u32>());
                    }
                    Err(error) => return Err(error),
                }
            }
            registered.ok_or_else(|| {
                GmError::new("conflict", "Couldn't find an unused memorable agent name.")
                    .hint("Choose a name with --name, or run setup again.")
                    .exit(exit::CONFLICT)
            })?
        }
    };
    let name = agent["name"].as_str().ok_or_else(|| {
        GmError::new(
            "protocol_error",
            "The server didn't return the agent's name.",
        )
    })?;
    let id = agent["id"].as_str().unwrap_or_default().to_string();
    let kept = config.agent_tokens().get(name).cloned();
    let works = kept.as_ref().is_some_and(|token| {
        let mut probe = config.clone();
        probe.acting = Acting::Token(token.clone());
        remote::api(&probe, "GET", "/session", None)
            .is_ok_and(|s| s["viewer"]["agent"]["id"] == id.as_str())
    });
    let token = if works {
        "kept"
    } else {
        let label = format!(
            "gm agent setup on {}",
            chrono::Utc::now().format("%Y-%m-%d")
        );
        let minted = remote::api(
            &config,
            "POST",
            &format!("/agents/{id}/tokens"),
            Some(&json!({ "name": label, "scope": "write" })),
        )?;
        let secret = minted["secret"]
            .as_str()
            .ok_or_else(|| GmError::new("protocol_error", "The server didn't return a token."))?;
        config.set_agent_token(name, secret.to_string());
        config.save()?;
        "minted and kept with gm's credentials"
    };
    Ok((
        json!({
            "id": id, "name": name, "accountable": person, "created": created,
            "token": token, "profile": "published",
            "skills": skills, "publishing": local.skills.publish,
        }),
        name.to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_managed_section_replaces_itself_and_leaves_the_rest() {
        let fresh = upsert_section("", "## A\nnew");
        assert_eq!(fresh, format!("{BEGIN}\n\n## A\nnew\n\n{END}\n"));
        let with = upsert_section("# Project\n\nOwn words.\n", "## A\nv1");
        assert!(with.starts_with("# Project\n\nOwn words.\n\n<!-- gm:agents begin"));
        let edited = format!("{with}\n## After\nMore words.\n");
        let again = upsert_section(&edited, "## A\nv2");
        assert!(again.contains("v2") && !again.contains("v1"));
        assert!(again.contains("Own words.") && again.ends_with("## After\nMore words.\n"));
        // Idempotent.
        assert_eq!(upsert_section(&again, "## A\nv2"), again);
        // Extra copies collapse into one.
        let twice = format!("{again}\n{BEGIN}\n\nold\n\n{END}\n");
        assert_eq!(upsert_section(&twice, "## A\nv2"), again);
        // An older wording of the opening marker is still the same section.
        let old = again.replace(BEGIN, "<!-- gm:agents begin: an older wording -->");
        assert_eq!(upsert_section(&old, "## A\nv2"), again);
    }

    #[test]
    fn lists_are_normalized() {
        assert_eq!(
            merged(
                &["rust".into(), "web".into()],
                &["linux".into()],
                &["web".into()]
            ),
            ["linux", "rust"]
        );
    }

    #[test]
    fn setup_installs_each_harness_step_hook() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".gitmatrix")).unwrap();
        std::fs::create_dir_all(dir.path().join(".omp/extensions")).unwrap();
        std::fs::write(
            dir.path().join(".omp/extensions/personal.ts"),
            "personal extension",
        )
        .unwrap();
        std::fs::write(
            dir.path().join(".omp/settings.json"),
            "{\"theme\":\"custom\"}",
        )
        .unwrap();
        let ctx = Ctx {
            format: crate::output::Format::Json,
            dry_run: false,
            cwd: dir.path().to_path_buf(),
            argv: String::new(),
        };
        let run = |harness: &str| {
            setup(
                &ctx,
                &Options {
                    harness: Some(harness.into()),
                    no_identity: true,
                    ..Default::default()
                },
            )
            .unwrap();
        };
        run("claude-code");
        run("codex");
        run("pi");
        let read = |path: &str| std::fs::read_to_string(dir.path().join(path)).unwrap();
        assert!(read(".claude/settings.json").contains("gm hook claude-code"));
        assert!(read(".codex/hooks.json").contains("gm hook codex"));
        assert_eq!(
            read(".omp/extensions/gitmatrix-steps.ts"),
            super::super::hooks::OMP_EXTENSION
        );
        let identity_extension = read(".omp/extensions/gitmatrix-agent/index.ts");
        let identity_resolver = read(".omp/extensions/gitmatrix-agent/identity.ts");
        let identity_contract = read(".omp/extensions/gitmatrix-agent/types/index.d.ts");
        run("pi");
        assert_eq!(
            read(".omp/extensions/gitmatrix-agent/index.ts"),
            identity_extension
        );
        assert_eq!(
            read(".omp/extensions/gitmatrix-agent/identity.ts"),
            identity_resolver
        );
        assert_eq!(
            read(".omp/extensions/gitmatrix-agent/types/index.d.ts"),
            identity_contract
        );
        assert_eq!(read(".omp/extensions/personal.ts"), "personal extension");
        assert_eq!(read(".omp/settings.json"), "{\"theme\":\"custom\"}");
        // Again: nothing doubles.
        run("codex");
        let codex: serde_json::Value = serde_json::from_str(&read(".codex/hooks.json")).unwrap();
        assert_eq!(
            codex["hooks"]["UserPromptSubmit"].as_array().unwrap().len(),
            1
        );
    }

    #[test]
    fn setup_keeps_its_generated_name_until_explicitly_changed() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".gitmatrix")).unwrap();
        let mut ctx = Ctx {
            format: crate::output::Format::Json,
            dry_run: false,
            cwd: dir.path().to_path_buf(),
            argv: String::new(),
        };
        let mut options = Options {
            harness: Some("codex".into()),
            no_identity: true,
            ..Default::default()
        };
        setup(&ctx, &options).unwrap();
        let first = profile::local_at(dir.path())
            .unwrap()
            .unwrap()
            .name
            .unwrap();
        let words: Vec<_> = first.split('-').collect();
        assert_eq!(words.len(), 2);
        assert!(
            words
                .iter()
                .all(|word| !word.is_empty() && word.chars().all(|c| c.is_ascii_lowercase()))
        );
        assert_ne!(first, "codex");
        options.harness = Some("claude-code".into());
        setup(&ctx, &options).unwrap();
        assert_eq!(
            profile::local_at(dir.path())
                .unwrap()
                .unwrap()
                .name
                .as_deref(),
            Some(first.as_str())
        );

        let local = std::fs::read(dir.path().join(profile::LOCAL_FILE)).unwrap();
        options.name = Some("deliberate-name".into());
        options.check = true;
        setup(&ctx, &options).unwrap();
        assert_eq!(
            std::fs::read(dir.path().join(profile::LOCAL_FILE)).unwrap(),
            local
        );
        options.check = false;
        ctx.dry_run = true;
        setup(&ctx, &options).unwrap();
        assert_eq!(
            std::fs::read(dir.path().join(profile::LOCAL_FILE)).unwrap(),
            local
        );

        ctx.dry_run = false;
        setup(&ctx, &options).unwrap();
        assert_eq!(
            profile::local_at(dir.path())
                .unwrap()
                .unwrap()
                .name
                .as_deref(),
            Some("deliberate-name")
        );
    }

    #[test]
    fn switching_intervention_is_local_persistent_and_dry_run_safe() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".gitmatrix")).unwrap();
        let mut ctx = Ctx {
            format: crate::output::Format::Json,
            dry_run: false,
            cwd: dir.path().to_path_buf(),
            argv: String::new(),
        };
        let mut options = Options {
            space: Some("orbit".into()),
            harness: Some("codex".into()),
            no_identity: true,
            ..Default::default()
        };
        setup(&ctx, &options).unwrap();
        let shared = std::fs::read(dir.path().join(profile::PROJECT_FILE)).unwrap();
        assert_eq!(
            profile::project_at(dir.path())
                .unwrap()
                .unwrap()
                .intervention,
            Some(profile::InterventionMode::Autonomous)
        );
        options.intervention = Some(profile::InterventionMode::Harness);
        setup(&ctx, &options).unwrap();
        options.intervention = None;
        setup(&ctx, &options).unwrap();
        assert_eq!(
            profile::local_at(dir.path()).unwrap().unwrap().intervention,
            Some(profile::InterventionMode::Harness)
        );
        let local = std::fs::read(dir.path().join(profile::LOCAL_FILE)).unwrap();
        ctx.dry_run = true;
        options.intervention = Some(profile::InterventionMode::Autonomous);
        setup(&ctx, &options).unwrap();
        assert_eq!(
            std::fs::read(dir.path().join(profile::LOCAL_FILE)).unwrap(),
            local
        );
        ctx.dry_run = false;
        setup(&ctx, &options).unwrap();
        assert_eq!(
            profile::local_at(dir.path()).unwrap().unwrap().intervention,
            Some(profile::InterventionMode::Autonomous)
        );
        assert_eq!(
            std::fs::read(dir.path().join(profile::PROJECT_FILE)).unwrap(),
            shared
        );
    }

    #[test]
    fn updating_legacy_setup_does_not_opt_into_autonomy() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".gitmatrix")).unwrap();
        std::fs::write(dir.path().join(profile::PROJECT_FILE), "{}\n").unwrap();
        let ctx = Ctx {
            format: crate::output::Format::Json,
            dry_run: false,
            cwd: dir.path().to_path_buf(),
            argv: String::new(),
        };
        setup(
            &ctx,
            &Options {
                harness: Some("codex".into()),
                no_identity: true,
                ..Default::default()
            },
        )
        .unwrap();
        let project = profile::project_at(dir.path()).unwrap().unwrap();
        let local = profile::local_at(dir.path()).unwrap().unwrap();
        assert_eq!(
            profile::intervention(&project, &local),
            profile::InterventionMode::Harness
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join(profile::PROJECT_FILE)).unwrap(),
            "{}\n"
        );
    }
}
