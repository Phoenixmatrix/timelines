//! Agents: identities that work on their own, each with a person accountable
//! for it. `gm agent token` mints a token the agent signs in with (GM_TOKEN).

use super::Ctx;
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

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}

/// "builder (for Ann Lee)": an agent and the person answerable for it.
fn line(agent: &Value) -> String {
    let revoked = if agent["revokedAt"].is_null() {
        String::new()
    } else {
        format!("  revoked {}", s(agent, "revokedAt"))
    };
    let tokens = agent["tokens"].as_array().map_or(0, Vec::len);
    format!(
        "{} (for {})  {} token{}{}",
        s(agent, "name"),
        s(&agent["accountable"], "displayName"),
        tokens,
        if tokens == 1 { "" } else { "s" },
        revoked
    )
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
    let config = Config::load();
    match command {
        AgentCommand::List => {
            let list = agents(&config)?;
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
