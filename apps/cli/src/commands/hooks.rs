//! Harness hooks (CORE-241): what the person tells the agent, captured as it
//! happens, so the next step carries it verbatim marked `hook`.
//!
//! `gm hook claude-code` is Claude Code's `UserPromptSubmit` hook (installed
//! by `gm agent setup`): it reads the hook's JSON from stdin and, in a
//! checkout working in a timeline, appends the prompt to the step journal's
//! pending entries: a session's first prompt as an instruction, later ones as
//! steering. The next `gm commit --context` or `gm step` takes them in.
//!
//! It never fails the person's prompt. It prints only lease updates (CORE-261,
//! `lease_updates`): Claude Code adds a UserPromptSubmit hook's stdout to the
//! conversation, so the agent reads what others changed on the issues it holds
//! with the person's prompt. `gm hook claude-code updates`, its PostToolUse
//! hook, does the same between prompts.
//!
//! The same contract serves Codex (CORE-242: its UserPromptSubmit hook in
//! `.codex/hooks.json` sends the same fields; the person trusts it once with
//! `/hooks`) and Oh My Pi (`.omp/extensions/gitmatrix-steps.ts` runs
//! `gm hook pi` from its `input` event with the same JSON).

use super::{Ctx, lease_updates, steps};
use crate::remote::Config;
use crate::repo::Workspace;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

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
    // Only Claude Code is known to read a prompt hook's stdout as context.
    if harness == "claude-code" {
        let _ = std::env::set_current_dir(&cwd);
        let config = Config::load();
        if let Some(scope) = lease_updates::Scope::hook(&config)
            && lease_updates::holds_any(&config, &scope)
        {
            lease_updates::for_hook(&config, &scope, |news| print!("{news}"));
        }
    }
}

/// How often the PostToolUse hook may ask the server, per identity.
const UPDATES_EVERY: Duration = Duration::from_secs(60);

/// Claude Code's PostToolUse hook (CORE-261): news on the issues this
/// checkout's identity holds, as context beside the tool result. Asks the
/// server at most once a minute and only while a lease is held; never inside a
/// subagent, whose context the lead wouldn't see; never fails the tool call.
pub fn updates(harness: &str) {
    if harness != "claude-code" {
        return;
    }
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return;
    }
    let Ok(event) = serde_json::from_str::<Value>(&input) else {
        return;
    };
    if event["agent_id"].as_str().is_some_and(|id| !id.is_empty()) {
        return;
    }
    if let Some(cwd) = event["cwd"].as_str() {
        let _ = std::env::set_current_dir(cwd);
    }
    let config = Config::load();
    let Some(scope) = lease_updates::Scope::hook(&config) else {
        return;
    };
    if !lease_updates::holds_any(&config, &scope)
        || !lease_updates::due(&config, &scope.identity, UPDATES_EVERY)
    {
        return;
    }
    lease_updates::for_hook(&config, &scope, |news| {
        println!("{}", post_tool_use_context(news))
    });
}

fn post_tool_use_context(news: &str) -> Value {
    json!({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": news}})
}

/// The Claude Code settings entry `gm agent setup` keeps in
/// `.claude/settings.json`: run the hook on every prompt when gm is installed.
pub const CLAUDE_HOOK_COMMAND: &str =
    "command -v gm >/dev/null 2>&1 && gm hook claude-code || true";

/// Claude Code's lease-update hook, after each tool call (CORE-261).
pub const CLAUDE_UPDATES_COMMAND: &str =
    "command -v gm >/dev/null 2>&1 && gm hook claude-code updates || true";

/// The same for Codex, in `.codex/hooks.json`.
pub const CODEX_HOOK_COMMAND: &str = "command -v gm >/dev/null 2>&1 && gm hook codex || true";

/// `settings` with the Claude Code step hook added once, everything else kept.
pub fn with_claude_hook(settings: &str) -> String {
    let settings = with_hook(settings, "UserPromptSubmit", CLAUDE_HOOK_COMMAND);
    with_hook(&settings, "PostToolUse", CLAUDE_UPDATES_COMMAND)
}

/// `.codex/hooks.json` with the Codex step hook added once (Codex reads the
/// same `hooks.UserPromptSubmit` shape as Claude Code).
pub fn with_codex_hook(settings: &str) -> String {
    with_hook(settings, "UserPromptSubmit", CODEX_HOOK_COMMAND)
}

/// Oh My Pi's step extension: `.omp/extensions/gitmatrix-steps.ts`.
pub const OMP_EXTENSION: &str = include_str!("../../assets/omp-steps-extension.ts");

/// The hooks' event lists, in the order the file has them.
#[derive(Deserialize)]
struct OrderedHooks {
    hooks: IndexMap<String, Value>,
}

/// A settings key on the way out: `hooks` keeps its events' order.
#[derive(Serialize)]
#[serde(untagged)]
enum Field {
    Hooks(IndexMap<String, Value>),
    Plain(Value),
}

/// `settings` with the hook added once. A file that already has it comes back
/// byte for byte, so setup and `--check` see it as current whatever its key
/// order or layout (CORE-405); adding one keeps the order of the top-level and
/// `hooks` keys, other people's included, and appends what is new.
fn with_hook(settings: &str, event: &str, command: &str) -> String {
    // serde_json's own maps sort their keys: read the order from the text.
    let top: Option<IndexMap<String, Value>> = serde_json::from_str(settings).ok();
    let mut hooks = serde_json::from_str::<OrderedHooks>(settings)
        .map(|ordered| ordered.hooks)
        .unwrap_or_default();
    let needle = command
        .split("&& ")
        .nth(1)
        .unwrap_or(command)
        .trim_end_matches(" || true");
    let present = hooks
        .get(event)
        .and_then(Value::as_array)
        .is_some_and(|list| {
            list.iter().any(|group| {
                group["hooks"].as_array().is_some_and(|hs| {
                    hs.iter()
                        .any(|h| h["command"].as_str().is_some_and(|c| c.contains(needle)))
                })
            })
        });
    if present && top.is_some() {
        return settings.to_string();
    }
    let list = hooks.entry(event.to_string()).or_insert_with(|| json!([]));
    if !list.is_array() {
        *list = json!([]);
    }
    list.as_array_mut().expect("array").push(json!({
        "hooks": [{"type": "command", "command": command}]
    }));
    let mut out: IndexMap<String, Field> = top
        .unwrap_or_default()
        .into_iter()
        .map(|(key, value)| (key, Field::Plain(value)))
        .collect();
    out.insert("hooks".to_string(), Field::Hooks(hooks));
    serde_json::to_string_pretty(&out).unwrap_or_default() + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A checked-in settings file as a formatter leaves it: its own key order,
    /// short arrays on one line (CORE-405).
    const FORMATTED: &str = r#"{
  "model": "opus",
  "fallbackModel": ["sonnet"],
  "env": {
    "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet"
  },
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "command": "command -v gm >/dev/null 2>&1 && gm hook claude-code || true",
            "type": "command"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "command": "command -v gm >/dev/null 2>&1 && gm hook claude-code updates || true",
            "type": "command"
          }
        ]
      }
    ]
  }
}
"#;

    #[test]
    fn settings_that_already_have_the_hooks_stay_byte_for_byte() {
        assert_eq!(with_claude_hook(FORMATTED), FORMATTED);
    }

    #[test]
    fn adding_a_hook_keeps_the_files_key_order() {
        // Only the prompt hook: setup adds the updates hook and nothing moves.
        let start = FORMATTED.find(",\n    \"PostToolUse\"").unwrap();
        let end = FORMATTED.rfind("\n  }\n}").unwrap();
        let partial = format!("{}{}", &FORMATTED[..start], &FORMATTED[end..]);
        let added = with_claude_hook(&partial);
        let top: IndexMap<String, Value> = serde_json::from_str(&added).unwrap();
        assert_eq!(
            top.keys().collect::<Vec<_>>(),
            ["model", "fallbackModel", "env", "hooks"]
        );
        let hooks = serde_json::from_str::<OrderedHooks>(&added).unwrap().hooks;
        assert_eq!(
            hooks.keys().collect::<Vec<_>>(),
            ["UserPromptSubmit", "PostToolUse"]
        );
        assert_eq!(
            hooks["PostToolUse"][0]["hooks"][0]["command"],
            json!(CLAUDE_UPDATES_COMMAND)
        );
        // Settings the agent's person added stay where they were too.
        let theirs =
            r#"{"permissions": {"allow": ["Bash(ls)"]}, "hooks": {"Stop": []}, "theme": "dark"}"#;
        let top: IndexMap<String, Value> = serde_json::from_str(&with_claude_hook(theirs)).unwrap();
        assert_eq!(
            top.keys().collect::<Vec<_>>(),
            ["permissions", "hooks", "theme"]
        );
    }

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
        assert_eq!(
            value["hooks"]["PostToolUse"][0]["hooks"][0]["command"],
            json!(CLAUDE_UPDATES_COMMAND)
        );
        // Codex: the same shape, its own command, beside a Claude hook if both are there.
        let both = with_codex_hook(&once);
        let value: Value = serde_json::from_str(&both).unwrap();
        assert_eq!(
            value["hooks"]["UserPromptSubmit"].as_array().unwrap().len(),
            2
        );
        assert_eq!(with_codex_hook(&both), both);
        assert!(OMP_EXTENSION.contains("gm\", [\"hook\", \"pi\"]"));
        // Codex gets no PostToolUse hook: only the prompt hook.
        assert_eq!(value["hooks"]["PostToolUse"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn updates_reach_claude_code_as_post_tool_use_context() {
        let shown = post_tool_use_context("CORE-1 changed");
        assert_eq!(shown["hookSpecificOutput"]["hookEventName"], "PostToolUse");
        assert_eq!(
            shown["hookSpecificOutput"]["additionalContext"],
            "CORE-1 changed"
        );
    }
}
