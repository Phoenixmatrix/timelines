// Timeline wiki pages (CORE-84): a checkpoint queues them, the coordinator
// starts them, the Workflow writes them from the timeline's graph with main's
// wiki code; asking on demand works; a set is idempotent per checkpoint and
// copied forward between sets; main's wiki is never written; the checkpoint
// view (and so the approval inbox) and the knowledge API show them; ended
// timelines keep theirs read-only. The models are fakes.

import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { WorkflowStep } from "cloudflare:workers";
import type {
  KnowledgeOverlay,
  KnowledgeOverlayChange,
  KnowledgePageSet,
  KnowledgePageSets,
  KnowledgeTimelinePage,
} from "../../shared/api.ts";
import type { CheckpointView } from "../../shared/timelines.ts";
import type { OpenRequests } from "../../shared/tracker.ts";
import { issueToken } from "../api/tokens.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import type { RepoReader } from "../objects.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { durableStorage } from "../testing/durable.ts";
import { fakeRemotes } from "../testing/remote.ts";
import { timelines } from "../timelines/api.ts";
import { Timing } from "../timing.ts";
import { Tracker } from "../tracker/object.ts";
import { tracker as trackerRoutes } from "../tracker/api.ts";
import { ANALYZER, type FileAnalysis } from "./analyze.ts";
import { knowledge } from "./api.ts";
import { KnowledgeCoordinator, requestCheckpointPages } from "./coordinator.ts";
import { applyGraph, buildGraph, saveSnapshot, type SnapshotFile } from "./graph.ts";
import {
  choosePages,
  queueSet,
  runPageSet,
  schedulePages,
  writeSetPages,
  type PageSetRef,
} from "./pages.ts";
import { overlayGraphs, diffGraphs, type FileChange } from "./overlay.ts";
import { updatePages, type WikiSource } from "./wiki.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const oid = (n: number) => n.toString(16).padStart(40, "0");
const MAIN = oid(1);
const TIP = oid(9);
const REF = "refs/heads/timeline/search";

const analysis = (over: Partial<FileAnalysis> = {}): FileAnalysis => ({
  language: "typescript",
  role: "source",
  lines: 10,
  summary: "Does a thing.",
  responsibilities: [],
  symbols: [],
  concepts: [],
  imports: [],
  ...over,
});

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const blobFile = (name: string, hash: string): ArtifactsTreeEntry => ({
  name,
  hash,
  mode: "100644",
  type: "blob",
});
const dir = (name: string, hash: string): ArtifactsTreeEntry => ({
  name,
  hash,
  mode: "40000",
  type: "tree",
});
const commit = (hash: string, tree: string, parents: string[], at: number) =>
  ({
    hash,
    treeHash: tree,
    message: hash,
    author: { name: "a", email: "a@x" },
    committer: { name: "a", email: "a@x" },
    parents,
    authoredAt: at,
    committedAt: at,
  }) satisfies ArtifactsCommitMetadata;

// Main has two components, src/web and src/cli. The timeline changes
// src/web/f0.ts (a refund function, a new concept) and adds src/web/f10.ts.
const MAIN_FILES: SnapshotFile[] = ["cli", "web"].flatMap((d) =>
  range(10).map((i) => ({ path: `src/${d}/f${i}.ts`, blob: `${d}${i}`, mode: "100644" })),
);
const TREES: Record<string, ArtifactsTreeEntry[]> = {
  "t-main": [dir("src", "s-main")],
  "s-main": [dir("cli", "d-cli"), dir("web", "w-main")],
  "t-tip": [dir("src", "s-tip")],
  "s-tip": [dir("cli", "d-cli"), dir("web", "w-tip")],
  "d-cli": range(10).map((i) => blobFile(`f${i}.ts`, `cli${i}`)),
  "w-main": range(10).map((i) => blobFile(`f${i}.ts`, `web${i}`)),
  "w-tip": [
    blobFile("f0.ts", "web0b"),
    ...range(9).map((i) => blobFile(`f${i + 1}.ts`, `web${i + 1}`)),
    blobFile("f10.ts", "web10"),
  ],
};
const COMMITS = [commit(MAIN, "t-main", [], 1), commit(TIP, "t-tip", [MAIN], 2)];

/** Reads the fixture's history and trees; blobs are not needed. */
const reader = {
  async commit(hash: string) {
    return COMMITS.find((c) => c.hash === hash) ?? null;
  },
  async tree(hash: string) {
    return TREES[hash] ?? null;
  },
  async blob() {
    return null;
  },
  async close() {},
} as unknown as RepoReader;

/** A Durable Object's state: key-value storage and an alarm, in memory. */
function objectState() {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    storage: {
      get: async (key: string) => structuredClone(values.get(key)),
      put: async (key: string, value: unknown) => void values.set(key, structuredClone(value)),
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => void (alarm = at),
      deleteAlarm: async () => void (alarm = null),
    },
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
  } as unknown as DurableObjectState;
}

interface AiCall {
  kind: "clef" | "write";
  prompt: string;
}

async function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name, member_repo_role) VALUES
      ('ann', 'user', 'ann', 'Ann', NULL), ('ben', 'user', 'ben', 'Ben', NULL),
      ('cat', 'user', 'cat', 'Cat', NULL), ('orbit', 'org', 'orbit', 'Orbit', 'read');
    INSERT INTO org_members (org_id, user_id, role) VALUES
      ('orbit', 'ann', 'owner'), ('orbit', 'ben', 'member'), ('orbit', 'cat', 'member');
    INSERT INTO agents (id, name, accountable_id) VALUES ('agt_bot', 'bot', 'ben');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('app', 'orbit', 'app', 'private', 'r-pages-${crypto.randomUUID()}', 'https://app');
    INSERT INTO repo_collaborators (repo_id, user_id, role) VALUES ('app', 'ben', 'write');
    INSERT INTO kg_state (repo_id, indexed_commit) VALUES ('app', '${MAIN}');
  `);
  const git = fakeRemotes();
  const app = git.add("https://app", { "refs/heads/main": MAIN });
  vi.stubGlobal("fetch", git.fetch);

  // The models: clef answers how stale a page is; the writer echoes the page.
  const ai = { stale: 0.9, calls: [] as AiCall[] };
  const AI = {
    async run(_model: string, inputs: Record<string, unknown>) {
      if ("questions" in inputs) {
        ai.calls.push({ kind: "clef", prompt: JSON.stringify(inputs.state) });
        return { answers: { stale: { type: "noul", noul: ai.stale } } };
      }
      const prompt = (inputs.messages as { content: string }[])[1]!.content;
      ai.calls.push({ kind: "write", prompt });
      const title = /page for the component "([^"]+)"/.exec(prompt)?.[1] ?? "a front page";
      return {
        choices: [
          {
            message: { content: `Written about ${title}.\n\n## Details\n\nMore.` },
            finish_reason: "stop",
          },
        ],
        usage: { total_tokens: 1000 },
      };
    },
  };

  const builds = new Map<string, { params: unknown; status: string }>();
  const trackers = new Map<string, Tracker>();
  const env = {
    DB: d1(sqlite),
    ARTIFACTS: git.artifacts,
    AI,
    KNOWLEDGE_BUILD: {
      create: async ({ id, params }: { id: string; params: unknown }) =>
        void builds.set(id, { params, status: "running" }),
      get: async (id: string) => ({
        status: async () => ({ status: builds.get(id)?.status ?? "running" }),
        terminate: async () => {},
      }),
    },
    KNOWLEDGE_COORDINATOR: { getByName: () => coordinator },
    TRACKER: {
      getByName: (id: string) => {
        if (!trackers.has(id)) {
          const { sql, transactionSync } = durableStorage();
          const ctx = { storage: { sql, transactionSync } } as unknown as DurableObjectState;
          trackers.set(id, new Tracker(ctx, {} as Env));
        }
        return trackers.get(id);
      },
    },
  } as unknown as Env;
  const coordinator = new KnowledgeCoordinator(objectState(), env);

  // Main's knowledge: analyses (the timeline's blobs too, as its overlay left
  // them), the indexed snapshot, the graph and a written wiki.
  const insert = sqlite.prepare(
    `INSERT INTO kg_blob_analysis (blob_oid, analyzer, language, data) VALUES (?, ?, 'typescript', ?)`,
  );
  const analyses = new Map<string, FileAnalysis>(MAIN_FILES.map((f) => [f.blob, analysis()]));
  analyses.set(
    "web0b",
    analysis({
      summary: "Does a thing, and refunds.",
      symbols: [{ name: "refund", kind: "function", line: 3, exported: true }],
      concepts: ["refund window"],
    }),
  );
  analyses.set("web10", analysis({ summary: "Keeps refunds.", concepts: ["refund window"] }));
  for (const [blob, a] of analyses) insert.run(blob, ANALYZER, JSON.stringify(a));
  await saveSnapshot(env.DB, "app", "current", MAIN_FILES);
  const syntheses = { components: new Map(), concepts: new Map() };
  const mainGraph = buildGraph("orbit/app", MAIN_FILES, analyses, syntheses);
  await applyGraph(env.DB, "app", "b0", MAIN, mainGraph);
  const mainSource: WikiSource = {
    repoId: "app",
    commit: MAIN,
    reader,
    graph: mainGraph,
    syntheses,
    files: MAIN_FILES,
    analyses,
    readme: "",
  };
  await updatePages(
    env,
    mainSource,
    ["overview", "architecture", "components/src-cli", "components/src-web", "glossary"],
    new Set(),
  );
  ai.calls.length = 0;
  const mainWiki = () => sqlite.prepare("SELECT * FROM wiki_pages ORDER BY slug").all();
  const mainNodes = () => sqlite.prepare("SELECT id, content_hash FROM kg_nodes ORDER BY id").all();

  const server = new Hono<AppEnv>();
  server.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    c.set("timing", new Timing());
    return next();
  });
  server.route("/api/tracker/:owner/timelines", timelines);
  server.route("/api/repos/:owner/:name/knowledge", knowledge);
  server.route("/api", trackerRoutes);
  const tokens = {
    ann: (await issueToken(env.DB, "ann", "t", "write")).secret,
    ben: (await issueToken(env.DB, "ben", "t", "write")).secret,
    cat: (await issueToken(env.DB, "cat", "t", "write")).secret,
    bot: (await issueToken(env.DB, "ben", "t", "write", undefined, "agt_bot")).secret,
  };
  const pending: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (work: Promise<unknown>) => pending.push(work),
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  const raw = async (who: keyof typeof tokens, method: string, path: string, body?: unknown) => {
    const response = await server.request(
      `/api${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${tokens[who]}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
      executionCtx,
    );
    await Promise.all(pending.splice(0));
    return { status: response.status, body: (await response.json()) as any };
  };
  const timeline = (who: keyof typeof tokens, method: string, path: string, body?: unknown) =>
    raw(who, method, `/tracker/orbit/timelines${path}`, body);
  const kn = (who: keyof typeof tokens, method: string, path: string) =>
    raw(who, method, `/repos/orbit/app/knowledge${path}`);

  // A timeline in orbit/app whose bookmark moved to TIP.
  await timeline("bot", "POST", "", { slug: "search", repos: ["orbit/app"] });
  app.refs.set(REF, TIP);

  const step = (names: string[]) =>
    ({
      do: async (name: string, a: unknown, b?: unknown) => {
        names.push(name);
        return ((typeof a === "function" ? a : b) as () => Promise<unknown>)();
      },
    }) as unknown as WorkflowStep;

  /** Wake the coordinator, then run every page set it started to the end. */
  const drain = async () => {
    await coordinator.alarm();
    const started = [...builds].filter(([, b]) => b.status === "running");
    const results = [];
    for (const [, build] of started) {
      const params = build.params as Parameters<typeof runPageSet>[1];
      results.push(
        await runPageSet(env, params, step([]), {
          repo: async (repoId) => ({ id: repoId, full_name: "orbit/app" }),
          withReader: (_row, work) => work(reader),
          finished: (buildId) => coordinator.pagesFinished(buildId),
        }),
      );
      build.status = "complete";
    }
    return { started: started.map(([id, b]) => ({ id, params: b.params })), results };
  };

  const sets = () =>
    sqlite
      .prepare(
        "SELECT set_key, status, commit_oid, checkpoint_number FROM kg_page_sets ORDER BY requested_at",
      )
      .all();
  const pages = (key: string) =>
    sqlite
      .prepare(
        "SELECT slug, kind, change, outcome, model FROM kg_page_set_pages WHERE set_key = ? ORDER BY slug",
      )
      .all(key);

  return {
    sqlite,
    env,
    app,
    ai,
    coordinator,
    builds,
    timeline,
    kn,
    raw,
    drain,
    sets,
    pages,
    mainWiki,
    mainNodes,
    step,
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function makeCheckpoint(t: Setup, summary = "Refunds") {
  const made = await t.timeline("bot", "POST", "/search/checkpoints", { summary });
  expect(made.status).toBe(201);
  return made.body as CheckpointView;
}

describe("timeline wiki pages", () => {
  test("a checkpoint queues them; they're written from the timeline's graph, never main's wiki", async () => {
    const t = await setup();
    const wikiBefore = t.mainWiki();
    const nodesBefore = t.mainNodes();

    const made = await makeCheckpoint(t);
    // Making the checkpoint only queued them: nothing was written or started yet.
    expect(t.sets()).toEqual([
      { set_key: made.checkpoint.id, status: "queued", commit_oid: TIP, checkpoint_number: 1 },
    ]);
    expect(t.builds.size).toBe(0);
    expect(t.ai.calls).toEqual([]);

    // The coordinator starts it; meanwhile the checkpoint shows it pending.
    await t.coordinator.alarm();
    expect(t.builds.size).toBe(1);
    const build = [...t.builds.values()][0];
    expect(build!.params).toMatchObject({
      repoId: "app",
      pages: { ref: REF, key: made.checkpoint.id },
    });
    const pending = (await t.timeline("cat", "GET", "/search/checkpoints/1"))
      .body as CheckpointView;
    expect(pending.knowledge).toMatchObject([{ repoId: "app", state: "writing", pages: [] }]);

    const { results } = await t.drain();
    expect(results).toEqual([
      expect.objectContaining({ status: "succeeded", written: 2, kept: 0, copied: 0 }),
    ]);

    // The changed component's page (clef said main's was stale) and the
    // glossary of its new concept; nothing else.
    expect(t.pages(made.checkpoint.id)).toEqual([
      {
        slug: "components/src-web",
        kind: "component",
        change: "changed",
        outcome: "written",
        model: "@cf/qwen/qwen3.8-27b",
      },
      { slug: "glossary", kind: "glossary", change: "changed", outcome: "written", model: null },
    ]);
    expect(t.ai.calls.map((c) => c.kind)).toEqual(["clef", "write"]);
    const write = t.ai.calls[1]!.prompt;
    expect(write).toContain('the component "src/web"');
    expect(write).toContain("What this timeline changes");
    expect(write).toContain("timeline_changes");
    expect(write).toContain("src/web/f10.ts");
    const glossary = t.sqlite
      .prepare("SELECT body FROM kg_page_set_pages WHERE slug = 'glossary'")
      .get() as { body: string };
    expect(glossary.body).toContain("### refund window");
    expect(glossary.body).toContain("New in this timeline");

    // Main's wiki and graph are exactly as they were.
    expect(t.mainWiki()).toEqual(wikiBefore);
    expect(t.mainNodes()).toEqual(nodesBefore);
    expect((await t.coordinator.status()).pages).toEqual([]);

    // The checkpoint, and so an approval request in the inbox, shows them.
    const view = (await t.timeline("cat", "GET", "/search/checkpoints/1")).body as CheckpointView;
    expect(view.knowledge).toMatchObject([
      {
        repoId: "app",
        state: "succeeded",
        checkpoint: { id: made.checkpoint.id, number: 1 },
        commit: TIP,
        baseCommit: MAIN,
        counts: { component: { added: 0, changed: 1, removed: 0 } },
        pages: [
          {
            slug: "components/src-web",
            outcome: "written",
            excerpt: "Written about src/web.",
          },
          { slug: "glossary", outcome: "written" },
        ],
      },
    ]);
    const mutate = (who: "ann" | "bot", mutation: unknown) =>
      t.raw(who, "POST", "/tracker/orbit/mutate", {
        operationId: crypto.randomUUID(),
        mutations: [mutation],
      });
    await mutate("ann", { kind: "team.create", id: "team", data: { key: "ENG", name: "Eng" } });
    await mutate("bot", {
      kind: "issue.create",
      id: "issue",
      data: { teamId: "team", title: "S" },
    });
    await mutate("bot", {
      kind: "request.open",
      id: "req",
      data: { issueId: "issue", kind: "approval", prompt: "Land?", checkpoint: made.checkpoint.id },
    });
    const inbox = (await t.raw("ben", "GET", "/requests")).body as OpenRequests;
    expect(inbox.requests[0]!.checkpoint!.knowledge[0]).toMatchObject({
      state: "succeeded",
      pages: [{ slug: "components/src-web" }, { slug: "glossary" }],
    });
  });

  test("are idempotent per checkpoint, and copied forward when the material is the same", async () => {
    const t = await setup();
    const made = await makeCheckpoint(t);
    await t.drain();
    const calls = t.ai.calls.length;
    const first = t.sqlite.prepare("SELECT * FROM kg_page_set_pages ORDER BY slug").all();

    // Asking again for the same checkpoint is the same set: nothing starts.
    await requestCheckpointPages(t.env, made.checkpoint, "search", "agt_bot");
    expect(
      await queueSet(t.env.DB, {
        repoId: "app",
        ref: REF,
        key: made.checkpoint.id,
        commit: TIP,
        checkpoint: { id: made.checkpoint.id, number: 1 },
        requestedBy: null,
      }),
    ).toEqual({ status: "succeeded", queued: false });
    expect((await t.drain()).started).toEqual([]);
    // Settling the set's pages again changes nothing and asks no model.
    const set: PageSetRef = { repoId: "app", ref: REF, key: made.checkpoint.id };
    const changes = await timelineChanges(t);
    const again = await writeSetPages(t.env, set, changes.source, changes.diff, changes.chosen);
    expect(again).toMatchObject({ written: 0, unchanged: 2 });
    expect(t.ai.calls.length).toBe(calls);
    expect(t.sqlite.prepare("SELECT * FROM kg_page_set_pages ORDER BY slug").all()).toEqual(first);

    // On demand at the same commit: a set of its own, copied from the checkpoint's.
    expect((await t.kn("cat", "POST", "/overlay/pages?ref=timeline/search")).status).toBe(403);
    const asked = await t.kn("ben", "POST", "/overlay/pages?ref=timeline/search");
    expect(asked.status).toBe(202);
    expect(asked.body).toMatchObject({ key: `commit:${TIP}`, state: "queued", checkpoint: null });
    // Asking twice at the same commit is one set.
    await t.kn("ben", "POST", "/overlay/pages?ref=timeline/search");
    expect(t.sets()).toHaveLength(2);
    const { results } = await t.drain();
    expect(results).toEqual([
      expect.objectContaining({ status: "succeeded", copied: 1, written: 1 }),
    ]);
    // The glossary is drawn without a model; the component page was copied.
    expect(t.ai.calls.length).toBe(calls);

    // The API lists both sets, newest first, and serves a page in full.
    const listed = (await t.kn("cat", "GET", "/overlay/pages?ref=timeline/search"))
      .body as KnowledgePageSets;
    expect(listed).toMatchObject({ ref: "timeline/search", timeline: "search", ended: false });
    expect(listed.sets.map((s) => [s.key, s.state])).toEqual([
      [`commit:${TIP}`, "succeeded"],
      [made.checkpoint.id, "succeeded"],
    ]);
    const only = (
      await t.kn(
        "cat",
        "GET",
        `/overlay/pages?ref=timeline/search&checkpoint=${made.checkpoint.id}`,
      )
    ).body as KnowledgePageSets;
    expect(only.sets.map((s) => s.key)).toEqual([made.checkpoint.id]);
    const page = (
      await t.kn(
        "cat",
        "GET",
        `/overlay/page?ref=timeline/search&slug=components/src-web&set=${made.checkpoint.id}`,
      )
    ).body as KnowledgeTimelinePage;
    expect(page).toMatchObject({
      slug: "components/src-web",
      timeline: "search",
      generatedIn: TIP,
      outcome: "written",
      set: { key: made.checkpoint.id, checkpoint: { number: 1 } },
    });
    expect(page.body).toContain("Written about src/web.");
    expect(
      (await t.kn("cat", "GET", "/overlay/page?ref=timeline/search&slug=overview")).status,
    ).toBe(404);
    const overlay = (await t.kn("cat", "GET", "/overlay?ref=timeline/search"))
      .body as KnowledgeOverlay;
    expect(overlay.pageSets.map((s: KnowledgePageSet) => s.key)).toEqual([
      `commit:${TIP}`,
      made.checkpoint.id,
    ]);
  });

  test("stop at the token budget, and keep main's page when clef finds it still holds", async () => {
    const t = await setup();
    const changes = await timelineChanges(t);
    const capped = await writeSetPages(
      t.env,
      { repoId: "app", ref: REF, key: "commit:x" },
      changes.source,
      changes.diff,
      changes.chosen,
      0,
    );
    // The glossary costs nothing; the component page would have.
    expect(capped).toMatchObject({ skipped: 1, written: 1, tokens: 0 });
    expect(t.ai.calls.map((c) => c.kind)).toEqual(["clef"]);

    t.ai.stale = 0.1;
    const set: PageSetRef = { repoId: "app", ref: REF, key: "commit:y" };
    const kept = await writeSetPages(t.env, set, changes.source, changes.diff, changes.chosen);
    expect(kept).toMatchObject({ kept: 1, written: 1, tokens: 0 });
    expect(t.ai.calls.map((c) => c.kind)).toEqual(["clef", "clef"]);
    expect(t.pages("commit:y")).toMatchObject([
      { slug: "components/src-web", outcome: "kept" },
      { slug: "glossary", outcome: "written" },
    ]);
  });

  test("ended timelines keep their pages read-only", async () => {
    const t = await setup();
    const made = await makeCheckpoint(t);
    await t.drain();
    const written = t.pages(made.checkpoint.id);

    // A second checkpoint's set is queued and started, then the timeline ends.
    t.app.refs.set(REF, TIP);
    const second = await requestSecond(t, made);
    await t.coordinator.alarm();
    t.sqlite.exec(`
      INSERT INTO kg_overlays (repo_id, ref, overlay_id, head_commit, base_commit, status,
          attempted_commit, ended_at, ended_reason)
        VALUES ('app', '${REF}', 'o1', '${TIP}', '${MAIN}', 'succeeded', '${TIP}',
          '2026-10-03T00:00:00.000Z', 'landed');
    `);
    const calls = t.ai.calls.length;
    const { results } = await t.drain();
    expect(results).toEqual([{ status: "ended" }]);
    expect(t.ai.calls.length).toBe(calls);
    expect(t.pages(second)).toEqual([]);
    expect(t.sets()).toMatchObject([
      { set_key: made.checkpoint.id, status: "succeeded" },
      { set_key: second, status: "ended" },
    ]);

    // Nothing new is queued or asked for; what was written stays readable.
    expect(
      await queueSet(t.env.DB, {
        repoId: "app",
        ref: REF,
        key: "cp-later",
        commit: TIP,
        checkpoint: { id: "cp-later", number: 3 },
        requestedBy: null,
      }),
    ).toEqual({ status: "ended", queued: false });
    expect((await t.kn("ben", "POST", "/overlay/pages?ref=timeline/search")).status).toBe(409);
    const listed = (await t.kn("cat", "GET", "/overlay/pages?ref=timeline/search"))
      .body as KnowledgePageSets;
    expect(listed.ended).toBe(true);
    expect(t.pages(made.checkpoint.id)).toEqual(written);
  });
});

/** Queue a set as a second checkpoint at the same commit would. */
async function requestSecond(t: Setup, first: CheckpointView) {
  const key = "cp-second";
  await requestCheckpointPages(
    t.env,
    { ...first.checkpoint, id: key, number: 2 },
    "search",
    "agt_bot",
  );
  return key;
}

/** The timeline's graph at TIP, its diff against main and the pages it affects. */
async function timelineChanges(t: Setup) {
  const changes: FileChange[] = [
    { path: "src/web/f0.ts", blob: "web0b", before: "web0", mode: "100644" },
    { path: "src/web/f10.ts", blob: "web10", before: null, mode: "100644" },
  ];
  const graphs = await overlayGraphs(t.env.DB, { id: "app", full_name: "orbit/app" }, changes);
  const diff = diffGraphs(graphs.main, graphs.timeline);
  const source: WikiSource = {
    repoId: "app",
    commit: TIP,
    reader,
    graph: graphs.timeline,
    syntheses: graphs.syntheses,
    files: graphs.files,
    analyses: graphs.analyses,
    readme: "",
  };
  return { diff, source, chosen: choosePages(graphs.timeline, graphs.syntheses, diff).pages };
}

describe("choosing pages", () => {
  const change = (
    id: string,
    kind: KnowledgeOverlayChange["kind"],
    what: KnowledgeOverlayChange["change"],
    path: string | null = null,
  ): KnowledgeOverlayChange => ({
    id,
    kind,
    change: what,
    name: id,
    path,
    summary: "",
    fields: [],
    links: { added: [], removed: [] },
  });
  const files: SnapshotFile[] = ["api", "cli", "web"].flatMap((d) =>
    range(10).map((i) => ({ path: `src/${d}/f${i}.ts`, blob: `${d}${i}`, mode: "100644" })),
  );
  const graph = buildGraph("o/a", files, new Map(files.map((f) => [f.blob, analysis()])), {
    components: new Map(),
    concepts: new Map(),
  });
  const empty = { components: new Map(), concepts: new Map() };

  test("added components first, then the most changed; architecture when components come or go", () => {
    const diff = [
      change("component:src/api", "component", "added"),
      change("component:src/cli", "component", "changed"),
      change("component:src/web", "component", "changed"),
      change("component:src/old", "component", "removed"),
      change("file:src/web/f1.ts", "file", "changed", "src/web/f1.ts"),
      change("file:src/web/f2.ts", "file", "changed", "src/web/f2.ts"),
      change("file:src/cli/f1.ts", "file", "changed", "src/cli/f1.ts"),
    ];
    expect(choosePages(graph, empty, diff)).toEqual({
      pages: [
        { slug: "architecture", change: "changed" },
        { slug: "components/src-api", change: "added" },
        { slug: "components/src-web", change: "changed" },
        { slug: "components/src-cli", change: "changed" },
      ],
      skipped: 0,
    });
    // Capped: the least changed are left out and counted.
    expect(choosePages(graph, empty, diff, 2).skipped).toBe(1);
  });

  test("a glossary only when concepts change, and nothing for an unchanged graph", () => {
    expect(choosePages(graph, empty, [change("concept:x", "concept", "removed")]).pages).toEqual([
      { slug: "glossary", change: "changed" },
    ]);
    expect(choosePages(graph, empty, [])).toEqual({ pages: [], skipped: 0 });
  });
});

test("page sets start oldest first, one per timeline, a couple per repository", () => {
  const run = (ref: string) => ({ buildId: ref, ref, key: "k", startedAt: 0 });
  const queued = [
    { ref: "a", key: "1" },
    { ref: "a", key: "2" },
    { ref: "b", key: "1" },
    { ref: "c", key: "1" },
  ];
  expect(schedulePages([], queued, 2)).toEqual({
    start: [
      { ref: "a", key: "1" },
      { ref: "b", key: "1" },
    ],
    more: true,
  });
  expect(schedulePages([run("b")], queued, 2)).toEqual({
    start: [{ ref: "a", key: "1" }],
    more: true,
  });
  expect(schedulePages([], [{ ref: "a", key: "1" }], 2)).toEqual({
    start: [{ ref: "a", key: "1" }],
    more: false,
  });
});
