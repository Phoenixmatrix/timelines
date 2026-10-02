import { describe, expect, test } from "vite-plus/test";
import type { RepoReader } from "../objects.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import type { FileAnalysis } from "./analyze.ts";
import { buildGraph } from "./graph.ts";
import { planWiki, updatePages, type WikiSource } from "./wiki.ts";

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
  think: boolean;
  prompt: string;
}

/** A repository of two components, a fake model, and the database the wiki lives in. */
function setup(reply: (call: Call) => { content: string | null; finish?: string } | Error) {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('acc', 'org', 'org', 'Org');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
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
        messages: { content: string }[];
        chat_template_kwargs: { enable_thinking: boolean };
      },
    ) {
      const call = {
        think: inputs.chat_template_kwargs.enable_thinking,
        prompt: inputs.messages[1]?.content ?? "",
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
  const env = { DB: d1(sqlite), AI } as unknown as Env;
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
    const c = setup(() => ({ content: "Text." }));
    expect(await planWiki(c.env, c.source)).toEqual({ pending: SLUGS, unchanged: 0, removed: 0 });
  });

  test("saves each page as it is written, so a failed page doesn't cost the others", async () => {
    let webFails = true;
    const c = setup(({ prompt }) =>
      webFails && prompt.includes('the component "src/web"')
        ? new Error("upstream reset")
        : { content: "Text." },
    );
    const first = await updatePages(c.env, c.source, SLUGS, new Set());
    expect(first).toMatchObject({ written: 4, failed: 1 });
    expect(first.errors).toEqual(["components/src-web: upstream reset"]);
    expect(c.pages().map(([slug]) => slug)).toEqual(SLUGS.filter((s) => !s.endsWith("web")).sort());

    // The next attempt only writes what is missing.
    webFails = false;
    const asked = c.calls.length;
    const plan = await planWiki(c.env, c.source);
    expect(plan.pending).toEqual(["components/src-web"]);
    expect(await updatePages(c.env, c.source, plan.pending, new Set())).toMatchObject({
      written: 1,
      failed: 0,
    });
    expect(c.calls.length).toBe(asked + 1);
  });

  test("front pages that think themselves out of room are written without thinking", async () => {
    const c = setup(({ think }) =>
      think ? { content: null, finish: "length" } : { content: "Plain." },
    );
    const stats = await updatePages(c.env, c.source, ["overview"], new Set());
    expect(stats).toMatchObject({ written: 1, failed: 0 });
    expect(c.calls.map((call) => call.think)).toEqual([true, false]);
    expect(c.pages()).toEqual([["overview", "Plain."]]);
  });

  test("pages the graph no longer plans are removed", async () => {
    const c = setup(() => ({ content: "Text." }));
    await updatePages(c.env, c.source, SLUGS, new Set());
    c.sqlite.exec(`
      INSERT INTO wiki_pages (repo_id, slug, title, section, position, body, inputs_hash, generated_in)
        VALUES ('repo', 'components/gone', 'Gone', 'src', 99, 'Old.', 'h', 'c0');
    `);
    expect(await planWiki(c.env, c.source)).toEqual({ pending: [], unchanged: 5, removed: 1 });
    expect(c.pages().map(([slug]) => slug)).toEqual([...SLUGS].sort());
  });
});
