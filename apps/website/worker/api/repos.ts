import { Hono, type Context } from "hono";
import { sql } from "kysely";
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
  UpdateRepoRequest,
  Visibility,
} from "../../shared/api.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { noteAgentPresence, readAgentPresence } from "../agent-presence.ts";
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
import { COMPARE_COMMITS, type CommitDiff, type CompareDiff } from "../../shared/diff.ts";
import { commitsSince, DiffBudget, diffFiles, readEither } from "../compare.ts";
import { mergeBase } from "../knowledge/overlay.ts";
import { isCommitId, RepoReader } from "../objects.ts";
import { atLeast } from "../permissions.ts";
import { db } from "../schema.ts";
import { readHistory } from "../history/read.ts";
import { semanticResponse } from "../semantic/api.ts";
import { fail, readJson, requireActor } from "./http.ts";
import { getWorkSource, resolveSource, workGitPath } from "../timelines/sources.ts";
import { TrackerError } from "../tracker/store.ts";
import { sourceLineage } from "../ref-log/lineage.ts";
import type { CodeSource } from "../../shared/code-source.ts";
import { authorize } from "../tracker/api.ts";
import { trackerObject } from "../tracker/stub.ts";
import { recoverSourcePush } from "../git/source-push.ts";
import { deliverRecoveredSourcePush } from "../git/source-push-delivery.ts";

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

/** Authorize the canonical repository before resolving its physical source. */
export async function loadSourceRepo(
  c: Context<AppEnv>,
  needed: RepoRole = "read",
  metadataOnly = false,
) {
  const loaded = await loadRepo(c, needed);
  if (loaded instanceof Response) return loaded;
  try {
    const resolved = await resolveSource(c.env, loaded.row, c.req.query("source"));
    return {
      row: resolved.repo,
      canonical: loaded.row,
      source: resolved.source,
      role: loaded.role,
      expired: false,
    };
  } catch (error) {
    if (metadataOnly && error instanceof TrackerError && error.code === "source_expired") {
      const owned = await getWorkSource(c.env, loaded.row.id, c.req.query("source")!);
      if (owned && owned.owner_id === loaded.row.owner_id) {
        const source: CodeSource = {
          sourceId: owned.source_id,
          repoId: loaded.row.id,
          kind: "timeline-work",
          timelineId: owned.timeline_id,
          ref: owned.work_ref,
        };
        return {
          row: {
            ...loaded.row,
            source_id: owned.source_id,
            artifacts_name: owned.artifacts_name,
            artifacts_remote: owned.artifacts_remote ?? "",
            default_branch: owned.work_ref.replace(/^refs\/heads\//, ""),
          },
          canonical: loaded.row,
          source,
          role: loaded.role,
          expired: true,
        };
      }
    }
    if (error instanceof TrackerError)
      return c.json({ error: error.message, code: error.code }, error.status);
    throw error;
  }
}

repos.get("/:owner/:name/sources/:sourceId/lineage", async (c) => {
  const loaded = await loadRepo(c);
  if (loaded instanceof Response) return loaded;
  const commit = c.req.query("commit") ?? "";
  if (!isCommitId(commit)) return fail(c, 400, "commit must be a full commit hash.");
  c.header("cache-control", "private, no-store");
  const result = await sourceLineage(c.env, loaded.row, c.req.param("sourceId"), commit);
  return result ? c.json(result) : fail(c, 404, "No such code source.");
});

async function sourcePushRoute(c: Context<AppEnv>, action: "list" | "inspect" | "recover") {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  if (action === "recover") {
    const credential = await tokenCredential(c);
    if (credential.kind === "token" && credential.scope !== "write")
      return fail(c, 403, "This token is read-only.");
  }
  const loaded = await loadRepo(c, action === "recover" ? "write" : "read");
  if (loaded instanceof Response) return loaded;
  c.header("cache-control", "private, no-store");
  try {
    const access = await authorize(c, false);
    if (access.owner.id !== loaded.row.owner_id) return fail(c, 404, "No matching source.");
    const sourceId = c.req.param("sourceId")!;
    const source = await getWorkSource(c.env, loaded.row.id, sourceId);
    if (!source || source.owner_id !== loaded.row.owner_id || sourceId === "canonical")
      return fail(c, 404, "No matching owned source.");
    const tracker = trackerObject(c.env, loaded.row.owner_id);
    if (action === "list") {
      const result = await tracker.sourcePushes(loaded.row.id);
      if (!result.ok) return c.json({ error: result.error, code: result.code }, result.status);
      return c.json({
        sourceId,
        operations: result.value.filter((operation) => operation.sourceId === sourceId),
      });
    }
    const operationId = c.req.param("operationId")!;
    if (action === "inspect") {
      const result = await tracker.sourcePush(operationId, loaded.row.id, sourceId);
      if (!result.ok) return c.json({ error: result.error, code: result.code }, result.status);
      return c.json(result.value);
    }
    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      return fail(c, 400, "Expected an empty JSON object.");
    }
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length)
      return fail(c, 400, "Expected an empty JSON object.");
    const result = await recoverSourcePush(
      c.env,
      loaded.row,
      sourceId,
      operationId,
      access.actorId,
      access.principalId,
    );
    if (
      source.state === "ready" &&
      source.artifacts_remote &&
      (result.state === "accepted" || result.syncRequired)
    ) {
      const physical = {
        ...loaded.row,
        source_id: sourceId,
        artifacts_name: source.artifacts_name,
        artifacts_remote: source.artifacts_remote,
        default_branch: source.work_ref.replace(/^refs\/heads\//, ""),
      };
      await deliverRecoveredSourcePush(
        c.env,
        physical,
        operationId,
        result.state === "accepted" ? null : actor,
        (work) => c.executionCtx.waitUntil(work),
      );
    }
    return c.json(result);
  } catch (error) {
    if (error instanceof TrackerError)
      return c.json({ error: error.message, code: error.code }, error.status);
    throw error;
  }
}

repos.get("/:owner/:name/sources/:sourceId/pushes", (c) => sourcePushRoute(c, "list"));
repos.get("/:owner/:name/sources/:sourceId/pushes/:operationId", (c) =>
  sourcePushRoute(c, "inspect"),
);
repos.post("/:owner/:name/sources/:sourceId/pushes/:operationId/recover", (c) =>
  sourcePushRoute(c, "recover"),
);

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
function reader(c: Context<AppEnv>, row: RepoRow & { source_id?: string }): RepoReader {
  return new RepoReader(
    c.env,
    row.artifacts_name,
    row.artifacts_remote,
    c.get("timing"),
    (work) => c.executionCtx.waitUntil(work),
    row.source_id && row.source_id !== "canonical" ? `refs/heads/${row.default_branch}` : undefined,
  );
}

/** Responses addressed by commit id never change, so browsers may keep them. */
function cacheIfImmutable(c: Context<AppEnv>, ref: string) {
  if (c.req.query("source") && c.req.query("source") !== "canonical") {
    c.header("cache-control", "private, no-store");
    return;
  }
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
  const loaded = await loadSourceRepo(c, "read", c.req.query("metadata") === "1");
  if (loaded instanceof Response) return loaded;
  const { row } = loaded;
  const owned =
    loaded.source.sourceId === "canonical"
      ? null
      : await getWorkSource(c.env, row.id, loaded.source.sourceId);
  if (loaded.source.sourceId !== "canonical" && !owned)
    return fail(c, 404, "Code source not found.");

  const detail: RepoDetail = {
    ...repoSummary(loaded.canonical, c.get("actor")),
    source: loaded.source,
    sourceState: loaded.expired ? "expired" : owned?.state === "archived" ? "archived" : "ready",
    state: "ready",
    cloneUrl: `${new URL(c.req.url).origin}${owned ? workGitPath(loaded.canonical, owned.timeline_slug) : `/${row.owner_slug}/${row.name}.git`}`,
    head: null,
    branches: [],
    tags: [],
  };
  // The repository shell and retained output need identity after Git expiry,
  // never a canonical ref list substituted for the unavailable work source.
  if (loaded.expired) return c.json(detail);
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
    if (
      loaded.source.sourceId === "canonical" &&
      refs.headBranch &&
      refs.headBranch !== row.default_branch
    ) {
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
  const loaded = await loadSourceRepo(c);
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
    const body: TreeResponse = {
      source: loaded.source,
      ref,
      path,
      commit: toCommit(commit),
      entries,
      readme,
    };
    return c.json(body);
  } finally {
    await objects.close();
  }
});

repos.get("/:owner/:name/blob", async (c) => {
  const loaded = await loadSourceRepo(c);
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
      source: loaded.source,
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
  const loaded = await loadSourceRepo(c);
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
      return c.json({
        source: loaded.source,
        ref,
        head: null,
        path,
        scanned: 0,
        next: null,
        commits: [],
        entries: {},
      });
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
    return c.json({ ...history, source: loaded.source, ref });
  } finally {
    await objects.close();
  }
});

repos.get("/:owner/:name/commits/:oid/presence", async (c) => {
  const loaded = await loadSourceRepo(c);
  if (loaded instanceof Response) return loaded;
  const oid = c.req.param("oid");
  if (!isCommitId(oid) || oid.length !== 40)
    return fail(c, 400, "Give the full 40-character commit hash.");
  const objects = reader(c, loaded.row);
  try {
    const commit = await objects.commit(oid);
    if (!commit) return fail(c, 404, `No commit ${oid}.`);
    c.header("cache-control", "private, no-store");
    return c.json(
      await readAgentPresence(c.env.DB, {
        kind: "commit",
        scopeId: loaded.canonical.id,
        resourceId: commit.hash,
        sourceId: loaded.source.sourceId,
      }),
    );
  } finally {
    await objects.close();
  }
});

// One commit's diff against its first parent (CORE-234: a step's work).
// Bounded: DIFF_LIMITS caps files listed, files patched, blob size and tree reads.
repos.get("/:owner/:name/commits/:oid/diff", async (c) => {
  // A timeline's commit may live only in its work source (`?source=`, CORE-296).
  const loaded = await loadSourceRepo(c);
  if (loaded instanceof Response) return loaded;
  const oid = c.req.param("oid");
  if (!isCommitId(oid) || oid.length !== 40)
    return fail(c, 400, "Give the full 40-character commit hash.");
  const objects = reader(c, loaded.row);
  try {
    const commit = await objects.commit(oid);
    if (!commit) return fail(c, 404, `No commit ${oid}.`);
    const parent = commit.parents[0] ? await objects.commit(commit.parents[0]) : null;
    let diffed: Awaited<ReturnType<typeof diffFiles>>;
    try {
      diffed = await diffFiles(objects, parent?.treeHash ?? null, commit.treeHash);
    } catch (error) {
      if (!(error instanceof DiffBudget)) throw error;
      return fail(c, 413, "This commit changes too much to show here.");
    }
    const body: CommitDiff = {
      oid,
      parents: commit.parents,
      message: commit.message,
      authorName: commit.author.name,
      authoredAt: commit.authoredAt,
      files: diffed.files,
      truncated: diffed.truncated,
    };
    cacheIfImmutable(c, oid);
    noteAgentPresence(c, {
      kind: "commit",
      scopeId: loaded.canonical.id,
      resourceId: commit.hash,
      sourceId: loaded.source.sourceId,
    });
    return c.json(body);
  } finally {
    await objects.close();
  }
});

const REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

// What a line of work changes (CORE-382): `head` (a commit id or branch/tag in
// the loaded source, so a timeline's work source via `?source=`) against its
// merge base with `base` (a commit id or branch/tag in the canonical repository,
// default its default branch), so main merged into a timeline isn't the
// timeline's change. Commits are listed newest first, as `git log base..head`.
// Objects are read from the source, then the canonical repository: a work
// source is a fork, and newer main commits exist only in canonical. Reads
// check both repositories' caches before any remote read, starting with the
// side that served a neighbour (base: canonical, head: source), so main's
// commits never cost a certain miss on the work source (CORE-400).
repos.get("/:owner/:name/compare", async (c) => {
  const loaded = await loadSourceRepo(c);
  if (loaded instanceof Response) return loaded;
  const headRef = c.req.query("head") ?? "";
  const baseRef = c.req.query("base") || loaded.canonical.default_branch;
  for (const ref of [headRef, baseRef])
    if (!isCommitId(ref) && (!REF_NAME.test(ref) || ref.includes("..") || ref.endsWith("/")))
      return fail(c, 400, "Give head and base as a branch, tag or full 40-character commit hash.");
  const sourceObjects = reader(c, loaded.row);
  // The canonical source is one repository; a work source adds the canonical one.
  const canonicalObjects =
    loaded.source.sourceId === "canonical" ? sourceObjects : reader(c, loaded.canonical);
  try {
    const either =
      canonicalObjects === sourceObjects ? null : readEither(sourceObjects, canonicalObjects);
    const objects = either ?? sourceObjects;
    const head = await sourceObjects.resolve(headRef);
    // A base named by branch is where work lands (canonical); a commit id may also be
    // the timeline's own, such as an earlier checkpoint (CORE-382).
    const base =
      isCommitId(baseRef) && baseRef.length === 40
        ? baseRef
        : await canonicalObjects.resolve(baseRef);
    if (head) either?.prefer(head, sourceObjects);
    // A base given as a commit id may be the timeline's own, so it isn't assumed canonical.
    if (base && !isCommitId(baseRef)) either?.prefer(base, canonicalObjects);
    if (!head || !(await objects.commit(head))) return fail(c, 404, `No commit named ${headRef}.`);
    const baseCommit = base && (await objects.commit(base));
    if (!base || !baseCommit) return fail(c, 404, `No commit named ${baseRef}.`);
    const found = await mergeBase(objects, head, base);
    const from = found.base ?? base;
    const fromCommit = from === base ? baseCommit : await objects.commit(from);
    const headCommit = (await objects.commit(head))!;
    if (!fromCommit) return fail(c, 404, `No commit ${from}.`);
    const history = await commitsSince(objects, head, from, COMPARE_COMMITS);
    let diffed: Awaited<ReturnType<typeof diffFiles>>;
    try {
      diffed = await diffFiles(objects, fromCommit.treeHash, headCommit.treeHash);
    } catch (error) {
      if (error instanceof DiffBudget)
        return fail(c, 413, "These changes are too large to show here.");
      // A tree neither repository has (CORE-382): the history was pruned.
      if (error instanceof Error && /^Tree \S+ not found$/.test(error.message))
        return fail(c, 404, "Part of this history isn't available.");
      throw error;
    }
    const body: CompareDiff = {
      base,
      head,
      from,
      mergeBase: found.base,
      historyTruncated: found.truncated,
      commits: history.commits,
      commitsTruncated: history.truncated,
      files: diffed.files,
      truncated: diffed.truncated,
    };
    // Branch names move; only two commit ids name an unchanging comparison.
    if (isCommitId(headRef) && isCommitId(baseRef)) cacheIfImmutable(c, head);
    noteAgentPresence(c, {
      kind: "commit",
      scopeId: loaded.canonical.id,
      resourceId: head,
      sourceId: loaded.source.sourceId,
    });
    return c.json(body);
  } finally {
    await sourceObjects.close();
    if (canonicalObjects !== sourceObjects) await canonicalObjects.close();
  }
});

repos.get("/:owner/:name/commits", async (c) => {
  const loaded = await loadSourceRepo(c);
  if (loaded instanceof Response) return loaded;
  const { row } = loaded;
  const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);

  const objects = reader(c, row);
  try {
    const target = await resolveTarget(c, objects, row);
    if (target instanceof Response) return target;
    const { ref } = target;
    const oid = await objects.resolve(ref);
    if (
      (oid && !(await objects.commit(oid))) ||
      (!oid && (c.req.query("ref") || c.req.query("at")))
    )
      return fail(c, 404, `No branch, tag or commit named ${ref}.`);
    const commits = oid
      ? await objects.log(oid, COMMITS_PER_PAGE + 1, (page - 1) * COMMITS_PER_PAGE)
      : [];
    cacheIfImmutable(c, ref);
    const body: CommitsResponse = {
      source: loaded.source,
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
  const body = await readJson<UpdateRepoRequest>(c);
  const name =
    body.name === undefined ? row.name : typeof body.name === "string" ? body.name.trim() : "";
  if (!REPO_NAME.test(name) || name.toLowerCase().endsWith(".git")) {
    return fail(
      c,
      400,
      "Use letters, numbers, dots, dashes and underscores, without a .git ending.",
    );
  }
  const description = body.description?.trim() ?? row.description;
  const visibility =
    body.visibility === "public" || body.visibility === "private"
      ? body.visibility
      : row.visibility;
  // One conditional statement arbitrates names (including tombstones) without
  // touching storage, source identities or any ID-keyed dependent records.
  const result = await db(c.env.DB)
    .updateTable("repos")
    .set({ name, description, visibility })
    .where("id", "=", row.id)
    .where("name", "=", row.name)
    .where("deleted_at", "is", null)
    .where(sql<boolean>`NOT EXISTS (
      SELECT 1 FROM repos AS occupied
      WHERE occupied.owner_id = ${row.owner_id}
        AND occupied.name = ${name} AND occupied.id != ${row.id}
    )`)
    .executeTakeFirst();
  if (!result.numUpdatedRows) {
    const current = await db(c.env.DB)
      .selectFrom("repos")
      .select(["name", "deleted_at"])
      .where("id", "=", row.id)
      .executeTakeFirst();
    if (!current || current.deleted_at) return fail(c, 404, "Repository not found.");
    const existing = await findRepo(c.env.DB, null, row.owner_slug, name, { deleting: true });
    return fail(
      c,
      409,
      existing && existing.id !== row.id
        ? existing.deleted_at
          ? `${row.owner_slug}/${name} is being deleted. Its name is free again once that finishes.`
          : `${row.owner_slug}/${name} already exists.`
        : "The repository changed during this request. Reload it and try again.",
    );
  }
  const updated = await findRepo(c.env.DB, c.get("actor"), row.owner_slug, name);
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
