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
  /** Owners the viewer may create repositories under: themselves, then their orgs. */
  canCreateIn: AccountSummary[];
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

export interface AccessToken {
  id: string;
  name: string;
  scope: TokenScope;
  lastFour: string;
  createdAt: string;
  lastUsedAt: string | null;
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
