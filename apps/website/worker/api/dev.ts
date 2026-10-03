import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { AppEnv } from "../auth.ts";
import type { TokenScope } from "../../shared/api.ts";
import { newArtifactsName } from "../artifacts.ts";
import {
  endAtlasFixtureOverlay,
  expireAtlasPriors,
  publishAtlasFixture,
  registerFixturePackage,
  writeAtlasFixtureGraph,
  writeAtlasFixtureOverlay,
} from "../atlas/fixture.ts";
import { decide, type ClefQuestion } from "../knowledge/models.ts";
import { findAccountBySlug } from "../db.ts";
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
    ["/tokens", "/seed", "/environment", "/atlas"].some((path) => c.req.path.endsWith(path))
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
 */
dev.post("/atlas", async (c) => {
  const body = await readJson<{
    repo: string;
    action: "publish" | "expire" | "overlay" | "end";
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
  return c.json(published, 201);
});
