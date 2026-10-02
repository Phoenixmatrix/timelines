import { describe, expect, it } from "vite-plus/test";
import { lineAnchor, parseLineAnchor } from "./lineAnchors.ts";

describe("source line anchors", () => {
  it.each([
    ["#L12", { start: 12, end: 12 }],
    ["#L12-L20", { start: 12, end: 20 }],
    ["#L20-L12", { start: 12, end: 20 }],
    ["#L12-L12", { start: 12, end: 12 }],
    ["#L0012", { start: 12, end: 12 }],
    ["#L12-L200", { start: 12, end: 100 }],
  ])("parses %s within the rendered file", (hash, expected) => {
    expect(parseLineAnchor(hash, 100)).toEqual(expected);
  });

  it.each([
    "",
    "#",
    "#L0",
    "#L-1",
    "#L1-L0",
    "#L1.5",
    "#L1e2",
    "#L1-L2-extra",
    "#L1-2",
    "#l1",
    "#L101",
    "#L200-L101",
    "#L9007199254740992",
    "#L1-L9007199254740992",
  ])("rejects malformed or unavailable selection %s", (hash) => {
    expect(parseLineAnchor(hash, 100)).toBeNull();
  });

  it.each([0, -1, Number.NaN, Infinity, 1.5])(
    "does not select lines in an invalid line count %s",
    (count) => {
      expect(parseLineAnchor("#L1", count)).toBeNull();
    },
  );

  it.each([
    [12, 12, "#L12"],
    [12, 20, "#L12-L20"],
    [20, 12, "#L12-L20"],
    [1, Number.MAX_SAFE_INTEGER, `#L1-L${Number.MAX_SAFE_INTEGER}`],
  ])("builds and round-trips %s through %s", (first, last, hash) => {
    expect(lineAnchor(first, last)).toBe(hash);
    expect(parseLineAnchor(hash, Number.MAX_SAFE_INTEGER)).toEqual({
      start: Math.min(first, last),
      end: Math.max(first, last),
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid line %s when building links",
    (line) => {
      expect(() => lineAnchor(line)).toThrow(RangeError);
      expect(() => lineAnchor(1, line)).toThrow(RangeError);
    },
  );
});
