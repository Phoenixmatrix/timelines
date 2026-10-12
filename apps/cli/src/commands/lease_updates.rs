//! Lease updates (CORE-261): what others changed on an issue while you hold
//! its lease, so the agent working it hears about it and can adapt.
//!
//! gm keeps, with each lease, the claim's actor and the newest tracker cursor
//! the holder has been told about. The issue's history after that cursor, less
//! the holder's own changes, is news. It reaches the agent three ways:
//! - `gm issue updates` lists it and marks it told;
//! - `gm issue renew` mentions it without marking it told (renewal loops
//!   often discard their output);
//! - Claude Code's hooks add it to the conversation and mark it told: after
//!   the main agent's tool calls (`gm hook claude-code updates`, at most once
//!   a minute, never inside a subagent) and with the person's next prompt.

use super::tracker::{Kept, held_leases, update_kept};
use crate::output::{GmError, Result};
use crate::remote::{self, Config, Identity};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// History read per request, and requests per lease: news beyond them is
/// reported as more to read in `gm issue history`.
const PAGE: u16 = 25;
const PAGES: usize = 4;

/// How long a hook waits for the server per read.
const HOOK_WAIT: Duration = Duration::from_secs(2);

/// What changed on one held issue since its holder was last told.
pub(crate) struct News {
    issue_id: String,
    kept: Kept,
    /// One line per change by someone else, oldest first.
    pub changes: Vec<String>,
    /// More history than gm read: the rest is in `gm issue history`.
    pub more: bool,
    /// The newest cursor read, own changes included: told up to here.
    newest: u64,
}

impl News {
    pub fn key(&self) -> &str {
        &self.kept.issue
    }
    pub fn is_news(&self) -> bool {
        !self.changes.is_empty() || self.more
    }
    pub fn to_json(&self) -> Value {
        json!({
            "issue": self.key(),
            "changes": self.changes,
            "more": self.more,
            "next": format!("Re-read it before going on: gm issue show {}", self.key()),
        })
    }
}

/// Whose leases: the identity gm acts as, one issue (key or ID) or all, and
/// for hooks the checkout they run in (leases claimed elsewhere belong to
/// another session).
pub(crate) struct Scope<'a> {
    pub identity: Identity,
    pub only: Option<&'a str>,
    pub checkout: Option<PathBuf>,
}

impl Scope<'_> {
    /// A hook's scope: the checkout's identity without provisioning a missing
    /// agent token (a hook never makes an agent), and the checkout itself.
    pub fn hook(config: &Config) -> Option<Scope<'static>> {
        Some(Scope {
            identity: config.known_identity()?,
            only: None,
            checkout: crate::profile::root(),
        })
    }
}

/// The leases in `scope`.
fn held(config: &Config, scope: &Scope) -> Vec<(String, Kept)> {
    held_leases(config)
        .into_iter()
        .filter(|(id, kept)| {
            kept.identity == scope.identity
                && !kept.owner.is_empty()
                && scope
                    .only
                    .is_none_or(|issue| issue == id || issue.eq_ignore_ascii_case(&kept.issue))
                && scope.checkout.as_deref().is_none_or(|here| {
                    kept.checkout
                        .as_deref()
                        .is_none_or(|claimed| Path::new(claimed) == here)
                })
        })
        .collect()
}

/// Whether any lease in `scope` could have news.
pub(crate) fn holds_any(config: &Config, scope: &Scope) -> bool {
    !held(config, scope).is_empty()
}

/// News on each lease in `scope`. `wait` bounds each read, for hooks, which
/// also stop at the first failed read (the server is likely down for all);
/// otherwise reads retry as any other.
pub(crate) fn gather(
    config: &Config,
    scope: &Scope,
    wait: Option<Duration>,
) -> Vec<(String, Result<News>)> {
    let mut out = Vec::new();
    for (issue_id, kept) in held(config, scope) {
        let key = kept.issue.clone();
        let read = read_since(config, &issue_id, &kept, wait);
        let failed = read.is_err();
        out.push((
            key,
            read.map(|(events, more)| news(issue_id, kept, &events, more)),
        ));
        if failed && wait.is_some() {
            break;
        }
    }
    out
}

/// The issue's history (newest first) back to what its holder was told, and
/// whether more remains beyond the pages read.
fn read_since(
    config: &Config,
    issue_id: &str,
    kept: &Kept,
    wait: Option<Duration>,
) -> Result<(Vec<Value>, bool)> {
    let mut events = Vec::new();
    let mut before = None;
    for _ in 0..PAGES {
        let mut path = format!(
            "/tracker/{}/issues/{issue_id}/history?limit={PAGE}",
            kept.owner
        );
        if let Some(before) = before {
            path.push_str(&format!("&before={before}"));
        }
        let page = match wait {
            Some(wait) => remote::get_briefly(config, &path, wait)?,
            None => remote::api(config, "GET", &path, None)?,
        };
        let rows = page["events"].as_array().cloned().unwrap_or_default();
        // A lease without a starting point needs only the newest cursor.
        let reached = kept.seen.is_none_or(|seen| {
            rows.iter()
                .any(|e| e["cursor"].as_u64().is_some_and(|c| c <= seen))
        });
        events.extend(rows);
        before = page["nextBefore"].as_u64();
        if reached || page["hasMore"] != true || before.is_none() {
            return Ok((events, false));
        }
    }
    Ok((events, true))
}

/// The news in an issue's history (newest first).
fn news(issue_id: String, kept: Kept, events: &[Value], more: bool) -> News {
    let newest = events
        .iter()
        .filter_map(|e| e["cursor"].as_u64())
        .chain(kept.seen)
        .max()
        .unwrap_or(0);
    // A lease kept by an older gm has no starting point: it starts from now.
    let (Some(seen), Some(actor)) = (kept.seen, kept.actor.clone()) else {
        return News {
            issue_id,
            kept,
            changes: Vec::new(),
            more: false,
            newest,
        };
    };
    let changes = events
        .iter()
        .rev()
        .filter(|e| e["cursor"].as_u64().is_some_and(|c| c > seen))
        .filter(|e| e["actorId"].as_str() != Some(actor.as_str()))
        .filter_map(|e| summary(e, &issue_id))
        .collect();
    News {
        issue_id,
        kept,
        changes,
        more,
        newest,
    }
}

/// Remember that the holder has been told everything `news` read. The lease
/// file is read again first, so a concurrent claim, resume, renewal or
/// completion keeps what it wrote: only `seen` moves, and only forward, and a
/// lease that ended meanwhile stays gone.
pub(crate) fn mark_told(config: &Config, news: &News) {
    update_kept(config, &news.issue_id, |kept| {
        if kept.identity != news.kept.identity || kept.seen.is_some_and(|s| s >= news.newest) {
            return false;
        }
        kept.seen = Some(news.newest);
        true
    });
}

/// The news as text for the agent, or nothing when there is none.
pub(crate) fn text(updates: &[Value]) -> Option<String> {
    let mut out = String::new();
    for update in updates.iter().filter(|u| u["changes"].is_array()) {
        let issue = update["issue"].as_str().unwrap_or("An issue you hold");
        out.push_str(&format!("{issue} changed while you hold its lease:\n"));
        for change in update["changes"].as_array().into_iter().flatten() {
            out.push_str(&format!("- {}\n", change.as_str().unwrap_or_default()));
        }
        if update["more"] == true {
            out.push_str(&format!("- …and more: gm issue history {issue}\n"));
        }
        out.push_str(&format!(
            "{}\n",
            update["next"].as_str().unwrap_or_default()
        ));
    }
    (!out.is_empty()).then_some(out)
}

/// `gm issue updates`: the news on the issues held, marked told once read.
pub(crate) fn command(config: &Config, only: Option<&str>) -> Result<Value> {
    let scope = Scope {
        identity: config.identity()?,
        only,
        checkout: None,
    };
    if only.is_some() && !holds_any(config, &scope) {
        return Err(GmError::usage(format!(
            "gm holds no lease on {} for you on this machine.",
            only.unwrap_or_default()
        ))
        .hint(
            "Lease updates cover issues claimed here with `gm issue claim` or `gm issue next`.",
        ));
    }
    let gathered = gather(config, &scope, None);
    let held = gathered.len();
    let mut updates = Vec::new();
    let mut read = Vec::new();
    for (key, news) in gathered {
        match news {
            Ok(news) => {
                if news.is_news() {
                    updates.push(news.to_json());
                }
                read.push(news);
            }
            Err(error) => updates.push(json!({"issue": key, "error": error.message})),
        }
    }
    for news in &read {
        mark_told(config, news);
    }
    Ok(json!({"leaseUpdates": updates, "held": held}))
}

/// The news for a hook: `emit` gets its text, if any, and only then is it
/// marked told, so a hook cut short repeats news rather than losing it.
/// Never fails; an unreachable server just means no news this time.
pub(crate) fn for_hook(config: &Config, scope: &Scope, emit: impl FnOnce(&str)) {
    let read: Vec<News> = gather(config, scope, Some(HOOK_WAIT))
        .into_iter()
        .filter_map(|(_, news)| news.ok())
        .collect();
    let updates: Vec<Value> = read
        .iter()
        .filter(|news| news.is_news())
        .map(News::to_json)
        .collect();
    if let Some(text) = text(&updates) {
        emit(&text);
    }
    for news in &read {
        mark_told(config, news);
    }
}

fn clip(text: &str, limit: usize) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= limit {
        return line;
    }
    format!("{}…", line.chars().take(limit).collect::<String>())
}

fn shown(value: &Value) -> String {
    match value {
        Value::Null => "none".into(),
        Value::String(text) => clip(text, 80),
        Value::Array(items) if items.is_empty() => "none".into(),
        Value::Array(items) => items.iter().map(shown).collect::<Vec<_>>().join(", "),
        other => clip(&other.to_string(), 80),
    }
}

/// Issue fields worth a before → after.
const SHOWN_FIELDS: [&str; 10] = [
    "status",
    "priority",
    "type",
    "title",
    "pickup",
    "closeReason",
    "timelineUse",
    "timelinePolicy",
    "assigneeId",
    "labels",
];
/// Issue fields too long or structured to show: named as changed.
const NAMED_FIELDS: [&str; 5] = [
    "description",
    "acceptance",
    "requires",
    "parentId",
    "workspaceIds",
];

/// One history event as a line, from the holder's side; nothing for changes
/// that don't concern them (counters, the holder's queue bookkeeping).
fn summary(event: &Value, held: &str) -> Option<String> {
    let who = event["actor"]["name"]
        .as_str()
        .or(event["actorId"].as_str())
        .unwrap_or("Someone");
    let before = &event["before"];
    let after = &event["entity"];
    let what = match event["entityType"].as_str()? {
        "comment" => {
            let comment = if after.is_null() { before } else { after };
            let kind = comment["kind"]
                .as_str()
                .filter(|kind| matches!(*kind, "checkpoint" | "evidence"))
                .unwrap_or("comment");
            if after.is_null() {
                format!("removed a {kind}")
            } else {
                format!(
                    "added a {kind}: {}",
                    clip(comment["body"].as_str().unwrap_or_default(), 300)
                )
            }
        }
        "request" => {
            let kind = after["kind"]
                .as_str()
                .or(before["kind"].as_str())
                .unwrap_or("request");
            let prompt = clip(
                after["prompt"]
                    .as_str()
                    .or(before["prompt"].as_str())
                    .unwrap_or_default(),
                120,
            );
            match (before.is_null(), after["status"].as_str()) {
                (true, _) => format!("asked a {kind}: {prompt}"),
                (false, Some("answered")) => format!(
                    "answered the {kind} \"{prompt}\": {}",
                    clip(after["answer"].as_str().unwrap_or_default(), 300)
                ),
                (false, Some("canceled")) => format!("withdrew the {kind} \"{prompt}\""),
                _ => format!("updated the {kind} \"{prompt}\""),
            }
        }
        "link" => {
            let kind = after["kind"]
                .as_str()
                .or(before["kind"].as_str())
                .unwrap_or("related");
            match (before.is_null(), after.is_null()) {
                (true, false) => format!("added a {kind} link"),
                (false, true) => format!("removed a {kind} link"),
                _ => format!("changed a {kind} link"),
            }
        }
        "issue" if event["entityId"] != held => {
            let key = after["key"]
                .as_str()
                .or(before["key"].as_str())
                .unwrap_or("an issue");
            if after["parentId"] == held && before["parentId"] != held {
                format!("made {key} a sub-issue of it")
            } else if before["parentId"] == held && after["parentId"] != held {
                format!("moved {key} out from under it")
            } else {
                return None;
            }
        }
        "issue" => issue_change(before, after)?,
        _ => return None,
    };
    Some(format!("{who} {what}"))
}

fn issue_change(before: &Value, after: &Value) -> Option<String> {
    if after.is_null() {
        return Some("deleted it".into());
    }
    let mut parts = Vec::new();
    let holder = |issue: &Value| issue["claim"]["actorId"].as_str().map(str::to_string);
    match (holder(before), holder(after)) {
        (Some(was), Some(now)) if was != now => {
            parts.push("took over the claim: your lease no longer holds".to_string())
        }
        (Some(_), None) => parts.push("ended the claim: your lease no longer holds".to_string()),
        _ => {}
    }
    for field in SHOWN_FIELDS {
        if before[field] != after[field] {
            parts.push(format!(
                "{field}: {} → {}",
                shown(&before[field]),
                shown(&after[field])
            ));
        }
    }
    for field in NAMED_FIELDS {
        if before[field] != after[field] {
            parts.push(format!("changed the {field}"));
        }
    }
    if after["queueFailure"].is_object() && before["queueFailure"] != after["queueFailure"] {
        parts.push("recorded a merge-queue failure".to_string());
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("; "))
}

/// The identity-wide hook throttle: true when the last check was at least
/// `every` ago (and records this one).
pub(crate) fn due(config: &Config, identity: &Identity, every: Duration) -> bool {
    let Some(path) = super::tracker::hook_check_path(config, identity) else {
        return false;
    };
    let now = std::time::SystemTime::now();
    let recent = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|at| now.duration_since(at).ok())
        .is_some_and(|since| since < every);
    if recent {
        return false;
    }
    std::fs::write(&path, b"").is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(cursor: u64, actor: &str, kind: &str, before: Value, entity: Value) -> Value {
        json!({
            "cursor": cursor, "actorId": actor, "actor": {"name": actor},
            "entityType": kind, "entityId": entity["id"].as_str().or(before["id"].as_str()).unwrap_or("i1"),
            "before": before, "entity": entity,
        })
    }

    fn events(history: &Value) -> &[Value] {
        history["events"].as_array().unwrap()
    }

    fn kept(seen: Option<u64>) -> Kept {
        serde_json::from_value(json!({
            "token": "t", "identity": {"kind": "person"}, "issue": "CORE-1",
            "owner": "matrixorg", "actor": "agent", "seen": seen,
        }))
        .unwrap()
    }

    fn issue(status: &str, claim: Option<&str>) -> Value {
        json!({"id": "i1", "key": "CORE-1", "status": status, "priority": 2, "description": "a",
               "claim": claim.map(|actor| json!({"actorId": actor}))})
    }

    #[test]
    fn news_is_what_others_changed_after_the_holder_was_told() {
        let history = json!({"hasMore": false, "events": [
            event(9, "fran", "comment", Value::Null,
                  json!({"id": "c", "issueId": "i1", "kind": "comment", "body": "Use the  new\nAPI please"})),
            event(8, "agent", "issue", issue("todo", Some("agent")), issue("in_progress", Some("agent"))),
            event(7, "fran", "issue", issue("todo", Some("agent")),
                  json!({"id": "i1", "key": "CORE-1", "status": "todo", "priority": 1, "description": "b",
                         "claim": {"actorId": "agent"}})),
            event(5, "fran", "issue", issue("todo", None), issue("todo", Some("agent"))),
        ]});
        let news = news("i1".into(), kept(Some(6)), events(&history), false);
        assert_eq!(
            news.changes,
            [
                "fran priority: 2 → 1; changed the description",
                "fran added a comment: Use the new API please",
            ]
        );
        assert!(!news.more);
        assert_eq!(news.newest, 9);
        // Told up to the newest: nothing more to say about this page.
        let again = super::news("i1".into(), kept(Some(9)), events(&history), false);
        assert!(!again.is_news());
    }

    #[test]
    fn a_lease_without_a_starting_point_starts_from_now() {
        let history = json!({"hasMore": false, "events": [
            event(9, "fran", "comment", Value::Null, json!({"id": "c", "issueId": "i1", "kind": "comment", "body": "hi"})),
        ]});
        let news = news("i1".into(), kept(None), events(&history), false);
        assert!(!news.is_news());
        assert_eq!(news.newest, 9);
    }

    #[test]
    fn a_full_page_of_news_says_there_is_more() {
        let history = json!({"hasMore": true, "events": [
            event(9, "fran", "comment", Value::Null, json!({"id": "c", "issueId": "i1", "kind": "checkpoint", "body": "x"})),
        ]});
        let news = news("i1".into(), kept(Some(2)), events(&history), true);
        assert!(news.more);
        assert_eq!(news.changes, ["fran added a checkpoint: x"]);
        let shown = text(&[news.to_json()]).unwrap();
        assert!(shown.contains("CORE-1 changed while you hold its lease"));
        assert!(shown.contains("gm issue history CORE-1"));
        assert!(shown.contains("gm issue show CORE-1"));
    }

    #[test]
    fn claims_requests_links_and_sub_issues_read_from_the_holders_side() {
        let took = event(
            3,
            "boss",
            "issue",
            issue("in_progress", Some("agent")),
            issue("in_progress", Some("boss")),
        );
        assert_eq!(
            summary(&took, "i1").unwrap(),
            "boss took over the claim: your lease no longer holds"
        );
        let answered = event(
            4,
            "fran",
            "request",
            json!({"id": "r", "kind": "decision", "prompt": "A or B?", "status": "open"}),
            json!({"id": "r", "kind": "decision", "prompt": "A or B?", "status": "answered", "answer": "B"}),
        );
        assert_eq!(
            summary(&answered, "i1").unwrap(),
            "fran answered the decision \"A or B?\": B"
        );
        let link = event(
            5,
            "fran",
            "link",
            Value::Null,
            json!({"id": "l", "kind": "blocks"}),
        );
        assert_eq!(summary(&link, "i1").unwrap(), "fran added a blocks link");
        let child = event(
            6,
            "fran",
            "issue",
            json!({"id": "i2", "key": "CORE-2", "parentId": null}),
            json!({"id": "i2", "key": "CORE-2", "parentId": "i1"}),
        );
        assert_eq!(
            summary(&child, "i1").unwrap(),
            "fran made CORE-2 a sub-issue of it"
        );
        // Bookkeeping that changes nothing the holder reads is left out.
        let quiet = event(
            7,
            "fran",
            "issue",
            issue("todo", Some("agent")),
            issue("todo", Some("agent")),
        );
        assert!(summary(&quiet, "i1").is_none());
    }
}
