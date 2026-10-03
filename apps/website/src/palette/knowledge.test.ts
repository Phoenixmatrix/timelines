import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { KnowledgeSearchResults } from "../../shared/api.ts";
import type { Viewer } from "../../shared/api.ts";
import { COMMAND_SOURCES, type PaletteContext } from "./commands.ts";
import { knowledgeResults, knowledgeSearch, type KnowledgeState } from "./knowledge.ts";

const repo = { owner: "orbit", name: "engine", defaultBranch: "main" };
const results = (over: Partial<KnowledgeSearchResults> = {}): KnowledgeSearchResults => ({
  query: "throttle",
  entities: [
    {
      id: "sym:throttle.ts#throttle",
      kind: "symbol",
      name: "throttle",
      path: "throttle.ts",
      summary: "",
      score: 0.9,
    },
  ],
  passages: [
    { kind: "code", path: "src/throttle.ts", text: "export function throttle()", score: 0.8 },
    { kind: "wiki", path: "components/engine", text: "The engine throttles starts.", score: 0.7 },
  ],
  providers: { entities: "ok", passages: "ok" },
  index: { state: "ready", indexedCommit: "c1" },
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("code and wiki results", () => {
  test("are grouped and lead to the entity, the file at the default branch, and the wiki page", () => {
    const { groups, notes } = knowledgeResults(repo, results());
    expect(groups.map((g) => [g.label, g.options.map((o) => o.to)])).toEqual([
      ["Entities", ["/orbit/engine/knowledge?node=sym%3Athrottle.ts%23throttle"]],
      ["Code", ["/orbit/engine/blob/main/src/throttle.ts"]],
      ["Wiki", ["/orbit/engine/wiki/components/engine"]],
    ]);
    expect(notes).toEqual([]);
  });

  test("tell no matches apart from a failed lookup or an index that isn't there yet", () => {
    const none = { entities: [], passages: [] };
    expect(knowledgeResults(repo, results(none)).notes).toEqual([
      "Nothing matches. Try a name, or describe the behavior.",
    ]);
    expect(
      knowledgeResults(
        repo,
        results({ ...none, providers: { entities: "ok", passages: "failed" } }),
      ).notes,
    ).toEqual(["Couldn't search code and wiki passages right now."]);
    expect(
      knowledgeResults(repo, results({ ...none, index: { state: "none", indexedCommit: null } }))
        .notes[0],
    ).toMatch(/isn't indexed yet/);
    expect(
      knowledgeResults(repo, results({ index: { state: "building", indexedCommit: "c1" } }))
        .notes[0],
    ).toMatch(/Indexing is running/);
  });
});

describe("code and wiki search", () => {
  test("runs only on submit, and a superseded answer never lands", async () => {
    const pending: ((body: unknown) => void)[] = [];
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        urls.push(url);
        return new Promise((resolve) =>
          pending.push((body) => resolve(new Response(JSON.stringify(body), { status: 200 }))),
        );
      }),
    );
    const states: KnowledgeState[] = [];
    const search = knowledgeSearch((state) => states.push(state));
    search.submit(repo, "throttle");
    search.submit({ ...repo, name: "website" }, "throttle");
    expect(urls).toEqual([
      "/api/repos/orbit/engine/knowledge/search?q=throttle",
      "/api/repos/orbit/website/knowledge/search?q=throttle",
    ]);
    pending[1]!(results());
    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({ status: "done", repo: "orbit/website" }),
    );
    pending[0]!(results());
    await new Promise((r) => setTimeout(r, 10));
    expect(
      states.filter((s) => s.status === "done").map((s) => s.status === "done" && s.repo),
    ).toEqual(["orbit/website"]);
    search.reset();
    expect(states.at(-1)).toEqual({ status: "idle" });
  });

  test("says when AI is off or the repository can't be read", async () => {
    for (const [status, message] of [
      [503, /off on this server/],
      [404, /can't search this repository/],
    ] as const) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ error: "x" }), { status })),
      );
      const states: KnowledgeState[] = [];
      knowledgeSearch((state) => states.push(state)).submit(repo, "throttle");
      await vi.waitFor(() => expect(states.at(-1)?.status).toBe("failed"));
      expect(states.at(-1)).toMatchObject({ message: expect.stringMatching(message) });
    }
  });
});

describe("code and wiki commands", () => {
  const viewer = { id: "ann", slug: "ann", displayName: "Ann", isSiteAdmin: false } as Viewer;
  const commands = (context: Partial<PaletteContext>) =>
    COMMAND_SOURCES.flatMap((source) =>
      source({ viewer, pathname: "/", repo: null, trackers: null, query: "", ...context }),
    ).filter((c) => c.id.startsWith("knowledge"));

  test("scope to the current repository, or ask for one; never for signed-out viewers", () => {
    expect(commands({ viewer: null })).toEqual([]);
    expect(commands({}).map((c) => c.run)).toEqual([{ kind: "scope", scope: { kind: "pick" } }]);
    const here = commands({
      repo: { owner: { slug: "orbit" }, name: "engine", defaultBranch: "main" } as never,
    });
    expect(here.map((c) => c.run)).toEqual([
      {
        kind: "scope",
        scope: { kind: "repo", owner: "orbit", name: "engine", defaultBranch: "main" },
      },
    ]);
  });
});
