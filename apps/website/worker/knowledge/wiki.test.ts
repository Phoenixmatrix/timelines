import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { LEGACY_AI_SNAPSHOT } from "../../shared/ai.ts";
import type { RepoReader } from "../objects.ts";
import { createFreshSpaceTestEnvironment } from "../testing/spaces.ts";
import type { FileAnalysis } from "./analyze.ts";
import { applyGraph, buildGraph } from "./graph.ts";
import { planWiki, updatePages, type WikiSource } from "./wiki.ts";

vi.mock("cloudflare:workers", () => import("../testing/runtime.ts"));
const fixtures: { close(): void }[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

const analysis = (): FileAnalysis => ({
  language: "typescript",
  role: "source",
  lines: 10,
  summary: "Does a thing.",
  responsibilities: [],
  symbols: [],
  concepts: [],
  imports: [],
});

interface Call {
  prompt: string;
}

/** A repository of two components, a fake model, and the database the wiki lives in. */
async function setup(
  reply: (call: Call) => { content: string | null; finish?: string } | Error,
  stale: (state: unknown) => number = () => 0.9,
) {
  const fixture = await createFreshSpaceTestEnvironment();
  fixtures.push(fixture);
  const { sqlite } = fixture;
  sqlite.exec(`
    BEGIN;
    INSERT INTO organizations (id,slug,display_name,kind,default_space_id) VALUES ('org','org','Org','company','acc');
    INSERT INTO spaces (id,organization_id,slug,display_name) VALUES ('acc','org','org','Org');
    COMMIT;
    INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('repo', 'acc', 'app', 'private', 'a', 'https://a');
  `);
  const files = ["web", "cli"].flatMap((dir) =>
    Array.from({ length: 10 }, (_, i) => ({
      path: `src/${dir}/f${i}.ts`,
      blob: `${dir}${i}`,
      mode: "100644",
    })),
  );
  const analyses = new Map(files.map((f) => [f.blob, analysis()]));
  const syntheses = { components: new Map(), concepts: new Map() };
  const calls: Call[] = [];
  const AI = {
    async run(
      _model: string,
      inputs: {
        messages?: { content: string }[];
        questions?: unknown;
        state?: unknown;
      },
    ) {
      if (inputs.questions)
        return { answers: { stale: { type: "noul", noul: stale(inputs.state) } } };
      const call = {
        prompt: inputs.messages?.[1]?.content ?? "",
      };
      calls.push(call);
      const result = reply(call);
      if (result instanceof Error) throw result;
      return {
        choices: [{ message: { content: result.content }, finish_reason: result.finish ?? "stop" }],
        usage: { total_tokens: 10 },
      };
    },
  };
  const env = { ...fixture.env, AI } as unknown as Env;
  const source: WikiSource = {
    repoId: "repo",
    commit: "c1",
    reader: { blob: async () => null } as unknown as RepoReader,
    graph: buildGraph("org/app", files, analyses, syntheses),
    syntheses,
    files,
    analyses,
    readme: "",
  };
  const pages = () =>
    (
      sqlite.prepare("SELECT slug, body FROM wiki_pages ORDER BY slug").all() as {
        slug: string;
        body: string;
      }[]
    ).map((p) => [p.slug, p.body]);
  return { env, source, calls, pages, sqlite };
}

const SLUGS = ["overview", "architecture", "components/src-cli", "components/src-web", "glossary"];

describe("wiki updates", () => {
  test("plans every page of a new wiki, in catalog order", async () => {
    const c = await setup(() => ({ content: "Text." }));
    expect(await planWiki(c.env, c.source)).toEqual({ pending: SLUGS, unchanged: 0, removed: 0 });
  });

  test("saves each page as it is written, so a failed page doesn't cost the others", async () => {
    let webFails = true;
    const c = await setup(({ prompt }) =>
      webFails && prompt.includes('the component "src/web"')
        ? new Error("upstream reset")
        : { content: "Text." },
    );
    const first = await updatePages(c.env, LEGACY_AI_SNAPSHOT.models, c.source, SLUGS, new Set());
    expect(first).toMatchObject({ written: 4, failed: 1 });
    expect(first.errors).toEqual(["components/src-web: upstream reset"]);
    expect(c.pages().map(([slug]) => slug)).toEqual(SLUGS.filter((s) => !s.endsWith("web")).sort());

    // The next attempt only writes what is missing.
    webFails = false;
    const asked = c.calls.length;
    const plan = await planWiki(c.env, c.source);
    expect(plan.pending).toEqual(["components/src-web"]);
    expect(
      await updatePages(c.env, LEGACY_AI_SNAPSHOT.models, c.source, plan.pending, new Set()),
    ).toMatchObject({
      written: 1,
      failed: 0,
    });
    expect(c.calls.length).toBe(asked + 1);
  });

  test("front pages recover when the model exhausts its response without content", async () => {
    let first = true;
    const c = await setup(() => {
      const result = first ? { content: null, finish: "length" } : { content: "Plain." };
      first = false;
      return result;
    });
    const stats = await updatePages(
      c.env,
      LEGACY_AI_SNAPSHOT.models,
      c.source,
      ["overview"],
      new Set(),
    );
    expect(stats).toMatchObject({ written: 1, failed: 0 });
    expect(c.pages()).toEqual([["overview", "Plain."]]);
  });

  test("resumes missed wiki inputs after a disabled build and an unrelated push", async () => {
    const decisions: unknown[] = [];
    let body = "The web component serves requests.";
    const c = await setup(
      () => ({ content: body }),
      (state) => {
        decisions.push(state);
        return JSON.stringify(state).includes("Refunds require manager approval") ? 0.9 : 0;
      },
    );
    await applyGraph(c.env.DB, "repo", "b1", "c1", c.source.graph);
    await updatePages(c.env, LEGACY_AI_SNAPSHOT.models, c.source, SLUGS, new Set());
    const original = c.pages();

    // A wiki-disabled build still publishes the changed graph, but leaves
    // the last written pages and their input hashes readable.
    c.source.analyses.set("web0", analysis());
    c.source.analyses.get("web0")!.summary = "Refunds require manager approval.";
    c.source.graph = buildGraph("org/app", c.source.files, c.source.analyses, c.source.syntheses);
    await applyGraph(c.env.DB, "repo", "b2", "c2", c.source.graph);
    expect(c.pages()).toEqual(original);

    // The next ordinary push after re-enable changes only the CLI. Its
    // change feed no longer contains the missed web update.
    c.source.analyses.get("cli0")!.summary = "Prints command usage.";
    c.source.graph = buildGraph("org/app", c.source.files, c.source.analyses, c.source.syntheses);
    c.source.commit = "c3";
    const diff = await applyGraph(c.env.DB, "repo", "b3", "c3", c.source.graph);
    const changed = new Set([...diff.added, ...diff.changed, ...diff.removed]);
    expect(changed.has("file:src/web/f0.ts")).toBe(false);
    body = "Refunds require manager approval.";
    const plan = await planWiki(c.env, c.source);
    expect(plan.pending).toContain("components/src-web");
    const stats = await updatePages(
      c.env,
      LEGACY_AI_SNAPSHOT.models,
      c.source,
      plan.pending,
      changed,
    );
    expect(stats.failed).toBe(0);
    expect(c.pages()).toContainEqual(["components/src-web", body]);
    expect(c.pages()).toContainEqual(["components/src-cli", "The web component serves requests."]);

    // Input hashes still make an unchanged successor entirely free.
    const calls = c.calls.length;
    const judgments = decisions.length;
    expect(await planWiki(c.env, c.source)).toEqual({ pending: [], unchanged: 5, removed: 0 });
    expect(
      await updatePages(c.env, LEGACY_AI_SNAPSHOT.models, c.source, SLUGS, new Set()),
    ).toMatchObject({ unchanged: 5, written: 0, kept: 0 });
    expect(c.calls.length).toBe(calls);
    expect(decisions.length).toBe(judgments);
  });

  test("pages the graph no longer plans are removed", async () => {
    const c = await setup(() => ({ content: "Text." }));
    await updatePages(c.env, LEGACY_AI_SNAPSHOT.models, c.source, SLUGS, new Set());
    c.sqlite.exec(`
      INSERT INTO wiki_pages (repo_id, slug, title, section, position, body, inputs_hash, generated_in)
        VALUES ('repo', 'components/gone', 'Gone', 'src', 99, 'Old.', 'h', 'c0');
    `);
    expect(await planWiki(c.env, c.source)).toEqual({ pending: [], unchanged: 5, removed: 1 });
    expect(c.pages().map(([slug]) => slug)).toEqual([...SLUGS].sort());
  });
});
