//! Harness hooks (CORE-241): what the person tells the agent, captured as it
//! happens, so the next step carries it verbatim marked `hook`.
//!
//! `gm hook claude-code` is Claude Code's `UserPromptSubmit` hook (installed
//! by `gm agent setup`): it reads the hook's JSON from stdin and, in a
//! checkout working in a timeline, appends the prompt to the step journal's
//! pending entries: a session's first prompt as an instruction, later ones as
//! steering. The next `gm commit --context` or `gm step` takes them in.
//!
//! It never fails the person's prompt and never prints: Claude Code adds a
//! UserPromptSubmit hook's stdout to the conversation.
//!
//! The same contract serves Codex (CORE-242: its UserPromptSubmit hook in
//! `.codex/hooks.json` sends the same fields; the person trusts it once with
//! `/hooks`) and Oh My Pi (`.omp/extensions/gitmatrix-steps.ts` runs
//! `gm hook pi` from its `input` event with the same JSON).

use super::{Ctx, steps};
use crate::repo::Workspace;
use serde_json::{Value, json};
use std::io::Read;
use std::path::PathBuf;

/// The harnesses `gm hook` captures for, by the id `agent::detect` gives them.
pub const HARNESSES: [&str; 3] = ["claude-code", "codex", "pi"];

/// A harness's prompt hook. Always succeeds, silently.
pub fn capture(ctx: &Ctx, harness: &str) {
    if !HARNESSES.contains(&harness) {
        return;
    }
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return;
    }
    let Ok(event) = serde_json::from_str::<Value>(&input) else {
        return;
    };
    let Some(prompt) = event["prompt"].as_str().filter(|p| !p.trim().is_empty()) else {
        return;
    };
    let cwd = event["cwd"]
        .as_str()
        .map(PathBuf::from)
        .unwrap_or_else(|| ctx.cwd.clone());
    let Ok(ws) = Workspace::open(&cwd) else {
        return;
    };
    let session = event["session_id"].as_str().unwrap_or("");
    let _ = steps::capture_prompt(&ws, harness, session, prompt);
}

/// The Claude Code settings entry `gm agent setup` keeps in
/// `.claude/settings.json`: run the hook on every prompt when gm is installed.
pub const CLAUDE_HOOK_COMMAND: &str =
    "command -v gm >/dev/null 2>&1 && gm hook claude-code || true";

/// The same for Codex, in `.codex/hooks.json`.
pub const CODEX_HOOK_COMMAND: &str = "command -v gm >/dev/null 2>&1 && gm hook codex || true";

/// `settings` with the Claude Code step hook added once, everything else kept.
pub fn with_claude_hook(settings: &str) -> String {
    with_prompt_hook(settings, CLAUDE_HOOK_COMMAND)
}

/// `.codex/hooks.json` with the Codex step hook added once (Codex reads the
/// same `hooks.UserPromptSubmit` shape as Claude Code).
pub fn with_codex_hook(settings: &str) -> String {
    with_prompt_hook(settings, CODEX_HOOK_COMMAND)
}

/// Oh My Pi's step extension: `.omp/extensions/gitmatrix-steps.ts`.
pub const OMP_EXTENSION: &str = include_str!("../../assets/omp-steps-extension.ts");

fn with_prompt_hook(settings: &str, command: &str) -> String {
    let mut value: Value = serde_json::from_str(settings).unwrap_or_else(|_| json!({}));
    if !value.is_object() {
        value = json!({});
    }
    let hooks = value
        .as_object_mut()
        .expect("object")
        .entry("hooks")
        .or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let list = hooks
        .as_object_mut()
        .expect("object")
        .entry("UserPromptSubmit")
        .or_insert_with(|| json!([]));
    if !list.is_array() {
        *list = json!([]);
    }
    let present = list.as_array().expect("array").iter().any(|group| {
        group["hooks"].as_array().is_some_and(|hs| {
            hs.iter().any(|h| {
                h["command"].as_str().is_some_and(|c| {
                    c.contains(
                        command
                            .split("&& ")
                            .nth(1)
                            .unwrap_or(command)
                            .trim_end_matches(" || true"),
                    )
                })
            })
        })
    });
    if !present {
        list.as_array_mut().expect("array").push(json!({
            "hooks": [{"type": "command", "command": command}]
        }));
    }
    serde_json::to_string_pretty(&value).unwrap_or_default() + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hook_is_added_once_and_other_settings_stay() {
        let mine = r#"{"model": "opus", "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "say done"}]}]}}"#;
        let once = with_claude_hook(mine);
        let twice = with_claude_hook(&once);
        assert_eq!(once, twice);
        let value: Value = serde_json::from_str(&once).unwrap();
        assert_eq!(value["model"], json!("opus"));
        assert_eq!(
            value["hooks"]["Stop"][0]["hooks"][0]["command"],
            json!("say done")
        );
        assert_eq!(
            value["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"],
            json!(CLAUDE_HOOK_COMMAND)
        );
        assert!(with_claude_hook("").contains("gm hook claude-code"));
        // Codex: the same shape, its own command, beside a Claude hook if both are there.
        let both = with_codex_hook(&once);
        let value: Value = serde_json::from_str(&both).unwrap();
        assert_eq!(
            value["hooks"]["UserPromptSubmit"].as_array().unwrap().len(),
            2
        );
        assert_eq!(with_codex_hook(&both), both);
        assert!(OMP_EXTENSION.contains("gm\", [\"hook\", \"pi\"]"));
    }
}
