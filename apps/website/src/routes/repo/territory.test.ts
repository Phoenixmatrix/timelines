import { describe, expect, test } from "vite-plus/test";
import type { AtlasEntitySummary, AtlasRegion } from "../../../shared/atlas.ts";
import {
  buildTerritory,
  cellAt,
  ChildLoader,
  HEX,
  shiftTerritory,
  type Load,
} from "./territory.ts";

const SQ3 = Math.sqrt(3);

const entity = (id: string, kind: string, files = 0): AtlasEntitySummary => ({
  id,
  kind,
  parentId: null,
  name: id,
  path: kind === "file" ? id : null,
  summary: "",
  counts: { files },
  structural: false,
});
const area = (id: string, files = 1) => entity(id, "area", files);
const file = (id: string) => entity(id, "file");
/** A capability; `areas` lists its concepts' file counts, as the overview does. */
const cap = (id: string, areas: number[] = [], since = 1): AtlasRegion => {
  const files = areas.reduce((s, n) => s + n, 0) || 3;
  return {
    ...entity(id, "capability", files),
    parentId: "repo",
    counts: { files, areas: areas.length },
    since,
    size: { files, members: files },
    summaryTruncated: false,
    ...(areas.length ? { areas: areas.map((n, i) => area(`${id}/area:${i}`, n)) } : {}),
  };
};
const group = (id: string): AtlasRegion => ({ ...cap(id), kind: "group", structural: true });
const link = (src: string, dst: string, weight: number) => ({ src, dst, weight });

type T = ReturnType<typeof buildTerritory>;
/** A country's own hexagons (not the small ones drawn on them). */
const own = (t: T, region: string) => t.tiles.filter((x) => x.region === region && !x.host);
const middle = (t: T, region: string) => {
  const tiles = own(t, region);
  return [
    tiles.reduce((s, x) => s + x.x, 0) / tiles.length,
    tiles.reduce((s, x) => s + x.y, 0) / tiles.length,
  ] as const;
};
const apart = (t: T, a: string, b: string) => {
  const [ax, ay] = middle(t, a);
  const [bx, by] = middle(t, b);
  return Math.hypot(ax - bx, ay - by);
};

describe("territory geometry", () => {
  test("every concept is one hexagon of its country, the largest in the middle", () => {
    const t = buildTerritory([cap("cap:a", [3, 20, 5, 8])], new Map(), 1);
    const country = t.byId.get("cap:a")!;
    expect(country.size).toBe(4);
    const tiles = own(t, "cap:a");
    expect(tiles).toHaveLength(4);
    expect(new Set(tiles.map((x) => x.cell))).toEqual(
      new Set([0, 1, 2, 3].map((i) => `cap:a/area:${i}`)),
    );
    for (const tile of tiles) {
      expect(tile.r).toBe(HEX);
      const concept = t.byId.get(tile.cell)!;
      expect(concept.parent).toBe("cap:a");
      expect(concept.hex).toBe(HEX);
    }
    // The 20-file concept sits where the country's name goes; it's drawn lightest.
    const biggest = t.byId.get("cap:a/area:1")!;
    expect(biggest.anchor).toEqual(country.anchor);
    expect(tiles.find((x) => x.cell === "cap:a/area:1")!.shade).toBe(2);
  });

  test("a region without concepts is a single hexagon; one known only by count, unnamed ones", () => {
    const counted: AtlasRegion = { ...cap("cap:c"), counts: { files: 9, areas: 5 } };
    const t = buildTerritory([cap("cap:a"), counted], new Map(), 1);
    expect(own(t, "cap:a").map((x) => x.cell)).toEqual(["cap:a"]);
    expect(t.byId.get("cap:a")!.hex).toBe(HEX);
    const unnamed = own(t, "cap:c");
    expect(unnamed).toHaveLength(5);
    for (const tile of unnamed) expect(tile.cell).toBe("cap:c");
  });

  test("countries never touch: there's always sea between them", () => {
    const t = buildTerritory(
      [
        cap("cap:a", [9, 8, 7, 6, 5, 4, 3]),
        cap("cap:b", [5, 4, 3]),
        cap("cap:c"),
        cap("cap:d", [2, 2]),
      ],
      new Map(),
      1,
      [link("cap:a", "cap:b", 30), link("cap:b", "cap:c", 10), link("cap:d", "cap:a", 4)],
    );
    // Neighbouring hexagons' middles are r·√3 apart; one of sea between makes it twice that.
    for (const a of t.tiles)
      for (const b of t.tiles)
        if (!a.host && !b.host && a.region !== b.region)
          expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(HEX * SQ3 * 1.5);
  });

  test("countries that import each other sit together", () => {
    const regions = [
      cap("cap:web", [6, 5, 4]),
      cap("cap:store", [6, 5, 4]),
      cap("cap:ui", [5, 4, 3]),
      cap("cap:db", [5, 4, 3]),
    ];
    const t = buildTerritory(regions, new Map(), 1, [
      link("cap:web", "cap:ui", 40),
      link("cap:ui", "cap:web", 10),
      link("cap:store", "cap:db", 40),
    ]);
    // Each sits as close to its partner as to anything else on the map.
    for (const [a, b] of [
      ["cap:web", "cap:ui"],
      ["cap:store", "cap:db"],
    ] as const)
      for (const other of regions)
        if (other.id !== a && other.id !== b)
          expect(apart(t, a, b)).toBeLessThanOrEqual(apart(t, a, other.id));
    expect(apart(t, "cap:web", "cap:ui")).toBeLessThan(apart(t, "cap:web", "cap:db"));
  });

  test("one overview always draws the same map; opening a hexagon moves nothing", () => {
    const regions = [cap("cap:a", [4, 3, 2]), cap("cap:b", [2, 1]), cap("cap:c"), group("group:u")];
    const links = [link("cap:a", "cap:b", 3)];
    const before = buildTerritory(regions, new Map(), 1, links);
    expect(buildTerritory(regions, new Map(), 1, links).tiles).toEqual(before.tiles);
    const files = ["file:a/1.ts", "file:a/2.ts", "file:a/3.ts"].map(file);
    const after = buildTerritory(
      regions,
      new Map([
        ["cap:a/area:0", files],
        ["cap:c", [file("file:c.ts")]],
      ]),
      1,
      links,
    );
    expect(after.tiles.filter((x) => !x.host)).toEqual(before.tiles);
    // Its files are small hexagons on it, inside its outline.
    const host = after.byId.get("cap:a/area:0")!;
    expect(host.inner).toBeGreaterThan(0);
    for (const f of files) {
      const cell = after.byId.get(f.id)!;
      expect(cell.parent).toBe(host.id);
      expect(cell.depth).toBe(2);
      expect(cell.hex).toBe(host.inner);
      const off = Math.hypot(cell.anchor.x - host.anchor.x, cell.anchor.y - host.anchor.y);
      expect(off + cell.hex).toBeLessThanOrEqual(host.hex);
      // Pointing at it finds it, not the hexagon it's drawn on.
      expect(cellAt(after, cell.anchor.x, cell.anchor.y)?.id).toBe(f.id);
    }
    expect(after.byId.get("file:c.ts")!.parent).toBe("cap:c");
  });

  test("a country past its room lists the rest without drawing them", () => {
    const t = buildTerritory(
      [
        cap(
          "cap:a",
          Array.from({ length: 40 }, () => 1),
        ),
      ],
      new Map(),
      1,
    );
    expect(own(t, "cap:a")).toHaveLength(37);
    const rest = t.cells.filter((c) => c.parent === "cap:a" && c.size === 0);
    expect(rest).toHaveLength(3);
  });

  test("structural groups are islands below the land", () => {
    const t = buildTerritory(
      [cap("cap:a", [4, 3, 2]), cap("cap:b", [5, 1]), group("group:u"), group("group:c")],
      new Map(),
      1,
    );
    const land = t.tiles.filter((x) => !x.region.startsWith("group:"));
    const bottom = Math.max(...land.map((x) => x.y));
    for (const id of ["group:u", "group:c"]) {
      const g = t.byId.get(id)!;
      expect(g.structural).toBe(true);
      expect(own(t, id)).toHaveLength(1);
      expect(g.anchor.y).toBeGreaterThan(bottom);
    }
  });

  test("every drawn cell gets a label spot on its own hexagon, and an outline", () => {
    const t = buildTerritory(
      [cap("cap:a", [4, 2]), cap("cap:b"), group("group:u")],
      new Map([["cap:b", [file("file:b.ts")]]]),
      1,
    );
    for (const c of t.cells) {
      expect(c.edges.length % 4).toBe(0);
      expect(c.edges.length).toBeGreaterThan(0);
      // A country's label sits on its middle concept; everything else's on itself.
      const at = cellAt(t, c.anchor.x, c.anchor.y)?.id;
      if (c.id === "cap:a") expect(t.byId.get(at!)!.parent).toBe("cap:a");
      else if (c.id === "cap:b") expect(at).toBe("file:b.ts");
      else expect(at).toBe(c.id);
    }
  });

  test("shifting moves everything by the same amount", () => {
    const t = buildTerritory([cap("cap:a", [2, 1])], new Map(), 1);
    const s = shiftTerritory(t, 100, -50);
    expect(s.left).toBe(t.left + 100);
    expect(s.top).toBe(t.top - 50);
    const a = t.byId.get("cap:a/area:0")!;
    expect(cellAt(s, a.anchor.x + 100, a.anchor.y - 50)?.id).toBe(a.id);
  });

  test("a first snapshot marks nothing changed: there's nothing to compare with", () => {
    const t = buildTerritory([cap("cap:a", [], 1)], new Map(), 1);
    expect(t.byId.get("cap:a")!.changed).toBe(false);
  });

  test("change markers come from the snapshot each region last changed in", () => {
    const t = buildTerritory([cap("cap:a", [], 7), cap("cap:b", [], 3)], new Map(), 7);
    expect(t.byId.get("cap:a")!.changed).toBe(true);
    expect(t.byId.get("cap:b")!.changed).toBe(false);
  });
});

describe("child loading", () => {
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  };
  const page = (ids: string[]) => ({ items: ids.map(file), next: null, total: ids.length });

  test("a late answer for an older request never replaces the newer one", async () => {
    const answers = [deferred<ReturnType<typeof page>>(), deferred<ReturnType<typeof page>>()];
    let call = 0;
    const seen: [string, Load][] = [];
    const loader = new ChildLoader(
      "s1",
      () => answers[call++]!.promise,
      (id, load) => seen.push([id, load]),
    );
    const first = loader.load("cap:a");
    const second = loader.load("cap:a");
    answers[1]!.resolve(page(["file:new.ts"]));
    await second;
    answers[0]!.resolve(page(["file:old.ts"]));
    await first;
    const ready = seen.filter(([, l]) => l.state === "ready");
    expect(ready).toHaveLength(1);
    expect(ready[0]![1]).toMatchObject({ items: [{ id: "file:new.ts" }] });
  });

  test("answers from a previous snapshot or scope are dropped", async () => {
    const answer = deferred<ReturnType<typeof page>>();
    const seen: Load[] = [];
    const loader = new ChildLoader(
      "s1",
      () => answer.promise,
      (_, load) => seen.push(load),
    );
    const pending = loader.load("cap:a");
    loader.reset("s2");
    answer.resolve(page(["file:stale.ts"]));
    await pending;
    expect(seen.map((l) => l.state)).toEqual(["loading"]);
  });

  test("errors are reported for the region, ready for a scoped retry", async () => {
    const seen: Load[] = [];
    const loader = new ChildLoader(
      "s1",
      () => Promise.reject(new Error("boom")),
      (_, load) => seen.push(load),
    );
    await loader.load("cap:a");
    expect(seen.at(-1)).toMatchObject({ state: "error", message: "boom" });
  });
});
