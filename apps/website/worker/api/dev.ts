import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { AppEnv } from "../auth.ts";
import type { TokenScope } from "../../shared/api.ts";
import { newArtifactsName } from "../artifacts.ts";
import {
  endAtlasFixtureOverlay,
  expireAtlasPriors,
  landAtlasFixtureBuild,
  publishAtlasFixture,
  queueAtlasFixtureBuild,
  registerFixturePackage,
  writeAtlasFixtureGraph,
  writeAtlasFixtureOverlay,
} from "../atlas/fixture.ts";
import { decide, type ClefQuestion } from "../knowledge/models.ts";
import { findAccountBySlug } from "../db.ts";
import { probeDurableObjects } from "../durable/probe.ts";
import { collectUsage } from "../usage/collect.ts";
import { advanceRun, createRun, getRun } from "../retention/runs.ts";
import { SYSTEM_ACTOR } from "../../registry/core/auth/system.ts";
import { Services } from "../../registry/core/context.ts";
import { collectGarbage } from "../../registry/jobs/gc.ts";
import type { RetentionTarget } from "../retention/policies.ts";
import { deletionStatus, resumeDeletions } from "../retention/repo-deletion.ts";
import { repoInventory } from "../retention/repo-inventory.ts";
import { plantOrphans, resetOrphanSweep, sweepRepoOrphans } from "../retention/repo-orphans.ts";
import type { DurableClass } from "../durable/classes.ts";
import { batch, db } from "../schema.ts";
import { fail, readJson } from "./http.ts";
import { issueToken } from "./tokens.ts";

// DEVELOPMENT ONLY: empty, named repositories exercising the persona permissions.
// The harness populates their bounded, pinned contents through the real CLI.
interface Sample {
  owner: string;
  name: string;
  visibility: "public" | "private";
  description: string;
  collaborators: { user: string; role: "read" | "write" | "admin" }[];
}

const SAMPLES: Sample[] = [
  {
    owner: "acc_orbit",
    name: "engine",
    visibility: "private",
    description: "Small private engine fixture.",
    collaborators: [
      { user: "acc_jun", role: "write" },
      { user: "acc_sam", role: "read" },
    ],
  },
  {
    owner: "acc_orbit",
    name: "website",
    visibility: "public",
    description: "The Orbit Labs website.",
    collaborators: [],
  },
  {
    owner: "acc_marco",
    name: "hello-world",
    visibility: "public",
    description: "My first repository.",
    collaborators: [],
  },
  {
    owner: "acc_sam",
    name: "notes",
    visibility: "private",
    description: "Private scratch notes.",
    collaborators: [],
  },
];

export const dev = new Hono<AppEnv>();

dev.use("*", async (c, next) => {
  if (Reflect.get(c.env, "DEV_MODE") !== "true") return fail(c, 404, "Not found.");
  const id = Reflect.get(c.env, "AGENT_ID");
  if (
    id &&
    [
      "/tokens",
      "/seed",
      "/environment",
      "/atlas",
      "/durable",
      "/usage",
      "/retention",
      "/ci-age",
      "/repo-inventory",
      "/repo-purge",
      "/repo-orphans",
    ].some((path) => c.req.path.endsWith(path))
  ) {
    const secret = Reflect.get(c.env, "AGENT_SECRET");
    const supplied = c.req.header("Authorization")?.replace(/^Bearer /, "");
    if (typeof secret !== "string" || !secret || !supplied) return fail(c, 401, "Unauthorized.");
    const expected = new TextEncoder().encode(secret);
    const actual = new TextEncoder().encode(supplied);
    if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual))
      return fail(c, 401, "Unauthorized.");
  }
  await next();
});

// The Durable Object purge contract in the real runtime (CORE-197): every
// class, a fresh instance each, registered, given storage, purged.
dev.post("/durable", async (c) => {
  const { classes } = await readJson<{ classes?: DurableClass[] }>(c);
  return c.json({ results: await probeDurableObjects(c.env, "acc_jun", classes) });
});

// Usage metering in the real runtime (CORE-207): run today's collection
// from the start to the end, then return one account's figures.
dev.post("/usage", async (c) => {
  const { account } = await readJson<{ account: string }>(c);
  const found = account ? await findAccountBySlug(c.env.DB, account) : null;
  if (!found) return fail(c, 404, "No such account.");
  await c.env.DB.prepare("DELETE FROM job_cursors WHERE name = 'usage:collect'").run();
  let runs = 0;
  for (let done = false; !done && runs < 50; runs++) done = (await collectUsage(c.env)).done;
  const { results } = await c.env.DB.prepare(
    "SELECT day, construct, item, metric, kind, quantity, estimated, method FROM usage_snapshots WHERE account_id = ? ORDER BY day, construct, item, metric",
  )
    .bind(found.id)
    .all();
  return c.json({ runs, figures: results });
});

// Retention runs in the real runtime with a moment `daysAhead` days from now
// (CORE-203), so E2E can age what it just made: run to the end, synchronously.
// With `account`, that account's categories; without, the site's. With `gc`,
// the registry's garbage collection then runs at the same moment (CORE-205).
dev.post("/retention", async (c) => {
  const { account, categories, daysAhead, dryRun, gc } = await readJson<{
    account?: string;
    categories?: Record<string, Record<string, number>>;
    daysAhead?: number;
    dryRun?: boolean;
    gc?: boolean;
  }>(c);
  if (typeof daysAhead !== "number" || !Number.isFinite(daysAhead) || !categories)
    return fail(c, 400, "daysAhead and categories are required.");
  let target: RetentionTarget = { scope: "site" };
  if (account) {
    const found = await findAccountBySlug(c.env.DB, account);
    if (!found) return fail(c, 404, "No such account.");
    target = { scope: "account", accountId: found.id };
  }
  const now = new Date(Date.now() + daysAhead * 86_400_000);
  const id = await createRun(c.env.DB, {
    target,
    trigger: "manual",
    actorId: null,
    dryRun: dryRun === true,
    categories: Object.entries(categories).map(([category, thresholds]) => ({
      id: category,
      thresholds,
    })),
    now,
  });
  for (let calls = 0; calls < 50; calls++)
    if ((await advanceRun(c.env, id, { now })) !== "more") break;
  let collected: number | null = null;
  if (gc) {
    const services = new Services(c.env, c.req.raw, () => undefined, "dev", SYSTEM_ACTOR);
    collected = 0;
    for (let rounds = 0; rounds < 20; rounds++) {
      const { blobs } = await collectGarbage(services, now.getTime());
      collected += blobs;
      if (!blobs) break;
    }
  }
  return c.json({ run: await getRun(c.env.DB, target, id), collected });
});

// CI retention in the real runtime (CORE-200): move runs (with their jobs and
// steps) back in time so the retention categories see them as old.
dev.post("/ci-age", async (c) => {
  const { owner, name, numbers, days } = await readJson<{
    owner: string;
    name: string;
    numbers: number[];
    days: number;
  }>(c);
  const account = owner ? await findAccountBySlug(c.env.DB, owner) : null;
  const repo = account
    ? await db(c.env.DB)
        .selectFrom("repos")
        .select("id")
        .where("owner_id", "=", account.id)
        .where("name", "=", name ?? "")
        .executeTakeFirst()
    : undefined;
  if (!repo) return fail(c, 404, "No such repository.");
  if (!Array.isArray(numbers) || !Number.isInteger(days))
    return fail(c, 400, "Send {numbers, days}.");
  const shift = `-${days} days`;
  const at = (column: string) =>
    `${column} = CASE WHEN ${column} IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', ${column}, '${shift}') END`;
  const runs = `SELECT id FROM ci_runs WHERE repo_id = ? AND number IN (SELECT value FROM json_each(?))`;
  const jobs = `SELECT id FROM ci_jobs WHERE run_id IN (${runs})`;
  const ids = JSON.stringify(numbers);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE ci_steps SET ${at("started_at")}, ${at("finished_at")} WHERE job_id IN (${jobs})`,
    ).bind(repo.id, ids),
    c.env.DB.prepare(
      `UPDATE ci_jobs SET ${at("started_at")}, ${at("finished_at")} WHERE id IN (${jobs})`,
    ).bind(repo.id, ids),
    c.env.DB.prepare(
      `UPDATE ci_runs SET ${at("created_at")}, ${at("started_at")}, ${at("finished_at")}
       WHERE id IN (${runs})`,
    ).bind(repo.id, ids),
  ]);
  return c.json({ ok: true });
});

// Repository deletion in the real runtime (CORE-199). The inventory of what
// a repository (by id, or owner/name while it exists or its deletion is
// recorded) holds in every store; nothing is changed.
dev.get("/repo-inventory", async (c) => {
  const id = await devRepoId(c.env, c.req.query("repo") ?? "");
  if (!id) return fail(c, 404, "No such repository or deletion.");
  return c.json(await repoInventory(c.env, id));
});

// `terminate` stands for a crash: the purge's Workflow instance dies where it
// is. `resume` is the cron's restart, without waiting for staleness.
dev.post("/repo-purge", async (c) => {
  const body = await readJson<{ repo: string; action: "terminate" | "resume" }>(c);
  const id = await devRepoId(c.env, body.repo ?? "");
  const deletion = id ? await deletionStatus(c.env, id) : null;
  if (!id || !deletion) return fail(c, 404, "No such deletion.");
  if (body.action === "terminate") {
    if (!deletion.workflowId) return fail(c, 409, "The purge has no Workflow instance.");
    const instance = await c.env.REPO_PURGE.get(deletion.workflowId);
    await instance.terminate();
    return c.json({ terminated: deletion.workflowId, status: await instance.status() });
  }
  if (body.action === "resume") {
    const started = await resumeDeletions(c.env, {
      staleMs: 0,
      waitUntil: (work) => c.executionCtx.waitUntil(work),
    });
    return c.json({ started, deletion: await deletionStatus(c.env, id) });
  }
  return fail(c, 400, "action is terminate or resume.");
});

// The orphan sweep, only in an isolated agent environment (its provider
// namespaces are its own). `plant` makes an orphan in each store as a
// repository deleted before the purge existed would have left it: an AI
// Search item and a vector naming an unknown repository id, and an Artifacts
// repository no row names. `sweep` runs the sweep from the start to the end,
// treating every Artifacts repository as old enough.
dev.post("/repo-orphans", async (c) => {
  if (!Reflect.get(c.env, "AGENT_ID"))
    return fail(c, 403, "Only an isolated agent environment sweeps orphans.");
  const body = await readJson<{ action: "plant" | "sweep" }>(c);
  if (body.action === "plant") return c.json(await plantOrphans(c.env));
  if (body.action === "sweep") {
    await resetOrphanSweep(c.env);
    let state = await sweepRepoOrphans(c.env, {
      waitUntil: (work) => c.executionCtx.waitUntil(work),
      limits: { minAgeMs: 0 },
    });
    for (let calls = 1; state.stage !== "done" && calls < 50; calls++)
      state = await sweepRepoOrphans(c.env, {
        waitUntil: (work) => c.executionCtx.waitUntil(work),
        limits: { minAgeMs: 0 },
      });
    return c.json(state);
  }
  return fail(c, 400, "action is plant or sweep.");
});

dev.get("/environment", async (c) => {
  const accounts = await db(c.env.DB)
    .selectFrom("accounts")
    .select("id")
    .where("id", "in", ["acc_priya", "acc_marco", "acc_jun", "acc_sam", "acc_orbit"])
    .execute();
  const repos = await db(c.env.DB).selectFrom("repos").select(["owner_id", "name"]).execute();
  return c.json({
    id: Reflect.get(c.env, "AGENT_ID") ?? null,
    ready: accounts.length === 5,
    fixtures: SAMPLES.every((sample) =>
      repos.some((repo) => repo.owner_id === sample.owner && repo.name === sample.name),
    ),
  });
});

// Mint a token for any persona with no sign-in, so scripts can bootstrap:
//   curl -X POST localhost:5180/api/dev/tokens -d '{"persona":"jun"}'
// A clef playground: ask typed questions about any state, to tune the
// questions the knowledge pipeline asks.
dev.post("/clef", async (c) => {
  const { state, questions } = await readJson<{
    state: unknown;
    questions: Record<string, ClefQuestion>;
  }>(c);
  if (!state || !questions) return fail(c, 400, "Send {state, questions}.");
  return c.json(await decide(c.env, state, questions));
});

dev.post("/tokens", async (c) => {
  const body = await readJson<{ persona: string; name: string; scope: TokenScope }>(c);
  const persona = body.persona ? await findAccountBySlug(c.env.DB, body.persona) : null;
  if (!persona || persona.kind !== "user") return fail(c, 404, "No such persona.");
  const scope: TokenScope = body.scope === "read" ? "read" : "write";
  const name = body.name?.trim() || "dev";
  return c.json(await issueToken(c.env.DB, persona.id, name, scope), 201);
});

dev.post("/seed", async (c) => {
  let created = 0;
  for (const sample of SAMPLES) {
    let row = await db(c.env.DB)
      .selectFrom("repos")
      .select("id")
      .where("owner_id", "=", sample.owner)
      .where("name", "=", sample.name)
      .executeTakeFirst();
    if (!row) {
      const artifactsName = newArtifactsName();
      const repo = await c.env.ARTIFACTS.create(artifactsName, {
        description: sample.description,
        setDefaultBranch: "main",
      });
      const id = `repo_${crypto.randomUUID()}`;
      try {
        await db(c.env.DB)
          .insertInto("repos")
          .values({
            id,
            owner_id: sample.owner,
            name: sample.name,
            description: sample.description,
            visibility: sample.visibility,
            default_branch: repo.defaultBranch || "main",
            artifacts_name: artifactsName,
            artifacts_remote: repo.remote,
            imported_from: null,
          })
          .execute();
        row = { id };
        created++;
      } catch (error) {
        await c.env.ARTIFACTS.delete(artifactsName);
        row = await db(c.env.DB)
          .selectFrom("repos")
          .select("id")
          .where("owner_id", "=", sample.owner)
          .where("name", "=", sample.name)
          .executeTakeFirst();
        if (!row) throw error;
      }
    }
    if (sample.collaborators.length) {
      await batch(
        c.env.DB,
        sample.collaborators.map((collaborator) =>
          db(c.env.DB)
            .insertInto("repo_collaborators")
            .values({ repo_id: row.id, user_id: collaborator.user, role: collaborator.role })
            .onConflict((oc) => oc.columns(["repo_id", "user_id"]).doNothing()),
        ),
      );
    }
  }
  return c.json({ created }, created ? 201 : 200);
});

/**
 * An Atlas for a seeded repository without a Knowledge build or a model
 * (worker/atlas/fixture.ts): `publish` writes the fixture graph at `commit`
 * (the commit its files were pushed at) and publishes a snapshot; `expire`
 * expires every prior snapshot, as retention does. `publishes` first records
 * in the registry that the repository publishes that npm package, and the
 * snapshot records it, so a workspace can resolve imports of it (CORE-167).
 * `overlay` stores the fixture timeline's knowledge overlay for bookmark
 * `ref` at `commit`, measured against main's `base`; `end` keeps it
 * read-only with `reason`, as the coordinator does when the bookmark goes.
 * `land` (with publish) also records the build as finished at `commit`, as
 * the Knowledge build does last, so an open page's status poll sees a build
 * land and reads the route again; `queue` makes the repository's build
 * pending again (CORE-187).
 */
dev.post("/atlas", async (c) => {
  const body = await readJson<{
    repo: string;
    action: "publish" | "expire" | "overlay" | "end" | "queue";
    land?: boolean;
    commit?: string;
    base?: string;
    ref?: string;
    reason?: "landed" | "abandoned" | "ended";
    variant?: "base" | "merged" | "consumer";
    unavailable?: "disabled" | "budget_exhausted" | "provider_error" | "error";
    publishes?: string;
  }>(c);
  const [owner, name] = (body.repo ?? "").split("/");
  const account = owner ? await findAccountBySlug(c.env.DB, owner) : null;
  const repo = account
    ? await db(c.env.DB)
        .selectFrom("repos")
        .select(["id", "name"])
        .where("owner_id", "=", account.id)
        .where("name", "=", name ?? "")
        .executeTakeFirst()
    : undefined;
  if (!repo) return fail(c, 404, "No such repository.");
  if (body.action === "expire") return c.json(await expireAtlasPriors(c.env.DB, repo.id));
  if (body.action === "queue") {
    await queueAtlasFixtureBuild(c.env.DB, repo.id);
    return c.json({ queued: true });
  }
  const oid = /^[0-9a-f]{40}$/;
  if (body.action === "overlay") {
    if (
      !body.ref?.startsWith("timeline/") ||
      !oid.test(body.commit ?? "") ||
      !oid.test(body.base ?? "")
    )
      return fail(c, 400, "Send {repo, action: overlay, ref: timeline/<slug>, commit, base}.");
    return c.json(
      await writeAtlasFixtureOverlay(c.env.DB, repo.id, body.ref, body.commit!, body.base!),
      201,
    );
  }
  if (body.action === "end") {
    if (!body.ref?.startsWith("timeline/"))
      return fail(c, 400, "Send {repo, action: end, ref: timeline/<slug>, reason}.");
    await endAtlasFixtureOverlay(c.env.DB, repo.id, body.ref, body.reason ?? "landed");
    return c.json({ ended: body.ref });
  }
  if (body.action !== "publish" || !body.commit || !/^[0-9a-f]{40}$/.test(body.commit))
    return fail(c, 400, "Send {repo, action: publish, commit} or {repo, action: expire}.");
  if (body.publishes !== undefined && !/^[a-z0-9][a-z0-9._-]{0,100}$/.test(body.publishes))
    return fail(c, 400, "publishes is an unscoped npm package name.");
  if (body.publishes)
    await registerFixturePackage(c.env.REGISTRY_DB, account!, repo.id, body.publishes);
  await writeAtlasFixtureGraph(c.env.DB, repo.id, repo.name, body.commit, body.variant ?? "base");
  const published = await publishAtlasFixture(c.env, repo.id, body.commit, {
    unavailable: body.unavailable ?? "disabled",
    packages: true,
  });
  if (body.land) await landAtlasFixtureBuild(c.env.DB, repo.id, body.commit);
  return c.json(published, 201);
});

/** A repository's id from its id or owner/name, live, being deleted or deleted. */
async function devRepoId(env: Env, repo: string): Promise<string | null> {
  if (!repo) return null;
  if (!repo.includes("/")) return repo;
  const [owner, name] = repo.split("/");
  const live = await env.DB.prepare(
    "SELECT r.id FROM repos r JOIN accounts o ON o.id = r.owner_id WHERE o.slug = ? AND r.name = ?",
  )
    .bind(owner, name)
    .first<string>("id");
  if (live) return live;
  return (
    (await env.DB.prepare(
      "SELECT repo_id FROM repo_deletions WHERE full_name = ? ORDER BY requested_at DESC LIMIT 1",
    )
      .bind(repo)
      .first<string>("repo_id")) ?? null
  );
}
