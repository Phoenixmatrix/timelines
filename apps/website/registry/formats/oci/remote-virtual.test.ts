import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { basic, makeHarness, type Harness } from "../../testing/harness.ts";
import { bearer, jwtClaims, OCI_MANIFEST, pushImage, sha, streamOf } from "./testing.ts";
import { resetUpstreamTokens } from "./upstream.ts";

const CONFIG = '{"architecture":"amd64","os":"linux"}';
const LAYER = "alpine layer bytes";
const MANIFEST = JSON.stringify({
  schemaVersion: 2,
  mediaType: OCI_MANIFEST,
  config: {
    mediaType: "application/vnd.oci.image.config.v1+json",
    digest: sha(CONFIG),
    size: CONFIG.length,
  },
  layers: [
    { mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: sha(LAYER), size: 18 },
  ],
});
const MANIFEST_DIGEST = sha(MANIFEST);
const CHALLENGE =
  'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/alpine:pull"';

describe("OCI remote and virtual repositories", () => {
  let h: Harness;
  let admin: string;
  let hits: string[];
  let realmAuth: (string | null)[];
  let tamper: boolean;

  beforeEach(async () => {
    resetUpstreamTokens();
    hits = [];
    realmAuth = [];
    tamper = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      const auth = req.headers.get("authorization");
      hits.push(`${req.method} ${url.host}${url.pathname}`);
      if (url.host === "auth.docker.io") {
        realmAuth.push(auth);
        expect(url.searchParams.get("service")).toBe("registry.docker.io");
        expect(url.searchParams.get("scope")).toBe("repository:library/alpine:pull");
        return Response.json({ token: "upstream-token", expires_in: 300 });
      }
      if (url.host === "cdn.example.com") {
        // Presigned storage: must never see the registry token.
        if (auth) return new Response("credentials leaked", { status: 400 });
        return new Response(tamper ? "tampered layer bytes" : LAYER);
      }
      if (url.host !== "registry-1.docker.io") return new Response("no", { status: 404 });
      if (auth !== "Bearer upstream-token") {
        return Response.json(
          { errors: [{ code: "UNAUTHORIZED" }] },
          { status: 401, headers: { "www-authenticate": CHALLENGE } },
        );
      }
      const path = url.pathname;
      if (
        path === "/v2/library/alpine/manifests/3.20" ||
        path === `/v2/library/alpine/manifests/${MANIFEST_DIGEST}`
      ) {
        return new Response(req.method === "HEAD" ? null : MANIFEST, {
          headers: {
            "content-type": OCI_MANIFEST,
            "docker-content-digest": MANIFEST_DIGEST,
            "content-length": String(MANIFEST.length),
          },
        });
      }
      if (path === `/v2/library/alpine/blobs/${sha(LAYER)}`) {
        return new Response(null, {
          status: 307,
          headers: { location: "https://cdn.example.com/layer?sig=abc" },
        });
      }
      if (path === `/v2/library/alpine/blobs/${sha(CONFIG)}`) return new Response(CONFIG);
      if (path === "/v2/library/alpine/tags/list") {
        return Response.json({ name: "library/alpine", tags: ["3.20", "3.19"] });
      }
      return Response.json({ errors: [{ code: "MANIFEST_UNKNOWN" }] }, { status: 404 });
    });

    h = await makeHarness();
    admin = await h.adminToken();
    await h.createRepo({ key: "local", format: "oci", kind: "local", visibility: "private" });
    await h.createRepo({
      key: "hub",
      format: "oci",
      kind: "remote",
      visibility: "public",
      config: { upstream: "https://registry-1.docker.io" },
    });
    await h.createRepo({
      key: "all",
      format: "oci",
      kind: "virtual",
      visibility: "private",
      config: { defaultDeployRepo: "local" },
      members: [{ key: "hub" }, { key: "local" }],
    });
    await h.request("/api/v1/repositories/all/permissions", {
      method: "PUT",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: JSON.stringify({ principal: "user:bob", role: "read" }),
    });
    await h.request("/api/v1/repositories/local/permissions", {
      method: "PUT",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: JSON.stringify({ principal: "user:bob", role: "write" }),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  describe("remote", () => {
    it("pulls through with the token dance and library/ prefix, then serves from cache", async () => {
      const token = await bearer(h, null, ["repository:hub/alpine:pull"]);
      const res = await h.request("/v2/hub/alpine/manifests/3.20", {
        headers: { authorization: token },
      });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(await res.text()).toBe(MANIFEST);
      expect(res.headers.get("docker-content-digest")).toBe(MANIFEST_DIGEST);
      expect(res.headers.get("content-type")).toBe(OCI_MANIFEST);
      expect(realmAuth).toEqual([null]);

      const layer = await h.request(`/v2/hub/alpine/blobs/${sha(LAYER)}`, {
        headers: { authorization: token },
      });
      expect(layer.status).toBe(200);
      expect(await layer.text()).toBe(LAYER);
      expect(hits).toContain("GET cdn.example.com/layer");

      const before = hits.length;
      const again = await h.request("/v2/hub/alpine/manifests/3.20", {
        method: "HEAD",
        headers: { authorization: token },
      });
      expect(again.status).toBe(200);
      expect(again.headers.get("content-length")).toBe(String(MANIFEST.length));
      expect((await h.request(`/v2/hub/alpine/blobs/${sha(LAYER)}`)).status).toBe(200);
      expect(hits.length).toBe(before);
      // One token fetch served every upstream request.
      expect(hits.filter((hit) => hit.startsWith("GET auth.docker.io"))).toHaveLength(1);
    });

    it("sends configured upstream credentials to the token realm", async () => {
      await h.createRepo({
        key: "hub-auth",
        format: "oci",
        kind: "remote",
        visibility: "public",
        config: {
          upstream: "https://registry-1.docker.io",
          upstreamUsername: "mirror",
          upstreamPassword: "s3cret",
        },
      });
      const res = await h.request(`/v2/hub-auth/alpine/manifests/${MANIFEST_DIGEST}`);
      expect(res.status).toBe(200);
      expect(realmAuth).toEqual([`Basic ${btoa("mirror:s3cret")}`]);
    });

    it("refuses upstream content that does not match its digest", async () => {
      tamper = true;
      const res = await h.request(`/v2/hub/alpine/blobs/${sha(LAYER)}`);
      expect(res.status).toBe(502);
      tamper = false;
      const retry = await h.request(`/v2/hub/alpine/blobs/${sha(LAYER)}`);
      expect(await retry.text()).toBe(LAYER);
    });

    it("proxies tags and misses, and is read-only", async () => {
      const tags = await h.request("/v2/hub/alpine/tags/list");
      expect(await tags.json()).toEqual({ name: "hub/alpine", tags: ["3.19", "3.20"] });
      expect((await h.request("/v2/hub/alpine/manifests/nope")).status).toBe(404);
      const push = await h.request("/v2/hub/alpine/blobs/uploads/", {
        method: "POST",
        headers: { authorization: basic(admin) },
      });
      expect(push.status).toBe(405);
      expect(((await push.json()) as { errors: { code: string }[] }).errors[0]!.code).toBe(
        "UNSUPPORTED",
      );
    });
  });

  describe("virtual", () => {
    it("pushes to the deploy target and resolves locals before remotes", async () => {
      const bob = h.token("bob");
      const token = await bearer(h, bob, ["repository:all/alpine:pull,push"]);
      const claims = jwtClaims(token.slice(7));
      expect(claims.access).toEqual([
        { type: "repository", name: "all/alpine", actions: ["pull", "push"] },
        { type: "repository", name: "local/alpine", actions: ["pull", "push"] },
        { type: "repository", name: "hub/alpine", actions: ["pull"] },
      ]);

      // Before anything is local, the remote member answers.
      const remote = await h.request("/v2/all/alpine/manifests/3.20", {
        headers: { authorization: token },
      });
      expect(await remote.text()).toBe(MANIFEST);

      const pushed = await pushImage(h, token, "all/alpine", "3.20", "our own alpine");
      const local = await h.request("/v2/all/alpine/manifests/3.20", {
        headers: { authorization: token },
      });
      expect(await local.text()).toBe(pushed.body);
      const direct = await h.request("/v2/local/alpine/manifests/3.20", {
        headers: { authorization: basic(bob) },
      });
      expect(await direct.text()).toBe(pushed.body);

      // Upstream-only content still falls through, blobs included.
      const upstreamOnly = await h.request(`/v2/all/alpine/manifests/${MANIFEST_DIGEST}`, {
        headers: { authorization: token },
      });
      expect(upstreamOnly.status).toBe(200);
      const layer = await h.request(`/v2/all/alpine/blobs/${sha(LAYER)}`, {
        headers: { authorization: token },
      });
      expect(await layer.text()).toBe(LAYER);

      const tags = await h.request("/v2/all/alpine/tags/list", {
        headers: { authorization: token },
      });
      expect(await tags.json()).toEqual({ name: "all/alpine", tags: ["3.19", "3.20"] });
    });

    it("chunk-uploads through the virtual repository", async () => {
      const auth = basic(h.token("bob"));
      const data = new TextEncoder().encode("chunked through virtual");
      const start = await h.request("/v2/all/tool/blobs/uploads/", {
        method: "POST",
        headers: { authorization: auth },
      });
      expect(start.status).toBe(202);
      expect(start.headers.get("location")).toMatch(/^\/v2\/all\/tool\/blobs\/uploads\//);
      const patch = await h.request(start.headers.get("location")!, {
        method: "PATCH",
        headers: { authorization: auth },
        body: streamOf(data, 5),
        duplex: "half",
      } as RequestInit);
      expect(patch.status).toBe(202);
      const put = await h.request(`${patch.headers.get("location")}?digest=${sha(data)}`, {
        method: "PUT",
        headers: { authorization: auth },
      });
      expect(put.status).toBe(201);
      const get = await h.request(`/v2/local/tool/blobs/${sha(data)}`, {
        headers: { authorization: auth },
      });
      expect(await get.text()).toBe("chunked through virtual");
    });

    it("refuses concurrent writers on one upload session", async () => {
      const auth = basic(h.token("bob"));
      const start = await h.request("/v2/local/tool/blobs/uploads/", {
        method: "POST",
        headers: { authorization: auth },
      });
      const location = start.headers.get("location")!;
      let finishSlow!: () => void;
      const gate = new Promise<void>((resolve) => (finishSlow = resolve));
      let sent = false;
      const slow = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new TextEncoder().encode("first"));
            return;
          }
          await gate;
          controller.close();
        },
      });
      const first = h.request(location, {
        method: "PATCH",
        headers: { authorization: auth },
        body: slow,
        duplex: "half",
      } as RequestInit);
      await new Promise((r) => setTimeout(r, 20));
      const second = await h.request(location, {
        method: "PATCH",
        headers: { authorization: auth },
        body: "second",
      });
      expect(second.status).toBe(416);
      finishSlow();
      expect((await first).status).toBe(202);
      const status = await h.request(location, { headers: { authorization: auth } });
      expect(status.headers.get("range")).toBe("0-4");
    });
  });
});
