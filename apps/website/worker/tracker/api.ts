import { Hono, type Context } from "hono";
import { requestTiming, type AppEnv } from "../auth.ts";
import { findRepo, roleFor, savedDefault, visibleRepos, type Actor } from "../db.ts";
import { findSpaceBySlug, listSpaceAccess } from "../spaces/access.ts";
import {
  CONTENT_CONTRACT_HEADER,
  CONTENT_CONTRACT_VERSION,
  preferredSpace,
  type SpaceAccess,
} from "../../shared/spaces.ts";
import { db as gitmatrixDb } from "../schema.ts";
import type {
  ApprovalAutomation,
  CompletedWorkList,
  HumanRequest,
  OpenRequest,
  OpenRequests,
  RequestHistory,
  RequestSummary,
  TrackerList,
  TrackerView,
  TrackerSpace,
} from "../../shared/tracker.ts";
import {
  TrackerError,
  validateRequest,
  type Access,
  type OpenRequestItem,
  closedKey,
} from "./store.ts";
import { accessFor, accessFromGrant, agentsAmong } from "./access.ts";
import { requestAdmission } from "../api/content-contract.ts";
import type { TrackerReply } from "./object.ts";
import { trackerObject } from "./stub.ts";
import { CHRONICLE_PAGE, type LinkedWork } from "../../shared/chronicle.ts";
import { agentWork, parseWhen, type AgentEligibility } from "../../shared/tracker-query.ts";
import { autoApprovable } from "../../shared/tracker.ts";
import { linkedWork } from "./work.ts";
import {
  clearPreferences,
  defaultSpace,
  parsePreferences,
  preferencesFor,
  savePreferences,
} from "./preferences.ts";
import { refreshAfterTrackerMutation } from "../release-notes/queue.ts";
import { view as checkpointView, writableRepoIds } from "../timelines/checkpoints.ts";
import { currentRepositoryNames } from "../timelines/names.ts";
import type { AutoApproveScope } from "../timelines/auto-approve.ts";
import type { RepoIssueSummary } from "../../shared/api.ts";
import { captureWorkAuthority } from "../ci/admission.ts";
import { timedCall, timedEnv, type Timing } from "../timing.ts";

export const tracker = new Hono<AppEnv>();

/** Explicit current Space grants only; Instance and Organization roles grant no Tracker access. */
export async function accessible(db: D1Database, actor: Actor): Promise<TrackerSpace[]> {
  return (await accessibleGrants(db, actor)).map((access) => ({
    ...access.space,
    canAdmin: access.grant.role === "admin",
  }));
}
/**
 * The grants behind `accessible`, in one query: exactly the Spaces
 * resolveSpaceAccess admits, by Space handle. Handles are lowercase ASCII, so
 * comparing code units keeps SQLite's NOCASE order.
 */
async function accessibleGrants(db: D1Database, actor: Actor): Promise<SpaceAccess[]> {
  return (await listSpaceAccess(db, actor)).sort((a, b) =>
    a.space.slug < b.space.slug ? -1 : a.space.slug > b.space.slug ? 1 : 0,
  );
}
/** `env` may be this request's timed view of the bindings (timing.ts timedEnv). */
export async function authorize(
  c: Context<AppEnv>,
  includeMembers = true,
  env: Env = c.env,
  timing?: Timing,
): Promise<Access> {
  if (c.req.header(CONTENT_CONTRACT_HEADER) !== String(CONTENT_CONTRACT_VERSION))
    throw new TrackerError(
      409,
      "client_upgrade_required",
      "Upgrade your client and send X-Gitmatrix-Content-Version: 4.",
    );
  const actor = c.get("actor");
  if (!actor) throw new TrackerError(401, "unauthenticated", "Sign in to access trackers.");
  const space = await findSpaceBySlug(env.DB, c.req.param("space")!);
  if (!space) throw new TrackerError(404, "not_found", "Tracker Space not found.");
  return accessFor(
    env,
    space,
    actor.id,
    actor.agent?.id ?? null,
    includeMembers,
    actor.credential,
    timing,
  );
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
  const [trackers, saved, lastSaved] = await Promise.all([
    accessible(c.env.DB, actor),
    savedDefault(c.env.DB, actor.id),
    defaultSpace(c.env.DB, actor.id),
  ]);
  // The person's own default (CORE-413) outranks the tracker they last tuned.
  const defaultSpaceId = preferredSpace(saved, trackers)?.id ?? lastSaved;
  return c.json<TrackerList>({ viewerId: actor.id, trackers, defaultSpaceId });
});
/**
 * How many open requests wait on you, and on anyone, across every tracker you're
 * in (CORE-301): the rail's Needs you badge, without the requests themselves.
 */
tracker.get("/requests/summary", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "Sign in to see what needs you." }, 401);
  const timing = requestTiming(c);
  const env = timedEnv(c.env, timing);
  const summary: RequestSummary = { forYou: 0, open: 0 };
  const grants = await accessibleGrants(env.DB, actor);
  if (!grants.length) return c.json(summary);
  // One admission read for every Space; each Tracker still re-resolves its grant.
  const admission = await requestAdmission(c);
  const accesses = grants.map((grant) => accessFromGrant(grant, admission, actor.credential));
  const results = await Promise.allSettled(
    accesses.map((access) =>
      timedCall(timing, trackerObject(env, access.spaceId).openRequests(access)),
    ),
  );
  // The first Space's failure wins, as when they were asked one at a time.
  for (const settled of results) {
    if (settled.status === "rejected") throw settled.reason;
    const result = settled.value;
    if (!result.ok) return response(c, result);
    for (const { request } of result.value) {
      summary.open++;
      if (request.routeTo === actor.id) summary.forYou++;
    }
  }
  return c.json(summary);
});
/**
 * Requests on Needs you from one tracker, as the page shows them: an
 * approval of a timeline checkpoint with its commits, CI runs, previews and
 * summary, and whether approve-when-green will answer it (CORE-378).
 */
async function needsYouItems(
  c: Context<AppEnv>,
  space: TrackerSpace,
  access: Access,
  items: OpenRequestItem[],
): Promise<OpenRequest[] | Response> {
  const stub = trackerObject(c.env, space.id);
  // History shows a closed approval's answer, not its checkpoint.
  const pinned = items.flatMap(({ request }) =>
    request.checkpoint && request.status === "open" ? [request.checkpoint.id] : [],
  );
  const checkpoints = new Map<string, OpenRequest["checkpoint"]>();
  if (pinned.length) {
    const states = await stub.checkpointStates(access, pinned);
    if (!states.ok) return response(c, states);
    const current = await currentRepositoryNames(
      c.env.DB,
      space.id,
      states.value.map(({ state }) => state.checkpoint),
    );
    for (const [index, { state, timeline }] of states.value.entries())
      checkpoints.set(
        state.checkpoint.id,
        await checkpointView(c.env, { ...state, checkpoint: current[index]! }, timeline),
      );
  }
  // Approve when green (CORE-378): whose pending checkpoint approvals answer
  // themselves. Only those asked by their person or one of that person's own
  // agents; revoked agents count as nobody's, so their requests stay manual.
  const automatic = new Set<string>();
  let askers: Awaited<ReturnType<typeof agentsAmong>> = [];
  if (pinned.length) {
    const on = await stub.approvingWhenGreen();
    if (!on.ok) return response(c, on);
    for (const id of on.value) automatic.add(id);
    if (automatic.size)
      askers = await agentsAmong(
        c.env.DB,
        items.map(({ request }) => request.askedBy),
      );
  }
  return items.map((item) => {
    const checkpoint = item.request.checkpoint && checkpoints.get(item.request.checkpoint.id);
    return {
      tracker: { slug: space.slug, displayName: space.displayName },
      ...item,
      ...(checkpoint ? { checkpoint } : {}),
      ...(checkpoint &&
      item.request.status === "open" &&
      automatic.has(item.request.routeTo) &&
      autoApprovable(item.request, askers)
        ? { approvesWhenGreen: true }
        : {}),
    };
  });
}

/** Read access to one Space's tracker for a Needs you or agent-work listing. */
function listingAccess(c: Context<AppEnv>, actor: Actor, space: TrackerSpace) {
  return accessFor(c.env, space, actor.id, actor.agent?.id ?? null, false, actor.credential);
}

/** Names for the people and agents requests mention: "builder for Ann Lee" for an agent. */
async function requestNames(
  db: D1Database,
  requests: OpenRequest[],
): Promise<Record<string, string>> {
  const ids = [
    ...new Set(
      requests.flatMap(({ request, work }) => [
        request.askedBy,
        request.routeTo,
        ...(request.answeredBy ? [request.answeredBy] : []),
        ...(work?.holder ? [work.holder.actorId] : []),
        ...(work?.latest ? [work.latest.actorId] : []),
        ...(work?.next ? [work.next.actorId] : []),
      ]),
    ),
  ];
  const names: Record<string, string> = {};
  if (!ids.length) return names;
  const k = gitmatrixDb(db);
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
  return names;
}

/**
 * Open requests to people across every tracker you're in: yours first, then
 * the rest, each with what its work is doing (CORE-386).
 */
tracker.get("/requests", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "Sign in to see what needs you." }, 401);
  const requests: OpenRequest[] = [];
  for (const space of await accessible(c.env.DB, actor)) {
    const access = await listingAccess(c, actor, space);
    const result = await trackerObject(c.env, space.id).neededRequests(access, { open: true });
    if (!result.ok) return response(c, result);
    const items = await needsYouItems(c, space, access, result.value);
    if (items instanceof Response) return items;
    requests.push(...items);
  }
  requests.sort(
    (a, b) =>
      Number(b.request.routeTo === actor.id) - Number(a.request.routeTo === actor.id) ||
      a.request.createdAt.localeCompare(b.request.createdAt),
  );
  return c.json<OpenRequests>({ requests, names: await requestNames(c.env.DB, requests) });
});

/** How many closed requests a history page shows. */
const HISTORY_PAGE = 25;

/**
 * Answered and withdrawn requests across every tracker you're in (CORE-387),
 * newest first, a page at a time: `before` is the last page's `next`.
 */
tracker.get("/requests/history", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "Sign in to see what needed you." }, 401);
  const before = c.req.query("before") ?? null;
  if (before !== null && (before.length > 200 || !before.includes("|")))
    throw new TrackerError(400, "invalid_input", "before is the last page's next.");
  const closed: OpenRequest[] = [];
  for (const space of await accessible(c.env.DB, actor)) {
    const access = await listingAccess(c, actor, space);
    const result = await trackerObject(c.env, space.id).neededRequests(access, {
      open: false,
      before,
      limit: HISTORY_PAGE + 1,
    });
    if (!result.ok) return response(c, result);
    const items = await needsYouItems(c, space, access, result.value);
    if (items instanceof Response) return items;
    closed.push(...items);
  }
  closed.sort((a, b) => closedKey(b.request).localeCompare(closedKey(a.request)));
  const requests = closed.slice(0, HISTORY_PAGE);
  const next = closed.length > HISTORY_PAGE ? closedKey(requests.at(-1)!.request) : null;
  return c.json<RequestHistory>({
    requests,
    names: await requestNames(c.env.DB, requests),
    next,
  });
});
/**
 * Which open issues each of your agents can take (CORE-32), in every tracker
 * you're in: requirements it meets, and a few it doesn't with why. An agent
 * signed in sees only itself.
 */
tracker.get("/agent-eligibility", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "Sign in to see your agents' work." }, 401);
  const out: AgentEligibility = { trackers: [] };
  for (const space of await accessible(c.env.DB, actor)) {
    const access = await accessFor(
      c.env,
      space,
      actor.id,
      actor.agent?.id ?? null,
      true,
      actor.credential,
    );
    const result = await trackerObject(c.env, space.id).snapshot(access);
    if (!result.ok) return response(c, result);
    const agents = result.value.agents.filter(
      (agent) =>
        agent.accountable.id === actor.id &&
        agent.revokedAt === null &&
        (!actor.agent || agent.id === actor.agent.id),
    );
    out.trackers.push({
      tracker: { slug: space.slug, displayName: space.displayName },
      agents: agents.map((agent) => agentWork(result.value, agent.id)),
      tags: result.value.labels,
    });
  }
  return c.json(out);
});
/**
 * What your agents finished lately (CORE-220), in every tracker you're in:
 * `?since=14d` (a duration or date), `?agent=<id or name>` for one of them,
 * `?tracker=<slug>` for one tracker. An agent signed in sees only its own.
 */
tracker.get("/agent-work", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "Sign in to see your agents' work." }, 401);
  const range = (c.req.query("since") || "14d").toLowerCase();
  const start = parseWhen(range, Date.now());
  if (start === null)
    throw new TrackerError(400, "invalid_input", "since must be a duration like 14d, or a date.");
  const since = new Date(start).toISOString();
  const rows = await gitmatrixDb(c.env.DB)
    .selectFrom("agents")
    .select(["id", "name", "revoked_at"])
    .where("accountable_id", "=", actor.id)
    .orderBy("name")
    .execute();
  let agents = rows
    .filter((agent) => !actor.agent || agent.id === actor.agent.id)
    .map((agent) => ({ id: agent.id, name: agent.name, revoked: agent.revoked_at !== null }));
  const wanted = c.req.query("agent");
  if (wanted) {
    agents = agents.filter((agent) => agent.id === wanted || agent.name === wanted);
    if (!agents.length) throw new TrackerError(404, "not_found", `You have no agent ${wanted}.`);
  }
  const only = c.req.query("tracker");
  const trackers = (await accessible(c.env.DB, actor)).filter(
    (space) => !only || space.slug === only,
  );
  if (only && !trackers.length)
    throw new TrackerError(404, "not_found", `You aren't in a tracker ${only}.`);
  const filter = {
    since,
    accountableId: actor.id,
    actorIds: actor.agent || wanted ? agents.map((agent) => agent.id) : null,
  };
  const results = await Promise.all(
    trackers.map(async (space) =>
      trackerObject(c.env, space.id).completedWork(await listingAccess(c, actor, space), filter),
    ),
  );
  const out: CompletedWorkList = {
    since,
    agents,
    trackers: trackers.map(({ slug, displayName }) => ({ slug, displayName })),
    items: [],
    truncated: false,
  };
  for (const [index, result] of results.entries()) {
    if (!result.ok) return response(c, result);
    const space = trackers[index]!;
    const where = { slug: space.slug, displayName: space.displayName };
    out.items.push(...result.value.items.map((item) => ({ tracker: where, ...item })));
    out.truncated ||= result.value.truncated;
  }
  out.items.sort((a, b) => b.completion.at.localeCompare(a.completion.at));
  return c.json(out);
});
// A single authenticated browser request, without the repository list or a session preflight.
tracker.get("/tracker/:space/view", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "Sign in to access trackers." }, 401);
  const timing = requestTiming(c);
  const env = timedEnv(c.env, timing);
  const [view, trackers] = await Promise.all([
    authorize(c, true, env, timing).then(async (access) => {
      const [result, preferences] = await Promise.all([
        timedCall(timing, trackerObject(env, access.space.id).snapshot(access, timelineParam(c))),
        // An agent sees its person's defaults: they're whose work it does.
        preferencesFor(env.DB, actor.id, access.space.id),
      ]);
      return { result, preferences };
    }),
    accessible(env.DB, actor),
  ]);
  if (!view.result.ok) return response(c, view.result);
  return c.json<TrackerView>({
    snapshot: view.result.value,
    trackers,
    preferences: view.preferences,
  });
});
/** Your defaults for this tracker (CORE-119); an agent reads its person's. */
tracker.get("/tracker/:space/preferences", async (c) => {
  const access = await authorize(c, false);
  return c.json({
    preferences: await preferencesFor(c.env.DB, c.get("actor")!.id, access.space.id),
  });
});
tracker.put("/tracker/:space/preferences", async (c) => {
  const access = await authorize(c, false);
  const actor = c.get("actor")!;
  if (actor.agent)
    throw new TrackerError(
      403,
      "forbidden",
      "Defaults are your person's to set; agents follow them.",
    );
  const parsed = parsePreferences(await body(c));
  if (typeof parsed === "string")
    throw new TrackerError(
      parsed.startsWith("client_upgrade_required:") ? 409 : 400,
      parsed.startsWith("client_upgrade_required:") ? "client_upgrade_required" : "invalid_input",
      parsed,
    );
  if (parsed.teamId !== null) {
    const teams = await trackerObject(c.env, access.spaceId).teamDirectory(access);
    if (!teams.ok) return response(c, teams);
    if (!teams.value.some((team) => team.id === parsed.teamId))
      throw new TrackerError(
        400,
        "invalid_input",
        "Default Team must be active and belong to this Space.",
      );
  }
  return c.json({
    preferences: await savePreferences(c.env.DB, actor.id, access.space.id, parsed),
  });
});
tracker.delete("/tracker/:space/preferences", async (c) => {
  const access = await authorize(c, false);
  const actor = c.get("actor")!;
  if (actor.agent)
    throw new TrackerError(
      403,
      "forbidden",
      "Defaults are your person's to set; agents follow them.",
    );
  await clearPreferences(c.env.DB, actor.id, access.space.id);
  return c.body(null, 204);
});
tracker.get("/tracker/:space/snapshot", async (c) => {
  const access = await authorize(c);
  return response(
    c,
    await trackerObject(c.env, access.space.id).snapshot(
      access,
      timelineParam(c),
      c.req.query("timelines") === "1",
    ),
  );
});
tracker.get("/tracker/:space/authorization", async (c) => {
  const access = await authorize(c, false);
  return c.json({
    contractVersion: 4,
    spaceId: access.spaceId,
    migrationEpoch: access.migrationEpoch,
  });
});
/**
 * The tracker's tag catalog (CORE-271), with how many issues carry each tag:
 * what issue tags, agent tags and requirement `tag:` values are chosen from.
 */
tracker.get("/tracker/:space/tags", async (c) => {
  const access = await authorize(c);
  const catalog = await trackerObject(c.env, access.space.id).tagCatalog(access);
  return response(c, catalog.ok ? { ...catalog, value: { tags: catalog.value } } : catalog);
});
tracker.get("/tracker/:space/teams", async (c) => {
  const access = await authorize(c, false);
  const result = await trackerObject(c.env, access.spaceId).teamDirectory(access);
  return response(c, result.ok ? { ...result, value: { teams: result.value } } : result);
});
tracker.post("/tracker/:space/recover", async (c) => {
  const access = await authorize(c, false);
  const input = await body(c);
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TrackerError(400, "invalid_input", "A legacy recovery request is required.");
  const record = input as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !["sourceContractVersion", "sourceSpaceId", "actorId", "operations"].includes(key),
    ) ||
    record.sourceContractVersion !== 3 ||
    record.sourceSpaceId !== access.spaceId ||
    record.actorId !== access.actorId ||
    !Array.isArray(record.operations) ||
    record.operations.length > 100
  )
    throw new TrackerError(
      409,
      "export_required",
      "Recovery must match the original person or agent, immutable Space and contract version 3; preserve and export unresolved intent.",
    );
  return response(
    c,
    await trackerObject(c.env, access.spaceId).recoverOperations(access, record.operations),
  );
});
tracker.get("/tracker/:space/changes", async (c) => {
  // Members and agents aren't events: a replica asks for them (directory=1) to
  // learn of agents created and people added since its snapshot. Polling skips it.
  const directory = c.req.query("directory") === "1";
  const access = await authorize(c, directory);
  if (
    c.req.query("spaceId") !== access.spaceId ||
    c.req.query("migrationEpoch") !== String(access.migrationEpoch)
  )
    throw new TrackerError(
      409,
      "migration_epoch_mismatch",
      "Changes require the immutable spaceId and migrationEpoch from your current snapshot.",
    );
  const after = c.req.query("after") ?? "0";
  const limit = c.req.query("limit") ?? "200";
  if (!/^\d+$/.test(after) || !/^\d+$/.test(limit))
    throw new TrackerError(400, "invalid_input", "after and limit must be integers.");
  // Timeline records and events only for replicas that know them (timelines=1).
  const changes = await trackerObject(c.env, access.space.id).changes(
    access,
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
tracker.get("/tracker/:space/issues/:issue/history", async (c) => {
  const access = await authorize(c);
  const before = c.req.query("before");
  const limit = c.req.query("limit") ?? "50";
  if ((before !== undefined && !/^\d+$/.test(before)) || !/^\d+$/.test(limit))
    throw new TrackerError(400, "invalid_input", "before and limit must be integers.");
  return response(
    c,
    await trackerObject(c.env, access.space.id).history(
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
tracker.get("/tracker/:space/chronicle", async (c) => {
  const access = await authorize(c);
  const limit = c.req.query("limit") ?? String(CHRONICLE_PAGE);
  if (!/^\d+$/.test(limit))
    throw new TrackerError(400, "invalid_input", "limit must be an integer.");
  return response(
    c,
    await trackerObject(c.env, access.space.id).chronicle(access, {
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
tracker.get("/tracker/:space/issues/:issue/work", async (c) => {
  const access = await authorize(c, false);
  const work = await trackerObject(c.env, access.space.id).issueWork(access, c.req.param("issue"));
  if (!work.ok) return response(c, work);
  return c.json<LinkedWork>(await linkedWork(c.env, c.get("actor")!, access.space, work.value));
});
tracker.post("/tracker/:space/mutate", async (c) => {
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
        "Tracker administration requires an explicit Space admin grant.",
      );
    access.repos = (await visibleRepos(c.env.DB, c.get("actor"), access.spaceId))
      .filter((repo) => repo.viewerRole === "admin")
      .map((repo) => ({
        id: repo.id,
        spaceId: repo.space.id,
        space: repo.space.slug,
        name: repo.name,
      }));
    const removals = request.mutations
      .filter((mutation) => mutation.kind === "subscription.remove")
      .map((mutation) => mutation.id);
    if (removals.length) {
      const lookup = await trackerObject(c.env, access.space.id).subscriptionRepoIds(
        access,
        removals,
      );
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
    access.writableRepoIds = await writableRepoIds(c.env.DB, c.get("actor")!, access.space.id);
  const result = await trackerObject(c.env, access.space.id).mutate(access, request);
  if (result.ok) {
    c.executionCtx.waitUntil(
      refreshAfterTrackerMutation(
        c.env,
        access.space.id,
        result.value,
        removedRepoIds,
        c.get("actor")!,
      ),
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
    // Approve when green (CORE-378): an approval just asked of someone with the
    // setting on, or the setting just turned on, may already be green.
    const scopes = result.value.events.flatMap((event): AutoApproveScope[] => {
      if (event.entityType === "request" && event.kind === "request.open") {
        const asked = event.entity as HumanRequest | null;
        return asked?.kind === "approval" && asked.checkpoint ? [{ requestId: asked.id }] : [];
      }
      if (event.entityType === "automation") {
        const now = event.entity as ApprovalAutomation | null;
        const was = event.before as ApprovalAutomation | null | undefined;
        return now?.approveWhenGreen && !was?.approveWhenGreen ? [{ personId: now.id }] : [];
      }
      return [];
    });
    if (scopes.length)
      c.executionCtx.waitUntil(
        Promise.all([import("../timelines/auto-approve.ts"), import("../timelines/landing.ts")])
          .then(async ([{ maybeAutoApprove }, { settled }]) => {
            for (const scope of scopes)
              await settled(c.env, (deps) => maybeAutoApprove(c.env, deps, access.space.id, scope));
          })
          .catch((error) => console.error("Auto-approve: after a mutation", error)),
      );
    // Loaded only then: the queue reaches CI, git and knowledge.
    if (slugs.size)
      c.executionCtx.waitUntil(
        import("../timelines/landing.ts").then(async ({ maybeLand, settled }) => {
          for (const slug of slugs) {
            const timeline = await trackerObject(c.env, access.spaceId).timeline(
              access,
              slug,
              0,
              1,
            );
            if (!timeline.ok) throw new Error(timeline.error);
            const repo = timeline.value.timeline.repos[0];
            if (!repo) throw new Error("Approval timeline has no repository authority.");
            const authority = await captureWorkAuthority(c.env, repo.id, c.get("actor")!);
            await settled(c.env, (deps) =>
              maybeLand(c.env, deps, access.space.id, slug, "approval", authority),
            );
          }
        }),
      );
  }
  return response(c, result);
});
tracker.get("/repos/:space/:name/tracker", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "Sign in to access trackers." }, 401);
  const repo = await findRepo(c.env.DB, actor, c.req.param("space"), c.req.param("name"));
  if (!repo || roleFor(repo, actor) === "none")
    return c.json({ error: "Repository not found." }, 404);
  const projects: { trackerSpace: string; projectId: string; slug: string; name: string }[] = [];
  const spaces = await accessible(c.env.DB, actor);
  for (const space of spaces) {
    if (space.id !== repo.space_id) continue;
    const access = await accessFor(
      c.env,
      space,
      actor.id,
      actor.agent?.id ?? null,
      false,
      actor.credential,
    );
    const result = await trackerObject(c.env, space.id).subscribedProjects(access, repo.id);
    if (!result.ok) return response(c, result);
    for (const project of result.value) projects.push({ trackerSpace: space.slug, ...project });
  }
  return c.json({
    projects,
    canManage:
      roleFor(repo, actor) === "admin" &&
      spaces.some((space) => space.slug === repo.space_slug && space.canAdmin),
  });
});

tracker.get("/repos/:space/:name/tracker/summary", async (c) => {
  const actor = c.get("actor");
  const repo = await findRepo(c.env.DB, actor, c.req.param("space"), c.req.param("name"));
  if (!repo || roleFor(repo, actor) === "none")
    return c.json({ error: "Repository not found." }, 404);
  const summary: RepoIssueSummary = { ready: null, projects: 0 };
  if (!actor) return c.json(summary);
  const timeline = timelineParam(c);
  for (const space of await accessible(c.env.DB, actor)) {
    if (space.id !== repo.space_id) continue;
    const access = await accessFor(
      c.env,
      space,
      actor.id,
      actor.agent?.id ?? null,
      false,
      actor.credential,
    );
    const result = await trackerObject(c.env, space.id).repoReadySummary(access, repo.id, timeline);
    if (!result.ok) return response(c, result);
    if (!result.value.projects) continue;
    summary.projects += result.value.projects;
    summary.ready = (summary.ready ?? 0) + result.value.ready;
  }
  return c.json(summary);
});
