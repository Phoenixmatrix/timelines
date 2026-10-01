import { describe, expect, test } from "vite-plus/test";
import { DELIM, FLUSH, parseLsRefs, parsePktLines, pkt } from "./pktline.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("pkt", () => {
  test("prefixes the length including the four header bytes", () => {
    expect(pkt("a\n")).toBe("0006a\n");
    expect(pkt("command=ls-refs\n")).toBe("0014command=ls-refs\n");
  });
});

describe("parsePktLines", () => {
  test("reads data, delimiter and flush packets", () => {
    const lines = [...parsePktLines(bytes(pkt("one\n") + DELIM + pkt("two\n") + FLUSH))];
    expect(lines.map((line) => line.type)).toEqual(["data", "delim", "data", "flush"]);
  });

  test("rejects truncated input", () => {
    expect(() => [...parsePktLines(bytes("000ahi"))]).toThrow(/Truncated/);
  });
});

describe("parseLsRefs", () => {
  const head = "c8f86c1a4b2a3f0e9d8c7b6a5f4e3d2c1b0a9f8e";
  const tag = "1111111111111111111111111111111111111111";

  test("reads refs, symrefs and peeled tags", () => {
    const response =
      pkt(`${head} HEAD symref-target:refs/heads/main\n`) +
      pkt(`${head} refs/heads/main\n`) +
      pkt(`${tag} refs/tags/v1.0 peeled:${head}\n`) +
      FLUSH;
    expect(parseLsRefs(bytes(response))).toEqual([
      { oid: head, name: "HEAD", symrefTarget: "refs/heads/main" },
      { oid: head, name: "refs/heads/main" },
      { oid: tag, name: "refs/tags/v1.0", peeled: head },
    ]);
  });

  test("reads an unborn HEAD in an empty repository", () => {
    const response = pkt("unborn HEAD symref-target:refs/heads/main\n") + FLUSH;
    expect(parseLsRefs(bytes(response))).toEqual([
      { oid: null, name: "HEAD", symrefTarget: "refs/heads/main" },
    ]);
  });

  test("surfaces server errors", () => {
    expect(() => parseLsRefs(bytes(pkt("ERR access denied\n")))).toThrow("git: access denied");
  });
});
