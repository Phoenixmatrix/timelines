//! Recognise when an AI agent harness is driving the CLI, from the same
//! environment signals the Cloudflare `cf` CLI uses.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Harness {
    pub id: &'static str,
    pub name: &'static str,
}

fn set(name: &str) -> Option<String> {
    let value = std::env::var(name).ok()?;
    let trimmed = value.trim();
    if matches!(
        trimmed.to_lowercase().as_str(),
        "" | "0" | "false" | "no" | "off"
    ) {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn equals(name: &str, expected: &str) -> bool {
    std::env::var(name).map(|v| v == expected).unwrap_or(false)
}

pub fn detect() -> Option<Harness> {
    // GM_AGENT=1 forces agent mode; GM_AGENT=0 turns detection off.
    if let Ok(forced) = std::env::var("GM_AGENT") {
        return match forced.as_str() {
            "0" | "false" | "no" | "off" => None,
            _ => Some(Harness {
                id: "custom",
                name: "Agent",
            }),
        };
    }
    type Check = (fn() -> bool, &'static str, &'static str);
    let checks: &[Check] = &[
        (|| equals("CLAUDECODE", "1"), "claude-code", "Claude Code"),
        (|| set("CODEX_THREAD_ID").is_some(), "codex", "OpenAI Codex"),
        (
            || equals("CURSOR_AGENT", "1"),
            "cursor-agent",
            "Cursor Agent",
        ),
        (|| equals("GEMINI_CLI", "1"), "gemini-agent", "Gemini CLI"),
        (|| equals("OPENCODE", "1"), "opencode", "OpenCode"),
        (|| set("AMP_CURRENT_THREAD_ID").is_some(), "amp", "Amp"),
        (|| equals("AUGMENT_AGENT", "1"), "auggie", "Auggie"),
        (
            || set("QWEN_CODE_SESSION_ID").is_some(),
            "qwen-code",
            "Qwen Code",
        ),
        (|| set("OZ_RUN_ID").is_some(), "warp", "Warp"),
        (
            || equals("COPILOT_AGENT", "1"),
            "vscode-copilot-agent",
            "GitHub Copilot",
        ),
        (|| set("AI_AGENT").is_some(), "ai-agent", "Agent"),
    ];
    checks
        .iter()
        .find(|(check, _, _)| check())
        .map(|(_, id, name)| Harness { id, name })
}

/// Printed above help output when an agent is driving, like `cf`'s banner.
pub const DISCOVERY_BANNER: &str = "\
=== AGENTS: START HERE ===
Do not explore gm by chaining --help calls. Instead:
  gm cli guide                     the workflow in one page (read once per session)
  gm cli search \"<what you want>\"  top 5 matching commands as JSON
  gm schema <command...>           exact inputs and the JSON output shape
Output is JSON whenever an agent or a pipe is detected. Errors are JSON on
stderr with a stable `code` and a `hint`. Every mutating command takes --dry-run,
and `gm undo` reverses the last operation.
=== END AGENTS ===
";
