// Knowledge updates (CORE-286): an update after a push, driven by the diff
// from the indexed commit and reusing every decision whose inputs didn't
// change, must leave exactly the Knowledge a full rebuild at the same commit
// leaves: graph, concepts, decisions, wiki pages, vectors and search items.
// Two copies of one repository history are built side by side, one with
// updates and one with full rebuilds, through the real build Workflow with
// deterministic models (an answer depends only on its question). Built like
// CORE-166's incremental Atlas tests.

import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { d1 } from "../testing/d1.ts";
import {
  editCode,
  fakeAi,
  fakeSearch,
  fakeVectors,
  FakeGit,
  knowledgeFixture,
  knowledgeState,
  moveFile,
  setConcepts,
  type CallCounts,
  type KnowledgeFixture,
} from "../testing/knowledge-repo.ts";
import { resolveAtlasSettings } from "./budget.ts";
import type { KnowledgePolicy } from "./policy.ts";
import { seedSpaceFixture, createFreshSpaceTestEnvironment } from "../testing/spaces.ts";
import { issueToken } from "../api/tokens.ts";
import { captureWorkAuthority } from "../ci/admission.ts";
import type { WorkAuthority } from "../../shared/ci.ts";

const dispose: (() => void)[] = [];
afterEach(() => {
  for (const close of dispose.splice(0)) close();
});

const reading = vi.hoisted(() => ({ reader: null as unknown }));

vi.mock("cloudflare:workers", () => {
  class Base {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  }
  return { DurableObject: Base, WorkflowEntrypoint: Base };
});
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class NonRetryableError extends Error {
    override name = "NonRetryableError";
  },
}));
vi.mock(import("../objects.ts"), async (original) => ({
  ...(await original()),
  forgetRefs: () => {},
  // Every build reads the fixture's git objects.
  RepoReader: class {
    constructor() {
      return reading.reader as object;
    }
  } as never,
}));

const { KnowledgeBuild, PIPELINE } = await import("./build.ts");

const POLICY: KnowledgePolicy = {
  ai: {
    version: 1,
    // Atlas prose is CORE-166's; its structure is still projected.
    features: { knowledge: true, wiki: true, atlas: false, releaseNotes: false },
    models: {
      classification: "@cf/cloudflare/clef",
      fast: "@cf/zai-org/glm-5.3-flash",
      task: "@cf/zai-org/glm-5.3-flash",
    },
    updatedAt: null,
  },
  atlas: resolveAtlasSettings(null, null),
};

interface Side {
  sqlite: DatabaseSync;
  env: Env;
  authorization: WorkAuthority;
  calls: CallCounts;
  vectors: ReturnType<typeof fakeVectors>;
  search: ReturnType<typeof fakeSearch>;
}

async function side(): Promise<Side> {
  const fresh = await createFreshSpaceTestEnvironment();
  const { sqlite } = fresh;
  dispose.push(fresh.close);
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('ann', 'user', 'ann', 'Ann');
  `);
  await seedSpaceFixture(d1(sqlite), {
    organization: {
      id: "org-ann",
      slug: "ann",
      displayName: "Ann",
      kind: "personal",
      personalAccountId: "ann",
    },
    space: { id: "ann", slug: "ann", displayName: "General" },
    actorId: "ann",
    members: [
      {
        accountId: "ann",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
  });
  sqlite.exec(
    "INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote) VALUES ('r1', 'ann', 'ledger', 'private', 'art-r1', '')",
  );
  const calls: CallCounts = {};
  const vectors = fakeVectors();
  const search = fakeSearch();
  const coordinator = {
    finished: async () => {},
    pagesFinished: async () => {},
    overlayFinished: async () => {},
  };
  const env = {
    ...fresh.env,
    AI: fakeAi(calls),
    VECTORS: vectors,
    SEARCH: search,
    KNOWLEDGE_COORDINATOR: { getByName: () => coordinator },
  } as unknown as Env;
  const token = await issueToken(env.DB, "ann", "build", "write");
  const authorization = await captureWorkAuthority(env, "r1", {
    id: "ann",
    credential: { kind: "token", id: token.id },
  });
  return { sqlite, env, calls, vectors, search, authorization };
}

/** Run one build of `commit` to the end; its stats and the model calls it made. */
async function build(s: Side, commit: string, force = false) {
  const before = { ...s.calls };
  const buildId = crypto.randomUUID();
  const step = {
    do: async (_name: string, a: unknown, b?: unknown) =>
      ((typeof a === "function" ? a : b) as () => Promise<unknown>)(),
  };
  await new KnowledgeBuild({ waitUntil: () => {} } as never, s.env).run(
    {
      payload: {
        repoId: "r1",
        buildId,
        policy: POLICY,
        commit,
        force,
        authorization: s.authorization,
      },
      instanceId: buildId,
    } as never,
    step as never,
  );
  const row = s.sqlite
    .prepare("SELECT status, error, stats, ai_usage FROM kg_builds WHERE id = ?")
    .get(buildId) as { status: string; error: string | null; stats: string; ai_usage: string };
  expect(row.error).toBeNull();
  expect(row.status).toBe("succeeded");
  const calls: CallCounts = {};
  for (const [kind, n] of Object.entries(s.calls))
    if (n - (before[kind] ?? 0) > 0) calls[kind] = n - (before[kind] ?? 0);
  return { stats: JSON.parse(row.stats) as Record<string, unknown>, calls };
}

const state = (s: Side) => knowledgeState(s.sqlite, "r1", s);

/** Two copies of one history: `inc` updates after each push, `full` rebuilds in full. */
async function twins() {
  const repo = knowledgeFixture();
  const git = new FakeGit();
  reading.reader = git.reader();
  const inc = await side();
  const full = await side();
  return {
    repo,
    git,
    inc,
    full,
    async push(change: (repo: KnowledgeFixture) => void) {
      change(repo);
      const commit = git.commit(repo);
      const reads = git.treeReads;
      const a = await build(inc, commit);
      const incReads = git.treeReads - reads;
      const b = await build(full, commit, true);
      return { commit, inc: { ...a, treeReads: incReads }, full: b };
    },
  };
}

// Each test runs whole build histories twice: allow slow CI sandboxes time.
describe("Knowledge updates", { timeout: 120_000 }, () => {
  test("an update leaves exactly what a full rebuild at the same commit leaves, push after push", async () => {
    const t = await twins();
    const first = await t.push(() => {});
    // The first build is a full one on both sides.
    expect(first.inc.stats).toMatchObject({ mode: "full", fullBecause: "first" });
    expect(first.full.stats).toMatchObject({ mode: "full", fullBecause: "requested" });
    expect(state(t.inc)).toEqual(state(t.full));
    expect(state(t.inc).state).toEqual({ indexed_commit: first.commit, pipeline: PIPELINE });

    const pushes: [string, (repo: KnowledgeFixture) => void][] = [
      ["a code edit", (r) => editCode(r, "src/billing/f0.ts")],
      [
        "a file's new concept",
        (r) => setConcepts(r, "src/auth/f1.ts", ["Fraud Check", "Access Token"]),
      ],
      ["a new file", (r) => setConcepts(r, "src/web/api/f9.ts", ["Webhook Retry", "Webhooks"])],
      ["a moved file", (r) => moveFile(r, "lib/f2.ts", "lib/util/f2.ts")],
      ["a removed file", (r) => r.files.delete("src/web/pages/f3.ts")],
      [
        "several at once",
        (r) => {
          editCode(r, "src/web/pages/f0.ts");
          editCode(r, "src/auth/f2.ts");
          setConcepts(r, "src/billing/f3.ts", ["Invoice Ledger", "Refund Flow", "Ledger"]);
          r.files.delete("src/web/api/f9.ts");
        },
      ],
      ["the README", (r) => r.files.set("README.md", "# Ledger app\n\nNow with refunds.\n")],
      ["nothing but a concept dropped", (r) => setConcepts(r, "src/auth/f1.ts", ["Access Token"])],
      // A newcomer close to many established concepts changes their closest
      // candidates too: those pairs are decided as a full rebuild decides them.
      [
        "a crowded neighbourhood",
        (r) => setConcepts(r, "src/webhooks/f2.ts", ["Token Revocation", "Token Rotation"]),
      ],
    ];
    for (const [what, change] of pushes) {
      const result = await t.push(change);
      expect(result.inc.stats, what).toMatchObject({ mode: "update" });
      expect(state(t.inc), what).toEqual(state(t.full));
      // An update never asks the model more than a full rebuild of the same history.
      expect(result.inc.calls.total ?? 0, what).toBeLessThanOrEqual(result.full.calls.total ?? 0);
    }
  });

  test("a small push asks the model only about what it changed", async () => {
    const t = await twins();
    const first = await t.push(() => {});
    const cold = first.inc.calls.total!;

    // A code edit rewords the file's summary (as every real re-analysis
    // does) but keeps its concepts: no concept is defined again, so no review
    // or salience is asked again, and no pair is new.
    const edit = await t.push((r) => editCode(r, "src/billing/f0.ts"));
    expect(edit.inc.calls).not.toHaveProperty("definitions");
    expect(edit.inc.calls).not.toHaveProperty("review");
    expect(edit.inc.calls).not.toHaveProperty("salience");
    expect(edit.inc.calls).not.toHaveProperty("pair");
    // One file's card, its role, and whether the edit means anything.
    expect(edit.inc.calls).toMatchObject({ card: 1, role: 1, cosmetic: 1 });
    expect(edit.inc.calls.total!).toBeLessThan(cold / 5);
    // It reads only the trees that changed: the root, src and src/billing
    // (twice: before and after), not every directory.
    expect(edit.inc.treeReads).toBeLessThan(first.inc.treeReads);
    expect(edit.inc.stats.treesRead).toBe(edit.inc.treeReads);
    expect(edit.inc.stats).toMatchObject({ changedFiles: 1, removedFiles: 0, toAnalyze: 1 });

    // A new concept in one file: only its pairs and the definitions (and
    // reviews) of the groups it changed.
    const concept = await t.push((r) =>
      setConcepts(r, "src/auth/f1.ts", ["Fraud Check", "Access Token", "Session Store"]),
    );
    expect(concept.inc.calls.pair).toBeGreaterThan(0);
    expect(concept.inc.calls.definitions ?? 0).toBeLessThanOrEqual(2);
    expect(concept.inc.calls.total!).toBeLessThan(cold / 3);

    // The build records what it spent, by model.
    expect(edit.inc.stats.aiUsage).toMatchObject({ calls: edit.inc.calls.total });
    expect(Object.keys((edit.inc.stats.aiUsage as { byModel: object }).byModel).sort()).toEqual([
      "@cf/cloudflare/clef",
      "@cf/qwen/qwen3-embedding-0.6b",
      "@cf/zai-org/glm-5.3-flash",
    ]);
  });

  test("a new pipeline version rebuilds in full", async () => {
    const t = await twins();
    await t.push(() => {});
    t.inc.sqlite.exec("UPDATE kg_state SET pipeline = 'older'");
    const next = await t.push((r) => editCode(r, "lib/f0.ts"));
    expect(next.inc.stats).toMatchObject({ mode: "full", fullBecause: "version" });
    expect(state(t.inc)).toEqual(state(t.full));
  });
  for (const revoked of ["credential", "grant", "membership", "epoch", "space"] as const) {
    test(`queued builds refuse ${revoked} changes before provider or publication effects`, async () => {
      const t = await twins();
      const commit = t.git.commit(t.repo);
      const before = state(t.inc);
      if (revoked === "credential")
        t.inc.sqlite
          .prepare("DELETE FROM access_tokens WHERE id = ?")
          .run(t.inc.authorization.credential.id);
      else if (revoked === "grant")
        t.inc.sqlite.exec("DELETE FROM space_grants WHERE space_id = 'ann' AND account_id = 'ann'");
      else if (revoked === "membership")
        t.inc.sqlite.exec(
          "DELETE FROM organization_members WHERE organization_id = 'org-ann' AND account_id = 'ann'",
        );
      else if (revoked === "epoch")
        t.inc.authorization = {
          ...t.inc.authorization,
          migrationEpoch: t.inc.authorization.migrationEpoch + 1,
        };
      else t.inc.authorization = { ...t.inc.authorization, spaceId: "another-space" };
      await expect(build(t.inc, commit)).rejects.toThrow();
      expect(t.inc.calls).toEqual({});
      expect(state(t.inc)).toEqual(before);
    });
  }
});
