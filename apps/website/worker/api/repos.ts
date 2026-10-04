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
import { isArtifactsError, newArtifactsName } from "../artifacts.ts";
import { launchPurge, requestDeletion } from "../retention/repo-deletion.ts";
import {
  accountSummary,
  canCreateIn,
  findAccountBySlug,
  findRepo,
  repoSummary,
  roleFor,
  visibleRepos,
  type RepoRow,
} from "../db.ts";
import { notifyKnowledge } from "../knowledge/coordinator.ts";
import { isCommitId, RepoReader } from "../objects.ts";
import { atLeast } from "../permissions.ts";
import { db } from "../schema.ts";
import { readHistory } from "../history/read.ts";
import { semanticResponse } from "../semantic/api.ts";
import { fail, readJson, requireActor } from "./http.ts";

const REPO_NAME = /^(?!\.)[A-Za-z0-9._-]{1,100}$/;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_README_BYTES = 512 * 1024;
const COMMITS_PER_PAGE = 30;

export const repos = new Hono<AppEnv>();

/** Load a repo the actor can see, or the response to send instead. */
export async function loadRepo(
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
  const existing = await findRepo(c.env.DB, null, owner.slug, name, { deleting: true });
  if (existing) {
    // A deleted repository keeps its name until its purge ends (CORE-199).
    return fail(
      c,
      409,
      existing.deleted_at
        ? `${owner.slug}/${name} is being deleted. Its name is free again once that finishes.`
        : `${owner.slug}/${name} already exists.`,
    );
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
    await db(c.env.DB)
      .insertInto("repos")
      .values({
        id: `repo_${crypto.randomUUID()}`,
        owner_id: owner.id,
        name,
        description,
        visibility,
        default_branch: created.defaultBranch || "main",
        artifacts_name: artifactsName,
        artifacts_remote: created.remote,
        imported_from: importUrl,
      })
      .execute();
  } catch (error) {
    // Lost a race for the same name: don't leave orphaned storage behind.
    c.executionCtx.waitUntil(c.env.ARTIFACTS.delete(artifactsName).then(() => undefined));
    throw error;
  }

  const row = await findRepo(c.env.DB, actor, owner.slug, name);
  if (row) c.executionCtx.waitUntil(notifyKnowledge(c.env, row.id));
  return c.json(row && repoSummary(row, actor), 201);
});

/** Open a cached object reader for a repo; always closed by the caller. */
function reader(c: Context<AppEnv>, row: RepoRow): RepoReader {
  return new RepoReader(c.env, row.artifacts_name, row.artifacts_remote, c.get("timing"), (work) =>
    c.executionCtx.waitUntil(work),
  );
}

/** Responses addressed by commit id never change, so browsers may keep them. */
function cacheIfImmutable(c: Context<AppEnv>, ref: string) {
  if (isCommitId(ref)) {
    c.header("cache-control", "private, max-age=31536000, immutable");
    c.header("vary", "Cookie, Authorization");
  }
}

/**
 * What a read request points at: `?at=<branch>/<path>` (a URL tail, split on
 * the server so the page doesn't have to load the branch list first), or
 * `?ref=&path=`. With neither, the repository's HEAD.
 */
async function resolveTarget(
  c: Context<AppEnv>,
  objects: RepoReader,
  row: RepoRow,
): Promise<{ ref: string; path: string } | Response> {
  const at = c.req.query("at");
  const raw = at
    ? await objects.split(at)
    : { ref: c.req.query("ref") || "", path: c.req.query("path") ?? "" };
  const path = cleanPath(raw.path);
  if (path === null) return fail(c, 400, "Invalid path.");
  if (raw.ref) return { ref: raw.ref, path };
  const refs = await objects.refs();
  return { ref: refs.headBranch ?? row.default_branch, path };
}

repos.get("/:owner/:name/semantic", async (c) => {
  const loaded = await loadRepo(c);
  if (loaded instanceof Response) return loaded;
  return semanticResponse(c, loaded.row);
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
  const objects = reader(c, row);
  try {
    const refs = await objects.refs();
    detail.head = refs.head;
    if (refs.head) {
      const warmer = reader(c, row);
      c.executionCtx.waitUntil(
        warmer.warm(refs.head, COMMITS_PER_PAGE + 1).finally(() => warmer.close()),
      );
    }
    detail.branches = refs.branches;
    detail.tags = refs.tags;
    if (refs.headBranch && refs.headBranch !== row.default_branch) {
      // Imports keep the source's HEAD (often "master"); git is the source of truth.
      detail.defaultBranch = refs.headBranch;
      c.executionCtx.waitUntil(
        db(c.env.DB)
          .updateTable("repos")
          .set({ default_branch: refs.headBranch })
          .where("id", "=", row.id)
          .execute(),
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
  } finally {
    await objects.close();
  }
  return c.json(detail);
});

repos.get("/:owner/:name/tree", async (c) => {
  const loaded = await loadRepo(c);
  if (loaded instanceof Response) return loaded;
  const { row } = loaded;
  const objects = reader(c, row);
  try {
    const target = await resolveTarget(c, objects, row);
    if (target instanceof Response) return target;
    const { ref, path } = target;
    const oid = await objects.resolve(ref);
    const commit = oid ? await objects.commit(oid) : null;
    if (!commit) return fail(c, 404, `No branch, tag or commit named ${ref}.`);
    const treeHash = await objects.treeAt(commit.treeHash, path);
    if (!treeHash) return fail(c, 404, `No folder at ${path} on ${ref}.`);

    const entries: TreeEntry[] = ((await objects.tree(treeHash)) ?? [])
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
      const blob = await objects.blob(readmeEntry.oid);
      if (blob && blob.size <= MAX_README_BYTES) {
        readme = { name: readmeEntry.name, text: new TextDecoder().decode(blob.bytes) };
      }
    }

    cacheIfImmutable(c, ref);
    const body: TreeResponse = { ref, path, commit: toCommit(commit), entries, readme };
    return c.json(body);
  } finally {
    await objects.close();
  }
});

repos.get("/:owner/:name/blob", async (c) => {
  const loaded = await loadRepo(c);
  if (loaded instanceof Response) return loaded;
  const { row } = loaded;
  const objects = reader(c, row);
  try {
    const target = await resolveTarget(c, objects, row);
    if (target instanceof Response) return target;
    const { ref, path } = target;
    if (!path) return fail(c, 400, "Invalid path.");
    const oid = await objects.resolve(ref);
    const commit = oid ? await objects.commit(oid) : null;
    if (!commit) return fail(c, 404, `No branch, tag or commit named ${ref}.`);
    const entry = await objects.entryAt(commit.treeHash, path);
    const blob = entry && entry.type !== "tree" ? await objects.blob(entry.hash) : null;
    if (!blob) return fail(c, 404, `No file at ${path} on ${ref}.`);

    const head = blob.bytes.subarray(0, MAX_TEXT_BYTES);
    const binary = looksBinary(head);
    cacheIfImmutable(c, ref);
    const body: BlobResponse = {
      ref,
      commitOid: commit.hash,
      path,
      size: blob.size,
      contentType: binary ? "application/octet-stream" : "text/plain; charset=utf-8",
      binary,
      text: binary ? null : new TextDecoder().decode(head),
      truncated: !binary && blob.size > MAX_TEXT_BYTES,
    };
    return c.json(body);
  } finally {
    await objects.close();
  }
});

repos.get("/:owner/:name/history", async (c) => {
  const loaded = await loadRepo(c);
  if (loaded instanceof Response) return loaded;
  const cursor = c.req.query("cursor");
  if (cursor && !isCommitId(cursor)) return fail(c, 400, "Invalid history cursor.");
  const objects = reader(c, loaded.row);
  try {
    const target = await resolveTarget(c, objects, loaded.row);
    if (target instanceof Response) return target;
    const { ref, path } = target;
    const head = await objects.resolve(ref);
    if (
      !head &&
      ref === loaded.row.default_branch &&
      !path &&
      !cursor &&
      !(await objects.refs()).head
    ) {
      return c.json({ ref, head: null, path, scanned: 0, next: null, commits: [], entries: {} });
    }
    if (!head || !(await objects.commit(head)))
      return fail(c, 404, `No branch, tag or commit named ${ref}.`);
    const history = await readHistory(
      objects,
      head,
      path,
      c.req.query("entries") === "true",
      cursor,
    );
    cacheIfImmutable(c, ref);
    return c.json({ ...history, ref });
  } finally {
    await objects.close();
  }
});

repos.get("/:owner/:name/commits", async (c) => {
  const loaded = await loadRepo(c);
  if (loaded instanceof Response) return loaded;
  const { row } = loaded;
  const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);

  const objects = reader(c, row);
  try {
    const target = await resolveTarget(c, objects, row);
    if (target instanceof Response) return target;
    const { ref } = target;
    const oid = await objects.resolve(ref);
    const commits = oid
      ? await objects.log(oid, COMMITS_PER_PAGE + 1, (page - 1) * COMMITS_PER_PAGE)
      : [];
    cacheIfImmutable(c, ref);
    const body: CommitsResponse = {
      ref,
      commits: commits.slice(0, COMMITS_PER_PAGE).map(toCommit),
      hasMore: commits.length > COMMITS_PER_PAGE,
    };
    return c.json(body);
  } finally {
    await objects.close();
  }
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
  await db(c.env.DB)
    .updateTable("repos")
    .set({ description, visibility })
    .where("id", "=", row.id)
    .execute();
  const updated = await findRepo(c.env.DB, c.get("actor"), row.owner_slug, row.name);
  return c.json(updated && repoSummary(updated, c.get("actor")));
});

repos.delete("/:owner/:name", async (c) => {
  const loaded = await loadRepo(c, "admin");
  if (loaded instanceof Response) return loaded;
  const { row } = loaded;
  // Tombstoned now, so it's missing to every reader at once; the purge
  // Workflow then removes what it owned everywhere and, last, the row
  // (CORE-199, worker/retention/repo-deletion.ts). The cron restarts a purge
  // that fails to start or dies.
  const waitUntil = (work: Promise<unknown>) => c.executionCtx.waitUntil(work);
  if (await requestDeletion(c.env, row, c.get("actor")?.id ?? null))
    await launchPurge(c.env, row.id, waitUntil).catch((error: unknown) =>
      console.error("Repository deletion: starting the purge failed", { repo: row.id, error }),
    );
  return c.body(null, 204);
});

repos.get("/:owner/:name/collaborators", async (c) => {
  const loaded = await loadRepo(c, "admin");
  if (loaded instanceof Response) return loaded;
  const results = await db(c.env.DB)
    .selectFrom("repo_collaborators as rc")
    .innerJoin("accounts as a", "a.id", "rc.user_id")
    .selectAll("a")
    .select("rc.role")
    .where("rc.repo_id", "=", loaded.row.id)
    .orderBy("a.slug")
    .execute();
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
  await db(c.env.DB)
    .insertInto("repo_collaborators")
    .values({ repo_id: loaded.row.id, user_id: user.id, role })
    .onConflict((oc) =>
      oc.columns(["repo_id", "user_id"]).doUpdateSet((eb) => ({ role: eb.ref("excluded.role") })),
    )
    .execute();
  const collaborator: Collaborator = { ...accountSummary(user), role };
  return c.json(collaborator);
});

repos.delete("/:owner/:name/collaborators/:username", async (c) => {
  const loaded = await loadRepo(c, "admin");
  if (loaded instanceof Response) return loaded;
  const user = await findAccountBySlug(c.env.DB, c.req.param("username"));
  if (!user) return fail(c, 404, "No such user.");
  await db(c.env.DB)
    .deleteFrom("repo_collaborators")
    .where("repo_id", "=", loaded.row.id)
    .where("user_id", "=", user.id)
    .execute();
  return c.body(null, 204);
});
