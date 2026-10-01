//! The command manifest: clap's definitions plus what clap doesn't know
//! (git equivalents, search keywords, output shape, examples). Like `cf`,
//! one manifest drives `--help`, `gm cli search`, `gm cli commands` and
//! `gm schema`.

use crate::model;
use crate::output::{GmError, Render, Result};
use clap::CommandFactory;
use schemars::JsonSchema;
use serde::Serialize;
use serde_json::{Value, json};

#[derive(Clone, Copy)]
pub enum Out {
    /// A JSON Schema generated from the output type.
    Typed(fn() -> Value),
    /// JSON shape described in words (server passthrough commands).
    Other(&'static str),
}

const OP: Out = Out::Typed(schema_of::<model::OpResult>);

pub struct Meta {
    pub path: &'static str,
    pub git: &'static str,
    pub keywords: &'static str,
    pub mutates: bool,
    pub out: Out,
    pub examples: &'static [&'static str],
}

macro_rules! meta {
    ($path:expr, git: $git:expr, kw: $kw:expr, mutates: $m:expr, out: $out:expr, ex: [$($ex:expr),* $(,)?]) => {
        Meta { path: $path, git: $git, keywords: $kw, mutates: $m, out: $out, examples: &[$($ex),*] }
    };
}

pub const COMMANDS: &[Meta] = &[
    meta!("status", git: "git status", kw: "what changed working copy modified files uncommitted dirty state where am i", mutates: false, out: Out::Typed(schema_of::<model::Status>), ex: ["gm status"]),
    meta!("log", git: "git log --oneline --graph", kw: "history list changes commits recent graph unpushed", mutates: false, out: Out::Typed(schema_of::<model::Log>), ex: ["gm log", "gm log -r all -n 20", "gm log -r trunk..@"]),
    meta!("show", git: "git show", kw: "inspect view change commit details patch", mutates: false, out: Out::Typed(schema_of::<model::Diff>), ex: ["gm show", "gm show @- --stat"]),
    meta!("diff", git: "git diff", kw: "difference patch compare changes lines edits", mutates: false, out: Out::Typed(schema_of::<model::Diff>), ex: ["gm diff", "gm diff --stat", "gm diff --from trunk --to @", "gm diff src/"]),
    meta!("describe", git: "git commit --amend -m (message only)", kw: "message rename reword edit description amend commit message title", mutates: true, out: OP, ex: ["gm describe -m \"Fix login redirect\"", "gm describe @- -m \"Better message\""]),
    meta!("new", git: "git switch -c / git stash / git merge --no-commit", kw: "start begin fresh empty change branch off checkout switch merge stash", mutates: true, out: OP, ex: ["gm new", "gm new trunk -m \"Try another approach\"", "gm new kxyz lmno"]),
    meta!("commit", git: "git commit -am", kw: "save checkpoint snapshot record work commit finish done message", mutates: true, out: OP, ex: ["gm commit -m \"Add retry to fetch\"", "gm commit -m \"Only the docs\" docs/"]),
    meta!("squash", git: "git commit --amend / git rebase -i fixup", kw: "amend fold fixup combine merge into parent meld absorb", mutates: true, out: OP, ex: ["gm squash", "gm squash -r kxyz --into lmno", "gm squash src/a.rs"]),
    meta!("split", git: "git add -p && git commit (partial)", kw: "separate break apart divide partial files into two changes", mutates: true, out: OP, ex: ["gm split -m \"Extract parser\" src/parser.rs"]),
    meta!("edit", git: "git checkout <commit> (to amend in place)", kw: "go to switch checkout revisit modify older change in place", mutates: true, out: OP, ex: ["gm edit kxyz"]),
    meta!("abandon", git: "git reset --hard HEAD~ / git rebase --onto (drop)", kw: "drop delete discard remove throw away change", mutates: true, out: OP, ex: ["gm abandon", "gm abandon kxyz"]),
    meta!("restore", git: "git restore / git checkout -- <path> / git reset --hard", kw: "discard revert file reset undo edits throw away changes clean", mutates: true, out: OP, ex: ["gm restore", "gm restore src/main.rs", "gm restore --from trunk Cargo.lock"]),
    meta!("rebase", git: "git rebase", kw: "move onto update base reparent stack", mutates: true, out: OP, ex: ["gm rebase", "gm rebase -s kxyz -d trunk", "gm rebase -r kxyz -d lmno"]),
    meta!("backout", git: "git revert", kw: "revert reverse undo a change inverse", mutates: true, out: OP, ex: ["gm backout -r kxyz"]),
    meta!("duplicate", git: "git cherry-pick", kw: "cherry pick copy apply change from elsewhere", mutates: true, out: OP, ex: ["gm duplicate kxyz", "gm duplicate kxyz -d trunk"]),
    meta!("undo", git: "git reflog + git reset (roughly)", kw: "undo revert last operation mistake oops go back", mutates: true, out: OP, ex: ["gm undo"]),
    meta!("op log", git: "git reflog", kw: "operation history undo log what did i do", mutates: false, out: Out::Typed(schema_of::<crate::commands::local::OpLog>), ex: ["gm op log -n 5"]),
    meta!("op restore", git: "git reset --hard <reflog entry>", kw: "restore operation go back to time travel", mutates: true, out: OP, ex: ["gm op restore 3fa2c1d09b7e"]),
    meta!("bookmark list", git: "git branch -a", kw: "branches list names refs", mutates: false, out: Out::Typed(schema_of::<crate::commands::local::Bookmarks>), ex: ["gm bookmark list"]),
    meta!("bookmark set", git: "git branch -f", kw: "create branch move branch name tag point", mutates: true, out: OP, ex: ["gm bookmark set feature-x", "gm bookmark set feature-x -r @-"]),
    meta!("bookmark delete", git: "git branch -D / git push --delete", kw: "delete remove branch", mutates: true, out: OP, ex: ["gm bookmark delete feature-x", "gm bookmark delete feature-x --remote"]),
    meta!("file show", git: "git show <rev>:<path>", kw: "cat read print file contents at revision", mutates: false, out: Out::Typed(schema_of::<crate::commands::local::FileShow>), ex: ["gm file show src/main.rs -r trunk"]),
    meta!("file list", git: "git ls-tree -r --name-only", kw: "ls files tree list paths", mutates: false, out: Out::Typed(schema_of::<crate::commands::local::FileList>), ex: ["gm file list", "gm file list src -r trunk"]),
    meta!("init", git: "git init (then adopt)", kw: "initialize start adopt existing repository setup", mutates: true, out: OP, ex: ["gm init"]),
    meta!("clone", git: "git clone", kw: "download copy checkout repository get code", mutates: true, out: Out::Typed(schema_of::<crate::commands::network::Cloned>), ex: ["gm clone orbit/engine", "gm clone orbit/engine ./engine"]),
    meta!("fetch", git: "git fetch", kw: "download remote update refresh get latest", mutates: true, out: Out::Other("{trunk:{before,after}|null,updated_refs:[name]}"), ex: ["gm fetch"]),
    meta!("sync", git: "git pull --rebase", kw: "pull update rebase onto latest trunk catch up refresh", mutates: true, out: OP, ex: ["gm sync"]),
    meta!("push", git: "git push", kw: "upload publish land ship merge deploy send pull request pr", mutates: true, out: Out::Typed(schema_of::<crate::commands::network::Pushed>), ex: ["gm push", "gm push --sync", "gm push -b feature-x"]),
    meta!("auth login", git: "git credential approve", kw: "login sign in authenticate token persona credentials", mutates: true, out: Out::Other("{server,user:{slug,displayName},scope}"), ex: ["gm auth login --persona jun", "gm auth login --token gmx_..."]),
    meta!("auth status", git: "", kw: "whoami who am i signed in user account", mutates: false, out: Out::Other("{server,user|null}"), ex: ["gm auth status"]),
    meta!("auth logout", git: "git credential reject", kw: "logout sign out forget token", mutates: true, out: Out::Other("{server,signed_out}"), ex: ["gm auth logout"]),
    meta!("repo list", git: "", kw: "repositories list remote server projects", mutates: false, out: Out::Other("{repos:[RepoSummary]}"), ex: ["gm repo list"]),
    meta!("repo create", git: "", kw: "new repository create remote server import", mutates: true, out: Out::Other("RepoSummary"), ex: ["gm repo create demo", "gm repo create engine --owner orbit --import https://github.com/lukeed/clsx"]),
    meta!("repo view", git: "git remote show origin", kw: "repository info details branches clone url", mutates: false, out: Out::Other("RepoDetail"), ex: ["gm repo view", "gm repo view orbit/engine"]),
    meta!("repo delete", git: "", kw: "delete remove repository server", mutates: true, out: Out::Other("{deleted}"), ex: ["gm repo delete jun/demo --yes"]),
    meta!("api", git: "", kw: "raw http api request endpoint json", mutates: true, out: Out::Other("the API's JSON response"), ex: ["gm api GET /repos", "gm api POST /repos -d '{\"owner\":\"jun\",\"name\":\"x\",\"visibility\":\"private\"}'"]),
    meta!("cli search", git: "", kw: "find command help discover how do i", mutates: false, out: Out::Typed(schema_of::<Vec<Hit>>), ex: ["gm cli search \"undo my last commit\""]),
    meta!("cli guide", git: "", kw: "workflow guide tutorial how to use agents", mutates: false, out: Out::Other("markdown text"), ex: ["gm cli guide"]),
    meta!("cli commands", git: "", kw: "manifest all commands list reference", mutates: false, out: Out::Other("{commands:[ManifestEntry]}"), ex: ["gm cli commands"]),
    meta!("schema", git: "", kw: "schema inputs outputs json shape arguments", mutates: false, out: Out::Other("{command,usage,arguments,options,output}"), ex: ["gm schema push", "gm schema bookmark set"]),
];

pub fn find(path: &str) -> Option<&'static Meta> {
    COMMANDS.iter().find(|m| m.path == path)
}

#[derive(Serialize, JsonSchema, Clone)]
pub struct Param {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short: Option<char>,
    pub required: bool,
    pub multiple: bool,
    /// Takes no value (a switch).
    pub flag: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub choices: Vec<String>,
    pub description: String,
}

#[derive(Serialize, JsonSchema, Clone)]
pub struct Entry {
    pub command: String,
    pub summary: String,
    pub usage: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub git: String,
    pub mutates: bool,
    pub arguments: Vec<Param>,
    pub options: Vec<Param>,
    pub examples: Vec<String>,
}

fn param(arg: &clap::Arg) -> Param {
    let flag = matches!(
        arg.get_action(),
        clap::ArgAction::SetTrue | clap::ArgAction::SetFalse | clap::ArgAction::Count
    );
    Param {
        name: arg
            .get_long()
            .map(|l| format!("--{l}"))
            .unwrap_or_else(|| arg.get_id().to_string()),
        short: arg.get_short(),
        required: arg.is_required_set(),
        multiple: matches!(arg.get_action(), clap::ArgAction::Append)
            || arg
                .get_num_args()
                .map(|n| n.max_values() > 1)
                .unwrap_or(false),
        flag,
        default: if flag {
            None
        } else {
            arg.get_default_values()
                .first()
                .map(|v| v.to_string_lossy().into_owned())
        },
        choices: if flag {
            Vec::new()
        } else {
            arg.get_possible_values()
                .iter()
                .map(|v| v.get_name().to_string())
                .collect()
        },
        description: arg.get_help().map(|h| h.to_string()).unwrap_or_default(),
    }
}

/// Every leaf command, in definition order.
pub fn manifest() -> Vec<Entry> {
    fn walk(cmd: &clap::Command, prefix: &str, out: &mut Vec<Entry>) {
        for sub in cmd.get_subcommands() {
            let path = if prefix.is_empty() {
                sub.get_name().to_string()
            } else {
                format!("{prefix} {}", sub.get_name())
            };
            if sub.has_subcommands() {
                walk(sub, &path, out);
                continue;
            }
            let meta = find(&path);
            let mut usage_cmd = sub.clone().bin_name(format!("gm {path}"));
            let usage = usage_cmd
                .render_usage()
                .to_string()
                .trim_start_matches("Usage: ")
                .to_string();
            let args: Vec<&clap::Arg> = sub
                .get_arguments()
                .filter(|a| !a.is_global_set() && a.get_id() != "help")
                .collect();
            out.push(Entry {
                command: format!("gm {path}"),
                summary: sub.get_about().map(|s| s.to_string()).unwrap_or_default(),
                usage,
                aliases: sub.get_visible_aliases().map(str::to_string).collect(),
                git: meta.map(|m| m.git.to_string()).unwrap_or_default(),
                mutates: meta.map(|m| m.mutates).unwrap_or(false),
                arguments: args
                    .iter()
                    .filter(|a| a.is_positional())
                    .map(|a| param(a))
                    .collect(),
                options: args
                    .iter()
                    .filter(|a| !a.is_positional())
                    .map(|a| param(a))
                    .collect(),
                examples: meta
                    .map(|m| m.examples.iter().map(|e| e.to_string()).collect())
                    .unwrap_or_default(),
            });
        }
    }
    let mut out = Vec::new();
    walk(&crate::cli::Cli::command(), "", &mut out);
    out
}

/// Global flags every command accepts.
pub fn global_options() -> Vec<Param> {
    crate::cli::Cli::command()
        .get_arguments()
        .filter(|a| a.is_global_set())
        .map(param)
        .collect()
}

// ---- search --------------------------------------------------------------

fn stem(word: &str) -> String {
    let w = word.to_lowercase();
    for suffix in ["ing", "ed", "es", "s"] {
        if w.len() > suffix.len() + 2 && w.ends_with(suffix) {
            return w[..w.len() - suffix.len()].to_string();
        }
    }
    w
}

fn tokens(text: &str) -> Vec<String> {
    const STOP: &[&str] = &[
        "the", "a", "an", "to", "my", "i", "of", "in", "on", "and", "or", "for", "it", "is", "do",
        "how", "with", "from", "into", "this", "that", "all", "me", "want",
    ];
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty() && !STOP.contains(&w.to_lowercase().as_str()))
        .map(stem)
        .collect()
}

#[derive(Serialize, JsonSchema)]
pub struct Hit {
    pub command: String,
    pub summary: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub git: String,
}

#[derive(Serialize)]
#[serde(transparent)]
pub struct Hits(pub Vec<Hit>);

impl Render for Hits {
    fn text(&self) -> String {
        self.0
            .iter()
            .map(|h| {
                let git = if h.git.is_empty() {
                    String::new()
                } else {
                    format!("  (git: {})", h.git)
                };
                format!("{:<22} {}{}", h.command, h.summary, git)
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Rank commands for a plain-language query (BM25-style weights over the
/// command name, keywords, git equivalent and description).
pub fn search(query: &str) -> Vec<Hit> {
    let entries = manifest();
    let docs: Vec<(Vec<String>, Vec<String>, Vec<String>)> = entries
        .iter()
        .map(|e| {
            let path = e.command.trim_start_matches("gm ");
            let meta = find(path);
            let mut name = tokens(path);
            name.extend(e.aliases.iter().map(|a| stem(a)));
            let keywords = tokens(&format!(
                "{} {}",
                meta.map(|m| m.keywords).unwrap_or(""),
                meta.map(|m| m.git).unwrap_or("")
            ));
            let body = tokens(&format!(
                "{} {}",
                e.summary,
                e.options
                    .iter()
                    .map(|o| o.description.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            ));
            (name, keywords, body)
        })
        .collect();
    let n = docs.len() as f64;
    let query = tokens(query);
    let mut scored: Vec<(f64, usize)> = docs
        .iter()
        .enumerate()
        .map(|(i, (name, keywords, body))| {
            let mut score = 0.0;
            for term in &query {
                let df = docs
                    .iter()
                    .filter(|(a, b, c)| a.contains(term) || b.contains(term) || c.contains(term))
                    .count() as f64;
                if df == 0.0 {
                    continue;
                }
                let idf = ((n - df + 0.5) / (df + 0.5) + 1.0).ln();
                let tf = 3.0 * name.iter().filter(|t| *t == term).count() as f64
                    + 2.0 * keywords.iter().filter(|t| *t == term).count().min(2) as f64
                    + body.iter().filter(|t| *t == term).count().min(2) as f64;
                score += idf * tf / (tf + 1.2);
            }
            (score, i)
        })
        .filter(|(score, _)| *score > 0.0)
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap().then(a.1.cmp(&b.1)));
    scored
        .into_iter()
        .take(5)
        .map(|(_, i)| Hit {
            command: entries[i].command.clone(),
            summary: entries[i].summary.clone(),
            git: entries[i].git.clone(),
        })
        .collect()
}

// ---- schema ----------------------------------------------------------------

#[derive(Serialize)]
pub struct Schema {
    #[serde(flatten)]
    pub entry: Entry,
    pub global_options: Vec<Param>,
    pub output: Value,
}

impl Render for Schema {
    fn text(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_default()
    }
}

fn schema_of<T: JsonSchema>() -> Value {
    serde_json::to_value(schemars::schema_for!(T)).unwrap_or(Value::Null)
}

pub fn schema(words: &[String]) -> Result<Schema> {
    let mut path = words.join(" ");
    path = path.trim_start_matches("gm ").to_string();
    let entries = manifest();
    let entry = entries
        .iter()
        .find(|e| {
            e.command == format!("gm {path}")
                || e.aliases
                    .iter()
                    .any(|a| format!("gm {a}") == format!("gm {path}"))
        })
        .cloned()
        .ok_or_else(|| {
            GmError::not_found("unknown_command", format!("No command `gm {path}`."))
                .hint(format!("Try `gm cli search \"{path}\"`."))
        })?;
    let out = find(entry.command.trim_start_matches("gm "))
        .map(|m| m.out)
        .unwrap_or(Out::Other("unspecified"));
    let output = match out {
        Out::Typed(schema) => schema(),
        Out::Other(shape) => json!({ "description": shape }),
    };
    Ok(Schema {
        entry,
        global_options: global_options(),
        output,
    })
}

// ---- guide ----------------------------------------------------------------

pub const GUIDE: &str = r#"# gm: working with Gitmatrix

gm is change-based (like jj), not commit-and-stage based (like git).

## The model
- Your files are always in a change called `@` (the working copy). Every gm
  command snapshots the files on disk into `@` first. There is no staging
  area and nothing is ever "uncommitted".
- Every change has a **change id** (letters k-z, e.g. `kxmqvtyl`) that stays
  the same when the change is rewritten. Commit ids (hex) change on every
  rewrite. Prefer change ids when you refer to changes.
- Rewriting a change automatically rebases everything on top of it.
- Every command is an operation; `gm undo` reverses the last one (repeat to go
  further back). Experiment freely.
- `trunk` is the server's main line. Changes in trunk are immutable.
- There are no pull requests. `gm push` lands your changes on trunk.

## The loop (commit early, commit often)
    gm status                      # where am I, what changed
    # ...edit files...
    gm commit -m "Add retry to fetch"   # describe @, start a fresh @ on top
    # ...edit more...
    gm commit -m "Cover retry in tests"
    gm push --sync                 # rebase onto latest trunk, then land it

`gm commit` is cheap: make one per logical step. To fix an earlier step,
edit files and run `gm squash --into <change id>`, or `gm edit <change id>`
then `gm new` to come back on top.

## Revisions
`@` working copy · `@-` its parent · `@--` grandparent · `trunk` · a change id
prefix (`kxmq`) · a commit id prefix (`1a2b3c`) · a bookmark name.
Ranges for `gm log -r`: `trunk..@`, `all`.

## Everyday commands (git equivalent)
- `gm status` (git status) · `gm diff` (git diff) · `gm log` (git log)
- `gm commit -m` (git commit -am) · `gm describe -m` (amend the message)
- `gm new` (start a fresh change; also how you "stash") · `gm edit <rev>`
- `gm squash` (amend/fixup) · `gm split -m msg <paths>` (partial commit)
- `gm restore [paths]` (discard edits) · `gm abandon <rev>` (drop a change)
- `gm rebase -d trunk` · `gm backout -r <rev>` (revert) · `gm duplicate <rev>` (cherry-pick)
- `gm sync` (pull --rebase) · `gm push` (land on trunk) · `gm push -b name` (push a bookmark)
- `gm undo` · `gm op log`

## Conflicts
Rebases never stop halfway. A conflicted change gets conflict markers in its
files and shows up in `gm status` under `conflicts`. Edit the markers away
in `@` (or `gm edit <change>` first); the next gm command records the fix.
`gm push` refuses changes that still have conflicts.

## For agents
- Output is compact JSON when an agent or a pipe is detected; `-o text` for prose.
- Errors are JSON on stderr: `{"error":{"code","message","hint"}}`. Exit codes:
  1 error, 2 bad usage, 3 not found, 4 needs a decision (conflict, behind
  trunk), 5 auth.
- `gm cli search "<task>"` finds commands; `gm schema <command>` gives exact
  inputs and the output JSON Schema. Every mutating command takes `--dry-run`.
- Sign in once: `gm auth login --persona <name>` (dev) or `--token gmx_…`.
"#;

#[derive(Serialize)]
pub struct Guide {
    pub guide: &'static str,
}

impl Render for Guide {
    fn text(&self) -> String {
        self.guide.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_command_has_metadata_and_every_metadata_has_a_command() {
        let commands: Vec<String> = manifest()
            .iter()
            .map(|e| e.command.trim_start_matches("gm ").to_string())
            .collect();
        for c in &commands {
            assert!(find(c).is_some(), "no metadata for `gm {c}`");
        }
        for m in COMMANDS {
            assert!(
                commands.iter().any(|c| c == m.path),
                "metadata for unknown command `gm {}`",
                m.path
            );
        }
    }

    #[test]
    fn search_finds_the_obvious_command() {
        let top = |q: &str| {
            search(q)
                .first()
                .map(|h| h.command.clone())
                .unwrap_or_default()
        };
        assert_eq!(top("undo the last thing I did"), "gm undo");
        assert_eq!(top("cherry-pick a commit"), "gm duplicate");
        assert_eq!(top("revert a change"), "gm backout");
        assert_eq!(top("save my work with a message"), "gm commit");
        assert_eq!(top("pull latest changes"), "gm sync");
        assert_eq!(top("create a branch"), "gm bookmark set");
        assert_eq!(top("discard my edits to a file"), "gm restore");
        assert_eq!(top("open a pull request"), "gm push");
    }
}
