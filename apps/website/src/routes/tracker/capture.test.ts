import { expect, test } from "vite-plus/test";
import { parseCaptureTitle } from "./capture.ts";

test("leading tags use catalog spelling and deduplicate without changing title parentheses", () => {
  expect(
    parseCaptureTitle(" (BUG) ( needs docs ) (bug) Fix save (on mobile) ", ["Bug", "needs docs"]),
  ).toEqual({
    title: "Fix save (on mobile)",
    labels: ["Bug", "needs docs"],
    unknown: [],
    error: null,
  });
});

test("unknown tags require definition and incomplete groups stay in the title", () => {
  expect(parseCaptureTitle("(new) (NEW) Investigate", [])).toEqual({
    title: "Investigate",
    labels: [],
    unknown: ["new"],
    error: null,
  });
  expect(parseCaptureTitle("(known) (incomplete title", ["known"])).toEqual({
    title: "(incomplete title",
    labels: ["known"],
    unknown: [],
    error: null,
  });
  expect(parseCaptureTitle("Check (known) after save", ["known"])).toEqual({
    title: "Check (known) after save",
    labels: [],
    unknown: [],
    error: null,
  });
});

test("invalid tag names are rejected and tags alone do not become a title", () => {
  for (const label of ["", " ", "x".repeat(101), "bad\0tag"]) {
    expect(parseCaptureTitle(`(${label}) Fix`, []).error).toBe(
      "Tags must be 1–100 characters without NUL.",
    );
  }
  expect(parseCaptureTitle("(known)", ["known"])).toEqual({
    title: "",
    labels: ["known"],
    unknown: [],
    error: null,
  });
});
