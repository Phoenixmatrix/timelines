import { gzipSync } from "@gitmatrix/formats/archive";
import {
  concat,
  enc,
  FLUSH,
  inflate,
  parseCommit,
  parseTree,
  pkt,
  pktText,
  readPkts,
} from "@gitmatrix/formats/git";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { createDb } from "../../core/db.ts";
import { basic, makeHarness, type Harness } from "../../testing/harness.ts";
import { getHead, getObject } from "./store.ts";

const TAP = "/brew/tap/homebrew-tools.git";

function formula(name: string, version: string, extra = ""): string {
  const cls = name.charAt(0).toUpperCase() + name.slice(1);
  return `class ${cls} < Formula
  desc "The ${name} tool"
  homepage "https://example.com/${name}"
  url "https://example.com/${name}-${version}.tar.gz"
  sha256 "${"a".repeat(64)}"
${extra}
  def install
    bin.install "${name}"
  end
end
`;
}

describe("brew taps", () => {
  let h: Harness;
  let writer: string;
  let repoId: string;

  const put = (path: string, body: string, token = writer) =>
    h.request(`/api/v1/brew/tap/${path}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body,
    });

  const commitOf = async (oid: string) => {
    const object = await getObject(createDb(h.env.REGISTRY_DB), repoId, oid);
    return parseCommit(inflate(object!.zdata));
  };

  beforeEach(async () => {
    h = await makeHarness();
    const res = await h.createRepo({
      key: "tap",
      format: "brew",
      kind: "local",
      visibility: "private",
      config: { tapName: "tools" },
    });
    expect(res.status).toBe(201);
    repoId = ((await res.json()) as { id: string }).id;
    writer = h.token("bob");
    await h.request("/api/v1/repositories/tap/permissions", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${await h.adminToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ principal: "user:bob", role: "write" }),
    });
  });

  it("commits each formula change on top of the previous commit", async () => {
    const first = await put("Formula/foo.rb", formula("foo", "1.0.0"));
    expect(first.status).toBe(201);
    const one = (await first.json()) as { commit: string; version: string };
    expect(one.version).toBe("1.0.0");

    const second = await put("Formula/foo.rb", formula("foo", "1.1.0"));
    expect(second.status).toBe(201);
    const two = (await second.json()) as { commit: string };

    const head = await getHead(createDb(h.env.REGISTRY_DB), repoId);
    expect(head?.oid).toBe(two.commit);
    const commit = await commitOf(two.commit);
    expect(commit.parents).toEqual([one.commit]);
    expect(commit.message).toContain("Update foo 1.1.0");
    expect(commit.message).toContain("Published-by: user:acc_bob");
    expect(commit.author).toMatch(/^gitmatrix <noreply@gitmatrix\.dev> \d+ \+0000$/);

    const root = await getObject(createDb(h.env.REGISTRY_DB), repoId, commit.tree);
    expect(parseTree(inflate(root!.zdata)).map((e) => e.name)).toEqual([
      ".gitmatrix.json",
      "Formula",
      "README.md",
      "lib",
    ]);

    // Identical bytes are a no-op; the same version with new bytes needs delete.
    const again = await put("Formula/foo.rb", formula("foo", "1.1.0"));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { changed: boolean }).changed).toBe(false);
    const clash = await put("Formula/foo.rb", formula("foo", "1.1.0", '  license "MIT"'));
    expect(clash.status).toBe(409);
    const admin = await put(
      "Formula/foo.rb",
      formula("foo", "1.1.0", '  license "MIT"'),
      await h.adminToken(),
    );
    expect(admin.status).toBe(201);

    const files = await h.request("/api/v1/brew/tap/files", {
      headers: { authorization: `Bearer ${writer}` },
    });
    const list = (await files.json()) as { formulae: { name: string; version: string }[] };
    expect(list.formulae).toMatchObject([{ name: "foo", version: "1.1.0" }]);
  });

  it("validates names, class names and size", async () => {
    expect((await put("Formula/Foo.rb", formula("foo", "1"))).status).toBe(400);
    expect((await put("Formula/foo.txt", formula("foo", "1"))).status).toBe(400);
    const wrong = await put("Formula/bar.rb", formula("foo", "1"));
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toContain("class Bar < Formula");
    const big = await put("Formula/foo.rb", "x".repeat(1024 * 1024 + 1));
    expect(big.status).toBe(413);
    const cask = await put("Casks/my-app.rb", 'cask "my-app" do\n  version "2.0"\nend\n');
    expect(cask.status).toBe(201);
  });

  it("advertises refs over protocol v0 and v2", async () => {
    await put("Formula/foo.rb", formula("foo", "1.0.0"));
    const head = await getHead(createDb(h.env.REGISTRY_DB), repoId);
    const v0 = await h.request(`${TAP}/info/refs?service=git-upload-pack`, {
      headers: { authorization: basic(writer) },
    });
    expect(v0.status).toBe(200);
    expect(v0.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    expect(v0.headers.get("cache-control")).toContain("no-cache");
    const lines = readPkts(new Uint8Array(await v0.arrayBuffer())).map(pktText);
    expect(lines[0]).toBe("# service=git-upload-pack");
    expect(lines[2]).toContain(`${head!.oid} HEAD\0`);
    expect(lines[2]).toContain("symref=HEAD:refs/heads/main");
    expect(lines[3]).toBe(`${head!.oid} refs/heads/main`);

    const v2 = await h.request(`/brew/tap/homebrew-tools/info/refs?service=git-upload-pack`, {
      headers: { authorization: basic(writer), "git-protocol": "version=2" },
    });
    const caps = readPkts(new Uint8Array(await v2.arrayBuffer())).map(pktText);
    expect(caps[0]).toBe("version 2");
    expect(caps).toContain("ls-refs=unborn");
    expect(caps).toContain("fetch=shallow");
    expect(caps).toContain("object-format=sha1");
  });

  it("creates the first commit on first clone of an empty tap", async () => {
    const res = await h.request(`${TAP}/info/refs?service=git-upload-pack`, {
      headers: { authorization: basic(writer) },
    });
    const lines = readPkts(new Uint8Array(await res.arrayBuffer())).map(pktText);
    expect(lines[2]).toMatch(/^[0-9a-f]{40} HEAD\0/);
  });

  it("answers ls-refs and fetch over v2, gzip-encoded too", async () => {
    await put("Formula/foo.rb", formula("foo", "1.0.0"));
    const head = (await getHead(createDb(h.env.REGISTRY_DB), repoId))!;
    const post = (body: Uint8Array, gzip = false) =>
      h.request(`${TAP}/git-upload-pack`, {
        method: "POST",
        headers: {
          authorization: basic(writer),
          "content-type": "application/x-git-upload-pack-request",
          "git-protocol": "version=2",
          ...(gzip ? { "content-encoding": "gzip" } : {}),
        },
        body: gzip ? gzipSync(body) : body,
      });

    const ls = await post(
      concat([
        pkt("command=ls-refs\n"),
        pkt("agent=git/2.54\n"),
        enc.encode("0001"),
        pkt("symrefs\n"),
        pkt("unborn\n"),
        pkt("ref-prefix HEAD\n"),
        FLUSH,
      ]),
      true,
    );
    expect(ls.headers.get("content-type")).toBe("application/x-git-upload-pack-result");
    expect(readPkts(new Uint8Array(await ls.arrayBuffer())).map(pktText)).toEqual([
      `${head.oid} HEAD symref-target:refs/heads/main`,
      "",
    ]);

    const fetch = await post(
      concat([
        pkt("command=fetch\n"),
        enc.encode("0001"),
        pkt(`want ${head.oid}\n`),
        pkt("ofs-delta\n"),
        pkt("done\n"),
        FLUSH,
      ]),
    );
    const pkts = readPkts(new Uint8Array(await fetch.arrayBuffer()));
    expect(pktText(pkts[0]!)).toBe("packfile");
    const pack = concat(
      pkts.flatMap((p) => (p.type === "data" && p.data[0] === 1 ? [p.data.subarray(1)] : [])),
    );
    expect(new TextDecoder().decode(pack.subarray(0, 4))).toBe("PACK");
    // commit, root tree, lib tree, Formula tree, README, metadata, strategy, foo.rb
    expect(new DataView(pack.buffer, pack.byteOffset).getUint32(8)).toBe(8);
  });

  it("answers a v0 clone request with NAK and a pack", async () => {
    await put("Formula/foo.rb", formula("foo", "1.0.0"));
    const head = (await getHead(createDb(h.env.REGISTRY_DB), repoId))!;
    const res = await h.request(`${TAP}/git-upload-pack`, {
      method: "POST",
      headers: {
        authorization: basic(writer),
        "content-type": "application/x-git-upload-pack-request",
      },
      body: concat([
        pkt(`want ${head.oid} multi_ack_detailed side-band-64k ofs-delta\n`),
        FLUSH,
        pkt("done\n"),
      ]),
    });
    const pkts = readPkts(new Uint8Array(await res.arrayBuffer()));
    expect(pktText(pkts[0]!)).toBe("NAK");
    expect(pkts[1]!.type === "data" && pkts[1]!.data[0]).toBe(1);
  });

  it("challenges anonymous git clients of private taps and refuses pushes", async () => {
    const res = await h.request(`${TAP}/info/refs?service=git-upload-pack`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('Basic realm="gitmatrix"');
    const post = await h.request(`${TAP}/git-upload-pack`, { method: "POST", body: "0000" });
    expect(post.status).toBe(401);

    const push = await h.request(`${TAP}/info/refs?service=git-receive-pack`, {
      headers: { authorization: basic(writer) },
    });
    expect(push.status).toBe(403);
    expect(push.headers.get("content-type")).toContain("text/plain");
    expect(await push.text()).toContain("read-only");

    const wrongTap = await h.request(
      "/brew/tap/homebrew-other.git/info/refs?service=git-upload-pack",
      {
        headers: { authorization: basic(writer) },
      },
    );
    expect(wrongTap.status).toBe(404);
  });

  it("stores and serves bottles with authentication", async () => {
    const file = "foo--1.0.0.arm64_sonoma.bottle.tar.gz";
    const upload = await h.request(`/brew/tap/bottles/${file}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${writer}` },
      body: "bottle-bytes",
    });
    expect(upload.status).toBe(201);
    const body = (await upload.json()) as { sha256: string; bottle: { tag: string } };
    expect(body.bottle.tag).toBe("arm64_sonoma");

    expect((await h.request(`/brew/tap/bottles/${file}`)).status).toBe(401);
    const get = await h.request(`/brew/tap/bottles/${file}`, {
      headers: { authorization: `Bearer ${writer}` },
    });
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("bottle-bytes");
    expect(get.headers.get("x-checksum-sha256")).toBe(body.sha256);

    const clash = await h.request(`/brew/tap/bottles/${file}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${writer}` },
      body: "different",
    });
    expect(clash.status).toBe(409);
    const bad = await h.request(`/brew/tap/bottles/x`, {
      method: "PUT",
      headers: { authorization: `Bearer ${writer}`, "x-checksum-sha256": "0".repeat(64) },
      body: "x",
    });
    expect(bad.status).toBe(400);
  });

  it("renders formulae from JSON with the private download strategy", async () => {
    const res = await h.request("/api/v1/brew/tap/formula", {
      method: "POST",
      headers: { authorization: `Bearer ${writer}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "hello-cli",
        desc: "Says hello",
        homepage: "https://example.com",
        url: "https://pkg.test/brew/tap/bottles/hello-cli-0.3.0.tar.gz",
        sha256: "b".repeat(64),
        version: "0.3.0",
        license: "MIT",
        depends_on: ["jq", { name: "go", type: "build" }],
        bottles: { arm64_sonoma: "c".repeat(64) },
      }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { version: string }).version).toBe("0.3.0");
    const source = await h.request("/api/v1/brew/tap/Formula/hello-cli.rb", {
      headers: { authorization: `Bearer ${writer}` },
    });
    const text = await source.text();
    expect(text).toContain('require_relative "../lib/gitmatrix_download_strategy"');
    expect(text).toContain("class HelloCli < Formula");
    expect(text).toContain(
      'root_url "https://pkg.test/brew/tap/bottles", using: GitmatrixDownloadStrategy',
    );

    const invalid = await h.request("/api/v1/brew/tap/formula", {
      method: "POST",
      headers: { authorization: `Bearer ${writer}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "x", url: "nope", sha256: "z" }),
    });
    expect(invalid.status).toBe(400);
  });

  it("deletes formulae with delete permission, in a new commit", async () => {
    await put("Formula/foo.rb", formula("foo", "1.0.0"));
    await put("Formula/bar.rb", formula("bar", "2.0.0"));
    const denied = await h.request("/api/v1/brew/tap/Formula/foo.rb", {
      method: "DELETE",
      headers: { authorization: `Bearer ${writer}` },
    });
    expect(denied.status).toBe(403);
    const res = await h.request("/api/v1/brew/tap/Formula/foo.rb", {
      method: "DELETE",
      headers: { authorization: `Bearer ${await h.adminToken()}` },
    });
    expect(res.status).toBe(200);
    const { commit } = (await res.json()) as { commit: string };
    expect((await commitOf(commit)).message).toContain("Delete foo");
    const files = await h.request("/api/v1/brew/tap/files", {
      headers: { authorization: `Bearer ${writer}` },
    });
    const list = (await files.json()) as { formulae: { name: string }[] };
    expect(list.formulae.map((f) => f.name)).toEqual(["bar"]);
  });
});
