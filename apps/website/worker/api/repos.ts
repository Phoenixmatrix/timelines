import { Hono, type Context } from "hono";
import type {
  BlobResponse,
  Collaborator,
  CollaboratorRole,
  CommitSummary,
  CommitsResponse,
  CreateRepoRequest,
  RepoDetail,
  RepoRole,
  TreeEntry,
  TreeResponse,
  Visibility,
} from "../../shared/api.ts";
import type { AppEnv } from "../auth.ts";
import {
  forgetUpstreamTokens,
  isArtifactsError,
  listRefs,
  newArtifactsName,
} from "../artifacts.ts";
import {
  accountSummary,
  canCreateIn,
  findAccountBySlug,
  findRepo,
  repoSummary,
  roleFor,
  visibleRepos,
  type AccountRow,
  type RepoRow,
} from "../db.ts";
import { atLeast } from "../permissions.ts";
import { fail, readJson, requireActor } from "./http.ts";

const REPO_NAME = /^(?!\.)[A-Za-z0-9._-]{1,100}$/;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_README_BYTES = 512 * 1024;
const COMMITS_PER_PAGE = 30;

export const repos = new Hono<AppEnv>();

/** Load a repo the actor can see, or the response to send instead. */
async function loadRepo(
  c: Context<AppEnv>,
  needed: RepoRole = "read",
): Promise<{ row: RepoRow; role: RepoRole } | Response> {
  const actor = c.get("actor");
  const row = await findRepo(
    c.env.DB,
    actor,
    c.req.param("owner") ?? "",
    c.req.param("name") ?? "",
  );
  const role = row ? roleFor(row, actor) : "none";
  // Private repos the actor cannot read look exactly like missing ones.
  if (!row || !atLeast(role, "read")) return fail(c, 404, "Repository not found.");
  if (!atLeast(role, needed)) return fail(c, 403, `This needs ${needed} access to the repository.`);
  return { row, role };
}

function cleanPath(raw: string | undefined): string | null {
  const segments = (raw ?? "").split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments.join("/");
}

function toCommit(commit: ArtifactsCommitMetadata): CommitSummary {
  return {
    oid: commit.hash,
    message: commit.message,
    authorName: commit.author.name,
    authorEmail: commit.author.email,
    authoredAt: commit.authoredAt,
    parents: commit.parents,
  };
}

function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

repos.get("/", async (c) => {
  return c.json({ repos: await visibleRepos(c.env.DB, c.get("actor")) });
});

repos.post("/", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const body = await readJson<CreateRepoRequest>(c);
  const name = body.name?.trim() ?? "";
  const description = body.description?.trim() ?? "";
  const visibility: Visibility = body.visibility === "public" ? "public" : "private";

  if (!REPO_NAME.test(name) || name.toLowerCase().endsWith(".git")) {
    return fail(
      c,
      400,
      "Use letters, numbers, dots, dashes and underscores, without a .git ending.",
    );
  }
  const owner = body.owner ? await findAccountBySlug(c.env.DB, body.owner) : null;
  if (!owner) return fail(c, 404, "No such owner.");
  if (!(await canCreateIn(c.env.DB, actor, owner))) {
    return fail(c, 403, `You can't create repositories in ${owner.slug}.`);
  }
  if (await findRepo(c.env.DB, null, owner.slug, name)) {
    return fail(c, 409, `${owner.slug}/${name} already exists.`);
  }

  let importUrl: string | null = null;
  if (body.importUrl?.trim()) {
    try {
      const url = new URL(body.importUrl.trim());
      if (url.protocol !== "https:") throw new Error("not https");
      importUrl = url.toString();
    } catch {
      return fail(c, 400, "Import from a public https:// Git URL.");
    }
  }

  const artifactsName = newArtifactsName();
  let created: ArtifactsCreateRepoResult;
  try {
    created = importUrl
      ? await c.env.ARTIFACTS.import({
          source: { url: importUrl },
          target: { name: artifactsName, opts: { description } },
        })
      : await c.env.ARTIFACTS.create(artifactsName, { description, setDefaultBranch: "main" });
  } catch (error) {
    if (isArtifactsError(error, "REMOTE_AUTH_REQUIRED")) {
      return fail(
        c,
        400,
        "That repository needs credentials. Only public repositories can be imported.",
      );
    }
    if (isArtifactsError(error, "NOT_FOUND") || isArtifactsError(error, "INVALID_URL")) {
      return fail(c, 400, "No Git repository was found at that URL.");
    }
    if (isArtifactsError(error, "MEMORY_LIMIT")) {
      return fail(c, 413, "That repository is too large to import.");
    }
    throw error;
  }

  try {
    await c.env.DB.prepare(
      `INSERT INTO repos (id, owner_id, name, description, visibility, default_branch,
         artifacts_name, artifacts_remote, imported_from)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        `repo_${crypto.randomUUID()}`,
        owner.id,
        name,
        description,
        visibility,
        created.defaultBranch || "main",
        artifactsName,
        created.remote,
        importUrl,
      )
      .run();
  } catch (error) {
    // Lost a race for the same name: don't leave orphaned storage behind.
    c.executionCtx.waitUntil(c.env.ARTIFACTS.delete(artifactsName).then(() => undefined));
    throw error;
  }

  const row = await findRepo(c.env.DB, actor, owner.slug, name);
  return c.json(row && repoSummary(row, actor), 201);
});

repos.get("/:owner/:name", async (c) => {
  const loaded = await loadRepo(c);
  if (loaded instanceof Response) return loaded;
  const { row } = loaded;

  const detail: RepoDetail = {
    ...repoSummary(row, c.get("actor")),
    state: "ready",
    cloneUrl: `${new URL(c.req.url).origin}/${row.owner_slug}/${row.name}.git`,
    head: null,
    branches: [],
    tags: [],
  };
  try {
    const refs = await listRefs(c.env, row.artifacts_name, row.artifacts_remote);
    detail.head = refs.head;
    detail.branches = refs.branches;
    detail.tags = refs.tags;
    if (refs.headBranch && refs.headBranch !== row.default_branch) {
      // Imports keep the source's HEAD (often "master"); git is the source of truth.
      detail.defaultBranch = refs.headBranch;
      c.executionCtx.waitUntil(
        c.env.DB.prepare("UPDATE repos SET default_branch = ? WHERE id = ?")
          .bind(refs.headBranch, row.id)
          .run(),
      );
    }
  } catch (error) {
    // A fresh import is not readable over git yet; the binding says why.
    try {
      using repo = await c.env.ARTIFACTS.get(row.artifacts_name);
      await repo.info();
    } catch (lookupError) {
      if (
        isArtifactsError(lookupError, "IMPORT_IN_PROGRESS") ||
        isArtifactsError(lookupError, "CREATE_IN_PROGRESS")
      ) {
        detail.state = "importing";
        return c.json(detail);
      }
    }
    throw error;
  }
  return c.json(detail);
});

repos.get("/:owner/:name/tree", async (c) => {
  const loaded = await loadRepo(c);
  if (loaded instanceof Response) return loaded;
  const { row } = loaded;
  const ref = c.req.query("ref") || row.default_branch;
  const path = cleanPath(c.req.query("path"));
  if (path === null) return fail(c, 400, "Invalid path.");

  using repo = await c.env.ARTIFACTS.get(row.artifacts_name);
  const [commit] = await repo.log({ ref, limit: 1 });
  if (!commit) return fail(c, 404, `No branch, tag or commit named ${ref}.`);

  let treeHash = commit.treeHash;
  for (const segment of path ? path.split("/") : []) {
    const entries = (await repo.readTree(treeHash)) ?? [];
    const next = entries.find((entry) => entry.name === segment && entry.type === "tree");
    if (!next) return fail(c, 404, `No folder at ${path} on ${ref}.`);
    treeHash = next.hash;
  }

  const entries: TreeEntry[] = ((await repo.readTree(treeHash)) ?? [])
    .map((entry) => ({
      name: entry.name,
      path: path ? `${path}/${entry.name}` : entry.name,
      type: entry.type,
      oid: entry.hash,
    }))
    .sort((a, b) =>
      a.type === "tree" && b.type !== "tree"
        ? -1
        : b.type === "tree" && a.type !== "tree"
          ? 1
          : a.name.localeCompare(b.name),
    );

  let readme: TreeResponse["readme"] = null;
  const readmeEntry = entries.find(
    (entry) => entry.type === "blob" && /^readme(\.(md|markdown|txt))?$/i.test(entry.name),
  );
  if (readmeEntry) {
    const blob = await repo.readBlob(readmeEntry.oid);
    if (blob && blob.size <= MAX_README_BYTES) {
      readme = { name: readmeEntry.name, text: await blob.text() };
    }
  }

  const body: TreeResponse = { ref, path, commit: toCommit(commit), entries, readme };
  return c.json(body);
});

repos.get("/:owner/:name/blob", async (c) => {
  const loaded = await loadRepo(c);
  if (loaded instanceof Response) return loaded;
  const { row } = loaded;
  const ref = c.req.query("ref") || row.default_branch;
  const path = cleanPath(c.req.query("path"));
  if (!path) return fail(c, 400, "Invalid path.");

  using repo = await c.env.ARTIFACTS.get(row.artifacts_name);
  const blob = await repo.readFile({ ref, path });
  if (!blob) return fail(c, 404, `No file at ${path} on ${ref}.`);

  const head = new Uint8Array(await blob.slice(0, MAX_TEXT_BYTES).arrayBuffer());
  const binary = looksBinary(head);
  const body: BlobResponse = {
    ref,
    path,
    size: blob.size,
    contentType: blob.type,
    binary,
    text: binary ? null : new TextDecoder().decode(head),
    truncated: !binary && blob.size > MAX_TEXT_BYTES,
  };
  return c.json(body);
});

repos.get("/:owner/:name/commits", async (c) => {
  const loaded = await loadRepo(c);
  if (loaded instanceof Response) return loaded;
  const { row } = loaded;
  const ref = c.req.query("ref") || row.default_branch;
  const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);

  using repo = await c.env.ARTIFACTS.get(row.artifacts_name);
  const commits = await repo.log({
    ref,
    limit: COMMITS_PER_PAGE + 1,
    offset: (page - 1) * COMMITS_PER_PAGE,
  });
  const body: CommitsResponse = {
    ref,
    commits: commits.slice(0, COMMITS_PER_PAGE).map(toCommit),
    hasMore: commits.length > COMMITS_PER_PAGE,
  };
  return c.json(body);
});

repos.patch("/:owner/:name", async (c) => {
  const loaded = await loadRepo(c, "admin");
  if (loaded instanceof Response) return loaded;
  const { row } = loaded;
  const body = await readJson<{ description: string; visibility: Visibility }>(c);
  const description = body.description?.trim() ?? row.description;
  const visibility =
    body.visibility === "public" || body.visibility === "private"
      ? body.visibility
      : row.visibility;
  await c.env.DB.prepare("UPDATE repos SET description = ?, visibility = ? WHERE id = ?")
    .bind(description, visibility, row.id)
    .run();
  const updated = await findRepo(c.env.DB, c.get("actor"), row.owner_slug, row.name);
  return c.json(updated && repoSummary(updated, c.get("actor")));
});

repos.delete("/:owner/:name", async (c) => {
  const loaded = await loadRepo(c, "admin");
  if (loaded instanceof Response) return loaded;
  const { row } = loaded;
  // Remove the record first: a failed storage delete leaves an unreachable
  // orphan rather than a listed repository with no contents.
  await c.env.DB.prepare("DELETE FROM repos WHERE id = ?").bind(row.id).run();
  forgetUpstreamTokens(row.artifacts_name);
  c.executionCtx.waitUntil(
    c.env.ARTIFACTS.delete(row.artifacts_name).then(
      () => undefined,
      (error: unknown) => console.error("Artifacts delete failed", row.artifacts_name, error),
    ),
  );
  return c.body(null, 204);
});

repos.get("/:owner/:name/collaborators", async (c) => {
  const loaded = await loadRepo(c, "admin");
  if (loaded instanceof Response) return loaded;
  const { results } = await c.env.DB.prepare(
    `SELECT a.*, rc.role FROM repo_collaborators rc JOIN accounts a ON a.id = rc.user_id
     WHERE rc.repo_id = ? ORDER BY a.slug`,
  )
    .bind(loaded.row.id)
    .all<AccountRow & { role: CollaboratorRole }>();
  const collaborators: Collaborator[] = results.map((row) => ({
    ...accountSummary(row),
    role: row.role,
  }));
  return c.json({ collaborators });
});

repos.put("/:owner/:name/collaborators/:username", async (c) => {
  const loaded = await loadRepo(c, "admin");
  if (loaded instanceof Response) return loaded;
  const { role } = await readJson<{ role: CollaboratorRole }>(c);
  if (role !== "read" && role !== "write" && role !== "admin") {
    return fail(c, 400, "Choose read, write or admin.");
  }
  const user = await findAccountBySlug(c.env.DB, c.req.param("username"));
  if (!user || user.kind !== "user") return fail(c, 404, "No such user.");
  await c.env.DB.prepare(
    `INSERT INTO repo_collaborators (repo_id, user_id, role) VALUES (?, ?, ?)
     ON CONFLICT (repo_id, user_id) DO UPDATE SET role = excluded.role`,
  )
    .bind(loaded.row.id, user.id, role)
    .run();
  const collaborator: Collaborator = { ...accountSummary(user), role };
  return c.json(collaborator);
});

repos.delete("/:owner/:name/collaborators/:username", async (c) => {
  const loaded = await loadRepo(c, "admin");
  if (loaded instanceof Response) return loaded;
  const user = await findAccountBySlug(c.env.DB, c.req.param("username"));
  if (!user) return fail(c, 404, "No such user.");
  await c.env.DB.prepare("DELETE FROM repo_collaborators WHERE repo_id = ? AND user_id = ?")
    .bind(loaded.row.id, user.id)
    .run();
  return c.body(null, 204);
});
