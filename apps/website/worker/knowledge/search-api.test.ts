import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { KnowledgeSearchResults } from "../../shared/api.ts";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { knowledge } from "./api.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkflowEntrypoint: class {},
}));

const ann: Actor = { id: "ann", slug: "ann", displayName: "Ann", isSiteAdmin: false };
const ben: Actor = { id: "ben", slug: "ben", displayName: "Ben", isSiteAdmin: false };

afterEach(() => vi.restoreAllMocks());

/** A repository with one indexed entity and passage; providers can be told to fail. */
function setup({ ai = true } = {}) {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('ann', 'user', 'ann', 'Ann'), ('ben', 'user', 'ben', 'Ben');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('r1', 'ann', 'engine', 'private', 'art-r1', '');
    INSERT INTO kg_nodes (repo_id, id, kind, name, path, summary, content_hash, changed_in)
      VALUES ('r1', 'sym:throttle.ts#throttle', 'symbol', 'throttle', 'throttle.ts', 'Limits starts', 'h', 'c1');
  `);
  const failing = new Set<"entities" | "passages">();
  const vectorQueries: unknown[] = [];
  const searches: unknown[] = [];
  // Searching must never reach the build coordinator.
  const untouchable = new Proxy(
    {},
    {
      get(_, key) {
        throw new Error(`search touched a build binding: ${String(key)}`);
      },
    },
  );
  const env = {
    DB: d1(sqlite),
    AI: ai
      ? {
          run: async () => {
            if (failing.has("entities")) throw new Error("embedding failed");
            return { data: [[0.1, 0.2]] };
          },
        }
      : undefined,
    VECTORS: {
      query: async (_vector: number[], options: unknown) => {
        vectorQueries.push(options);
        return {
          matches: [{ id: "v1", score: 0.9, metadata: { node: "sym:throttle.ts#throttle" } }],
        };
      },
    },
    SEARCH: {
      get: () => ({
        search: async (request: unknown) => {
          searches.push(request);
          if (failing.has("passages")) throw new Error("AI Search unavailable");
          return {
            chunks: [
              {
                id: "c1",
                type: "text",
                score: 0.9,
                text: "export function throttle()",
                item: { key: "file:throttle.ts", metadata: { kind: "code", path: "throttle.ts" } },
                scoring_details: { reranking_score: 0.9, vector_score: 0.6 },
              },
            ],
          };
        },
      }),
    },
    KNOWLEDGE: untouchable,
    KNOWLEDGE_QUEUE: untouchable,
  } as unknown as Env;
  let actor: Actor | null = ann;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/api/repos/:owner/:name/knowledge", knowledge);
  const call = (q: string) =>
    app.request(`/api/repos/ann/engine/knowledge/search?q=${encodeURIComponent(q)}`, {}, env);
  return {
    sqlite,
    failing,
    vectorQueries,
    searches,
    as: (next: Actor | null) => {
      actor = next;
    },
    call,
    search: async (q: string) => {
      const response = await call(q);
      expect(response.status).toBe(200);
      return (await response.json()) as KnowledgeSearchResults;
    },
  };
}

describe("knowledge search status", () => {
  test("reports a built index and both providers answering", async () => {
    const s = setup();
    s.sqlite.exec(`INSERT INTO kg_state (repo_id, indexed_commit) VALUES ('r1', 'c1')`);
    const result = await s.search("throttle");
    expect(result.providers).toEqual({ entities: "ok", passages: "ok" });
    expect(result.index).toEqual({ state: "ready", indexedCommit: "c1" });
    expect(result.entities.map((e) => e.id)).toEqual(["sym:throttle.ts#throttle"]);
    expect(result.passages.map((p) => [p.kind, p.path])).toEqual([["code", "throttle.ts"]]);
    // Both lookups stay inside this repository.
    expect(s.vectorQueries).toEqual([expect.objectContaining({ filter: { repo: "r1" } })]);
    expect(s.searches).toEqual([
      expect.objectContaining({
        ai_search_options: expect.objectContaining({
          retrieval: expect.objectContaining({ filters: { repo: "r1" } }),
        }),
      }),
    ]);
  });

  test("tells a failed provider apart from no matches, keeping the other's results", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = setup();
    s.sqlite.exec(`INSERT INTO kg_state (repo_id, indexed_commit) VALUES ('r1', 'c1')`);
    s.failing.add("passages");
    const passagesDown = await s.search("throttle");
    expect(passagesDown.providers).toEqual({ entities: "ok", passages: "failed" });
    expect(passagesDown.entities).toHaveLength(1);
    expect(passagesDown.passages).toEqual([]);
    s.failing.add("entities");
    expect((await s.search("throttle")).providers).toEqual({
      entities: "failed",
      passages: "failed",
    });
  });

  test("says when nothing is indexed yet, or a build is running, without starting one", async () => {
    const s = setup();
    expect((await s.search("throttle")).index).toEqual({ state: "none", indexedCommit: null });
    s.sqlite.exec(`
      INSERT INTO kg_state (repo_id, indexed_commit) VALUES ('r1', 'c1');
      INSERT INTO kg_builds (id, repo_id, to_commit, status) VALUES ('b2', 'r1', 'c2', 'running');
    `);
    expect((await s.search("throttle")).index).toEqual({ state: "building", indexedCommit: "c1" });
  });

  test("is off without AI, and closed to people who can't read the repository", async () => {
    expect((await setup({ ai: false }).call("throttle")).status).toBe(503);
    const s = setup();
    s.as(ben);
    expect((await s.call("throttle")).status).toBe(404);
    expect(s.searches).toEqual([]);
    expect(s.vectorQueries).toEqual([]);
  });
});
