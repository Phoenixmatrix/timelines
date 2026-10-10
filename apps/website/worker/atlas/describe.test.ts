import { describe, expect, test, vi } from "vite-plus/test";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type {
  AtlasDescription,
  AtlasDetail,
  AtlasInference,
  AtlasOverview,
  AtlasProvenance,
} from "../../shared/atlas.ts";
import type { AppEnv } from "../auth.ts";
import { ANALYZER } from "../knowledge/analyze.ts";
import {
  ATLAS_LIMITS,
  atlasInfer,
  atlasRunSpend,
  reserveAtlasCall,
  type PriceTable,
} from "../knowledge/budget.ts";
import { MODELS } from "../knowledge/models.ts";
import { sha256 } from "../knowledge/util.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { atlas } from "./api.ts";
import {
  describeRepoCapabilities,
  DESCRIBE_PURPOSE,
  DESCRIBE_VERSION,
  type DescribeOptions,
} from "./describe.ts";
import {
  beginRepoProjection,
  childrenAt,
  entityAt,
  groupRepoCapabilities,
  GROUPS,
  projectEdges,
  projectEntities,
  publishProjection,
  repoScope,
  type AtlasEntity,
  type EdgeCursor,
} from "./projection.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkflowEntrypoint: class {},
}));

const scope = repoScope("r1");
const PRICES: PriceTable = { [MODELS.reason]: { input: 0.45, output: 3.2 } };

const FILES = {
  "src/billing/charge.ts": ["payments", "code"],
  "src/billing/invoice.ts": ["payments", "code"],
  "web/checkout.ts": ["payments", "cart", "code"],
  "web/cart.ts": ["cart", "code"],
  "ops/deploy.ts": ["deployment", "code"],
  "ops/rollback.ts": ["deployment", "code"],
  "ops/canary.ts": ["deployment", "code"],
  "misc/notes.ts": ["code"],
} as const;

function node(
  sqlite: DatabaseSync,
  id: string,
  kind: string,
  name: string,
  path: string | null,
  summary = "",
  data: Record<string, unknown> = {},
) {
  sqlite
    .prepare(
      `INSERT INTO kg_nodes (repo_id, id, kind, name, path, summary, data, content_hash, changed_in)
       VALUES ('r1', ?, ?, ?, ?, ?, ?, 'h', 'c')
       ON CONFLICT (repo_id, id) DO UPDATE SET summary = excluded.summary, data = excluded.data`,
    )
    .run(id, kind, name, path, summary, JSON.stringify(data));
}
function edge(sqlite: DatabaseSync, src: string, dst: string, kind: string) {
  sqlite
    .prepare(`INSERT INTO kg_edges (repo_id, src, dst, kind, weight) VALUES ('r1', ?, ?, ?, 1)`)
    .run(src, dst, kind);
}

/** A file's card (kg_blob_analysis), keyed by its blob. */
function card(sqlite: DatabaseSync, path: string, blob: string, summary: string) {
  sqlite
    .prepare(
      `INSERT INTO kg_blob_analysis (blob_oid, analyzer, language, data, model) VALUES (?, ?, 'typescript', ?, ?)
       ON CONFLICT DO UPDATE SET data = excluded.data`,
    )
    .run(
      blob,
      ANALYZER,
      JSON.stringify({
        language: "typescript",
        role: "source",
        lines: 40,
        summary,
        responsibilities: [`Handles ${path}`],
        symbols: [
          { name: "main", kind: "function", line: 7, exported: true },
          { name: "helper", kind: "function", line: 0, exported: false, description: "Helps" },
        ],
        concepts: [],
        imports: [],
      }),
      MODELS.fast,
    );
}

/** The capability fixture of projection.test.ts, with file cards and syntheses. */
function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('ann', 'user', 'ann', 'Ann');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('r1', 'ann', 'shop', 'private', 'art-r1', '');
  `);
  node(sqlite, "repo", "repository", "shop", null);
  for (const dir of ["src", "src/billing", "web", "ops", "misc"])
    node(sqlite, `dir:${dir}`, "directory", dir, dir);
  node(sqlite, "component:src/billing", "component", "Billing", null, "Charges and invoices.", {
    dir: "src/billing",
  });
  node(sqlite, "component:web", "component", "Web", null, "The storefront.", { dir: "web" });
  node(sqlite, "component:ops", "component", "Ops", null, "Deploys the shop.", { dir: "ops" });
  for (const path of Object.keys(FILES)) setFile(sqlite, path, `${path}@1`, `Card for ${path}`);
  for (const c of ["payments", "cart", "deployment", "code"])
    node(sqlite, `concept:${c}`, "concept", c[0]!.toUpperCase() + c.slice(1), null, `About ${c}`);
  for (const [component, files] of [
    ["component:src/billing", ["src/billing/charge.ts", "src/billing/invoice.ts"]],
    ["component:web", ["web/checkout.ts", "web/cart.ts"]],
    ["component:ops", ["ops/deploy.ts", "ops/rollback.ts", "ops/canary.ts"]],
  ] as const)
    for (const f of files) edge(sqlite, component, `file:${f}`, "contains");
  edge(sqlite, "file:web/checkout.ts", "file:src/billing/charge.ts", "imports");
  edge(sqlite, "file:src/billing/invoice.ts", "file:src/billing/charge.ts", "imports");
  edge(sqlite, "file:web/cart.ts", "file:web/checkout.ts", "imports");
  edge(sqlite, "file:ops/rollback.ts", "file:ops/deploy.ts", "imports");
  edge(sqlite, "file:ops/canary.ts", "file:ops/rollback.ts", "imports");
  for (const [path, concepts] of Object.entries(FILES))
    for (const c of concepts) edge(sqlite, `file:${path}`, `concept:${c}`, "mentions");
  return { sqlite, DB: d1(sqlite) };
}

/** Point a file at a blob with its own card (a push that changed it). */
function setFile(sqlite: DatabaseSync, path: string, blob: string, summary: string) {
  node(sqlite, `file:${path}`, "file", path.split("/").pop()!, path, summary, {
    blob,
    lines: 40,
  });
  card(sqlite, path, blob, summary);
}

interface FakeAi {
  calls: { model: string; user: string }[];
  binding: { run(model: string, inputs: unknown): Promise<unknown> };
}

/** A stub Workers AI binding that names whatever it is shown. */
function fakeAi(
  reply: (input: { files: { path: string }[] }) => unknown = (input) => ({
    name: `Capability of ${input.files[0]?.path}`,
    summary: `These files share the work described by ${input.files.length} cards.`,
    rationale: "They import each other and share concepts.",
    sources: [input.files[0]?.path, "not/a/member.ts"],
  }),
  fail?: Error,
): FakeAi {
  const calls: FakeAi["calls"] = [];
  return {
    calls,
    binding: {
      async run(model, inputs) {
        const messages = (inputs as { messages: { role: string; content: string }[] }).messages;
        const user = messages.find((m) => m.role === "user")!.content;
        calls.push({ model, user });
        if (fail) throw fail;
        return {
          choices: [{ message: { content: JSON.stringify(reply(JSON.parse(user))) } }],
          usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 },
        };
      },
    },
  };
}

/**
 * One Atlas projection like the build's: group, describe (through the Atlas
 * budget, as the build does), batches, publish.
 */
async function build(
  DB: D1Database,
  ai: FakeAi,
  buildId: string,
  options: Partial<DescribeOptions> & { prices?: PriceTable } = {},
) {
  const { snapshotId, seq } = await beginRepoProjection(DB, "r1", [
    { repoId: "r1", commit: `commit-${buildId}`, buildId },
  ]);
  await groupRepoCapabilities(DB, "r1", snapshotId, seq);
  const env = { DB, AI: ai.binding } as unknown as Env;
  const described = await describeRepoCapabilities(
    env,
    { repoId: "r1", buildId, snapshotId, seq, commit: `commit-${buildId}` },
    {
      infer: atlasInfer(
        DB,
        { kind: "build", repoId: "r1", buildId },
        {
          prices: options.prices ?? PRICES,
        },
      ),
      ...options,
    },
  );
  let after: string | null = null;
  do ({ next: after } = await projectEntities(DB, "r1", snapshotId, seq, after));
  while (after);
  let cursor: EdgeCursor = null;
  do ({ next: cursor } = await projectEdges(DB, "r1", snapshotId, seq, cursor));
  while (cursor);
  await publishProjection(DB, scope, snapshotId, seq);
  const top = await childrenAt(DB, scope, seq, "repo", null, 100);
  const capabilities = top.entities.filter((e) => e.kind === "capability");
  return { seq, described, capabilities };
}

const descriptionOf = (e: AtlasEntity) => e.data.description as AtlasDescription;
const provenanceOf = (e: AtlasEntity) => e.data.provenance as AtlasProvenance;

/** Every file's placement and membership: what wording must never move. */
async function placements(DB: D1Database, seq: number) {
  const out: Record<string, unknown> = {};
  for (const path of Object.keys(FILES)) {
    const file = (await entityAt(DB, scope, seq, `file:${path}`))!;
    out[path] = { parent: file.parentId, membership: file.data.membership };
  }
  return out;
}

const count = (sqlite: DatabaseSync, table: string) =>
  (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("capability names and summaries", () => {
  test("model names and summaries, with transitive provenance to immutable sources", async () => {
    const { sqlite, DB } = setup();
    const ai = fakeAi();
    const { described, capabilities } = await build(DB, ai, "b1");
    expect(capabilities).toHaveLength(2);
    expect(described).toMatchObject({ capabilities: 2, current: 2, inferred: 2, cached: 0 });
    // One call per capability, on the reason model, recorded as Atlas spend.
    expect(ai.calls.map((c) => c.model)).toEqual([MODELS.reason, MODELS.reason]);
    expect(await atlasRunSpend(DB, "build", "b1")).toMatchObject({
      calls: 2,
      inputTokens: 1800,
      outputTokens: 240,
      exhausted: null,
    });
    expect(sqlite.prepare("SELECT DISTINCT purpose, status FROM atlas_spend").all()).toEqual([
      { purpose: DESCRIBE_PURPOSE, status: "settled" },
    ]);

    // Billing spans src/billing and web: four files, anchored on its best-linked one.
    const billing = capabilities.find((c) => (c.data.counts as { files: number }).files === 4)!;
    const anchor = (billing.data.anchor as string).slice(5);
    // The model's prompt was built from cards, syntheses and concepts, not other capability prose.
    const prompt = JSON.parse(ai.calls.find((c) => c.user.includes("charge.ts"))!.user);
    expect(prompt.files[0]).toEqual({
      path: anchor,
      role: "source",
      summary: `Card for ${anchor}`,
      responsibilities: [`Handles ${anchor}`],
      symbols: ["main", "helper"],
    });
    expect(prompt.components.map((c: { title: string }) => c.title).sort()).toEqual([
      "Billing",
      "Web",
    ]);
    expect(prompt.concepts.map((c: { name: string }) => c.name)).toContain("Payments");
    expect(prompt.grouping).toMatchObject({ member_files: 4, import_links_between_members: 3 });
    expect(JSON.stringify(prompt)).not.toContain("Capability of");

    expect(billing.name).toBe(`Capability of ${anchor}`);
    expect(billing.summary).toBe("These files share the work described by 4 cards.");
    expect(billing.data).toMatchObject({ nameSource: "model", interimName: expect.any(String) });
    expect(descriptionOf(billing)).toEqual({
      status: "current",
      name: billing.name,
      summary: billing.summary,
      rationale: "They import each other and share concepts.",
    });

    const provenance = provenanceOf(billing);
    expect(provenance.structural).toEqual({
      producer: "atlas/grouping",
      version: expect.any(Number),
      evidence: ["imports", "concepts"],
    });
    expect(provenance.curated).toEqual([]);
    const inferred = provenance.inferred!;
    expect(inferred).toMatchObject({
      fields: ["name", "summary", "rationale"],
      producer: "atlas/describe",
      model: MODELS.reason,
      basis: { repoId: "r1", commit: "commit-b1", buildId: "b1" },
      inputsHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // Cited sources are member files only (the made-up path is dropped), at
    // the indexed commit and blob, with ranges where known and "unavailable" otherwise.
    expect(inferred.sources).toEqual([
      {
        repoId: "r1",
        sourceId: "canonical",
        commit: "commit-b1",
        path: anchor,
        blob: `${anchor}@1`,
        range: { startLine: 1, endLine: 40, status: "whole-file" },
        symbols: [
          { name: "main", range: { startLine: 7, endLine: null, status: "start-line" } },
          { name: "helper", range: { startLine: null, endLine: null, status: "unavailable" } },
        ],
      },
    ]);
    // Transitively: the cards (blob, analyzer, model), syntheses and concepts it was derived from.
    const kinds = inferred.derivedFrom.map((d) => d.kind);
    expect(kinds[0]).toBe("membership");
    expect(inferred.derivedFrom).toContainEqual({
      kind: "file-card",
      path: "web/cart.ts",
      blob: "web/cart.ts@1",
      producer: "knowledge/analyze",
      analyzer: ANALYZER,
      model: MODELS.fast,
    });
    expect(inferred.derivedFrom).toContainEqual(
      expect.objectContaining({
        kind: "component-synthesis",
        id: "component:web",
        model: "unavailable",
      }),
    );
    expect(inferred.derivedFrom).toContainEqual(
      expect.objectContaining({ kind: "concept", id: "concept:payments", name: "Payments" }),
    );
    // No numeric confidence anywhere.
    expect(JSON.stringify(billing.data)).not.toMatch(/confidence/i);
  });

  test("identical inputs reuse the cached prose: a second build makes no calls and rewrites nothing", async () => {
    const { sqlite, DB } = setup();
    const ai = fakeAi();
    const first = await build(DB, ai, "b1");
    const rows = count(sqlite, "atlas_entities");
    const second = await build(DB, ai, "b2");
    expect(ai.calls).toHaveLength(2);
    expect(second.described).toMatchObject({ current: 2, cached: 2, inferred: 0 });
    expect(await atlasRunSpend(DB, "build", "b2")).toMatchObject({ calls: 0, usd: 0 });
    // The capability rows are the first snapshot's, stored once.
    expect(count(sqlite, "atlas_entities")).toBe(rows);
    expect(second.capabilities).toEqual(first.capabilities);
    // The prose keeps the source version it was written from.
    expect(provenanceOf(second.capabilities[0]!).inferred!.basis.buildId).toBe("b1");
  });

  test("a component reworded by the model reuses the prose: only what it shares changes it", async () => {
    const { sqlite, DB } = setup();
    const ai = fakeAi();
    const first = await build(DB, ai, "b1");
    // A push rewrote Ops' synthesis (any of its files changing does): new wording, same members.
    node(sqlite, "component:ops", "component", "Shipping", null, "Ships the shop blue-green.", {
      dir: "ops",
    });
    const second = await build(DB, ai, "b2");
    expect(second.described).toMatchObject({ current: 2, cached: 2, inferred: 0 });
    expect(ai.calls).toHaveLength(2);
    expect(second.capabilities).toEqual(first.capabilities);
    // The members a component shares are part of the inputs.
    edge(sqlite, "component:ops", "file:src/billing/charge.ts", "contains");
    const third = await build(DB, ai, "b3");
    expect(third.described).toMatchObject({ cached: 1, inferred: 1 });
    const changed = third.capabilities.find(
      (c) => provenanceOf(c).inferred?.basis.buildId === "b3",
    )!;
    const was = provenanceOf(first.capabilities.find((c) => c.id === changed.id)!).inferred!;
    const parts = provenanceOf(changed).inferred!.inputParts!;
    expect(Object.keys(parts).filter((key) => parts[key] !== was.inputParts![key])).toEqual([
      "component:component:ops",
      "order",
    ]);
  });

  test("prose cached by its components' wording is adopted under the new key, not bought again", async () => {
    const { sqlite, DB } = setup();
    const ai = fakeAi();
    const first = await build(DB, ai, "b1");
    // Restore the storage before components were keyed by their members:
    // the cache key was the hash of exactly what the model was shown.
    for (const call of ai.calls) {
      const key = await sha256(
        `atlas-capability:${DESCRIBE_VERSION}:${ANALYZER}:r1:canonical:${call.user}`,
      );
      const name = `Capability of ${(JSON.parse(call.user) as { files: { path: string }[] }).files[0]!.path}`;
      sqlite
        .prepare(`UPDATE kg_synthesis SET key = ? WHERE json_extract(data, '$.name') = ?`)
        .run(key, name);
    }
    const second = await build(DB, ai, "b2");
    expect(second.described).toMatchObject({ current: 2, cached: 2, inferred: 0 });
    expect(ai.calls).toHaveLength(2);
    expect(second.capabilities).toEqual(first.capabilities);
    // Adopted under the new key: the next build finds it there.
    node(sqlite, "component:ops", "component", "Shipping", null, "Ships the shop blue-green.", {
      dir: "ops",
    });
    const third = await build(DB, ai, "b3");
    expect(third.described).toMatchObject({ cached: 2, inferred: 0 });
    expect(ai.calls).toHaveLength(2);
  });

  test("a wording-only change in model output never moves members or ids", async () => {
    const { sqlite, DB } = setup();
    const first = await build(DB, fakeAi(), "b1");
    const before = await placements(DB, first.seq);
    // Forget the cached prose: the model now words everything differently.
    sqlite.exec("DELETE FROM kg_synthesis");
    const reworded = fakeAi((input) => ({
      name: `Renamed ${input.files.length}`,
      summary: "Entirely different words.",
      rationale: "Other words.",
      sources: [],
    }));
    const second = await build(DB, reworded, "b2");
    expect(second.capabilities.map((c) => c.id).sort()).toEqual(
      first.capabilities.map((c) => c.id).sort(),
    );
    expect(second.capabilities.map((c) => c.name).sort()).toEqual(["Renamed 3", "Renamed 4"]);
    expect(await placements(DB, second.seq)).toEqual(before);
    // No cited source: the prose still rests on the member files it was shown.
    expect(provenanceOf(second.capabilities[0]!).inferred!.sources.length).toBeGreaterThan(0);
  });

  test("an exhausted budget keeps structure and interim names, prose unavailable", async () => {
    const { DB } = setup();
    // Stub reservations: the build's 20 calls are already spent.
    for (let i = 0; i < ATLAS_LIMITS.build.calls; i++)
      await reserveAtlasCall(
        DB,
        {
          scope: { kind: "build", repoId: "r1", buildId: "b1" },
          purpose: "other",
          model: MODELS.reason,
          maxInputTokens: 1,
          maxOutputTokens: 1,
        },
        { prices: PRICES },
      );
    const ai = fakeAi();
    const { seq, described, capabilities } = await build(DB, ai, "b1");
    expect(ai.calls).toHaveLength(0);
    expect(described).toMatchObject({
      current: 0,
      unavailable: 2,
      reasons: { budget_exhausted: 2 },
    });
    expect(capabilities).toHaveLength(2);
    for (const cap of capabilities) {
      expect(cap.name).toBe(cap.data.interimName);
      expect(cap.summary).toBe("");
      expect(cap.data.nameSource).toBe("concepts");
      expect(descriptionOf(cap)).toEqual({
        status: "unavailable",
        reason: "budget_exhausted",
        exhausted: { cap: "calls", resetsAt: null },
        name: null,
        summary: null,
        rationale: null,
      });
      expect(provenanceOf(cap).inferred).toBeNull();
    }
    // Membership still published.
    const charge = await entityAt(DB, scope, seq, "file:src/billing/charge.ts");
    expect(charge?.parentId).not.toBe(GROUPS.unclassified);
  });

  test("the account's daily ceiling stops paid work too", async () => {
    const { sqlite, DB } = setup();
    sqlite
      .prepare(
        `INSERT INTO atlas_spend (id, account_id, day, scope, run_id, repo_id, purpose, model, status,
           input_tokens, output_tokens, cost_micro_usd, reserved_input_tokens, reserved_output_tokens,
           reserved_micro_usd, created_at)
         VALUES ('s0', 'ann', ?, 'build', 'other', 'r1', 'x', ?, 'settled', 0, 0, ?, 0, 0, 0, ?)`,
      )
      .run(
        new Date().toISOString().slice(0, 10),
        MODELS.reason,
        ATLAS_LIMITS.dailyUsdPerAccount * 1_000_000,
        new Date().toISOString(),
      );
    const ai = fakeAi();
    const { capabilities } = await build(DB, ai, "b1");
    expect(ai.calls).toHaveLength(0);
    expect(descriptionOf(capabilities[0]!)).toMatchObject({
      status: "unavailable",
      reason: "budget_exhausted",
      exhausted: { cap: "daily_usd", resetsAt: expect.any(String) },
    });
  });

  test("an unpriced model disables paid synthesis", async () => {
    const { DB } = setup();
    const ai = fakeAi();
    const { described, capabilities } = await build(DB, ai, "b1", { prices: {} });
    expect(ai.calls).toHaveLength(0);
    expect(described.reasons).toEqual({ disabled: 2 });
    expect(descriptionOf(capabilities[0]!)).toMatchObject({
      status: "unavailable",
      reason: "disabled",
    });
    expect(await atlasRunSpend(DB, "build", "b1")).toMatchObject({ calls: 0 });
  });

  test("a provider error is charged, not retried, and leaves prose unavailable", async () => {
    const { sqlite, DB } = setup();
    const ai = fakeAi(undefined, new Error("upstream 500"));
    const { described, capabilities } = await build(DB, ai, "b1");
    expect(described.reasons).toEqual({ provider_error: 2 });
    expect(ai.calls.length).toBeLessThanOrEqual(2);
    // Every attempt stays charged at its reservation; none is repeated.
    const spend = sqlite.prepare("SELECT status FROM atlas_spend").all() as { status: string }[];
    expect(spend).toHaveLength(ai.calls.length);
    expect(spend.every((s) => s.status === "failed")).toBe(true);
    expect(descriptionOf(capabilities[0]!)).toMatchObject({
      status: "unavailable",
      reason: "provider_error",
    });
    expect(count(sqlite, "kg_synthesis")).toBe(0);
  });

  test("changing the selected model reuses prose and spends only on changed content", async () => {
    const { sqlite, DB } = setup();
    const original = "@cf/zai-org/glm-5.3-flash";
    const selected = "@cf/google/gemma-4-26b-a4b-it";
    const ai = fakeAi();
    const prices = {
      [original]: { input: 0.15, output: 0.5 },
      [selected]: { input: 0.1, output: 0.3 },
    };
    const first = await build(DB, ai, "b1", { model: original, prices });
    expect(ai.calls.map((c) => c.model)).toEqual([original, original]);
    const second = await build(DB, ai, "b2", { model: selected, prices });
    expect(second.described).toMatchObject({ cached: 2, inferred: 0 });
    expect(second.capabilities).toEqual(first.capabilities);
    expect(ai.calls).toHaveLength(2);
    expect(await atlasRunSpend(DB, "build", "b2")).toMatchObject({ calls: 0, usd: 0 });
    expect(count(sqlite, "kg_synthesis")).toBe(2);

    setFile(sqlite, "ops/deploy.ts", "ops/deploy.ts@2", "Deploys with blue-green");
    const third = await build(DB, ai, "b3", { model: selected, prices });
    expect(third.described).toMatchObject({ current: 2, cached: 1, inferred: 1 });
    expect(ai.calls.slice(2).map((c) => c.model)).toEqual([selected]);
    const changed = third.capabilities.find(
      (c) => provenanceOf(c).inferred?.basis.buildId === "b3",
    )!;
    expect(provenanceOf(changed).inferred).toMatchObject({
      model: selected,
      basis: { buildId: "b3" },
    });
    // Provenance says which input part changed.
    const was = provenanceOf(first.capabilities.find((c) => c.id === changed.id)!).inferred!;
    const parts = provenanceOf(changed).inferred!.inputParts!;
    expect(Object.keys(parts).filter((key) => parts[key] !== was.inputParts![key])).toEqual([
      "file:ops/deploy.ts",
    ]);
    const unchanged = third.capabilities.find((c) => c.id !== changed.id)!;
    expect(provenanceOf(unchanged)).toEqual(
      provenanceOf(first.capabilities.find((c) => c.id === unchanged.id)!),
    );
    const spend = await atlasRunSpend(DB, "build", "b3");
    expect(spend).toMatchObject({ calls: 1, inputTokens: 900, outputTokens: 120 });
    expect(spend.usd).toBeCloseTo((900 * 0.1 + 120 * 0.3) / 1_000_000, 10);
  });

  test.each([
    [MODELS.reason, "@cf/zai-org/glm-5.3-flash"],
    ["@cf/zai-org/glm-5.3-flash", "@cf/google/gemma-4-26b-a4b-it"],
  ])(
    "reuses legacy %s cache rows after selecting %s without rewriting provenance",
    async (original, selected) => {
      const { sqlite, DB } = setup();
      const ai = fakeAi();
      const prices = {
        [original]: { input: 0.45, output: 3.2 },
        [selected]: { input: 0.1, output: 0.3 },
      };
      await build(DB, ai, "b1", { model: original, prices });
      // Restore the pre-settings storage shape: the model was part of the
      // exact input hash, both in the cache key and immutable inference record.
      for (const call of ai.calls) {
        const identity = `atlas-capability:${DESCRIBE_VERSION}:${ANALYZER}:`;
        const legacyKey = await sha256(`${identity}${original}:r1:${call.user}`);
        const name = `Capability of ${(JSON.parse(call.user) as { files: { path: string }[] }).files[0]!.path}`;
        sqlite
          .prepare(
            `UPDATE kg_synthesis SET key = ?,
           data = json_set(data, '$.inference.inputsHash', ?) WHERE json_extract(data, '$.name') = ?`,
          )
          .run(legacyKey, legacyKey, name);
      }
      const stored = sqlite.prepare("SELECT * FROM kg_synthesis ORDER BY key").all();
      const cached = sqlite.prepare("SELECT data FROM kg_synthesis").all() as { data: string }[];
      const originalProvenance = new Map(
        cached.map(({ data }) => {
          const value = JSON.parse(data) as { name: string; inference: AtlasInference };
          return [value.name, value.inference];
        }),
      );
      const second = await build(DB, ai, "b2", { model: selected, prices });
      expect(second.described).toMatchObject({ current: 2, cached: 2, inferred: 0 });
      expect(ai.calls).toHaveLength(2);
      expect(await atlasRunSpend(DB, "build", "b2")).toMatchObject({ calls: 0, usd: 0 });
      for (const capability of second.capabilities)
        expect(provenanceOf(capability).inferred).toEqual(originalProvenance.get(capability.name));
      expect(sqlite.prepare("SELECT * FROM kg_synthesis ORDER BY key").all()).toEqual(stored);

      setFile(sqlite, "ops/deploy.ts", "ops/deploy.ts@2", "Deploys with blue-green");
      const third = await build(DB, ai, "b3", { model: selected, prices });
      expect(third.described).toMatchObject({ current: 2, cached: 1, inferred: 1 });
      expect(ai.calls.slice(2).map((c) => c.model)).toEqual([selected]);
    },
  );

  test("a model the provider refuses is a provider error, charged once per call", async () => {
    const { sqlite, DB } = setup();
    const ai = fakeAi(undefined, new Error("5007: No such model test/unserved or task"));
    const model = "test/unserved";
    const { described, capabilities } = await build(DB, ai, "b1", {
      model,
      prices: { [model]: { input: 0.45, output: 3.2 } },
    });
    expect(described.reasons).toEqual({ provider_error: 2 });
    expect(ai.calls.every((c) => c.model === model)).toBe(true);
    const spend = sqlite.prepare("SELECT status, model FROM atlas_spend").all();
    expect(spend).toEqual(ai.calls.map(() => ({ status: "failed", model })));
    expect(descriptionOf(capabilities[0]!)).toMatchObject({
      status: "unavailable",
      reason: "provider_error",
    });
  });

  test("a reply without a summary is invalid and cached nowhere", async () => {
    const { sqlite, DB } = setup();
    const ai = fakeAi(() => ({ name: "Only a name" }));
    const { described } = await build(DB, ai, "b1");
    expect(described.reasons).toEqual({ invalid_reply: 2 });
    expect(count(sqlite, "kg_synthesis")).toBe(0);
  });

  test("when new prose can't be written, the previous prose stays, labelled stale with its basis", async () => {
    const { sqlite, DB } = setup();
    const first = await build(DB, fakeAi(), "b1");
    const before = first.capabilities.find(
      (c) => (c.data.counts as { files: number }).files === 3,
    )!;
    // A push changes a card, then the provider is down.
    setFile(sqlite, "ops/deploy.ts", "ops/deploy.ts@2", "Deploys with blue-green");
    const ai = fakeAi(undefined, new Error("upstream 500"));
    const second = await build(DB, ai, "b2");
    expect(second.described).toMatchObject({ current: 1, cached: 1, stale: 1 });
    const ops = second.capabilities.find((c) => c.id === before.id)!;
    expect(ops.name).toBe(ops.data.interimName);
    expect(ops.summary).toBe("");
    expect(descriptionOf(ops)).toEqual({
      status: "stale",
      reason: "provider_error",
      name: before.name,
      summary: before.summary,
      rationale: descriptionOf(before).rationale,
    });
    // The stale prose names the source version it was written from.
    const inferred = provenanceOf(ops).inferred as AtlasInference;
    expect(inferred.basis).toEqual({
      repoId: "r1",
      sourceId: "canonical",
      commit: "commit-b1",
      buildId: "b1",
    });
    expect(inferred.sources[0]?.commit).toBe("commit-b1");

    // Still stale a build later, still with the original basis.
    const third = await build(DB, ai, "b3");
    const again = third.capabilities.find((c) => c.id === before.id)!;
    expect(descriptionOf(again).status).toBe("stale");
    expect(provenanceOf(again).inferred!.basis.buildId).toBe("b1");
  });

  test("without a model runner, cached prose is used and the rest is labelled", async () => {
    const { sqlite, DB } = setup();
    await build(DB, fakeAi(), "b1");
    setFile(sqlite, "web/cart.ts", "web/cart.ts@2", "A new cart");
    const ai = fakeAi();
    const { described } = await build(DB, ai, "b2", { infer: null, unavailable: "error" });
    expect(ai.calls).toHaveLength(0);
    expect(described).toMatchObject({ cached: 1, stale: 1, reasons: { error: 1 } });
  });

  test("the read API labels each region's prose and serves its provenance, with no model", async () => {
    const { sqlite, DB } = setup();
    await build(DB, fakeAi(), "b1");
    setFile(sqlite, "web/cart.ts", "web/cart.ts@2", "A new cart");
    await build(DB, fakeAi(), "b2", { prices: {} });
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", { id: "ann", slug: "ann", displayName: "Ann", isSiteAdmin: false });
      await next();
    });
    app.route("/api/repos/:owner/:name/atlas", atlas);
    // Browsing has no model: any touch of AI fails the request.
    const env = {
      DB,
      BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
      AI: new Proxy(
        {},
        {
          get: () => {
            throw new Error("browse touched AI");
          },
        },
      ),
    } as unknown as Env;
    const get = async <T>(path: string) => {
      const response = await app.request(`/api/repos/ann/shop/atlas/${path}`, {}, env);
      expect(response.status).toBe(200);
      return (await response.json()) as T;
    };
    const overview = await get<AtlasOverview>("overview");
    const states = overview.regions
      .filter((r) => r.kind === "capability")
      .map((r) => [r.summaryState, r.summary === ""]);
    expect(states).toContainEqual([{ status: "current" }, false]);
    expect(states).toContainEqual([{ status: "stale", reason: "disabled" }, true]);
    expect(overview.regions.find((r) => r.kind === "group")?.summaryState).toBeUndefined();
    const stale = overview.regions.find((r) => r.summaryState?.status === "stale")!;
    const detail = await get<AtlasDetail>(`detail?id=${encodeURIComponent(stale.id)}`);
    expect(detail.entity.data.description).toMatchObject({
      status: "stale",
      summary: expect.any(String),
    });
    expect((detail.entity.data.provenance as AtlasProvenance).inferred?.basis.buildId).toBe("b1");
  });
});
