import { createHash } from "node:crypto";

import { encodePublishBody, parseIndexFile } from "@gitmatrix/formats/cargo";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeHarness, type Harness } from "../../testing/harness.ts";

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

function crateBytes(label: string): Uint8Array {
  return new TextEncoder().encode(`fake-crate-${label}`.repeat(50));
}

function meta(name: string, vers: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    vers,
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
        name: "helper-real",
        version_req: "0.2",
        features: [],
        optional: true,
        default_features: true,
        target: null,
        kind: "normal",
        registry: null,
        explicit_name_in_toml: "helper",
      },
    ],
    features: { default: [], extra: ["dep:helper"] },
    authors: ["Someone"],
    description: `The ${name} crate`,
    license: "MIT",
    readme: "# Hello",
    links: null,
    ...extra,
  };
}

function publish(h: Harness, repo: string, token: string, body: Uint8Array) {
  return h.request(`/cargo/${repo}/api/v1/crates/new`, {
    method: "PUT",
    // cargo sends the raw token with no scheme.
    headers: { authorization: token },
    body,
  });
}

describe("cargo local repositories", () => {
  let h: Harness;
  let writer: string;

  beforeEach(async () => {
    h = await makeHarness();
    await h.createRepo({ key: "crates", format: "cargo", kind: "local", visibility: "private" });
    writer = h.token("bob");
    await h.request("/api/v1/repositories/crates/permissions", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${await h.adminToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ principal: "user:bob", role: "write" }),
    });
  });

  it("serves config.json anonymously and challenges index reads", async () => {
    const config = await h.request("/cargo/crates/index/config.json");
    expect(config.status).toBe(200);
    expect(await config.json()).toEqual({
      dl: "https://pkg.test/cargo/crates/api/v1/crates",
      api: "https://pkg.test/cargo/crates",
      "auth-required": true,
    });

    const index = await h.request("/cargo/crates/index/de/mo/demo");
    expect(index.status).toBe(401);
    expect(index.headers.get("www-authenticate")).toBe(
      'Cargo login_url="https://pkg.test/settings/tokens"',
    );
    expect(await index.json()).toEqual({ errors: [{ detail: "Authentication required" }] });
  });

  it("publishes, indexes, downloads, yanks and searches", async () => {
    const crate = crateBytes("demo");
    const res = await publish(
      h,
      "crates",
      writer,
      encodePublishBody(meta("Demo_Crate", "0.1.0"), crate),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      warnings: { invalid_categories: [], invalid_badges: [], other: [] },
    });
    await publish(
      h,
      "crates",
      writer,
      encodePublishBody(meta("Demo_Crate", "0.2.0"), crateBytes("2")),
    );

    const index = await h.request("/cargo/crates/index/de/mo/demo_crate", {
      headers: { authorization: writer },
    });
    expect(index.status).toBe(200);
    const lines = parseIndexFile(await index.text());
    expect(lines.map((l) => l.vers)).toEqual(["0.1.0", "0.2.0"]);
    const first = lines[0]!;
    expect(first.name).toBe("Demo_Crate");
    expect(first.cksum).toBe(sha256(crate));
    expect(first.yanked).toBe(false);
    expect(first.v).toBe(2);
    expect(first.features2).toEqual({ extra: ["dep:helper"] });
    expect(first.deps).toEqual([
      {
        name: "helper",
        package: "helper-real",
        req: "0.2",
        features: [],
        optional: true,
        default_features: true,
        target: null,
        kind: "normal",
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

    // Conditional requests.
    const etag = index.headers.get("etag")!;
    const again = await h.request("/cargo/crates/index/de/mo/demo_crate", {
      headers: { authorization: writer, "if-none-match": etag },
    });
    expect(again.status).toBe(304);
    const since = await h.request("/cargo/crates/index/de/mo/demo_crate", {
      headers: {
        authorization: writer,
        "if-modified-since": index.headers.get("last-modified")!,
      },
    });
    expect(since.status).toBe(304);

    // The index path is the exact lowercased name.
    expect(
      (
        await h.request("/cargo/crates/index/de/mo/demo-crate", {
          headers: { authorization: writer },
        })
      ).status,
    ).toBe(404);

    const dl = await h.request("/cargo/crates/api/v1/crates/Demo_Crate/0.1.0/download", {
      headers: { authorization: writer },
    });
    expect(dl.status).toBe(200);
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(crate);

    const yank = await h.request("/cargo/crates/api/v1/crates/Demo_Crate/0.1.0/yank", {
      method: "DELETE",
      headers: { authorization: writer },
    });
    expect(await yank.json()).toEqual({ ok: true });
    const yanked = await h.request("/cargo/crates/index/de/mo/demo_crate", {
      headers: { authorization: writer, "if-none-match": etag },
    });
    expect(yanked.status).toBe(200);
    expect(parseIndexFile(await yanked.text())[0]!.yanked).toBe(true);

    const search = await h.request("/cargo/crates/api/v1/crates?q=demo&per_page=5", {
      headers: { authorization: writer },
    });
    expect(await search.json()).toEqual({
      crates: [{ name: "Demo_Crate", max_version: "0.2.0", description: "The Demo_Crate crate" }],
      meta: { total: 1 },
    });

    const unyank = await h.request("/cargo/crates/api/v1/crates/Demo_Crate/0.1.0/unyank", {
      method: "PUT",
      headers: { authorization: writer },
    });
    expect(unyank.status).toBe(200);
    const restored = await h.request("/cargo/crates/index/de/mo/demo_crate", {
      headers: { authorization: writer },
    });
    expect(parseIndexFile(await restored.text())[0]!.yanked).toBe(false);

    const owners = await h.request("/cargo/crates/api/v1/crates/Demo_Crate/owners", {
      headers: { authorization: writer },
    });
    expect(((await owners.json()) as { users: { login: string }[] }).users[0]!.login).toBe("bob");
  });

  it("enforces unique normalized names and immutable versions", async () => {
    expect(
      (
        await publish(
          h,
          "crates",
          writer,
          encodePublishBody(meta("my_crate", "1.0.0"), crateBytes("a")),
        )
      ).status,
    ).toBe(200);
    const renamed = await publish(
      h,
      "crates",
      writer,
      encodePublishBody(meta("My-Crate", "1.1.0"), crateBytes("b")),
    );
    expect(renamed.status).toBe(409);
    expect(JSON.stringify(await renamed.json())).toContain("previously named `my_crate`");
    const again = await publish(
      h,
      "crates",
      writer,
      encodePublishBody(meta("my_crate", "1.0.0+build"), crateBytes("c")),
    );
    expect(again.status).toBe(409);
    expect(JSON.stringify(await again.json())).toContain("already uploaded");
  });

  it("validates names, versions and framing", async () => {
    const bad = await publish(
      h,
      "crates",
      writer,
      encodePublishBody(meta("nul", "1.0.0"), crateBytes("x")),
    );
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { errors: { detail: string }[] }).errors[0]!.detail).toContain(
      "reserved",
    );
    expect(
      (await publish(h, "crates", writer, encodePublishBody(meta("ok", "1.0"), crateBytes("x"))))
        .status,
    ).toBe(400);
    const truncated = encodePublishBody(meta("ok", "1.0.0"), crateBytes("x")).slice(0, -5);
    expect((await publish(h, "crates", writer, truncated)).status).toBe(400);
  });

  it("refuses publishes from readers", async () => {
    const reader = h.token("carol");
    const res = await publish(
      h,
      "crates",
      reader,
      encodePublishBody(meta("x1", "1.0.0"), crateBytes("x")),
    );
    expect(res.status).toBe(403);
  });

  it("marks public repositories as not requiring auth", async () => {
    await h.createRepo({ key: "open", format: "cargo", kind: "local", visibility: "public" });
    const config = (await (await h.request("/cargo/open/index/config.json")).json()) as Record<
      string,
      unknown
    >;
    expect(config["auth-required"]).toBe(false);
    await publish(
      h,
      "open",
      await h.adminToken(),
      encodePublishBody(meta("abc", "1.0.0"), crateBytes("x")),
    );
    expect((await h.request("/cargo/open/index/3/a/abc")).status).toBe(200);
  });
});

describe("cargo remote and virtual repositories", () => {
  let h: Harness;
  let admin: string;
  const hits: string[] = [];
  const serde = crateBytes("serde");
  const upstreamIndex = [
    { name: "serde", vers: "1.0.0", deps: [], cksum: sha256(serde), features: {}, yanked: false },
    { name: "serde", vers: "1.0.1", deps: [], cksum: "0".repeat(64), features: {}, yanked: false },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n");

  beforeEach(async () => {
    hits.length = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      hits.push(url.href);
      if (url.href === "https://index.crates.io/config.json") {
        return Response.json({
          dl: "https://static.crates.io/crates/{crate}/{crate}-{version}.crate",
          api: "https://crates.io",
        });
      }
      if (url.href === "https://index.crates.io/se/rd/serde") return new Response(upstreamIndex);
      if (url.href === "https://static.crates.io/crates/serde/serde-1.0.0.crate")
        return new Response(serde);
      if (url.href === "https://static.crates.io/crates/serde/serde-1.0.1.crate")
        return new Response("tampered");
      return new Response("not found", { status: 404 });
    });
    h = await makeHarness();
    admin = await h.adminToken();
    await h.createRepo({ key: "local", format: "cargo", kind: "local", visibility: "public" });
    await h.createRepo({
      key: "crates-io",
      format: "cargo",
      kind: "remote",
      visibility: "public",
      config: { upstream: "https://index.crates.io" },
    });
    await h.createRepo({
      key: "all",
      format: "cargo",
      kind: "virtual",
      visibility: "public",
      config: { defaultDeployRepo: "local" },
      members: [{ key: "crates-io" }, { key: "local" }],
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("proxies the index and verifies downloads against it", async () => {
    const config = await (await h.request("/cargo/crates-io/index/config.json")).json();
    expect(config).toEqual({
      dl: "https://pkg.test/cargo/crates-io/api/v1/crates",
      "auth-required": false,
    });
    const index = await h.request("/cargo/crates-io/index/se/rd/serde");
    expect(parseIndexFile(await index.text()).map((l) => l.vers)).toEqual(["1.0.0", "1.0.1"]);

    const dl = await h.request("/cargo/crates-io/api/v1/crates/serde/1.0.0/download");
    expect(dl.status).toBe(200);
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(serde);
    await h.request("/cargo/crates-io/api/v1/crates/serde/1.0.0/download");
    expect(hits.filter((u) => u.endsWith(".crate"))).toEqual([
      "https://static.crates.io/crates/serde/serde-1.0.0.crate",
    ]);

    const tampered = await h.request("/cargo/crates-io/api/v1/crates/serde/1.0.1/download");
    expect(tampered.status).toBeGreaterThanOrEqual(400);
    expect((await h.request("/cargo/crates-io/api/v1/crates/serde/9.9.9/download")).status).toBe(
      404,
    );

    const publishRemote = await publish(
      h,
      "crates-io",
      admin,
      encodePublishBody(meta("mine", "1.0.0"), crateBytes("m")),
    );
    expect(publishRemote.status).toBe(405);
  });

  it("serves local and upstream crates through a virtual repository", async () => {
    const config = (await (await h.request("/cargo/all/index/config.json")).json()) as Record<
      string,
      unknown
    >;
    expect(config.dl).toBe("https://pkg.test/cargo/all/api/v1/crates");
    expect(config.api).toBe("https://pkg.test/cargo/all");

    const mine = crateBytes("mine");
    expect(
      (await publish(h, "all", admin, encodePublishBody(meta("mine", "1.0.0"), mine))).status,
    ).toBe(200);
    // It landed in the deploy target.
    expect((await h.request("/cargo/local/index/mi/ne/mine")).status).toBe(200);

    const localIndex = await h.request("/cargo/all/index/mi/ne/mine");
    expect(parseIndexFile(await localIndex.text())[0]!.cksum).toBe(sha256(mine));
    const remoteIndex = await h.request("/cargo/all/index/se/rd/serde");
    expect(parseIndexFile(await remoteIndex.text()).length).toBe(2);

    const localDl = await h.request("/cargo/all/api/v1/crates/mine/1.0.0/download");
    expect(new Uint8Array(await localDl.arrayBuffer())).toEqual(mine);
    const remoteDl = await h.request("/cargo/all/api/v1/crates/serde/1.0.0/download");
    expect(new Uint8Array(await remoteDl.arrayBuffer())).toEqual(serde);

    const search = (await (await h.request("/cargo/all/api/v1/crates?q=mi")).json()) as {
      crates: { name: string }[];
    };
    expect(search.crates.map((c) => c.name)).toEqual(["mine"]);
  });

  it("merges versions across members when configured", async () => {
    await publish(h, "local", admin, encodePublishBody(meta("serde", "2.0.0"), crateBytes("s2")));
    // Local wins without merging.
    let index = await h.request("/cargo/all/index/se/rd/serde");
    expect(parseIndexFile(await index.text()).map((l) => l.vers)).toEqual(["2.0.0"]);

    await h.request("/api/v1/repositories/all", {
      method: "PATCH",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: JSON.stringify({ config: { defaultDeployRepo: "local", mergeVersions: true } }),
    });
    index = await h.request("/cargo/all/index/se/rd/serde");
    expect(parseIndexFile(await index.text()).map((l) => l.vers)).toEqual([
      "2.0.0",
      "1.0.0",
      "1.0.1",
    ]);
  });
});
