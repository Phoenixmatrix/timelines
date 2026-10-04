import { describe, expect, test } from "vite-plus/test";
import type { AtlasEntitySummary, AtlasRegion } from "../../../shared/atlas.ts";
import { buildTerritory, cellAt, ChildLoader, TILE, type Load } from "./territory.ts";

const cap = (id: string, slot: number, files: number, since = 1): AtlasRegion => ({
  id,
  kind: "capability",
  parentId: "repo",
  name: id,
  path: null,
  summary: "",
  counts: { files },
  structural: false,
  since,
  layout: {
    slot,
    col: slot % 4,
    row: Math.floor(slot / 4),
    bucket: Math.ceil(Math.log2(files + 1)),
    fill: Math.min(1, 0.3 + 0.07 * Math.ceil(Math.log2(files + 1))),
  },
  size: { files, members: files },
  summaryTruncated: false,
});
const group = (id: string): AtlasRegion => ({
  ...cap(id, 0, 3),
  kind: "group",
  structural: true,
  layout: undefined,
});
const file = (id: string): AtlasEntitySummary => ({
  id,
  kind: "file",
  parentId: null,
  name: id,
  path: id,
  summary: "",
  counts: {},
  structural: false,
});
const rect = (t: ReturnType<typeof buildTerritory>, id: string) => {
  const c = t.byId.get(id)!;
  return [c.x, c.y, c.w, c.h];
};

describe("territory geometry", () => {
  test("regions sit in their stable slots; expanding one moves no other", () => {
    const regions = [
      cap("cap:a", 0, 40),
      cap("cap:b", 1, 10),
      cap("cap:c", 5, 3),
      group("group:u"),
    ];
    const before = buildTerritory(regions, new Map(), 1);
    const after = buildTerritory(
      regions,
      new Map([["cap:a", [file("file:a/1.ts"), file("file:a/2.ts")]]]),
      1,
    );
    for (const id of ["cap:a", "cap:b", "cap:c", "group:u"])
      expect(rect(after, id)).toEqual(rect(before, id));
    // The children are drawn inside their parent.
    const [px, py, pw, ph] = rect(after, "cap:a") as [number, number, number, number];
    for (const id of ["file:a/1.ts", "file:a/2.ts"]) {
      const [x, y, w, h] = rect(after, id) as [number, number, number, number];
      expect(x).toBeGreaterThanOrEqual(px);
      expect(y).toBeGreaterThanOrEqual(py);
      expect(x + w).toBeLessThanOrEqual(px + pw);
      expect(y + h).toBeLessThanOrEqual(py + ph);
    }
    const one = after.byId.get("file:a/1.ts")!;
    expect(cellAt(after, one.anchor.x, one.anchor.y)?.id).toBe("file:a/1.ts");
  });

  test("a region growing within its bucket, appearing or leaving moves no other", () => {
    const base = buildTerritory([cap("cap:a", 0, 40), cap("cap:b", 1, 10)], new Map(), 1);
    const later = buildTerritory(
      // b grows within its bucket, a new region takes a slot away from both.
      [cap("cap:a", 0, 40), cap("cap:b", 1, 12), cap("cap:new", 11, 6)],
      new Map(),
      2,
    );
    expect(rect(later, "cap:a")).toEqual(rect(base, "cap:a"));
    expect(rect(later, "cap:b")).toEqual(rect(base, "cap:b"));
    const gone = buildTerritory([cap("cap:b", 1, 10)], new Map(), 3);
    // b only gains the border a gave up.
    const before = land(base, "cap:b");
    const now = land(gone, "cap:b");
    for (const at of before) expect(now.has(at), at).toBe(true);
  });

  test("a neighbour growing moves only the borders it shares", () => {
    const regions = [
      cap("cap:a", 0, 40),
      cap("cap:b", 1, 10),
      cap("cap:c", 4, 20),
      cap("cap:far", 7, 8),
    ];
    const base = buildTerritory(regions, new Map(), 1);
    // b jumps three buckets.
    const grown = buildTerritory(
      regions.map((r) => (r.id === "cap:b" ? cap("cap:b", 1, 90) : r)),
      new Map(),
      2,
    );
    // The others only lose land, and only to b.
    for (const id of ["cap:a", "cap:c", "cap:far"]) {
      const was = land(base, id);
      for (const at of land(grown, id)) expect(was.has(at), `${id} ${at}`).toBe(true);
    }
    const gained = land(grown, "cap:b");
    for (const at of land(base, "cap:b")) expect(gained.has(at), at).toBe(true);
    expect(gained.size).toBeGreaterThan(land(base, "cap:b").size);
    // A region that doesn't border it doesn't change at all.
    expect(rect(grown, "cap:far")).toEqual(rect(base, "cap:far"));
  });

  test("more files means more land, in buckets", () => {
    const t = buildTerritory(
      [cap("cap:small", 0, 2), cap("cap:mid", 2, 20), cap("cap:big", 8, 200)],
      new Map(),
      1,
    );
    const size = (id: string) => t.byId.get(id)!.size;
    expect(size("cap:small")).toBeGreaterThan(0);
    expect(size("cap:mid")).toBeGreaterThan(size("cap:small"));
    expect(size("cap:big")).toBeGreaterThan(size("cap:mid"));
  });

  test("children divide their parent's land: all of it, and nothing outside it", () => {
    const children = [file("file:a/1.ts"), file("file:a/2.ts"), file("file:a/3.ts")].map(
      (f, i) => ({ ...f, counts: { files: [10, 20, 10][i]! } }),
    );
    const t = buildTerritory(
      [cap("cap:a", 0, 40), cap("cap:b", 1, 10)],
      new Map([["cap:a", children]]),
      1,
    );
    const parent = t.byId.get("cap:a")!;
    const mine = land(t, "cap:a");
    expect(mine.size).toBe(parent.size);
    let total = 0;
    for (const child of children) {
      const cell = t.byId.get(child.id)!;
      expect(cell.parent).toBe("cap:a");
      expect(cell.size).toBeGreaterThan(0);
      total += cell.size;
      for (const tile of t.tiles.filter((x) => x.cell === child.id))
        expect(mine.has(key(tile))).toBe(true);
    }
    expect(total).toBe(parent.size);
    // Shares follow files: the 20-file child holds about half.
    const half = t.byId.get("file:a/2.ts")!.size / parent.size;
    expect(half).toBeGreaterThan(0.35);
    expect(half).toBeLessThan(0.65);
  });

  test("structural groups are islands below the continent, touching nothing", () => {
    const t = buildTerritory(
      [cap("cap:a", 0, 40), cap("cap:b", 5, 30), group("group:u"), group("group:c")],
      new Map(),
      1,
    );
    const continent = t.tiles.filter((x) => !x.region.startsWith("group:"));
    const bottom = Math.max(...continent.map((x) => x.y));
    for (const id of ["group:u", "group:c"]) {
      const g = t.byId.get(id)!;
      expect(g.structural).toBe(true);
      expect(g.size).toBeGreaterThan(0);
      expect(g.y).toBeGreaterThan(bottom);
      // No tile of it sits next to another region's.
      for (const tile of t.tiles.filter((x) => x.region === id))
        for (const other of t.tiles)
          if (other.region !== id)
            expect(Math.hypot(tile.x - other.x, tile.y - other.y)).toBeGreaterThan(TILE * 2);
    }
  });

  test("every region gets a label spot on its own land, and an outline", () => {
    const t = buildTerritory(
      [cap("cap:a", 0, 40), cap("cap:b", 1, 10), group("group:u")],
      new Map(),
      1,
    );
    for (const c of t.cells) {
      expect(cellAt(t, c.anchor.x, c.anchor.y)?.id).toBe(c.id);
      expect(c.edges.length % 4).toBe(0);
      expect(c.edges.length).toBeGreaterThan(0);
    }
  });

  test("a first snapshot marks nothing changed: there's nothing to compare with", () => {
    const t = buildTerritory([cap("cap:a", 0, 40, 1)], new Map(), 1);
    expect(t.byId.get("cap:a")!.changed).toBe(false);
  });

  test("change markers come from the snapshot each region last changed in", () => {
    const t = buildTerritory([cap("cap:a", 0, 40, 7), cap("cap:b", 1, 10, 3)], new Map(), 7);
    expect(t.byId.get("cap:a")!.changed).toBe(true);
    expect(t.byId.get("cap:b")!.changed).toBe(false);
  });
});

const key = (tile: { x: number; y: number }) => `${Math.round(tile.x)},${Math.round(tile.y)}`;
/** Where a top-level region's tiles are. */
function land(t: ReturnType<typeof buildTerritory>, id: string): Set<string> {
  return new Set(t.tiles.filter((x) => x.region === id).map(key));
}

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
