//! What an issue requires of the agent that claims it (CORE-32), mirroring
//! apps/website/shared/requirements.ts: the text form `gm issue create|update
//! --requires` takes, the stored object the server keeps, and matching against
//! an agent's self-reported capabilities (`gm agent setup`). Eligibility, not
//! authorization: people bypass capabilities, but pickup and permissions still apply.
use crate::output::{GmError, Result};
use serde_json::{Map, Value, json};

/// The lists, in canonical order, with the term each is written with.
const LISTS: [(&str, &str); 7] = [
    ("tags", "tag"),
    ("skills", "skill"),
    ("models", "model"),
    ("harnesses", "harness"),
    ("os", "os"),
    ("arch", "arch"),
    ("runtime", "runtime"),
];
/// Lists where the agent needs every value; the others need any one.
const EVERY: [&str; 2] = ["tags", "skills"];
const RUNTIMES: [&str; 6] = [
    "host",
    "container",
    "vm",
    "wsl",
    "cloudflare-worker",
    "unknown",
];
const MAX_VALUES: usize = 20;
const MAX_MEMORY: u64 = 1 << 50;
const MAX_CPUS: u64 = 4096;
const GIB: u64 = 1 << 30;

fn list_key(term: &str) -> Option<&'static str> {
    Some(match term {
        "tag" | "tags" => "tags",
        "skill" | "skills" => "skills",
        "model" | "models" => "models",
        "harness" | "harnesses" => "harnesses",
        "os" => "os",
        "arch" => "arch",
        "runtime" => "runtime",
        _ => return None,
    })
}
fn term_of(key: &str) -> &'static str {
    LISTS
        .iter()
        .find(|(k, _)| *k == key)
        .map_or("?", |(_, t)| t)
}
fn singular(key: &str) -> &'static str {
    match key {
        "tags" => "tag",
        "skills" => "skill",
        "models" => "model",
        "harnesses" => "harness",
        "os" => "OS",
        "arch" => "architecture",
        _ => "runtime",
    }
}

/// "16GiB", "512MB", "1.5G", "17179869184": bytes, or None when it isn't a size.
pub fn parse_bytes(text: &str) -> Option<u64> {
    let text = text.trim();
    let split = text
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(text.len());
    let (number, unit) = text.split_at(split);
    let unit = unit.trim_start();
    if number.is_empty()
        || number.starts_with('.')
        || number.ends_with('.')
        || number.matches('.').count() > 1
        || !unit.chars().all(|c| c.is_ascii_alphabetic())
    {
        return None;
    }
    let size: f64 = match unit.to_ascii_lowercase().as_str() {
        "" | "b" => 1.0,
        "k" | "kib" => 1024.0,
        "m" | "mib" => 1024f64.powi(2),
        "g" | "gib" => 1024f64.powi(3),
        "t" | "tib" => 1024f64.powi(4),
        "kb" => 1e3,
        "mb" => 1e6,
        "gb" => 1e9,
        "tb" => 1e12,
        _ => return None,
    };
    let bytes = (number.parse::<f64>().ok()? * size).round();
    (1.0..=9_007_199_254_740_991.0)
        .contains(&bytes)
        .then_some(bytes as u64)
}

/// Bytes in the largest unit that keeps it whole, binary first: 16GiB, 16GB, 1536MiB, 1001B.
pub fn format_bytes(bytes: u64) -> String {
    for (unit, size) in [
        ("TiB", 1u64 << 40),
        ("TB", 1_000_000_000_000),
        ("GiB", GIB),
        ("GB", 1_000_000_000),
        ("MiB", 1 << 20),
        ("MB", 1_000_000),
        ("KiB", 1 << 10),
        ("KB", 1_000),
    ] {
        if bytes >= size && bytes.is_multiple_of(size) {
            return format!("{}{unit}", bytes / size);
        }
    }
    format!("{bytes}B")
}
/// A reported amount of memory, roughly: "15.5GiB" (never parsed back).
fn rough_bytes(bytes: u64) -> String {
    if bytes.is_multiple_of(1 << 20) {
        return format_bytes(bytes);
    }
    if bytes >= GIB {
        let tenths = (bytes as f64 / GIB as f64 * 10.0).floor() / 10.0;
        format!("{tenths}GiB")
    } else {
        format!("{}MiB", bytes >> 20)
    }
}

fn valid_value(v: &str) -> bool {
    let mut chars = v.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '*')
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "*._+/@-".contains(c))
}

/// Whether there is anything to meet: absent, null and empty mean any agent.
pub fn has_requirements(requires: &Value) -> bool {
    let Some(map) = requires.as_object() else {
        return false;
    };
    LISTS.iter().any(|(k, _)| {
        map.get(*k)
            .and_then(Value::as_array)
            .is_some_and(|a| !a.is_empty())
    }) || map.get("minMemory").is_some_and(|v| !v.is_null())
        || map.get("minCpus").is_some_and(|v| !v.is_null())
}

/// The stored form of a `requires` value, as the server keeps it: known keys,
/// trimmed lowercase values without duplicates, whole positive numbers; null
/// when it asks nothing. A usage error says what's wrong.
pub fn normalize(value: &Value) -> Result<Value> {
    let input = match value {
        Value::Null => return Ok(Value::Null),
        Value::Object(map) => map,
        _ => {
            return Err(GmError::usage(
                "requires must be an object, or null for any agent.",
            ));
        }
    };
    let mut out = Map::new();
    for (key, item) in input {
        if item.is_null() {
            continue;
        }
        if LISTS.iter().any(|(k, _)| k == key) {
            let items = item
                .as_array()
                .filter(|a| a.len() <= MAX_VALUES)
                .ok_or_else(|| {
                    GmError::usage(format!(
                        "{key} must be a list of at most {MAX_VALUES} values."
                    ))
                })?;
            let mut values: Vec<String> = Vec::new();
            for raw in items {
                let text = raw
                    .as_str()
                    .ok_or_else(|| GmError::usage(format!("{key} values must be text.")))?;
                let v = text.trim().to_lowercase();
                if v.is_empty() || v.len() > 100 || !valid_value(&v) {
                    return Err(GmError::usage(format!(
                        "Invalid {} \"{text}\": use letters, digits, . _ + / @ - and * (1–100 characters).",
                        term_of(key)
                    )));
                }
                if key == "runtime" && !v.contains('*') && !RUNTIMES.contains(&v.as_str()) {
                    return Err(GmError::usage(format!(
                        "Unknown runtime \"{v}\": use {}.",
                        RUNTIMES.join(", ")
                    )));
                }
                if !values.contains(&v) {
                    values.push(v);
                }
            }
            if !values.is_empty() {
                out.insert(key.clone(), json!(values));
            }
        } else if key == "minMemory" || key == "minCpus" {
            let max = if key == "minMemory" {
                MAX_MEMORY
            } else {
                MAX_CPUS
            };
            let n = item
                .as_u64()
                .filter(|n| (1..=max).contains(n))
                .ok_or_else(|| {
                    GmError::usage(format!("{key} must be a whole number from 1 to {max}."))
                })?;
            out.insert(key.clone(), json!(n));
        } else {
            return Err(GmError::usage(format!("Unknown requirement: {key}.")));
        }
    }
    let out = Value::Object(out);
    Ok(if has_requirements(&out) {
        out
    } else {
        Value::Null
    })
}

/// Parse the text form ("tag:ux model:claude-* memory>=16GiB") into the stored
/// object; empty text is null (any agent).
pub fn parse(text: &str) -> Result<Value> {
    let mut draft = Map::new();
    for term in text.split_whitespace() {
        let lower = term.to_ascii_lowercase();
        if let Some((name, _)) = lower.split_once(">=") {
            let name = name.trim();
            let memory = matches!(name, "memory" | "mem");
            if !memory && !matches!(name, "cpus" | "cpu") {
                return Err(unknown_term(term));
            }
            let raw = &term[term.find(">=").unwrap() + 2..];
            let value = if memory {
                parse_bytes(raw)
            } else {
                raw.trim().parse::<u64>().ok().filter(|n| *n >= 1)
            };
            let value = value.ok_or_else(|| {
                GmError::usage(if memory {
                    format!("Invalid memory \"{raw}\": use a size like 16GiB.")
                } else {
                    format!("Invalid CPU count \"{raw}\".")
                })
            })?;
            draft.insert(
                if memory { "minMemory" } else { "minCpus" }.into(),
                json!(value),
            );
            continue;
        }
        let Some((name, values)) = term.split_once(':').filter(|(n, _)| !n.is_empty()) else {
            return Err(unknown_term(term));
        };
        let key = list_key(&name.to_ascii_lowercase()).ok_or_else(|| unknown_term(term))?;
        let values: Vec<&str> = values.split(',').filter(|v| !v.is_empty()).collect();
        if values.is_empty() {
            return Err(GmError::usage(format!("\"{term}\" needs a value.")));
        }
        let list = draft.entry(key).or_insert_with(|| json!([]));
        for value in values {
            list.as_array_mut().unwrap().push(json!(value));
        }
    }
    normalize(&Value::Object(draft))
}
fn unknown_term(term: &str) -> GmError {
    GmError::usage(format!(
        "Unknown requirement \"{term}\": use tag:, skill:, model:, harness:, os:, arch:, runtime:, memory>= or cpus>=."
    ))
    .hint("For example: --requires 'tag:ux model:claude-* memory>=16GiB'.")
}

/// Each requirement as a term: ["tag:ux", "memory>=16GiB"].
pub fn terms(requires: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if !requires.is_object() {
        return out;
    }
    for (key, term) in LISTS {
        for value in requires[key].as_array().into_iter().flatten() {
            if let Some(v) = value.as_str() {
                out.push(format!("{term}:{v}"));
            }
        }
    }
    if let Some(memory) = requires["minMemory"].as_u64() {
        out.push(format!("memory>={}", format_bytes(memory)));
    }
    if let Some(cpus) = requires["minCpus"].as_u64() {
        out.push(format!("cpus>={cpus}"));
    }
    out
}
/// The text form, one term per value: "tag:ux model:claude-* memory>=16GiB".
pub fn text(requires: &Value) -> String {
    terms(requires).join(" ")
}

/// `*` matches any run of characters; everything else literally, ignoring case.
pub fn glob(pattern: &str, value: &str) -> bool {
    let pattern: Vec<char> = pattern.to_lowercase().chars().collect();
    let value: Vec<char> = value.to_lowercase().chars().collect();
    let (mut p, mut v) = (0, 0);
    let (mut star, mut mark) = (None, 0);
    while v < value.len() {
        if p < pattern.len() && pattern[p] != '*' && pattern[p] == value[v] {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            mark = v;
            p += 1;
        } else if let Some(s) = star {
            p = s + 1;
            mark += 1;
            v = mark;
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|c| *c == '*')
}

fn unmet_entry(
    requirement: &str,
    wanted: String,
    reported: Option<String>,
    message: String,
) -> Value {
    json!({"requirement": requirement, "wanted": wanted, "reported": reported, "message": message})
}

/// Every requirement `capabilities` doesn't meet: empty when it's eligible. An
/// agent that never reported capabilities meets nothing but an empty requirement.
pub fn unmet(requires: &Value, capabilities: &Value) -> Vec<Value> {
    if !has_requirements(requires) {
        return Vec::new();
    }
    if !capabilities.is_object() {
        return vec![unmet_entry(
            "capabilities",
            text(requires),
            None,
            "it hasn't reported its capabilities: run `gm agent setup` in its checkout to publish them".into(),
        )];
    }
    let env = &capabilities["environment"];
    let strings =
        |v: &Value| -> Vec<String> { v.as_str().map(|s| vec![s.to_string()]).unwrap_or_default() };
    let reported = |key: &str| -> Vec<String> {
        match key {
            "tags" => capabilities["tags"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|t| t.as_str().map(str::to_string))
                .collect(),
            "skills" => capabilities["skills"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|s| s["name"].as_str().map(str::to_string))
                .collect(),
            "models" => strings(&capabilities["model"]),
            "harnesses" => strings(&capabilities["harness"]),
            "os" => strings(&env["os"]),
            "arch" => strings(&env["arch"]),
            _ => strings(&env["runtime"]),
        }
    };
    let mut out = Vec::new();
    for (key, term) in LISTS {
        let wanted: Vec<&str> = requires[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        if wanted.is_empty() {
            continue;
        }
        let have = reported(key);
        let every = EVERY.contains(&key);
        let said = (!have.is_empty()).then(|| have.join(", "));
        let suffix = match &said {
            Some(said) if every => format!(" (it reports {}s: {said})", singular(key)),
            Some(said) => format!(" (it reports {said})"),
            None if every => format!(" (it reports no {}s)", singular(key)),
            None => format!(" (it reports no {})", singular(key)),
        };
        if every {
            for value in &wanted {
                if !have.iter().any(|h| glob(value, h)) {
                    out.push(unmet_entry(
                        key,
                        format!("{term}:{value}"),
                        said.clone(),
                        format!("needs {} {value}{suffix}", singular(key)),
                    ));
                }
            }
        } else if !wanted.iter().any(|w| have.iter().any(|h| glob(w, h))) {
            let lead = if wanted.len() > 1 {
                format!("one of {} ", singular(key))
            } else {
                format!("{} ", singular(key))
            };
            out.push(unmet_entry(
                key,
                format!("{term}:{}", wanted.join(",")),
                said,
                format!("needs {lead}{}{suffix}", wanted.join(", ")),
            ));
        }
    }
    if let Some(min) = requires["minMemory"].as_u64() {
        let memory = env["memoryBytes"].as_u64();
        if memory.is_none_or(|m| m < min) {
            out.push(unmet_entry(
                "minMemory",
                format!("memory>={}", format_bytes(min)),
                memory.map(rough_bytes),
                format!(
                    "needs at least {} of memory ({})",
                    format_bytes(min),
                    memory.map_or("it reports none".into(), |m| format!(
                        "it reports {}",
                        rough_bytes(m)
                    ))
                ),
            ));
        }
    }
    if let Some(min) = requires["minCpus"].as_u64() {
        let cpus = env["cpuCount"].as_u64();
        if cpus.is_none_or(|c| c < min) {
            out.push(unmet_entry(
                "minCpus",
                format!("cpus>={min}"),
                cpus.map(|c| c.to_string()),
                format!(
                    "needs at least {min} CPUs ({})",
                    cpus.map_or("it reports none".into(), |c| format!("it reports {c}"))
                ),
            ));
        }
    }
    out
}

/// Tags checked against a tracker's tag catalog (CORE-271): each tag the catalog
/// doesn't have (ignoring case), with the closest catalog name when one is near.
/// Unknown tags are warned about, never refused.
pub fn unknown_tags(tags: &[String], catalog: &[String]) -> Vec<Value> {
    tags.iter()
        .filter(|tag| !catalog.iter().any(|name| name.eq_ignore_ascii_case(tag)))
        .map(|tag| json!({ "tag": tag, "suggestion": closest(tag, catalog) }))
        .collect()
}

/// The catalog name nearest `tag` by edit distance, when it's close enough to be a
/// likely typo or variant (at most a third of the longer name, and at least 1).
pub fn closest<'a>(tag: &str, catalog: &'a [String]) -> Option<&'a str> {
    let tag = tag.to_lowercase();
    catalog
        .iter()
        .map(|name| (edit_distance(&tag, &name.to_lowercase()), name))
        .filter(|(d, name)| *d <= (tag.chars().count().max(name.chars().count()) / 3).max(1))
        .min_by_key(|(d, _)| *d)
        .map(|(_, name)| name.as_str())
}

fn edit_distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut previous = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let current = row[j + 1];
            row[j + 1] = (previous + usize::from(ca != *cb))
                .min(row[j] + 1)
                .min(current + 1);
            previous = current;
        }
    }
    row[b.len()]
}

/// "tag \"uxx\" isn't in orbit's tag catalog (did you mean \"ux\"?)": one warning line.
pub fn unknown_tag_warning(unknown: &Value, owner: &str) -> String {
    let tag = unknown["tag"].as_str().unwrap_or("");
    match unknown["suggestion"].as_str() {
        Some(near) => {
            format!("tag \"{tag}\" isn't in {owner}'s tag catalog (did you mean \"{near}\"?)")
        }
        None => format!("tag \"{tag}\" isn't in {owner}'s tag catalog"),
    }
}

/// The `tag:` values of stored requirements.
pub fn required_tags(requires: &Value) -> Vec<String> {
    requires["tags"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| t.as_str().map(str::to_owned))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_tags_warn_with_the_closest_catalog_name() {
        let catalog: Vec<String> = ["ux", "frontend", "data", "Security"]
            .map(String::from)
            .to_vec();
        let tags: Vec<String> = ["UX", "frontned", "security", "gpu", "uxx"]
            .map(String::from)
            .to_vec();
        assert_eq!(
            unknown_tags(&tags, &catalog),
            vec![
                json!({"tag": "frontned", "suggestion": "frontend"}),
                json!({"tag": "gpu", "suggestion": null}),
                json!({"tag": "uxx", "suggestion": "ux"}),
            ]
        );
        assert_eq!(
            unknown_tag_warning(&unknown_tags(&tags, &catalog)[0], "orbit"),
            "tag \"frontned\" isn't in orbit's tag catalog (did you mean \"frontend\"?)"
        );
        assert!(unknown_tags(&tags, &[]).len() == 5);
        assert_eq!(
            required_tags(&json!({"tags": ["ux"], "models": ["x"]})),
            ["ux"]
        );
    }

    fn caps() -> Value {
        json!({
            "version": 1, "harness": "claude-code", "model": "claude-opus-4-5",
            "environment": {"os": "linux", "arch": "x86_64", "runtime": "wsl", "cpuCount": 8, "memoryBytes": 16u64 << 30},
            "tags": ["ux", "data"], "skills": [{"name": "playwright", "description": "", "source": "detected"}]
        })
    }

    #[test]
    fn sizes_take_binary_and_decimal_units() {
        assert_eq!(parse_bytes("16GiB"), Some(16 << 30));
        assert_eq!(parse_bytes("16G"), Some(16 << 30));
        assert_eq!(parse_bytes("16GB"), Some(16_000_000_000));
        assert_eq!(parse_bytes("1.5gib"), Some(1536 << 20));
        assert_eq!(parse_bytes("512"), Some(512));
        assert_eq!(parse_bytes("512 MB"), Some(512_000_000));
        assert_eq!(parse_bytes("0"), None);
        assert_eq!(parse_bytes("lots"), None);
        assert_eq!(parse_bytes("16XB"), None);
        assert_eq!(format_bytes(16 << 30), "16GiB");
        assert_eq!(format_bytes(1536 << 20), "1536MiB");
        assert_eq!(format_bytes(16_000_000_000), "16GB");
        assert_eq!(format_bytes(1000), "1KB");
        assert_eq!(format_bytes(1001), "1001B");
        assert_eq!(rough_bytes((15 << 30) + (600 << 20) + 7), "15.5GiB");
    }

    #[test]
    fn text_parses_to_the_stored_form_and_back() {
        let parsed = parse(
            "Tag:UX tags:gpu,ux model:claude-opus-*,gpt-5* harness:claude-code os:linux arch:x86_64 runtime:host memory>=16GiB cpus>=8 skill:playwright",
        )
        .unwrap();
        assert_eq!(
            parsed,
            json!({"tags":["ux","gpu"],"skills":["playwright"],"models":["claude-opus-*","gpt-5*"],"harnesses":["claude-code"],"os":["linux"],"arch":["x86_64"],"runtime":["host"],"minMemory":16u64<<30,"minCpus":8})
        );
        let canonical = text(&parsed);
        assert_eq!(
            canonical,
            "tag:ux tag:gpu skill:playwright model:claude-opus-* model:gpt-5* harness:claude-code os:linux arch:x86_64 runtime:host memory>=16GiB cpus>=8"
        );
        assert_eq!(parse(&canonical).unwrap(), parsed);
        assert_eq!(
            parse("mem>=512MB cpu>=2").unwrap(),
            json!({"minMemory":512_000_000,"minCpus":2})
        );
        assert_eq!(text(&parse("memory>=16GB").unwrap()), "memory>=16GB");
        assert_eq!(parse("  ").unwrap(), Value::Null);
    }

    #[test]
    fn bad_text_says_what_is_wrong() {
        for (input, needle) in [
            ("gpu", "Unknown requirement \"gpu\""),
            ("color:red", "Unknown requirement"),
            ("tag:", "needs a value"),
            ("memory>=lots", "Invalid memory"),
            ("cpus>=0", "Invalid CPU count"),
            ("tag:ux!", "Invalid tag"),
            ("runtime:docker", "Unknown runtime"),
            ("disk>=1G", "Unknown requirement"),
        ] {
            let error = parse(input).unwrap_err();
            assert!(error.message.contains(needle), "{input}: {}", error.message);
        }
        assert!(normalize(&json!({"minCpus": 5000})).is_err());
        assert!(normalize(&json!({"gpu": ["a"]})).is_err());
        assert!(
            normalize(&json!({"tags": (0..21).map(|i| format!("t{i}")).collect::<Vec<_>>()}))
                .is_err()
        );
        assert_eq!(normalize(&json!({"tags": []})).unwrap(), Value::Null);
    }

    #[test]
    fn wildcards_match_case_insensitively() {
        assert!(glob("claude-opus-*", "Claude-Opus-4-5"));
        assert!(glob("*", "anything"));
        assert!(glob("gpt-*-mini", "gpt-5-mini"));
        assert!(!glob("gpt-*-mini", "gpt-5"));
        assert!(glob("x86_64", "X86_64"));
        assert!(!glob("claude-opus-*", "claude-sonnet-4"));
    }

    #[test]
    fn matching_lists_every_unmet_requirement() {
        assert!(
            unmet(
                &parse("tag:ux model:claude-* memory>=16GiB cpus>=8 skill:play*").unwrap(),
                &caps()
            )
            .is_empty()
        );
        assert!(unmet(&Value::Null, &Value::Null).is_empty());
        let missing = unmet(
            &parse("tag:ux tag:gpu tag:infra model:gpt-5*,o3 os:macos memory>=32GiB cpus>=16 harness:codex runtime:host,vm").unwrap(),
            &caps(),
        );
        let messages: Vec<&str> = missing
            .iter()
            .map(|u| u["message"].as_str().unwrap())
            .collect();
        assert_eq!(
            messages,
            [
                "needs tag gpu (it reports tags: ux, data)",
                "needs tag infra (it reports tags: ux, data)",
                "needs one of model gpt-5*, o3 (it reports claude-opus-4-5)",
                "needs harness codex (it reports claude-code)",
                "needs OS macos (it reports linux)",
                "needs one of runtime host, vm (it reports wsl)",
                "needs at least 32GiB of memory (it reports 16GiB)",
                "needs at least 16 CPUs (it reports 8)",
            ]
        );
        assert_eq!(missing[2]["wanted"], "model:gpt-5*,o3");
        assert_eq!(missing[6]["requirement"], "minMemory");
    }

    #[test]
    fn missing_capabilities_and_unreported_values() {
        let requires = parse("tag:ux").unwrap();
        let none = unmet(&requires, &Value::Null);
        assert_eq!(none.len(), 1);
        assert_eq!(none[0]["requirement"], "capabilities");
        assert!(
            none[0]["message"]
                .as_str()
                .unwrap()
                .contains("gm agent setup")
        );
        let mut bare = caps();
        bare["model"] = Value::Null;
        bare["tags"] = json!([]);
        bare["environment"]["memoryBytes"] = Value::Null;
        let messages: Vec<String> = unmet(&parse("tag:ux model:* memory>=1G").unwrap(), &bare)
            .iter()
            .map(|u| u["message"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            messages,
            [
                "needs tag ux (it reports no tags)",
                "needs model * (it reports no model)",
                "needs at least 1GiB of memory (it reports none)",
            ]
        );
    }
}
