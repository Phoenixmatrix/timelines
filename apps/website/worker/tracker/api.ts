import { Hono, type Context } from "hono";
import type { AppEnv } from "../auth.ts";
import {
  findAccountBySlug,
  findRepo,
  roleFor,
  visibleRepos,
  type AccountRow,
  type Actor,
} from "../db.ts";
import type { TrackerIdentity, TrackerOwner } from "../../shared/tracker.ts";
import { TrackerError, validateRequest, type Access } from "./store.ts";
import type { Tracker, TrackerReply } from "./object.ts";

export const tracker = new Hono<AppEnv>();

function trackerObject(env: Env, ownerId: string): DurableObjectStub<Tracker> {
  // String-named exports in the config cannot infer their RPC class.
  return (env.TRACKER as unknown as DurableObjectNamespace<Tracker>).getByName(ownerId);
}

async function accessible(db: D1Database, actor: Actor): Promise<TrackerOwner[]> {
  const rows = await db
    .prepare(`SELECT a.id,a.slug,a.display_name,m.role FROM accounts a
    LEFT JOIN org_members m ON m.org_id=a.id AND m.user_id=?
    WHERE a.id=? OR (a.kind='org' AND m.user_id IS NOT NULL) ORDER BY a.slug`)
    .bind(actor.id, actor.id)
    .all<{ id: string; slug: string; display_name: string; role: string | null }>();
  return rows.results.map((row) => ({
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    canAdmin: row.id === actor.id || row.role === "owner",
  }));
}
async function authorize(c: Context<AppEnv>, includeMembers = true): Promise<Access> {
  const actor = c.get("actor");
  if (!actor) throw new TrackerError(401, "unauthenticated", "Sign in to access trackers.");
  const owner = await findAccountBySlug(c.env.DB, c.req.param("owner")!);
  if (!owner) throw new TrackerError(404, "not_found", "Tracker account not found.");
  let canAdmin = owner.id === actor.id;
  if (!canAdmin) {
    const membership =
      owner.kind === "org"
        ? await c.env.DB.prepare("SELECT role FROM org_members WHERE org_id=? AND user_id=?")
            .bind(owner.id, actor.id)
            .first<{ role: string }>()
        : null;
    if (!membership)
      throw new TrackerError(403, "forbidden", "Tracker access requires account membership.");
    canAdmin = membership.role === "owner";
  }
  const members = !includeMembers
    ? []
    : owner.kind === "user"
      ? [owner]
      : (
          await c.env.DB.prepare(
            "SELECT a.* FROM accounts a JOIN org_members m ON m.user_id=a.id WHERE m.org_id=? ORDER BY a.slug",
          )
            .bind(owner.id)
            .all<AccountRow>()
        ).results;
  return {
    actorId: actor.id,
    owner: { id: owner.id, slug: owner.slug, displayName: owner.display_name },
    canAdmin,
    members: members.map((m): TrackerIdentity => ({
      id: m.id,
      slug: m.slug,
      displayName: m.display_name,
    })),
    repos: [],
  };
}
function response<T>(c: Context<AppEnv>, result: TrackerReply<T>) {
  return result.ok
    ? Response.json(result.value)
    : c.json({ error: result.error, code: result.code, ...result.details }, result.status);
}
async function body(c: Context<AppEnv>): Promise<unknown> {
  const stream = c.req.raw.body;
  if (!stream) throw new TrackerError(400, "invalid_input", "A JSON body is required.");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_048_576) {
        await reader.cancel();
        throw new TrackerError(413, "body_too_large", "Mutation body exceeds 1 MiB.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new TrackerError(400, "invalid_input", "Body must be valid UTF-8 JSON.");
  }
}
tracker.onError((error, c) => {
  if (error instanceof TrackerError)
    return c.json({ error: error.message, code: error.code, ...error.details }, error.status);
  throw error;
});
tracker.get("/tracker", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "Sign in to access trackers." }, 401);
  return c.json({ trackers: await accessible(c.env.DB, actor) });
});
tracker.get("/tracker/:owner/snapshot", async (c) => {
  const access = await authorize(c);
  return response(c, await trackerObject(c.env, access.owner.id).snapshot(access));
});
tracker.get("/tracker/:owner/changes", async (c) => {
  const access = await authorize(c, false);
  const after = c.req.query("after") ?? "0";
  const limit = c.req.query("limit") ?? "200";
  if (!/^\d+$/.test(after) || !/^\d+$/.test(limit))
    throw new TrackerError(400, "invalid_input", "after and limit must be integers.");
  return response(
    c,
    await trackerObject(c.env, access.owner.id).changes(Number(after), Number(limit)),
  );
});
tracker.post("/tracker/:owner/mutate", async (c) => {
  const access = await authorize(c);
  const request = validateRequest(await body(c));
  if (
    request.mutations.some(
      (mutation) => mutation.kind === "subscription.add" || mutation.kind === "subscription.remove",
    )
  ) {
    if (!access.canAdmin)
      throw new TrackerError(
        403,
        "forbidden",
        "Tracker administration requires account ownership.",
      );
    access.repos = (await visibleRepos(c.env.DB, c.get("actor")))
      .filter((repo) => repo.viewerRole === "admin")
      .map((repo) => ({ id: repo.id, owner: repo.owner.slug, name: repo.name }));
    const removals = request.mutations
      .filter((mutation) => mutation.kind === "subscription.remove")
      .map((mutation) => mutation.id);
    if (removals.length) {
      const lookup = await trackerObject(c.env, access.owner.id).subscriptionRepoIds(removals);
      if (!lookup.ok) return response(c, lookup);
      if (lookup.value.length) {
        const existing = await c.env.DB.prepare(
          `SELECT id FROM repos WHERE id IN (${lookup.value.map(() => "?").join(",")})`,
        )
          .bind(...lookup.value)
          .all<{ id: string }>();
        const ids = new Set(existing.results.map((repo) => repo.id));
        access.deletedRepoIds = lookup.value.filter((repoId) => !ids.has(repoId));
      }
    }
  }
  return response(c, await trackerObject(c.env, access.owner.id).mutate(access, request));
});
tracker.get("/repos/:owner/:name/tracker", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "Sign in to access trackers." }, 401);
  const repo = await findRepo(c.env.DB, actor, c.req.param("owner"), c.req.param("name"));
  if (!repo || roleFor(repo, actor) === "none")
    return c.json({ error: "Repository not found." }, 404);
  const workspaces: { trackerOwner: string; workspaceId: string; slug: string; name: string }[] =
    [];
  for (const owner of await accessible(c.env.DB, actor)) {
    const result = await trackerObject(c.env, owner.id).subscribedWorkspaces(repo.id);
    if (!result.ok) return response(c, result);
    for (const workspace of result.value)
      workspaces.push({ trackerOwner: owner.slug, ...workspace });
  }
  return c.json({ workspaces });
});
