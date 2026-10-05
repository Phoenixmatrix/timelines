import { expect, test } from "vite-plus/test";
import type { CommitTarget, RepoTarget } from "../../shared/refs.ts";
import { refContextFromPath, refHref } from "./context.ts";

test("the address implies the ref context", () => {
  expect(refContextFromPath("/orbit/engine/commits/main")).toEqual({
    owner: "orbit",
    repo: "engine",
  });
  expect(refContextFromPath("/orbit/engine")).toEqual({ owner: "orbit", repo: "engine" });
  expect(refContextFromPath("/orbit")).toEqual({ owner: "orbit" });
  expect(refContextFromPath("/orbit/-/packages/npm/ui")).toEqual({ owner: "orbit" });
  expect(refContextFromPath("/tracker/orbit/issues/ENG-1")).toEqual({ tracker: "orbit" });
  expect(refContextFromPath("/tracker")).toEqual({});
  expect(refContextFromPath("/settings/tokens")).toEqual({});
  expect(refContextFromPath("/-/go/ENG-1")).toEqual({});
  expect(refContextFromPath("/")).toEqual({});
});

test("a commit opens its panel over the current page inside its repository", () => {
  const target: CommitTarget = {
    kind: "commit",
    path: `/orbit/engine?commit=${"a".repeat(40)}`,
    label: "Commit aaaaaaa in orbit/engine",
    owner: "orbit",
    repo: "engine",
    sha: "a".repeat(40),
  };
  expect(refHref(target, { pathname: "/orbit/engine/ci/12", search: "?tab=logs&commit=b" })).toBe(
    `/orbit/engine/ci/12?tab=logs&commit=${"a".repeat(40)}`,
  );
  // Elsewhere: over the repository's home.
  expect(refHref(target, { pathname: "/tracker/orbit", search: "" })).toBe(target.path);
  expect(refHref(target, { pathname: "/orbit/website", search: "" })).toBe(target.path);
  const repo: RepoTarget = {
    kind: "repo",
    path: "/orbit/engine",
    label: "orbit/engine",
    owner: "orbit",
    name: "engine",
  };
  expect(refHref(repo, { pathname: "/orbit/engine/ci", search: "" })).toBe("/orbit/engine");
});
