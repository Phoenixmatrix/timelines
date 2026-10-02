import { describe, expect, it } from "vite-plus/test";
import type { KnowledgeMap } from "../../../shared/api.ts";
import { buildAtlas, cellAt, squarify, WORLD_W, type Cell } from "./atlas.ts";

function synthetic(files: number): KnowledgeMap {
  const nodes: KnowledgeMap["nodes"] = [["repo", "repository", "repo", null, 0, 0]];
  const edges: KnowledgeMap["edges"] = [];
  const components = Math.ceil(files / 60);
  for (let c = 0; c < components; c++)
    nodes.push([`component:c${c}`, "component", `Component ${c}`, `pkg${c}`, 0, 0]);
  for (let f = 0; f < files; f++) {
    const c = f % components;
    const file =
      nodes.push([
        `file:pkg${c}/d${f % 5}/f${f}.ts`,
        "file",
        `f${f}.ts`,
        `pkg${c}/d${f % 5}/f${f}.ts`,
        40 + (f % 300),
        0,
      ]) - 1;
    edges.push([1 + c, file, "contains"]);
    for (let s = 0; s < 3; s++) {
      const sym = nodes.push([`sym:f${f}#s${s}`, "symbol", `s${s}`, null, s, 0]) - 1;
      edges.push([file, sym, "defines"]);
    }
    if (f > 0) edges.push([file, file - 4 * (f % 2), "imports"]);
  }
  return { commit: "c", nodes, edges };
}

const all = (cell: Cell): Cell[] => [cell, ...cell.children.flatMap(all)];

describe("atlas layout", () => {
  it("squarifies into the rectangle without overlap", () => {
    const rects = squarify(
      [9, 5, 3, 2, 1].map((weight, i) => ({ weight, label: String(i) })),
      0,
      0,
      100,
      50,
    );
    expect(rects.reduce((s, r) => s + r.w * r.h, 0)).toBeCloseTo(5000);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(100.0001);
      expect(r.y + r.h).toBeLessThanOrEqual(50.0001);
    }
  });

  // Correctness at scale only: timing is measured in the browser, since a
  // shared CI machine makes wall-clock assertions flaky.
  it("nests every cell inside its parent at 30,000 files", { timeout: 60_000 }, () => {
    const map = synthetic(30_000);
    const atlas = buildAtlas(map);
    const cells = all(atlas.root);
    expect(cells.filter((c) => c.level === "plot")).toHaveLength(30_000);
    expect(cells.filter((c) => c.level === "lot")).toHaveLength(90_000);
    const outside = cells.filter(
      (c) =>
        c.parent &&
        (c.x < c.parent.x - 1e-6 ||
          c.y < c.parent.y - 1e-6 ||
          c.x + c.w > c.parent.x + c.parent.w + 1e-6 ||
          c.y + c.h > c.parent.y + c.parent.h + 1e-6),
    );
    expect(outside).toHaveLength(0);
    expect(atlas.root.w).toBe(WORLD_W);
    expect(atlas.root.h).toBe(WORLD_W / 1.6);
    expect(buildAtlas(map, 1).height).toBe(WORLD_W);
  });

  it("is stable across rebuilds and finds cells by point", () => {
    const a = buildAtlas(synthetic(500));
    const b = buildAtlas(synthetic(500));
    const file = a.byId.get("file:pkg3/d3/f3.ts")!;
    const ca = a.cellOf.get(file)!;
    expect(b.cellOf.get(file)).toMatchObject({ x: ca.x, y: ca.y, w: ca.w, h: ca.h });
    expect(cellAt(a, ca.x + ca.w / 2, ca.y + ca.h - 0.01, "plot")?.node).toBe(file);
    expect(a.cellOf.get(a.byId.get("component:c3")!)?.level).toBe("region");
  });
});
