import type { Context } from "hono";
import type { AppEnv } from "../auth.ts";
import type {
  LegacyCheckpoint as Checkpoint,
  LegacyLanding as Landing,
  LegacyTimeline as Timeline,
} from "../tracker/legacy-source-fixture.ts";
import { selectRepos } from "../db.ts";
import { lsRefs } from "../artifacts.ts";
import { trackerObject } from "../tracker/stub.ts";
import { fail, readJson } from "./http.ts";
import { writeRefs } from "../timelines/bookmarks.ts";
import { findSpaceBySlug } from "../spaces/access.ts";
import { fixtureAccess } from "./dev-fixture-access.ts";

interface LegacySeed {
  slug: string;
  parent?: string;
  status?: "active" | "landed" | "abandoned";
  experimental?: boolean;
  policy?: "auto" | "approval";
  operation?: "partial" | "inflight";
  repos: { name: string; base: string; head: string; merge?: string }[];
}

/** Pre-cutover records only. Mounted behind the named-development secret gate. */
export async function sourceFixtures(c: Context<AppEnv>) {
  const agentId = Reflect.get(c.env, "AGENT_ID");
  if (Reflect.get(c.env, "DEV_MODE") !== "true" || typeof agentId !== "string" || !agentId.trim())
    return fail(c, 404, "Not found.");
  const input = await readJson<LegacySeed>(c);
  if (
    typeof input.slug !== "string" ||
    !/^source-migration-[a-z0-9-]{1,80}$/.test(input.slug) ||
    !Array.isArray(input.repos) ||
    input.repos.length < 1 ||
    input.repos.length > 2 ||
    new Set(input.repos.map((repo) => repo.name)).size !== input.repos.length ||
    (input.status !== undefined && !["active", "landed", "abandoned"].includes(input.status)) ||
    (input.policy !== undefined && !["auto", "approval"].includes(input.policy)) ||
    (input.operation !== undefined && !["partial", "inflight"].includes(input.operation)) ||
    (input.parent !== undefined && !/^source-migration-[a-z0-9-]{1,80}$/.test(input.parent))
  )
    return fail(c, 400, "Invalid bounded legacy fixture.");
  const tracker = trackerObject(c.env, "acc_orbit");
  const space = await findSpaceBySlug(c.env.DB, "orbit");
  if (!space) return fail(c, 404, "Fixture Space missing.");
  const access = await fixtureAccess(c.env, space, "acc_marco");
  const parent = input.parent ? await tracker.timeline(access, input.parent, 0, 1) : null;
  if (parent && !parent.ok) return fail(c, 400, "Legacy parent does not exist.");
  const entries = [];
  for (const entry of input.repos) {
    if (
      !/^queue-[a-f0-9]{8}$/.test(entry.name) ||
      ![entry.base, entry.head, ...(entry.merge ? [entry.merge] : [])].every((oid) =>
        /^[a-f0-9]{40}$/.test(oid),
      )
    )
      return fail(c, 400, "Only disposable native Git fixture repositories are allowed.");
    const repo = await selectRepos(c.env.DB, "acc_marco")
      .where("r.space_id", "=", "acc_orbit")
      .where("r.name", "=", entry.name)
      .executeTakeFirst();
    if (!repo) return fail(c, 404, "Fixture repository is missing or deleted.");
    const refs = await lsRefs(c.env, repo.artifacts_name, repo.artifacts_remote);
    if (
      !refs.some(
        (ref) => ref.name === `refs/heads/gitmatrix/queue/${entry.head}` && ref.oid === entry.head,
      )
    )
      return fail(c, 409, "Stage the exact native legacy head before its durable record.");
    const provider = await c.env.ARTIFACTS.get(repo.artifacts_name);
    try {
      for (const oid of [entry.base, entry.head, ...(entry.merge ? [entry.merge] : [])])
        if (!(await provider.readCommit(oid)))
          return fail(c, 400, "Fixture commit is unavailable.");
    } finally {
      provider[Symbol.dispose]();
    }
    const written = await writeRefs(c.env, repo, [
      { ref: `refs/heads/timeline/${input.slug}`, old: null, new: entry.head },
      { ref: `refs/heads/gitmatrix/queue/${entry.head}`, old: entry.head, new: null },
    ]);
    if (written.some((result) => !result.ok))
      return fail(c, 409, "Could not provision the exact legacy fixture bookmark.");
    entries.push({ ...entry, id: repo.id });
  }
  if (input.operation === "partial" && (entries.length !== 2 || !entries[0]!.merge))
    return fail(c, 400, "Partial fixture needs two repositories and one real successful merge.");
  const now = new Date().toISOString();
  const checkpointId = `${input.slug}-checkpoint`;
  const timeline: Timeline = {
    id: input.slug,
    slug: input.slug,
    name: input.slug,
    policy: input.policy ?? "auto",
    experimental: input.experimental ?? false,
    parentId: parent?.ok ? parent.value.timeline.id : null,
    forkPoint: {
      commits: Object.fromEntries(entries.map((entry) => [entry.id, entry.base])),
      trackerCursor: 0,
    },
    repos: entries.map((entry) => ({
      id: entry.id,
      owner: "orbit",
      name: entry.name,
      bookmark: `timeline/${input.slug}`,
    })),
    status:
      input.operation === "partial"
        ? "partly_landed"
        : input.operation === "inflight"
          ? "landing"
          : (input.status ?? "active"),
    accountableId: "acc_marco",
    startedBy: "acc_marco",
    agentIds: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
    pushedAt: now,
    ...(input.status === "landed" || input.status === "abandoned" ? { endedAt: now } : {}),
  };
  const checkpoint: Checkpoint = {
    id: checkpointId,
    timelineId: timeline.id,
    number: 1,
    repos: entries.map((entry) => ({
      id: entry.id,
      owner: "orbit",
      name: entry.name,
      commit: entry.head,
      base: entry.base,
      changes: [],
    })),
    summary: "Pre-cutover approved checkpoint",
    actorId: "acc_marco",
    accountableId: "acc_marco",
    createdAt: now,
  };
  const landing: Landing | null = input.operation
    ? {
        id: `${input.slug}-landing`,
        timelineId: timeline.id,
        slug: timeline.slug,
        checkpointId,
        checkpointNumber: 1,
        state: input.operation === "partial" ? "failed" : "merging",
        repos: entries.map((entry, index) => ({
          id: entry.id,
          owner: "orbit",
          name: entry.name,
          commit: entry.head,
          base: entry.base,
          merge: entry.merge ?? null,
          attempt: 1,
          state: input.operation === "inflight" ? "merging" : index === 0 ? "advanced" : "failed",
          mergeRun: null,
          gateRun: null,
          reason: null,
        })),
        reason: "Pre-cutover operation",
        trigger: "request",
        requestedBy: { actorId: "acc_marco", accountableId: "acc_marco" },
        version: 1,
        createdAt: now,
        updatedAt: now,
      }
    : null;
  const result = await tracker.seedLegacySourceFixture(
    agentId,
    {
      timeline,
      checkpoint,
      landing,
      approved: true,
    },
    access,
  );
  if (!result.ok) return c.json({ error: result.error, code: result.code }, result.status);
  return c.json({ timeline: result.value, checkpoint, landing }, 201);
}
