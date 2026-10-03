import { describe, expect, test } from "vite-plus/test";
import { atlasHref, parseLens, readAtlasUrl, writeAtlasUrl } from "./atlasUrl.ts";
import { pathToOpen } from "./atlasNavigation.ts";
import type { AtlasEntitySummary } from "../../../shared/atlas.ts";

describe("the Atlas's address", () => {
  test("round-trips selection, snapshot, lens and lookup, keeping the timeline scope", () => {
    const written = writeAtlasUrl("tl=launch&other=1", {
      select: "sym:billing/ledger.ts#post",
      snapshot: "s-1",
      lens: { direction: "in", kind: "imports" },
      q: "ledger",
      kind: "file",
    });
    expect(written.get("tl")).toBe("launch");
    expect(written.get("other")).toBe("1");
    expect(written.get("lens")).toBe("in:imports");
    expect(readAtlasUrl(written)).toEqual({
      select: "sym:billing/ledger.ts#post",
      snapshot: "s-1",
      lens: { direction: "in", kind: "imports" },
      q: "ledger",
      kind: "file",
    });
  });

  test("defaults and clears leave nothing behind but what isn't the Atlas's", () => {
    const cleared = writeAtlasUrl("select=a&snapshot=s&lens=in&q=x&kind=area&tl=main", {
      select: null,
      snapshot: null,
      lens: { direction: "out", kind: null },
      q: "  ",
      kind: null,
    });
    expect(cleared.toString()).toBe("tl=main");
    expect(readAtlasUrl("")).toEqual({
      select: null,
      snapshot: null,
      lens: { direction: "out", kind: null },
      q: "",
      kind: null,
    });
  });

  test("ignores what it can't trust: unknown lens directions, kinds and filters", () => {
    expect(parseLens("sideways:imports")).toEqual({ direction: "out", kind: null });
    expect(parseLens("in:Drop Table")).toEqual({ direction: "in", kind: null });
    expect(parseLens("in")).toEqual({ direction: "in", kind: null });
    expect(readAtlasUrl("kind=package&select=%20x").kind).toBeNull();
    expect(readAtlasUrl("select=%20x").select).toBeNull();
  });

  test("links into the Atlas carry the rest of the address", () => {
    expect(atlasHref("/o/r/atlas", { select: "cap:1", snapshot: "s" }, "tl=launch")).toBe(
      "/o/r/atlas?tl=launch&select=cap%3A1&snapshot=s",
    );
    expect(atlasHref("/o/r/atlas", { snapshot: null }, "snapshot=s")).toBe("/o/r/atlas");
  });
});

describe("the path a deep link opens", () => {
  const e = (id: string, kind: string, parentId: string | null): AtlasEntitySummary => ({
    id,
    kind,
    parentId,
    name: id,
    path: null,
    summary: "",
    counts: {},
    structural: false,
  });
  test("is every ancestor below the root, then the entity if it holds others", () => {
    const chain = [
      e("repo", "repository", null),
      e("cap:1", "capability", "repo"),
      e("area:1", "area", "cap:1"),
    ];
    expect(pathToOpen(e("file:a.ts", "file", "area:1"), chain)).toEqual(["cap:1", "area:1"]);
    expect(pathToOpen(e("area:1", "area", "cap:1"), chain.slice(0, 2))).toEqual([
      "cap:1",
      "area:1",
    ]);
  });
});
