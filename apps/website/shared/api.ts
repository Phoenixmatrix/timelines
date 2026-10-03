// Shapes the Worker's JSON API returns, shared with the React app.

export type RepoRole = "none" | "read" | "write" | "admin";
export type Visibility = "public" | "private";
export type TokenScope = "read" | "write";
export type CollaboratorRole = "read" | "write" | "admin";

export interface AccountSummary {
  id: string;
  kind: "user" | "org";
  slug: string;
  displayName: string;
}

export interface Viewer extends AccountSummary {
  kind: "user";
  isSiteAdmin: boolean;
  /** The address they sign in with; null for development personas. */
  email: string | null;
  /** Owners the viewer may create repositories under: themselves, then their orgs. */
  canCreateIn: AccountSummary[];
  /** Set when signed in with an agent's token: the agent acting for this viewer. */
  agent: AgentRef | null;
}

/** An agent as it's named in passing: enough to show who did something. */
export interface AgentRef {
  id: string;
  name: string;
}

/** Self-reported advisory metadata, never an authorization or scheduling policy. */
export interface AgentCapabilities {
  version: 1;
  harness: string | null;
  model: string | null;
  environment: {
    os: string;
    arch: string;
    runtime: "host" | "container" | "vm" | "wsl" | "cloudflare-worker" | "unknown";
    cpuCount: number | null;
    memoryBytes: number | null;
  };
  tags: string[];
  skills: { name: string; description: string; source: "detected" | "declared" }[];
}

/** An identity that works on its own, with a human accountable for it. */
export interface Agent extends AgentRef {
  description: string;
  /** The human answerable for everything the agent does. */
  accountable: AccountSummary;
  createdAt: string;
  revokedAt: string | null;
  capabilities: AgentCapabilities | null;
  capabilitiesUpdatedAt: string | null;
  /** Tokens it can sign in with. */
  tokens: AccessToken[];
}

export interface Persona extends AccountSummary {
  bio: string;
  isSiteAdmin: boolean;
}

export interface SessionResponse {
  viewer: Viewer | null;
}

export interface RepoSummary {
  id: string;
  owner: AccountSummary;
  name: string;
  description: string;
  visibility: Visibility;
  defaultBranch: string;
  viewerRole: RepoRole;
  createdAt: string;
  pushedAt: string | null;
  importedFrom: string | null;
}

export interface GitRef {
  name: string;
  /** Short name: "main" for refs/heads/main. */
  shortName: string;
  kind: "branch" | "tag";
  oid: string;
}

export interface RepoDetail extends RepoSummary {
  /** "importing" while Artifacts is still copying an imported repository. */
  state: "ready" | "importing";
  cloneUrl: string;
  /** Null while the repository has no commits. */
  head: string | null;
  branches: GitRef[];
  tags: GitRef[];
}

export interface CommitSummary {
  oid: string;
  message: string;
  authorName: string;
  authorEmail: string;
  authoredAt: number;
  parents: string[];
}

export interface TreeEntry {
  name: string;
  path: string;
  type: "tree" | "blob" | "symlink" | "gitlink" | "exec";
  oid: string;
}

export interface TreeResponse {
  ref: string;
  path: string;
  commit: CommitSummary;
  entries: TreeEntry[];
  readme: { name: string; text: string } | null;
}

export interface BlobResponse {
  ref: string;
  /** The exact commit used to read this blob, even if its branch moves afterward. */
  commitOid: string;
  path: string;
  size: number;
  contentType: string;
  binary: boolean;
  /** Null for binary files; cut at a size limit when truncated is set. */
  text: string | null;
  truncated: boolean;
}

export interface CommitsResponse {
  ref: string;
  commits: CommitSummary[];
  hasMore: boolean;
}

/** One bounded page of first-parent history, pinned to an immutable head. */
export interface HistoryPage {
  ref: string;
  /** Null for an empty repository. */
  head: string | null;
  path: string;
  scanned: number;
  /** Next first-parent commit to scan, or null when counts are exact. */
  next: string | null;
  commits: CommitSummary[];
  entries: Record<string, { latest: CommitSummary; count: number }>;
}

export interface AccountPage extends AccountSummary {
  bio: string;
  repos: RepoSummary[];
  members: (AccountSummary & { role: "owner" | "member" })[];
}

export interface Collaborator extends AccountSummary {
  role: CollaboratorRole;
}

/** An address allowed to create an account (sign-up is invite only). */
export interface Invite {
  email: string;
  /** Slug of the admin who invited them. */
  invitedBy: string | null;
  createdAt: string;
}

export interface AccessToken {
  id: string;
  name: string;
  scope: TokenScope;
  lastFour: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** A public key registered for SSH sign-in over HTTPS (gm). */
export interface SshKey {
  id: string;
  title: string;
  type: string;
  fingerprint: string;
  scope: TokenScope;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Step one of SSH sign-in: sign `message` (SSHSIG, `namespace`) with the key. */
export interface SshChallenge {
  fingerprint: string;
  nonce: string;
  message: string;
  namespace: string;
  expiresAt: string;
}

/** Step two: a short-lived token that acts as the key's owner. */
export interface SshSession {
  token: string;
  expiresAt: string;
  scope: TokenScope;
  user: AccountSummary;
  key: { fingerprint: string; title: string };
}

export interface CreatedAccessToken extends AccessToken {
  /** Shown once, at creation. */
  secret: string;
}

export interface CreateRepoRequest {
  owner: string;
  name: string;
  description?: string;
  visibility: Visibility;
  importUrl?: string;
}

export interface ApiError {
  error: string;
}

// ---- Knowledge graph and wiki ------------------------------------------------

export interface KnowledgeBuild {
  id: string;
  fromCommit: string | null;
  toCommit: string;
  status: "running" | "succeeded" | "failed";
  phase: string;
  stats: Record<string, unknown>;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface KnowledgeStatus {
  /** The commit the graph and wiki describe; null before the first build. */
  indexedCommit: string | null;
  indexedAt: string | null;
  /** The repository's current HEAD, to compare with `indexedCommit`. */
  head: string | null;
  state: "empty" | "up-to-date" | "queued" | "building" | "failed";
  /** Changes whenever the stored graph does, including mid-build; the map is cached by it. */
  graphVersion: string;
  current: KnowledgeBuild | null;
  recent: KnowledgeBuild[];
  counts: Record<string, number>;
}

export interface GraphNode {
  id: string;
  kind: "repository" | "directory" | "file" | "symbol" | "package" | "concept" | "component";
  name: string;
  path: string | null;
  summary: string;
  data: Record<string, unknown>;
  changedIn: string;
}

export interface GraphLink {
  kind: string;
  weight: number;
  node: Pick<GraphNode, "id" | "kind" | "name" | "path" | "summary">;
}

/**
 * The whole graph, lean enough to draw at tens of thousands of nodes:
 * summaries and data load per node from /graph/node.
 */
export interface KnowledgeMap {
  commit: string | null;
  /** The graph version this map was read at (see KnowledgeStatus.graphVersion). */
  version: string;
  /** [id, kind, name, path, size (lines for files, line for symbols), changed in the latest build] */
  nodes: [string, GraphNode["kind"], string, string | null, number, 0 | 1][];
  /** [source index, target index, kind] */
  edges: [number, number, string][];
}

export interface GraphNodeDetail {
  node: GraphNode;
  outgoing: GraphLink[];
  incoming: GraphLink[];
}

export interface KnowledgeSearchResults {
  query: string;
  /** Graph entities closest in meaning to the query (Vectorize). */
  entities: (Pick<GraphNode, "id" | "kind" | "name" | "path" | "summary"> & { score: number })[];
  /** Matching passages from source files and wiki pages (AI Search, hybrid). */
  passages: { kind: "code" | "wiki"; path: string; text: string; score: number }[];
  /**
   * Which lookups answered. A failed one leaves its list empty, so an empty
   * list is "no matches" only when its provider is "ok".
   */
  providers: { entities: "ok" | "failed"; passages: "ok" | "failed" };
  /**
   * The index the results come from: "none" before the first build (nothing
   * is searchable yet), "building" while a build runs (results may be from an
   * older commit, or missing), "ready" otherwise. Searching never starts a build.
   */
  index: { state: "none" | "building" | "ready"; indexedCommit: string | null };
}

export interface WikiPageSummary {
  slug: string;
  title: string;
  section: string;
  position: number;
  nodeId: string | null;
  updatedAt: string;
}

export interface WikiCatalog {
  pages: WikiPageSummary[];
  status: KnowledgeStatus;
}

export interface WikiPage extends WikiPageSummary {
  body: string;
  /** Mermaid source drawn from the graph, or "". */
  diagram: string;
  sources: string[];
  generatedIn: string;
  model: string | null;
}

/**
 * One entry of a timeline's graph overlay: a node the timeline adds, changes
 * or removes compared with main's indexed graph.
 */
export interface KnowledgeOverlayChange {
  id: string;
  kind: GraphNode["kind"];
  change: "added" | "changed" | "removed";
  name: string;
  path: string | null;
  /** The timeline's description (main's for a removed node). */
  summary: string;
  /** What differs on a changed node: `name`, `summary`, data keys, or `links`. */
  fields: string[];
  /** Links from this node that the timeline adds or drops. */
  links: { added: OverlayLink[]; removed: OverlayLink[] };
}

export interface OverlayLink {
  id: string;
  kind: string;
}

/**
 * `waiting`: main has no graph yet to compare with; `ended`: the bookmark is
 * gone and the last overlay is kept, read-only (see `ended`).
 */
export type KnowledgeOverlayState =
  | "up-to-date"
  | "building"
  | "queued"
  | "failed"
  | "waiting"
  | "ended";

/**
 * Why an overlay ended, from the timeline's record when its bookmark went:
 * it `landed` or was `abandoned`; `ended` when the tracker did not say.
 */
export type KnowledgeOverlayEndReason = "landed" | "abandoned" | "ended";

/** A timeline's knowledge graph diff against main, kept current on every push. */
export interface KnowledgeOverlaySummary {
  /** The bookmark, as `timeline/<slug>`. */
  ref: string;
  timeline: string;
  /** The bookmark's tip now; null once it is gone. */
  head: string | null;
  /** The timeline commit the stored diff describes. */
  commit: string | null;
  /** Main's indexed commit it is measured against. */
  baseCommit: string | null;
  /** Where the timeline's own changes are counted from; null when no shared history was found. */
  mergeBase: string | null;
  state: KnowledgeOverlayState;
  /** Per node kind: how many the timeline adds, changes and removes. */
  counts: Record<string, { added: number; changed: number; removed: number }>;
  updatedAt: string | null;
  error: string | null;
  /**
   * Set once the timeline's bookmark is gone (CORE-139): the last overlay is
   * kept read-only and never computed again. Null while the bookmark exists.
   */
  ended: { reason: KnowledgeOverlayEndReason; at: string } | null;
}

export interface KnowledgeOverlay extends KnowledgeOverlaySummary {
  changes: KnowledgeOverlayChange[];
  /** More changes are stored than were returned. */
  truncated: boolean;
  /** The timeline's newest wiki page sets (CORE-84), newest first. */
  pageSets: KnowledgePageSet[];
}

/**
 * Where a timeline's wiki page set stands (CORE-84): `queued` and `writing`
 * while pending; `ended` when the timeline ended before it was finished (what
 * was written is kept, read-only).
 */
export type KnowledgePageSetState = "queued" | "writing" | "succeeded" | "failed" | "ended";

/** One wiki page written for a timeline, in brief. */
export interface KnowledgeTimelinePageSummary {
  slug: string;
  title: string;
  section: string;
  kind: "component" | "architecture" | "glossary";
  /** Whether the timeline adds the page's subject or changes it. */
  change: "added" | "changed";
  /** `kept`: main's page still holds, so the timeline has no page of its own. */
  outcome: "written" | "kept";
  nodeId: string | null;
  /** The page's opening, for a review card; empty when kept. */
  excerpt: string;
  model: string | null;
  updatedAt: string;
}

/**
 * The wiki pages a timeline affects, written for one checkpoint (or on
 * demand at one commit), apart from main's wiki: what the timeline adds or
 * changes in components and concepts.
 */
export interface KnowledgePageSet {
  /** The bookmark, as `timeline/<slug>`. */
  ref: string;
  timeline: string;
  /** What it was written for: a checkpoint's id, or `commit:<oid>` on demand. */
  key: string;
  checkpoint: { id: string; number: number | null } | null;
  /** The timeline commit the pages describe. */
  commit: string;
  /** Main's indexed commit they were measured against. */
  baseCommit: string | null;
  state: KnowledgePageSetState;
  /** The timeline's graph diff the pages were chosen from, per node kind. */
  counts: Record<string, { added: number; changed: number; removed: number }>;
  pages: KnowledgeTimelinePageSummary[];
  /** Affected pages left out by the per-set caps. */
  skipped: number;
  error: string | null;
  requestedAt: string;
  finishedAt: string | null;
}

/** GET /knowledge/overlay/pages: a timeline's page sets, newest first. */
export interface KnowledgePageSets {
  ref: string;
  timeline: string;
  /** The timeline's overlay has ended: its pages are read-only and no new set starts. */
  ended: boolean;
  sets: KnowledgePageSet[];
}

/** GET /knowledge/overlay/page: one timeline page in full. */
export interface KnowledgeTimelinePage extends WikiPage {
  timeline: string;
  /** The set it belongs to. */
  set: Omit<KnowledgePageSet, "pages" | "counts">;
  kind: KnowledgeTimelinePageSummary["kind"];
  change: KnowledgeTimelinePageSummary["change"];
  outcome: KnowledgeTimelinePageSummary["outcome"];
}

// ---- CI/CD ------------------------------------------------------------------

export type CiRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type CiJobStatus =
  | "pending"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";
export type CiStepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";
export type CiRunner = "local" | "sandbox";

export interface CiRunSummary {
  id: string;
  number: number;
  commit: string;
  /** Branch name, without refs/heads/. */
  ref: string;
  trigger: "push" | "manual" | "preview";
  /** A preview run's action, timeline and checkpoint (CORE-79); null for other runs. */
  preview: CiRunPreview | null;
  title: string;
  status: CiRunStatus;
  actor: string | null;
  /** The agent that pushed or started it, acting for `actor`. */
  agent: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Set while the run waits for runs in flight on its branch (coalescing). */
  heldAt: string | null;
  /** The run that covered this one's commit instead of running it. */
  coveredBy: number | null;
}

/** What a preview run is for: `create` (a revival when `revived`) or `teardown`. */
export interface CiRunPreview {
  action: "create" | "teardown";
  timeline: string | null;
  checkpoint: string | null;
  revived: boolean;
}

export interface CiRunList {
  runs: CiRunSummary[];
  runner: CiRunner;
}

/** One ref update a push made, from the push log. */
export interface RefUpdate {
  id: number;
  /** Full name: refs/heads/main, refs/tags/v1. */
  ref: string;
  /** Null when the push created the ref. */
  old: string | null;
  /** Null when the push deleted it. */
  new: string | null;
  /** A force push (the old commit isn't an ancestor of the new); null when unknown. */
  forced: boolean | null;
  /** Who pushed: the person, and the agent that pushed for them. */
  actor: string | null;
  agent: string | null;
  createdAt: string;
}

export interface RefUpdateList {
  updates: RefUpdate[];
  /** Pass as `before` for the next (older) page; null on the last. */
  next: number | null;
}

/** A ref a change reached: first when a push made one of its commits reachable from it. */
export interface ChangeRef {
  changeId: string;
  ref: string;
  firstCommit: string;
  firstSeenAt: string;
  /** The push that brought it. */
  firstUpdate: RefUpdate;
  /** The latest of its commits to reach the ref (a rewrite has a new commit). */
  lastCommit: string;
  lastSeenAt: string;
}

export interface ChangeHistory {
  changeId: string;
  /** Oldest first. */
  refs: ChangeRef[];
}

export interface CiStep {
  position: number;
  name: string;
  status: CiStepStatus;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CiJob {
  id: string;
  name: string;
  needs: string[];
  status: CiJobStatus;
  runner: CiRunner;
  claimedBy: string | null;
  exitCode: number | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  steps: CiStep[];
}

export interface CiRunDetail extends CiRunSummary {
  configError: string | null;
  jobs: CiJob[];
}

export interface CiLogChunk {
  seq: number;
  step: number;
  text: string;
}

export interface CiLogs {
  chunks: CiLogChunk[];
  /** Pass back as `after` to fetch only newer output. */
  next: number;
  done: boolean;
}

/** Latest run per commit, for status dots in history. */
export type CiCommitStatuses = Record<
  string,
  { status: CiRunStatus; number: number; coveredBy: number | null }
>;

export interface CiSecretSummary {
  name: string;
  updatedAt: string;
}

/**
 * What `gm runner` gets when it claims a job. `env` may contain
 * `${GITMATRIX_CONFIG}`: the runner writes `files` under a directory of its
 * own and substitutes that directory's path.
 */
export interface CiClaimedJob {
  id: string;
  runId: string;
  runNumber: number;
  name: string;
  repo: string;
  commit: string;
  ref: string;
  timeoutMinutes: number;
  env: Record<string, string>;
  /** Package tool configuration (npmrc, docker/config.json…), by relative path. */
  files: Record<string, string>;
  steps: { position: number; name: string; run: string }[];
}

/** One report from a runner: new output, step changes, and maybe the end. */
export interface CiJobReport {
  logs?: { step: number; text: string }[];
  steps?: { position: number; status: CiStepStatus; exitCode?: number | null }[];
  done?: { status: "succeeded" | "failed" | "cancelled"; exitCode?: number | null; error?: string };
}

/** A repository's one-way mirror to another git host (a GitHub backup). */
export interface RepoMirror {
  /** HTTPS clone URL of the target. */
  url: string;
  username: string;
  /** The token is write-only; this says whether one is stored. */
  hasToken: boolean;
  enabled: boolean;
  /** Delete target branches and tags that no longer exist here. */
  prune: boolean;
  status: "pending" | "syncing" | "ok" | "failed";
  lastError: string | null;
  lastAttemptAt: string | null;
  lastSyncedAt: string | null;
  lastSyncedCommit: string | null;
  /**
   * The system identity mirror pushes are attributed to: the instance owner
   * (OWNER_EMAIL), whoever configured the mirror. Null until they have an account.
   */
  pushedAs: AccountSummary | null;
}

export interface UpdateMirrorRequest {
  url?: string;
  username?: string;
  /** Omit to keep the stored token. */
  token?: string;
  enabled?: boolean;
  prune?: boolean;
}
