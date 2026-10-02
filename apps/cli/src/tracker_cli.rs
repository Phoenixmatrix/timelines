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
    /// Canonical ID, issue key, team key or workspace slug.
    pub id: String,
    /// JSON object of mutable fields; use '-' for stdin or '@path' for a file.
    /// Issue fields: title, description, acceptance, type, status, priority (0–4),
    /// assigneeId, parentId, workspaceIds and labels. Team fields: name, description,
    /// memberIds and archived. Workspace fields: name, description and archived.
    /// Relationships use canonical IDs; null clears assigneeId/parentId.
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
    #[arg(long)]
    pub team: String,
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
    #[arg(long, default_value="task", value_parser=["task","bug","prd","chore","research"])]
    pub r#type: String,
    #[arg(long, default_value="todo", value_parser=["backlog","todo","in_progress","done","canceled"])]
    pub status: String,
    #[arg(long, default_value_t=2, value_parser=clap::value_parser!(u8).range(0..=4))]
    pub priority: u8,
    #[arg(long)]
    pub parent: Option<String>,
    #[arg(long)]
    pub assignee: Option<String>,
    #[arg(long)]
    pub workspace: Vec<String>,
    #[arg(long)]
    pub label: Vec<String>,
}
#[derive(Args)]
pub struct ListIssues {
    #[arg(long)]
    pub team: Option<String>,
    #[arg(long)]
    pub workspace: Option<String>,
    #[arg(long)]
    pub status: Option<String>,
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
    /// Fencing token; prefer GM_LEASE_TOKEN to avoid shell history/process arguments.
    #[arg(long, env = "GM_LEASE_TOKEN", hide_env_values = true)]
    pub lease_token: String,
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
    /// Inspect an issue and bounded ancestors, blockers, dependents and notes.
    Show {
        issue: String,
        #[arg(long, default_value_t=30, value_parser=clap::value_parser!(u16).range(1..=200))]
        limit: u16,
    },
    /// Apply a JSON patch with optimistic version checking; null clears nullable fields.
    Update(Patch),
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
        #[arg(long)]
        agent: String,
        #[arg(long, default_value_t=900, value_parser=clap::value_parser!(u32).range(30..=86400))]
        ttl: u32,
        #[command(flatten)]
        delegation: Delegation,
    },
    /// Take back a claim inside your leased subtree; its token stops working.
    Revoke {
        issue: String,
        /// The lease token of an issue above it; prefer GM_UNDER_TOKEN.
        #[arg(long, env = "GM_UNDER_TOKEN", hide_env_values = true)]
        under_token: String,
    },
    /// Pick and claim the next ready issue in one step: highest priority, then most unblocked work, then oldest. Returns its token once, with the issue's working context.
    Next {
        #[arg(long)]
        agent: String,
        #[arg(long)]
        team: Option<String>,
        #[arg(long)]
        workspace: Option<String>,
        /// Only work under this issue (a project or other parent).
        #[arg(long)]
        under: Option<String>,
        #[arg(long, default_value_t=900, value_parser=clap::value_parser!(u32).range(30..=86400))]
        ttl: u32,
        /// With --under: pick inside your own leased subtree.
        #[command(flatten)]
        delegation: Delegation,
    },
    /// Renew an online fenced lease; returns its token only in this response.
    Renew {
        #[command(flatten)]
        lease: Lease,
        #[arg(long, default_value_t=900, value_parser=clap::value_parser!(u32).range(30..=86400))]
        ttl: u32,
    },
    /// Release the current fenced lease online.
    Release(Lease),
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
