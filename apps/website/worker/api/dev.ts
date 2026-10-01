import { Hono } from "hono";
import type { AppEnv } from "../auth.ts";
import type { TokenScope } from "../../shared/api.ts";
import { newArtifactsName } from "../artifacts.ts";
import { notifyKnowledge } from "../knowledge/coordinator.ts";
import { decide, type ClefQuestion } from "../knowledge/models.ts";
import { findAccountBySlug } from "../db.ts";
import { fail, readJson } from "./http.ts";
import { issueToken } from "./tokens.ts";

// DEVELOPMENT ONLY: sample repositories that put each persona's permissions to
// work. Small public repos are imported; sam/notes starts empty to show the
// first-push flow.
interface Sample {
  owner: string;
  name: string;
  visibility: "public" | "private";
  description: string;
  importUrl: string | null;
  collaborators: { user: string; role: "read" | "write" | "admin" }[];
}

const SAMPLES: Sample[] = [
  {
    owner: "acc_orbit",
    name: "engine",
    visibility: "private",
    description: "Tiny utility for constructing className strings.",
    importUrl: "https://github.com/lukeed/clsx",
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
    importUrl: "https://github.com/octocat/Spoon-Knife",
    collaborators: [],
  },
  {
    owner: "acc_marco",
    name: "hello-world",
    visibility: "public",
    description: "My first repository.",
    importUrl: "https://github.com/octocat/Hello-World",
    collaborators: [],
  },
  {
    owner: "acc_sam",
    name: "notes",
    visibility: "private",
    description: "Private scratch notes.",
    importUrl: null,
    collaborators: [],
  },
];

export const dev = new Hono<AppEnv>();

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
  const existing = await c.env.DB.prepare("SELECT count(*) AS n FROM repos").first<{ n: number }>();
  if (existing && existing.n > 0)
    return c.json({ error: "Sample repositories already exist." }, 409);

  const created = await Promise.all(
    SAMPLES.map(async (sample) => {
      const artifactsName = newArtifactsName();
      const repo = sample.importUrl
        ? await c.env.ARTIFACTS.import({
            source: { url: sample.importUrl },
            target: { name: artifactsName, opts: { description: sample.description } },
          })
        : await c.env.ARTIFACTS.create(artifactsName, {
            description: sample.description,
            setDefaultBranch: "main",
          });
      return { sample, artifactsName, repo };
    }),
  );

  const statements = created.flatMap(({ sample, artifactsName, repo }) => {
    const id = `repo_${crypto.randomUUID()}`;
    return [
      c.env.DB.prepare(
        `INSERT INTO repos (id, owner_id, name, description, visibility, default_branch,
           artifacts_name, artifacts_remote, imported_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        sample.owner,
        sample.name,
        sample.description,
        sample.visibility,
        repo.defaultBranch || "main",
        artifactsName,
        repo.remote,
        sample.importUrl,
      ),
      ...sample.collaborators.map((collaborator) =>
        c.env.DB.prepare(
          "INSERT INTO repo_collaborators (repo_id, user_id, role) VALUES (?, ?, ?)",
        ).bind(id, collaborator.user, collaborator.role),
      ),
    ];
  });
  await c.env.DB.batch(statements);
  const { results } = await c.env.DB.prepare("SELECT id FROM repos").all<{ id: string }>();
  c.executionCtx.waitUntil(Promise.all(results.map((r) => notifyKnowledge(c.env, r.id))));
  return c.json({ created: created.length }, 201);
});
