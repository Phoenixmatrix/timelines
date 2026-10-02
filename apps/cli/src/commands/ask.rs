//! `gm ask`: ask the Gitmatrix assistant from a terminal (CORE-26), the way a
//! DeepWiki MCP answers questions about a codebase, but over everything the
//! server knows: code and its knowledge graph, issues, CI and packages.
//!
//! People see the answer stream in; agents (JSON output) get one object with
//! the answer, what the assistant looked at and a link to continue on the
//! web. Read-only unless --write, since a terminal can't approve each change.

use super::Ctx;
use super::agents::Shown;
use crate::cli::{AskArgs, AssistantCommand};
use crate::output::{Format, GmError, Result};
use crate::remote::{self, Config};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::path::Path;

/// owner/name of the checkout's origin, when it lives on this server.
fn origin_repo(cwd: &Path, server: &str) -> Option<String> {
    let root = crate::profile::root_from(cwd)?;
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["remote", "get-url", "origin"])
        .output()
        .ok()?;
    let url = String::from_utf8(out.stdout).ok()?;
    let url = url.trim().trim_end_matches('/').trim_end_matches(".git");
    let rest = url.strip_prefix(server.trim_end_matches('/'))?;
    let mut parts = rest.trim_start_matches('/').split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(owner), Some(name), None) if !owner.is_empty() && !name.is_empty() => {
            Some(format!("{owner}/{name}"))
        }
        _ => None,
    }
}

fn question(args: &AskArgs) -> Result<String> {
    let joined = args.question.join(" ");
    let text = if joined.trim() == "-" {
        let mut buf = String::new();
        std::io::stdin().read_to_string(&mut buf)?;
        buf
    } else {
        joined
    };
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err(GmError::usage(
            "Ask a question: gm ask \"Why did run 44 fail?\"",
        ));
    }
    Ok(text)
}

pub fn ask(ctx: &Ctx, args: &AskArgs) -> Result<Shown> {
    let config = Config::load();
    let question = question(args)?;
    let repo = args
        .repo
        .clone()
        .or_else(|| origin_repo(&ctx.cwd, &config.server()));
    let mut body = json!({ "question": question, "write": args.write });
    if let Some(repo) = &repo {
        body["repo"] = json!(repo);
    }
    if let Some(chat) = &args.chat {
        body["chatId"] = json!(chat);
    }
    if ctx.dry_run {
        return Ok(Shown::new(
            json!({ "dry_run": true, "request": body }),
            format!(
                "Would ask{}: {question}",
                repo.as_deref()
                    .map(|r| format!(" about {r}"))
                    .unwrap_or_default()
            ),
        ));
    }

    // People watch it arrive; agents get one object at the end.
    let live = ctx.format == Format::Text;
    let mut answer = String::new();
    let mut chat_id = String::new();
    let mut url = String::new();
    let mut tools: Vec<String> = Vec::new();
    let mut failure: Option<String> = None;
    let mut plan = Value::Null;
    let mut stdout = std::io::stdout();
    let mut stderr = std::io::stderr();
    remote::stream_lines(&config, "/assistant/ask", &body, |line| {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            return Ok(());
        };
        let text = |key: &str| event[key].as_str().unwrap_or("").to_string();
        match event["type"].as_str() {
            Some("chat") => {
                chat_id = text("chatId");
                url = text("url");
            }
            Some("status") if live => {
                let _ = writeln!(stderr, "\x1b[2m{}…\x1b[0m", text("text"));
            }
            Some("tool") => {
                let label = text("label");
                if live {
                    let _ = writeln!(stderr, "\x1b[2m· {label}\x1b[0m");
                }
                tools.push(label);
            }
            Some("text") => {
                let delta = text("delta");
                if live {
                    let _ = write!(stdout, "{delta}");
                    let _ = stdout.flush();
                }
                answer.push_str(&delta);
            }
            Some("plan") => {
                plan = json!({
                    "intent": event["intent"],
                    "model": event["model"],
                    "groups": event["groups"],
                    "codemode": event["codemode"],
                    "routedMs": event["routedMs"],
                });
            }
            Some("error") => failure = Some(text("message")),
            _ => {}
        }
        Ok(())
    })?;
    if let Some(message) = failure {
        return Err(GmError::new("assistant_failed", message).hint(format!(
            "Try again, or continue the conversation on the web: {url}"
        )));
    }
    if live {
        let _ = writeln!(stdout);
    }
    Ok(Shown::new(
        json!({
            "chatId": chat_id,
            "url": url,
            "repo": repo,
            "answer": answer.trim(),
            "tools": tools,
            "plan": plan,
            "next": format!("Follow up with gm ask --chat {chat_id} \"…\"; open {url} to continue on the web."),
        }),
        // The answer already streamed; leave the way back.
        format!("\x1b[2mContinue: gm ask --chat {chat_id} \"…\" · {url}\x1b[0m"),
    ))
}

pub fn assistant(ctx: &Ctx, command: &AssistantCommand) -> Result<Shown> {
    let config = Config::load();
    match command {
        AssistantCommand::List => {
            let value = remote::api(&config, "GET", "/assistant/chats", None)?;
            let chats = value["chats"].as_array().cloned().unwrap_or_default();
            let text = if chats.is_empty() {
                "No conversations yet. Start one with `gm ask \"…\"`.".to_string()
            } else {
                chats
                    .iter()
                    .map(|c| {
                        format!(
                            "{}  {}  {}{}",
                            c["id"].as_str().unwrap_or(""),
                            c["updatedAt"].as_str().unwrap_or(""),
                            c["title"]
                                .as_str()
                                .filter(|t| !t.is_empty())
                                .unwrap_or("(untitled)"),
                            if c["source"] == "cli" {
                                "  · gm ask"
                            } else {
                                ""
                            }
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            Ok(Shown::new(value, text))
        }
        AssistantCommand::Show { id } => {
            let value = remote::api(&config, "GET", &format!("/assistant/chats/{id}"), None)?;
            let mut text = format!(
                "{}\n",
                value["title"]
                    .as_str()
                    .filter(|t| !t.is_empty())
                    .unwrap_or("(untitled)")
            );
            for message in value["messages"].as_array().into_iter().flatten() {
                let who = if message["role"] == "user" {
                    "You"
                } else {
                    "Assistant"
                };
                for tool in message["tools"].as_array().into_iter().flatten() {
                    text.push_str(&format!("  · {}\n", tool.as_str().unwrap_or("")));
                }
                text.push_str(&format!(
                    "\n{who}: {}\n",
                    message["text"].as_str().unwrap_or("")
                ));
            }
            Ok(Shown::new(value, text))
        }
        AssistantCommand::Delete { id } => {
            if ctx.dry_run {
                return Ok(Shown::new(
                    json!({ "dry_run": true, "chat": id }),
                    format!("Would delete conversation {id}."),
                ));
            }
            remote::api(&config, "DELETE", &format!("/assistant/chats/{id}"), None)?;
            Ok(Shown::new(
                json!({ "deleted": id }),
                format!("Deleted conversation {id}."),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_checkout_names_the_repository_only_on_this_server() {
        let dir = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(dir.path())
                .args(args)
                .output()
                .unwrap()
        };
        git(&["init", "-q"]);
        git(&[
            "remote",
            "add",
            "origin",
            "https://gitmatrix.example/orbit/engine.git",
        ]);
        assert_eq!(
            origin_repo(dir.path(), "https://gitmatrix.example/").as_deref(),
            Some("orbit/engine")
        );
        assert_eq!(origin_repo(dir.path(), "https://elsewhere.example"), None);
    }
}
