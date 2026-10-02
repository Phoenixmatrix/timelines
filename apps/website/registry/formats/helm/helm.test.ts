import { createHash } from "node:crypto";

import { gzipSync, writeTar } from "@gitmatrix/formats/archive";
import { parseIndex } from "@gitmatrix/formats/helm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { invalidateMembers } from "../../core/virtual.ts";
import { basic, makeHarness, REGISTRY_URL, type Harness } from "../../testing/harness.ts";

function chart(name: string, version: string, values = "replicas: 1\n"): Uint8Array {
  return gzipSync(
    writeTar([
      {
        name: `${name}/Chart.yaml`,
        data: `apiVersion: v2\nname: ${name}\nversion: ${version}\nappVersion: "1.0"\ndescription: The ${name} chart\n`,
      },
      { name: `${name}/values.yaml`, data: values },
    ]),
  );
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function multipart(fields: Record<string, Uint8Array | string>): {
  body: Uint8Array;
  type: string;
} {
  const boundary = "----gitmatrix-test";
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${name}.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      typeof value === "string" ? enc.encode(value) : value,
      enc.encode("\r\n"),
    );
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.length;
  }
  return { body, type: `multipart/form-data; boundary=${boundary}` };
}

const prov = (name: string, version: string) =>
  `-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA512\n\napiVersion: v2\nname: ${name}\nversion: ${version}\n\n...\nfiles:\n  ${name}-${version}.tgz: sha256:abc\n-----BEGIN PGP SIGNATURE-----\n\nsig\n-----END PGP SIGNATURE-----\n`;

describe("helm local repositories", () => {
  let h: Harness;
  let admin: string;
  let writer: string;

  const api = (path: string, init: RequestInit = {}, token = admin) =>
    h.request(`/helm/charts/${path}`, {
      ...init,
      headers: { authorization: basic(token), ...(init.headers as Record<string, string>) },
    });

  beforeEach(async () => {
    h = await makeHarness();
    admin = await h.adminToken();
    writer = h.token("bob");
    await h.createRepo({ key: "charts", format: "helm", kind: "local", visibility: "private" });
    await h.request("/api/v1/repositories/charts/permissions", {
      method: "PUT",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: JSON.stringify({ principal: "user:bob", role: "write" }),
    });
  });

  it("uploads through the ChartMuseum API and serves index.yaml", async () => {
    const tgz = chart("web", "1.2.3");
    const res = await api("api/charts", { method: "POST", body: tgz }, writer);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ saved: true });
    await api("api/charts", { method: "POST", body: chart("web", "1.10.0") }, writer);

    const index = await api("index.yaml");
    expect(index.status).toBe(200);
    const parsed = parseIndex(await index.text());
    expect(parsed.apiVersion).toBe("v1");
    expect(parsed.generated).toBeTruthy();
    const web = parsed.entries.web!;
    expect(web.map((v) => v.version)).toEqual(["1.10.0", "1.2.3"]);
    expect(web[1]).toMatchObject({
      name: "web",
      apiVersion: "v2",
      appVersion: "1.0",
      description: "The web chart",
      digest: sha256(tgz),
      urls: [`${REGISTRY_URL}/helm/charts/charts/web-1.2.3.tgz`],
    });
    expect(web[1]!.created).toMatch(/^\d{4}-\d\d-\d\dT/);

    const download = await h.request(new URL(web[1]!.urls[0]!).pathname, {
      headers: { authorization: basic(writer) },
    });
    expect(download.status).toBe(200);
    expect(sha256(new Uint8Array(await download.arrayBuffer()))).toBe(sha256(tgz));
  });

  it("accepts multipart uploads with provenance (helm cm-push)", async () => {
    const form = multipart({ chart: chart("api", "0.1.0"), prov: prov("api", "0.1.0") });
    const res = await api(
      "api/charts",
      { method: "POST", body: form.body, headers: { "content-type": form.type } },
      writer,
    );
    expect(res.status).toBe(201);
    const provRes = await api("charts/api-0.1.0.tgz.prov");
    expect(await provRes.text()).toContain("name: api");
    const provOnly = await api("api/prov", { method: "POST", body: prov("api", "0.1.0") }, writer);
    expect(provOnly.status).toBe(201);
  });

  it("accepts plain PUT uploads and checks the filename", async () => {
    const ok = await api("charts/db-2.0.0.tgz", { method: "PUT", body: chart("db", "2.0.0") });
    expect(ok.status).toBe(201);
    const wrong = await api("charts/db-9.9.9.tgz", { method: "PUT", body: chart("db", "2.0.1") });
    expect(wrong.status).toBe(400);
  });

  it("applies the overwrite rules", async () => {
    const post = (body: Uint8Array, query = "", token = writer) =>
      api(`api/charts${query}`, { method: "POST", body }, token);
    const original = chart("app", "1.0.0");
    expect((await post(original)).status).toBe(201);
    // Reuse identical bytes: regenerating gzip can change its timestamp.
    expect((await post(original)).status).toBe(201);
    const changed = chart("app", "1.0.0", "replicas: 3\n");
    const conflict = await post(changed);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: expect.stringContaining("exists") });
    expect((await post(changed, "?force", writer)).status).toBe(403);
    expect((await post(changed, "?force=true", admin)).status).toBe(201);
    const index = parseIndex(await (await api("index.yaml")).text());
    expect(index.entries.app![0]!.digest).toBe(sha256(changed));
  });

  it("rejects invalid charts", async () => {
    const bad = gzipSync(
      writeTar([{ name: "x/Chart.yaml", data: "apiVersion: v2\nname: x\nversion: one\n" }]),
    );
    const res = await api("api/charts", { method: "POST", body: bad });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("SemVer") });
    expect((await api("api/charts", { method: "POST", body: "junk" })).status).toBe(400);
  });

  it("lists, gets and deletes chart versions", async () => {
    await api("api/charts", { method: "POST", body: chart("svc", "1.0.0") });
    await api("api/charts", { method: "POST", body: chart("svc", "2.0.0") });
    const all = (await (await api("api/charts")).json()) as Record<string, unknown[]>;
    expect(all.svc).toHaveLength(2);
    expect(await (await api("api/charts/svc/latest")).json()).toMatchObject({ version: "2.0.0" });
    expect((await api("api/charts/svc/3.0.0")).status).toBe(404);
    expect((await api("api/charts/svc/1.0.0", { method: "DELETE" }, writer)).status).toBe(403);
    const del = await api("api/charts/svc/1.0.0", { method: "DELETE" });
    expect(await del.json()).toEqual({ deleted: true });
    const versions = (await (await api("api/charts/svc")).json()) as { version: string }[];
    expect(versions.map((v) => v.version)).toEqual(["2.0.0"]);
    expect((await api("charts/svc-1.0.0.tgz")).status).toBe(404);
    await api("api/charts/svc/2.0.0", { method: "DELETE" });
    expect((await api("api/charts/svc")).status).toBe(404);
  });

  it("challenges anonymous clients of private repositories", async () => {
    const res = await h.request("/helm/charts/index.yaml");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
    const upload = await h.request("/helm/charts/api/charts", {
      method: "POST",
      body: chart("x", "1.0.0"),
    });
    expect(upload.status).toBe(401);
  });

  it("serves an empty index before the first upload", async () => {
    const index = parseIndex(await (await api("index.yaml")).text());
    expect(index.entries).toEqual({});
  });
});

describe("helm remote and virtual repositories", () => {
  let h: Harness;
  let admin: string;
  const hits: string[] = [];
  const good = chart("nginx", "15.0.0");
  const other = chart("redis", "18.0.0");
  const tampered = chart("redis", "17.0.0");

  const upstreamIndex = `apiVersion: v1
entries:
  nginx:
    - apiVersion: v2
      name: nginx
      version: 15.0.0
      digest: ${sha256(good)}
      urls:
        - https://charts.example.com/bitnami/nginx-15.0.0.tgz
  redis:
    - apiVersion: v2
      name: redis
      version: 18.0.0
      digest: ${sha256(other)}
      urls:
        - redis-18.0.0.tgz
    - apiVersion: v2
      name: redis
      version: 17.0.0
      digest: ${"f".repeat(64)}
      urls:
        - https://cdn.example.org/redis-17.0.0.tgz
  web:
    - apiVersion: v2
      name: web
      version: 9.0.0
      digest: ${"e".repeat(64)}
      urls:
        - web-9.0.0.tgz
generated: "2026-01-01T00:00:00Z"
`;

  beforeEach(async () => {
    invalidateMembers();
    hits.length = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      hits.push(url.href);
      switch (url.href) {
        case "https://charts.example.com/bitnami/index.yaml":
          return new Response(upstreamIndex);
        case "https://charts.example.com/bitnami/nginx-15.0.0.tgz":
          return new Response(good);
        case "https://charts.example.com/bitnami/redis-18.0.0.tgz":
          return new Response(other);
        case "https://cdn.example.org/redis-17.0.0.tgz":
          return new Response(tampered);
        default:
          return new Response("nope", { status: 404 });
      }
    });
    h = await makeHarness();
    admin = await h.adminToken();
    await h.createRepo({ key: "mine", format: "helm", kind: "local", visibility: "public" });
    await h.createRepo({
      key: "bitnami",
      format: "helm",
      kind: "remote",
      visibility: "public",
      config: { upstream: "https://charts.example.com/bitnami" },
    });
    await h.createRepo({
      key: "all",
      format: "helm",
      kind: "virtual",
      visibility: "public",
      config: { defaultDeployRepo: "mine", pinnedNamespaces: ["web"] },
      members: [{ key: "bitnami" }, { key: "mine" }],
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("rewrites upstream chart URLs back to the registry", async () => {
    const res = await h.request("/helm/bitnami/index.yaml");
    expect(res.status).toBe(200);
    const index = parseIndex(await res.text());
    expect(index.entries.nginx![0]!.urls).toEqual([
      `${REGISTRY_URL}/helm/bitnami/remote-charts/${sha256(good)}/nginx-15.0.0.tgz`,
    ]);
    const redis = index.entries.redis![0]!.urls[0]!;
    expect(redis).toBe(
      `${REGISTRY_URL}/helm/bitnami/remote-charts/${sha256(other)}/redis-18.0.0.tgz`,
    );

    const download = await h.request(new URL(redis).pathname);
    expect(download.status).toBe(200);
    expect(sha256(new Uint8Array(await download.arrayBuffer()))).toBe(sha256(other));
    // The index is fetched once and cached; the chart is cached too.
    await h.request(new URL(redis).pathname);
    expect(hits.filter((u) => u.endsWith("index.yaml"))).toHaveLength(1);
    expect(hits.filter((u) => u.endsWith("redis-18.0.0.tgz"))).toHaveLength(1);
  });

  it("verifies chart digests and only fetches URLs from the index", async () => {
    const index = parseIndex(await (await h.request("/helm/bitnami/index.yaml")).text());
    const bad = index.entries.redis![1]!.urls[0]!;
    expect((await h.request(new URL(bad).pathname)).status).toBe(502);
    hits.length = 0;
    const forged = await h.request(`/helm/bitnami/remote-charts/${"a".repeat(64)}/evil.tgz`);
    expect(forged.status).toBe(404);
    expect(hits.some((u) => u.includes("evil"))).toBe(false);
  });

  it("merges members and rewrites URLs to the virtual repository", async () => {
    const put = await h.request("/helm/all/api/charts", {
      method: "POST",
      headers: { authorization: basic(admin) },
      body: chart("nginx", "1.0.0"),
    });
    expect(put.status).toBe(201);
    await h.request("/helm/mine/api/charts", {
      method: "POST",
      headers: { authorization: basic(admin) },
      body: chart("web", "1.0.0"),
    });
    const index = parseIndex(await (await h.request("/helm/all/index.yaml")).text());
    // The local member owns nginx; redis comes from the remote; pinned web never does.
    expect(index.entries.nginx!.map((v) => v.version)).toEqual(["1.0.0"]);
    expect(index.entries.redis!.map((v) => v.version)).toEqual(["18.0.0", "17.0.0"]);
    expect(index.entries.web!.map((v) => v.version)).toEqual(["1.0.0"]);
    expect(index.entries.nginx![0]!.urls[0]).toBe(
      `${REGISTRY_URL}/helm/all/charts/nginx-1.0.0.tgz`,
    );
    const redisUrl = index.entries.redis![0]!.urls[0]!;
    expect(redisUrl.startsWith(`${REGISTRY_URL}/helm/all/remote-charts/`)).toBe(true);

    expect((await h.request(new URL(index.entries.nginx![0]!.urls[0]!).pathname)).status).toBe(200);
    const remote = await h.request(new URL(redisUrl).pathname);
    expect(sha256(new Uint8Array(await remote.arrayBuffer()))).toBe(sha256(other));
  });

  it("merges versions across members with mergeVersions", async () => {
    await h.request("/api/v1/repositories/all", {
      method: "PATCH",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: JSON.stringify({
        config: { defaultDeployRepo: "mine", mergeVersions: true },
        members: [{ key: "bitnami" }, { key: "mine" }],
      }),
    });
    invalidateMembers();
    await h.request("/helm/mine/api/charts", {
      method: "POST",
      headers: { authorization: basic(admin) },
      body: chart("nginx", "1.0.0"),
    });
    const index = parseIndex(await (await h.request("/helm/all/index.yaml")).text());
    expect(index.entries.nginx!.map((v) => v.version)).toEqual(["15.0.0", "1.0.0"]);
  });
});
