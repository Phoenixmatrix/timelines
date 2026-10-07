//! `gm agent mod` (CORE-303): install the Claude Code mod that shows the
//! gitmatrix issue a session works on in a card above the prompt.
//!
//! Claude Code loads a plugin folder from its user skills folder by itself
//! (`~/.claude/skills/<name>`, or under `CLAUDE_CONFIG_DIR`), so installing is
//! writing the mod there and binding its chord in `keybindings.json`. Mods
//! can't declare keybinding actions, so the chord goes to an engine action
//! that is idle outside the diff panel, and the mod's hidden Button answers it
//! (assets/claude-code-mod/hooks/register.tsx's ACTION).
//!
//! Reruns update the files; `--check` reports what's stale; `--remove`
//! uninstalls. The person's other keybindings are never touched.

use super::Ctx;
use super::agents::Shown;
use crate::output::{GmError, Result, exit};
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

/// The plugin's name, and its folder under `<claude dir>/skills`.
pub const NAME: &str = "gitmatrix-work";
/// The engine action the mod's toggle Button answers.
pub const ACTION: &str = "app:toggleDiffPreSession";
/// The chord bound when none is: free in Claude Code's defaults, and under
/// its own ctrl+x prefix, so no terminal multiplexer takes it.
pub const DEFAULT_KEY: &str = "ctrl+x g";
const CONTEXT: &str = "Global";

macro_rules! asset {
    ($path:literal) => {
        (
            $path,
            include_str!(concat!("../../assets/claude-code-mod/", $path)),
        )
    };
}

/// The mod's runtime files, relative to its folder. Tests and the dev
/// tsconfig stay in the repository.
const FILES: &[(&str, &str)] = &[
    asset!(".claude-plugin/plugin.json"),
    asset!("hooks/hooks.json"),
    asset!("hooks/register.tsx"),
    asset!("hooks/gm.ts"),
    asset!("types/index.d.ts"),
];

pub struct Options {
    pub key: Option<String>,
    pub check: bool,
    pub remove: bool,
}

/// Claude Code's configuration folder: `CLAUDE_CONFIG_DIR`, else `~/.claude`.
fn claude_dir() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|home| PathBuf::from(home).join(".claude"))
        .ok_or_else(|| {
            GmError::new(
                "no_home",
                "Can't find Claude Code's folder: HOME isn't set.",
            )
            .hint("Set CLAUDE_CONFIG_DIR to it.")
        })
}

pub fn run(ctx: &Ctx, o: &Options) -> Result<Shown> {
    let dir = claude_dir()?;
    if o.remove {
        remove(&dir, ctx.dry_run)
    } else {
        install(&dir, o.key.as_deref(), o.check, ctx.dry_run)
    }
}

/// A file the install manages, and what it should contain.
struct Planned {
    path: PathBuf,
    content: String,
    stale: bool,
    exists: bool,
}

fn plan(path: PathBuf, content: String) -> Planned {
    let current = std::fs::read_to_string(&path).ok();
    Planned {
        stale: current.as_deref() != Some(content.as_str()),
        exists: current.is_some(),
        path,
        content,
    }
}

fn status(f: &Planned) -> &'static str {
    match (f.stale, f.exists) {
        (false, _) => "unchanged",
        (true, true) => "updated",
        (true, false) => "created",
    }
}

fn install(dir: &Path, key: Option<&str>, check: bool, dry_run: bool) -> Result<Shown> {
    let folder = dir.join("skills").join(NAME);
    let keybindings = dir.join("keybindings.json");
    let current = std::fs::read_to_string(&keybindings).ok();
    let bound = bind(current.as_deref(), key)?;
    let mut files: Vec<Planned> = FILES
        .iter()
        .map(|(path, content)| plan(folder.join(path), (*content).to_string()))
        .collect();
    files.push(plan(keybindings, bound.content));

    if check {
        let stale: Vec<String> = files
            .iter()
            .filter(|f| f.stale)
            .map(|f| f.path.display().to_string())
            .collect();
        if !stale.is_empty() {
            return Err(GmError::new(
                "stale",
                format!("The Claude Code mod is out of date: {}.", stale.join(", ")),
            )
            .hint("Run `gm agent mod` to update it.")
            .exit(exit::CONFLICT));
        }
        return Ok(Shown::new(
            json!({ "upToDate": true, "dir": folder, "key": bound.key, "files": report(&files) }),
            format!(
                "The Claude Code mod is up to date ({} toggles it).",
                bound.key
            ),
        ));
    }

    if !dry_run {
        for f in files.iter().filter(|f| f.stale) {
            if let Some(parent) = f.path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&f.path, &f.content)?;
        }
    }

    let value = json!({
        "dryRun": dry_run,
        "plugin": NAME,
        "dir": folder,
        "key": bound.key,
        "action": ACTION,
        "files": report(&files),
        "next": "New Claude Code sessions load it: press the key (or run /gm-work) to show the card.",
    });
    let mut text = format!(
        "{} the Claude Code mod {NAME}: {} or /gm-work toggles the card\n",
        if dry_run {
            "Would install"
        } else {
            "Installed"
        },
        bound.key,
    );
    for f in &files {
        text.push_str(&format!("  {:<9} {}\n", status(f), f.path.display()));
    }
    text.push_str(
        "Next: start a Claude Code session; the card shows the gitmatrix issue it works on.",
    );
    Ok(Shown::new(value, text))
}

fn report(files: &[Planned]) -> Vec<Value> {
    files
        .iter()
        .map(|f| json!({ "path": f.path, "status": status(f) }))
        .collect()
}

fn remove(dir: &Path, dry_run: bool) -> Result<Shown> {
    let folder = dir.join("skills").join(NAME);
    let manifest = std::fs::read_to_string(folder.join(".claude-plugin/plugin.json")).ok();
    let ours = manifest
        .and_then(|m| serde_json::from_str::<Value>(&m).ok())
        .is_some_and(|m| m["name"] == json!(NAME));
    if folder.exists() && !ours {
        return Err(GmError::new(
            "not_ours",
            format!("{} isn't the gitmatrix mod; leaving it.", folder.display()),
        )
        .exit(exit::CONFLICT));
    }
    let keybindings = dir.join("keybindings.json");
    let current = std::fs::read_to_string(&keybindings).ok();
    let unbound = match current.as_deref() {
        Some(text) => unbind(text)?,
        None => None,
    };
    if !dry_run {
        if ours {
            std::fs::remove_dir_all(&folder)?;
        }
        if let Some(content) = &unbound {
            std::fs::write(&keybindings, content)?;
        }
    }
    let files = json!([
        { "path": folder, "status": if ours { "removed" } else { "absent" } },
        { "path": keybindings, "status": if unbound.is_some() { "updated" } else { "unchanged" } },
    ]);
    let text = format!(
        "{} the Claude Code mod {NAME}\n  {:<9} {}\n  {:<9} {}",
        if dry_run { "Would remove" } else { "Removed" },
        files[0]["status"].as_str().unwrap_or(""),
        folder.display(),
        files[1]["status"].as_str().unwrap_or(""),
        keybindings.display(),
    );
    Ok(Shown::new(
        json!({ "dryRun": dry_run, "plugin": NAME, "removed": ours, "files": files }),
        text,
    ))
}

/// keybindings.json with the mod's chord bound, and the chord.
struct Bound {
    content: String,
    key: String,
}

fn invalid(message: impl Into<String>) -> GmError {
    GmError::new("invalid_keybindings", message)
        .hint("Fix Claude Code's keybindings.json (it must hold a \"bindings\" array), then rerun.")
}

/// The file's `bindings` array, created when the file is empty.
fn parse(text: Option<&str>) -> Result<Value> {
    let text = text.unwrap_or("").trim();
    let mut value: Value = if text.is_empty() {
        json!({
            "$schema": "https://www.schemastore.org/claude-code-keybindings.json",
            "$docs": "https://code.claude.com/docs/en/keybindings",
        })
    } else {
        serde_json::from_str(text)
            .map_err(|e| invalid(format!("Claude Code's keybindings.json isn't JSON: {e}")))?
    };
    let Some(object) = value.as_object_mut() else {
        return Err(invalid("Claude Code's keybindings.json isn't an object."));
    };
    let bindings = object.entry("bindings").or_insert_with(|| json!([]));
    if !bindings.is_array() {
        return Err(invalid(
            "Claude Code's keybindings.json's \"bindings\" isn't an array.",
        ));
    }
    Ok(value)
}

fn blocks(value: &mut Value) -> &mut Vec<Value> {
    value["bindings"].as_array_mut().expect("parse checked it")
}

/// The chords bound to the mod's action, in any context.
fn chords_for_action(value: &Value) -> Vec<String> {
    value["bindings"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|block| block["bindings"].as_object())
        .flat_map(|map| map.iter())
        .filter(|(_, action)| action.as_str() == Some(ACTION))
        .map(|(chord, _)| chord.clone())
        .collect()
}

/// Drops every binding of the mod's action, and blocks left empty by it.
fn drop_action(value: &mut Value) {
    blocks(value).retain_mut(|block| {
        let Some(map) = block["bindings"].as_object_mut() else {
            return true;
        };
        let before = map.len();
        map.retain(|_, action| action.as_str() != Some(ACTION));
        !(map.is_empty() && before > 0)
    });
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default() + "\n"
}

/// Binds `key` (default: the chord already bound, else DEFAULT_KEY) to the
/// mod's action in the Global context, leaving every other binding alone.
fn bind(text: Option<&str>, key: Option<&str>) -> Result<Bound> {
    let mut value = parse(text)?;
    let existing = chords_for_action(&value);
    let key = match key.map(str::trim).filter(|k| !k.is_empty()) {
        Some(key) => key.to_string(),
        None if !existing.is_empty() => {
            // Already bound (perhaps to a chord the person chose): keep it.
            let unchanged = text.map(str::to_string).unwrap_or_else(|| pretty(&value));
            return Ok(Bound {
                content: unchanged,
                key: existing[0].clone(),
            });
        }
        None => DEFAULT_KEY.to_string(),
    };
    if existing == [key.clone()] {
        let unchanged = text.map(str::to_string).unwrap_or_else(|| pretty(&value));
        return Ok(Bound {
            content: unchanged,
            key,
        });
    }
    drop_action(&mut value);
    let list = blocks(&mut value);
    let global = list
        .iter()
        .position(|block| block["context"].as_str() == Some(CONTEXT));
    let block = match global {
        Some(at) => &mut list[at],
        None => {
            list.push(json!({ "context": CONTEXT, "bindings": {} }));
            list.last_mut().expect("just pushed")
        }
    };
    if !block["bindings"].is_object() {
        block["bindings"] = Value::Object(Map::new());
    }
    let map = block["bindings"].as_object_mut().expect("object");
    if let Some(taken) = map.get(&key).filter(|action| !action.is_null()) {
        return Err(GmError::new(
            "key_taken",
            format!(
                "{key} is already bound to {} in Claude Code's {CONTEXT} keybindings.",
                taken.as_str().unwrap_or("something else")
            ),
        )
        .hint("Pass another chord: `gm agent mod --key 'ctrl+x w'`.")
        .exit(exit::CONFLICT));
    }
    map.insert(key.clone(), json!(ACTION));
    Ok(Bound {
        content: pretty(&value),
        key,
    })
}

/// keybindings.json without the mod's chord, or None when it had none.
fn unbind(text: &str) -> Result<Option<String>> {
    let mut value = parse(Some(text))?;
    if chords_for_action(&value).is_empty() {
        return Ok(None);
    }
    drop_action(&mut value);
    Ok(Some(pretty(&value)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chords(content: &str) -> Vec<String> {
        chords_for_action(&serde_json::from_str(content).unwrap())
    }

    #[test]
    fn a_missing_file_gets_the_default_chord_with_its_schema() {
        let bound = bind(None, None).unwrap();
        assert_eq!(bound.key, DEFAULT_KEY);
        let value: Value = serde_json::from_str(&bound.content).unwrap();
        assert_eq!(
            value["$schema"],
            json!("https://www.schemastore.org/claude-code-keybindings.json")
        );
        assert_eq!(
            value["bindings"],
            json!([{ "context": "Global", "bindings": { "ctrl+x g": ACTION } }])
        );
    }

    #[test]
    fn binding_keeps_the_persons_bindings_and_is_idempotent() {
        let mine = r#"{"bindings": [
            {"context": "Chat", "bindings": {"ctrl+e": "chat:externalEditor"}},
            {"context": "Global", "bindings": {"ctrl+k ctrl+t": "app:toggleTodos"}}
        ]}"#;
        let once = bind(Some(mine), None).unwrap();
        let twice = bind(Some(&once.content), None).unwrap();
        assert_eq!(once.content, twice.content);
        let value: Value = serde_json::from_str(&once.content).unwrap();
        assert_eq!(
            value["bindings"][0]["bindings"],
            json!({"ctrl+e": "chat:externalEditor"})
        );
        assert_eq!(
            value["bindings"][1]["bindings"],
            json!({"ctrl+k ctrl+t": "app:toggleTodos", "ctrl+x g": ACTION})
        );
    }

    #[test]
    fn a_chord_the_person_chose_is_kept_and_key_moves_it() {
        let chosen = bind(None, Some("ctrl+x w")).unwrap();
        assert_eq!(chosen.key, "ctrl+x w");
        let rerun = bind(Some(&chosen.content), None).unwrap();
        assert_eq!(rerun.key, "ctrl+x w");
        assert_eq!(rerun.content, chosen.content);
        let moved = bind(Some(&chosen.content), Some("ctrl+x m")).unwrap();
        assert_eq!(chords(&moved.content), ["ctrl+x m"]);
    }

    #[test]
    fn a_taken_chord_is_refused_and_broken_files_are_never_overwritten() {
        let taken =
            r#"{"bindings": [{"context": "Global", "bindings": {"ctrl+x g": "app:redraw"}}]}"#;
        let refused = bind(Some(taken), None).err().unwrap();
        assert_eq!(refused.code, "key_taken");
        // Unbinding a default (null) frees the chord.
        let freed = r#"{"bindings": [{"context": "Global", "bindings": {"ctrl+x g": null}}]}"#;
        assert_eq!(
            chords(&bind(Some(freed), None).unwrap().content),
            ["ctrl+x g"]
        );
        assert_eq!(
            bind(Some("{oops"), None).err().unwrap().code,
            "invalid_keybindings"
        );
        assert_eq!(
            bind(Some(r#"{"bindings": {}}"#), None).err().unwrap().code,
            "invalid_keybindings"
        );
    }

    #[test]
    fn unbinding_drops_only_the_mods_chord() {
        let mine =
            r#"{"bindings": [{"context": "Chat", "bindings": {"ctrl+e": "chat:externalEditor"}}]}"#;
        let bound = bind(Some(mine), None).unwrap();
        let unbound = unbind(&bound.content).unwrap().unwrap();
        let value: Value = serde_json::from_str(&unbound).unwrap();
        assert_eq!(
            value["bindings"],
            json!([{"context": "Chat", "bindings": {"ctrl+e": "chat:externalEditor"}}])
        );
        assert_eq!(unbind(&unbound).unwrap(), None);
    }

    #[test]
    fn install_check_and_remove_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let claude = dir.path();
        let installed = install(claude, None, false, false).unwrap();
        let value = serde_json::to_value(&installed).unwrap();
        assert_eq!(value["key"], json!(DEFAULT_KEY));
        for (path, content) in FILES {
            let written = std::fs::read_to_string(claude.join("skills").join(NAME).join(path));
            assert_eq!(written.unwrap(), *content);
        }
        let manifest: Value = serde_json::from_str(FILES[0].1).unwrap();
        assert_eq!(manifest["name"], json!(NAME));
        assert!(
            FILES
                .iter()
                .any(|(_, content)| content.contains(&format!("\"{ACTION}\"")))
        );

        let checked = serde_json::to_value(install(claude, None, true, false).unwrap()).unwrap();
        assert_eq!(checked["upToDate"], json!(true));
        let mod_file = claude.join("skills").join(NAME).join("hooks/gm.ts");
        std::fs::write(&mod_file, "old").unwrap();
        assert_eq!(
            install(claude, None, true, false).err().unwrap().code,
            "stale"
        );

        // A dry run changes nothing.
        install(claude, None, false, true).unwrap();
        assert_eq!(std::fs::read_to_string(&mod_file).unwrap(), "old");

        let removed = serde_json::to_value(remove(claude, false).unwrap()).unwrap();
        assert_eq!(removed["removed"], json!(true));
        assert!(!claude.join("skills").join(NAME).exists());
        let keybindings = std::fs::read_to_string(claude.join("keybindings.json")).unwrap();
        assert!(chords(&keybindings).is_empty());
    }

    #[test]
    fn remove_leaves_a_folder_that_isnt_the_mod() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("skills").join(NAME);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("SKILL.md"), "someone else's").unwrap();
        assert_eq!(remove(dir.path(), false).err().unwrap().code, "not_ours");
        assert!(folder.join("SKILL.md").exists());
    }
}
