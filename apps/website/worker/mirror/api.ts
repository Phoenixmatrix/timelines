import { Hono } from "hono";
import type { RepoMirror, UpdateMirrorRequest } from "../../shared/api.ts";
import type { AppEnv } from "../auth.ts";
import { loadRepo } from "../api/repos.ts";
import { fail, readJson } from "../api/http.ts";
import { accountSummary } from "../db.ts";
import { db, nowIso } from "../schema.ts";
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
