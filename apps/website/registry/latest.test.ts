// Only a repository's default branch moves `latest`. CI jobs building other
// branches still publish their versions, with the branch in the history, but
// those never become `latest` in any format: not by dist-tag or tag, and not as
// the newest publish. People publishing by hand move it as before.

import { createHash } from "node:crypto";

import { gzipSync, strToU8, writeTar, zipSync } from "@gitmatrix/formats/archive";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import type { PackageDetail } from "../shared/packages.ts";
import { createDb } from "./core/db.ts";
import type { ReleaseDto } from "./formats/releases/types.ts";
import { bearer, pushImage } from "./formats/oci/testing.ts";
import { publishBody } from "./formats/npm/testing.ts";
import { basic, makeHarness, type Harness } from "./testing/harness.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("latest follows the default branch", () => {
  let h: Harness;
  let admin: string;
  const db = () => createDb(h.env.REGISTRY_DB);

  const main = async () => (await h.jobToken({ repo: "web", ref: "main" })).token;
  const branch = async () => (await h.jobToken({ repo: "web", ref: "agent/experiment" })).token;

  beforeEach(async () => {
    h = await makeHarness();
    h.grant("dana", "admin");
    admin = h.token("dana");
  });

  describe("npm", () => {
    const publish = (token: string, version: string, tag?: string) =>
      h.request("/npm/test/@test%2fui", {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: publishBody("@test/ui", version, tag ? { tag } : {}),
      });
    const distTags = async () =>
      (
        (await (
          await h.request("/npm/test/@test%2fui", { headers: { authorization: `Bearer ${admin}` } })
        ).json()) as { "dist-tags": Record<string, string> }
      )["dist-tags"];

    it("keeps branch versions and their other tags, never latest", async () => {
      expect((await publish(await main(), "1.0.0")).status).toBe(201);
      expect(await distTags()).toEqual({ latest: "1.0.0" });

      // npm sends `latest` by default; from a branch it is dropped, the version kept.
      expect((await publish(await branch(), "1.1.0")).status).toBe(201);
      expect((await publish(await branch(), "1.2.0-exp.1", "exp")).status).toBe(201);
      expect(await distTags()).toEqual({ latest: "1.0.0", exp: "1.2.0-exp.1" });
      const rows = await db()
        .selectFrom("publishes")
        .select(["version", "ref", "off_default_branch"])
        .orderBy("at")
        .orderBy("id")
        .execute();
      expect(rows).toEqual([
        { version: "1.0.0", ref: "main", off_default_branch: 0 },
        { version: "1.1.0", ref: "agent/experiment", off_default_branch: 1 },
        { version: "1.2.0-exp.1", ref: "agent/experiment", off_default_branch: 1 },
      ]);

      // Nor can a branch build point latest at it afterwards.
      const moved = await h.request("/npm/test/-/package/@test%2fui/dist-tags/latest", {
        method: "PUT",
        headers: { authorization: `Bearer ${await branch()}`, "content-type": "application/json" },
        body: JSON.stringify("1.1.0"),
      });
      expect(moved.status).toBe(403);
      expect(await moved.text()).toContain("default branch");
      expect((await distTags()).latest).toBe("1.0.0");

      // The default branch moves it as before.
      expect((await publish(await main(), "1.3.0")).status).toBe(201);
      expect((await distTags()).latest).toBe("1.3.0");

      // Unpublishing latest falls back to the highest default-branch version.
      const doc = (await (
        await h.request("/npm/test/@test%2fui?write=true", {
          headers: { authorization: `Bearer ${admin}` },
        })
      ).json()) as { _rev: string; versions: Record<string, unknown> };
      delete doc.versions["1.3.0"];
      const unpublished = await h.request(`/npm/test/@test%2fui/-rev/${doc._rev}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
        body: JSON.stringify(doc),
      });
      expect(unpublished.status).toBe(200);
      expect((await distTags()).latest).toBe("1.0.0");

      // A person publishing by hand moves it too.
      expect((await publish(admin, "2.0.0")).status).toBe(201);
      expect((await distTags()).latest).toBe("2.0.0");
    });

    it("leaves a package only branches published without latest", async () => {
      expect((await publish(await branch(), "0.1.0")).status).toBe(201);
      expect(await distTags()).toEqual({});
      expect((await publish(await main(), "0.0.9")).status).toBe(201);
      expect(await distTags()).toEqual({ latest: "0.0.9" });
    });
  });

  it("generic: the newest publish from the default branch is latest", async () => {
    const deploy = (token: string, version: string) =>
      h.request(`/generic/test/web/${version}/web.tgz`, {
        method: "PUT",
        headers: { authorization: basic(token) },
        body: version,
      });
    const latest = async () => {
      const res = await h.request("/api/packages/test/generic/web", {
        headers: { authorization: `Bearer ${admin}` },
      });
      return ((await res.json()) as PackageDetail).package.latest;
    };

    // Only a branch has published: there is no latest.
    expect((await deploy(await branch(), "0.9.0")).status).toBe(201);
    expect(await latest()).toBeNull();
    await tick();
    expect((await deploy(await main(), "1.0.0")).status).toBe(201);
    await tick();
    expect((await deploy(await branch(), "1.1.0")).status).toBe(201);
    expect(await latest()).toBe("1.0.0");
    // `gm pkg download web/latest/…` resolves through the same field.
    await tick();
    expect((await deploy(await main(), "1.2.0")).status).toBe(201);
    expect(await latest()).toBe("1.2.0");
    await tick();
    expect((await deploy(admin, "1.3.0")).status).toBe(201);
    expect(await latest()).toBe("1.3.0");
  });

  it("oci: a branch push of :latest stores the image but leaves the tag", async () => {
    const push = async (token: string, tag: string, layer: string) =>
      pushImage(
        h,
        await bearer(h, token, ["repository:test/web:pull,push"]),
        "test/web",
        tag,
        layer,
      );
    const tagged = async (tag: string) =>
      (
        await h.request(`/v2/test/web/manifests/${tag}`, {
          headers: { authorization: await bearer(h, admin, ["repository:test/web:pull"]) },
        })
      ).headers.get("docker-content-digest");

    const mainImage = await push(await main(), "latest", "main layer");
    expect(await tagged("latest")).toBe(mainImage.digest);

    const exp = await push(await branch(), "latest", "experiment layer");
    expect(await tagged("latest")).toBe(mainImage.digest);
    // Still pullable by digest, and by any other tag the branch pushes.
    expect(await tagged(exp.digest)).toBe(exp.digest);
    await push(await branch(), "sha-exp", "experiment layer");
    expect(await tagged("sha-exp")).toBe(exp.digest);

    const next = await push(await main(), "latest", "next main layer");
    expect(await tagged("latest")).toBe(next.digest);
  });

  it("releases: a branch's release is never the latest one", async () => {
    const create = (token: string, tag: string) =>
      h.request("/api/v1/releases/test/tool/releases", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ tag }),
      });
    const latest = async () => {
      const res = await h.request("/api/v1/releases/test/tool/releases/latest", {
        headers: { authorization: `Bearer ${admin}` },
      });
      return res.status === 200 ? ((await res.json()) as ReleaseDto).tag : res.status;
    };

    expect((await create(await branch(), "v0.9.0")).status).toBe(201);
    expect(await latest()).toBe(404);
    await tick();
    expect((await create(await main(), "v1.0.0")).status).toBe(201);
    await tick();
    expect((await create(await branch(), "v1.1.0")).status).toBe(201);
    expect(await latest()).toBe("v1.0.0");
    await tick();
    expect((await create(await main(), "v1.2.0")).status).toBe(201);
    expect(await latest()).toBe("v1.2.0");
  });

  it("go: @latest skips versions published from a branch", async () => {
    const put = (token: string, version: string) =>
      h.request(`/go/test/acme.dev/tools/@v/${version}.zip`, {
        method: "PUT",
        headers: { authorization: basic(token) },
        body: zipSync({
          [`acme.dev/tools@${version}/go.mod`]: strToU8("module acme.dev/tools\n"),
        }),
      });
    const latest = async () =>
      (
        (await (
          await h.request("/go/test/acme.dev/tools/@latest", {
            headers: { authorization: basic(admin) },
          })
        ).json()) as { Version: string }
      ).Version;

    expect((await put(await main(), "v1.0.0")).status).toBe(201);
    expect((await put(await branch(), "v1.1.0")).status).toBe(201);
    expect(await latest()).toBe("v1.0.0");
    expect((await put(await main(), "v1.2.0")).status).toBe(201);
    expect(await latest()).toBe("v1.2.0");
  });

  it("helm: the latest chart skips versions published from a branch", async () => {
    const chart = (version: string) =>
      gzipSync(
        writeTar([
          {
            name: "svc/Chart.yaml",
            data: `apiVersion: v2\nname: svc\nversion: ${version}\ndescription: svc\n`,
          },
        ]),
      );
    const upload = (token: string, version: string) =>
      h.request("/helm/test/api/charts", {
        method: "POST",
        headers: { authorization: basic(token) },
        body: chart(version),
      });
    const latest = async () =>
      (
        (await (
          await h.request("/helm/test/api/charts/svc/latest", {
            headers: { authorization: basic(admin) },
          })
        ).json()) as { version: string }
      ).version;

    expect((await upload(await main(), "1.0.0")).status).toBe(201);
    expect((await upload(await branch(), "1.1.0")).status).toBe(201);
    expect(await latest()).toBe("1.0.0");
    expect((await upload(await main(), "1.2.0")).status).toBe(201);
    expect(await latest()).toBe("1.2.0");
  });

  it("maven: metadata lists branch versions but never as latest or release", async () => {
    const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");
    const deploy = async (token: string, version: string) => {
      const path = `/maven/test/com/acme/lib/${version}/lib-${version}.jar`;
      const jar = `jar ${version}`;
      for (const [suffix, body] of [
        ["", jar],
        [".sha1", sha1(jar)],
      ] as const) {
        const res = await h.request(`${path}${suffix}`, {
          method: "PUT",
          headers: { authorization: basic(token) },
          body,
        });
        expect(res.status).toBe(201);
      }
    };
    const metadata = async () =>
      (
        await h.request("/maven/test/com/acme/lib/maven-metadata.xml", {
          headers: { authorization: basic(admin) },
        })
      ).text();

    await deploy(await main(), "1.0");
    await deploy(await branch(), "1.1");
    let xml = await metadata();
    expect(xml).toMatch(/<version>1.0<\/version>\s*<version>1.1<\/version>/);
    expect(xml).toContain("<latest>1.0</latest>");
    expect(xml).toContain("<release>1.0</release>");
    await deploy(await main(), "1.2");
    xml = await metadata();
    expect(xml).toContain("<latest>1.2</latest>");
    expect(xml).toContain("<release>1.2</release>");
  });
});
