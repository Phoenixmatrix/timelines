//! AI release notes stored by the server: list releases, read one as Markdown.

use super::Ctx;
use super::semantic::encode_into;
use super::server::current_repo;
use super::tracker::selected_space;
use crate::cli::{ReleaseCommand, ReleaseFeedArgs, ReleaseNotesArgs};
use crate::output::{GmError, Render, Result};
use crate::remote::{self, Config};
use serde::{Serialize, Serializer};
use serde_json::Value;
use std::fmt::Write;

const DAILY_RELEASE_PREFIX: &str = "@day:";

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

/// The timeline an entry's work landed with: its branch, else the landing merge.
fn landed(entry: &Value) -> Option<String> {
    let timeline = entry["timeline"].as_object()?;
    let label = match timeline.get("branch").and_then(Value::as_str) {
        Some(branch) => branch.to_string(),
        None => format!(
            "merge {}",
            timeline
                .get("landing")
                .and_then(Value::as_str)
                .unwrap_or("")
                .chars()
                .take(7)
                .collect::<String>()
        ),
    };
    Some(format!("landed with {label}"))
}

fn title(name: &str, kind: &str) -> String {
    if kind == "daily" {
        format!(
            "{} UTC",
            name.strip_prefix(DAILY_RELEASE_PREFIX).unwrap_or(name)
        )
    } else {
        format!("Tag {name}")
    }
}

fn base(repo: &str) -> Result<String> {
    let (space, name) = repo
        .split_once('/')
        .ok_or_else(|| GmError::usage("Name the repository with --repo space/name."))?;
    if [space, name]
        .iter()
        .any(|part| part.is_empty() || matches!(*part, "." | "..") || part.contains('/'))
    {
        return Err(GmError::usage(
            "Name the repository with --repo space/name.",
        ));
    }
    let mut path = String::from("/repos/");
    encode_into(&mut path, space);
    path.push('/');
    encode_into(&mut path, name);
    path.push_str("/release-notes");
    Ok(path)
}

/// Only an exact `day:YYYY-MM-DD` selector names a daily update; tags stay literal.
fn release_name(release: &str) -> std::borrow::Cow<'_, str> {
    let bytes = release.as_bytes();
    if bytes.len() == 14
        && bytes.starts_with(b"day:")
        && bytes[8] == b'-'
        && bytes[11] == b'-'
        && bytes[4..8]
            .iter()
            .chain(&bytes[9..11])
            .chain(&bytes[12..14])
            .all(u8::is_ascii_digit)
    {
        format!("@{release}").into()
    } else {
        release.into()
    }
}

fn default_release(index: &Value) -> Option<&Value> {
    let releases = index["releases"].as_array()?;
    releases
        .iter()
        .filter(|release| s(release, "kind") == "daily")
        .max_by_key(|release| {
            (
                release["entries"].as_u64().unwrap_or(0) > 0,
                s(release, "name"),
            )
        })
        .or_else(|| {
            releases
                .iter()
                .filter(|release| {
                    s(release, "kind") == "tag" && release["entries"].as_u64().unwrap_or(0) > 0
                })
                .max_by_key(|release| s(release, "lastCommitAt"))
                .or_else(|| releases.iter().find(|release| s(release, "kind") == "tag"))
        })
}

fn list_text(value: &Value) -> String {
    let mut out = String::new();
    let mut releases: Vec<&Value> = value["releases"].as_array().into_iter().flatten().collect();
    releases.sort_by(|a, b| {
        (s(a, "kind") != "daily")
            .cmp(&(s(b, "kind") != "daily"))
            .then_with(|| s(b, "lastCommitAt").cmp(s(a, "lastCommitAt")))
    });
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
            "{:<20} {:>3} entries  last commit {}{}",
            title(s(release, "name"), s(release, "kind")),
            release["entries"].as_u64().unwrap_or(0),
            s(release, "lastCommitAt"),
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
    let mut out = format!("# {}\n", title(s(release, "name"), s(release, "kind")));
    if s(release, "kind") == "daily" {
        out.push_str("Default-branch code updates grouped by Git committer date (UTC).\n");
    } else {
        match release["fromTag"].as_str() {
            Some(tag) => {
                let _ = writeln!(out, "Code changes since {tag}.");
            }
            None => out.push_str("Code changes up to this tag.\n"),
        }
    }
    if let Some(at) = release["lastCommitAt"].as_str() {
        let _ = writeln!(out, "Last commit: {at}.");
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
            refs.extend(landed(entry));
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
        value["space"]["displayName"].as_str().unwrap_or("")
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
        out.push_str("\nNo code updates match.\n");
    }
    let mut day = String::new();
    for entry in &entries {
        let committed = s(entry, "lastCommitAt").get(..10).unwrap_or("");
        if committed != day {
            day = committed.to_string();
            let _ = write!(out, "\n## {day} UTC\n");
        }
        let mut refs: Vec<String> = Vec::new();
        if let Some(key) = entry["issue"]["key"].as_str() {
            refs.push(key.to_string());
        }
        refs.extend(landed(entry));
        for repo in entry["repos"].as_array().into_iter().flatten() {
            let releases: Vec<String> = repo["releases"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(|name| {
                    title(
                        name,
                        if name.starts_with(DAILY_RELEASE_PREFIX) {
                            "daily"
                        } else {
                            "tag"
                        },
                    )
                })
                .collect();
            refs.push(format!(
                "{}/{} {}",
                s(repo, "space"),
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
        let space = selected_space(&config, args.space.clone())?;
        let mut path = String::from("/tracker/");
        encode_into(&mut path, &space);
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
        Some(release) => release_name(release).into_owned(),
        None => {
            let pick = default_release(&index)
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
    fn paths_encode_space_name_and_release() {
        assert_eq!(
            base("orbit/engine").unwrap(),
            "/repos/orbit/engine/release-notes"
        );
        assert!(base("orbit").is_err());
        assert!(base("orbit/../x").is_err());
        let mut path = String::new();
        encode_into(&mut path, &release_name("release/1.0&x=y"));
        assert_eq!(path, "release%2F1.0%26x%3Dy");
        assert_eq!(release_name("day:2026-10-02"), "@day:2026-10-02");
        assert_eq!(
            release_name("day:2026-10-02-preview"),
            "day:2026-10-02-preview"
        );
        assert_eq!(release_name("day:2026-1-02"), "day:2026-1-02");
    }

    #[test]
    fn notes_render_as_markdown_grouped_by_category() {
        let value = json!({
            "release": {"name": "v2", "kind": "tag", "fromTag": "v1", "intro": "Faster search.", "lastCommitAt": "2026-10-02T12:00:00Z"},
            "entries": [
                {"category": "internal", "title": "Bump deps", "summary": "", "issue": null, "commits": ["abcdef0123"]},
                {"category": "fix", "title": "Fix ranking", "summary": "Results sort by relevance.", "issue": {"key": "ENG-2"}, "commits": ["1234567890", "2345678901"],
                 "timeline": {"id": null, "branch": "timeline/ranking", "landing": "fedcba9876"}},
                {"category": "feature", "title": "Add search", "summary": "Find anything.", "issue": null, "commits": ["9876543210"],
                 "timeline": {"id": null, "branch": null, "landing": "0011223344"}}
            ]
        });
        let text = notes_text(&value, false);
        assert!(text.contains("## New\n- **Add search**"));
        assert!(text.contains("(landed with merge 0011223, 9876543)"));
        assert!(text.contains("## Fixed\n- **Fix ranking**"));
        assert!(text.contains("ENG-2, landed with timeline/ranking, 1234567, 2345678"));
        assert!(!text.contains("Bump deps"));
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
    fn feed_preserves_repository_and_tracker_provenance() {
        let value = json!({
            "space": {"displayName": "Orbit Labs"},
            "query": {"unknown": ["color:red"]},
            "truncated": false,
            "facets": {},
            "entries": [
                {"category": "fix", "title": "Fix rollback", "summary": "Rollbacks finish.", "releaseKind": "daily", "lastCommitAt": "2026-09-25T00:00:00Z", "issue": {"key": "OPS-3"},
                 "repos": [{"space": "orbit", "name": "engine", "releases": ["v2", "@day:2026-09-25"]}]}
            ]
        });
        let text = feed_text(&value, true);
        assert!(text.contains("2026-09-25 UTC"));
        assert!(text.contains("OPS-3; orbit/engine Tag v2, 2026-09-25 UTC"));
    }

    #[test]
    fn default_selection_prefers_visible_daily_updates_before_tags() {
        let mut value = json!({
            "status": {"state": "ready", "generatedAt": "2026-10-02T00:00:00Z"},
            "releases": [
                {"name": "v2", "kind": "tag", "entries": 2, "lastCommitAt": "2026-10-03T00:00:00Z", "fromTag": "v1"},
                {"name": "@day:2026-10-01", "kind": "daily", "entries": 3, "lastCommitAt": "2026-10-01T00:00:00Z", "fromTag": null},
                {"name": "@day:2026-10-02", "kind": "daily", "entries": 0, "lastCommitAt": "2026-10-02T00:00:00Z", "fromTag": null}
            ]
        });
        assert_eq!(
            s(default_release(&value).unwrap(), "name"),
            "@day:2026-10-01"
        );
        let text = list_text(&value);
        assert!(text.find("2026-10-02 UTC").unwrap() < text.find("Tag v2").unwrap());
        assert!(text.contains("last commit 2026-10-02T00:00:00Z"));
        value["releases"][1]["entries"] = json!(0);
        assert_eq!(
            s(default_release(&value).unwrap(), "name"),
            "@day:2026-10-02"
        );
        let mut tags = json!({"releases": [
            {"name": "v3", "kind": "tag", "entries": 0, "lastCommitAt": "2026-10-03T00:00:00Z"},
            {"name": "v1", "kind": "tag", "entries": 2, "lastCommitAt": "2026-10-01T00:00:00Z"},
            {"name": "v2", "kind": "tag", "entries": 2, "lastCommitAt": "2026-10-02T00:00:00Z"}
        ]});
        assert_eq!(s(default_release(&tags).unwrap(), "name"), "v2");
        tags["releases"][1]["entries"] = json!(0);
        tags["releases"][2]["entries"] = json!(0);
        assert_eq!(s(default_release(&tags).unwrap(), "name"), "v3");
        assert!(default_release(&json!({"releases": []})).is_none());
    }
}
