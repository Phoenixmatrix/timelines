import { describe, expect, test } from "vite-plus/test";
import { issueKeys } from "./keys.ts";

describe("issue keys in commit messages", () => {
  test("finds keys wherever the repo's conventions put them, once each, in order", () => {
    expect(issueKeys("Match the Create button height (CORE-13)")).toEqual(["CORE-13"]);
    expect(issueKeys("CORE-15: tracker leases\n\nAlso fixes ENG2-7 and CORE-15.")).toEqual([
      "CORE-15",
      "ENG2-7",
    ]);
    expect(issueKeys("[OPS-1] [OPS-2], see OPS-1")).toEqual(["OPS-1", "OPS-2"]);
  });

  test("skips lowercase, embedded, zero-padded and malformed lookalikes", () => {
    expect(issueKeys("core-13 Core-13 XCORE_1-2 aCORE-3 CORE-013 CORE-0 C-1")).toEqual([]);
    expect(issueKeys("CORE-13a CORE-13_x my-CORE-4 TOOLONG-5")).toEqual([]);
  });

  test("keeps key-shaped words for resolution to discard", () => {
    expect(issueKeys("Decode UTF-8 and SHA2-256 safely")).toEqual(["UTF-8", "SHA2-256"]);
  });
});
