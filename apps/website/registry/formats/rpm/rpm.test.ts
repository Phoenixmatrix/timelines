import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { gunzip } from "@gitmatrix/formats/archive";
import { verifyDetached } from "@gitmatrix/formats/pgp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { basic, makeHarness, type Harness } from "../../testing/harness.ts";

const FIXTURES = new URL("../../../../../packages/formats/src/rpm/fixtures/", import.meta.url);
const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(name, FIXTURES).href)));
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const WHICH = "which-2.23-4.fc44.x86_64.rpm";
const BASESYSTEM = "basesystem-11-20.fc40.noarch.rpm";

describe("rpm local repositories", () => {
  let h: Harness;
  let admin: string;

  beforeEach(async () => {
    h = await makeHarness();
    admin = await h.adminToken();
    await h.createRepo({
      key: "el",
      format: "rpm",
      kind: "local",
      visibility: "private",
      description: "Internal EL packages",
      config: { signingAlgorithm: "ed25519" },
    });
  });

  const auth = () => ({ authorization: basic(admin) });
  const get = (path: string) => h.request(`/rpm/el/${path}`, { headers: auth() });
  const put = (path: string, body: Uint8Array) =>
    h.request(`/rpm/el/${path}`, { method: "PUT", headers: auth(), body });
  const bytes = async (path: string) => {
    const res = await get(path);
    expect(res.status, path).toBe(200);
    return new Uint8Array(await res.arrayBuffer());
  };

  async function repodata() {
    const repomd = new TextDecoder().decode(await bytes("repodata/repomd.xml"));
    const data: Record<string, { location: string; checksum: string; open: string; size: number }> =
      {};
    for (const block of repomd.matchAll(/<data type="(\w+)">([\s\S]*?)<\/data>/g)) {
      const body = block[2]!;
      data[block[1]!] = {
        location: /<location href="([^"]+)"/.exec(body)![1]!,
        checksum: /<checksum type="sha256">(\w+)</.exec(body)![1]!,
        open: /<open-checksum type="sha256">(\w+)</.exec(body)![1]!,
        size: Number(/<size>(\d+)</.exec(body)![1]),
      };
    }
    const xml: Record<string, string> = {};
    for (const [kind, entry] of Object.entries(data)) {
      const gz = await bytes(entry.location);
      expect(gz.length).toBe(entry.size);
      expect(sha256(gz)).toBe(entry.checksum);
      expect(entry.location).toBe(`repodata/${entry.checksum}-${kind}.xml.gz`);
      const plain = gunzip(gz);
      expect(sha256(plain)).toBe(entry.open);
      xml[kind] = new TextDecoder().decode(plain);
    }
    return { repomd, data, xml };
  }

  it("publishes packages and writes signed createrepo metadata", async () => {
    const which = await put(`Packages/w/${WHICH}`, fixture(WHICH));
    expect(which.status).toBe(201);
    const base = await put(`upload/${BASESYSTEM}`, fixture(BASESYSTEM));
    expect(base.status).toBe(201);
    expect(((await base.json()) as { path: string }).path).toBe(`/Packages/b/${BASESYSTEM}`);

    const { repomd, xml } = await repodata();
    const key = new TextDecoder().decode(await bytes("repodata/repomd.xml.key"));
    const asc = new TextDecoder().decode(await bytes("repodata/repomd.xml.asc"));
    expect(await verifyDetached(repomd, asc, key)).toBe(true);

    expect(xml.primary).toContain('packages="2"');
    expect(xml.primary).toContain(`<location href="Packages/b/${BASESYSTEM}"/>`);
    expect(xml.primary).toContain(`<location href="Packages/w/${WHICH}"/>`);
    expect(xml.primary).toContain(
      `<checksum type="sha256" pkgid="YES">${sha256(fixture(WHICH))}</checksum>`,
    );
    expect(xml.primary).toContain('<rpm:header-range start="4504" end="10501"/>');
    expect(xml.primary).toContain("<file>/usr/bin/which</file>");
    expect(xml.filelists).toContain('<file type="dir">/usr/share/doc/which</file>');
    expect(xml.other).toContain("Fedora_44_Mass_Rebuild");

    const rpm = await get(`Packages/w/${WHICH}`);
    expect(rpm.headers.get("content-type")).toBe("application/x-rpm");
    expect(sha256(new Uint8Array(await rpm.arrayBuffer()))).toBe(sha256(fixture(WHICH)));
  });

  it("serves a ready-made .repo file", async () => {
    const text = await (await get("config.repo")).text();
    expect(text).toContain("[el]\n");
    expect(text).toContain("name=Internal EL packages\n");
    expect(text).toContain("baseurl=https://pkg.test/rpm/el/\n");
    expect(text).toContain("repo_gpgcheck=1\n");
    expect(text).toContain("gpgcheck=0\n");
    expect(text).toContain("gpgkey=https://pkg.test/rpm/el/repodata/repomd.xml.key\n");
  });

  it("answers an empty repository with valid signed metadata", async () => {
    const { repomd, xml } = await repodata();
    expect(xml.primary).toContain('packages="0"');
    const key = new TextDecoder().decode(await bytes("repodata/repomd.xml.key"));
    const asc = new TextDecoder().decode(await bytes("repodata/repomd.xml.asc"));
    expect(await verifyDetached(repomd, asc, key)).toBe(true);
  });

  it("rejects a different package with the same NEVRA and accepts identical re-uploads", async () => {
    const original = fixture(WHICH);
    expect((await put(`upload/${WHICH}`, original)).status).toBe(201);
    expect((await put(`upload/${WHICH}`, original)).status).toBe(200);
    const tampered = original.slice();
    tampered[tampered.length - 10] = tampered[tampered.length - 10]! ^ 0xff;
    const res = await put(`other/${WHICH}`, tampered);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("which-2.23-4.fc44.x86_64 already exists");
  });

  it("validates uploads", async () => {
    expect((await put("x.rpm", new TextEncoder().encode("not an rpm"))).status).toBe(400);
    expect((await put("x.deb", fixture(WHICH))).status).toBe(400);
    expect((await put(`repodata/${WHICH}`, fixture(WHICH))).status).toBe(400);
  });

  it("challenges anonymous clients", async () => {
    const res = await h.request("/rpm/el/repodata/repomd.xml");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
  });

  it("deletes packages and keeps recent repodata generations", async () => {
    await put(`upload/${WHICH}`, fixture(WHICH));
    const first = await repodata();
    await put(`upload/${BASESYSTEM}`, fixture(BASESYSTEM));
    const res = await h.request(`/api/v1/rpm/el/packages/which-2.23-4.fc44.x86_64`, {
      method: "DELETE",
      headers: auth(),
    });
    expect(res.status).toBe(204);
    const after = await repodata();
    expect(after.xml.primary).toContain('packages="1"');
    expect(after.xml.primary).not.toContain("<name>which</name>");
    expect((await get(`Packages/w/${WHICH}`)).status).toBe(404);
    // The first generation's files are still there for clients mid-refresh.
    expect((await get(first.data.primary!.location)).status).toBe(200);
    // Two more generations push the first one out.
    await put("upload/which-el8.rpm", fixture("which-2.21-20.el8.x86_64.rpm"));
    await repodata();
    await h.request(`/api/v1/rpm/el/packages/basesystem-0:11-20.fc40.noarch`, {
      method: "DELETE",
      headers: auth(),
    });
    expect((await repodata()).xml.primary).toContain('ver="2.21" rel="20.el8"');
    expect((await get(first.data.primary!.location)).status).toBe(404);
    const missing = await h.request(`/api/v1/rpm/el/packages/nope-1-1.noarch`, {
      method: "DELETE",
      headers: auth(),
    });
    expect(missing.status).toBe(404);
  });

  it("rotates the signing key", async () => {
    await put(`upload/${WHICH}`, fixture(WHICH));
    const oldKey = new TextDecoder().decode(await bytes("key.asc"));
    const res = await h.request("/api/v1/rpm/el/rotate-key", { method: "POST", headers: auth() });
    expect(res.status).toBe(200);
    const newKey = new TextDecoder().decode(await bytes("repodata/repomd.xml.key"));
    expect(newKey).not.toBe(oldKey);
    const repomd = new TextDecoder().decode(await bytes("repodata/repomd.xml"));
    const asc = new TextDecoder().decode(await bytes("repodata/repomd.xml.asc"));
    expect(await verifyDetached(repomd, asc, newKey)).toBe(true);
  });
});

describe("rpm remote repositories", () => {
  let h: Harness;
  const hits: string[] = [];
  const which = fixture(WHICH);
  const repomd = '<?xml version="1.0"?><repomd/>\n';

  beforeEach(async () => {
    hits.length = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      hits.push(url.pathname);
      if (url.pathname === "/fedora/repodata/repomd.xml") return new Response(repomd);
      if (url.pathname === "/fedora/repodata/abc-primary.xml.gz") return new Response("gz");
      if (url.pathname === `/fedora/Packages/w/${WHICH}`) return new Response(which);
      return new Response("missing", { status: 404 });
    });
    h = await makeHarness();
    await h.createRepo({
      key: "fedora",
      format: "rpm",
      kind: "remote",
      visibility: "public",
      config: { upstream: "https://mirror.example.org/fedora" },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("proxies repodata and packages with caching", async () => {
    for (let i = 0; i < 2; i++) {
      expect(await (await h.request("/rpm/fedora/repodata/repomd.xml")).text()).toBe(repomd);
      expect(await (await h.request("/rpm/fedora/repodata/abc-primary.xml.gz")).text()).toBe("gz");
      const rpm = await h.request(`/rpm/fedora/Packages/w/${WHICH}`);
      expect(sha256(new Uint8Array(await rpm.arrayBuffer()))).toBe(sha256(which));
    }
    expect(hits).toEqual([
      "/fedora/repodata/repomd.xml",
      "/fedora/repodata/abc-primary.xml.gz",
      `/fedora/Packages/w/${WHICH}`,
    ]);
    expect((await h.request("/rpm/fedora/repodata/repomd.xml.asc")).status).toBe(404);
    const config = await (await h.request("/rpm/fedora/config.repo")).text();
    expect(config).toContain("baseurl=https://pkg.test/rpm/fedora/");
    expect(config).toContain("gpgcheck=1\n");
  });
});
