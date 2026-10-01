import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it } from "vite-plus/test";

import type { ReleaseAssetDto, ReleaseDto, ReleaseProjectDto } from "./types.ts";
import { makeHarness, type Harness } from "../../testing/harness.ts";

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");

describe("releases", () => {
  let h: Harness;
  let writer: string;
  let reader: string;
  let admin: string;

  const api = (path: string, token: string | null, init: RequestInit = {}) =>
    h.request(`/api/v1/releases/${path}`, {
      ...init,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.body && typeof init.body === "string"
          ? { "content-type": "application/json" }
          : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });

  const create = (tag: string, extra: Record<string, unknown> = {}, token = writer) =>
    api("rel/tool/releases", token, {
      method: "POST",
      body: JSON.stringify({ tag, title: `Tool ${tag}`, notes: "## Changes\n- stuff", ...extra }),
    });

  const uploadAsset = (tag: string, name: string, body: string, headers = {}, query = "") =>
    api(`rel/tool/releases/${tag}/assets/${name}${query}`, writer, {
      method: "PUT",
      headers,
      body,
    });

  beforeEach(async () => {
    h = await makeHarness();
    admin = await h.adminToken();
    await h.createRepo({ key: "rel", format: "releases", kind: "local", visibility: "private" });
    writer = h.token("bob");
    reader = h.token("carol");
    for (const [principal, role] of [
      ["user:bob", "write"],
      ["user:carol", "read"],
    ]) {
      await h.request("/api/v1/repositories/rel/permissions", {
        method: "PUT",
        headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
        body: JSON.stringify({ principal, role }),
      });
    }
  });

  it("creates releases, uploads assets and serves downloads", async () => {
    const res = await create("v1.0.0");
    expect(res.status).toBe(201);
    const release = (await res.json()) as ReleaseDto;
    expect(release).toMatchObject({
      repo: "rel",
      project: "tool",
      tag: "v1.0.0",
      title: "Tool v1.0.0",
      draft: false,
      latest: true,
    });
    expect(release.publishedAt).not.toBeNull();
    expect((await create("v1.0.0")).status).toBe(409);
    expect((await create("latest")).status).toBe(400);

    const up = await uploadAsset(
      "v1.0.0",
      "tool-linux.tar.gz",
      "linux-bytes",
      {
        "x-checksum-sha256": sha256("linux-bytes"),
      },
      "?label=Linux",
    );
    expect(up.status).toBe(201);
    const asset = (await up.json()) as ReleaseAssetDto;
    expect(asset).toMatchObject({
      name: "tool-linux.tar.gz",
      label: "Linux",
      size: 11,
      sha256: sha256("linux-bytes"),
      browserDownloadUrl: "https://pkg.test/releases/rel/tool/v1.0.0/download/tool-linux.tar.gz",
    });
    const bad = await uploadAsset("v1.0.0", "other.zip", "x", {
      "x-checksum-sha256": "0".repeat(64),
    });
    expect(bad.status).toBe(400);
    await uploadAsset("v1.0.0", "tool-mac.zip", "mac-bytes");

    const dl = await h.request("/releases/rel/tool/v1.0.0/download/tool-linux.tar.gz", {
      headers: { authorization: `Bearer ${reader}` },
    });
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe("linux-bytes");
    expect(dl.headers.get("content-disposition")).toContain(
      'attachment; filename="tool-linux.tar.gz"',
    );

    const sums = await h.request("/releases/rel/tool/v1.0.0/SHA256SUMS", {
      headers: { authorization: `Bearer ${reader}` },
    });
    expect(await sums.text()).toBe(
      `${sha256("linux-bytes")}  tool-linux.tar.gz\n${sha256("mac-bytes")}  tool-mac.zip\n`,
    );

    const got = (await (await api("rel/tool/releases/tags/v1.0.0", reader)).json()) as ReleaseDto;
    expect(got.assets.map((a) => [a.name, a.downloads])).toEqual([
      ["tool-linux.tar.gz", 1],
      ["tool-mac.zip", 0],
    ]);
  });

  it("refuses to replace assets without delete permission", async () => {
    await create("v1.0.0");
    expect((await uploadAsset("v1.0.0", "a.bin", "one")).status).toBe(201);
    expect((await uploadAsset("v1.0.0", "a.bin", "one")).status).toBe(200);
    expect((await uploadAsset("v1.0.0", "a.bin", "two")).status).toBe(409);
    expect((await uploadAsset("v1.0.0", "a.bin", "two", {}, "?overwrite=1")).status).toBe(403);
    const replaced = await api("rel/tool/releases/v1.0.0/assets/a.bin?overwrite=1", admin, {
      method: "PUT",
      body: "two",
    });
    expect(replaced.status).toBe(200);
    expect(
      await (
        await h.request("/releases/rel/tool/v1.0.0/download/a.bin", {
          headers: { authorization: `Bearer ${admin}` },
        })
      ).text(),
    ).toBe("two");
    expect((await uploadAsset("v1.0.0", "a%5Cb", "x")).status).toBe(400);
    expect((await uploadAsset("v1.0.0", "a%2Fb", "x")).status).toBe(400);
  });

  it("resolves latest, skipping drafts and prereleases", async () => {
    await create("v1.0.0");
    await uploadAsset("v1.0.0", "tool.bin", "one");
    await create("v1.1.0-rc.1", { prerelease: true });
    await uploadAsset("v1.1.0-rc.1", "tool.bin", "rc");
    await create("v2.0.0", { draft: true });
    await uploadAsset("v2.0.0", "tool.bin", "two");

    const latest = (await (await api("rel/tool/releases/latest", reader)).json()) as ReleaseDto;
    expect(latest.tag).toBe("v1.0.0");
    const dl = await h.request("/releases/rel/tool/latest/download/tool.bin", {
      headers: { authorization: `Bearer ${reader}` },
    });
    expect(await dl.text()).toBe("one");

    // Publishing the draft makes it latest.
    const published = await api("rel/tool/releases/v2.0.0", writer, {
      method: "PATCH",
      body: JSON.stringify({ draft: false, notes: "Final" }),
    });
    const body = (await published.json()) as ReleaseDto;
    expect(body.draft).toBe(false);
    expect(body.publishedAt).not.toBeNull();
    expect(body.latest).toBe(true);
    const next = await h.request("/releases/rel/tool/latest/download/tool.bin", {
      headers: { authorization: `Bearer ${reader}` },
    });
    expect(await next.text()).toBe("two");
  });

  it("hides drafts from readers and challenges anonymous callers", async () => {
    await create("v1.0.0");
    await create("v2.0.0", { draft: true });
    await uploadAsset("v2.0.0", "tool.bin", "draft");

    const asReader = (await (await api("rel/tool/releases", reader)).json()) as ReleaseDto[];
    expect(asReader.map((r) => r.tag)).toEqual(["v1.0.0"]);
    const asWriter = await api("rel/tool/releases", writer);
    expect(((await asWriter.json()) as ReleaseDto[]).map((r) => r.tag)).toEqual([
      "v2.0.0",
      "v1.0.0",
    ]);
    expect(asWriter.headers.get("x-total-count")).toBe("2");
    expect((await api("rel/tool/releases/tags/v2.0.0", reader)).status).toBe(404);
    expect(
      (
        await h.request("/releases/rel/tool/v2.0.0/download/tool.bin", {
          headers: { authorization: `Bearer ${reader}` },
        })
      ).status,
    ).toBe(404);

    const projects = (await (await api("rel/projects", reader)).json()) as ReleaseProjectDto[];
    expect(projects).toMatchObject([{ name: "tool", releaseCount: 1, latest: { tag: "v1.0.0" } }]);

    const anon = await h.request("/releases/rel/tool/v1.0.0/SHA256SUMS");
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toContain("Basic");
    expect((await api("rel/projects", null)).status).toBe(401);

    expect((await create("v3.0.0", {}, reader)).status).toBe(403);
    expect((await api("rel/tool/releases/v1.0.0", writer, { method: "DELETE" })).status).toBe(403);
    expect((await api("rel/tool/releases/v1.0.0", admin, { method: "DELETE" })).status).toBe(204);
    expect((await api("rel/tool/releases/tags/v1.0.0", admin)).status).toBe(404);
  });

  it("supports one-shot curl uploads", async () => {
    const put = await h.request("/releases/rel/cli/v0.1.0/cli-linux-amd64", {
      method: "PUT",
      headers: { authorization: `Bearer ${writer}` },
      body: "binary",
    });
    expect(put.status).toBe(201);
    await h.request("/releases/rel/cli/v0.1.0/cli-darwin-arm64", {
      method: "PUT",
      headers: { authorization: `Bearer ${writer}` },
      body: "binary2",
    });
    const release = (await (await api("rel/cli/releases/latest", reader)).json()) as ReleaseDto;
    expect(release.tag).toBe("v0.1.0");
    expect(release.draft).toBe(false);
    expect(release.assets.map((a) => a.name)).toEqual(["cli-darwin-arm64", "cli-linux-amd64"]);

    expect(
      (
        await h.request("/releases/rel/Bad_Project/v1/x", {
          method: "PUT",
          headers: { authorization: `Bearer ${writer}` },
          body: "x",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.request("/releases/rel/cli/v0.2.0/x", {
          method: "PUT",
          headers: { authorization: `Bearer ${reader}` },
          body: "x",
        })
      ).status,
    ).toBe(403);
  });

  it("deletes assets with delete permission and audits mutations", async () => {
    await create("v1.0.0");
    await uploadAsset("v1.0.0", "a.bin", "a");
    expect(
      (await api("rel/tool/releases/v1.0.0/assets/a.bin", writer, { method: "DELETE" })).status,
    ).toBe(403);
    expect(
      (await api("rel/tool/releases/v1.0.0/assets/a.bin", admin, { method: "DELETE" })).status,
    ).toBe(204);
    expect(
      (await api("rel/tool/releases/v1.0.0/assets/a.bin", admin, { method: "DELETE" })).status,
    ).toBe(404);
    const audit = (await (
      await h.request("/api/v1/audit?repo=rel", { headers: { authorization: `Bearer ${admin}` } })
    ).json()) as { action: string }[];
    expect(
      audit
        .map((a) => a.action)
        .filter((a) => a.startsWith("releases."))
        .sort(),
    ).toEqual(["releases.asset.delete", "releases.asset.upload", "releases.create"].sort());
  });

  it("serves public repositories anonymously", async () => {
    await h.createRepo({ key: "pub", format: "releases", kind: "local", visibility: "public" });
    await h.request("/releases/pub/app/v1.0.0/app.tgz", {
      method: "PUT",
      headers: { authorization: `Bearer ${admin}` },
      body: "app",
    });
    const dl = await h.request("/releases/pub/app/latest/download/app.tgz");
    expect(await dl.text()).toBe("app");
  });
});
