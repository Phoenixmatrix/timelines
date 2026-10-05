import { describe, expect, test } from "vite-plus/test";
import { goPath, issueUrlParts, refKind, scanRefs, splitRefs } from "./refs.ts";

const refs = (text: string, commits = false) =>
  scanRefs(text, { commits }).map(({ ref, kind }) => `${kind}:${ref}`);

describe("scanRefs", () => {
  test("finds issue keys but not things in words", () => {
    expect(refs("Fix CORE-12 and ENG-3; not UTF-8x, x-CORE-1 or CORE-012")).toEqual([
      "issue:CORE-12",
      "issue:ENG-3",
    ]);
    // Looks like a key: only resolving drops it.
    expect(refs("UTF-8")).toEqual(["issue:UTF-8"]);
  });

  test("finds tracker issue URLs of any origin, whole", () => {
    expect(
      refs(
        "See https://gitmatrix.fward.dev/tracker/matrixorg/issues/CORE-22, and http://x.test:5180/tracker/a/issues/abc-1.",
      ),
    ).toEqual([
      "issue-url:https://gitmatrix.fward.dev/tracker/matrixorg/issues/CORE-22",
      "issue-url:http://x.test:5180/tracker/a/issues/abc-1",
    ]);
    // Inside someone else's address, nothing is a ref.
    expect(refs("https://linear.app/acme/issue/ENG-1 and www.x.test/orbit/engine")).toEqual([]);
  });

  test("finds owner/repo but not paths", () => {
    expect(refs("Moved to orbit/engine.")).toEqual(["repo:orbit/engine"]);
    expect(refs("Edit src/lib/refs.ts and ./a/b, or https://github.com/a/b")).toEqual([]);
    expect(refs("orbit/engine.git works")).toEqual(["repo:orbit/engine.git"]);
  });

  test("finds name@version, npm scopes included", () => {
    expect(refs("Ship @orbit/ui@1.2.0 and engine@v2.0.1-rc.1.")).toEqual([
      "package:@orbit/ui@1.2.0",
      "package:engine@v2.0.1-rc.1",
    ]);
    expect(refs("mail me@example.com")).toEqual([]);
  });

  test("finds hashes only where asked, and only plausible ones", () => {
    const text = "Reverts 3f2a9c1 (deadbeef0, 20261004, defaced) at 3f2a9c1b";
    expect(refs(text)).toEqual([]);
    expect(refs(text, true)).toEqual(["commit:3f2a9c1", "commit:deadbeef0", "commit:3f2a9c1b"]);
    const full = "a".repeat(40);
    expect(refs(`merge ${full}`, true)).toEqual([`commit:${full}`]);
    // Too long to be a hash.
    expect(refs(`x ${"a1".repeat(21)}`, true)).toEqual([]);
  });

  test("never overlaps: a URL wins over the key inside it", () => {
    expect(refs("https://h.test/tracker/o/issues/CORE-1")).toEqual([
      "issue-url:https://h.test/tracker/o/issues/CORE-1",
    ]);
  });
});

test("splitRefs keeps every character", () => {
  const text = "Fix CORE-1 in orbit/engine now";
  const pieces = splitRefs(text);
  expect(pieces.map((p) => p.text).join("")).toBe(text);
  expect(pieces.filter((p) => p.span).map((p) => p.text)).toEqual(["CORE-1", "orbit/engine"]);
});

test("refKind classifies a whole ref", () => {
  expect(refKind("CORE-1")).toBe("issue");
  expect(refKind("orbit/engine")).toBe("repo");
  expect(refKind("abc1234")).toBe("commit");
  expect(refKind("engine@1.0.0")).toBe("package");
  expect(refKind("CORE-1 and more")).toBeNull();
  expect(refKind("hello")).toBeNull();
});

test("issueUrlParts and goPath", () => {
  expect(issueUrlParts("https://h.test/tracker/orbit/issues/ENG-2")).toEqual({
    origin: "https://h.test",
    tracker: "orbit",
    issue: "ENG-2",
  });
  expect(issueUrlParts("https://h.test/orbit/engine")).toBeNull();
  expect(goPath("orbit/engine", { owner: "orbit" })).toBe("/-/go/orbit%2Fengine?owner=orbit");
});
