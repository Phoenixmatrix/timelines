import { describe, expect, test } from "vite-plus/test";
import { splitRefPath } from "./objects.ts";

describe("splitRefPath", () => {
  const names = ["main", "jun/feature"];
  const oid = "d4ab1d76ba279828d6bee91662507022755f3a7f";

  test("finds a plain branch and path", () => {
    expect(splitRefPath("main/src/index.js", names)).toEqual({ ref: "main", path: "src/index.js" });
  });

  test("prefers the longest branch name that matches", () => {
    expect(splitRefPath("jun/feature/src", names)).toEqual({ ref: "jun/feature", path: "src" });
    expect(splitRefPath("jun/feature", names)).toEqual({ ref: "jun/feature", path: "" });
  });

  test("falls back to the first segment for commit ids and unknown refs", () => {
    expect(splitRefPath(`${oid}/readme.md`, names)).toEqual({ ref: oid, path: "readme.md" });
  });

  test("does not match a branch that is only a string prefix", () => {
    expect(splitRefPath("mainline/x", names)).toEqual({ ref: "mainline", path: "x" });
  });

  test("an empty tail means the default branch", () => {
    expect(splitRefPath("", names)).toEqual({ ref: "", path: "" });
  });
});
