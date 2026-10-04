import { Hono, type Context } from "hono";
import type { AppEnv } from "../auth.ts";
import { findAccountBySlug, findRepo, roleFor, visibleRepos, type Actor } from "../db.ts";
import { db as gitmatrixDb } from "../schema.ts";
import type {
  HumanRequest,
  OpenRequest,
  OpenRequests,
  TrackerList,
  TrackerView,
  TrackerOwner,
} from "../../shared/tracker.ts";
import { TrackerError, validateRequest, type Access } from "./store.ts";
import { accessFor } from "./access.ts";
import type { TrackerReply } from "./object.ts";
import { trackerObject } from "./stub.ts";
import { CHRONICLE_PAGE, type LinkedWork } from "../../shared/chronicle.ts";
import { linkedWork } from "./work.ts";
import {
  clearPreferences,
  defaultOwner,
  parsePreferences,
  preferencesFor,
  savePreferences,
} from "./preferences.ts";
import { refreshAfterTrackerMutation } from "../release-notes/queue.ts";
import { view as checkpointView, writableRepoIds } from "../timelines/checkpoints.ts";

export const tracker = new Hono<AppEnv>();

/** The trackers an actor can read: their own, and their organizations'. */
export async function accessible(db: D1Database, actor: Actor): Promise<TrackerOwner[]> {
  const rows = await gitmatrixDb(db)
    .selectFrom("accounts as a")
    .leftJoin("org_members as m", (join) =>
      join.onRef("m.org_id", "=", "a.id").on("m.user_id", "=", actor.id),
    )
    .select(["a.id", "a.slug", "a.display_name", "m.role"])
    .where((eb) =>
      eb.or([
        eb("a.id", "=", actor.id),
        eb.and([eb("a.kind", "=", "org"), eb("m.user_id", "is not", null)]),
      ]),
    )
    .orderBy("a.slug")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    canAdmin: row.id === actor.id || row.role === "owner",
  }));
}
export async function authorize(c: Context<AppEnv>, includeMembers = true): Promise<Access> {
  const actor = c.get("actor");
  if (!actor) throw new TrackerError(401, "unauthenticated", "Sign in to access trackers.");
  const owner = await findAccountBySlug(c.env.DB, c.req.param("owner")!);
  if (!owner) throw new TrackerError(404, "not_found", "Tracker account not found.");
  let canAdmin = owner.id === actor.id;
  if (!canAdmin) {
    const membership =
      owner.kind === "org"
        ? await gitmatrixDb(c.env.DB)
            .selectFrom("org_members")
            .select("role")
            .where("org_id", "=", owner.id)
            .where("user_id", "=", actor.id)
            .executeTakeFirst()
        : null;
    if (!membership)
      throw new TrackerError(403, "forbidden", "Tracker access requires account membership.");
    canAdmin = membership.role === "owner";
  }
  return accessFor(c.env.DB, owner, actor.id, actor.agent?.id ?? null, canAdmin, includeMembers);
}
/** `?timeline=<slug>`: a timeline's view instead of main's. */
function timelineParam(c: Context<AppEnv>): string | undefined {
  const timeline = c.req.query("timeline");
  if (timeline === undefined || timeline === "" || timeline === "main") return undefined;
  if (timeline.length > 100)
    throw new TrackerError(400, "invalid_input", "timeline must be a slug or id.");
  return timeline;
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
  const [trackers, defaultOwnerId] = await Promise.all([
    accessible(c.env.DB, actor),
    defaultOwner(c.env.DB, actor.id),
  ]);
  return c.json<TrackerList>({ viewerId: actor.id, trackers, defaultOwnerId });
});
/** Open requests to people across every tracker you're in: yours first, then the rest. */
tracker.get("/requests", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "Sign in to see what needs you." }, 401);
  const requests: OpenRequest[] = [];
  for (const owner of await accessible(c.env.DB, actor)) {
    const stub = trackerObject(c.env, owner.id);
    const result = await stub.openRequests();
    if (!result.ok) return response(c, result);
    // An approval of a timeline checkpoint shows its commits, CI runs, previews and summary.
    const pinned = result.value.flatMap(({ request }) =>
      request.checkpoint ? [request.checkpoint.id] : [],
    );
    const checkpoints = new Map<string, OpenRequest["checkpoint"]>();
    if (pinned.length) {
      const states = await stub.checkpointStates(pinned);
      if (!states.ok) return response(c, states);
      for (const { state, timeline } of states.value)
        checkpoints.set(state.checkpoint.id, await checkpointView(c.env, state, timeline));
    }
    for (const item of result.value) {
      const checkpoint = item.request.checkpoint && checkpoints.get(item.request.checkpoint.id);
      requests.push({
        tracker: { slug: owner.slug, displayName: owner.displayName },
        ...item,
        ...(checkpoint ? { checkpoint } : {}),
      });
    }
  }
  requests.sort(
    (a, b) =>
      Number(b.request.routeTo === actor.id) - Number(a.request.routeTo === actor.id) ||
      a.request.createdAt.localeCompare(b.request.createdAt),
  );
  const ids = [...new Set(requests.flatMap(({ request }) => [request.askedBy, request.routeTo]))];
  const names: Record<string, string> = {};
  if (ids.length) {
    const k = gitmatrixDb(c.env.DB);
    const [people, agents] = await Promise.all([
      k.selectFrom("accounts").select(["id", "display_name"]).where("id", "in", ids).execute(),
      k
        .selectFrom("agents as g")
        .innerJoin("accounts as a", "a.id", "g.accountable_id")
        .select(["g.id", "g.name", "a.display_name"])
        .where("g.id", "in", ids)
        .execute(),
    ]);
    for (const p of people) names[p.id] = p.display_name;
    for (const g of agents) names[g.id] = `${g.name} for ${g.display_name}`;
  }
  return c.json<OpenRequests>({ requests, names });
});
// A single authenticated browser request, without the repository list or a session preflight.
tracker.get("/tracker/:owner/view", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "Sign in to access trackers." }, 401);
  const [view, trackers] = await Promise.all([
    authorize(c).then(async (access) => ({
      result: await trackerObject(c.env, access.owner.id).snapshot(access, timelineParam(c)),
      // An agent sees its person's defaults: they're whose work it does.
      preferences: await preferencesFor(c.env.DB, actor.id, access.owner.id),
    })),
    accessible(c.env.DB, actor),
  ]);
  if (!view.result.ok) return response(c, view.result);
  return c.json<TrackerView>({
    snapshot: view.result.value,
    trackers,
    preferences: view.preferences,
  });
});
/** Your defaults for this tracker (CORE-119); an agent reads its person's. */
tracker.get("/tracker/:owner/preferences", async (c) => {
  const access = await authorize(c, false);
  return c.json({
    preferences: await preferencesFor(c.env.DB, c.get("actor")!.id, access.owner.id),
  });
});
tracker.put("/tracker/:owner/preferences", async (c) => {
  const access = await authorize(c, false);
  const actor = c.get("actor")!;
  if (actor.agent)
    throw new TrackerError(
      403,
      "forbidden",
      "Defaults are your person's to set; agents follow them.",
    );
  const parsed = parsePreferences(await body(c));
  if (typeof parsed === "string") throw new TrackerError(400, "invalid_input", parsed);
  return c.json({
    preferences: await savePreferences(c.env.DB, actor.id, access.owner.id, parsed),
  });
});
tracker.delete("/tracker/:owner/preferences", async (c) => {
  const access = await authorize(c, false);
  const actor = c.get("actor")!;
  if (actor.agent)
    throw new TrackerError(
      403,
      "forbidden",
      "Defaults are your person's to set; agents follow them.",
    );
  await clearPreferences(c.env.DB, actor.id, access.owner.id);
  return c.body(null, 204);
});
tracker.get("/tracker/:owner/snapshot", async (c) => {
  const access = await authorize(c);
  return response(
    c,
    await trackerObject(c.env, access.owner.id).snapshot(
      access,
      timelineParam(c),
      c.req.query("timelines") === "1",
    ),
  );
});
tracker.get("/tracker/:owner/changes", async (c) => {
  // Members and agents aren't events: a replica asks for them (directory=1) to
  // learn of agents created and people added since its snapshot. Polling skips it.
  const directory = c.req.query("directory") === "1";
  const access = await authorize(c, directory);
  const after = c.req.query("after") ?? "0";
  const limit = c.req.query("limit") ?? "200";
  if (!/^\d+$/.test(after) || !/^\d+$/.test(limit))
    throw new TrackerError(400, "invalid_input", "after and limit must be integers.");
  // Timeline records and events only for replicas that know them (timelines=1).
  const changes = await trackerObject(c.env, access.owner.id).changes(
    Number(after),
    Number(limit),
    c.req.query("timelines") === "1",
  );
  return response(
    c,
    directory && changes.ok
      ? {
          ...changes,
          value: {
            ...changes.value,
            members: access.members,
            agents: access.agents,
            canAdmin: access.canAdmin,
          },
        }
      : changes,
  );
});
tracker.get("/tracker/:owner/issues/:issue/history", async (c) => {
  const access = await authorize(c);
  const before = c.req.query("before");
  const limit = c.req.query("limit") ?? "50";
  if ((before !== undefined && !/^\d+$/.test(before)) || !/^\d+$/.test(limit))
    throw new TrackerError(400, "invalid_input", "before and limit must be integers.");
  return response(
    c,
    await trackerObject(c.env, access.owner.id).history(
      access,
      c.req.param("issue"),
      before === undefined ? null : Number(before),
      Number(limit),
    ),
  );
});
/**
 * The Chronicle (CORE-250): issues matching `q` as of `from`, with what
 * changed, who worked them and what happened until `to`. Paged by `cursor`.
 */
tracker.get("/tracker/:owner/chronicle", async (c) => {
  const access = await authorize(c);
  const limit = c.req.query("limit") ?? String(CHRONICLE_PAGE);
  if (!/^\d+$/.test(limit))
    throw new TrackerError(400, "invalid_input", "limit must be an integer.");
  return response(
    c,
    await trackerObject(c.env, access.owner.id).chronicle(access, {
      from: c.req.query("from") ?? "",
      to: c.req.query("to") ?? new Date().toISOString(),
      query: c.req.query("q") ?? "",
      cursor: c.req.query("cursor") || null,
      limit: Number(limit),
      quiet: c.req.query("quiet") === "1",
    }),
  );
});
/** What an issue's work produced (CORE-250): commits, work contexts, runs, previews, packages, timelines, release notes. */
tracker.get("/tracker/:owner/issues/:issue/work", async (c) => {
  const access = await authorize(c, false);
  const work = await trackerObject(c.env, access.owner.id).issueWork(c.req.param("issue"));
  if (!work.ok) return response(c, work);
  return c.json<LinkedWork>(await linkedWork(c.env, c.get("actor")!, access.owner, work.value));
});
tracker.post("/tracker/:owner/mutate", async (c) => {
  const access = await authorize(c);
  const source = c.req.header("X-Gitmatrix-Source");
  access.source = source === "web" || source === "cli" || source === "assistant" ? source : "api";
  const request = validateRequest(await body(c));
  let removedRepoIds: string[] = [];
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
      removedRepoIds = lookup.value;
      if (lookup.value.length) {
        const existing = await gitmatrixDb(c.env.DB)
          .selectFrom("repos")
          .select("id")
          .where("id", "in", lookup.value)
          .execute();
        const ids = new Set(existing.map((repo) => repo.id));
        access.deletedRepoIds = lookup.value.filter((repoId) => !ids.has(repoId));
      }
    }
  }
  // Approving a checkpoint needs write access to its repositories, which D1 knows.
  if (request.mutations.some((mutation) => mutation.kind === "request.answer"))
    access.writableRepoIds = await writableRepoIds(c.env.DB, c.get("actor")!, access.owner.id);
  const result = await trackerObject(c.env, access.owner.id).mutate(access, request);
  if (result.ok) {
    c.executionCtx.waitUntil(
      refreshAfterTrackerMutation(c.env, access.owner.id, result.value, removedRepoIds),
    );
    // A person approved a checkpoint: an approval timeline lands it (CORE-77).
    const approved = new Set(
      request.mutations
        .filter((m) => m.kind === "request.answer" && m.data.approved === true)
        .map((m) => m.id),
    );
    const slugs = new Set(
      result.value.events.flatMap((event) => {
        const entity = event.entity as HumanRequest | null;
        return event.entityType === "request" && approved.has(event.entityId) && entity?.checkpoint
          ? [entity.checkpoint.timeline]
          : [];
      }),
    );
    // Loaded only then: the queue reaches CI, git and knowledge.
    if (slugs.size)
      c.executionCtx.waitUntil(
        import("../timelines/landing.ts").then(async ({ maybeLand, settled }) => {
          for (const slug of slugs)
            await settled(c.env, (deps) =>
              maybeLand(c.env, deps, access.owner.id, slug, "approval", {
                principalId: access.principalId,
                agentId: null,
              }),
            );
        }),
      );
  }
  return response(c, result);
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
