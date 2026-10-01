import { describe, expect, test } from "vite-plus/test";
import { encodePath, splitRefAndPath, treeUrl } from "./refs.ts";

const oid = "d4ab1d76ba279828d6bee91662507022755f3a7f";
const ref = (shortName: string) => ({
  name: `refs/heads/${shortName}`,
  shortName,
  kind: "branch" as const,
  oid,
});
const repo = { branches: [ref("main"), ref("jun/feature")], tags: [] };

describe("splitRefAndPath", () => {
  test("finds a plain branch and path", () => {
    expect(splitRefAndPath("main/src/index.js", repo)).toEqual({
      ref: "main",
      path: "src/index.js",
    });
  });

  test("prefers the longest branch name that matches", () => {
    expect(splitRefAndPath("jun/feature/src", repo)).toEqual({ ref: "jun/feature", path: "src" });
    expect(splitRefAndPath("jun/feature", repo)).toEqual({ ref: "jun/feature", path: "" });
  });

  test("falls back to the first segment for commit ids and unknown refs", () => {
    expect(splitRefAndPath(`${oid}/readme.md`, repo)).toEqual({ ref: oid, path: "readme.md" });
  });

  test("does not match a branch that is only a string prefix", () => {
    expect(splitRefAndPath("mainline/x", repo)).toEqual({ ref: "mainline", path: "x" });
  });
});

test("URLs keep slashes but encode each segment", () => {
  expect(encodePath("docs/a b#1.md")).toBe("docs/a%20b%231.md");
  expect(treeUrl("orbit", "engine", "jun/feature", "src")).toBe(
    "/orbit/engine/tree/jun/feature/src",
  );
});
