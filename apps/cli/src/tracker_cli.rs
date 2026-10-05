//! Agent-first tracker commands; no Git checkout is required.
use clap::{Args, Subcommand};
use std::path::PathBuf;

#[derive(Args)]
pub struct TrackerArgs {
    #[command(flatten)]
    pub scope: Scope,
    #[command(subcommand)]
    pub command: TrackerCommand,
}
#[derive(Args)]
pub struct TeamArgs {
    #[command(flatten)]
    pub scope: Scope,
    #[command(subcommand)]
    pub command: TeamCommand,
}
#[derive(Args)]
pub struct RequestArgs {
    #[command(flatten)]
    pub scope: Scope,
    #[command(subcommand)]
    pub command: RequestCommand,
}
#[derive(Subcommand)]
pub enum RequestCommand {
    /// Requests to people in this tracker: yours first. Include answers to resume parked work.
    List {
        #[arg(long, default_value="open", value_parser=["open","answered","canceled","all"])]
        status: String,
        /// Limit requests to an issue's canonical ID or key.
        #[arg(long)]
        issue: Option<String>,
    },
    /// Answer a request: --answer for a question, --choice for a decision, --approve/--reject; a credential asks for its value (hidden) and stores it as its secret.
    Answer {
        id: String,
        #[arg(long)]
        answer: Option<String>,
        #[arg(long)]
        choice: Option<String>,
        #[arg(long, conflicts_with = "reject")]
        approve: bool,
        #[arg(long)]
        reject: bool,
    },
    /// Withdraw a request you asked.
    Cancel { id: String },
}
#[derive(Args)]
pub struct WorkspaceArgs {
    #[command(flatten)]
    pub scope: Scope,
    #[command(subcommand)]
    pub command: WorkspaceCommand,
}
#[derive(Args)]
pub struct IssueArgs {
    #[command(flatten)]
    pub scope: Scope,
    #[command(subcommand)]
    pub command: IssueCommand,
}
#[derive(Args)]
pub struct Scope {
    /// Tracker account/organization slug; otherwise use saved tracker context.
    #[arg(long, global = true)]
    pub owner: Option<String>,
    /// Use only this private SQLite replica. Never automatically falls back offline.
    #[arg(long, global = true)]
    pub offline: bool,
    /// Work in a timeline (its slug): read its view of the issues, and make changes in it.
    /// Defaults to GM_TIMELINE, then this checkout's timeline (`gm timeline use`);
    /// `main` is main's view.
    #[arg(long, global = true)]
    pub timeline: Option<String>,
}
impl Scope {
    /// The timeline selected, if any: None for main. Without `--timeline`, the
    /// one gm works in here (`profile::timeline`: GM_TIMELINE, then the checkout's
    /// binding), so a checkout bound to a timeline tags its tracker changes too.
    pub fn timeline(&self) -> Option<String> {
        match &self.timeline {
            Some(slug) => Some(slug.clone()).filter(|slug| !slug.is_empty() && slug != "main"),
            None => crate::profile::timeline(),
        }
    }
}
#[derive(Subcommand)]
pub enum TrackerCommand {
    /// List trackers visible to the authenticated account (online only).
    List,
    /// Select a tracker and initialize its authenticated offline replica.
    Use { owner: String },
    /// Replay ordered durable operations, then pull the cursor feed.
    Sync,
    /// Show replica cursor, pending operations and identity.
    Status,
    /// Show blocked operations with preserved local edits and current server data.
    Conflicts,
    /// Resolve the head conflict explicitly; later operations remain queued.
    Resolve {
        operation: String,
        #[arg(long, value_parser=["accept-server", "reapply-local"])]
        strategy: String,
    },
    /// Read bounded authoritative changes after an explicit cursor (online only).
    Changes {
        #[arg(long, default_value_t = 0)]
        after: u64,
        #[arg(long, default_value_t=100, value_parser=clap::value_parser!(u16).range(1..=200))]
        limit: u16,
    },
    /// Recover an old credential partition's outbox after verifying the same server identity.
    Recover { replica: PathBuf },
}
#[derive(Args)]
pub struct EntityCreate {
    /// Immutable team key or workspace slug.
    pub key: String,
    #[arg(long)]
    pub name: String,
    #[arg(long, default_value = "")]
    pub description: String,
}
#[derive(Args)]
pub struct Patch {
    /// Canonical ID, team key or workspace slug.
    pub id: String,
    /// JSON object of mutable fields; use '-' for stdin or '@path' for a file.
    /// Team fields: name, description, memberIds and archived. Workspace fields:
    /// name, description and archived. Member IDs are canonical.
    #[arg(long)]
    pub data: String,
}
#[derive(Subcommand)]
pub enum TeamCommand {
    /// List teams and membership.
    List,
    /// Create a team with an immutable issue-key prefix.
    Create(EntityCreate),
    /// Update name, description, memberIds or archived with version checking.
    Update(Patch),
}
#[derive(Subcommand)]
pub enum WorkspaceCommand {
    /// List cross-team workspaces.
    List,
    /// Create a workspace with an immutable slug.
    Create(EntityCreate),
    /// Update name, description or archived with version checking.
    Update(Patch),
    /// Associate an authorized repository ID with a workspace; grants no membership.
    Subscribe {
        workspace: String,
        #[arg(long)]
        repo: String,
    },
    /// Remove a subscription by its canonical ID.
    Unsubscribe { id: String },
}
#[derive(Args)]
pub struct IssueCreate {
    pub title: String,
    /// Defaults to this checkout's or the project's team, then your default team (set on the web).
    #[arg(long)]
    pub team: Option<String>,
    #[arg(long, conflicts_with = "description_file")]
    pub description: Option<String>,
    /// Markdown file, or '-' for stdin.
    #[arg(long)]
    pub description_file: Option<PathBuf>,
    #[arg(long, conflicts_with = "acceptance_file")]
    pub acceptance: Option<String>,
    /// Acceptance criteria file, or '-' for stdin.
    #[arg(long)]
    pub acceptance_file: Option<PathBuf>,
    #[arg(long, default_value="task", value_parser=["task","bug","prd","chore","research","remediation"])]
    pub r#type: String,
    #[arg(long, default_value="todo", value_parser=["backlog","todo","in_progress","done","canceled"])]
    pub status: String,
    /// Required for canceled issues; forbidden for other statuses.
    #[arg(long, value_parser=["duplicate","not_planned","obsolete","cannot_reproduce","other"])]
    pub close_reason: Option<String>,
    /// Who may pick up the issue: anyone (default), nobody yet, or people only.
    #[arg(long, default_value="anyone", value_parser=["anyone","not_ready","human_only"])]
    pub pickup: String,
    #[arg(long, default_value_t=2, value_parser=clap::value_parser!(u8).range(0..=4))]
    pub priority: u8,
    #[command(flatten)]
    pub timeline: TimelineRule,
    #[arg(long)]
    pub parent: Option<String>,
    #[arg(long)]
    pub assignee: Option<String>,
    #[arg(long)]
    pub workspace: Vec<String>,
    /// Work-area tag from the tracker's tag catalog; repeat for each area (e.g. --tag ux
    /// --tag frontend). `gm issue tags` lists the catalog; a new name is added to it.
    /// Tags describe the issue and do not restrict claims; --requires says which agents
    /// may claim it. (`--label` is the old name of this flag.)
    #[arg(long = "tag", alias = "label", value_name = "TAG")]
    pub tags: Vec<String>,
    #[command(flatten)]
    pub requires: RequiresArgs,
}
/// What an agent must report (`gm agent setup`) to claim the issue (`requires`).
#[derive(Args)]
pub struct RequiresArgs {
    /// Which agents may claim it, from what they report (`gm agent setup`):
    /// space-separated terms like 'tag:ux skill:playwright model:claude-opus-*,gpt-5*
    /// harness:claude-code os:linux arch:x86_64 runtime:host memory>=16GiB cpus>=8'.
    /// Tags and skills: every one; the rest: any one; `*` is a wildcard. Agents that
    /// don't meet them can't claim it and `gm issue next` skips it. People bypass
    /// capability requirements, but not pickup policy.
    #[arg(long, value_name = "TERMS")]
    pub requires: Option<String>,
}
/// Whether an agent works the issue in a timeline (`timelineUse`, `timelinePolicy`).
#[derive(Args)]
pub struct TimelineRule {
    /// Whether agents work this issue in a timeline: agent_decides (the default; the
    /// agent also reads the description or PRD), required or never.
    #[arg(long, value_parser=["agent_decides","required","never"])]
    pub timeline_use: Option<String>,
    /// With required: the policy the agent's timeline must use (auto or approval);
    /// none leaves it to the agent.
    #[arg(long, value_parser=["auto","approval","none"])]
    pub timeline_policy: Option<String>,
}
#[derive(Args)]
pub struct IssuePatch {
    /// Canonical ID or issue key.
    pub id: String,
    /// JSON object of mutable fields; use '-' for stdin or '@path' for a file:
    /// title, description, acceptance, type, status, closeReason, timelineUse,
    /// timelinePolicy, priority (0–4), assigneeId, parentId, workspaceIds, tags
    /// (the whole list; `labels` is its old name), pickup and requires (an object,
    /// or null; --requires writes it from terms).
    /// Relationships use canonical IDs; null clears assigneeId/parentId.
    /// Setting status to canceled requires closeReason: duplicate, not_planned,
    /// obsolete, cannot_reproduce or other. Leaving canceled clears closeReason
    /// automatically, as leaving required clears timelinePolicy.
    #[arg(long, required_unless_present_any=["timeline_use","timeline_policy","requires","clear_requires","pickup","tags","drop_tags","require_issue_tags"])]
    pub data: Option<String>,
    /// Pickup policy; only a person can change an existing restricted policy.
    #[arg(long, value_parser=["anyone","not_ready","human_only"])]
    pub pickup: Option<String>,
    /// Add a tag from the tracker's tag catalog (repeat); keeps its other tags.
    /// (`--label` is the old name of this flag.)
    #[arg(long = "tag", alias = "label", value_name = "TAG")]
    pub tags: Vec<String>,
    /// Remove a tag (repeat).
    #[arg(long = "drop-tag", value_name = "TAG")]
    pub drop_tags: Vec<String>,
    /// Require agents tagged with this issue's saved tags: adds a `tag:` term for
    /// each to its requirements.
    #[arg(long)]
    pub require_issue_tags: bool,
    /// When new requirements no longer allow the agent holding the issue, release
    /// its claim instead of keeping it (tracker owners and the agent's person).
    /// Either way gm prints who's affected and the issue records it.
    #[arg(long)]
    pub release_claim: bool,
    #[command(flatten)]
    pub timeline: TimelineRule,
    #[command(flatten)]
    pub requires: RequiresArgs,
    /// Remove capability requirements (requires: null); does not change pickup policy.
    #[arg(long, conflicts_with = "requires")]
    pub clear_requires: bool,
}
#[derive(Args)]
pub struct ListIssues {
    /// Defaults to this checkout's or the project's team, then your default team (set on the web).
    #[arg(long, conflicts_with = "all_teams")]
    pub team: Option<String>,
    /// Ignore every default team and list across all teams.
    #[arg(long)]
    pub all_teams: bool,
    #[arg(long)]
    pub workspace: Option<String>,
    #[arg(long)]
    pub status: Option<String>,
    /// Filter by issue type, including automatic queue remediation.
    #[arg(long, value_parser=["task","bug","prd","chore","research","remediation"])]
    pub r#type: Option<String>,
    #[arg(long)]
    pub search: Option<String>,
    #[arg(long, default_value_t=50, value_parser=clap::value_parser!(u16).range(1..=500))]
    pub limit: u16,
}
#[derive(Args)]
pub struct Note {
    pub issue: String,
    /// Markdown text; '-' reads stdin and '@path' reads a file.
    pub body: String,
}
#[derive(Args)]
pub struct Lease {
    pub issue: String,
    /// Fencing token; defaults to the one gm kept when this identity claimed the issue.
    /// Otherwise prefer GM_LEASE_TOKEN to avoid shell history/process arguments.
    #[arg(long, env = "GM_LEASE_TOKEN", hide_env_values = true)]
    pub lease_token: Option<String>,
}
/// Delegation inside a leased subtree: the covering lease's token, and who the claim is for.
#[derive(Args)]
pub struct Delegation {
    /// The lease token of the issue whose subtree this is; prefer GM_UNDER_TOKEN.
    #[arg(long, env = "GM_UNDER_TOKEN", hide_env_values = true)]
    pub under_token: Option<String>,
    /// Hold the claim as one of your agents (name or id) instead of yourself.
    #[arg(long = "for")]
    pub for_agent: Option<String>,
}
#[derive(Subcommand)]
pub enum IssueCommand {
    /// Create a ticket or full Markdown PRD with a stable offline ID.
    Create(Box<IssueCreate>),
    /// List issues with bounded filtering.
    List(ListIssues),
    /// Find unblocked, unclaimed work; offline readiness is advisory only.
    Ready(ListIssues),
    /// The tracker's tag catalog: every tag defined (kept after its last use), with how many issues carry it.
    Tags,
    /// Inspect an issue and bounded ancestors, blockers, dependents and notes, with its requirements and whether the acting agent meets them.
    Show {
        issue: String,
        #[arg(long, default_value_t=30, value_parser=clap::value_parser!(u16).range(1..=200))]
        limit: u16,
    },
    /// Read the complete audit trail, newest first (online only).
    History {
        /// Canonical issue ID or key.
        issue: String,
        /// Exclusive cursor from the previous page's nextBefore.
        #[arg(long)]
        before: Option<u64>,
        #[arg(long, default_value_t=50, value_parser=clap::value_parser!(u16).range(1..=100))]
        limit: u16,
    },
    /// Apply a JSON patch with optimistic version checking; null clears nullable fields.
    /// --timeline-use and --timeline-policy set the timeline rule without JSON;
    /// --requires and --clear-requires set which agents may claim it.
    Update(IssuePatch),
    /// Add a directed relation: FROM blocks TO (or related/duplicates).
    Link {
        from: String,
        to: String,
        #[arg(long, default_value="blocks", value_parser=["blocks","related","duplicates"])]
        kind: String,
    },
    /// Remove a relationship by canonical ID.
    Unlink { id: String },
    /// Append a durable Markdown comment.
    Comment(Note),
    /// Append a durable agent checkpoint (progress, decisions and next actions).
    Checkpoint(Note),
    /// Append durable completion or verification evidence.
    Evidence(Note),
    /// Atomically acquire exclusive work online; returns the secret fencing token once.
    Claim {
        issue: String,
        /// A session name for this piece of work; defaults to this checkout's agent (`gm agent setup`).
        #[arg(long, value_name = "SESSION_NAME")]
        agent: Option<String>,
        /// Lease seconds; defaults to .gitmatrix/agents.yml's, else 900.
        #[arg(long, value_parser=clap::value_parser!(u32).range(30..=86400))]
        ttl: Option<u32>,
        #[command(flatten)]
        delegation: Delegation,
        /// Take over someone else's active claim (tracker owners, as themselves). Their token stops working; the takeover is noted on the issue.
        #[arg(long)]
        force: bool,
    },
    /// Ask a person for something: a question, an approval, a decision or a credential. With the issue's lease token the lease is parked while you wait.
    Ask {
        issue: String,
        #[arg(long, value_parser=["question","approval","decision","credential"])]
        kind: String,
        /// Markdown; '-' reads stdin and '@path' reads a file.
        #[arg(long)]
        prompt: String,
        /// For a decision: an option (repeat for each).
        #[arg(long = "choice")]
        choices: Vec<String>,
        /// For a credential: the secret to store the answer as, owner/repo:NAME.
        #[arg(long)]
        secret: Option<String>,
        /// Ask this member (slug) instead of your accountable person.
        #[arg(long)]
        route_to: Option<String>,
        /// The issue's lease token, to park the lease; prefer GM_LEASE_TOKEN.
        #[arg(long, env = "GM_LEASE_TOKEN", hide_env_values = true)]
        lease_token: Option<String>,
        /// For an approval: the timeline checkpoint to approve (its id, from `gm timeline checkpoint`). It must be the timeline's head; new commits need a new checkpoint.
        #[arg(long)]
        checkpoint: Option<String>,
    },
    /// Take a parked lease back up once its requests are answered; returns a fresh token.
    Resume {
        issue: String,
        /// Lease seconds; defaults to .gitmatrix/agents.yml's, else 900.
        #[arg(long, value_parser=clap::value_parser!(u32).range(30..=86400))]
        ttl: Option<u32>,
    },
    /// Hand your lease to another agent or person: prints a single-use code. You keep the lease until it's accepted.
    Handoff {
        #[command(flatten)]
        lease: Lease,
        /// Only this agent (name or id) or member (slug) may accept.
        #[arg(long)]
        to: Option<String>,
        /// How long the code works, in seconds.
        #[arg(long, default_value_t=600, value_parser=clap::value_parser!(u32).range(30..=3600))]
        ttl: u32,
    },
    /// Withdraw a pending handoff of your lease.
    Withdraw(Lease),
    /// Accept a handoff code: the lease moves to you with a fresh token; the giver's stops working.
    Accept {
        code: String,
        /// A session name for this piece of work (defaults to the giver's).
        #[arg(long, value_name = "SESSION_NAME")]
        agent: Option<String>,
        /// Lease seconds; defaults to .gitmatrix/agents.yml's, else 900.
        #[arg(long, value_parser=clap::value_parser!(u32).range(30..=86400))]
        ttl: Option<u32>,
    },
    /// Take back a claim inside your leased subtree; its token stops working.
    Revoke {
        issue: String,
        /// The lease token of an issue above it; prefer GM_UNDER_TOKEN.
        #[arg(long, env = "GM_UNDER_TOKEN", hide_env_values = true)]
        under_token: String,
    },
    /// Pick and claim the next ready issue in one step: highest priority, then most unblocked work, then oldest. Returns its token once, with the issue's working context. An agent only gets issues whose requirements it meets; the result says how many it skipped.
    Next {
        /// A session name for this piece of work; defaults to this checkout's agent (`gm agent setup`).
        #[arg(long, value_name = "SESSION_NAME")]
        agent: Option<String>,
        /// Defaults to this checkout's scope, then the project's (.gitmatrix/agents.yml), then your default team (set on the web).
        #[arg(long, conflicts_with = "all_teams")]
        team: Option<String>,
        /// Ignore every default team and pick from all teams.
        #[arg(long)]
        all_teams: bool,
        #[arg(long)]
        workspace: Option<String>,
        /// Only work under this issue (a project or other parent).
        #[arg(long)]
        under: Option<String>,
        /// Lease seconds; defaults to .gitmatrix/agents.yml's, else 900.
        #[arg(long, value_parser=clap::value_parser!(u32).range(30..=86400))]
        ttl: Option<u32>,
        /// With --under: pick inside your own leased subtree.
        #[command(flatten)]
        delegation: Delegation,
    },
    /// Renew an online fenced lease; returns its token only in this response.
    Renew {
        #[command(flatten)]
        lease: Lease,
        /// Lease seconds; defaults to .gitmatrix/agents.yml's, else 900.
        #[arg(long, value_parser=clap::value_parser!(u32).range(30..=86400))]
        ttl: Option<u32>,
    },
    /// Release the current fenced lease online.
    Release {
        #[command(flatten)]
        lease: Lease,
        /// End someone else's claim without its token (tracker owners, as themselves); noted on the issue, not counted as their failure.
        #[arg(long)]
        force: bool,
    },
    /// Complete claimed work online with durable evidence and a valid fencing token.
    Complete {
        #[command(flatten)]
        lease: Lease,
        #[arg(long)]
        evidence: String,
    },
    /// Queue one atomic mutation array (max 100). Create referenced IDs before using them; '-' reads stdin, '@path' reads a file.
    Batch {
        /// JSON array of {kind,id,expectedVersion?,data?}; use canonical IDs.
        /// Kinds: team.create/update, workspace.create/update, issue.create/update,
        /// link.add/remove, comment.add, subscription.add/remove. Lease operations
        /// are online-only and cannot be queued.
        /// Create data: team {key,name,description?,memberIds?}; workspace
        /// {slug,name,description?}; issue {teamId,title,...issue update fields}.
        /// Updates use the fields documented by `gm schema issue update`.
        /// link.add data: {fromId,toId,kind:blocks|related|duplicates}.
        /// comment.add data: {issueId,body,kind:comment|checkpoint|evidence}.
        /// subscription.add data: {workspaceId,repoId}. Removes need only kind/id.
        /// Updates require expectedVersion. Referenced creates must appear earlier.
        data: String,
    },
}
