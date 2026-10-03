import { describe, expect, test } from "vite-plus/test";
import { readCompareUrl, writeCompareUrl } from "./atlasCompare.ts";
import { readAtlasUrl, writeAtlasUrl } from "./atlasUrl.ts";

describe("a comparison's address", () => {
  test("round-trips the older snapshot, class and capability beside the Atlas's own keys", () => {
    const written = writeCompareUrl("select=cap%3Aa&snapshot=s-2&tl=launch", {
      compare: "s-1",
      changes: "regrouping",
      within: "cap:a",
    });
    expect(readCompareUrl(written)).toEqual({
      compare: "s-1",
      changes: "regrouping",
      within: "cap:a",
    });
    expect(written.get("tl")).toBe("launch");
    expect(readAtlasUrl(written)).toMatchObject({ select: "cap:a", snapshot: "s-2" });
    // Moving around the Atlas keeps the comparison.
    const moved = writeAtlasUrl(written, {
      select: "file:x.ts",
      lens: { direction: "in", kind: null },
    });
    expect(readCompareUrl(moved)).toEqual(readCompareUrl(written));
  });

  test("ignores what it doesn't understand and clears cleanly", () => {
    expect(readCompareUrl("compare=%20s&changes=vibes&within=")).toEqual({
      compare: null,
      changes: null,
      within: null,
    });
    const cleared = writeCompareUrl("compare=s-1&changes=source&within=cap%3Aa&tl=main", {
      compare: null,
      changes: null,
      within: null,
    });
    expect(cleared.toString()).toBe("tl=main");
  });
});
