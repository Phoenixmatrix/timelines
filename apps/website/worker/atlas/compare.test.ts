// Main snapshot comparisons (CORE-175) against real D1 projections of the
// Atlas fixture, through the Atlas API and its browser client: source,
// regrouping and summary-only changes kept apart, complete paging, capability
// filtering, and comparisons that are unavailable (never empty) once a side
// leaves retention. Every model, index and build binding fails if touched.

import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type {
  AtlasChange,
  AtlasComparison,
  AtlasError,
  AtlasSnapshotList,
} from "../../shared/atlas.ts";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { atlasApi, atlasErrorOf } from "../../src/lib/atlas.ts";
import { caveatText, describeChange, unavailableText } from "../../src/routes/repo/atlasCompare.ts";
import { atlas } from "./api.ts";
import { expireAtlasPriors, publishAtlasFixture, writeAtlasFixtureGraph } from "./fixture.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkflowEntrypoint: class {},
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ann: Actor = { id: "ann", slug: "ann", displayName: "Ann", isSiteAdmin: false };
const ben: Actor = { id: "ben", slug: "ben", displayName: "Ben", isSiteAdmin: false };
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const C3 = "3".repeat(40);

function forbidden(name: string, touched: string[]) {
  return new Proxy(
    {},
    {
      get(_, key) {
        touched.push(`${name}.${String(key)}`);
        throw new Error(`An Atlas comparison touched ${name}.${String(key)}`);
      },
    },
  );
}

function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('ann', 'user', 'ann', 'Ann'), ('ben', 'user', 'ben', 'Ben');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('r1', 'ann', 'shop', 'private', 'art-r1', '');
  `);
  const touched: string[] = [];
  const env = {
    DB: d1(sqlite),
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    AI: forbidden("AI", touched),
    VECTORS: forbidden("VECTORS", touched),
    SEARCH: forbidden("SEARCH", touched),
    KNOWLEDGE: forbidden("KNOWLEDGE", touched),
    KNOWLEDGE_QUEUE: forbidden("KNOWLEDGE_QUEUE", touched),
    KNOWLEDGE_BUILD: forbidden("KNOWLEDGE_BUILD", touched),
  } as unknown as Env;
  let actor: Actor | null = ann;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/api/repos/:owner/:name/atlas", atlas);
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) =>
    app.request(String(input), init ?? {}, env),
  );
  const call = (path: string) => app.request(`/api/repos/ann/shop/atlas/${path}`, {}, env);
  return {
    sqlite,
    env,
    touched,
    call,
    as: (next: Actor | null) => {
      actor = next;
    },
  };
}

const repo = { owner: "ann", name: "shop" };

/** Three builds: the base, the same code with prose that ran out of budget, then operations merged into search. */
async function threeBuilds(s: ReturnType<typeof setup>) {
  await writeAtlasFixtureGraph(s.env.DB, "r1", "shop", C1);
  const base = await publishAtlasFixture(s.env, "r1", C1);
  const reworded = await publishAtlasFixture(s.env, "r1", C1, { unavailable: "budget_exhausted" });
  await writeAtlasFixtureGraph(s.env.DB, "r1", "shop", C2, "merged");
  const merged = await publishAtlasFixture(s.env, "r1", C2, { unavailable: "budget_exhausted" });
  return { base, reworded, merged };
}

/** Every record of a comparison, a page at a time. */
async function all(
  from: string,
  to: string,
  options: { class?: AtlasComparison["class"]; within?: string; limit?: number } = {},
) {
  const pages: AtlasComparison[] = [];
  let cursor: string | null = null;
  do {
    const page: AtlasComparison = await atlasApi.compare(repo, from, to, { ...options, cursor });
    pages.push(page);
    cursor = page.next;
  } while (cursor);
  return { pages, items: pages.flatMap((p) => p.items), first: pages[0]! };
}

const byId = (items: AtlasChange[]) => new Map(items.map((c) => [c.id, c]));

describe("Atlas snapshot comparisons", () => {
  test("the same code reworded is summary-only: no source changes, no regrouping", async () => {
    const s = setup();
    const { base, reworded } = await threeBuilds(s);
    const { first, items } = await all(base.snapshotId, reworded.snapshotId);

    expect(first.from.snapshot.id).toBe(base.snapshotId);
    expect(first.to.snapshot.id).toBe(reworded.snapshotId);
    expect(first.snapshot.id).toBe(reworded.snapshotId);
    expect(first.caveats.map((c) => c.code)).toEqual(["same-commit", "relations"]);
    expect(first.summary).toMatchObject({
      classes: { source: 0, regrouping: 0 },
      files: { added: 0, removed: 0, modified: 0 },
    });
    expect(items.length).toBeGreaterThan(0);
    for (const change of items) {
      expect(change.kind, change.id).toBe("capability");
      expect(change.presence).toBe("changed");
      expect(change.classes).toEqual(["summary"]);
      expect(change.fields).toContain("description");
      expect(change.members).toEqual({ movedIn: 0, movedOut: 0, added: 0, removed: 0 });
      expect(change.from?.summaryState).toEqual({ status: "unavailable", reason: "disabled" });
      expect(change.to?.summaryState).toEqual({
        status: "unavailable",
        reason: "budget_exhausted",
      });
    }
    expect(first.summary?.classes.summary).toBe(items.length);
    // In words: only the description, and how its state changed.
    expect(describeChange(items[0]!)).toEqual([
      "Only its description changed: the same members, from the same source.",
      "Description: unavailable (paid synthesis off) → unavailable (budget used up).",
    ]);
    expect(first.caveats.map(caveatText)[0]).toMatch(/same commit: nothing in the code changed/);
    expect(s.touched).toEqual([]);
  });

  test("a merge separates source changes from regrouping, with lineage and names", async () => {
    const s = setup();
    const { reworded, merged } = await threeBuilds(s);
    const { first, items } = await all(reworded.snapshotId, merged.snapshotId);
    const changes = byId(items);

    // Operations' capability was retired into search's.
    const ops = items.find((c) => c.kind === "capability" && c.presence === "removed");
    expect(ops).toBeDefined();
    expect(ops!.classes).toContain("regrouping");
    expect(ops!.retired?.change).toBe("merged");
    expect(ops!.retired?.seq).toBe(merged.seq);
    const successor = ops!.retired!.successors[0]!;
    expect(successor.name).toBeTruthy();

    // Its files changed source (their imports) and moved into the successor.
    for (const path of ["ops/deploy.ts", "ops/health.ts", "ops/logs.ts"]) {
      const file = changes.get(`file:${path}`)!;
      expect(file.presence, path).toBe("changed");
      expect(file.classes, path).toEqual(["source", "regrouping"]);
      expect(file.from?.blob).not.toBe(file.to?.blob);
      expect(file.from?.capability).toBe(ops!.id);
      expect(file.to?.capability).toBe(successor.id);
      expect(file.names[ops!.id]).toBe(ops!.from?.name);
      expect(file.names[successor.id]).toBe(successor.name);
    }
    // The successor kept its id and took them in: regrouping, not new.
    const search = changes.get(successor.id);
    expect(search?.presence).toBe("changed");
    expect(search?.classes).toContain("regrouping");
    expect(search?.members).toMatchObject({ movedIn: 3, movedOut: 0, added: 0, removed: 0 });

    // In words, as the panel shows them.
    expect(describeChange(ops!)).toEqual([
      `Merged into “${successor.name}” (all of its files), in build #${merged.seq}.`,
      "Members: 3 files moved out.",
    ]);
    const deploy = changes.get("file:ops/deploy.ts")!;
    expect(describeChange(deploy)).toEqual([
      `Its source changed (blob ${deploy.from!.blob!.slice(0, 7)} → ${deploy.to!.blob!.slice(0, 7)}).`,
      `Moved from ${ops!.from!.name} to ${successor.name}.`,
    ]);
    expect(describeChange(search!)).toEqual(["Members: 3 files moved in."]);

    // Billing's code didn't change: nothing of it is a source change.
    for (const change of items)
      if (change.id.startsWith("file:billing/")) expect(change.classes).not.toContain("source");
    expect(first.summary?.files).toEqual({ added: 0, removed: 0, modified: 3 });
    expect(first.caveats.map((c) => c.code)).toEqual(["relations"]);

    // A class filter pages exactly what the summary counts.
    for (const cls of ["source", "regrouping", "summary", "other"] as const) {
      const only = await all(reworded.snapshotId, merged.snapshotId, { class: cls, limit: 2 });
      expect(
        only.items.every((c) => c.classes.includes(cls)),
        cls,
      ).toBe(true);
      expect(only.items.length, cls).toBe(first.summary!.classes[cls]);
      expect(only.first.counts.knownTotal, cls).toBe(first.summary!.classes[cls]);
    }

    // Within the successor: the capability, and the files that moved in.
    const within = await all(reworded.snapshotId, merged.snapshotId, { within: successor.id });
    expect(within.first.within?.id).toBe(successor.id);
    expect(within.first.summary?.others).toBeNull();
    const ids = within.items.map((c) => c.id);
    expect(ids).toContain(successor.id);
    for (const path of ["ops/deploy.ts", "ops/health.ts", "ops/logs.ts"])
      expect(ids).toContain(`file:${path}`);
    expect(ids.some((id) => id.startsWith("file:billing/"))).toBe(false);
    // Within the retired capability too, from the older side.
    const old = await all(reworded.snapshotId, merged.snapshotId, { within: ops!.id });
    expect(old.first.within?.id).toBe(ops!.id);
    expect(old.items.map((c) => c.id)).toContain("file:ops/deploy.ts");
    expect(s.touched).toEqual([]);
  });

  test("pages traverse every record once, in a stable order, with the summary on the first", async () => {
    const s = setup();
    const { base, merged } = await threeBuilds(s);
    const whole = await all(base.snapshotId, merged.snapshotId, { limit: 100 });
    const paged = await all(base.snapshotId, merged.snapshotId, { limit: 3 });
    expect(paged.pages.length).toBeGreaterThan(2);
    expect(paged.items.map((c) => c.id)).toEqual(whole.items.map((c) => c.id));
    expect(new Set(paged.items.map((c) => c.id)).size).toBe(paged.items.length);
    expect(paged.pages.slice(1).every((p) => p.summary === null)).toBe(true);
    expect(paged.pages.at(-1)!.counts).toMatchObject({
      loaded: whole.items.length,
      knownTotal: whole.first.summary!.total,
    });
    // Capabilities, then areas, then files.
    const ranks = paged.items.map((c) => ["capability", "area", "file"].indexOf(c.kind));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    // Two builds apart: lineage is build to build, and it says so.
    expect(whole.first.caveats).toContainEqual({ code: "between", builds: 1 });
    // A third request reads the same answer.
    const again = await all(base.snapshotId, merged.snapshotId, { limit: 100 });
    expect(again.items).toEqual(whole.items);
  });

  test("a source edit with nothing regrouped is a source change only", async () => {
    const s = setup();
    await writeAtlasFixtureGraph(s.env.DB, "r1", "shop", C1);
    const before = await publishAtlasFixture(s.env, "r1", C1);
    s.sqlite
      .prepare(
        `UPDATE kg_nodes SET data = json_set(data, '$.blob', ?) WHERE repo_id = 'r1' AND id = ?`,
      )
      .run("f".repeat(40), "file:misc/notes.ts");
    const after = await publishAtlasFixture(s.env, "r1", C3);
    const { first, items } = await all(before.snapshotId, after.snapshotId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "file:misc/notes.ts",
      presence: "changed",
      classes: ["source"],
      fields: ["source"],
    });
    expect(items[0]!.to?.blob).toBe("f".repeat(40));
    expect(first.summary).toMatchObject({
      total: 1,
      classes: { source: 1, regrouping: 0, summary: 0, other: 0 },
      files: { added: 0, removed: 0, modified: 1 },
    });
  });

  test("outside retention a comparison is unavailable, never empty", async () => {
    const s = setup();
    const { base, reworded, merged } = await threeBuilds(s);
    const listed = (await atlasApi.snapshots(repo)) satisfies AtlasSnapshotList;
    expect(listed.current).toBe(merged.snapshotId);
    expect(listed.items.map((i) => [i.id, i.state])).toEqual([
      [merged.snapshotId, "current"],
      [reworded.snapshotId, "retained"],
      [base.snapshotId, "retained"],
    ]);
    const firstPage = await atlasApi.compare(repo, base.snapshotId, merged.snapshotId, {
      limit: 2,
    });
    expect(firstPage.next).not.toBeNull();

    await expireAtlasPriors(s.env.DB, "r1");
    const expired = await atlasApi
      .compare(repo, base.snapshotId, merged.snapshotId)
      .then(() => null, atlasErrorOf);
    expect(expired).toMatchObject({
      code: "snapshot_expired",
      side: "from",
      current: { id: merged.snapshotId },
    });
    expect(expired?.error).toMatch(/unavailable/);
    expect(unavailableText(expired!)).toMatch(
      /^Comparison unavailable\. The older snapshot has expired because newer builds pushed it past the 20 prior snapshots kept, and a comparison needs both\. That doesn't mean nothing changed\.$/,
    );
    // A cursor issued before the expiry stops too.
    const continued = await atlasApi
      .compare(repo, base.snapshotId, merged.snapshotId, { cursor: firstPage.next })
      .then(() => null, atlasErrorOf);
    expect(continued).toMatchObject({ code: "snapshot_expired", side: "from" });
    // The newer side expiring names that side.
    const newer = await s.call(`compare?from=${base.snapshotId}&to=${reworded.snapshotId}`);
    expect(newer.status).toBe(410);
    expect(((await newer.json()) as AtlasError).side).toBe("to");
    const after = await atlasApi.snapshots(repo);
    expect(after.items.map((i) => i.state)).toEqual(["current", "expired", "expired"]);
    expect(after.items[1]?.expiredReason).toBe("count");
  });

  test("requests are checked: order, names, classes, cursors and who is asking", async () => {
    const s = setup();
    const { base, reworded, merged } = await threeBuilds(s);
    const status = async (path: string) => {
      const response = await s.call(path);
      return [response.status, ((await response.json()) as AtlasError).code] as const;
    };
    expect(await status(`compare?from=${merged.snapshotId}&to=${base.snapshotId}`)).toEqual([
      400,
      "bad_request",
    ]);
    expect(await status(`compare?from=${base.snapshotId}&to=${base.snapshotId}`)).toEqual([
      400,
      "bad_request",
    ]);
    expect(await status(`compare?to=${merged.snapshotId}`)).toEqual([400, "bad_request"]);
    expect(await status(`compare?from=nope&to=${merged.snapshotId}`)).toEqual([
      404,
      "snapshot_unknown",
    ]);
    expect(await status(`compare?from=${base.snapshotId}&to=nope`)).toEqual([
      404,
      "snapshot_unknown",
    ]);
    expect(
      await status(`compare?from=${base.snapshotId}&to=${merged.snapshotId}&class=vibes`),
    ).toEqual([400, "bad_request"]);
    expect(
      await status(
        `compare?from=${base.snapshotId}&to=${merged.snapshotId}&within=file%3Aops%2Fdeploy.ts`,
      ),
    ).toEqual([400, "bad_request"]);
    expect(
      await status(`compare?from=${base.snapshotId}&to=${merged.snapshotId}&within=cap%3Anope`),
    ).toEqual([404, "entity_unknown"]);

    // A cursor is bound to its from, class and filter.
    const page = await atlasApi.compare(repo, base.snapshotId, merged.snapshotId, { limit: 1 });
    const cursor = encodeURIComponent(page.next ?? "");
    for (const path of [
      `compare?from=${reworded.snapshotId}&to=${merged.snapshotId}&cursor=${cursor}`,
      `compare?from=${base.snapshotId}&to=${merged.snapshotId}&class=source&cursor=${cursor}`,
    ])
      expect(await status(path), path).toEqual([400, "cursor_invalid"]);

    // Someone who can't read the repository sees it missing, whatever they ask.
    s.as(ben);
    const missing = await s.call("overview");
    const missingBody = await missing.text();
    for (const path of [
      `compare?from=${base.snapshotId}&to=${merged.snapshotId}`,
      `compare?from=${base.snapshotId}&to=${merged.snapshotId}&cursor=${cursor}`,
      "compare",
      "snapshots",
    ]) {
      const response = await s.call(path);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).toBe(missingBody);
    }
    // Nor can another person replay the owner's cursor.
    s.as(null);
    expect((await s.call(`snapshots`)).status).toBe(404);
  });
});
