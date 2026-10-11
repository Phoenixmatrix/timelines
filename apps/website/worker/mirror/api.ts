import { Hono } from "hono";
import type { RepoMirror, UpdateMirrorRequest } from "../../shared/api.ts";
import type { AppEnv } from "../auth.ts";
import { loadRepo } from "../api/repos.ts";
import { fail, readJson } from "../api/http.ts";
import { accountSummary } from "../db.ts";
import { db, nowIso } from "../schema.ts";
import { unseal } from "../../registry/core/seal.ts";
import { productionOnly } from "../preview.ts";
import { MirrorError, normalizeMirrorUrl, sealMirrorToken, syncMirror } from "./sync.ts";

/** `/api/repos/:owner/:name/mirror`: a repository's one-way mirror (admins only). */
export const mirrors = new Hono<AppEnv>();

/** Mirror pushes come from one system identity: the instance owner's account. */
export async function mirrorPusher(env: Env) {
  const row = await db(env.DB)
    .selectFrom("accounts")
    .selectAll()
    .where("email", "=", env.OWNER_EMAIL.toLowerCase())
    .where("kind", "=", "user")
    .executeTakeFirst();
  return row ? accountSummary(row) : null;
}

async function current(env: Env, repoId: string): Promise<RepoMirror | null> {
  const [row, pushedAs] = await Promise.all([
    db(env.DB)
      .selectFrom("repo_mirrors")
      .selectAll()
      .where("repo_id", "=", repoId)
      .executeTakeFirst(),
    mirrorPusher(env),
  ]);
  if (!row) return null;
  return {
    url: row.url,
    username: row.username,
    hasToken: row.token_sealed !== null,
    enabled: row.enabled === 1,
    prune: row.prune === 1,
    status: row.status,
    lastError: row.last_error,
    lastAttemptAt: row.last_attempt_at,
    lastSyncedAt: row.last_synced_at,
    lastSyncedCommit: row.last_synced_commit,
    pushedAs,
  };
}

mirrors.get("/:owner/:name/mirror", async (c) => {
  const loaded = await loadRepo(c, "admin");
  if (loaded instanceof Response) return loaded;
  return c.json({ mirror: await current(c.env, loaded.row.id) });
});

mirrors.put("/:owner/:name/mirror", async (c) => {
  const loaded = await loadRepo(c, "admin");
  if (loaded instanceof Response) return loaded;
  const body = await readJson<UpdateMirrorRequest>(c);
  const existing = await current(c.env, loaded.row.id);
  let url: string;
  try {
    url = normalizeMirrorUrl(
      body.url ?? existing?.url ?? "",
      Reflect.get(c.env, "DEV_MODE") === "true",
    );
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : "Invalid URL.");
  }
  const token = body.token?.trim();
  if (!token && !existing?.hasToken) {
    return fail(c, 400, "Give the mirror a token with push access to the target.");
  }
  const values = {
    url,
    username: body.username?.trim() || existing?.username || "x-access-token",
    enabled: (body.enabled ?? existing?.enabled ?? true) ? 1 : 0,
    prune: (body.prune ?? existing?.prune ?? false) ? 1 : 0,
    updated_at: nowIso(),
    ...(token ? { token_sealed: await sealMirrorToken(c.env, token) } : {}),
  };
  await db(c.env.DB)
    .insertInto("repo_mirrors")
    .values({ repo_id: loaded.row.id, ...values })
    .onConflict((oc) => oc.column("repo_id").doUpdateSet(values))
    .execute();
  return c.json({ mirror: await current(c.env, loaded.row.id) });
});

mirrors.delete("/:owner/:name/mirror", async (c) => {
  const loaded = await loadRepo(c, "admin");
  if (loaded instanceof Response) return loaded;
  await db(c.env.DB).deleteFrom("repo_mirrors").where("repo_id", "=", loaded.row.id).execute();
  return c.body(null, 204);
});

/** Sync now and report how it went (pushes sync on their own, through the queue). */
mirrors.post("/:owner/:name/mirror/sync", async (c) => {
  const loaded = await loadRepo(c, "admin");
  if (loaded instanceof Response) return loaded;
  try {
    const result = await syncMirror(c.env, loaded.row.id);
    if (result.status === "skipped") return fail(c, 409, "This repository has no enabled mirror.");
    if (result.status === "busy")
      return fail(c, 409, "A sync is already running. Try again shortly.");
    return c.json({
      message: result.message,
      updates: result.updates,
      mirror: await current(c.env, loaded.row.id),
    });
  } catch (error) {
    if (error instanceof MirrorError) return fail(c, 502, error.message);
    throw error;
  }
});

/**
 * Rename an existing GitHub backup through its configured mirror, not a second
 * source of Git writes. The remote ID fences stale names and accidental targets.
 */
mirrors.post("/:owner/:name/mirror/rename", async (c) => {
  const loaded = await loadRepo(c, "admin");
  if (loaded instanceof Response) return loaded;
  if (!productionOnly(c.env, "mirror", "renaming a GitHub backup"))
    return fail(c, 403, "Previews cannot rename mirror targets.");
  const body = await readJson<{
    name?: unknown;
    expectedRepositoryId?: unknown;
    token?: unknown;
  }>(c);
  if (
    typeof body.name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(body.name) ||
    !Number.isSafeInteger(body.expectedRepositoryId) ||
    Number(body.expectedRepositoryId) <= 0 ||
    (body.token !== undefined && (typeof body.token !== "string" || !body.token.trim()))
  )
    return fail(
      c,
      400,
      "Send a repository name, its expected GitHub numeric ID and an optional administration token.",
    );
  const d = db(c.env.DB);
  const lease = new Date(Date.now() + 10 * 60_000).toISOString();
  const row = await d
    .updateTable("repo_mirrors")
    .set({ lease_until: lease })
    .where("repo_id", "=", loaded.row.id)
    .where((eb) => eb.or([eb("lease_until", "is", null), eb("lease_until", "<", nowIso())]))
    .returningAll()
    .executeTakeFirst();
  if (!row)
    return fail(c, 409, "Configure a mirror first, and wait for any active mirror operation.");
  try {
    const target = new URL(row.url);
    const parts = /^\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)\.git$/.exec(target.pathname);
    if (target.origin !== "https://github.com" || target.username || target.password || !parts)
      return fail(c, 400, "Only an existing github.com repository mirror can be renamed.");
    const token =
      typeof body.token === "string"
        ? body.token.trim()
        : row.token_sealed
          ? await unseal(c.env, row.token_sealed)
          : null;
    if (!token)
      return fail(c, 400, "A GitHub token with repository administration access is required.");
    const headers = {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "Timelines-mirror",
      "x-github-api-version": "2026-03-10",
    };
    const endpoint = `https://api.github.com/repos/${parts[1]}/${parts[2]}`;
    const before = await fetch(endpoint, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!before.ok)
      return fail(
        c,
        502,
        `GitHub refused mirror inspection (HTTP ${before.status}). Check the target and token permissions.`,
      );
    const identity = (await before.json()) as { id?: unknown };
    if (identity.id !== body.expectedRepositoryId)
      return fail(c, 409, "The configured GitHub repository no longer has the expected identity.");
    const renamed = await fetch(endpoint, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: body.name }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!renamed.ok)
      return fail(
        c,
        502,
        `GitHub refused the rename (HTTP ${renamed.status}). It requires an available name and repository administration access.`,
      );
    const result = (await renamed.json()) as { id?: unknown; full_name?: unknown };
    const fullName = `${parts[1]}/${body.name}`;
    if (
      result.id !== body.expectedRepositoryId ||
      typeof result.full_name !== "string" ||
      result.full_name.toLowerCase() !== fullName.toLowerCase()
    )
      return fail(
        c,
        502,
        "GitHub returned an unexpected identity; inspect the remote before changing mirror configuration.",
      );
    const updated = await d
      .updateTable("repo_mirrors")
      .set({ url: `https://github.com/${result.full_name}.git`, updated_at: nowIso() })
      .where("repo_id", "=", loaded.row.id)
      .where("url", "=", row.url)
      .where("lease_until", "=", lease)
      .executeTakeFirst();
    if (!updated.numUpdatedRows)
      return fail(
        c,
        409,
        "GitHub renamed the repository, but mirror configuration changed concurrently. Inspect both before updating the mirror URL.",
      );
    return c.json({ repositoryId: result.id, mirror: await current(c.env, loaded.row.id) });
  } catch {
    return fail(
      c,
      502,
      "Mirror rename could not be confirmed. Inspect the GitHub repository before retrying.",
    );
  } finally {
    await d
      .updateTable("repo_mirrors")
      .set({ lease_until: null })
      .where("repo_id", "=", loaded.row.id)
      .where("lease_until", "=", lease)
      .execute();
  }
});
