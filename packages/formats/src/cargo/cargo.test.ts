import { describe, expect, it } from "vite-plus/test";

import {
  buildIndexLine,
  CargoProtocolError,
  compareVersions,
  crateNameError,
  encodePublishBody,
  expandDlTemplate,
  indexPath,
  maxVersion,
  mergeIndexFiles,
  nameFromIndexPath,
  normalizeCrateName,
  parseIndexFile,
  parsePublishMetadata,
  readPublishBody,
  validVersion,
} from "./index.ts";

function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("crate names", () => {
  it("follows crates.io rules", () => {
    expect(crateNameError("serde_json")).toBeNull();
    expect(crateNameError("Foo-Bar2")).toBeNull();
    expect(crateNameError("1abc")).not.toBeNull();
    expect(crateNameError("-abc")).not.toBeNull();
    expect(crateNameError("a.b")).not.toBeNull();
    expect(crateNameError("nul")).not.toBeNull();
    expect(crateNameError("NUL")).not.toBeNull();
    expect(crateNameError("a".repeat(65))).not.toBeNull();
    expect(crateNameError("")).not.toBeNull();
  });

  it("normalizes case and separators", () => {
    expect(normalizeCrateName("Foo_Bar")).toBe("foo-bar");
    expect(normalizeCrateName("foo-bar")).toBe("foo-bar");
  });
});

describe("versions", () => {
  it("validates semver", () => {
    expect(validVersion("1.0.0")).toBe(true);
    expect(validVersion("1.0.0-alpha.1+build.5")).toBe(true);
    expect(validVersion("1.0")).toBe(false);
    expect(validVersion("v1.0.0")).toBe(false);
    expect(validVersion("01.0.0")).toBe(false);
  });

  it("orders by precedence and prefers stable releases", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-alpha.2", "1.0.0-alpha.10")).toBe(-1);
    expect(compareVersions("1.0.0+a", "1.0.0+b")).toBe(0);
    expect(maxVersion(["0.9.0", "1.0.0", "2.0.0-beta.1"])).toBe("1.0.0");
    expect(maxVersion(["2.0.0-beta.1"])).toBe("2.0.0-beta.1");
  });
});

describe("index paths", () => {
  it("computes the sparse layout", () => {
    expect(indexPath("a")).toBe("1/a");
    expect(indexPath("ab")).toBe("2/ab");
    expect(indexPath("abc")).toBe("3/a/abc");
    expect(indexPath("Serde")).toBe("se/rd/serde");
  });

  it("parses only well-formed paths", () => {
    expect(nameFromIndexPath("se/rd/serde")).toBe("serde");
    expect(nameFromIndexPath("3/a/abc")).toBe("abc");
    expect(nameFromIndexPath("1/a")).toBe("a");
    expect(nameFromIndexPath("se/xx/serde")).toBeNull();
    expect(nameFromIndexPath("Se/rd/Serde")).toBeNull();
    expect(nameFromIndexPath("config.json")).toBeNull();
  });
});

describe("index lines", () => {
  const meta = parsePublishMetadata({
    name: "demo",
    vers: "0.1.0",
    deps: [
      {
        name: "serde",
        version_req: "^1.0",
        features: ["derive"],
        optional: false,
        default_features: true,
        target: null,
        kind: "normal",
        registry: "https://github.com/rust-lang/crates.io-index",
        explicit_name_in_toml: null,
      },
      {
        name: "real-name",
        version_req: "=0.2.0",
        features: [],
        optional: true,
        default_features: false,
        target: "cfg(unix)",
        kind: "build",
        registry: "sparse+https://pkg.test/cargo/crates/index/",
        explicit_name_in_toml: "alias",
      },
    ],
    features: { default: ["std"], std: [], json: ["dep:alias", "serde?/std"] },
    links: "z",
    rust_version: "1.70",
  });

  it("maps publish deps to index deps", () => {
    const line = buildIndexLine(meta, "ab".repeat(32), {
      ownIndexUrls: ["https://pkg.test/cargo/crates/index"],
    });
    expect(line.deps).toEqual([
      {
        name: "alias",
        package: "real-name",
        req: "=0.2.0",
        features: [],
        optional: true,
        default_features: false,
        target: "cfg(unix)",
        kind: "build",
      },
      {
        name: "serde",
        req: "^1.0",
        features: ["derive"],
        optional: false,
        default_features: true,
        target: null,
        kind: "normal",
        registry: "https://github.com/rust-lang/crates.io-index",
      },
    ]);
    expect(line.features).toEqual({ default: ["std"], std: [] });
    expect(line.features2).toEqual({ json: ["dep:alias", "serde?/std"] });
    expect(line.v).toBe(2);
    expect(line.links).toBe("z");
    expect(line.rust_version).toBe("1.70");
    expect(line.yanked).toBe(false);
  });

  it("rejects invalid metadata", () => {
    expect(() => parsePublishMetadata({ name: "nul", vers: "1.0.0" })).toThrow(CargoProtocolError);
    expect(() => parsePublishMetadata({ name: "ok", vers: "1.0" })).toThrow(/semver/);
    expect(() =>
      parsePublishMetadata({ name: "ok", vers: "1.0.0", deps: [{ name: "x", kind: "weird" }] }),
    ).toThrow(/kind/);
  });

  it("merges index files, first version wins", () => {
    const a = `${JSON.stringify({ name: "x", vers: "1.0.0", cksum: "a" })}\n`;
    const b = `${JSON.stringify({ name: "x", vers: "1.0.0", cksum: "b" })}\n${JSON.stringify({ name: "x", vers: "1.1.0", cksum: "c" })}\nnot json\n`;
    const merged = parseIndexFile(mergeIndexFiles([a, b]));
    expect(merged.map((l) => [l.vers, l.cksum])).toEqual([
      ["1.0.0", "a"],
      ["1.1.0", "c"],
    ]);
  });
});

describe("dl templates", () => {
  it("appends the default suffix without markers", () => {
    expect(expandDlTemplate("https://h/api/v1/crates", { name: "Foo", version: "1.0.0" })).toBe(
      "https://h/api/v1/crates/Foo/1.0.0/download",
    );
  });

  it("expands every marker", () => {
    expect(
      expandDlTemplate(
        "https://h/{prefix}/{lowerprefix}/{crate}-{version}.crate?c={sha256-checksum}",
        {
          name: "Serde",
          version: "1.0.0",
          cksum: "abc",
        },
      ),
    ).toBe("https://h/Se/rd/se/rd/Serde-1.0.0.crate?c=abc");
  });
});

describe("publish body framing", () => {
  const crate = new Uint8Array(10_000).map((_, i) => i % 251);
  const body = encodePublishBody({ name: "demo", vers: "1.0.0" }, crate);

  it("splits metadata and streams the crate across chunk boundaries", async () => {
    for (const size of [1, 7, 4096, body.length]) {
      const parsed = await readPublishBody(chunked(body, size));
      expect(parsed.metadata).toEqual({ name: "demo", vers: "1.0.0" });
      expect(parsed.crateLength).toBe(crate.length);
      expect(await collect(parsed.crate)).toEqual(crate);
    }
  });

  it("caps the metadata size", async () => {
    await expect(readPublishBody(chunked(body, 64), { maxJsonBytes: 10 })).rejects.toThrow(
      /larger than/,
    );
  });

  it("fails on truncated bodies and trailing data", async () => {
    const short = await readPublishBody(chunked(body.slice(0, body.length - 1), 1000));
    await expect(collect(short.crate)).rejects.toThrow(/ended inside the crate/);
    const long = new Uint8Array(body.length + 3);
    long.set(body);
    const extra = await readPublishBody(chunked(long, 1000));
    await expect(collect(extra.crate)).rejects.toThrow(/after the crate/);
    await expect(readPublishBody(chunked(body.slice(0, 6), 2))).rejects.toThrow(/metadata/);
  });
});
