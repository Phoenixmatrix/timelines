import { describe, expect, test } from "vite-plus/test";
import type { RepoDetail } from "../../../shared/api.ts";
import { refCommit } from "./CommitCi.tsx";

const oid = (c: string) => c.repeat(40);
const repo = {
  branches: [{ name: "refs/heads/main", shortName: "main", kind: "branch", oid: oid("a") }],
  tags: [{ name: "refs/tags/v1", shortName: "v1", kind: "tag", oid: oid("b") }],
} as unknown as RepoDetail;

describe("the commit whose CI the ref bar shows", () => {
  test("is a branch's or tag's head", () => {
    expect(refCommit(repo, "main")).toBe(oid("a"));
    expect(refCommit(repo, "v1")).toBe(oid("b"));
  });
  test("is the commit itself when browsing by id, and nothing for unknown refs", () => {
    expect(refCommit(repo, oid("c"))).toBe(oid("c"));
    expect(refCommit(repo, "gone")).toBeNull();
    expect(refCommit(repo, "abc1234")).toBeNull();
  });
});
