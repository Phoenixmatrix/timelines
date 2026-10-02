//! Read the server's paginated syntax-change feed without altering its JSON response.

use super::Ctx;
use super::server::current_repo;
use crate::cli::{SemanticCommand, SemanticListArgs};
use crate::output::{GmError, Render, Result};
use crate::remote::{self, Config};
use serde::{Serialize, Serializer};
use serde_json::Value;
use std::fmt::Write;

pub struct Shown {
    value: Value,
}

impl Serialize for Shown {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        self.value.serialize(serializer)
    }
}

impl Render for Shown {
    fn text(&self) -> String {
        feed_text(&self.value)
    }
}

/// Encode one path segment or query value, including cursor punctuation and UTF-8.
pub(crate) fn encode_into(out: &mut String, value: &str) {
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char);
            }
            _ => {
                let _ = write!(out, "%{byte:02X}");
            }
        }
    }
}

fn request_path(repo: &str, args: &SemanticListArgs) -> Result<String> {
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
    let _ = write!(path, "/semantic?limit={}", args.limit);
    for (key, value) in [
        ("ref", args.reference.as_deref()),
        ("cursor", args.cursor.as_deref()),
        ("path", args.path.as_deref()),
        ("kind", args.kind.as_deref()),
        ("language", args.language.as_deref()),
    ] {
        if let Some(value) = value {
            path.push('&');
            path.push_str(key);
            path.push('=');
            encode_into(&mut path, value);
        }
    }
    Ok(path)
}

fn s<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}

fn feed_text(value: &Value) -> String {
    let mut out = format!(
        "Semantic changes on {} (head {}) — syntax evidence\n",
        s(value, "ref"),
        value["head"].as_str().unwrap_or("none"),
    );
    if value["entries"].as_array().is_some_and(Vec::is_empty) {
        out.push_str("No matching semantic changes in this page.\n");
    }
    for entry in value["entries"].as_array().into_iter().flatten() {
        let source = if entry["after"].is_null() {
            &entry["before"]
        } else {
            &entry["after"]
        };
        let _ = writeln!(
            out,
            "{} [{}] {}",
            s(entry, "kind"),
            s(entry, "language"),
            s(entry, "summary")
        );
        let _ = writeln!(
            out,
            "  {}:{}  id {}",
            s(source, "path"),
            source["start"]["line"],
            s(entry, "id")
        );
        let _ = writeln!(
            out,
            "  commit {}  {}",
            s(&entry["commit"], "oid"),
            s(&entry["links"], "commit")
        );
        for label in ["before", "after"] {
            if let Some(link) = entry["links"][label].as_str() {
                let _ = writeln!(out, "  {label} {link}");
            }
        }
    }
    if let Some(coverage) = value["coverage"].as_array() {
        let _ = writeln!(
            out,
            "Coverage: {} file/commit analyses in this page",
            coverage.len()
        );
        for item in coverage {
            let _ = writeln!(
                out,
                "  {} {} ({})",
                s(item, "status"),
                s(item, "path"),
                s(item, "commit")
            );
            for diagnostic in item["diagnostics"].as_array().into_iter().flatten() {
                let _ = writeln!(out, "    {}", s(diagnostic, "message"));
            }
        }
    }
    if let Some(cursor) = value["nextCursor"].as_str() {
        let _ = writeln!(
            out,
            "Next cursor: {cursor}\nContinue with --cursor and the same repository, ref and filters (even when this page is empty)."
        );
    } else {
        out.push_str("End of feed.\n");
    }
    out.pop();
    out
}

pub fn run(ctx: &Ctx, command: &SemanticCommand) -> Result<Shown> {
    let SemanticCommand::List(args) = command;
    let inferred;
    let repo = match args.repo.as_deref() {
        Some(repo) => repo,
        None => {
            inferred = current_repo(ctx)?;
            &inferred
        }
    };
    let path = request_path(repo, args)?;
    let value = remote::api(&Config::load(), "GET", &path, None)?;
    Ok(Shown { value })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Cli, Command};
    use clap::Parser;
    use serde_json::json;

    fn args(extra: &[&str]) -> SemanticListArgs {
        let mut argv = vec!["gm", "semantic", "list"];
        argv.extend_from_slice(extra);
        let cli = Cli::try_parse_from(argv).unwrap();
        match cli.command.unwrap() {
            Command::Semantic(SemanticCommand::List(args)) => args,
            _ => unreachable!(),
        }
    }

    #[test]
    fn query_values_cannot_inject_filters_or_fragments() {
        let args = args(&[
            "--ref",
            "feature/a&limit=999",
            "--cursor",
            "a+b/=",
            "--path",
            "src/é #?.ts",
        ]);
        assert_eq!(
            request_path("orbit/engine", &args).unwrap(),
            "/repos/orbit/engine/semantic?limit=30&ref=feature%2Fa%26limit%3D999&cursor=a%2Bb%2F%3D&path=src%2F%C3%A9%20%23%3F.ts"
        );
    }

    #[test]
    fn invalid_repository_targets_do_not_reach_other_routes() {
        let args = args(&[]);
        for repo in [
            "orbit",
            "/engine",
            "orbit/",
            "orbit/engine/semantic",
            "../engine",
            "orbit/..",
        ] {
            assert!(request_path(repo, &args).is_err(), "{repo}");
        }
    }

    #[test]
    fn page_limit_rejects_nonpositive_and_overflowing_values() {
        for limit in ["0", "-1", "4294967296", "many"] {
            assert!(Cli::try_parse_from(["gm", "semantic", "list", "--limit", limit]).is_err());
        }
    }

    #[test]
    fn empty_page_with_cursor_is_not_reported_as_end_of_feed() {
        let mut page =
            json!({"ref":"main","head":"abc","entries":[],"coverage":[],"nextCursor":"next"});
        let text = feed_text(&page);
        assert!(text.contains("Next cursor: next"));
        assert!(!text.contains("End of feed."));
        page["nextCursor"] = Value::Null;
        assert!(feed_text(&page).contains("End of feed."));
    }
}
