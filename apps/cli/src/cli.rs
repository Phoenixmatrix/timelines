//! The command-line surface. Descriptions here feed `--help`, `gm cli search`
//! and `gm schema`, so they are written for agents as much as for people.

use crate::output::Format;
use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "gm",
    version,
    about = "gm: the Gitmatrix CLI. Change-based version control for agents and people.",
    long_about = None,
    disable_help_subcommand = true,
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,
    #[command(flatten)]
    pub global: Global,
}

#[derive(Args, Clone)]
pub struct Global {
    /// Output format. Defaults to json for agents and pipes, text at a terminal.
    #[arg(short = 'o', long, global = true, value_enum)]
    pub output: Option<Format>,
    /// Show what a mutating command would do without changing anything.
    #[arg(long, global = true)]
    pub dry_run: bool,
    /// Run as if gm was started in this directory.
    #[arg(short = 'C', long = "cwd", global = true, value_name = "DIR")]
    pub cwd: Option<PathBuf>,
}

#[derive(Subcommand)]
pub enum Command {
    /// Offline replicas, ordered sync, conflicts and tracker selection (no Git repository needed)
    Tracker(crate::tracker_cli::TrackerArgs),
    /// Tracker teams, membership and immutable issue-key prefixes
    Team(crate::tracker_cli::TeamArgs),
    /// Cross-team tracker workspaces and repository subscriptions
    Workspace(crate::tracker_cli::WorkspaceArgs),
    /// Agent-first issues, PRDs, dependency graph, checkpoints and fenced claims
    Issue(crate::tracker_cli::IssueArgs),
    /// Requests to people: what agents are waiting on, and answering them
    Request(crate::tracker_cli::RequestArgs),
    /// Show the working-copy change, its files and where it sits relative to trunk
    #[command(visible_alias = "st")]
    Status,
    /// List changes: your unpushed work and the trunk commit it builds on
    Log(LogArgs),
    /// Show one change: its description and diff
    Show(ShowArgs),
    /// Show the diff of a change (default: the working copy) or between two revisions
    Diff(DiffArgs),
    /// Set the description (commit message) of a change, by default the working copy
    #[command(visible_alias = "desc")]
    Describe(DescribeArgs),
    /// Start a new empty change on top of one or more revisions (several = a merge)
    New(NewArgs),
    /// Merge revisions (main, a bookmark, a change) into a new merge change below the working copy
    Merge(MergeArgs),
    /// Describe the working-copy change and start a new one on top: the "save my work" step
    #[command(visible_alias = "ci")]
    Commit(CommitArgs),
    /// Move a change's edits into another change (default: the working copy into its parent)
    Squash(SquashArgs),
    /// Split selected files out of a change into a new change before it
    Split(SplitArgs),
    /// Make an existing change the working copy, to keep editing it in place
    Edit(EditArgs),
    /// Drop changes; their descendants are rebased onto their parents
    Abandon(AbandonArgs),
    /// Discard edits: restore files from another revision (default: the parent)
    Restore(RestoreArgs),
    /// Move changes (and their descendants) onto another revision
    Rebase(RebaseArgs),
    /// Add a change that reverses another change, just below the working copy
    Backout(BackoutArgs),
    /// Copy a change (cherry-pick); by default insert the copy below the working copy
    Duplicate(DuplicateArgs),
    /// Undo the last operation; repeat to go further back
    Undo,
    /// Inspect or restore the operation log
    #[command(subcommand)]
    Op(OpCommand),
    /// Named pointers to changes (git branches)
    #[command(subcommand, visible_alias = "b")]
    Bookmark(BookmarkCommand),
    /// Read files at any revision without touching the working copy
    #[command(subcommand)]
    File(FileCommand),
    /// Why did these lines change? Blame, then the change's timelines, issues, checkpoints, approval and landing
    Why(WhyArgs),
    /// Manage isolated working copies sharing this repository's objects and bookmarks
    #[command(subcommand)]
    Worktree(WorktreeCommand),
    /// Start using gm in the current git repository
    Init,
    /// Clone a Gitmatrix repository and set it up for gm
    Clone(CloneArgs),
    /// Download new commits from Gitmatrix without changing your changes
    Fetch,
    /// Fetch, then rebase your changes onto the new trunk
    #[command(visible_alias = "pull")]
    Sync,
    /// Land changes on trunk (or a bookmark) on Gitmatrix. There are no pull requests.
    Push(PushArgs),
    /// Timelines: parallel lines of work on `timeline/<slug>` that land on main later
    #[command(subcommand, visible_alias = "tl")]
    Timeline(crate::commands::timeline::TimelineCommand),
    /// Sign in to a Gitmatrix server
    #[command(subcommand)]
    Auth(AuthCommand),
    /// Account-wide settings for a person or organization
    #[command(subcommand)]
    Settings(crate::commands::settings::SettingsCommand),
    /// Manage repositories on the Gitmatrix server
    #[command(subcommand)]
    Repo(RepoCommand),
    /// Syntax-level changes from the server's repository history
    #[command(subcommand)]
    Semantic(SemanticCommand),
    /// AI release notes written from commits, tracker issues and code changes
    #[command(subcommand)]
    Release(ReleaseCommand),
    /// CI/CD runs of .gitmatrix/ci.yml: list, inspect, read logs, wait for a result
    #[command(subcommand)]
    Runs(RunsCommand),
    /// Run queued CI jobs on this machine (how CI runs against the dev server)
    Runner(RunnerArgs),
    /// Deployment records: where commits are deployed (production, timeline previews)
    #[command(subcommand)]
    Deploy(crate::commands::deploy::DeployCommand),
    /// Secrets that CI jobs can read as environment variables
    #[command(subcommand)]
    Secret(SecretCommand),
    /// Agents: identities that work on their own, accountable to you
    #[command(subcommand)]
    Agent(AgentCommand),
    /// Ask the Gitmatrix assistant about code, issues, CI and packages (read-only unless --write)
    Ask(AskArgs),
    /// Your conversations with the assistant, from the web and gm ask
    #[command(subcommand)]
    Assistant(AssistantCommand),
    /// Packages: npm, Docker, PyPI, Cargo… versions, provenance and housekeeping
    #[command(subcommand, visible_alias = "packages")]
    Pkg(PkgCommand),
    /// Call the Gitmatrix JSON API directly
    Api(ApiArgs),
    /// Discover commands: search, workflow guide, full manifest
    #[command(subcommand)]
    Cli(CliCommand),
    /// Exact inputs and JSON output shape of a command
    Schema(SchemaArgs),
}

#[derive(Subcommand)]
pub enum WorktreeCommand {
    /// Create an initialized, detached worktree with its own working-copy change
    Add {
        /// Destination directory, relative to --cwd.
        path: PathBuf,
        /// Revision to build on; defaults to the current working-copy snapshot.
        #[arg(short, long, default_value = "@")]
        revision: String,
        /// Copy ignored files matching the source checkout's .worktreeinclude.
        /// The checkout's agent (.gitmatrix/agent.local.yml) is always copied.
        #[arg(long)]
        include: bool,
    },
    /// List the main checkout and linked worktrees, including non-gm worktrees
    List,
    /// Remove a linked worktree; its gm history is retained for recovery
    Remove {
        /// Worktree directory, relative to --cwd.
        path: PathBuf,
        /// Discard modified, untracked and ignored files; locked worktrees still refuse removal.
        #[arg(long)]
        force: bool,
    },
}

#[derive(Args)]
pub struct LogArgs {
    /// Revision or range: `@`, a change id, `A..B`, or `all`. Default: your mutable changes plus trunk.
    #[arg(short, long)]
    pub revisions: Option<String>,
    /// Maximum number of changes.
    #[arg(short = 'n', long, default_value_t = 50)]
    pub limit: usize,
}

#[derive(Args)]
pub struct ShowArgs {
    /// Revision to show.
    #[arg(default_value = "@")]
    pub revision: String,
    /// Only list files and line counts.
    #[arg(long)]
    pub stat: bool,
}

#[derive(Args)]
pub struct DiffArgs {
    /// Change to diff against its parent.
    #[arg(short, long, conflicts_with_all = ["from", "to"])]
    pub revision: Option<String>,
    /// Diff from this revision (with --to).
    #[arg(long)]
    pub from: Option<String>,
    /// Diff to this revision (default `@`).
    #[arg(long)]
    pub to: Option<String>,
    /// Only list files and line counts.
    #[arg(long)]
    pub stat: bool,
    /// Limit to these paths.
    pub paths: Vec<String>,
}

#[derive(Args)]
pub struct DescribeArgs {
    /// Change to describe.
    #[arg(default_value = "@")]
    pub revision: String,
    /// The description. Several -m flags become paragraphs.
    #[arg(short, long, required = true)]
    pub message: Vec<String>,
}

#[derive(Args)]
pub struct NewArgs {
    /// Parent revisions (default `@`). Two or more make a merge.
    pub revisions: Vec<String>,
    /// Description for the new change.
    #[arg(short, long)]
    pub message: Vec<String>,
}

#[derive(Args)]
pub struct MergeArgs {
    /// Revisions to merge into `@-`, e.g. `trunk` or a bookmark. Several make an octopus merge.
    #[arg(required = true)]
    pub revisions: Vec<String>,
    /// Description for the merge (default "Merge <revisions>").
    #[arg(short, long)]
    pub message: Vec<String>,
}

#[derive(Args)]
pub struct CommitArgs {
    /// Description for the change being committed (the current working copy).
    #[arg(short, long, required = true)]
    pub message: Vec<String>,
    /// Commit only these paths; the rest stays in the new working copy.
    pub paths: Vec<String>,
}

#[derive(Args)]
pub struct SquashArgs {
    /// Change to take edits from.
    #[arg(short, long, default_value = "@")]
    pub revision: String,
    /// Change to put them into (default: the parent of --revision).
    #[arg(long, visible_alias = "to")]
    pub into: Option<String>,
    /// New description for the destination.
    #[arg(short, long)]
    pub message: Vec<String>,
    /// Move only these paths.
    pub paths: Vec<String>,
}

#[derive(Args)]
pub struct SplitArgs {
    /// Change to split.
    #[arg(short, long, default_value = "@")]
    pub revision: String,
    /// Description for the new change holding the selected paths.
    #[arg(short, long, required = true)]
    pub message: Vec<String>,
    /// Paths to split out.
    #[arg(required = true)]
    pub paths: Vec<String>,
}

#[derive(Args)]
pub struct EditArgs {
    /// Change to edit.
    pub revision: String,
}

#[derive(Args)]
pub struct AbandonArgs {
    /// Changes to drop (default `@`).
    pub revisions: Vec<String>,
}

#[derive(Args)]
pub struct RestoreArgs {
    /// Take file contents from this revision (default: the parent of --into).
    #[arg(long)]
    pub from: Option<String>,
    /// Change to restore files in.
    #[arg(long, visible_alias = "to", default_value = "@")]
    pub into: String,
    /// Paths to restore (default: everything).
    pub paths: Vec<String>,
}

#[derive(Args)]
// Declared on the command, not the struct: a struct-level group would take in
// --destination too and refuse `-s X -d Y`.
#[command(group(clap::ArgGroup::new("what").multiple(false)))]
pub struct RebaseArgs {
    /// Rebase this change and its descendants.
    #[arg(short, long, group = "what")]
    pub source: Option<String>,
    /// Rebase only this change; its descendants stay where they are.
    #[arg(short, long, group = "what")]
    pub revision: Option<String>,
    /// Rebase the whole stack containing this change (default `@`).
    #[arg(short, long, group = "what")]
    pub branch: Option<String>,
    /// Destination (default `trunk`).
    #[arg(short, long, default_value = "trunk")]
    pub destination: String,
}

#[derive(Args)]
pub struct BackoutArgs {
    /// Change to reverse.
    #[arg(short, long)]
    pub revision: String,
}

#[derive(Args)]
pub struct DuplicateArgs {
    /// Change to copy.
    pub revision: String,
    /// Put the copy on top of this revision instead of below the working copy.
    #[arg(short, long)]
    pub destination: Option<String>,
}

#[derive(Subcommand)]
pub enum OpCommand {
    /// List recent operations, newest first
    Log {
        #[arg(short = 'n', long, default_value_t = 20)]
        limit: usize,
    },
    /// Put the repository back to how it was right after an operation
    Restore {
        /// Operation id from `gm op log`.
        operation: String,
    },
}

#[derive(Subcommand)]
pub enum BookmarkCommand {
    /// List local bookmarks and their remote counterparts
    List,
    /// Create or move a bookmark
    Set {
        name: String,
        /// Revision to point at.
        #[arg(short, long, default_value = "@")]
        revision: String,
    },
    /// Delete a bookmark
    Delete {
        name: String,
        /// Also delete it on the server.
        #[arg(long)]
        remote: bool,
    },
}

#[derive(Subcommand)]
pub enum FileCommand {
    /// Print a file's contents at a revision
    Show {
        path: String,
        #[arg(short, long, default_value = "@")]
        revision: String,
    },
    /// List files at a revision
    List {
        /// Only under this directory.
        path: Option<String>,
        #[arg(short, long, default_value = "@")]
        revision: String,
    },
}

#[derive(Args)]
pub struct WhyArgs {
    /// A file and line: `src/app.ts:12` or `src/app.ts:12-20`; or just the file, with --line.
    pub target: String,
    /// The line or range (12, 12-20), when the target names only the file.
    #[arg(short = 'L', long)]
    pub line: Option<String>,
    /// Revision to blame at (default: the working copy).
    #[arg(short, long = "rev", visible_alias = "revision", default_value = "@")]
    pub revision: String,
    /// Repository on the server as owner/name (default: this repository's origin).
    #[arg(short = 'R', long)]
    pub repo: Option<String>,
}

#[derive(Args)]
pub struct CloneArgs {
    /// Repository as owner/name.
    pub repository: String,
    /// Directory to clone into (default: the repository name).
    pub directory: Option<PathBuf>,
    /// Suppress live progress on stderr (the final result and errors remain).
    #[arg(short, long)]
    pub quiet: bool,
}

#[derive(Args)]
pub struct PushArgs {
    /// Change to push (default `@`, or `@-` when `@` is empty). Its ancestors go too.
    #[arg(short, long)]
    pub revision: Option<String>,
    /// Push to this bookmark instead of trunk, creating or moving it. In a checkout
    /// working in a timeline, trunk is `timeline/<slug>` and main is refused.
    #[arg(short, long)]
    pub bookmark: Option<String>,
    /// Fetch and rebase onto the latest trunk first.
    #[arg(long)]
    pub sync: bool,
}

#[derive(Subcommand)]
pub enum AuthCommand {
    /// Sign in: in the browser (default, device login), or with an SSH key, a token, or a dev persona
    Login {
        /// Approve this sign-in in the browser with a one-time code (the default without other flags).
        #[arg(long, conflicts_with_all = ["ssh", "persona", "token"])]
        device: bool,
        /// Sign in with an SSH key registered on the server, through your SSH agent or key files.
        #[arg(long, conflicts_with_all = ["persona", "token"])]
        ssh: bool,
        /// With --ssh: the key to use (fingerprint, key file, or part of its comment).
        #[arg(long, requires = "ssh")]
        key: Option<String>,
        /// Dev persona to mint a token for (priya, marco, jun, sam).
        #[arg(long, conflicts_with = "token")]
        persona: Option<String>,
        /// Existing personal access token (gmx_…).
        #[arg(long)]
        token: Option<String>,
        /// Server URL; also makes it the default. GM_SERVER signs in to a server
        /// for this run without changing the default.
        #[arg(long)]
        server: Option<String>,
    },
    /// SSH keys registered for signing in (`gm auth login --ssh`)
    #[command(subcommand)]
    SshKey(SshKeyCommand),
    /// Git credential helper: lets plain git use your gm sign-in, SSH keys included
    GitCredential {
        /// What git asks for: get, store or erase.
        operation: String,
    },
    /// Show who you are signed in as
    Status,
    /// Forget the stored token
    Logout,
}

#[derive(Subcommand)]
pub enum SshKeyCommand {
    /// Register a public key from your SSH agent or ~/.ssh (needs you signed in)
    Add {
        /// Which key: fingerprint, key file, or part of its comment (default: the first one found).
        #[arg(long)]
        key: Option<String>,
        /// Name shown for the key (default: its comment).
        #[arg(long)]
        title: Option<String>,
        /// Sessions from this key can clone and fetch but not push.
        #[arg(long)]
        read_only: bool,
    },
    /// Keys registered on the server, and the keys gm can use on this machine
    List,
    /// Unregister a key (by id or fingerprint); its sessions end at once
    Remove { key: String },
}

#[derive(Subcommand)]
pub enum RepoCommand {
    /// List repositories you can read
    List,
    /// Create a repository, empty or imported from a public Git URL
    Create {
        /// Repository name.
        name: String,
        /// Owner (you, or an org you belong to). Default: you.
        #[arg(long)]
        owner: Option<String>,
        #[arg(long)]
        description: Option<String>,
        /// Make it public (default private).
        #[arg(long)]
        public: bool,
        /// Import from this public https:// Git URL.
        #[arg(long)]
        import: Option<String>,
    },
    /// Show a repository with its branches (default: the current one)
    View { repository: Option<String> },
    /// Delete a repository on the server, permanently
    Delete {
        repository: String,
        /// Required: confirms the deletion.
        #[arg(long)]
        yes: bool,
    },
    /// Push every push on to another git host (a one-way backup, e.g. GitHub)
    #[command(subcommand)]
    Mirror(MirrorCommand),
}

#[derive(Subcommand)]
pub enum MirrorCommand {
    /// The repository's mirror and how its last sync went
    Show {
        #[arg(short = 'R', long)]
        repo: Option<String>,
    },
    /// Create or change the mirror; the token comes from --token-stdin
    Set {
        /// HTTPS clone URL to push to, e.g. https://github.com/owner/name.git
        url: Option<String>,
        #[arg(short = 'R', long)]
        repo: Option<String>,
        /// Read a token with push access from stdin (kept if omitted).
        #[arg(long)]
        token_stdin: bool,
        /// Username sent with the token (GitHub accepts any).
        #[arg(long)]
        username: Option<String>,
        /// Also delete tags (and the default branch) on the target that are gone here.
        #[arg(long, overrides_with = "no_prune")]
        prune: bool,
        #[arg(long)]
        no_prune: bool,
        /// Pause mirroring without forgetting the settings.
        #[arg(long, overrides_with = "enable")]
        disable: bool,
        #[arg(long)]
        enable: bool,
    },
    /// Sync now and wait for the result
    Sync {
        #[arg(short = 'R', long)]
        repo: Option<String>,
    },
    /// Stop mirroring (the target keeps what it has)
    Remove {
        #[arg(short = 'R', long)]
        repo: Option<String>,
    },
}

#[derive(Subcommand)]
pub enum ReleaseCommand {
    /// Releases with notes: unreleased work first, then tags newest first
    List {
        /// Repository as owner/name (default: this repository's origin).
        #[arg(short = 'R', long)]
        repo: Option<String>,
    },
    /// One release's notes (default: the newest release with entries)
    Notes(ReleaseNotesArgs),
    /// A tracker account's notes across repositories, filtered by facets
    Feed(ReleaseFeedArgs),
}

#[derive(Args)]
pub struct ReleaseFeedArgs {
    /// Filters and words, e.g. `type:fix repo:engine since:30d`; keys are team, repo,
    /// ws, type, label, release, since and until, negated with a leading `-`.
    pub query: Vec<String>,
    /// Only this team's work (adds `team:KEY`).
    #[arg(long)]
    pub team: Option<String>,
    /// Tracker account/organization slug; otherwise use saved tracker context.
    #[arg(long)]
    pub owner: Option<String>,
    /// Include internal entries (chores, refactors, tests, tooling).
    #[arg(long)]
    pub internal: bool,
}

#[derive(Args)]
pub struct ReleaseNotesArgs {
    /// A tag, or `unreleased` for the default branch's work since the newest tag.
    pub release: Option<String>,
    /// Repository as owner/name (default: this repository's origin).
    #[arg(short = 'R', long)]
    pub repo: Option<String>,
    /// Include internal entries (chores, refactors, tests, tooling).
    #[arg(long)]
    pub internal: bool,
}

#[derive(Subcommand)]
pub enum SemanticCommand {
    /// One page of individual semantic changes, with source links and analysis coverage
    List(SemanticListArgs),
}

#[derive(Args)]
pub struct SemanticListArgs {
    /// Repository as owner/name (default: this repository's origin).
    #[arg(short = 'R', long)]
    pub repo: Option<String>,
    /// Server branch or commit id (default: repository default branch).
    #[arg(long = "ref")]
    pub reference: Option<String>,
    /// Opaque nextCursor from the previous page; keep the same filters.
    #[arg(long)]
    pub cursor: Option<String>,
    /// Maximum entries in this page; empty pages may still have a nextCursor.
    #[arg(short = 'n', long, default_value_t = 30, value_parser = clap::value_parser!(u32).range(1..))]
    pub limit: u32,
    /// Exact repository-relative file path.
    #[arg(long)]
    pub path: Option<String>,
    /// Exact change kind, e.g. symbol.added or symbol.signature_changed.
    #[arg(long)]
    pub kind: Option<String>,
    /// Language: typescript, tsx, rust, python, go, markdown, xml, json, html, css.
    #[arg(long)]
    pub language: Option<String>,
}

#[derive(Subcommand)]
pub enum RunsCommand {
    /// Recent runs, newest first
    List {
        /// Repository as owner/name (default: this repository's origin).
        #[arg(short = 'R', long)]
        repo: Option<String>,
        #[arg(short = 'n', long, default_value_t = 20)]
        limit: usize,
    },
    /// One run with its jobs and steps (default: the latest run)
    Show {
        number: Option<i64>,
        #[arg(short = 'R', long)]
        repo: Option<String>,
    },
    /// Output of a run's jobs (default: the latest run, every job)
    Logs {
        number: Option<i64>,
        /// Only this job.
        #[arg(short, long)]
        job: Option<String>,
        #[arg(short = 'R', long)]
        repo: Option<String>,
        /// Keep streaming until the jobs finish (text output).
        #[arg(short, long)]
        follow: bool,
    },
    /// Block until a run finishes; exits 0 only if it succeeded. Default: the run for trunk.
    Wait {
        /// Run number. Default: the newest run for --commit.
        number: Option<i64>,
        /// Revision or commit hash whose run to wait for (default `trunk`).
        #[arg(short, long, conflicts_with = "number")]
        commit: Option<String>,
        #[arg(short = 'R', long)]
        repo: Option<String>,
        /// Give up after this many seconds.
        #[arg(long, default_value_t = 1800)]
        timeout: u64,
    },
    /// Start a run of a branch by hand
    Start {
        /// Branch (default: the repository's default branch).
        #[arg(long)]
        r#ref: Option<String>,
        #[arg(short = 'R', long)]
        repo: Option<String>,
    },
    /// Cancel a queued or running run
    Cancel {
        number: i64,
        #[arg(short = 'R', long)]
        repo: Option<String>,
    },
    /// Run the same commit again
    Rerun {
        number: i64,
        #[arg(short = 'R', long)]
        repo: Option<String>,
    },
}

#[derive(Args)]
pub struct RunnerArgs {
    /// Only take jobs from this repository (owner/name).
    #[arg(short = 'R', long)]
    pub repo: Option<String>,
    /// Name shown on the jobs this runner takes (default: the host name).
    #[arg(long)]
    pub name: Option<String>,
    /// Take at most one job, then exit (exits right away when none is queued).
    #[arg(long)]
    pub once: bool,
    /// Seconds between polls for work.
    #[arg(long, default_value_t = 2)]
    pub poll: u64,
    /// Where jobs check out code (default: ~/.cache/gitmatrix/runner).
    #[arg(long)]
    pub workdir: Option<PathBuf>,
    /// Echo job output here as well as to the server.
    #[arg(short, long)]
    pub verbose: bool,
}

#[derive(Subcommand)]
pub enum SecretCommand {
    /// Secret names (values are never shown)
    List {
        #[arg(short = 'R', long)]
        repo: Option<String>,
    },
    /// Create or replace a secret; the value comes from --value or stdin
    Set {
        name: String,
        #[arg(long)]
        value: Option<String>,
        #[arg(short = 'R', long)]
        repo: Option<String>,
    },
    /// Remove a secret
    Delete {
        name: String,
        #[arg(short = 'R', long)]
        repo: Option<String>,
    },
}

#[derive(Subcommand)]
pub enum AgentCommand {
    /// Set up this checkout for a coding agent: instructions, skills, identity and profile. Rerun to update.
    Setup {
        /// Agent name (default: a memorable generated name; kept on reruns)
        #[arg(long)]
        name: Option<String>,
        /// claude-code, codex, cursor-agent, gemini-agent, opencode…; detected when an agent runs this
        #[arg(long)]
        harness: Option<String>,
        /// The model it runs (never inferred)
        #[arg(long)]
        model: Option<String>,
        /// Add a profile tag (repeat)
        #[arg(long = "tag")]
        tags: Vec<String>,
        /// Remove a profile tag (repeat)
        #[arg(long = "drop-tag")]
        drop_tags: Vec<String>,
        /// Tracker owner; seeds .gitmatrix/agents.yml (default: origin's owner)
        #[arg(long)]
        owner: Option<String>,
        /// Team `gm issue next` picks from
        #[arg(long)]
        team: Option<String>,
        /// Only work under this issue, e.g. a project
        #[arg(long)]
        under: Option<String>,
        /// Lease seconds
        #[arg(long, value_parser=clap::value_parser!(u32).range(30..=86400))]
        ttl: Option<u32>,
        /// Human intervention: autonomous records requests and continues scoped work; harness keeps its own behavior. New projects default to autonomous; existing projects save an override for this checkout.
        #[arg(long)]
        intervention: Option<crate::profile::InterventionMode>,
        /// Only write the files; don't create the agent, keep a token or publish its profile
        #[arg(long)]
        no_identity: bool,
        /// Report what's out of date without changing anything (exit 4 if stale)
        #[arg(long)]
        check: bool,
        /// Which discovered skills its profile publishes: repo (default), all (adds your user-level skills) or none; saved for this checkout
        #[arg(long = "publish-skills")]
        publish_skills: Option<crate::profile::Publish>,
        /// Publish this skill whatever the scope (repeat; saved)
        #[arg(long = "allow-skill")]
        allow_skills: Vec<String>,
        /// Never publish this skill (repeat; saved)
        #[arg(long = "deny-skill")]
        deny_skills: Vec<String>,
    },
    /// Your agents and advisory capabilities, optionally from an owner's tracker
    List {
        #[arg(long)]
        owner: Option<String>,
    },
    /// Detect local advisory capabilities without network access
    Detect {
        #[command(flatten)]
        capabilities: CapabilityArgs,
    },
    /// Create or refresh a named owned agent, or the authenticated agent itself
    Configure {
        name: Option<String>,
        #[command(flatten)]
        capabilities: CapabilityArgs,
    },
    /// Show a named owned agent, or the authenticated agent itself
    Show { name: Option<String> },
    /// Create an agent accountable to you
    Create {
        /// Lowercase letters, digits and hyphens, e.g. builder
        name: String,
        #[arg(long)]
        description: Option<String>,
    },
    /// Mint a token the agent signs in with (shown once)
    Token {
        /// The agent's name or id
        name: String,
        /// What to call the token
        #[arg(long = "name")]
        label: Option<String>,
        /// read or write
        #[arg(long, default_value = "write")]
        scope: String,
    },
    /// Revoke an agent; its tokens stop working at once
    Revoke {
        /// The agent's name or id
        name: String,
    },
}

#[derive(Args, Debug, Default)]
pub struct CapabilityArgs {
    /// Explicit harness identifier (otherwise detected)
    #[arg(long, conflicts_with = "clear_harness")]
    pub harness: Option<String>,
    #[arg(long)]
    pub clear_harness: bool,
    /// Explicit model identifier; never inferred from harness
    #[arg(long, conflicts_with = "clear_model")]
    pub model: Option<String>,
    #[arg(long)]
    pub clear_model: bool,
    /// Override detected runtime classification
    #[arg(long, value_parser = ["host", "container", "vm", "wsl", "cloudflare-worker", "unknown"])]
    pub runtime: Option<String>,
    /// Replace tags with this repeatable set
    #[arg(long = "tag", conflicts_with = "clear_tags")]
    pub tags: Vec<String>,
    #[arg(long)]
    pub clear_tags: bool,
    /// Replace declared skills with NAME or NAME=DESCRIPTION (repeatable)
    #[arg(long = "skill", conflicts_with = "clear_skills")]
    pub skills: Vec<String>,
    /// Remove declared skills; detected skills are still refreshed
    #[arg(long)]
    pub clear_skills: bool,
    /// Additional directory containing skill directories or a SKILL.md (always published)
    #[arg(long = "skill-dir")]
    pub skill_dirs: Vec<PathBuf>,
    /// Which discovered skills to publish: repo (default), all (adds your user-level skills) or none;
    /// otherwise .gitmatrix/agent.local.yml's skills.publish
    #[arg(long = "publish-skills")]
    pub publish_skills: Option<crate::profile::Publish>,
    /// Publish this skill whatever the scope (repeat)
    #[arg(long = "allow-skill")]
    pub allow_skills: Vec<String>,
    /// Never publish this skill (repeat)
    #[arg(long = "deny-skill")]
    pub deny_skills: Vec<String>,
}

#[derive(Args)]
pub struct AskArgs {
    /// The question; '-' reads it from stdin.
    #[arg(required = true, num_args = 1.., trailing_var_arg = true)]
    pub question: Vec<String>,
    /// owner/name it's about; defaults to this checkout's repository.
    #[arg(short = 'R', long)]
    pub repo: Option<String>,
    /// Continue a conversation (an id from the last answer or `gm assistant list`).
    #[arg(long)]
    pub chat: Option<String>,
    /// Let the assistant make changes (create issues, comment, rerun CI…) without asking.
    #[arg(long)]
    pub write: bool,
}

#[derive(Subcommand)]
pub enum AssistantCommand {
    /// Your conversations, newest first
    List,
    /// A conversation's messages and what the assistant did
    Show { id: String },
    /// Delete a conversation
    Delete { id: String },
}

#[derive(Args)]
pub struct ApiArgs {
    /// HTTP method.
    pub method: String,
    /// Path under /api, e.g. /repos.
    pub path: String,
    /// JSON request body.
    #[arg(short, long)]
    pub data: Option<String>,
}

#[derive(Subcommand)]
pub enum CliCommand {
    /// Find commands by describing what you want to do
    Search {
        /// What you want to do, in plain words.
        query: Vec<String>,
    },
    /// The gm workflow in one page, for agents and AGENTS.md
    Guide,
    /// Every command with its arguments, as JSON
    Commands,
}

#[derive(Args)]
pub struct SchemaArgs {
    /// Command path, e.g. `push` or `bookmark set`.
    #[arg(required = true)]
    pub command: Vec<String>,
}

/// A package is `<format>/<name>`: `npm/@orbit/web`, `oci/engine`, `pypi/orbit-sdk`.
#[derive(Subcommand)]
pub enum PkgCommand {
    /// An owner's packages, most recently published first
    List {
        /// Owner (user or org). Default: this repository's owner, else you.
        #[arg(short = 'O', long)]
        owner: Option<String>,
    },
    /// One package: latest version, tags, sources, counts and the install command
    Show {
        package: String,
        #[arg(short = 'O', long)]
        owner: Option<String>,
    },
    /// A package's publishes, newest first, filtered by a query
    Versions {
        package: String,
        /// source:web branch:main status:active since:7d commit:ab12 run:42 by:jun tag:latest; words match versions; - excludes.
        #[arg(short, long, default_value = "status:active")]
        query: String,
        #[arg(short = 'n', long, default_value_t = 50)]
        limit: usize,
        #[arg(long, default_value_t = 0)]
        offset: usize,
        #[arg(short = 'O', long)]
        owner: Option<String>,
    },
    /// Delete versions (owner admins); name them, or select them with --query
    Delete(PkgAction),
    /// Yank versions (Cargo, PyPI): still resolvable when pinned, never chosen
    Yank(PkgAction),
    /// Undo a yank or a deprecation
    Restore(PkgAction),
    /// Deprecate npm versions with a message
    Deprecate(PkgAction),
    /// Point a tag at a version (npm dist-tag, Docker tag)
    Tag {
        package: String,
        version: String,
        tag: String,
        #[arg(short = 'O', long)]
        owner: Option<String>,
    },
    /// Repositories allowed to publish a package
    Sources {
        package: String,
        #[arg(short = 'O', long)]
        owner: Option<String>,
    },
    /// Allow a repository (owner/name) to publish a package
    Grant {
        package: String,
        repo: String,
        #[arg(short = 'O', long)]
        owner: Option<String>,
    },
    /// Stop a repository publishing a package
    Revoke {
        package: String,
        repo: String,
        #[arg(short = 'O', long)]
        owner: Option<String>,
    },
    /// What a CI run or a commit published (default: the latest run)
    Published {
        /// Run number.
        #[arg(long, conflicts_with = "commit")]
        run: Option<i64>,
        /// Full commit hash.
        #[arg(long)]
        commit: Option<String>,
        #[arg(short = 'R', long)]
        repo: Option<String>,
    },
    /// Upload a file as a generic package: gm pkg upload dist/app.tgz app/1.4.0
    Upload {
        file: PathBuf,
        /// <name>/<version>[/<path>]; the file name is used when no path is given.
        target: String,
        #[arg(short = 'O', long)]
        owner: Option<String>,
    },
    /// Download a generic artifact, verifying its SHA-256 before saving
    Download {
        /// <name>/<version>/<path>; use latest to resolve the newest published version.
        target: String,
        #[arg(short = 'O', long)]
        owner: Option<String>,
        /// Destination file (default: the artifact's basename).
        #[arg(long)]
        dest: Option<PathBuf>,
        /// Atomically replace an existing regular file.
        #[arg(long)]
        force: bool,
    },
    /// Install a Unix CLI artifact into ~/.local/bin (no installer scripts or archives)
    Install {
        /// Generic package and installed executable name.
        name: String,
        #[arg(short = 'O', long)]
        owner: Option<String>,
        #[arg(long, default_value = "latest")]
        version: String,
        /// Artifact path within the version (default: <os>-<arch>/<name>).
        #[arg(long)]
        file: Option<String>,
        #[arg(long)]
        bin_dir: Option<PathBuf>,
        /// Atomically replace an existing executable, including this running gm.
        #[arg(long)]
        force: bool,
    },
    /// Configure npm, Docker, pip, Cargo… on this machine for an owner's registries
    Setup {
        #[arg(short = 'O', long)]
        owner: Option<String>,
        /// Also write it: npm (~/.npmrc) and docker (docker login).
        #[arg(long, value_delimiter = ',')]
        write: Vec<String>,
    },
}

#[derive(Args)]
pub struct PkgAction {
    pub package: String,
    /// Versions to act on.
    pub versions: Vec<String>,
    /// Everything this query matches instead (up to 1,000 per call).
    #[arg(short, long, conflicts_with = "versions")]
    pub query: Option<String>,
    /// Why (shown to npm users on deprecation; recorded on yanks).
    #[arg(long)]
    pub reason: Option<String>,
    #[arg(short = 'O', long)]
    pub owner: Option<String>,
}
