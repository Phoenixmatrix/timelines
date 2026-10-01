import { beforeEach, describe, expect, it } from "vite-plus/test";

import { basic, makeHarness, type Harness } from "../../testing/harness.ts";

describe("generic repositories", () => {
  let h: Harness;
  let writer: string;

  beforeEach(async () => {
    h = await makeHarness();
    expect(
      (
        await h.createRepo({
          key: "files",
          format: "generic",
          kind: "local",
          visibility: "private",
        })
      ).status,
    ).toBe(201);
    writer = h.token("bob");
    await h.request("/api/v1/repositories/files/permissions", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${await h.adminToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ principal: "user:bob", role: "write" }),
    });
  });

  it("deploys and downloads with checksums", async () => {
    const put = await h.request("/generic/files/tools/v1/app.tar.gz", {
      method: "PUT",
      headers: { authorization: basic(writer) },
      body: "payload",
    });
    expect(put.status).toBe(201);
    const body = (await put.json()) as { checksums: { sha256: string } };

    const get = await h.request("/generic/files/tools/v1/app.tar.gz", {
      headers: { authorization: basic(writer) },
    });
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("payload");
    expect(get.headers.get("content-disposition")).toContain("app.tar.gz");

    const sidecar = await h.request("/generic/files/tools/v1/app.tar.gz.sha256", {
      headers: { authorization: `Bearer ${writer}` },
    });
    expect(await sidecar.text()).toBe(body.checksums.sha256);
  });

  it("challenges anonymous readers of private repositories", async () => {
    const res = await h.request("/generic/files/anything");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
  });

  it("refuses readers without write access", async () => {
    const reader = h.token("carol");
    const res = await h.request("/generic/files/a.txt", {
      method: "PUT",
      headers: { authorization: `Bearer ${reader}` },
      body: "x",
    });
    expect(res.status).toBe(403);
  });

  it("rejects a bad Artifactory checksum header", async () => {
    const res = await h.request("/generic/files/a.txt", {
      method: "PUT",
      headers: { authorization: `Bearer ${writer}`, "x-checksum-sha256": "0".repeat(64) },
      body: "x",
    });
    expect(res.status).toBe(400);
  });

  it("does not overwrite without delete permission", async () => {
    const put = (body: string) =>
      h.request("/generic/files/a.txt", {
        method: "PUT",
        headers: { authorization: `Bearer ${writer}` },
        body,
      });
    expect((await put("one")).status).toBe(201);
    expect((await put("two")).status).toBe(409);
  });

  it("lists directories as JSON and HTML", async () => {
    await h.request("/generic/files/dir/a.txt", {
      method: "PUT",
      headers: { authorization: `Bearer ${writer}` },
      body: "a",
    });
    await h.request("/generic/files/dir/sub/b.txt", {
      method: "PUT",
      headers: { authorization: `Bearer ${writer}` },
      body: "b",
    });
    const json = await h.request("/generic/files/dir/?format=json", {
      headers: { authorization: `Bearer ${writer}` },
    });
    const list = (await json.json()) as { children: { name: string; folder: boolean }[] };
    expect(list.children.map((c) => `${c.name}${c.folder ? "/" : ""}`)).toEqual(["sub/", "a.txt"]);
    const html = await h.request("/generic/files/dir/", {
      headers: { authorization: `Bearer ${writer}` },
    });
    expect(await html.text()).toContain('href="a.txt"');
  });

  it("serves public repositories anonymously", async () => {
    await h.createRepo({ key: "pub", format: "generic", kind: "local", visibility: "public" });
    const admin = await h.adminToken();
    await h.request("/generic/pub/x.bin", {
      method: "PUT",
      headers: { authorization: `Bearer ${admin}` },
      body: "x",
    });
    expect((await h.request("/generic/pub/x.bin")).status).toBe(200);
  });

  it("rejects path traversal", async () => {
    const res = await h.request("/generic/files/a%2f..%2f..%2fetc", {
      method: "PUT",
      headers: { authorization: `Bearer ${writer}` },
      body: "x",
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid tokens instead of treating them as anonymous", async () => {
    const res = await h.request("/generic/files/x", {
      headers: { authorization: "Bearer tm_pat_bogus" },
    });
    expect(res.status).toBe(401);
  });
});
