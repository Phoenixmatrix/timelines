//! Agents: identities that work on their own, each with a person accountable
//! for it. `gm agent token` mints a token the agent signs in with (GM_TOKEN).

use super::Ctx;
use crate::agent::capabilities::{self, AgentCapabilities};
use crate::cli::AgentCommand;
use crate::output::{GmError, Render, Result};
use crate::remote::{self, Config};
use serde::{Serialize, Serializer};
use serde_json::{Value, json};

/// JSON for agents, a purpose-made text rendering for people.
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

impl Shown {
    pub fn new(value: Value, text: String) -> Shown {
        Shown { value, text }
    }
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}

fn terminal(value: &str) -> String {
    let mut safe = String::new();
    for character in value.chars() {
        if character.is_control()
            || matches!(character, '\u{2028}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        {
            safe.extend(character.escape_default());
        } else {
            safe.push(character);
        }
    }
    safe
}

/// "builder (for Ann Lee)": an agent and the person answerable for it.
fn line(agent: &Value) -> String {
    let revoked = if agent["revokedAt"].is_null() {
        String::new()
    } else {
        format!("  revoked {}", terminal(s(agent, "revokedAt")))
    };
    // Tracker discovery deliberately omits credential metadata.
    let tokens = agent["tokens"]
        .as_array()
        .map(|tokens| {
            format!(
                "  {} token{}",
                tokens.len(),
                if tokens.len() == 1 { "" } else { "s" }
            )
        })
        .unwrap_or_default();
    format!(
        "{} (for {}){}{}{}",
        terminal(s(agent, "name")),
        terminal(s(&agent["accountable"], "displayName")),
        tokens,
        revoked,
        summary(&agent["capabilities"])
    )
}

fn summary(profile: &Value) -> String {
    if profile.is_null() {
        return "  capabilities unknown".into();
    }
    let tags = profile["tags"]
        .as_array()
        .map(|tags| {
            tags.iter()
                .filter_map(Value::as_str)
                .map(terminal)
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let skills = profile["skills"]
        .as_array()
        .map(|skills| {
            skills
                .iter()
                .filter_map(|s| s["name"].as_str())
                .map(terminal)
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    format!(
        "\n  harness: {}  model: {}  environment: {}/{}/{}\n  cpus: {}  memory: {}\n  tags: {}  skills: {}",
        terminal(profile["harness"].as_str().unwrap_or("unknown")),
        terminal(profile["model"].as_str().unwrap_or("unknown")),
        terminal(s(&profile["environment"], "os")),
        terminal(s(&profile["environment"], "arch")),
        terminal(s(&profile["environment"], "runtime")),
        profile["environment"]["cpuCount"]
            .as_u64()
            .map_or_else(|| "unknown".into(), |n| n.to_string()),
        profile["environment"]["memoryBytes"]
            .as_u64()
            .map_or_else(|| "unknown".into(), |n| format!("{n} bytes")),
        if tags.is_empty() { "none" } else { &tags },
        if skills.is_empty() { "none" } else { &skills },
    )
}

/// Agent tags checked against the tracker's tag catalog (CORE-271): the same
/// vocabulary issues are tagged with, so `requires tag:ux` finds agents tagged ux.
/// Unknown names warn on stderr and are kept, never refused. Null when no tracker is
/// known or its catalog can't be read (an older server, offline, no access).
pub fn tag_check(config: &Config, owner: Option<&str>, tags: &[String]) -> Value {
    let Some(owner) = owner.filter(|o| {
        !o.is_empty()
            && o.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }) else {
        return Value::Null;
    };
    let Ok(response) = remote::api(config, "GET", &format!("/tracker/{owner}/tags"), None) else {
        return Value::Null;
    };
    let Some(entries) = response["tags"].as_array() else {
        return Value::Null;
    };
    let catalog: Vec<String> = entries
        .iter()
        .filter_map(|t| t["name"].as_str().map(str::to_owned))
        .collect();
    let unknown = super::requirements::unknown_tags(tags, &catalog);
    for u in &unknown {
        eprintln!(
            "gm: warning: {}; the agent keeps it, and issues that require tag:{} match it.",
            super::requirements::unknown_tag_warning(u, owner),
            u["tag"].as_str().unwrap_or("")
        );
    }
    // Most used first: what the tracker's work is most often about.
    let mut ranked: Vec<&Value> = entries.iter().collect();
    ranked.sort_by_key(|t| std::cmp::Reverse(t["open"].as_u64().unwrap_or(0)));
    let suggestions: Vec<&str> = ranked
        .iter()
        .filter_map(|t| t["name"].as_str())
        .filter(|name| name.encode_utf16().count() <= 64)
        .filter(|name| !tags.iter().any(|tag| tag.eq_ignore_ascii_case(name)))
        .take(12)
        .collect();
    json!({ "owner": owner, "unknown": unknown, "suggestions": suggestions })
}

/// The catalog check as text lines, or nothing without one.
pub fn tag_check_text(check: &Value) -> String {
    let Some(owner) = check["owner"].as_str() else {
        return String::new();
    };
    let mut out = String::new();
    for u in check["unknown"].as_array().into_iter().flatten() {
        out.push_str(&format!(
            "  warning: {}\n",
            terminal(&super::requirements::unknown_tag_warning(u, owner))
        ));
    }
    let suggestions: Vec<String> = check["suggestions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(terminal)
        .collect();
    if !suggestions.is_empty() {
        out.push_str(&format!(
            "  {owner}'s tag catalog: {} (add one with --tag NAME)\n",
            suggestions.join(", ")
        ));
    }
    out
}

fn shown_agent(value: Value) -> Shown {
    Shown {
        text: line(&value["agent"]),
        value,
    }
}

fn self_agent(config: &Config) -> Result<Value> {
    Ok(remote::api(config, "GET", "/agents/self", None)?["agent"].clone())
}

fn agents(config: &Config) -> Result<Vec<Value>> {
    Ok(remote::api(config, "GET", "/agents", None)?["agents"]
        .as_array()
        .cloned()
        .unwrap_or_default())
}

/// Your agent by name (or id), unrevoked.
fn find(config: &Config, name: &str) -> Result<Value> {
    let found = agents(config)?
        .into_iter()
        .find(|a| a["name"] == name || a["id"] == name)
        .ok_or_else(|| {
            GmError::not_found("not_found", format!("You have no agent named {name}."))
                .hint("List them with `gm agent list`, or create one with `gm agent create`.")
        })?;
    if !found["revokedAt"].is_null() {
        return Err(GmError::new(
            "revoked",
            format!("{name} was revoked; create a new agent."),
        ));
    }
    Ok(found)
}

pub fn agent(ctx: &Ctx, command: &AgentCommand) -> Result<Shown> {
    let mut config = Config::load();
    // Managing your agents is a person's job, even in a checkout where gm would
    // act as its agent; showing or configuring "self" means the agent.
    if matches!(
        command,
        AgentCommand::Create { .. }
            | AgentCommand::Token { .. }
            | AgentCommand::Revoke { .. }
            | AgentCommand::Configure { name: Some(_), .. }
            | AgentCommand::Show { name: Some(_) }
            | AgentCommand::List { owner: None }
    ) {
        config.acting = remote::Acting::Person;
    }
    match command {
        AgentCommand::Setup {
            name,
            harness,
            model,
            tags,
            drop_tags,
            owner,
            team,
            under,
            ttl,
            intervention,
            no_identity,
            check,
            publish_skills,
            allow_skills,
            deny_skills,
        } => super::agent_setup::setup(
            ctx,
            &super::agent_setup::Options {
                name: name.clone(),
                harness: harness.clone(),
                model: model.clone(),
                tags: tags.clone(),
                drop_tags: drop_tags.clone(),
                owner: owner.clone(),
                team: team.clone(),
                under: under.clone(),
                ttl: *ttl,
                intervention: *intervention,
                no_identity: *no_identity,
                check: *check,
                publish_skills: *publish_skills,
                allow_skills: allow_skills.clone(),
                deny_skills: deny_skills.clone(),
            },
        ),
        AgentCommand::Detect { capabilities: args } => {
            let value = serde_json::to_value(capabilities::detect(args, None, &ctx.cwd)?)?;
            Ok(Shown {
                text: summary(&value).trim().into(),
                value,
            })
        }
        AgentCommand::Show { name } => {
            let agent = match name {
                Some(name) => find(&config, name)?,
                None => self_agent(&config)?,
            };
            Ok(shown_agent(json!({ "agent": agent })))
        }
        AgentCommand::Configure {
            name,
            capabilities: args,
        } => {
            let existing = match name {
                Some(name) => agents(&config)?
                    .into_iter()
                    .find(|a| a["name"] == *name || a["id"] == *name),
                None => Some(self_agent(&config)?),
            };
            if existing.as_ref().is_some_and(|a| !a["revokedAt"].is_null()) {
                return Err(GmError::new(
                    "revoked",
                    "This agent was revoked; create a new identity.",
                ));
            }
            let previous: Option<AgentCapabilities> = existing
                .as_ref()
                .filter(|a| !a["capabilities"].is_null())
                .map(|a| serde_json::from_value(a["capabilities"].clone()))
                .transpose()?;
            let report = capabilities::detect(args, previous.as_ref(), &ctx.cwd)?;
            let (method, path, body) = match &existing {
                Some(agent) => (
                    "PUT",
                    if name.is_none() {
                        "/agents/self/capabilities".into()
                    } else {
                        format!("/agents/{}/capabilities", s(agent, "id"))
                    },
                    serde_json::to_value(report)?,
                ),
                None => (
                    "POST",
                    "/agents".into(),
                    json!({ "name": name, "capabilities": report }),
                ),
            };
            if ctx.dry_run {
                return Ok(Shown {
                    text: format!(
                        "Would {method} {path}\n{}",
                        serde_json::to_string_pretty(&body)?
                    ),
                    value: json!({ "dry_run": true, "method": method, "path": path, "request": body }),
                });
            }
            let mut shown = shown_agent(remote::api(&config, method, &path, Some(&body))?);
            // Tags given now are checked against the tracker's tag catalog (CORE-271).
            if !args.tags.is_empty() {
                let owner = super::tracker::selected_owner(&config, None).ok();
                let check = tag_check(&config, owner.as_deref(), &args.tags);
                if !check.is_null() {
                    shown.text.push('\n');
                    shown.text.push_str(tag_check_text(&check).trim_end());
                    shown.value["tagCatalog"] = check;
                }
            }
            // This checkout's agent keeps its declared model, so setup reruns keep it too.
            if (args.model.is_some() || args.clear_model)
                && let Some(root) = crate::profile::root_from(&ctx.cwd)
                && let Ok(Some(mut local)) = crate::profile::local_at(&root)
                && (name.is_none() || name.as_deref() == local.name.as_deref())
            {
                local.model = if args.clear_model {
                    None
                } else {
                    args.model.clone()
                };
                crate::profile::write_local(&root, &local)?;
            }
            Ok(shown)
        }
        AgentCommand::List { owner } => {
            let list = if let Some(owner) = owner {
                if owner.is_empty()
                    || !owner
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                {
                    return Err(GmError::usage(
                        "Owner must be an account slug (letters, numbers, '-' or '_').",
                    ));
                }
                let snapshot =
                    remote::api(&config, "GET", &format!("/tracker/{owner}/snapshot"), None)?;
                snapshot["agents"].as_array().cloned().ok_or_else(|| {
                    GmError::new("protocol_error", "Tracker snapshot has no agents array.")
                })?
            } else {
                agents(&config)?
            };
            let text = if list.is_empty() {
                "No agents yet. Create one with `gm agent create <name>`.".into()
            } else {
                list.iter().map(line).collect::<Vec<_>>().join("\n")
            };
            Ok(Shown {
                value: json!({ "agents": list }),
                text,
            })
        }
        AgentCommand::Create { name, description } => {
            let body =
                json!({ "name": name, "description": description.clone().unwrap_or_default() });
            if ctx.dry_run {
                return Ok(Shown {
                    text: format!("Would create agent {name}."),
                    value: json!({ "dry_run": true, "request": body }),
                });
            }
            let created = remote::api(&config, "POST", "/agents", Some(&body))?;
            let agent = created["agent"].clone();
            Ok(Shown {
                text: format!(
                    "Created {}. Mint it a token with `gm agent token {name}`.",
                    line(&agent)
                ),
                value: created,
            })
        }
        AgentCommand::Token { name, label, scope } => {
            let agent = find(&config, name)?;
            let mut body = json!({ "scope": scope });
            if let Some(label) = label {
                body["name"] = json!(label);
            }
            if ctx.dry_run {
                return Ok(Shown {
                    text: format!("Would mint a {scope} token for {name}."),
                    value: json!({ "dry_run": true, "agent": agent["id"], "request": body }),
                });
            }
            let token = remote::api(
                &config,
                "POST",
                &format!("/agents/{}/tokens", s(&agent, "id")),
                Some(&body),
            )?;
            Ok(Shown {
                text: format!(
                    "{}\n\nShown once. The agent signs in with it as GM_TOKEN, e.g.\n  GM_TOKEN=… gm issue next --agent {name}",
                    s(&token, "secret")
                ),
                value: json!({ "agent": agent["id"], "token": token }),
            })
        }
        AgentCommand::Revoke { name } => {
            let agent = find(&config, name)?;
            if ctx.dry_run {
                return Ok(Shown {
                    text: format!("Would revoke {name} and its tokens."),
                    value: json!({ "dry_run": true, "agent": agent["id"] }),
                });
            }
            remote::api(
                &config,
                "DELETE",
                &format!("/agents/{}", s(&agent, "id")),
                None,
            )?;
            Ok(Shown {
                text: format!("Revoked {name}; its tokens stopped working."),
                value: json!({ "revoked": agent["id"] }),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::cli::Cli;
    use clap::Parser;

    #[test]
    fn untrusted_profile_text_cannot_control_the_terminal() {
        let profile = serde_json::json!({
            "harness": "\u{1b}[2J", "model": "model\nforged",
            "environment": { "os": "linux", "arch": "x86_64", "runtime": "unknown" },
            "tags": ["rust\rforged"], "skills": [{ "name": "\u{202e}skill", "description": "not displayed\nmultiline" }]
        });
        let text = super::summary(&profile);
        assert!(!text.contains('\u{1b}'));
        assert!(!text.contains('\r'));
        assert!(!text.contains('\u{202e}'));
        assert!(text.contains("model\\nforged"));
        assert!(text.contains("\\u{1b}[2J"));
        assert!(!text.contains("multiline"));
    }

    #[test]
    fn ambiguous_declarations_and_invalid_runtime_are_rejected() {
        for args in [
            vec!["gm", "agent", "configure", "--tag", "rust", "--clear-tags"],
            vec![
                "gm",
                "agent",
                "configure",
                "--skill",
                "review",
                "--clear-skills",
            ],
            vec!["gm", "agent", "detect", "--model", "model", "--clear-model"],
            vec!["gm", "agent", "detect", "--runtime", "guessed"],
        ] {
            assert!(Cli::try_parse_from(args).is_err());
        }
    }
}
