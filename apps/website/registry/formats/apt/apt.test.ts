import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { field, parseDeb822 } from "@gitmatrix/formats/apt";
import { gunzip, gzipSync, writeTar } from "@gitmatrix/formats/archive";
import { verifyClearsigned, verifyDetached } from "@gitmatrix/formats/pgp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { basic, makeHarness, type Harness } from "../../testing/harness.ts";

const FIXTURES = new URL("../../../../../packages/formats/src/apt/fixtures/", import.meta.url);
const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(name, FIXTURES).href)));
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** A minimal .deb (control.tar.gz only; apt never sees our data member). */
function makeDeb(pkg: string, version: string, arch: string, extra = ""): Uint8Array {
  const control = `Package: ${pkg}\nVersion: ${version}\nArchitecture: ${arch}\nMaintainer: T <t@example.com>\nDescription: test ${pkg}\n more${extra}\n`;
  const members: [string, Uint8Array][] = [
    ["debian-binary", new TextEncoder().encode("2.0\n")],
    ["control.tar.gz", gzipSync(writeTar([{ name: "./control", data: control }]))],
    ["data.tar.gz", gzipSync(writeTar([{ name: "./usr/share/doc/x", data: pkg }]))],
  ];
  const parts: Uint8Array[] = [new TextEncoder().encode("!<arch>\n")];
  for (const [name, data] of members) {
    const header = `${name}/`.padEnd(16) + "0".padEnd(12) + "0".padEnd(6) + "0".padEnd(6);
    const full = `${header}${"100644".padEnd(8)}${String(data.length).padEnd(10)}\`\n`;
    parts.push(new TextEncoder().encode(full), data);
    if (data.length % 2) parts.push(new Uint8Array([0x0a]));
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe("apt local repositories", () => {
  let h: Harness;
  let admin: string;

  beforeEach(async () => {
    h = await makeHarness();
    admin = await h.adminToken();
    const res = await h.createRepo({
      key: "deb",
      format: "apt",
      kind: "local",
      visibility: "private",
      config: { signingAlgorithm: "ed25519", apt: { origin: "Test Origin", label: "Test" } },
    });
    expect(res.status).toBe(201);
  });

  const auth = () => ({ authorization: basic(admin) });
  const get = (path: string) => h.request(`/apt/deb/${path}`, { headers: auth() });
  const put = (path: string, body: Uint8Array) =>
    h.request(`/apt/deb/${path}`, { method: "PUT", headers: auth(), body });
  const text = async (path: string) => {
    const res = await get(path);
    expect(res.status, path).toBe(200);
    return res.text();
  };

  it("publishes .debs with gz, xz and zstd control members and signs the indexes", async () => {
    for (const [compression, dist] of [
      ["gzip", "jammy"],
      ["xz", "noble"],
      ["zstd", "bookworm"],
    ] as const) {
      const res = await put(
        `pool/main/a/arttest/arttest_1.0-1_amd64.deb;deb.distribution=${dist};deb.component=main;deb.architecture=amd64`,
        fixture(`arttest_1.0-1_amd64-${compression}.deb`),
      );
      // Same identity, different bytes: only the first may land at this path.
      expect(res.status).toBe(compression === "gzip" ? 201 : 409);
    }
    const hello = await put(
      "pool/main/h/hello/hello_2.10-3_amd64.deb;deb.distribution=noble,jammy;deb.component=main",
      fixture("hello_2.10-3_amd64.deb"),
    );
    expect(hello.status).toBe(201);
    const ubuntu = await put(
      "pool/main/h/hello/hello_2.10-3build1_amd64.deb;deb.distribution=noble",
      fixture("hello_2.10-3build1_amd64.deb"),
    );
    expect(ubuntu.status).toBe(201);

    const publicKey = await text("key.asc");
    const inRelease = await text("dists/noble/InRelease");
    const release = await text("dists/noble/Release");
    expect((await verifyClearsigned(inRelease, publicKey))?.trimEnd()).toBe(release.trimEnd());
    expect(await verifyDetached(release, await text("dists/noble/Release.gpg"), publicKey)).toBe(
      true,
    );

    const [fields] = parseDeb822(release);
    expect(field(fields!, "Origin")).toBe("Test Origin");
    expect(field(fields!, "Suite")).toBe("noble");
    expect(field(fields!, "Acquire-By-Hash")).toBe("yes");
    expect(field(fields!, "Architectures")).toBe("amd64");
    expect(field(fields!, "Date")).toMatch(/^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} UTC$/);

    // Every index listed in Release is served with the advertised size and hash.
    const sha = field(fields!, "SHA256")!
      .trim()
      .split("\n")
      .map((l) => l.trim().split(/\s+/));
    expect(sha.map(([, , p]) => p)).toEqual([
      "main/binary-amd64/Packages",
      "main/binary-amd64/Packages.gz",
      "main/binary-amd64/Release",
    ]);
    for (const [hash, size, path] of sha) {
      const res = await get(`dists/noble/${path}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(bytes.length).toBe(Number(size));
      expect(sha256(bytes)).toBe(hash);
      if (!path!.endsWith("Release")) {
        const byHash = await get(`dists/noble/main/binary-amd64/by-hash/SHA256/${hash}`);
        expect(byHash.status).toBe(200);
      }
    }

    const packages = await text("dists/noble/main/binary-amd64/Packages");
    const gz = new Uint8Array(
      await (await get("dists/noble/main/binary-amd64/Packages.gz")).arrayBuffer(),
    );
    expect(new TextDecoder().decode(gunzip(gz))).toBe(packages);
    const stanzas = parseDeb822(packages);
    expect(stanzas.map((s) => `${field(s, "Package")} ${field(s, "Version")}`)).toEqual([
      "hello 2.10-3",
      "hello 2.10-3build1",
    ]);
    const helloStanza = stanzas[0]!;
    expect(field(helloStanza, "Filename")).toBe("pool/main/h/hello/hello_2.10-3_amd64.deb");
    expect(field(helloStanza, "SHA256")).toBe(sha256(fixture("hello_2.10-3_amd64.deb")));
    expect(field(helloStanza, "Size")).toBe(String(fixture("hello_2.10-3_amd64.deb").length));
    expect(field(helloStanza, "Replaces")).toBe("hello-debhelper (<< 2.9), hello-traditional");
    expect(field(helloStanza, "Description")).toContain("\n Seriously, though");

    const deb = await get("pool/main/h/hello/hello_2.10-3_amd64.deb");
    expect(deb.headers.get("content-type")).toBe("application/vnd.debian.binary-package");
    expect(sha256(new Uint8Array(await deb.arrayBuffer()))).toBe(
      sha256(fixture("hello_2.10-3_amd64.deb")),
    );
    expect((await get("dists/noble/main/i18n/Translation-en")).status).toBe(404);

    // jammy has hello from the comma-separated distribution list.
    const jammy = parseDeb822(await text("dists/jammy/main/binary-amd64/Packages"));
    expect(jammy.map((s) => field(s, "Package"))).toEqual(["arttest", "hello"]);
  });

  it("is idempotent for identical re-uploads and adds distributions", async () => {
    const deb = fixture("arttest_1.0-1_amd64-gzip.deb");
    expect((await put("a.deb;deb.distribution=one", deb)).status).toBe(201);
    const again = await put("a.deb;deb.distribution=two", deb);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { distributions: string[] }).distributions).toEqual([
      "one",
      "two",
    ]);
    expect(await text("dists/two/main/binary-amd64/Packages")).toContain("Filename: a.deb\n");
    const conflict = await put("b.deb;deb.distribution=one", fixture("arttest_1.0-1_amd64-xz.deb"));
    expect(conflict.status).toBe(409);
    expect(await conflict.text()).toMatch(/already exists/);
  });

  it("fans architecture all out to every architecture", async () => {
    await put("upload/x.deb?distribution=stable", makeDeb("native", "1.0", "arm64"));
    await put("upload/y.deb?distribution=stable", fixture("artall_0.1_all-xz.deb"));
    const release = parseDeb822(await text("dists/stable/Release"))[0]!;
    const archs = field(release, "Architectures")!.split(" ");
    expect(archs).toContain("amd64");
    expect(archs).toContain("arm64");
    for (const arch of archs) {
      const names = parseDeb822(await text(`dists/stable/main/binary-${arch}/Packages`)).map((s) =>
        field(s, "Package"),
      );
      expect(names).toEqual(arch === "arm64" ? ["artall", "native"] : ["artall"]);
    }
    const stanza = parseDeb822(await text("dists/stable/main/binary-amd64/Packages"))[0]!;
    expect(field(stanza, "Filename")).toBe("pool/main/a/artall/artall_0.1_all.deb");
  });

  it("keeps the last generations of by-hash indexes", async () => {
    const hashes: string[] = [];
    for (let i = 1; i <= 4; i++) {
      await put(`upload/p${i}.deb?distribution=stable`, makeDeb(`pkg${i}`, "1.0", "amd64"));
      hashes.push(sha256(await text("dists/stable/main/binary-amd64/Packages")));
    }
    const byHash = (hash: string) =>
      get(`dists/stable/main/binary-amd64/by-hash/SHA256/${hash}`).then((r) => r.status);
    expect(await byHash(hashes[3]!)).toBe(200);
    expect(await byHash(hashes[2]!)).toBe(200);
    expect(await byHash(hashes[1]!)).toBe(200);
    expect(await byHash(hashes[0]!)).toBe(404);
  });

  it("validates uploads", async () => {
    expect(
      (
        await put(
          "x.deb;deb.distribution=stable;deb.architecture=arm64",
          makeDeb("aa", "1", "amd64"),
        )
      ).status,
    ).toBe(400);
    expect((await put("x.deb", new TextEncoder().encode("not a deb"))).status).toBe(400);
    expect((await put("x.rpm", makeDeb("aa", "1", "amd64"))).status).toBe(400);
    expect((await put("dists/x.deb", makeDeb("aa", "1", "amd64"))).status).toBe(400);
    expect((await put("x.deb;deb.distribution=Bad/Name", makeDeb("aa", "1", "amd64"))).status).toBe(
      400,
    );
    const bad = await put("x.deb", makeDeb("Bad_Name", "1", "amd64"));
    expect(bad.status).toBe(400);
    expect(bad.headers.get("content-type")).toContain("text/plain");
  });

  it("challenges anonymous clients and refuses readers without write access", async () => {
    const res = await h.request("/apt/deb/dists/stable/InRelease");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('Basic realm="gitmatrix"');
    const reader = h.token("carol");
    const denied = await h.request("/apt/deb/upload/x.deb", {
      method: "PUT",
      headers: { authorization: basic(reader) },
      body: makeDeb("aa", "1", "amd64"),
    });
    expect(denied.status).toBe(403);
  });

  it("serves an empty signed index for configured distributions", async () => {
    await h.createRepo({
      key: "empty",
      format: "apt",
      kind: "local",
      visibility: "public",
      config: { signingAlgorithm: "ed25519", apt: { distributions: ["trixie"] } },
    });
    const inRelease = await h.request("/apt/empty/dists/trixie/InRelease");
    expect(inRelease.status).toBe(200);
    const key = await (await h.request("/apt/empty/key.asc")).text();
    const signed = await verifyClearsigned(await inRelease.text(), key);
    expect(signed).toContain("Components: main");
    const packages = await h.request("/apt/empty/dists/trixie/main/binary-amd64/Packages");
    expect(await packages.text()).toBe("");
    expect((await h.request("/apt/empty/dists/nope/InRelease")).status).toBe(404);
  });

  it("deletes a version through the REST API", async () => {
    await put("upload/a.deb?distribution=stable", makeDeb("gone", "1.0", "amd64"));
    await put("upload/b.deb?distribution=stable", makeDeb("kept", "1.0", "amd64"));
    const writer = h.token("bob");
    const forbidden = await h.request("/api/v1/apt/deb/packages/gone/1.0/amd64", {
      method: "DELETE",
      headers: { authorization: `Bearer ${writer}` },
    });
    expect(forbidden.status).toBe(403);
    const res = await h.request("/api/v1/apt/deb/packages/gone/1.0/amd64?distribution=stable", {
      method: "DELETE",
      headers: auth(),
    });
    expect(res.status).toBe(204);
    const names = parseDeb822(await text("dists/stable/main/binary-amd64/Packages")).map((s) =>
      field(s, "Package"),
    );
    expect(names).toEqual(["kept"]);
    expect((await get("pool/main/g/gone/gone_1.0_amd64.deb")).status).toBe(404);
    const again = await h.request("/api/v1/apt/deb/packages/gone/1.0/amd64", {
      method: "DELETE",
      headers: auth(),
    });
    expect(again.status).toBe(404);
  });

  it("uploads through the REST API and rotates the signing key", async () => {
    const res = await h.request("/api/v1/apt/deb/upload?distribution=focal&component=contrib", {
      method: "POST",
      headers: auth(),
      body: makeDeb("libfoo1", "2:1.0-1", "amd64"),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { path: string }).path).toBe(
      "/pool/contrib/libf/libfoo1/libfoo1_1.0-1_amd64.deb",
    );
    const oldKey = await text("key.asc");
    const rotated = await h.request("/api/v1/apt/deb/rotate-key", {
      method: "POST",
      headers: auth(),
    });
    expect(rotated.status).toBe(200);
    const newKey = await text("key.asc");
    expect(newKey).not.toBe(oldKey);
    const inRelease = await text("dists/focal/InRelease");
    expect(await verifyClearsigned(inRelease, newKey)).toContain("Components: contrib");
    expect(await verifyClearsigned(inRelease, oldKey)).toBeNull();
  });

  it("uses RSA-4096 keys by default and serves a binary keyring", { timeout: 60_000 }, async () => {
    await h.createRepo({ key: "rsa", format: "apt", kind: "local", visibility: "public" });
    await h.request("/apt/rsa/upload/a.deb", {
      method: "PUT",
      headers: auth(),
      body: makeDeb("aa", "1.0", "amd64"),
    });
    const gpg = new Uint8Array(await (await h.request("/apt/rsa/key.gpg")).arrayBuffer());
    // Old-format public key packet with a two-byte length, version 4, algorithm 1 (RSA).
    expect(gpg[0]).toBe(0xc6);
    const asc = await (await h.request("/apt/rsa/key.asc")).text();
    const inRelease = await (await h.request("/apt/rsa/dists/stable/InRelease")).text();
    expect(await verifyClearsigned(inRelease, asc)).toContain("Suite: stable");
  });
});

describe("apt remote repositories", () => {
  let h: Harness;
  const hits: string[] = [];
  const deb = fixture("hello_2.10-3_amd64.deb");
  const inRelease = "-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA512\n\nSuite: stable\n";

  beforeEach(async () => {
    hits.length = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      hits.push(url.pathname);
      if (url.pathname === "/debian/dists/stable/InRelease") return new Response(inRelease);
      if (url.pathname === "/debian/dists/stable/main/binary-amd64/by-hash/SHA256/abc") {
        return new Response(gzipSync(new TextEncoder().encode("Package: hello\n")));
      }
      if (url.pathname === "/debian/pool/main/h/hello/hello_2.10-3_amd64.deb") {
        return new Response(deb);
      }
      return new Response("missing", { status: 404 });
    });
    h = await makeHarness();
    await h.createRepo({
      key: "debian",
      format: "apt",
      kind: "remote",
      visibility: "public",
      config: { upstream: "https://deb.example.org/debian" },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("proxies signed metadata verbatim and caches it", async () => {
    expect(await (await h.request("/apt/debian/dists/stable/InRelease")).text()).toBe(inRelease);
    expect(await (await h.request("/apt/debian/dists/stable/InRelease")).text()).toBe(inRelease);
    expect(hits).toEqual(["/debian/dists/stable/InRelease"]);
  });

  it("caches pool files and by-hash indexes as immutable blobs", async () => {
    for (let i = 0; i < 2; i++) {
      const res = await h.request("/apt/debian/pool/main/h/hello/hello_2.10-3_amd64.deb");
      expect(res.status).toBe(200);
      expect(sha256(new Uint8Array(await res.arrayBuffer()))).toBe(sha256(deb));
    }
    const gz = await h.request("/apt/debian/dists/stable/main/binary-amd64/by-hash/SHA256/abc");
    expect(new TextDecoder().decode(gunzip(new Uint8Array(await gz.arrayBuffer())))).toBe(
      "Package: hello\n",
    );
    expect(hits.filter((p) => p.endsWith(".deb"))).toHaveLength(1);
    expect((await h.request("/apt/debian/dists/stable/Release")).status).toBe(404);
  });

  it("refuses uploads to remote repositories", async () => {
    const res = await h.request("/apt/debian/upload/x.deb", {
      method: "PUT",
      headers: { authorization: `Bearer ${await h.adminToken()}` },
      body: makeDeb("aa", "1", "amd64"),
    });
    expect(res.status).toBe(405);
  });
});
