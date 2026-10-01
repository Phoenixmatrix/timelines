import { randomBytes } from "node:crypto";

import { beforeEach, describe, expect, it } from "vite-plus/test";

import { basic, makeHarness, type Harness } from "../../testing/harness.ts";
import {
  bearer,
  hashOf,
  jwtClaims,
  OCI_INDEX,
  OCI_MANIFEST,
  pushBlob,
  pushImage,
  putManifest,
  sha,
  streamOf,
} from "./testing.ts";

const MiB = 1024 * 1024;

describe("OCI registry (local repositories)", () => {
  let h: Harness;
  let admin: string;
  let bob: string;
  let carol: string;
  let adminAuth: string;

  async function grant(repo: string, principal: string, role: string) {
    const res = await h.request(`/api/v1/repositories/${repo}/permissions`, {
      method: "PUT",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: JSON.stringify({ principal, role }),
    });
    expect(res.status).toBe(204);
  }

  beforeEach(async () => {
    h = await makeHarness();
    admin = await h.adminToken();
    adminAuth = basic(admin);
    bob = h.token("bob");
    carol = h.token("carol");
    for (const [key, visibility] of [
      ["images", "private"],
      ["pub", "public"],
      ["secret", "private"],
    ] as const) {
      // `secret` belongs to another org, so bob (a member of the test org) can't read it.
      const owner = key === "secret" ? "elsewhere" : undefined;
      expect(
        (await h.createRepo({ key, format: "oci", kind: "local", visibility, owner })).status,
      ).toBe(201);
    }
    await grant("images", "user:bob", "write");
  });

  describe("auth and token service", () => {
    it("challenges anonymous /v2/ and accepts credentials or tokens", async () => {
      const anon = await h.request("/v2/");
      expect(anon.status).toBe(401);
      expect(anon.headers.get("www-authenticate")).toBe(
        'Bearer realm="https://pkg.test/v2/token",service="pkg.test"',
      );
      expect(anon.headers.get("docker-distribution-api-version")).toBe("registry/2.0");
      expect(((await anon.json()) as { errors: { code: string }[] }).errors[0]!.code).toBe(
        "UNAUTHORIZED",
      );

      const withPat = await h.request("/v2/", { headers: { authorization: basic(bob) } });
      expect(withPat.status).toBe(200);
      expect(await withPat.json()).toEqual({});

      const login = await bearer(h, bob, []);
      expect((await h.request("/v2", { headers: { authorization: login } })).status).toBe(200);
    });

    it("rejects bad credentials at the token service", async () => {
      const res = await h.request("/v2/token?service=pkg.test", {
        headers: { authorization: basic("tm_pat_bogus") },
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Basic");
    });

    it("grants exactly what the caller may do", async () => {
      const anonPub = jwtClaims((await bearer(h, null, ["repository:pub/app:pull,push"])).slice(7));
      expect(anonPub.access).toEqual([{ type: "repository", name: "pub/app", actions: ["pull"] }]);

      const anonPrivate = jwtClaims(
        (await bearer(h, null, ["repository:images/app:pull"])).slice(7),
      );
      expect(anonPrivate.access).toEqual([]);

      const bobs = jwtClaims(
        (
          await bearer(h, bob, [
            "repository:images/app:pull,push",
            "repository:secret/x:pull",
            "repository:images/app:delete",
          ])
        ).slice(7),
      );
      expect(bobs.access).toEqual([
        { type: "repository", name: "images/app", actions: ["pull", "push"] },
      ]);

      const catalog = jwtClaims((await bearer(h, admin, ["registry:catalog:*"])).slice(7));
      expect(catalog.access).toEqual([{ type: "registry", name: "catalog", actions: ["*"] }]);
    });

    it("supports the OAuth2 POST form containerd uses", async () => {
      const form = new URLSearchParams({
        grant_type: "password",
        username: "bob",
        password: bob,
        service: "pkg.test",
        scope: "repository:images/app:pull,push",
        client_id: "containerd",
      });
      const res = await h.request("/v2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { access_token: string; expires_in: number };
      expect(body.expires_in).toBeGreaterThan(0);
      expect(jwtClaims(body.access_token).access[0]!.actions).toEqual(["pull", "push"]);

      const bad = await h.request("/v2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "password", password: "tm_pat_nope" }).toString(),
      });
      expect(bad.status).toBe(401);
    });

    it("answers 401 with a scoped challenge for private names", async () => {
      const res = await h.request("/v2/images/app/manifests/latest");
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(
        'Bearer realm="https://pkg.test/v2/token",service="pkg.test",scope="repository:images/app:pull"',
      );
      const push = await h.request("/v2/images/app/blobs/uploads/", { method: "POST" });
      expect(push.headers.get("www-authenticate")).toContain(
        'scope="repository:images/app:pull,push"',
      );
      // Unknown repositories look the same to anonymous callers.
      expect((await h.request("/v2/nope/app/tags/list")).status).toBe(401);
    });

    it("asks a token holder without the grant to re-authenticate", async () => {
      const token = await bearer(h, carol, ["repository:images/app:pull,push"]);
      const res = await h.request("/v2/images/app/blobs/uploads/", {
        method: "POST",
        headers: { authorization: token },
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
      // A PAT used directly gets a plain 403.
      const direct = await h.request("/v2/images/app/blobs/uploads/", {
        method: "POST",
        headers: { authorization: basic(carol) },
      });
      expect(direct.status).toBe(403);
      expect(((await direct.json()) as { errors: { code: string }[] }).errors[0]!.code).toBe(
        "DENIED",
      );
    });

    it("lets anonymous callers pull public images through the token flow", async () => {
      const image = await pushImage(h, adminAuth, "pub/tool", "v1", "layer-bytes");
      const token = await bearer(h, null, ["repository:pub/tool:pull"]);
      const res = await h.request("/v2/pub/tool/manifests/v1", {
        headers: { authorization: token },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(image.body);
      // Pushing with that token is refused.
      const push = await h.request("/v2/pub/tool/blobs/uploads/", {
        method: "POST",
        headers: { authorization: token },
      });
      expect(push.status).toBe(401);
    });
  });

  describe("push and pull", () => {
    it("pushes monolithically and pulls by tag and digest", async () => {
      const auth = await bearer(h, bob, ["repository:images/app:pull,push"]);
      const image = await pushImage(h, auth, "images/app", "1.0", "hello layer");

      const byTag = await h.request("/v2/images/app/manifests/1.0", {
        headers: { authorization: auth, accept: OCI_MANIFEST },
      });
      expect(byTag.status).toBe(200);
      expect(byTag.headers.get("content-type")).toBe(OCI_MANIFEST);
      expect(byTag.headers.get("docker-content-digest")).toBe(image.digest);
      expect(await byTag.text()).toBe(image.body);

      const head = await h.request(`/v2/images/app/manifests/${image.digest}`, {
        method: "HEAD",
        headers: { authorization: auth },
      });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(image.body.length));
      expect(head.headers.get("content-type")).toBe(OCI_MANIFEST);
      expect(head.headers.get("docker-content-digest")).toBe(image.digest);

      const blob = await h.request(`/v2/images/app/blobs/${image.layer.digest}`, {
        headers: { authorization: auth, range: "bytes=0-4" },
      });
      expect(blob.status).toBe(206);
      expect(await blob.text()).toBe("hello");
      const headBlob = await h.request(`/v2/images/app/blobs/${image.layer.digest}`, {
        method: "HEAD",
        headers: { authorization: auth },
      });
      expect(headBlob.headers.get("docker-content-digest")).toBe(image.layer.digest);
      expect(headBlob.headers.get("content-length")).toBe("11");
    });

    it("keeps blobs private to the image they were pushed to", async () => {
      const layer = await pushBlob(h, adminAuth, "secret/base", "top secret layer");
      const res = await h.request(`/v2/images/app/blobs/${layer.digest}`, {
        headers: { authorization: basic(bob) },
      });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { errors: { code: string }[] }).errors[0]!.code).toBe(
        "BLOB_UNKNOWN",
      );
    });

    it("rejects bad digests and names", async () => {
      const auth = basic(bob);
      const wrong = await h.request(`/v2/images/app/blobs/uploads/?digest=${sha("other")}`, {
        method: "POST",
        headers: { authorization: auth },
        body: "data",
      });
      expect(wrong.status).toBe(400);
      expect(((await wrong.json()) as { errors: { code: string }[] }).errors[0]!.code).toBe(
        "DIGEST_INVALID",
      );
      const sha512 = await h.request(`/v2/images/app/blobs/sha512:${"a".repeat(128)}`, {
        headers: { authorization: auth },
      });
      expect(((await sha512.json()) as { errors: { code: string }[] }).errors[0]!.code).toBe(
        "UNSUPPORTED",
      );
      const badName = await h.request("/v2/images/App/tags/list", {
        headers: { authorization: auth },
      });
      expect(((await badName.json()) as { errors: { code: string }[] }).errors[0]!.code).toBe(
        "NAME_INVALID",
      );
    });

    it("streams a multi-PATCH chunked upload across part boundaries", async () => {
      const auth = basic(bob);
      const data = randomBytes(19 * MiB + 12345);
      const digest = sha(data);

      const start = await h.request("/v2/images/big/blobs/uploads/", {
        method: "POST",
        headers: { authorization: auth },
      });
      expect(start.status).toBe(202);
      expect(start.headers.get("range")).toBe("0-0");
      expect(start.headers.get("oci-chunk-min-length")).toBe(String(8 * MiB));
      const uuid = start.headers.get("docker-upload-uuid")!;
      let location = start.headers.get("location")!;
      expect(location).toBe(`/v2/images/big/blobs/uploads/${uuid}`);

      // 5 MiB, then 7 MiB (crosses the first 8 MiB part), then a chunked stream
      // with no Content-Length crossing the second, then the rest on PUT.
      const cuts = [0, 5 * MiB, 12 * MiB, 18 * MiB + 7];
      for (let i = 0; i < cuts.length - 1; i++) {
        const chunk = data.subarray(cuts[i], cuts[i + 1]);
        const streamed = i === 2;
        const res = await h.request(location, {
          method: "PATCH",
          headers: {
            authorization: auth,
            "content-type": "application/octet-stream",
            ...(streamed ? {} : { "content-range": `${cuts[i]}-${cuts[i + 1]! - 1}` }),
          },
          body: streamed ? streamOf(chunk, 300_000) : chunk,
          ...(streamed ? { duplex: "half" } : {}),
        } as RequestInit);
        expect(res.status, await res.clone().text()).toBe(202);
        expect(res.headers.get("range")).toBe(`0-${cuts[i + 1]! - 1}`);
        location = res.headers.get("location")!;
      }

      const status = await h.request(location, { headers: { authorization: auth } });
      expect(status.status).toBe(204);
      expect(status.headers.get("range")).toBe(`0-${18 * MiB + 6}`);

      const done = await h.request(`${location}?digest=${digest}`, {
        method: "PUT",
        headers: { authorization: auth, "content-type": "application/octet-stream" },
        body: data.subarray(18 * MiB + 7),
      });
      expect(done.status, await done.clone().text()).toBe(201);
      expect(done.headers.get("location")).toBe(`/v2/images/big/blobs/${digest}`);

      const get = await h.request(`/v2/images/big/blobs/${digest}`, {
        headers: { authorization: auth },
      });
      expect(get.headers.get("content-length")).toBe(String(data.length));
      expect(await hashOf(get)).toBe(digest);
      // Only the blob itself remains: no multipart leftovers or tails.
      expect([...h.bucket.objects.keys()].filter((k) => k.includes(".tail."))).toEqual([]);
    });

    it("accepts a whole layer as one chunked PATCH, like docker", async () => {
      const auth = await bearer(h, bob, ["repository:images/big:pull,push"]);
      const data = randomBytes(17 * MiB);
      const digest = sha(data);
      const start = await h.request("/v2/images/big/blobs/uploads/", {
        method: "POST",
        headers: { authorization: auth },
      });
      const patch = await h.request(start.headers.get("location")!, {
        method: "PATCH",
        headers: { authorization: auth },
        body: streamOf(data, 32 * 1024),
        duplex: "half",
      } as RequestInit);
      expect(patch.status).toBe(202);
      const put = await h.request(`${patch.headers.get("location")!}?digest=${digest}`, {
        method: "PUT",
        headers: { authorization: auth },
      });
      expect(put.status, await put.clone().text()).toBe(201);
      const get = await h.request(`/v2/images/big/blobs/${digest}`, {
        headers: { authorization: auth },
      });
      expect(await hashOf(get)).toBe(digest);
    });

    it("finishes a POST + single PUT upload and small chunk uploads", async () => {
      const auth = basic(bob);
      const start = await h.request("/v2/images/app/blobs/uploads/", {
        method: "POST",
        headers: { authorization: auth },
      });
      const put = await h.request(`${start.headers.get("location")}?digest=${sha("whole")}`, {
        method: "PUT",
        headers: { authorization: auth },
        body: "whole",
      });
      expect(put.status).toBe(201);

      const again = await h.request("/v2/images/app/blobs/uploads/", {
        method: "POST",
        headers: { authorization: auth },
      });
      const one = await h.request(again.headers.get("location")!, {
        method: "PATCH",
        headers: { authorization: auth, "content-range": "0-2" },
        body: "abc",
      });
      const two = await h.request(`${one.headers.get("location")}?digest=${sha("abcdef")}`, {
        method: "PUT",
        headers: { authorization: auth, "content-range": "3-5" },
        body: "def",
      });
      expect(two.status).toBe(201);
      const get = await h.request(`/v2/images/app/blobs/${sha("abcdef")}`, {
        headers: { authorization: auth },
      });
      expect(await get.text()).toBe("abcdef");
    });

    it("refuses out-of-order chunks with 416 and keeps the session", async () => {
      const auth = basic(bob);
      const start = await h.request("/v2/images/app/blobs/uploads/", {
        method: "POST",
        headers: { authorization: auth },
      });
      const location = start.headers.get("location")!;
      await h.request(location, {
        method: "PATCH",
        headers: { authorization: auth, "content-range": "0-3" },
        body: "abcd",
      });
      const bad = await h.request(location, {
        method: "PATCH",
        headers: { authorization: auth, "content-range": "10-13" },
        body: "wxyz",
      });
      expect(bad.status).toBe(416);
      expect(bad.headers.get("range")).toBe("0-3");
      const short = await h.request(location, {
        method: "PATCH",
        headers: { authorization: auth, "content-range": "4-9" },
        body: "ef",
      });
      expect(short.status).toBe(416);
      const status = await h.request(location, { headers: { authorization: auth } });
      expect(status.headers.get("range")).toBe("0-3");

      const mismatch = await h.request(`${location}?digest=${sha("nope")}`, {
        method: "PUT",
        headers: { authorization: auth },
      });
      expect(mismatch.status).toBe(400);
      expect(((await mismatch.json()) as { errors: { code: string }[] }).errors[0]!.code).toBe(
        "DIGEST_INVALID",
      );
      // A failed finalize ends the session.
      const gone = await h.request(location, { headers: { authorization: auth } });
      expect(gone.status).toBe(404);
      expect(((await gone.json()) as { errors: { code: string }[] }).errors[0]!.code).toBe(
        "BLOB_UPLOAD_UNKNOWN",
      );
    });

    it("cancels uploads and rejects sessions from another image", async () => {
      const auth = basic(bob);
      const start = await h.request("/v2/images/app/blobs/uploads/", {
        method: "POST",
        headers: { authorization: auth },
      });
      const uuid = start.headers.get("docker-upload-uuid")!;
      const elsewhere = await h.request(`/v2/images/other/blobs/uploads/${uuid}`, {
        headers: { authorization: auth },
      });
      expect(elsewhere.status).toBe(404);
      const cancel = await h.request(start.headers.get("location")!, {
        method: "DELETE",
        headers: { authorization: auth },
      });
      expect(cancel.status).toBe(204);
      expect(
        (await h.request(start.headers.get("location")!, { headers: { authorization: auth } }))
          .status,
      ).toBe(404);
    });
  });

  describe("manifests", () => {
    it("rejects manifests whose blobs are missing or not linked", async () => {
      const auth = basic(bob);
      const config = await pushBlob(h, auth, "images/app", "{}x");
      const foreign = await pushBlob(h, adminAuth, "secret/x", "private layer");
      const res = await putManifest(h, auth, "images/app", "v1", {
        schemaVersion: 2,
        mediaType: OCI_MANIFEST,
        config: { mediaType: "application/vnd.oci.image.config.v1+json", ...config },
        layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar", ...foreign }],
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { errors: { code: string; detail: unknown }[] };
      expect(body.errors[0]).toMatchObject({
        code: "MANIFEST_BLOB_UNKNOWN",
        detail: { digest: foreign.digest },
      });
    });

    it("rejects schema 1, invalid JSON and digest mismatches", async () => {
      const auth = basic(bob);
      const schema1 = await putManifest(
        h,
        auth,
        "images/app",
        "old",
        { schemaVersion: 1, name: "x", tag: "old", fsLayers: [] },
        "application/vnd.docker.distribution.manifest.v1+prettyjws",
      );
      expect(((await schema1.json()) as { errors: { code: string }[] }).errors[0]!.code).toBe(
        "MANIFEST_INVALID",
      );
      const byDigest = await putManifest(
        h,
        auth,
        "images/app",
        sha("x"),
        { schemaVersion: 2, mediaType: OCI_INDEX, manifests: [] },
        OCI_INDEX,
      );
      expect(((await byDigest.json()) as { errors: { code: string }[] }).errors[0]!.code).toBe(
        "DIGEST_INVALID",
      );
    });

    it("stores indexes whose children exist", async () => {
      const auth = basic(bob);
      const amd = await pushImage(h, auth, "images/multi", "amd64", "amd layer");
      const arm = await pushImage(h, auth, "images/multi", "arm64", "arm layer");
      const child = (m: { digest: string; body: string }, arch: string) => ({
        mediaType: OCI_MANIFEST,
        digest: m.digest,
        size: m.body.length,
        platform: { os: "linux", architecture: arch },
      });
      const missing = await putManifest(
        h,
        auth,
        "images/multi",
        "latest",
        {
          schemaVersion: 2,
          mediaType: OCI_INDEX,
          manifests: [child(amd, "amd64"), { ...child(arm, "arm64"), digest: sha("nope") }],
        },
        OCI_INDEX,
      );
      expect(((await missing.json()) as { errors: { code: string }[] }).errors[0]!.code).toBe(
        "MANIFEST_BLOB_UNKNOWN",
      );

      const index = {
        schemaVersion: 2,
        mediaType: OCI_INDEX,
        manifests: [child(amd, "amd64"), child(arm, "arm64")],
      };
      const ok = await putManifest(h, auth, "images/multi", "latest", index, OCI_INDEX);
      expect(ok.status).toBe(201);
      const get = await h.request("/v2/images/multi/manifests/latest", {
        headers: { authorization: auth, accept: `${OCI_INDEX}, ${OCI_MANIFEST}` },
      });
      expect(get.headers.get("content-type")).toBe(OCI_INDEX);
      expect(get.headers.get("docker-content-digest")).toBe(sha(JSON.stringify(index)));
      // Layers of child manifests are readable through the image name.
      const layer = await h.request(`/v2/images/multi/blobs/${arm.layer.digest}`, {
        headers: { authorization: auth },
      });
      expect(await layer.text()).toBe("arm layer");
    });

    it("accepts Docker v2 manifests and the implicit empty config", async () => {
      const auth = basic(bob);
      const layer = await pushBlob(h, auth, "images/art", "artifact payload");
      const res = await putManifest(h, auth, "images/art", "v1", {
        schemaVersion: 2,
        mediaType: OCI_MANIFEST,
        artifactType: "application/vnd.example.thing",
        config: {
          mediaType: "application/vnd.oci.empty.v1+json",
          digest: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
          size: 2,
        },
        layers: [{ mediaType: "application/octet-stream", ...layer }],
      });
      expect(res.status, await res.clone().text()).toBe(201);

      const config = await pushBlob(h, auth, "images/docker", '{"os":"linux"}');
      const docker = await putManifest(
        h,
        auth,
        "images/docker",
        "latest",
        {
          schemaVersion: 2,
          mediaType: "application/vnd.docker.distribution.manifest.v2+json",
          config: { mediaType: "application/vnd.docker.container.image.v1+json", ...config },
          layers: [{ mediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip", ...layer }],
        },
        "application/vnd.docker.distribution.manifest.v2+json",
      );
      // The layer was only pushed to images/art, so it is unknown here.
      expect(docker.status).toBe(400);
    });

    it("lists tags with pagination", async () => {
      const auth = basic(bob);
      for (const tag of ["b", "a", "c"]) await pushImage(h, auth, "images/app", tag, "same layer");
      const first = await h.request("/v2/images/app/tags/list?n=2", {
        headers: { authorization: auth },
      });
      expect(await first.json()).toEqual({ name: "images/app", tags: ["a", "b"] });
      expect(first.headers.get("link")).toBe('</v2/images/app/tags/list?n=2&last=b>; rel="next"');
      const second = await h.request("/v2/images/app/tags/list?n=2&last=b", {
        headers: { authorization: auth },
      });
      expect(await second.json()).toEqual({ name: "images/app", tags: ["c"] });
      expect(second.headers.get("link")).toBeNull();
      const unknown = await h.request("/v2/images/none/tags/list", {
        headers: { authorization: auth },
      });
      expect(unknown.status).toBe(404);
      expect(((await unknown.json()) as { errors: { code: string }[] }).errors[0]!.code).toBe(
        "NAME_UNKNOWN",
      );
    });

    it("serves referrers with artifactType filtering", async () => {
      const auth = basic(bob);
      const subject = await pushImage(h, auth, "images/app", "v1", "base layer");
      const sigLayer = await pushBlob(h, auth, "images/app", "signature");
      const sig = {
        schemaVersion: 2,
        mediaType: OCI_MANIFEST,
        artifactType: "application/vnd.dev.cosign.artifact.sig.v1+json",
        config: {
          mediaType: "application/vnd.oci.empty.v1+json",
          digest: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
          size: 2,
        },
        layers: [{ mediaType: "application/vnd.dev.cosign.simplesigning.v1+json", ...sigLayer }],
        subject: { mediaType: OCI_MANIFEST, digest: subject.digest, size: subject.body.length },
        annotations: { "org.example.signed": "yes" },
      };
      const put = await putManifest(h, auth, "images/app", sha(JSON.stringify(sig)), sig);
      expect(put.status).toBe(201);
      expect(put.headers.get("oci-subject")).toBe(subject.digest);

      const res = await h.request(`/v2/images/app/referrers/${subject.digest}`, {
        headers: { authorization: auth },
      });
      expect(res.headers.get("content-type")).toBe(OCI_INDEX);
      const index = (await res.json()) as { manifests: Record<string, unknown>[] };
      expect(index.manifests).toEqual([
        {
          mediaType: OCI_MANIFEST,
          digest: sha(JSON.stringify(sig)),
          size: JSON.stringify(sig).length,
          artifactType: sig.artifactType,
          annotations: sig.annotations,
        },
      ]);
      const filtered = await h.request(
        `/v2/images/app/referrers/${subject.digest}?artifactType=application/other`,
        { headers: { authorization: auth } },
      );
      expect(filtered.headers.get("oci-filters-applied")).toBe("artifactType");
      expect(((await filtered.json()) as { manifests: unknown[] }).manifests).toEqual([]);
    });

    it("deletes tags and manifests with delete permission", async () => {
      const auth = basic(bob);
      const image = await pushImage(h, auth, "images/app", "v1", "layer");
      const denied = await h.request("/v2/images/app/manifests/v1", {
        method: "DELETE",
        headers: { authorization: auth },
      });
      expect(denied.status).toBe(403);

      const delTag = await h.request("/v2/images/app/manifests/v1", {
        method: "DELETE",
        headers: { authorization: adminAuth },
      });
      expect(delTag.status).toBe(202);
      expect(
        (await h.request("/v2/images/app/manifests/v1", { headers: { authorization: auth } }))
          .status,
      ).toBe(404);
      expect(
        (
          await h.request(`/v2/images/app/manifests/${image.digest}`, {
            headers: { authorization: auth },
          })
        ).status,
      ).toBe(200);

      const delDigest = await h.request(`/v2/images/app/manifests/${image.digest}`, {
        method: "DELETE",
        headers: { authorization: adminAuth },
      });
      expect(delDigest.status).toBe(202);
      const gone = await h.request(`/v2/images/app/manifests/${image.digest}`, {
        headers: { authorization: auth },
      });
      expect(gone.status).toBe(404);
      expect(((await gone.json()) as { errors: { code: string }[] }).errors[0]!.code).toBe(
        "MANIFEST_UNKNOWN",
      );

      const delBlob = await h.request(`/v2/images/app/blobs/${image.layer.digest}`, {
        method: "DELETE",
        headers: { authorization: adminAuth },
      });
      expect(delBlob.status).toBe(202);
    });

    it("refuses to move tags in immutable repositories", async () => {
      await h.request("/api/v1/repositories/images", {
        method: "PATCH",
        headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
        body: JSON.stringify({ config: { immutable: true } }),
      });
      const auth = basic(bob);
      await pushImage(h, auth, "images/app", "v1", "one");
      const config = await pushBlob(h, auth, "images/app", "cfg");
      const res = await putManifest(h, auth, "images/app", "v1", {
        schemaVersion: 2,
        mediaType: OCI_MANIFEST,
        config: { mediaType: "application/vnd.oci.image.config.v1+json", ...config },
        layers: [],
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { errors: { code: string }[] }).errors[0]!.code).toBe("DENIED");
    });

    it("prunes untagged manifests when retention asks for it", async () => {
      await h.request("/api/v1/repositories/images", {
        method: "PATCH",
        headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
        body: JSON.stringify({ config: { retention: { deleteUntagged: true } } }),
      });
      const auth = basic(bob);
      const first = await pushImage(h, auth, "images/app", "latest", "one");
      await pushImage(h, auth, "images/app", "latest", "two");
      const old = await h.request(`/v2/images/app/manifests/${first.digest}`, {
        headers: { authorization: auth },
      });
      expect(old.status).toBe(404);
    });
  });

  describe("cross-repository mounts", () => {
    it("mounts blobs the caller can read", async () => {
      await grant("pub", "user:bob", "write");
      const base = await pushBlob(h, basic(bob), "pub/base", "shared base layer");
      const auth = await bearer(h, bob, [
        "repository:images/app:pull,push",
        "repository:pub/base:pull",
      ]);
      const res = await h.request(
        `/v2/images/app/blobs/uploads/?mount=${base.digest}&from=pub/base`,
        { method: "POST", headers: { authorization: auth } },
      );
      expect(res.status).toBe(201);
      expect(res.headers.get("location")).toBe(`/v2/images/app/blobs/${base.digest}`);
      const get = await h.request(`/v2/images/app/blobs/${base.digest}`, {
        headers: { authorization: auth },
      });
      expect(await get.text()).toBe("shared base layer");
    });

    it("never mounts blobs from repositories the caller cannot read", async () => {
      const secret = await pushBlob(h, adminAuth, "secret/base", "private layer");
      for (const auth of [
        basic(bob),
        await bearer(h, bob, ["repository:images/app:pull,push", "repository:secret/base:pull"]),
      ]) {
        const res = await h.request(
          `/v2/images/app/blobs/uploads/?mount=${secret.digest}&from=secret/base`,
          { method: "POST", headers: { authorization: auth } },
        );
        expect(res.status).toBe(202);
        expect(res.headers.get("docker-upload-uuid")).toBeTruthy();
        const get = await h.request(`/v2/images/app/blobs/${secret.digest}`, {
          headers: { authorization: auth },
        });
        expect(get.status).toBe(404);
      }
      // Readable repository, but the blob was never pushed to that image.
      const other = await h.request(
        `/v2/images/app/blobs/uploads/?mount=${secret.digest}&from=images/other`,
        { method: "POST", headers: { authorization: basic(bob) } },
      );
      expect(other.status).toBe(202);
    });
  });

  describe("catalog", () => {
    it("lists the images each caller can read", async () => {
      await pushImage(h, adminAuth, "pub/tool", "v1", "a");
      await pushImage(h, adminAuth, "images/app", "v1", "b");
      await pushImage(h, adminAuth, "secret/x", "v1", "c");

      const anon = await h.request("/v2/_catalog");
      expect(await anon.json()).toEqual({ repositories: ["pub/tool"] });

      const bobs = await h.request("/v2/_catalog", { headers: { authorization: basic(bob) } });
      expect(await bobs.json()).toEqual({ repositories: ["images/app", "pub/tool"] });

      const adminToken = await bearer(h, admin, ["registry:catalog:*"]);
      const page = await h.request("/v2/_catalog?n=2", { headers: { authorization: adminToken } });
      expect(await page.json()).toEqual({ repositories: ["images/app", "pub/tool"] });
      expect(page.headers.get("link")).toBe('</v2/_catalog?n=2&last=pub%2Ftool>; rel="next"');
    });
  });
});
