import { describe, expect, test } from "vite-plus/test";
import type { AtlasEntitySummary, AtlasRegion } from "../../../shared/atlas.ts";
import { buildTerritory, cellAt, ChildLoader, type Load } from "./territory.ts";

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
    expect(cellAt(after, ...centre(after, "file:a/1.ts"))?.id).toBe("file:a/1.ts");
  });

  test("a region growing, appearing or leaving never moves another", () => {
    const base = buildTerritory([cap("cap:a", 0, 40), cap("cap:b", 1, 10)], new Map(), 1);
    const later = buildTerritory(
      // b grows within its bucket, a new region takes slot 2.
      [cap("cap:a", 0, 40), cap("cap:b", 1, 12), cap("cap:new", 2, 6)],
      new Map(),
      2,
    );
    expect(rect(later, "cap:a")).toEqual(rect(base, "cap:a"));
    expect(rect(later, "cap:b")).toEqual(rect(base, "cap:b"));
    const gone = buildTerritory([cap("cap:b", 1, 10)], new Map(), 3);
    expect(rect(gone, "cap:b")).toEqual(rect(base, "cap:b"));
  });

  test("structural groups stay in their own band, apart from capabilities", () => {
    const t = buildTerritory(
      [cap("cap:a", 0, 40), group("group:u"), group("group:c")],
      new Map(),
      1,
    );
    const a = t.byId.get("cap:a")!;
    for (const id of ["group:u", "group:c"]) {
      const g = t.byId.get(id)!;
      expect(g.structural).toBe(true);
      expect(g.y).toBeGreaterThan(a.y + a.h);
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

function centre(t: ReturnType<typeof buildTerritory>, id: string): [number, number] {
  const c = t.byId.get(id)!;
  return [c.x + c.w / 2, c.y + c.h / 2];
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
    expect(seen.at(-1)).toEqual({ state: "error", message: "boom" });
  });
});
