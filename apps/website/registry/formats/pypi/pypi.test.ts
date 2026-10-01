import { beforeEach, describe, expect, it } from "vite-plus/test";

import { basic, makeHarness, type Harness } from "../../testing/harness.ts";
import { metadataText, sha256, uploadBody, wheel, type UploadInput } from "./testing.ts";

const JSON_ACCEPT =
  "application/vnd.pypi.simple.v1+json, application/vnd.pypi.simple.v1+html; q=0.1, text/html; q=0.01";

describe("pypi local repositories", () => {
  let h: Harness;
  let writer: string;

  const upload = (input: UploadInput, token = writer, path = "/pypi/py/") => {
    const { body, contentType } = uploadBody(input);
    return h.request(path, {
      method: "POST",
      headers: { authorization: basic(token, "__token__"), "content-type": contentType },
      body,
    });
  };
  const get = (path: string, headers: Record<string, string> = {}) =>
    h.request(path, { headers: { authorization: basic(writer, "__token__"), ...headers } });

  beforeEach(async () => {
    h = await makeHarness();
    expect(
      (await h.createRepo({ key: "py", format: "pypi", kind: "local", visibility: "private" }))
        .status,
    ).toBe(201);
    writer = h.token("bob", ["packages:read", "packages:write", "packages:delete"]);
    await h.request("/api/v1/repositories/py/permissions", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${await h.adminToken()}`,
        "content-type": "application/json",
      },
      // Deleting published versions takes an owner admin in gitmatrix.
      body: JSON.stringify({ principal: "user:bob", role: "admin" }),
    });
  });

  it("uploads a wheel and serves it through the simple API", async () => {
    const data = wheel("Demo_Pkg", "1.0.0");
    const res = await upload({
      name: "Demo_Pkg",
      version: "1.0.0",
      filename: "demo_pkg-1.0.0-py3-none-any.whl",
      data,
    });
    expect(res.status).toBe(200);

    const html = await get("/pypi/py/simple/demo-pkg/");
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html.headers.get("vary")).toBe("Accept");
    const text = await html.text();
    const fileUrl =
      "https://pkg.test/pypi/py/packages/demo-pkg/1.0.0/demo_pkg-1.0.0-py3-none-any.whl";
    expect(text).toContain(`href="${fileUrl}#sha256=${sha256(data)}"`);
    expect(text).toContain('data-requires-python="&#62;=3.8"');
    const metadataSha = sha256(metadataText("Demo_Pkg", "1.0.0"));
    expect(text).toContain(`data-core-metadata="sha256=${metadataSha}"`);
    expect(text).toContain(`data-dist-info-metadata="sha256=${metadataSha}"`);

    const json = await get("/pypi/py/simple/demo-pkg", { accept: JSON_ACCEPT });
    expect(json.headers.get("content-type")).toBe("application/vnd.pypi.simple.v1+json");
    const doc = (await json.json()) as {
      meta: Record<string, string>;
      name: string;
      versions: string[];
      files: Record<string, unknown>[];
    };
    expect(doc.meta["api-version"]).toBe("1.1");
    expect(doc.name).toBe("demo-pkg");
    expect(doc.versions).toEqual(["1.0.0"]);
    expect(doc.files[0]).toMatchObject({
      filename: "demo_pkg-1.0.0-py3-none-any.whl",
      url: fileUrl,
      hashes: { sha256: sha256(data) },
      "requires-python": ">=3.8",
      "core-metadata": { sha256: metadataSha },
      yanked: false,
      size: data.length,
    });
    expect(doc.files[0]!["upload-time"]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);

    const file = await get(new URL(fileUrl).pathname);
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(data);

    const meta = await get(`${new URL(fileUrl).pathname}.metadata`);
    expect(meta.status).toBe(200);
    expect(await meta.text()).toBe(metadataText("Demo_Pkg", "1.0.0"));

    const html1 = await get("/pypi/py/simple/", { accept: "text/html" });
    expect(await html1.text()).toContain('<a href="demo-pkg/">Demo_Pkg</a>');
    const index = await get("/pypi/py/simple/", { accept: JSON_ACCEPT });
    expect(await index.json()).toMatchObject({ projects: [{ name: "Demo_Pkg" }] });
  });

  it("accepts metadata fields after the file part (sdist)", async () => {
    const data = new TextEncoder().encode("fake sdist bytes");
    const res = await upload({
      name: "demo",
      version: "2.0",
      filename: "demo-2.0.tar.gz",
      data,
      contentFirst: true,
    });
    expect(res.status).toBe(200);
    const text = await (await get("/pypi/py/simple/demo/")).text();
    expect(text).toContain(`demo-2.0.tar.gz#sha256=${sha256(data)}`);
    expect(text).not.toContain("data-core-metadata");
  });

  it("rejects a different file under an existing name but accepts identical re-uploads", async () => {
    const input = {
      name: "demo",
      version: "1.0",
      filename: "demo-1.0.tar.gz",
      data: new TextEncoder().encode("one"),
    };
    expect((await upload(input)).status).toBe(200);
    expect((await upload(input)).status).toBe(200);
    const again = await upload({ ...input, data: new TextEncoder().encode("two") });
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("File already exists");
    const late = await upload({
      ...input,
      data: new TextEncoder().encode("two"),
      contentFirst: true,
    });
    expect(late.status).toBe(400);
    expect(await late.text()).toContain("File already exists");
  });

  it("rejects digest mismatches, bad names and mismatched filenames", async () => {
    const data = new TextEncoder().encode("bytes");
    const bad = await upload({
      name: "demo",
      version: "1.0",
      filename: "demo-1.0.tar.gz",
      data,
      sha256: "0".repeat(64),
    });
    expect(bad.status).toBe(400);
    const lateBad = await upload({
      name: "demo",
      version: "1.0",
      filename: "demo-1.0.tar.gz",
      data,
      sha256: "0".repeat(64),
      contentFirst: true,
    });
    expect(lateBad.status).toBe(400);
    expect(await lateBad.text()).toContain("sha256_digest");
    expect(
      (await upload({ name: "demo", version: "not-a-version", filename: "demo-1.0.tar.gz", data }))
        .status,
    ).toBe(400);
    expect(
      (await upload({ name: "demo", version: "1.1", filename: "demo-1.0.tar.gz", data })).status,
    ).toBe(400);
    expect(
      (await upload({ name: "other", version: "1.0", filename: "demo-1.0.tar.gz", data })).status,
    ).toBe(400);
    expect(
      (await upload({ name: "demo", version: "1.0", filename: "..demo-1.0.tar.gz", data })).status,
    ).toBe(400);
    // METADATA inside the wheel must agree with the form.
    const mismatched = wheel("demo", "1.0", metadataText("demo", "9.9"));
    expect(
      (
        await upload({
          name: "demo",
          version: "1.0",
          filename: "demo-1.0-py3-none-any.whl",
          data: mismatched,
        })
      ).status,
    ).toBe(400);
    expect((await get("/pypi/py/simple/demo/")).status).toBe(404);
  });

  it("redirects non-normalized project names", async () => {
    await upload({
      name: "Demo.Pkg",
      version: "1.0",
      filename: "demo_pkg-1.0.tar.gz",
      data: new TextEncoder().encode("x"),
    });
    const res = await get("/pypi/py/simple/Demo.Pkg/");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/pypi/py/simple/demo-pkg/");
    expect((await get("/pypi/py/simple/demo-pkg")).status).toBe(200);
    expect((await get("/pypi/py/simple/missing/")).status).toBe(404);
  });

  it("challenges anonymous clients and honors __token__ basic auth", async () => {
    const res = await h.request("/pypi/py/simple/demo/");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('Basic realm="gitmatrix"');
    const upload401 = await h.request("/pypi/py/", {
      method: "POST",
      ...(() => {
        const { body, contentType } = uploadBody({
          name: "demo",
          version: "1.0",
          filename: "demo-1.0.tar.gz",
          data: new Uint8Array([1]),
        });
        return { body, headers: { "content-type": contentType } };
      })(),
    });
    expect(upload401.status).toBe(401);
    const reader = h.token("carol");
    expect(
      (
        await upload(
          { name: "demo", version: "1.0", filename: "demo-1.0.tar.gz", data: new Uint8Array([1]) },
          reader,
        )
      ).status,
    ).toBe(403);
  });

  it("uploads through /legacy/ too", async () => {
    const res = await upload(
      { name: "demo", version: "1.0", filename: "demo-1.0.tar.gz", data: new Uint8Array([1]) },
      writer,
      "/pypi/py/legacy/",
    );
    expect(res.status).toBe(200);
  });

  it("yanks, unyanks and deletes releases through the API", async () => {
    await upload({
      name: "demo",
      version: "1.0",
      filename: "demo-1.0.tar.gz",
      data: new Uint8Array([1]),
    });
    await upload({
      name: "demo",
      version: "1.1",
      filename: "demo-1.1.tar.gz",
      data: new Uint8Array([2]),
    });
    const yank = await h.request("/api/v1/pypi/py/demo/1.0/yank", {
      method: "POST",
      headers: { authorization: `Bearer ${writer}`, "content-type": "application/json" },
      body: JSON.stringify({ reason: "broken <build>" }),
    });
    expect(yank.status).toBe(200);
    const html = await (await get("/pypi/py/simple/demo/")).text();
    expect(html).toContain('data-yanked="broken &#60;build&#62;"');
    const doc = (await (await get("/pypi/py/simple/demo/", { accept: JSON_ACCEPT })).json()) as {
      files: { filename: string; yanked: unknown }[];
    };
    expect(doc.files.map((f) => f.yanked)).toEqual(["broken <build>", false]);

    await h.request("/api/v1/pypi/py/demo/1.0/unyank", {
      method: "POST",
      headers: { authorization: `Bearer ${writer}` },
    });
    expect(await (await get("/pypi/py/simple/demo/")).text()).not.toContain("data-yanked");

    const del = await h.request("/api/v1/pypi/py/demo/1.0", {
      method: "DELETE",
      headers: { authorization: `Bearer ${writer}` },
    });
    expect(del.status).toBe(204);
    const after = await (await get("/pypi/py/simple/demo/")).text();
    expect(after).not.toContain("demo-1.0.tar.gz");
    expect(after).toContain("demo-1.1.tar.gz");

    const audit = await h.request("/api/v1/audit?repo=py", {
      headers: { authorization: `Bearer ${await h.adminToken()}` },
    });
    const actions = (await audit.json()) as { items?: { action: string }[] } | { action: string }[];
    const list = Array.isArray(actions) ? actions : (actions.items ?? []);
    expect(list.map((e) => e.action)).toEqual(
      expect.arrayContaining(["pypi.publish", "pypi.yank", "pypi.unyank", "pypi.delete"]),
    );
  });
});
