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

/** An identity that works on its own, with a human accountable for it. */
export interface Agent extends AgentRef {
  description: string;
  /** The human answerable for everything the agent does. */
  accountable: AccountSummary;
  createdAt: string;
  revokedAt: string | null;
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
  trigger: "push" | "manual";
  title: string;
  status: CiRunStatus;
  actor: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Set while the run waits for runs in flight on its branch (coalescing). */
  heldAt: string | null;
  /** The run that covered this one's commit instead of running it. */
  coveredBy: number | null;
}

export interface CiRunList {
  runs: CiRunSummary[];
  runner: CiRunner;
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
