import { describe, expect, test } from "vite-plus/test";
import { cell, GRID_WIDTH, reconcile, type NextGroup, type PriorGroup } from "./identity.ts";

const files = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `file:${prefix}/${i}.ts`);
const mint = (key: string) => `cap:new-${key}`;

describe("capability identity", () => {
  test("unchanged groups keep their ids and slots, whatever the grouping pass called them", () => {
    const prior: PriorGroup[] = [
      { id: "cap:billing", members: files("billing", 8), slot: 2 },
      { id: "cap:deploy", members: files("deploy", 5), slot: 0 },
    ];
    // The grouping pass's own keys changed (a shifted anchor): ids must not.
    const next: NextGroup[] = [
      { key: "cap:anchor-x", members: files("billing", 8) },
      { key: "cap:anchor-y", members: files("deploy", 5) },
    ];
    const r = reconcile(prior, next, mint);
    expect(r.ids).toEqual(
      new Map([
        ["cap:anchor-x", "cap:billing"],
        ["cap:anchor-y", "cap:deploy"],
      ]),
    );
    expect(r.slots).toEqual(
      new Map([
        ["cap:billing", 2],
        ["cap:deploy", 0],
      ]),
    );
    expect(r.retired).toEqual([]);
  });

  test("a split keeps the id on the side that continues it and records the other's origin", () => {
    const members = files("billing", 10);
    const r = reconcile(
      [{ id: "cap:billing", members, slot: 0 }],
      [
        { key: "a", members: members.slice(0, 6) },
        { key: "b", members: members.slice(6) },
      ],
      mint,
    );
    expect(r.ids.get("a")).toBe("cap:billing");
    expect(r.ids.get("b")).toBe("cap:new-b");
    expect(r.lineage.get("cap:new-b")).toEqual({
      predecessors: [{ id: "cap:billing", share: 0.4 }],
      change: "split",
    });
    expect(r.retired).toEqual([]);
    expect(r.slots.get("cap:billing")).toBe(0);
    expect(r.slots.get("cap:new-b")).toBe(1);
  });

  test("an even split continues neither side: both are new, and the old id is retired with both", () => {
    const members = files("billing", 10);
    const r = reconcile(
      [{ id: "cap:billing", members, slot: 0 }],
      [
        { key: "a", members: members.slice(0, 5) },
        { key: "b", members: members.slice(5) },
      ],
      mint,
    );
    expect([r.ids.get("a"), r.ids.get("b")]).toEqual(["cap:new-a", "cap:new-b"]);
    expect(r.retired).toEqual([
      {
        id: "cap:billing",
        change: "split",
        successors: [
          { id: "cap:new-a", share: 0.5 },
          { id: "cap:new-b", share: 0.5 },
        ],
      },
    ]);
  });

  test("a merge of two capabilities is new, with both as predecessors", () => {
    const r = reconcile(
      [
        { id: "cap:charges", members: files("charges", 4), slot: 0 },
        { id: "cap:refunds", members: files("refunds", 4), slot: 1 },
      ],
      [{ key: "m", members: [...files("charges", 4), ...files("refunds", 4)] }],
      mint,
    );
    expect(r.ids.get("m")).toBe("cap:new-m");
    expect(r.lineage.get("cap:new-m")).toEqual({
      predecessors: [
        { id: "cap:charges", share: 1 },
        { id: "cap:refunds", share: 1 },
      ],
      change: "merge",
    });
    expect(r.retired.map((x) => [x.id, x.change])).toEqual([
      ["cap:charges", "merged"],
      ["cap:refunds", "merged"],
    ]);
  });

  test("a deleted capability is retired with nowhere to point, never at something unrelated", () => {
    const r = reconcile(
      [
        { id: "cap:gone", members: files("gone", 3), slot: 0 },
        { id: "cap:stays", members: files("stays", 4), slot: 1 },
      ],
      [
        { key: "s", members: files("stays", 4) },
        { key: "fresh", members: files("fresh", 5) },
      ],
      mint,
    );
    expect(r.retired).toEqual([{ id: "cap:gone", successors: [], change: "removed" }]);
    expect(r.ids.get("fresh")).toBe("cap:new-fresh");
    expect(r.lineage.get("cap:new-fresh")).toEqual({ predecessors: [], change: "new" });
    // The freed slot goes to the newcomer; the survivor doesn't move.
    expect(r.slots.get("cap:stays")).toBe(1);
    expect(r.slots.get("cap:new-fresh")).toBe(0);
  });

  test("continuity needs a unique reciprocal match: one prior id never goes to two groups", () => {
    const members = files("x", 9);
    const r = reconcile(
      [{ id: "cap:x", members, slot: 0 }],
      // Both sides overlap; only the larger, reciprocal one keeps the id.
      [
        { key: "big", members: members.slice(0, 7) },
        { key: "small", members: members.slice(7) },
      ],
      mint,
    );
    expect([...r.ids.values()].filter((id) => id === "cap:x")).toHaveLength(1);
    expect(r.ids.get("big")).toBe("cap:x");
  });

  test("layout is local: regions appearing, growing or leaving never move another", () => {
    const before = reconcile(
      [],
      [
        { key: "a", members: files("a", 40) },
        { key: "b", members: files("b", 10) },
        { key: "c", members: files("c", 5) },
      ],
      mint,
    );
    const prior: PriorGroup[] = ["a", "b", "c"].map((k, i) => ({
      id: before.ids.get(k)!,
      members: files(k, [40, 10, 5][i]!),
      slot: before.slots.get(before.ids.get(k)!)!,
    }));
    const coords = (r: ReturnType<typeof reconcile>, id: string, size: number) => {
      const c = cell(r.slots.get(id)!, size, GRID_WIDTH.top);
      return [c.col, c.row];
    };
    // c leaves, b grows a little, d arrives.
    const after = reconcile(
      prior,
      [
        { key: "a2", members: files("a", 40) },
        { key: "b2", members: [...files("b", 10), "file:b/extra.ts"] },
        { key: "d", members: files("d", 7) },
      ],
      mint,
    );
    const a = before.ids.get("a")!;
    const b = before.ids.get("b")!;
    expect(after.ids.get("a2")).toBe(a);
    expect(after.ids.get("b2")).toBe(b);
    expect(coords(after, a, 40)).toEqual(coords(before, a, 40));
    expect(coords(after, b, 11)).toEqual(coords(before, b, 10));
    // Size within the cell moves in buckets: 10 -> 11 files changes nothing.
    expect(cell(0, 11, 4).fill).toBe(cell(0, 10, 4).fill);
    expect(after.slots.get(after.ids.get("d")!)).toBe(before.slots.get(before.ids.get("c")!));
  });
});
