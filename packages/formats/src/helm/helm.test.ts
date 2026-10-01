import { describe, expect, it } from "vite-plus/test";

import { gzipSync, writeTar } from "../archive/index.ts";
import {
  ChartError,
  buildIndex,
  compareChartVersions,
  mergeIndexes,
  multipartBoundary,
  parseChartFilename,
  parseChartYaml,
  parseIndex,
  parseMultipart,
  parseProvenance,
  readChartArchive,
  serializeIndex,
  type ChartVersion,
} from "./index.ts";

const chartTgz = (chartYaml: string, dir = "mychart") =>
  gzipSync(
    writeTar([
      { name: `${dir}/Chart.yaml`, data: chartYaml },
      { name: `${dir}/values.yaml`, data: "replicas: 1\n" },
      { name: `${dir}/charts/sub/Chart.yaml`, data: "apiVersion: v2\nname: sub\nversion: 9.9.9\n" },
    ]),
  );

describe("Chart.yaml", () => {
  it("reads and validates a packaged chart", () => {
    const meta = readChartArchive(
      chartTgz("apiVersion: v2\nname: mychart\nversion: 1.2.3\nappVersion: 1.0\nextra: nope\n"),
    );
    expect(meta).toEqual({
      apiVersion: "v2",
      name: "mychart",
      version: "1.2.3",
      appVersion: "1.0",
    });
  });

  it("rejects bad names, versions and api versions", () => {
    expect(() => parseChartYaml("apiVersion: v2\nname: ../x\nversion: 1.0.0")).toThrow(ChartError);
    expect(() => parseChartYaml("apiVersion: v2\nname: x\nversion: 1.0")).toThrow(/SemVer/);
    expect(() => parseChartYaml("apiVersion: v3\nname: x\nversion: 1.0.0")).toThrow(/apiVersion/);
    expect(parseChartYaml("name: legacy\nversion: 0.1.0").apiVersion).toBe("v1");
  });

  it("rejects archives without a top-level Chart.yaml", () => {
    const tgz = gzipSync(writeTar([{ name: "a/b/Chart.yaml", data: "name: x" }]));
    expect(() => readChartArchive(tgz)).toThrow(/Chart.yaml/);
    expect(() => readChartArchive(new TextEncoder().encode("not gzip at all..."))).toThrow(
      /gzipped/,
    );
  });

  it("refuses archives that expand past the cap", () => {
    expect(() =>
      readChartArchive(chartTgz("name: x\nversion: 1.0.0"), { maxUncompressed: 100 }),
    ).toThrow(/expands/);
  });
});

describe("index.yaml", () => {
  const entry = (name: string, version: string, url = `${name}-${version}.tgz`): ChartVersion => ({
    apiVersion: "v2",
    name,
    version,
    urls: [url],
    digest: "0".repeat(64),
  });

  it("builds a sorted index and round-trips it", () => {
    const index = buildIndex(
      [entry("b", "1.0.0"), entry("a", "1.0.0"), entry("a", "1.10.0"), entry("a", "1.2.0-rc.1")],
      "2026-01-01T00:00:00.000Z",
    );
    expect(Object.keys(index.entries)).toEqual(["a", "b"]);
    expect(index.entries.a!.map((v) => v.version)).toEqual(["1.10.0", "1.2.0-rc.1", "1.0.0"]);
    const text = serializeIndex(index);
    expect(text).toMatch(/^apiVersion: v1\nentries:\n {2}a:\n/);
    expect(parseIndex(text)).toEqual(index);
  });

  it("merges first-owner-wins or with mergeVersions", () => {
    const one = buildIndex([entry("a", "1.0.0")], "2026-01-01T00:00:00Z");
    const two = buildIndex([entry("a", "2.0.0"), entry("b", "1.0.0")], "2026-02-01T00:00:00Z");
    const owned = mergeIndexes([one, two]);
    expect(owned.entries.a!.map((v) => v.version)).toEqual(["1.0.0"]);
    expect(owned.entries.b).toHaveLength(1);
    expect(owned.generated).toBe("2026-02-01T00:00:00Z");
    const merged = mergeIndexes([one, two], { mergeVersions: true });
    expect(merged.entries.a!.map((v) => v.version)).toEqual(["2.0.0", "1.0.0"]);
  });

  it("orders versions newest first", () => {
    expect(["1.0.0", "2.0.0-beta.1", "2.0.0", "garbage"].sort(compareChartVersions)).toEqual([
      "2.0.0",
      "2.0.0-beta.1",
      "1.0.0",
      "garbage",
    ]);
  });

  it("drops malformed entries", () => {
    const index = parseIndex("apiVersion: v1\nentries:\n  x:\n    - version: 1.0.0\n  y: nope\n");
    expect(index.entries).toEqual({});
  });
});

describe("uploads", () => {
  it("parses chart filenames", () => {
    expect(parseChartFilename("my-chart-1.2.3-rc.1.tgz")).toEqual({
      name: "my-chart",
      version: "1.2.3-rc.1",
    });
    expect(parseChartFilename("nope.tgz")).toBeNull();
  });

  it("parses multipart bodies", () => {
    const boundary = "XyZ";
    const body = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="chart"; filename="c.tgz"\r\nContent-Type: application/gzip\r\n\r\nCHART\r\nBYTES\r\n--${boundary}\r\nContent-Disposition: form-data; name="prov"\r\n\r\nPROV\r\n--${boundary}--\r\n`,
    );
    expect(multipartBoundary(`multipart/form-data; boundary="${boundary}"`)).toBe(boundary);
    const parts = parseMultipart(body, boundary);
    expect(parts.map((p) => [p.name, p.filename, new TextDecoder().decode(p.data)])).toEqual([
      ["chart", "c.tgz", "CHART\r\nBYTES"],
      ["prov", null, "PROV"],
    ]);
  });

  it("reads the chart out of a provenance file", () => {
    const prov = `-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA512\n\napiVersion: v2\nname: mychart\nversion: 0.1.0\n\n...\nfiles:\n  mychart-0.1.0.tgz: sha256:abc\n-----BEGIN PGP SIGNATURE-----\n\nxx\n-----END PGP SIGNATURE-----\n`;
    expect(parseProvenance(prov)).toEqual({ name: "mychart", version: "0.1.0" });
    expect(parseProvenance("garbage")).toBeNull();
  });
});
