//! AI release notes stored by the server: list releases, read one as Markdown.

use super::Ctx;
use super::semantic::encode_into;
use super::server::current_repo;
use super::tracker::selected_owner;
use crate::cli::{ReleaseCommand, ReleaseFeedArgs, ReleaseNotesArgs};
use crate::output::{GmError, Render, Result};
use crate::remote::{self, Config};
use serde::{Serialize, Serializer};
use serde_json::Value;
use std::fmt::Write;

const UNRELEASED: &str = "@unreleased";

pub struct Shown {
    value: Value,
    internal: bool,
}

impl Serialize for Shown {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        self.value.serialize(serializer)
    }
}

impl Render for Shown {
    fn text(&self) -> String {
        if self.value.get("facets").is_some() {
            feed_text(&self.value, self.internal)
        } else if self.value.get("releases").is_some() {
            list_text(&self.value)
        } else {
            notes_text(&self.value, self.internal)
        }
    }
}

fn s<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}

fn title(name: &str) -> &str {
    if name == UNRELEASED {
        "Unreleased"
    } else {
        name
    }
}

fn base(repo: &str) -> Result<String> {
    let (owner, name) = repo
        .split_once('/')
        .ok_or_else(|| GmError::usage("Name the repository with --repo owner/name."))?;
    if [owner, name]
        .iter()
        .any(|part| part.is_empty() || matches!(*part, "." | "..") || part.contains('/'))
    {
        return Err(GmError::usage(
            "Name the repository with --repo owner/name.",
        ));
    }
    let mut path = String::from("/repos/");
    encode_into(&mut path, owner);
    path.push('/');
    encode_into(&mut path, name);
    path.push_str("/release-notes");
    Ok(path)
}

/// `unreleased` (any case) names the default branch's work; anything else is a tag.
fn release_name(release: &str) -> &str {
    if release.eq_ignore_ascii_case("unreleased") {
        UNRELEASED
    } else {
        release
    }
}

fn list_text(value: &Value) -> String {
    let mut out = String::new();
    let releases = value["releases"].as_array().cloned().unwrap_or_default();
    if releases.is_empty() {
        out.push_str("No release notes yet.\n");
    }
    for release in &releases {
        let since = release["fromTag"]
            .as_str()
            .map(|tag| format!("  since {tag}"))
            .unwrap_or_default();
        let _ = writeln!(
            out,
            "{:<20} {:>3} entries  {}{}",
            title(s(release, "name")),
            release["entries"].as_u64().unwrap_or(0),
            s(release, "releasedAt").get(..10).unwrap_or(""),
            since
        );
    }
    let status = &value["status"];
    let _ = write!(out, "Status: {}", s(status, "state"));
    if let Some(at) = status["generatedAt"].as_str() {
        let _ = write!(out, ", updated {at}");
    }
    out
}

fn notes_text(value: &Value, internal: bool) -> String {
    let release = &value["release"];
    let mut out = format!("# {}\n", title(s(release, "name")));
    match release["fromTag"].as_str() {
        Some(tag) => {
            let _ = writeln!(out, "Changes since {tag}.");
        }
        None => out.push_str("Everything up to this release.\n"),
    }
    if let Some(intro) = release["intro"].as_str().filter(|intro| !intro.is_empty()) {
        let _ = write!(out, "\n{intro}\n");
    }
    let entries = value["entries"].as_array().cloned().unwrap_or_default();
    let mut hidden = 0;
    for (category, heading) in [
        ("feature", "New"),
        ("fix", "Fixed"),
        ("improvement", "Improved"),
        ("internal", "Internal"),
    ] {
        let group: Vec<&Value> = entries
            .iter()
            .filter(|entry| s(entry, "category") == category)
            .collect();
        if group.is_empty() {
            continue;
        }
        if category == "internal" && !internal {
            hidden = group.len();
            continue;
        }
        let _ = write!(out, "\n## {heading}\n");
        for entry in group {
            let mut refs: Vec<String> = Vec::new();
            if let Some(key) = entry["issue"]["key"].as_str() {
                refs.push(key.to_string());
            }
            for oid in entry["commits"].as_array().into_iter().flatten().take(3) {
                refs.push(oid.as_str().unwrap_or("").chars().take(7).collect());
            }
            let _ = write!(out, "- **{}**", s(entry, "title"));
            if !s(entry, "summary").is_empty() {
                let _ = write!(out, " — {}", s(entry, "summary"));
            }
            let _ = writeln!(out, " ({})", refs.join(", "));
        }
    }
    if entries.is_empty() {
        out.push_str("\nNo entries you can see in this release.\n");
    }
    if hidden > 0 {
        let _ = write!(
            out,
            "\n{hidden} internal entries hidden; show them with --internal.\n"
        );
    }
    out.pop();
    out
}

/// The feed query: `--team` first, then the words given.
fn feed_query(args: &ReleaseFeedArgs) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(team) = &args.team {
        parts.push(format!("team:{team}"));
    }
    parts.extend(args.query.iter().cloned());
    if !args.internal && !parts.iter().any(|part| part.starts_with("type:")) {
        parts.push("-type:internal".to_string());
    }
    parts.join(" ")
}

fn feed_text(value: &Value, internal: bool) -> String {
    let mut out = format!(
        "# Release notes: {}\n",
        value["owner"]["displayName"].as_str().unwrap_or("")
    );
    let unknown: Vec<&str> = value["query"]["unknown"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    if !unknown.is_empty() {
        let _ = writeln!(out, "Not understood: {}", unknown.join(" "));
    }
    let entries = value["entries"].as_array().cloned().unwrap_or_default();
    if entries.is_empty() {
        out.push_str("\nNothing shipped matches.\n");
    }
    let mut day = String::new();
    for entry in &entries {
        let shipped = s(entry, "shippedAt").get(..10).unwrap_or("");
        if shipped != day {
            day = shipped.to_string();
            let _ = write!(out, "\n## {day}\n");
        }
        let mut refs: Vec<String> = Vec::new();
        if let Some(key) = entry["issue"]["key"].as_str() {
            refs.push(key.to_string());
        }
        for repo in entry["repos"].as_array().into_iter().flatten() {
            let releases: Vec<&str> = repo["releases"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(|r| if r == UNRELEASED { "unreleased" } else { r })
                .collect();
            refs.push(format!(
                "{}/{} {}",
                s(repo, "owner"),
                s(repo, "name"),
                releases.join(", ")
            ));
        }
        let _ = write!(
            out,
            "- [{}] **{}**",
            s(entry, "category"),
            s(entry, "title")
        );
        if !s(entry, "summary").is_empty() {
            let _ = write!(out, " — {}", s(entry, "summary"));
        }
        let _ = writeln!(out, " ({})", refs.join("; "));
    }
    if value["truncated"].as_bool().unwrap_or(false) {
        let _ = write!(
            out,
            "\nShowing the newest {}; narrow the query for older work.\n",
            entries.len()
        );
    }
    if !internal {
        out.push_str("\nInternal entries are left out; include them with --internal.\n");
    }
    out.pop();
    out
}

pub fn run(ctx: &Ctx, command: &ReleaseCommand) -> Result<Shown> {
    if let ReleaseCommand::Feed(args) = command {
        let config = Config::load();
        let owner = selected_owner(&config, args.owner.clone())?;
        let mut path = String::from("/tracker/");
        encode_into(&mut path, &owner);
        path.push_str("/release-notes?q=");
        encode_into(&mut path, &feed_query(args));
        let value = remote::api(&config, "GET", &path, None)?;
        return Ok(Shown {
            value,
            internal: args.internal,
        });
    }
    let (repo, notes): (&Option<String>, Option<&ReleaseNotesArgs>) = match command {
        ReleaseCommand::List { repo } => (repo, None),
        ReleaseCommand::Notes(args) => (&args.repo, Some(args)),
        ReleaseCommand::Feed(_) => unreachable!(),
    };
    let repo = match repo {
        Some(repo) => repo.clone(),
        None => current_repo(ctx)?,
    };
    let base = base(&repo)?;
    let config = Config::load();
    let index = remote::api(&config, "GET", &base, None)?;
    let Some(args) = notes else {
        return Ok(Shown {
            value: index,
            internal: false,
        });
    };
    let name = match args.release.as_deref() {
        Some(release) => release_name(release).to_string(),
        None => {
            let releases = index["releases"].as_array().cloned().unwrap_or_default();
            let pick = releases
                .iter()
                .find(|release| release["entries"].as_u64().unwrap_or(0) > 0)
                .or(releases.first())
                .ok_or_else(|| GmError::usage("This repository has no release notes yet."))?;
            s(pick, "name").to_string()
        }
    };
    let mut path = format!("{base}/release?name=");
    encode_into(&mut path, &name);
    let value = remote::api(&config, "GET", &path, None)?;
    Ok(Shown {
        value,
        internal: args.internal,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn paths_encode_owner_name_and_release() {
        assert_eq!(
            base("orbit/engine").unwrap(),
            "/repos/orbit/engine/release-notes"
        );
        assert!(base("orbit").is_err());
        assert!(base("orbit/../x").is_err());
        let mut path = String::new();
        encode_into(&mut path, release_name("release/1.0&x=y"));
        assert_eq!(path, "release%2F1.0%26x%3Dy");
        assert_eq!(release_name("Unreleased"), UNRELEASED);
    }

    #[test]
    fn notes_render_as_markdown_grouped_by_category() {
        let value = json!({
            "release": {"name": "v2", "fromTag": "v1", "intro": "Faster search."},
            "entries": [
                {"category": "internal", "title": "Bump deps", "summary": "", "issue": null, "commits": ["abcdef0123"]},
                {"category": "fix", "title": "Fix ranking", "summary": "Results sort by relevance.", "issue": {"key": "ENG-2"}, "commits": ["1234567890", "2345678901"]},
                {"category": "feature", "title": "Add search", "summary": "Find anything.", "issue": null, "commits": ["9876543210"]}
            ]
        });
        assert_eq!(
            notes_text(&value, false),
            "# v2\nChanges since v1.\n\nFaster search.\n\n## New\n- **Add search** — Find anything. (9876543)\n\n## Fixed\n- **Fix ranking** — Results sort by relevance. (ENG-2, 1234567, 2345678)\n\n1 internal entries hidden; show them with --internal."
        );
        assert!(notes_text(&value, true).contains("## Internal\n- **Bump deps** (abcdef0)"));
    }

    #[test]
    fn feed_query_adds_team_and_hides_internal_unless_asked() {
        use crate::cli::{Cli, Command};
        use clap::Parser;
        let parse = |argv: &[&str]| {
            let mut full = vec!["gm", "release", "feed"];
            full.extend_from_slice(argv);
            match Cli::try_parse_from(full).unwrap().command.unwrap() {
                Command::Release(ReleaseCommand::Feed(args)) => feed_query(&args),
                _ => unreachable!(),
            }
        };
        assert_eq!(
            parse(&["--team", "CORE", "since:30d", "repo:engine"]),
            "team:CORE since:30d repo:engine -type:internal"
        );
        assert_eq!(parse(&["--internal"]), "");
        assert_eq!(parse(&["type:internal"]), "type:internal");
    }

    #[test]
    fn feed_renders_days_with_where_it_shipped() {
        let value = json!({
            "owner": {"displayName": "Orbit Labs"},
            "query": {"unknown": ["color:red"]},
            "truncated": false,
            "facets": {},
            "entries": [
                {"category": "fix", "title": "Fix rollback", "summary": "Rollbacks finish.", "shippedAt": "2026-09-25T00:00:00Z", "issue": {"key": "OPS-3"},
                 "repos": [{"owner": "orbit", "name": "engine", "releases": ["v2", "@unreleased"]}]}
            ]
        });
        assert_eq!(
            feed_text(&value, true),
            "# Release notes: Orbit Labs\nNot understood: color:red\n\n## 2026-09-25\n- [fix] **Fix rollback** — Rollbacks finish. (OPS-3; orbit/engine v2, unreleased)"
        );
    }

    #[test]
    fn list_shows_unreleased_by_name_and_status() {
        let value = json!({
            "status": {"state": "ready", "generatedAt": "2026-10-02T00:00:00Z"},
            "releases": [
                {"name": "@unreleased", "entries": 3, "releasedAt": "2026-10-02T00:00:00Z", "fromTag": "v1"},
                {"name": "v1", "entries": 2, "releasedAt": "2026-09-01T00:00:00Z", "fromTag": null}
            ]
        });
        let text = list_text(&value);
        assert!(text.starts_with("Unreleased             3 entries  2026-10-02  since v1\nv1"));
        assert!(text.ends_with("Status: ready, updated 2026-10-02T00:00:00Z"));
    }
}
