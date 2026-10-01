import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";

import { createHasher, resumeHasher, toHex } from "./index.ts";

function reference(algo: "sha1" | "sha256", data: Uint8Array): string {
  return createHash(algo).update(data).digest("hex");
}

describe("resumable hashers", () => {
  const data = new Uint8Array(200_003).map((_, i) => (i * 31 + 7) & 0xff);

  for (const algo of ["sha1", "sha256"] as const) {
    it(`${algo} matches node:crypto`, () => {
      const hasher = createHasher(algo);
      hasher.update(data);
      expect(toHex(hasher.digest())).toBe(reference(algo, data));
    });

    it(`${algo} survives export/import at odd offsets`, () => {
      let hasher = createHasher(algo);
      let at = 0;
      for (const size of [1, 63, 64, 65, 1000, 4097, 77_777]) {
        hasher.update(data.subarray(at, at + size));
        at += size;
        hasher = resumeHasher(JSON.parse(JSON.stringify(hasher.exportState())));
      }
      hasher.update(data.subarray(at));
      expect(toHex(hasher.digest())).toBe(reference(algo, data));
    });
  }

  it("hashes the empty input", () => {
    expect(toHex(createHasher("sha256").digest())).toBe(reference("sha256", new Uint8Array()));
  });
});
