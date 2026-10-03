import { describe, expect, test } from "vite-plus/test";
import { linesLabel, whyPath } from "./WhyPanel.tsx";

describe("why panel", () => {
  test("asks about the selection at the commit on screen", () => {
    const oid = "a".repeat(40);
    expect(whyPath("orbit", "app", "src/a b.ts", oid, 3, 3)).toBe(
      `/repos/orbit/app/why?path=src%2Fa%20b.ts&line=3&rev=${oid}`,
    );
    expect(whyPath("orbit", "app", "x.ts", oid, 3, 9)).toContain("&line=3-9&");
  });

  test("names the lines a commit explains", () => {
    expect(linesLabel([4])).toBe("line 4");
    expect(linesLabel([5, 4, 6])).toBe("lines 4–6");
    expect(linesLabel([3, 7, 9])).toBe("lines 3, 7 and 9");
    expect(linesLabel([1, 3, 5, 7, 9, 11, 13, 15])).toBe("lines 1, 3, 5, 7, 9, 11 and 2 more");
  });
});
