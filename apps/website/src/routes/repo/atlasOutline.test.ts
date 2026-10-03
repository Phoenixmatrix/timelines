import { describe, expect, test } from "vite-plus/test";
import type { AtlasEntitySummary } from "../../../shared/atlas.ts";
import { opensInOutline, outlineRows, rowDetail, rowSummary } from "./AtlasOutline.tsx";
import type { Load } from "./territory.ts";

const e = (
  id: string,
  kind: string,
  extra: Partial<AtlasEntitySummary> = {},
): AtlasEntitySummary => ({
  id,
  kind,
  parentId: null,
  name: id,
  path: null,
  summary: "",
  counts: {},
  structural: false,
  ...extra,
});

describe("the outline's rows", () => {
  const cap = e("cap:a", "capability", { counts: { files: 2 } });
  const other = e("cap:b", "capability", { counts: { files: 1 } });
  const file = e("file:a.ts", "file", { counts: { symbols: 1 } });
  const bare = e("file:b.ts", "file", { counts: { symbols: 0 } });

  test("are the roots, then each expanded entity's loaded children, depth first, with levels", () => {
    const loads = new Map<string, Load>([
      ["cap:a", { state: "ready", items: [file, bare], next: "c1", total: 5 }],
      ["file:a.ts", { state: "ready", items: [e("sym:a.ts#f", "symbol")], next: null, total: 1 }],
    ]);
    const rows = outlineRows([cap, other], true, new Set(["cap:a", "file:a.ts"]), loads);
    expect(
      rows.map((r) =>
        r.kind === "entity"
          ? [r.key, r.level, r.posinset, r.setsize, r.expandable, r.expanded]
          : [r.kind, r.level, r.parent],
      ),
    ).toEqual([
      ["cap:a", 1, 1, 2, true, true],
      ["file:a.ts", 2, 1, 2, true, true],
      ["sym:a.ts#f", 3, 1, 1, false, false],
      ["file:b.ts", 2, 2, 2, false, false],
      ["more", 2, "cap:a"],
      ["cap:b", 1, 2, 2, true, false],
      ["more", 1, null],
    ]);
  });

  test("say when an opened entity is loading or failed, rather than showing it empty", () => {
    const loading = outlineRows([cap], false, new Set(["cap:a"]), new Map());
    expect(loading.map((r) => r.kind)).toEqual(["entity", "loading"]);
    const failed = outlineRows(
      [cap],
      false,
      new Set(["cap:a"]),
      new Map<string, Load>([["cap:a", { state: "error", message: "x" }]]),
    );
    expect(failed.map((r) => r.kind)).toEqual(["entity", "error"]);
  });

  test("open regions, and files only when they define symbols", () => {
    expect(opensInOutline(cap)).toBe(true);
    expect(opensInOutline(file)).toBe(true);
    expect(opensInOutline(bare)).toBe(false);
    expect(opensInOutline(e("sym:x", "symbol"))).toBe(false);
  });

  test("give a region's summary, or say why there's no current one", () => {
    expect(rowSummary(e("cap:a", "capability", { summary: "Charges cards." }))).toBe(
      "Charges cards.",
    );
    expect(
      rowSummary(
        e("cap:a", "capability", { summaryState: { status: "unavailable", reason: "disabled" } }),
      ),
    ).toMatch(/^No summary for this build \(summaries are off\)/);
    expect(rowSummary(e("file:a.ts", "file"))).toBeNull();
  });

  test("say kind, size and change in words", () => {
    expect(
      rowDetail(
        e("cap:a", "capability", {
          counts: { files: 3 },
          since: 4,
          summaryState: { status: "unavailable", reason: "disabled" },
        }),
        4,
      ),
    ).toBe("Capability · 3 files · changed in this build");
    // A first snapshot marks nothing changed: there's nothing to compare with.
    expect(rowDetail(e("cap:a", "capability", { counts: { files: 1 }, since: 1 }), 1)).toBe(
      "Capability · 1 file",
    );
    expect(rowDetail(e("file:a.ts", "file", { counts: { symbols: 2 } }), 1)).toBe(
      "File · 2 symbols",
    );
    expect(
      rowDetail(
        {
          ...e("group:u", "group", { structural: true }),
          size: { files: 4, members: 4 },
        } as AtlasEntitySummary,
        1,
      ),
    ).toBe("Structural group · 4 items");
  });
});
