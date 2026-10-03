//! Advisory, bounded local metadata; never executes tools or reads skill bodies into profiles.
use crate::cli::CapabilityArgs;
use crate::output::{GmError, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCapabilities {
    pub version: u8,
    pub harness: Option<String>,
    pub model: Option<String>,
    pub environment: Environment,
    pub tags: Vec<String>,
    pub skills: Vec<Skill>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Environment {
    pub os: String,
    pub arch: String,
    pub runtime: String,
    pub cpu_count: Option<usize>,
    pub memory_bytes: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub source: String,
}

fn bounded_file(path: &Path, limit: usize) -> Option<String> {
    // Avoid FIFOs/devices, including symlinks to them.
    if !fs::metadata(path).ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > limit {
        return None;
    }
    String::from_utf8(bytes).ok()
}

fn classify_runtime(kernel: &str, container: bool, virtualization: &str) -> &'static str {
    let virtualization = virtualization.to_ascii_lowercase();
    if kernel.to_ascii_lowercase().contains("microsoft") {
        "wsl"
    } else if container {
        "container"
    } else if [
        "kvm",
        "qemu",
        "vmware",
        "virtualbox",
        "virtual machine",
        "xen",
        "amazon ec2",
        "google compute engine",
    ]
    .iter()
    .any(|s| virtualization.contains(s))
    {
        "vm"
    } else {
        "unknown"
    }
}

fn limited_memory(physical: u64, limits: impl IntoIterator<Item = u64>) -> Option<u64> {
    // JavaScript safe integer is part of the wire contract.
    let value = limits
        .into_iter()
        .filter(|n| *n > 0)
        .fold(physical, u64::min);
    (value > 0 && value <= 9_007_199_254_740_991).then_some(value)
}

fn memory_limits(cgroups: &str, root: &Path) -> Vec<u64> {
    let mut limits = Vec::new();
    for line in cgroups.lines() {
        let mut fields = line.splitn(3, ':');
        let (Some(_), Some(controllers), Some(path)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let (base, file) = if controllers.is_empty() {
            (root.to_path_buf(), "memory.max")
        } else if controllers.split(',').any(|s| s == "memory") {
            (root.join("memory"), "memory.limit_in_bytes")
        } else {
            continue;
        };
        let relative = Path::new(path.trim_start_matches('/'));
        if relative.components().any(|c| {
            !matches!(
                c,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        }) {
            continue;
        }
        let mut current = base.join(relative);
        loop {
            if let Some(n) =
                bounded_file(&current.join(file), 128).and_then(|s| s.trim().parse::<u64>().ok())
            {
                limits.push(n);
            }
            if current == base || !current.pop() {
                break;
            }
        }
    }
    // Cgroup namespaces can expose only their effective root.
    for path in [
        root.join("memory.max"),
        root.join("memory/memory.limit_in_bytes"),
    ] {
        if let Some(n) = bounded_file(&path, 128).and_then(|s| s.trim().parse::<u64>().ok()) {
            limits.push(n);
        }
    }
    limits
}

fn environment() -> Environment {
    let kernel = bounded_file(Path::new("/proc/sys/kernel/osrelease"), 4096).unwrap_or_default();
    let cgroups = bounded_file(Path::new("/proc/self/cgroup"), 65536).unwrap_or_default();
    let container = Path::new("/.dockerenv").exists()
        || Path::new("/run/.containerenv").exists()
        || cgroups.contains("docker")
        || cgroups.contains("kubepods")
        || cgroups.contains("containerd");
    let virtualization =
        bounded_file(Path::new("/sys/class/dmi/id/product_name"), 4096).unwrap_or_default();
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    Environment {
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        runtime: classify_runtime(&kernel, container, &virtualization).into(),
        cpu_count: std::thread::available_parallelism()
            .ok()
            .map(usize::from)
            .filter(|n| *n <= 65536),
        memory_bytes: limited_memory(
            system.total_memory(),
            memory_limits(&cgroups, Path::new("/sys/fs/cgroup")),
        ),
    }
}

fn skill_metadata(text: &str) -> Option<Skill> {
    let mut lines = text.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let mut yaml = String::new();
    let mut ended = false;
    for line in lines {
        if matches!(line.trim(), "---" | "...") {
            ended = true;
            break;
        }
        yaml.push_str(line);
        yaml.push('\n');
    }
    if !ended {
        return None;
    }
    let value: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).ok()?;
    let name = value.get("name")?.as_str()?.trim();
    let description = value.get("description")?.as_str()?.trim();
    if name.is_empty() || name.encode_utf16().count() > 128 {
        return None;
    }
    // Match the API's JavaScript string limits without splitting UTF-8 characters.
    let mut units = 0;
    let end = description
        .char_indices()
        .find_map(|(offset, c)| {
            units += c.len_utf16();
            (units > 512).then_some(offset)
        })
        .unwrap_or(description.len());
    Some(Skill {
        name: name.into(),
        description: description[..end].into(),
        source: "detected".into(),
    })
}

fn read_skill(path: &Path) -> Option<Skill> {
    use std::io::BufRead;
    if !fs::metadata(path).ok()?.is_file() {
        return None;
    }
    let file = fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(file.take(65537));
    let mut frontmatter = String::new();
    let mut line = String::new();
    if reader.read_line(&mut line).ok()? == 0 || line.trim() != "---" {
        return None;
    }
    frontmatter.push_str(&line);
    loop {
        line.clear();
        if reader.read_line(&mut line).ok()? == 0 {
            return None;
        }
        frontmatter.push_str(&line);
        if frontmatter.len() > 65536 {
            return None;
        }
        if matches!(line.trim(), "---" | "...") {
            return skill_metadata(&frontmatter);
        }
    }
}

fn discover(roots: &[PathBuf]) -> Result<Vec<Skill>> {
    let mut seen = BTreeSet::new();
    let mut skills = BTreeMap::new();
    let mut stack: Vec<_> = roots.iter().rev().map(|p| (p.clone(), 0)).collect();
    while let Some((path, depth)) = stack.pop() {
        let Ok(canonical) = fs::canonicalize(&path) else {
            continue;
        };
        if !seen.insert(canonical.clone()) {
            continue;
        }
        if seen.len() > 4096 {
            return Err(GmError::usage(
                "Skill discovery exceeds 4096 entries; narrow --skill-dir.",
            ));
        }
        if !canonical.is_dir() {
            continue;
        }
        if let Some(skill) = read_skill(&canonical.join("SKILL.md")) {
            skills.entry(skill.name.clone()).or_insert(skill);
            continue;
        }
        if depth >= 8 {
            continue;
        }
        let Ok(entries) = fs::read_dir(&canonical) else {
            continue;
        };
        let mut children = Vec::new();
        for (index, entry) in entries.take(4097).enumerate() {
            if index == 4096 {
                return Err(GmError::usage("Skill directory exceeds 4096 entries."));
            }
            let Ok(entry) = entry else {
                continue;
            };
            let name = entry.file_name();
            if name.to_str().is_some_and(|s| {
                s.starts_with('.') || matches!(s, "node_modules" | "target" | "vendor")
            }) {
                continue;
            }
            children.push(entry.path());
        }
        children.sort();
        stack.extend(children.into_iter().rev().map(|p| (p, depth + 1)));
    }
    Ok(skills.into_values().collect())
}

const SKILL_DIRECTORIES: [&str; 7] = [
    ".agents/skills",
    ".claude/skills",
    ".codex/skills",
    ".gemini/skills",
    ".opencode/skills",
    ".omp/skills",
    ".pi/skills",
];

/// The repository's skill directories: cwd and its ancestors up to the checkout root.
fn repo_roots(cwd: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for ancestor in cwd.ancestors() {
        roots.extend(SKILL_DIRECTORIES.iter().map(|dir| ancestor.join(dir)));
        if ancestor.join(".git").exists() {
            break;
        }
    }
    roots
}

/// Your own skill directories, in your home directory.
fn user_roots(home: &Path) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = SKILL_DIRECTORIES.iter().map(|dir| home.join(dir)).collect();
    roots.push(home.join(".omp/agent/skills"));
    roots.push(home.join(".pi/agent/skills"));
    roots.push(home.join(".config/opencode/skills"));
    roots.push(home.join(".config/omp/skills"));
    roots
}

/// What may be published: this checkout's policy (.gitmatrix/agent.local.yml),
/// then the flags.
fn policy(args: &CapabilityArgs, cwd: &Path) -> crate::profile::SkillPolicy {
    let mut policy = crate::profile::root_from(cwd)
        .and_then(|root| crate::profile::local_at(&root).ok().flatten())
        .map(|local| local.skills)
        .unwrap_or_default();
    if let Some(publish) = args.publish_skills {
        policy.publish = publish;
    }
    policy.allow.extend(args.allow_skills.iter().cloned());
    policy.deny.extend(args.deny_skills.iter().cloned());
    policy
}

/// Discovered skills the policy publishes: the repository's (and any --skill-dir,
/// named on purpose), then user-level ones it allows that the repository
/// doesn't already have.
fn published(
    policy: &crate::profile::SkillPolicy,
    cwd: &Path,
    home: Option<&Path>,
    extra: &[PathBuf],
) -> Result<Vec<Skill>> {
    let mut skills: Vec<Skill> = discover(&repo_roots(cwd))?
        .into_iter()
        .filter(|s| policy.publishes(&s.name, false))
        .collect();
    let deny = |name: &str| policy.deny.iter().any(|d| d == name);
    for skill in discover(extra)? {
        if !deny(&skill.name) && !skills.iter().any(|s| s.name == skill.name) {
            skills.push(skill);
        }
    }
    if let Some(home) = home {
        for skill in discover(&user_roots(home))? {
            if policy.publishes(&skill.name, true) && !skills.iter().any(|s| s.name == skill.name) {
                skills.push(skill);
            }
        }
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(skills)
}

fn check(value: &str, max: usize, label: &str, empty: bool) -> Result<()> {
    if (!empty && value.trim().is_empty()) || value.encode_utf16().count() > max {
        return Err(GmError::usage(format!(
            "{label} must contain {}..{max} UTF-16 code units.",
            if empty { 0 } else { 1 }
        )));
    }
    Ok(())
}

pub fn merge(
    mut report: AgentCapabilities,
    previous: Option<&AgentCapabilities>,
    args: &CapabilityArgs,
) -> Result<AgentCapabilities> {
    // Explicit, then what the harness declares now, then what was recorded.
    report.model = if args.clear_model {
        None
    } else {
        args.model
            .clone()
            .or(report.model.take())
            .or_else(|| previous.and_then(|p| p.model.clone()))
    };
    if args.clear_harness {
        report.harness = None;
    } else if let Some(harness) = &args.harness {
        report.harness = Some(harness.clone());
    }
    if let Some(runtime) = &args.runtime {
        report.environment.runtime.clone_from(runtime);
    }
    for (label, value) in [("Model", &report.model), ("Harness", &report.harness)] {
        if let Some(value) = value {
            check(value, 120, label, true)?;
        }
    }
    report.tags = if args.clear_tags {
        vec![]
    } else if !args.tags.is_empty() {
        args.tags.clone()
    } else {
        previous.map(|p| p.tags.clone()).unwrap_or_default()
    };
    for tag in &report.tags {
        check(tag, 64, "Tag", false)?;
    }
    report.tags.sort();
    report.tags.dedup();
    if report.tags.len() > 64 {
        return Err(GmError::usage("At most 64 tags are allowed."));
    }
    let mut skills: BTreeMap<String, Skill> = report
        .skills
        .into_iter()
        .map(|s| (s.name.clone(), s))
        .collect();
    let declared = if !args.skills.is_empty() {
        args.skills
            .iter()
            .map(|s| {
                let (name, description) = s.split_once('=').unwrap_or((s, ""));
                Skill {
                    name: name.into(),
                    description: description.into(),
                    source: "declared".into(),
                }
            })
            .collect()
    } else if args.clear_skills {
        Vec::new()
    } else {
        previous
            .map(|p| {
                p.skills
                    .iter()
                    .filter(|s| s.source == "declared")
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    };
    for skill in declared {
        check(&skill.name, 128, "Skill name", false)?;
        check(&skill.description, 512, "Skill description", true)?;
        skills.insert(skill.name.clone(), skill);
    }
    if skills.len() > 256 {
        return Err(GmError::usage(
            "At most 256 skills are allowed; narrow discovery directories.",
        ));
    }
    report.skills = skills.into_values().collect();
    if serde_json::to_vec(&report)?.len() > 256 * 1024 {
        return Err(GmError::usage(
            "Capability profile exceeds 256 KiB; reduce skill descriptions or declarations.",
        ));
    }
    Ok(report)
}

pub fn detect(
    args: &CapabilityArgs,
    previous: Option<&AgentCapabilities>,
    cwd: &Path,
) -> Result<AgentCapabilities> {
    let extra: Vec<_> = args
        .skill_dirs
        .iter()
        .map(|path| {
            if path.is_absolute() {
                path.clone()
            } else {
                cwd.join(path)
            }
        })
        .collect();
    for path in &extra {
        if !path.is_dir() {
            return Err(GmError::usage(format!(
                "Skill directory does not exist or is not a directory: {}",
                path.display()
            )));
        }
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let report = AgentCapabilities {
        version: 1,
        harness: super::detect().map(|h| h.id.into()),
        // What the harness itself declares (ANTHROPIC_MODEL…), never a guess.
        model: crate::profile::declared_model(
            args.harness.as_deref().or(super::detect().map(|h| h.id)),
        ),
        environment: environment(),
        tags: vec![],
        skills: published(&policy(args, cwd), cwd, home.as_deref(), &extra)?,
    };
    merge(report, previous, args)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_model_comes_from_a_declaration_never_a_guess() {
        let with = |model: Option<&str>| AgentCapabilities {
            model: model.map(str::to_string),
            ..report()
        };
        let recorded = with(Some("model-a"));
        let none = CapabilityArgs::default();
        // What the harness declares now beats what was recorded before…
        assert_eq!(
            merge(with(Some("model-b")), Some(&recorded), &none)
                .unwrap()
                .model
                .as_deref(),
            Some("model-b")
        );
        // …an explicit --model beats both, and nothing declared keeps the record.
        let explicit = CapabilityArgs {
            model: Some("model-c".into()),
            ..Default::default()
        };
        assert_eq!(
            merge(with(Some("model-b")), Some(&recorded), &explicit)
                .unwrap()
                .model
                .as_deref(),
            Some("model-c")
        );
        assert_eq!(
            merge(with(None), Some(&recorded), &none)
                .unwrap()
                .model
                .as_deref(),
            Some("model-a")
        );
        assert_eq!(merge(with(None), None, &none).unwrap().model, None);
        // Harnesses without a documented model setting declare nothing.
        assert_eq!(crate::profile::declared_model(Some("codex")), None);
        assert_eq!(crate::profile::declared_model(None), None);
    }

    #[test]
    fn profiles_publish_the_repository_s_skills_unless_you_opt_in() {
        use crate::profile::{Publish, SkillPolicy};
        let repo = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        fs::create_dir(repo.path().join(".git")).unwrap();
        let skill = |dir: &Path, name: &str| {
            let path = dir.join(name);
            fs::create_dir_all(&path).unwrap();
            fs::write(
                path.join("SKILL.md"),
                format!("---\nname: {name}\ndescription: The {name} skill\n---\n\nBody\n"),
            )
            .unwrap();
        };
        skill(&repo.path().join(".agents/skills"), "graph-work");
        skill(&home.path().join(".claude/skills"), "morning");
        skill(&home.path().join(".claude/skills"), "deploy");
        let names = |policy: &SkillPolicy| -> Vec<String> {
            published(policy, repo.path(), Some(home.path()), &[])
                .unwrap()
                .into_iter()
                .map(|s| s.name)
                .collect()
        };
        // By default, only what the repository ships.
        assert_eq!(names(&SkillPolicy::default()), ["graph-work"]);
        // Opting in to one personal skill, or to all of them.
        let one = SkillPolicy {
            allow: vec!["deploy".into()],
            ..Default::default()
        };
        assert_eq!(names(&one), ["deploy", "graph-work"]);
        let all = SkillPolicy {
            publish: Publish::All,
            deny: vec!["morning".into()],
            ..Default::default()
        };
        assert_eq!(names(&all), ["deploy", "graph-work"]);
        // None publishes nothing discovered, and deny beats allow.
        let none = SkillPolicy {
            publish: Publish::None,
            ..Default::default()
        };
        assert!(names(&none).is_empty());
        let both = SkillPolicy {
            allow: vec!["deploy".into()],
            deny: vec!["deploy".into()],
            ..Default::default()
        };
        assert_eq!(names(&both), ["graph-work"]);
    }

    fn report() -> AgentCapabilities {
        AgentCapabilities {
            version: 1,
            harness: None,
            model: None,
            environment: Environment {
                os: "linux".into(),
                arch: "x86_64".into(),
                runtime: "unknown".into(),
                cpu_count: None,
                memory_bytes: None,
            },
            tags: vec![],
            skills: vec![],
        }
    }
    #[test]
    fn runtime_and_memory_boundaries() {
        assert_eq!(classify_runtime("Microsoft-standard-WSL2", true, ""), "wsl");
        assert_eq!(classify_runtime("Linux", true, "KVM"), "container");
        assert_eq!(classify_runtime("Linux", false, "KVM"), "vm");
        assert_eq!(classify_runtime("Linux", false, ""), "unknown");
        assert_eq!(limited_memory(8192, [0, 4096, 2048]), Some(2048));
        assert_eq!(limited_memory(0, [4096]), None);
        assert_eq!(limited_memory(u64::MAX, []), None);
    }
    #[test]
    fn yaml_metadata_is_bounded_and_not_prompt_text() {
        let skill = skill_metadata("---\nname: 'review: code'\ndescription: >-\n  Review code\n  carefully.\n---\nsecret prompt").unwrap();
        assert_eq!(skill.name, "review: code");
        assert_eq!(skill.description, "Review code carefully.");
        assert!(skill_metadata("---\nname: [bad]\ndescription: x\n---").is_none());
        assert!(skill_metadata("---\nname: x\ndescription: y").is_none());
        let text = format!(
            "---\nname: unicode\ndescription: '{}'\n---",
            "界".repeat(600)
        );
        assert_eq!(
            skill_metadata(&text).unwrap().description.chars().count(),
            512
        );
        let text = format!(
            "---\nname: unicode\ndescription: '{}'\n---",
            "\u{10000}".repeat(300)
        );
        assert_eq!(
            skill_metadata(&text).unwrap().description,
            "\u{10000}".repeat(256)
        );
        let args = CapabilityArgs {
            model: Some("\u{10000}".repeat(61)),
            ..Default::default()
        };
        assert!(merge(report(), None, &args).is_err());
    }
    #[test]
    fn declarations_survive_refresh_and_clear_explicitly() {
        let mut prior = report();
        prior.model = Some("explicit-model".into());
        prior.tags = vec!["rust".into()];
        prior.skills = vec![
            Skill {
                name: "review".into(),
                description: "manual".into(),
                source: "declared".into(),
            },
            Skill {
                name: "stale".into(),
                description: "old".into(),
                source: "detected".into(),
            },
        ];
        let result = merge(report(), Some(&prior), &CapabilityArgs::default()).unwrap();
        assert_eq!(result.model, prior.model);
        assert_eq!(result.tags, prior.tags);
        assert_eq!(result.skills, vec![prior.skills[0].clone()]);
        let args = CapabilityArgs {
            clear_model: true,
            clear_tags: true,
            clear_skills: true,
            ..Default::default()
        };
        let result = merge(report(), Some(&prior), &args).unwrap();
        assert!(result.model.is_none());
        assert!(result.tags.is_empty());
        assert!(result.skills.is_empty());
        let args = CapabilityArgs {
            tags: vec!["new".into(), "new".into()],
            skills: vec!["review=replaced".into()],
            ..Default::default()
        };
        let result = merge(report(), Some(&prior), &args).unwrap();
        assert_eq!(result.tags, ["new"]);
        assert_eq!(result.skills[0].description, "replaced");
    }
    #[test]
    fn cgroup_caps_include_parent_and_ignore_escape() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("child")).unwrap();
        fs::write(dir.path().join("memory.max"), "1024").unwrap();
        fs::write(dir.path().join("child/memory.max"), "max").unwrap();
        assert_eq!(
            limited_memory(8192, memory_limits("0::/child", dir.path())),
            Some(1024)
        );
        assert_eq!(memory_limits("0::/../../escape", dir.path()), vec![1024]);
    }
    #[cfg(unix)]
    #[test]
    fn symlinked_skills_and_cycles_are_safe() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let shared = tempfile::tempdir().unwrap();
        fs::write(
            shared.path().join("SKILL.md"),
            "---\nname: linked\ndescription: valid\n---\nprivate prompt",
        )
        .unwrap();
        symlink(shared.path(), dir.path().join("linked")).unwrap();
        symlink(dir.path(), dir.path().join("cycle")).unwrap();
        fs::create_dir(dir.path().join("unsafe")).unwrap();
        symlink("/dev/zero", dir.path().join("unsafe/SKILL.md")).unwrap();
        let found = discover(&[dir.path().to_path_buf()]).unwrap();
        assert_eq!(
            found,
            vec![Skill {
                name: "linked".into(),
                description: "valid".into(),
                source: "detected".into()
            }]
        );
    }
}
