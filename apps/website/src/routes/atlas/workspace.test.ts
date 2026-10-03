import { describe, expect, test } from "vite-plus/test";
import type {
  AtlasEntitySummary,
  AtlasRegion,
  AtlasWorkspaceComposition,
  AtlasWorkspaceOverview,
  AtlasWorkspacePage,
  AtlasWorkspaceRepo,
} from "../../../shared/atlas.ts";
import { ApiError } from "../../lib/api.ts";
import type { AtlasWorkspace } from "../../lib/atlas.ts";
import {
  buildWorkspaceTerritory,
  coverageOf,
  parseSelection,
  toggleSelection,
  WorkspaceSession,
  type WorkspaceClient,
  type WorkspaceState,
  type WorkspaceTerritory,
} from "./workspace.ts";

const repo = (
  id: string,
  name: string,
  state: AtlasWorkspaceRepo["state"] = "ready",
): AtlasWorkspaceRepo => ({
  id,
  owner: "acme",
  name,
  visibility: "public",
  state,
  building: false,
  snapshot:
    state === "ready"
      ? {
          id: `snap-${id}`,
          seq: 2,
          vector: [{ repoId: id, commit: `${id}c0ffee`, buildId: `b-${id}` }],
          publishedAt: "2026-10-01T00:00:00.000Z",
          partial: false,
          projectionVersion: 3,
          expiresAt: null,
        }
      : null,
});

/** A capability of `repoId` in `slot`: two repositories use the same slots on purpose. */
const cap = (repoId: string, local: string, slot: number, files = 10): AtlasRegion => ({
  id: `${repoId}/${local}`,
  repoId,
  kind: "capability",
  parentId: `${repoId}/repo`,
  name: local,
  path: null,
  summary: "",
  counts: { files },
  structural: false,
  since: 1,
  layout: { slot, col: slot % 4, row: Math.floor(slot / 4), bucket: 4, fill: 0.58 },
  size: { files, members: files },
  summaryTruncated: false,
});
const group = (repoId: string, local: string): AtlasRegion => ({
  ...cap(repoId, local, 0, 3),
  kind: "group",
  structural: true,
  layout: undefined,
});
const file = (repoId: string, local: string): AtlasEntitySummary => ({
  id: `${repoId}/${local}`,
  repoId,
  kind: "file",
  parentId: null,
  name: local,
  path: local,
  summary: "",
  counts: {},
  structural: false,
});

const A = repo("r1", "api");
const B = repo("r2", "web");
const C = repo("r3", "docs");
const regionsOf = {
  r1: [
    cap("r1", "cap:auth", 0, 40),
    cap("r1", "cap:billing", 1),
    group("r1", "group:unclassified"),
  ],
  r2: [cap("r2", "cap:ui", 0, 30), cap("r2", "cap:forms", 1), cap("r2", "cap:theme", 5)],
  r3: [cap("r3", "cap:guides", 0), cap("r3", "cap:api-docs", 2)],
};
const allRegions = [...regionsOf.r1, ...regionsOf.r2, ...regionsOf.r3];

const rect = (t: WorkspaceTerritory, id: string) => {
  const c = t.byId.get(id);
  if (!c) throw new Error(`no cell ${id}`);
  return { x: c.x, y: c.y, w: c.w, h: c.h };
};
const overlaps = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const layout = (selection: string[], repos: AtlasWorkspaceRepo[], expanded = new Map()) =>
  buildWorkspaceTerritory(coverageOf(selection, repos), allRegions, expanded);

describe("selection", () => {
  test("keeps selection order, drops duplicates, other owners and junk", () => {
    expect(parseSelection("web, api,acme/docs,web,other/x,,a/b/c,..,../x", "acme")).toEqual([
      "web",
      "api",
      "docs",
    ]);
    expect(parseSelection(null, "acme")).toEqual([]);
  });

  test("toggling appends at the end or removes in place", () => {
    expect(toggleSelection(["api", "web"], "docs")).toEqual(["api", "web", "docs"]);
    expect(toggleSelection(["api", "web", "docs"], "web")).toEqual(["api", "docs"]);
  });

  test("coverage lists every selected name, readable or not, and never a common head", () => {
    const coverage = coverageOf(
      ["api", "secret", "web", "docs"],
      [A, repo("r2", "web", "not-enabled"), repo("r3", "docs", "building")],
    );
    expect(coverage.map((c) => [c.name, c.state])).toEqual([
      ["api", "ready"],
      ["secret", "denied"],
      ["web", "not-enabled"],
      ["docs", "building"],
    ]);
  });
});

describe("workspace layout", () => {
  test("repositories sharing slot numbers never overlap; each stays in its band", () => {
    const t = layout(["api", "web", "docs"], [A, B, C]);
    const top = t.cells.filter((c) => c.depth === 0);
    expect(top).toHaveLength(allRegions.length);
    for (const a of top)
      for (const b of top) if (a !== b) expect(overlaps(a, b), `${a.id} / ${b.id}`).toBe(false);
    for (const band of t.bands) {
      expect(band.repoId).not.toBeNull();
      for (const c of top.filter((cell) => cell.entity.repoId === band.repoId)) {
        expect(c.x).toBeGreaterThanOrEqual(band.x);
        expect(c.x + c.w).toBeLessThanOrEqual(band.x + band.w);
        expect(c.y + c.h).toBeLessThanOrEqual(band.y + band.h);
      }
    }
    for (let i = 1; i < t.bands.length; i++)
      expect(t.bands[i]!.x).toBeGreaterThan(t.bands[i - 1]!.x + t.bands[i - 1]!.w);
    // Bands follow selection order.
    expect(t.bands.map((b) => b.name)).toEqual(["api", "web", "docs"]);
  });

  test("adding a repository moves no region of the others", () => {
    const before = layout(["api", "web"], [A, B]);
    const after = layout(["api", "web", "docs"], [A, B, C]);
    for (const region of [...regionsOf.r1, ...regionsOf.r2])
      expect(rect(after, region.id)).toEqual(rect(before, region.id));
  });

  test("removing a repository never rearranges the others' regions", () => {
    const before = layout(["api", "web", "docs"], [A, B, C]);
    // Removing the last: nothing else moves at all.
    const withoutLast = layout(["api", "web"], [A, B]);
    for (const region of [...regionsOf.r1, ...regionsOf.r2])
      expect(rect(withoutLast, region.id)).toEqual(rect(before, region.id));
    // Removing one in the middle: bands before it stay put; the ones after it
    // shift as a whole, so every region keeps its place inside its band.
    const withoutMiddle = layout(["api", "docs"], [A, C]);
    for (const region of regionsOf.r1)
      expect(rect(withoutMiddle, region.id)).toEqual(rect(before, region.id));
    const shift =
      withoutMiddle.bands.find((b) => b.name === "docs")!.x -
      before.bands.find((b) => b.name === "docs")!.x;
    for (const region of regionsOf.r3) {
      const was = rect(before, region.id);
      expect(rect(withoutMiddle, region.id)).toEqual({ ...was, x: was.x + shift });
    }
  });

  test("another repository growing, losing access or not being ready moves nothing", () => {
    const before = layout(["api", "web", "docs"], [A, B, C]);
    // web grows a row of capabilities; docs becomes unreadable.
    const grown = [...allRegions, cap("r2", "cap:new", 9), cap("r2", "cap:more", 11)];
    const after = buildWorkspaceTerritory(
      coverageOf(["api", "web", "docs"], [A, B]),
      grown.filter((r) => r.repoId !== "r3"),
      new Map(),
    );
    for (const region of [...regionsOf.r1, ...regionsOf.r2])
      expect(rect(after, region.id)).toEqual(rect(before, region.id));
    expect(after.bands.map((b) => [b.name, b.coverage.state])).toEqual([
      ["api", "ready"],
      ["web", "ready"],
    ]);
    expect(after.cells.some((c) => c.entity.repoId === "r3")).toBe(false);
    // Access going away mid-view leaves the band where it was, empty.
    const revoked = buildWorkspaceTerritory(
      coverageOf(["docs", "api", "web"], [A, B], new Set(["docs"])),
      allRegions.filter((r) => r.repoId !== "r3"),
      new Map(),
    );
    const open = layout(["docs", "api", "web"], [C, A, B]);
    expect(revoked.bands.map((b) => [b.name, b.coverage.state])).toEqual([
      ["docs", "revoked"],
      ["api", "ready"],
      ["web", "ready"],
    ]);
    for (const region of [...regionsOf.r1, ...regionsOf.r2])
      expect(rect(revoked, region.id)).toEqual(rect(open, region.id));
    // A selected repository without an Atlas gets no band, only its coverage row.
    const notEnabled = layout(["api", "web", "docs"], [A, B, repo("r3", "docs", "not-enabled")]);
    expect(notEnabled.bands.map((b) => b.name)).toEqual(["api", "web"]);
    expect(notEnabled.cells.some((c) => c.entity.repoId === "r3")).toBe(false);
    for (const region of [...regionsOf.r1, ...regionsOf.r2])
      expect(rect(notEnabled, region.id)).toEqual(rect(before, region.id));
  });

  test("expanding a region in one repository moves nothing anywhere else", () => {
    const before = layout(["api", "web"], [A, B]);
    const after = layout(
      ["api", "web"],
      [A, B],
      new Map([["r1/cap:auth", [file("r1", "src/auth.ts"), file("r1", "src/session.ts")]]]),
    );
    for (const region of [...regionsOf.r1, ...regionsOf.r2])
      expect(rect(after, region.id)).toEqual(rect(before, region.id));
    const parent = rect(after, "r1/cap:auth");
    const child = rect(after, "r1/src/auth.ts");
    expect(child.x).toBeGreaterThanOrEqual(parent.x);
    expect(child.x + child.w).toBeLessThanOrEqual(parent.x + parent.w);
  });
});

// ---- the session -------------------------------------------------------------------

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const overview = (repos: AtlasWorkspaceRepo[], id = "ws1.tag.2.2"): AtlasWorkspaceOverview => {
  const regions = allRegions.filter((r) => repos.some((x) => x.id === r.repoId));
  const envelope = {
    scope: "ws:o:hash",
    owner: { id: "o", slug: "acme" },
    snapshot: { id, repos },
  };
  return {
    ...envelope,
    regions,
    totalRegions: regions.length,
    catalogue: {
      ...envelope,
      items: [],
      counts: { loaded: 0, knownTotal: 0, unknownTotal: false },
      next: null,
    },
  };
};
const childPage = (items: AtlasEntitySummary[]): AtlasWorkspacePage<AtlasEntitySummary> => ({
  scope: "ws:o:hash",
  owner: { id: "o", slug: "acme" },
  snapshot: { id: "ws1.tag.2.2", repos: [] },
  items,
  counts: { loaded: items.length, knownTotal: items.length, unknownTotal: false },
  next: null,
});

/** A client whose answers the test hands out one by one, in any order. */
function scriptedClient() {
  const overviews: ReturnType<typeof deferred<AtlasWorkspaceOverview>>[] = [];
  const children = new Map<
    string,
    ReturnType<typeof deferred<AtlasWorkspacePage<AtlasEntitySummary>>>
  >();
  const compositions: ReturnType<typeof deferred<AtlasWorkspaceComposition>>[] = [];
  const requests: {
    route: string;
    workspace: AtlasWorkspace;
    snapshot?: string;
    signal?: AbortSignal;
  }[] = [];
  const client: WorkspaceClient = {
    overview(workspace, request) {
      requests.push({ route: "overview", workspace, ...request });
      const d = deferred<AtlasWorkspaceOverview>();
      overviews.push(d);
      return d.promise;
    },
    children(workspace, id, request) {
      requests.push({ route: `children ${id}`, workspace, ...request });
      const d = deferred<AtlasWorkspacePage<AtlasEntitySummary>>();
      children.set(id, d);
      return d.promise;
    },
    composition(workspace, request) {
      requests.push({ route: "composition", workspace, ...request });
      const d = deferred<AtlasWorkspaceComposition>();
      compositions.push(d);
      return d.promise;
    },
  };
  return { client, overviews, children, compositions, requests };
}

function track(workspace: AtlasWorkspace, client: WorkspaceClient) {
  const states: WorkspaceState[] = [];
  const session = new WorkspaceSession(workspace, client, (s) => states.push(s));
  return { session, states, last: () => states.at(-1)! };
}

describe("workspace session", () => {
  test("switching scope drops the previous scope's late answers", async () => {
    const { client, overviews, children, requests } = scriptedClient();
    const first = track({ owner: "acme", repos: ["api", "web"] }, client);
    void first.session.open();
    overviews[0]!.resolve(overview([A, B]));
    await flush();
    first.session.expand("r1/cap:auth");
    expect(first.last().loads.get("r1/cap:auth")).toEqual({ state: "loading" });

    // The selection changes: the page disposes this session and opens another.
    first.session.dispose();
    const second = track({ owner: "acme", repos: ["docs"] }, client);
    void second.session.open();
    const seen = first.states.length;
    // The old scope's child page arrives late, then the new overview.
    children.get("r1/cap:auth")!.resolve(childPage([file("r1", "src/auth.ts")]));
    overviews[1]!.resolve(overview([C], "ws1.other.2"));
    await flush();

    expect(first.states).toHaveLength(seen);
    expect(requests.find((r) => r.route === "children r1/cap:auth")!.signal!.aborted).toBe(true);
    const now = second.last();
    expect(now.status).toBe("ready");
    expect(now.loads.size).toBe(0);
    expect(now.overview!.regions.every((r) => r.repoId === "r3")).toBe(true);
    // The new scope's first state was empty: nothing carried over.
    expect(second.states[0]).toMatchObject({ status: "loading", overview: null });
  });

  test("an overview answering after its session is gone changes nothing", async () => {
    const { client, overviews } = scriptedClient();
    const view = track({ owner: "acme", repos: ["api"] }, client);
    void view.session.open();
    view.session.dispose();
    overviews[0]!.resolve(overview([A]));
    await flush();
    expect(view.states.map((s) => s.status)).toEqual(["loading"]);
  });

  test("revocation detected mid-view discards that repository's content", async () => {
    const { client, overviews, children, requests } = scriptedClient();
    const view = track({ owner: "acme", repos: ["api", "web"] }, client);
    void view.session.open();
    overviews[0]!.resolve(overview([A, B]));
    await flush();
    // Both repositories have something open.
    view.session.expand("r1/cap:auth");
    view.session.expand("r2/cap:ui");
    children.get("r1/cap:auth")!.resolve(childPage([file("r1", "src/auth.ts")]));
    await flush();
    expect(view.last().loads.get("r1/cap:auth")?.state).toBe("ready");
    // Every child request is pinned to the composite the overview named.
    expect(requests.filter((r) => r.route.startsWith("children")).map((r) => r.snapshot)).toEqual([
      "ws1.tag.2.2",
      "ws1.tag.2.2",
    ]);

    // Access to "api" goes away: the pinned composite no longer matches the
    // authorized set, so the next pinned page says snapshot_unknown.
    view.session.expand("r1/cap:billing");
    children
      .get("r1/cap:billing")!
      .reject(
        new ApiError(404, "There's no such Atlas snapshot in this scope.", "snapshot_unknown"),
      );
    await flush();
    // The session re-reads the scope: only "web" is readable now.
    overviews[1]!.resolve(overview([B], "ws1.new.2"));
    await flush();
    // "web"'s page answers late; "api"'s first page answers again too late.
    children.get("r2/cap:ui")!.resolve(childPage([file("r2", "src/ui.tsx")]));
    await flush();

    const state = view.last();
    expect(state.revoked).toEqual(new Set(["api"]));
    expect(state.notice).toEqual({ kind: "access", lost: ["api"] });
    expect(state.overview!.regions.some((r) => r.repoId === "r1")).toBe(false);
    expect(state.overview!.snapshot.repos.map((r) => r.name)).toEqual(["web"]);
    expect([...state.loads.keys()].some((id) => id.startsWith("r1/"))).toBe(false);
    expect(state.loads.get("r2/cap:ui")?.state).toBe("ready");
    // Nothing of the revoked repository can be opened again.
    const before = requests.length;
    view.session.expand("r1/cap:auth");
    expect(requests).toHaveLength(before);
    // What's on screen draws without it.
    const map = buildWorkspaceTerritory(
      coverageOf(["api", "web"], state.overview!.snapshot.repos, state.revoked),
      state.overview!.regions,
      new Map(),
    );
    expect(map.bands.map((b) => b.coverage.state)).toEqual(["revoked", "ready"]);
    expect(map.cells.some((c) => c.id.startsWith("r1/"))).toBe(false);
  });

  test("losing every repository empties the view", async () => {
    const { client, overviews, children } = scriptedClient();
    const view = track({ owner: "acme", repos: ["api"] }, client);
    void view.session.open();
    overviews[0]!.resolve(overview([A]));
    await flush();
    view.session.expand("r1/cap:auth");
    children
      .get("r1/cap:auth")!
      .reject(new ApiError(404, "None of the selected repositories…", "scope_empty"));
    await flush();
    overviews[1]!.reject(new ApiError(404, "None of the selected repositories…", "scope_empty"));
    await flush();
    const state = view.last();
    expect(state.overview!.regions).toEqual([]);
    expect(state.overview!.snapshot.repos).toEqual([]);
    expect(state.revoked).toEqual(new Set(["api"]));
  });

  test("an expired snapshot asks for the current view instead of switching silently", async () => {
    const { client, overviews, children } = scriptedClient();
    const view = track({ owner: "acme", repos: ["api"] }, client);
    void view.session.open();
    overviews[0]!.resolve(overview([A]));
    await flush();
    view.session.expand("r1/cap:auth");
    children
      .get("r1/cap:auth")!
      .reject(new ApiError(410, "This Atlas snapshot has expired.", "snapshot_expired"));
    await flush();
    expect(overviews).toHaveLength(1);
    expect(view.last().notice?.kind).toBe("restart");
    expect(view.last().overview!.regions.length).toBeGreaterThan(0);
  });

  test("a scope nobody can read says so", async () => {
    const { client, overviews } = scriptedClient();
    const view = track({ owner: "acme", repos: ["secret"] }, client);
    void view.session.open();
    overviews[0]!.reject(new ApiError(404, "None of the selected repositories…", "scope_empty"));
    await flush();
    expect(view.last()).toMatchObject({ status: "empty", overview: null });
  });
});

describe("composition coverage", () => {
  const composition = (repos: AtlasWorkspaceRepo[]): AtlasWorkspaceComposition => ({
    scope: "ws:o:hash",
    owner: { id: "o", slug: "acme" },
    snapshot: { id: "ws1.tag.2.2", repos },
    items: [],
    counts: { loaded: 0, knownTotal: 3, unknownTotal: false },
    next: null,
    coverage: repos.map((r, i) => ({
      repoId: r.id,
      capabilities: { composed: 2, total: 2 },
      packages: i === 0 ? "recorded" : "unrecorded",
      imports: { considered: 4, truncated: false },
    })),
    resolved: 2,
    inference: "none",
  });

  test("is read at the overview's composite, and dropped with its scope", async () => {
    const { client, overviews, compositions, requests } = scriptedClient();
    const view = track({ owner: "acme", repos: ["api", "web"] }, client);
    void view.session.open();
    overviews[0]!.resolve(overview([A, B]));
    await flush();
    expect(view.last().composition).toEqual({ status: "loading" });
    const asked = requests.find((r) => r.route === "composition")!;
    expect(asked.snapshot).toBe("ws1.tag.2.2");
    compositions[0]!.resolve(composition([A, B]));
    await flush();
    expect(view.last().composition).toMatchObject({
      status: "ready",
      composites: 3,
      resolved: 2,
      coverage: [
        { repoId: "r1", packages: "recorded" },
        { repoId: "r2", packages: "unrecorded" },
      ],
    });

    // Another scope: this one's composition answer never lands.
    const other = track({ owner: "acme", repos: ["api"] }, client);
    void other.session.open();
    view.session.dispose();
    const seen = view.states.length;
    overviews[1]!.resolve(overview([A], "ws1.solo.2"));
    await flush();
    expect(requests.filter((r) => r.route === "composition")[0]!.signal!.aborted).toBe(true);
    compositions[1]!.resolve(composition([A]));
    await flush();
    expect(view.states).toHaveLength(seen);
    expect(other.last().composition).toMatchObject({
      status: "ready",
      coverage: [{ repoId: "r1" }],
    });
  });

  test("revocation keeps only readable repositories' rows and drops scope-wide totals", async () => {
    const { client, overviews, compositions } = scriptedClient();
    const view = track({ owner: "acme", repos: ["api", "web"] }, client);
    void view.session.open();
    overviews[0]!.resolve(overview([A, B]));
    await flush();
    compositions[0]!.resolve(composition([A, B]));
    await flush();
    view.session.revoke(["api"]);
    expect(view.last().composition).toEqual({
      status: "ready",
      coverage: [expect.objectContaining({ repoId: "r2" })],
      composites: null,
      resolved: null,
    });
  });
});
