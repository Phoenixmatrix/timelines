import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { gzipSync, strToU8, writeTar, zipSync } from "@gitmatrix/formats/archive";
import { encodePublishBody } from "@gitmatrix/formats/cargo";
import type { FormatId } from "@gitmatrix/formats/info";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { PackageContents, PackageContentEntry } from "../../shared/packageContents.ts";
import { SYSTEM_ACTOR } from "../core/auth/system.ts";
import { Services } from "../core/context.ts";
import { createDb } from "../core/db.ts";
import { publishBody } from "../formats/npm/testing.ts";
import {
  bearer,
  OCI_INDEX,
  OCI_MANIFEST,
  pushImage,
  putManifest,
  sha,
} from "../formats/oci/testing.ts";
import { uploadBody, wheel } from "../formats/pypi/testing.ts";
import { basic, makeHarness, type Harness } from "../testing/harness.ts";
import { collectGarbage, GC_GRACE_MS } from "../jobs/gc.ts";

const digest = (body: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(body).digest("hex")}`;
const base = (format: FormatId, name: string) =>
  `/api/packages/test/${format}/${encodeURIComponent(name)}`;

function formula(version: string) {
  return `class Tool < Formula\n  desc "Contents test tool"\n  homepage "https://example.com/tool"\n  url "https://example.com/tool-${version}.tar.gz"\n  sha256 "${"a".repeat(64)}"\n  def install\n    bin.install "tool"\n  end\nend\n`;
}

describe("package version contents API", () => {
  let h: Harness;
  let admin: string;
  let reader: string;
  let outsider: string;

  beforeEach(async () => {
    h = await makeHarness();
    h.grant("dana", "admin");
    h.grant("carol", "read");
    admin = h.token("dana");
    reader = h.token("carol", ["packages:read"]);
    outsider = h.token("eve");
  });

  const headers = (token = admin) => ({ authorization: `Bearer ${token}` });
  const send = (path: string, body: BodyInit, method = "PUT", extra: Record<string, string> = {}) =>
    h.request(path, { method, headers: { ...headers(), ...extra }, body });
  const feed = async (format: FormatId, visibility = "private") => {
    const response = await h.createRepo({ key: "test", format, kind: "local", visibility });
    expect(response.status, await response.clone().text()).toBe(201);
  };
  const url = (
    format: FormatId,
    name: string,
    version: string,
    query: Record<string, string> = {},
  ) => `${base(format, name)}/contents?${new URLSearchParams({ version, ...query }).toString()}`;
  const contents = async (
    format: FormatId,
    name: string,
    version: string,
    query: Record<string, string> = {},
  ) => {
    const response = await h.request(url(format, name, version, query), {
      headers: headers(reader),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    return (await response.json()) as PackageContents;
  };
  const downloaded = async (entry: PackageContentEntry, expected: string | Uint8Array) => {
    expect(entry.downloadUrl).toBeTruthy();
    const target = new URL(entry.downloadUrl!, "https://pkg.test");
    expect(target.origin).toBe("https://pkg.test");
    const response = await h.request(target.pathname + target.search, { headers: headers(reader) });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toEqual(typeof expected === "string" ? strToU8(expected) : expected);
    expect(entry.size).toBe(bytes.length);
    expect(entry.digest).toBe(digest(bytes));
    expect((await h.request(target.pathname + target.search)).status).toBe(401);
    expect(
      (await h.request(target.pathname + target.search, { headers: headers(outsider) })).status,
    ).toBe(404);
  };
  const publishNpm = async (tgz: Uint8Array, version = "1.0.0") => {
    const response = await send(
      "/npm/test/@test%2Fui",
      publishBody("@test/ui", version, { tgz }),
      "PUT",
      { "content-type": "application/json" },
    );
    expect(response.status, await response.clone().text()).toBe(201);
  };

  it("paginates generic files, downloads their exact bytes and keeps version/package boundaries", async () => {
    await feed("generic");
    for (const [name, body] of [
      ["a.txt", "one"],
      ["b.txt", "two"],
      ["c.txt", "three"],
    ]) {
      expect((await send(`/generic/test/tool/1.0/${name}`, body!)).status).toBe(201);
    }
    expect((await send("/generic/test/tool/2.0/new.txt", "new-version")).status).toBe(201);
    expect((await send("/generic/test/other/1.0/private.txt", "other-package")).status).toBe(201);
    const first = await contents("generic", "tool", "1.0", { limit: "2" });
    expect(first.total).toBe(3);
    expect(first.files.map((file) => file.name)).toEqual(["a.txt", "b.txt"]);
    const last = await contents("generic", "tool", "1.0", { limit: "2", offset: "2" });
    expect(last.files.map((file) => file.name)).toEqual(["c.txt"]);
    await downloaded(last.files[0]!, "three");
    expect((await contents("generic", "tool", "1.0", { offset: "3" })).files).toEqual([]);
    const target = new URL(first.files[0]!.downloadUrl!, "https://pkg.test");
    target.searchParams.set("version", "2.0");
    expect(
      (await h.request(target.pathname + target.search, { headers: headers(reader) })).status,
    ).toBe(404);
    target.searchParams.set("version", "1.0");
    target.pathname = target.pathname.replace("/tool/", "/other/");
    expect(
      (await h.request(target.pathname + target.search, { headers: headers(reader) })).status,
    ).toBe(404);
    expect((await h.request(url("generic", "tool", "1.0"))).status).toBe(401);
    expect(
      (await h.request(url("generic", "tool", "1.0"), { headers: headers(outsider) })).status,
    ).toBe(404);
  });

  it("allows public contents and public downloads without a token", async () => {
    await feed("generic", "public");
    expect((await send("/generic/test/public/1/readme.txt", "public bytes")).status).toBe(201);
    const response = await h.request(url("generic", "public", "1"));
    expect(response.status).toBe(200);
    const page = (await response.json()) as PackageContents;
    const download = await h.request(page.files[0]!.downloadUrl!);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("public bytes");
  });

  it("shows release assets and hides drafts from read-only viewers", async () => {
    await feed("releases");
    const create = (tag: string, draft: boolean) =>
      send(
        "/api/v1/releases/test/tool/releases",
        JSON.stringify({ tag, title: "Tool", notes: "Release notes", draft }),
        "POST",
        { "content-type": "application/json" },
      );
    expect((await create("v1", false)).status).toBe(201);
    expect(
      (await send("/api/v1/releases/test/tool/releases/v1/assets/tool.bin", "release bytes"))
        .status,
    ).toBe(201);
    const page = await contents("releases", "tool", "v1");
    expect(page.files.map((file) => file.name)).toEqual(["tool.bin"]);
    await downloaded(page.files[0]!, "release bytes");
    expect((await create("v2", true)).status).toBe(201);
    expect(
      (await send("/api/v1/releases/test/tool/releases/v2/assets/tool.bin", "draft bytes")).status,
    ).toBe(201);
    expect(
      (await h.request(url("releases", "tool", "v2"), { headers: headers(reader) })).status,
    ).toBe(404);
    const draft = await h.request(url("releases", "tool", "v2"), { headers: headers() });
    expect(draft.status).toBe(200);
    const draftPage = (await draft.json()) as PackageContents;
    expect(
      (await h.request(draftPage.files[0]!.downloadUrl!, { headers: headers(reader) })).status,
    ).toBe(404);
  });

  it("indexes npm once, returns the archive manifest, pages directories and downloads cached members", async () => {
    await feed("npm");
    const manifest = { name: "@test/ui", version: "1.0.0", exports: "./src/a.ts" };
    await publishNpm(
      gzipSync(
        writeTar([
          { name: "package/package.json", data: JSON.stringify(manifest) },
          { name: "package/src/a.ts", data: "export const a = 1;\n" },
          { name: "package/src/b.ts", data: "export const b = 2;\n" },
          { name: "package/src/c.ts", data: "export const c = 3;\n" },
          { name: "package/README.md", data: "# UI\n" },
        ]),
      ),
    );
    const db = createDb(h.env.REGISTRY_DB);
    const source = await db
      .selectFrom("files as f")
      .innerJoin("blobs as b", "f.digest", "b.digest")
      .select("b.r2_key")
      .where("f.path", "like", "%.tgz")
      .executeTakeFirstOrThrow();
    const reads = vi.spyOn(h.bucket, "get");
    const [root, simultaneous] = await Promise.all([
      contents("npm", "@test/ui", "1.0.0"),
      contents("npm", "@test/ui", "1.0.0"),
    ]);
    expect(root.manifest).toEqual(manifest);
    expect(simultaneous.manifest).toEqual(manifest);
    expect(reads.mock.calls.filter(([key]) => key === source.r2_key)).toHaveLength(1);
    reads.mockRestore();
    const packageDirectory = root.files.find(
      (file) => file.kind === "directory" && file.name === "package",
    )!;
    const packagePage = await contents("npm", "@test/ui", "1.0.0", { path: packageDirectory.path });
    const directory = packagePage.files.find(
      (file) => file.kind === "directory" && file.name === "src",
    )!;
    expect(directory).toMatchObject({ kind: "directory", downloadUrl: null });
    await h.bucket.delete(source.r2_key);
    const page = await contents("npm", "@test/ui", "1.0.0", { path: directory.path, limit: "2" });
    expect(page.total).toBe(3);
    expect(page.files.map((file) => file.name)).toEqual(["a.ts", "b.ts"]);
    const last = await contents("npm", "@test/ui", "1.0.0", {
      path: directory.path,
      limit: "2",
      offset: "2",
    });
    expect(last.files.map((file) => file.name)).toEqual(["c.ts"]);
    await downloaded(last.files[0]!, "export const c = 3;\n");
    const member = new URL(last.files[0]!.downloadUrl!, "https://pkg.test");
    member.searchParams.set("version", "9.0.0");
    expect(
      (await h.request(member.pathname + member.search, { headers: headers(reader) })).status,
    ).toBe(404);
  });

  it.each(["blob", "repository"] as const)(
    "reclaims npm cache bytes after %s deletion and the GC grace period",
    async (target) => {
      await feed("npm");
      await publishNpm(
        gzipSync(
          writeTar([
            {
              name: "package/package.json",
              data: JSON.stringify({ name: "@test/ui", version: "1.0.0" }),
            },
            { name: "package/index.js", data: "export const ready = true;\n" },
          ]),
        ),
      );
      await contents("npm", "@test/ui", "1.0.0");
      const db = createDb(h.env.REGISTRY_DB);
      const cache = await db.selectFrom("archive_caches").selectAll().executeTakeFirstOrThrow();
      const services = new Services(
        h.env,
        new Request("https://pkg.test/"),
        () => undefined,
        "test",
        SYSTEM_ACTOR,
      );
      if (target === "blob") {
        await db.deleteFrom("files").where("digest", "=", cache.digest).execute();
        await db
          .updateTable("blobs")
          .set({ created_at: "2020-01-01T00:00:00.000Z" })
          .where("digest", "=", cache.digest)
          .execute();
      } else {
        await db.deleteFrom("repositories").where("id", "=", cache.repo_id).execute();
      }
      await collectGarbage(services);
      expect(
        await db
          .selectFrom("archive_caches")
          .select("id")
          .where("id", "=", cache.id)
          .executeTakeFirst(),
      ).toBeUndefined();
      expect(
        await db
          .selectFrom("archive_members")
          .select("path")
          .where("cache_id", "=", cache.id)
          .execute(),
      ).toEqual([]);
      expect(h.bucket.bytes(cache.r2_key)).toBeDefined();
      await collectGarbage(services, Date.now() + 2 * GC_GRACE_MS);
      expect(h.bucket.bytes(cache.r2_key)).toBeUndefined();
    },
  );

  it("shows OCI platforms, config and layers but cannot traverse another version's manifest", async () => {
    await feed("oci");
    const auth = await bearer(h, admin, ["repository:test/app:pull,push"]);
    const linux = await pushImage(h, auth, "test/app", "linux", "linux-layer");
    const other = await pushImage(h, auth, "test/app", "other", "unrelated-layer");
    const index = {
      schemaVersion: 2,
      mediaType: OCI_INDEX,
      manifests: [
        {
          mediaType: OCI_MANIFEST,
          digest: linux.digest,
          size: strToU8(linux.body).length,
          platform: { os: "linux", architecture: "amd64" },
        },
      ],
    };
    expect((await putManifest(h, auth, "test/app", "multi", index, OCI_INDEX)).status).toBe(201);
    const root = await contents("oci", "app", sha(JSON.stringify(index)));
    expect(root.manifest).toEqual(index);
    const platform = root.files.find((file) => file.manifestDigest === linux.digest)!;
    expect(platform.platform).toContain("linux");
    expect(platform.platform).toContain("amd64");
    await downloaded(platform, linux.body);
    const child = await contents("oci", "app", root.version, { manifest: linux.digest });
    expect(child.manifest).toEqual(JSON.parse(linux.body));
    expect(child.config).toMatchObject({ architecture: "amd64", layer: "linux-layer" });
    await downloaded(
      child.files.find((file) => file.kind === "layer")!,
      "linux-layer",
    );
    await downloaded(
      child.files.find((file) => file.kind === "config")!,
      JSON.stringify({ architecture: "amd64", layer: "linux-layer" }),
    );
    const denied = await h.request(url("oci", "app", root.version, { manifest: other.digest }), {
      headers: headers(reader),
    });
    expect(denied.status).toBe(404);
    const forged = new URL(platform.downloadUrl!, "https://pkg.test");
    for (const [key, value] of forged.searchParams) {
      if (value.includes(linux.digest))
        forged.searchParams.set(key, value.replace(linux.digest, other.digest));
    }
    expect(
      (await h.request(forged.pathname + forged.search, { headers: headers(reader) })).status,
    ).toBe(404);
  });

  const distributionFormats = [
    "pypi",
    "cargo",
    "maven",
    "helm",
    "go",
    "apt",
    "rpm",
    "brew",
  ] as const;
  it.each(distributionFormats)(
    "lists %s distributions with recorded metadata and authorized downloads",
    async (format) => {
      await feed(format);
      let name = "tool";
      let version = "1.0.0";
      let content: string | Uint8Array;
      let filename: string;
      let response: Response;
      let expectedMetadata: Record<string, unknown> | null = null;
      switch (format) {
        case "pypi": {
          content = wheel(name, version);
          filename = "tool-1.0.0-py3-none-any.whl";
          const upload = uploadBody({ name, version, filename, data: content });
          response = await send("/pypi/test/", upload.body, "POST", {
            "content-type": upload.contentType,
            authorization: basic(admin),
          });
          expectedMetadata = { name, version, requiresPython: ">=3.8" };
          break;
        }
        case "cargo": {
          content = gzipSync(
            writeTar([
              { name: "tool-1.0.0/Cargo.toml", data: '[package]\nname="tool"\nversion="1.0.0"\n' },
            ]),
          );
          filename = "tool-1.0.0.crate";
          response = await send(
            "/cargo/test/api/v1/crates/new",
            encodePublishBody(
              {
                name,
                vers: version,
                deps: [],
                features: {},
                authors: [],
                description: "Contents tool",
                license: "MIT",
              },
              content,
            ),
            "PUT",
            { authorization: admin },
          );
          break;
        }
        case "maven": {
          name = "com.acme:tool";
          content = "jar bytes";
          filename = "tool-1.0.0.jar";
          response = await send(`/maven/test/com/acme/tool/1.0.0/${filename}`, content, "PUT", {
            authorization: basic(admin),
          });
          break;
        }
        case "helm": {
          content = gzipSync(
            writeTar([
              {
                name: "tool/Chart.yaml",
                data: "apiVersion: v2\nname: tool\nversion: 1.0.0\nappVersion: 9.0.0\n",
              },
            ]),
          );
          filename = "tool-1.0.0.tgz";
          response = await send("/helm/test/api/charts", content, "POST", {
            authorization: basic(admin),
          });
          expectedMetadata = { chart: { name, version, appVersion: "9.0.0" } };
          break;
        }
        case "go": {
          name = "acme.dev/tool";
          version = "v1.0.0";
          content = zipSync({
            [`${name}@${version}/go.mod`]: strToU8("module acme.dev/tool\n\ngo 1.22\n"),
            [`${name}@${version}/tool.go`]: strToU8("package tool\n"),
          });
          filename = `${version}.zip`;
          response = await send(`/go/test/${name}/@v/${filename}`, content, "PUT", {
            authorization: basic(admin),
          });
          break;
        }
        case "apt": {
          name = "arttest";
          version = "1.0-1_amd64";
          filename = "arttest_1.0-1_amd64.deb";
          content = new Uint8Array(
            readFileSync(
              fileURLToPath(
                new URL(
                  "../../../../packages/formats/src/apt/fixtures/arttest_1.0-1_amd64-gzip.deb",
                  import.meta.url,
                ).href,
              ),
            ),
          );
          response = await send(
            `/apt/test/pool/main/a/arttest/${filename};deb.distribution=stable;deb.component=main`,
            content,
            "PUT",
            { authorization: basic(admin) },
          );
          expectedMetadata = { package: name, version: "1.0-1", architecture: "amd64" };
          break;
        }
        case "rpm": {
          name = "which";
          version = "0:2.23-4.fc44.x86_64";
          filename = "which-2.23-4.fc44.x86_64.rpm";
          content = new Uint8Array(
            readFileSync(
              fileURLToPath(
                new URL(
                  "../../../../packages/formats/src/rpm/fixtures/which-2.23-4.fc44.x86_64.rpm",
                  import.meta.url,
                ).href,
              ),
            ),
          );
          response = await send(`/rpm/test/Packages/w/${filename}`, content, "PUT", {
            authorization: basic(admin),
          });
          expectedMetadata = { name, arch: "x86_64", version: "2.23", release: "4.fc44" };
          break;
        }
        case "brew": {
          content = formula(version);
          filename = "tool.rb";
          response = await send("/api/v1/brew/test/Formula/tool.rb", content);
          expectedMetadata = { path: "Formula/tool.rb", desc: "Contents test tool" };
          break;
        }
      }
      expect(response.ok, await response.clone().text()).toBe(true);
      const page = await contents(format, name, version);
      expect(page.format).toBe(format);
      expect(page.version).toBe(version);
      const file = page.files.find((entry) => entry.name === filename)!;
      expect(file, `${format} distribution file`).toBeDefined();
      await downloaded(file, content);
      if (expectedMetadata) expect(page.metadata.version).toMatchObject(expectedMetadata);
      if (format === "cargo")
        expect(page.metadata.version).toMatchObject({
          index: { name, vers: version },
          license: "MIT",
        });
      if (format === "maven")
        expect(page.metadata.package).toMatchObject({ groupId: "com.acme", artifactId: "tool" });
      if (format === "go") {
        const mod = page.files.find((entry) => entry.name === "v1.0.0.mod")!;
        await downloaded(mod, "module acme.dev/tool\n\ngo 1.22\n");
      }
    },
  );

  it("keeps old Homebrew formula contents pinned after a newer formula replaces the current path", async () => {
    await feed("brew");
    expect((await send("/api/v1/brew/test/Formula/tool.rb", formula("1.0.0"))).status).toBe(201);
    expect((await send("/api/v1/brew/test/Formula/tool.rb", formula("2.0.0"))).status).toBe(201);
    const old = await contents("brew", "tool", "1.0.0");
    await downloaded(old.files[0]!, formula("1.0.0"));
    const current = await contents("brew", "tool", "2.0.0");
    await downloaded(current.files[0]!, formula("2.0.0"));
  });
});
