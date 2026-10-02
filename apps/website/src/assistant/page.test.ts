import { describe, expect, test } from "vite-plus/test";
import { contextFor, contextLabel } from "./page.ts";
import { suggestionsFor } from "./suggestions.ts";

describe("page context", () => {
  test("a file with selected lines, an issue, a run", () => {
    const file = contextFor("/orbit/app/blob/main/src/a.ts", "#L3-L9", [
      {
        params: { owner: "orbit", repo: "app", "*": "main/src/a.ts" },
        data: { blob: { ref: "main", path: "src/a.ts" } },
      },
    ]);
    expect(file).toMatchObject({ repo: "orbit/app", ref: "main", file: "src/a.ts", lines: "3-9" });
    expect(contextLabel(file)).toBe("a.ts · L3-9");
    const issue = contextFor("/tracker/orbit/issues/CORE-25", "", []);
    expect(issue).toMatchObject({ tracker: "orbit", issue: "CORE-25" });
    expect(suggestionsFor(issue)[0]).toContain("CORE-25");
    const run = contextFor("/orbit/app/ci/44", "", [
      { params: { owner: "orbit", repo: "app", number: "44" }, data: null },
    ]);
    expect(run).toMatchObject({ repo: "orbit/app", run: 44 });
    expect(contextLabel(contextFor("/", "", []))).toBeNull();
  });
});
