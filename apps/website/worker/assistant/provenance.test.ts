import { describe, expect, test } from "vite-plus/test";
import { authorizeReceipts, contentProbe, contentReceipt } from "./provenance.ts";
import type { CallApi } from "./internal.ts";

const repository = {
  id: "repo-original",
  space: { id: "space-original" },
  source: { sourceId: "source-original" },
};

describe("Assistant durable content provenance", () => {
  test("source reads bind immutable repository, Space and source identities", async () => {
    const probe = contentProbe(
      "GET",
      "/repos/general/project/blob?path=a.ts&source=source-original",
    )!;
    expect(probe).toEqual({
      kind: "repository",
      path: "/repos/general/project?authorization=1&metadata=1&source=source-original",
    });
    const api: CallApi = async () => ({ ok: true, status: 200, body: repository });
    const receipt = await contentReceipt(api, probe);
    await authorizeReceipts(api, JSON.parse(JSON.stringify([receipt])));
    for (const body of [
      { ...repository, id: "different-repo" },
      { ...repository, space: { id: "sibling-space" } },
      { ...repository, source: { sourceId: "canonical" } },
    ]) {
      await expect(
        authorizeReceipts(async () => ({ ok: true, status: 200, body }), [receipt]),
      ).rejects.toThrow("current source access");
    }
  });

  test("private and absent sources both refuse warm and serialized receipts after revocation", async () => {
    const receipt = await contentReceipt(
      async () => ({ ok: true, status: 200, body: repository }),
      {
        kind: "repository",
        path: "/repos/general/project?source=source-original",
      },
    );
    for (const status of [401, 403, 404]) {
      const revoked: CallApi = async () => ({ ok: false, status, body: { error: "unavailable" } });
      await expect(authorizeReceipts(revoked, [receipt])).rejects.toThrow("current source access");
      await expect(
        authorizeReceipts(revoked, JSON.parse(JSON.stringify([receipt]))),
      ).rejects.toThrow("current source access");
    }
  });

  test("tracker receipts cannot change Space or migration epoch", async () => {
    const snapshot = { contractVersion: 4, spaceId: "space-1", migrationEpoch: 7 };
    const receipt = await contentReceipt(async () => ({ ok: true, status: 200, body: snapshot }), {
      kind: "tracker",
      path: "/tracker/general/snapshot",
    });
    for (const body of [
      { ...snapshot, migrationEpoch: 8 },
      { ...snapshot, spaceId: "space-2" },
      { ...snapshot, contractVersion: 3 },
    ]) {
      await expect(
        authorizeReceipts(async () => ({ ok: true, status: 200, body }), [receipt]),
      ).rejects.toThrow("current source access");
    }
  });

  test("filtered aggregates cannot reuse removed private inputs", async () => {
    const probe = contentProbe(
      "GET",
      "/repos/general/project/knowledge/completion-evidence?q=ENG-1",
    )!;
    expect(probe.kind).toBe("response");
    const receipt = await contentReceipt(
      async () => ({ ok: true, status: 200, body: { notes: [{ id: "private-proof" }] } }),
      probe,
    );
    await expect(
      authorizeReceipts(async () => ({ ok: true, status: 200, body: { notes: [] } }), [receipt]),
    ).rejects.toThrow("current source access");
  });
});

test("repository read access cannot reuse former administrator-only tool data", async () => {
  const probe = contentProbe("GET", "/repos/general/project/ci/secrets")!;
  expect(probe.permissionPath).toBe("/repos/general/project/ci/secrets");
  const receipt = await contentReceipt(
    async (_method, path) => ({
      ok: true,
      status: 200,
      body: path === probe.permissionPath ? { names: ["PRIVATE_KEY"] } : repository,
    }),
    probe,
  );
  await expect(
    authorizeReceipts(
      async (_method, path) =>
        path === probe.permissionPath
          ? { ok: false, status: 403, body: { error: "Forbidden" } }
          : { ok: true, status: 200, body: repository },
      [receipt],
    ),
  ).rejects.toThrow("current source access");
});
