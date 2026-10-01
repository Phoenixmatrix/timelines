import { describe, expect, it } from "vite-plus/test";

import {
  assetNameError,
  compareTags,
  renderSha256Sums,
  selectLatest,
  validProjectName,
  validTag,
} from "./index.ts";

describe("release names", () => {
  it("validates projects, tags and assets", () => {
    expect(validProjectName("my-tool")).toBe(true);
    expect(validProjectName("My-Tool")).toBe(false);
    expect(validProjectName("-tool")).toBe(false);
    expect(validTag("v1.2.3")).toBe(true);
    expect(validTag("1.0.0+build.1")).toBe(true);
    expect(validTag("latest")).toBe(false);
    expect(validTag("v1/2")).toBe(false);
    expect(assetNameError("tool-linux-amd64.tar.gz")).toBeNull();
    expect(assetNameError("a/b")).not.toBeNull();
    expect(assetNameError("..")).not.toBeNull();
    expect(assetNameError("x".repeat(256))).not.toBeNull();
    expect(assetNameError("bad\nname")).not.toBeNull();
  });
});

describe("latest selection", () => {
  const r = (tag: string, publishedAt: string | null, draft = false, prerelease = false) => ({
    tag,
    publishedAt,
    draft,
    prerelease,
  });

  it("skips drafts and prereleases and picks the newest", () => {
    const latest = selectLatest([
      r("v1.0.0", "2026-01-01T00:00:00.000Z"),
      r("v1.1.0", "2026-02-01T00:00:00.000Z"),
      r("v2.0.0-rc.1", "2026-03-01T00:00:00.000Z", false, true),
      r("v2.0.0", null, true),
    ]);
    expect(latest?.tag).toBe("v1.1.0");
  });

  it("breaks publication-time ties by semver", () => {
    const at = "2026-01-01T00:00:00.000Z";
    expect(selectLatest([r("v1.10.0", at), r("v1.9.0", at)])?.tag).toBe("v1.10.0");
    expect(selectLatest([r("v1.9.0", at), r("v1.10.0", at)])?.tag).toBe("v1.10.0");
    expect(selectLatest([])).toBeNull();
  });

  it("compares tags semver-aware", () => {
    expect(compareTags("v1.10.0", "v1.9.0")).toBe(1);
    expect(compareTags("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareTags("nightly", "v1.0.0")).toBe(-1);
  });
});

describe("SHA256SUMS", () => {
  it("renders sha256sum format sorted by name", () => {
    expect(
      renderSha256Sums([
        { name: "b.tgz", sha256: "22" },
        { name: "a.zip", sha256: "11" },
      ]),
    ).toBe("11  a.zip\n22  b.tgz\n");
  });
});
