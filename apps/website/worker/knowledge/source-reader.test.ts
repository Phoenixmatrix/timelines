import { afterEach, expect, test, vi } from "vite-plus/test";
import { createFreshSpaceTestEnvironment } from "../testing/spaces.ts";
import { saveSnapshot } from "./graph.ts";
import { withOverlayReader } from "./source-reader.ts";

vi.mock("cloudflare:workers", () => import("../testing/runtime.ts"));
const fixtures: { close(): void }[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const fixture of fixtures.splice(0)) fixture.close();
});

test("a composed work wiki reads only canonical blobs rooted in its pinned base", async () => {
  const fixture = await createFreshSpaceTestEnvironment();
  fixtures.push(fixture);
  const { sqlite } = fixture;
  const prefix = crypto.randomUUID();
  sqlite.exec(`
    BEGIN;
    INSERT INTO organizations (id,slug,display_name,kind,default_space_id) VALUES ('org','org','Org','company','owner');
    INSERT INTO spaces (id,organization_id,slug,display_name) VALUES ('owner','org','owner','Space');
    COMMIT;
    INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote)
      VALUES ('repo','owner','app','private','${prefix}-main','https://main');
    INSERT INTO timeline_work_sources
      (source_id,repo_id,timeline_id,timeline_slug,space_id,artifacts_name,artifacts_remote,state,
       allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,initial_token_revoked,created_at,updated_at,
       initial_source_id,initial_commit,initial_tree,initial_ref)
      VALUES ('work_one','repo','timeline','topic','owner','${prefix}-work','https://work','ready',
        'allocate','canonical','base','base-tree','refs/heads/main',1,'now','now',
        'canonical','base','base-tree','refs/heads/main');
  `);
  const reads: string[] = [];
  const closed: string[] = [];
  const content: Record<string, Record<string, string>> = {
    [`${prefix}-main`]: { allowed: "pinned canonical", forbidden: "new canonical secret" },
    [`${prefix}-work`]: { changed: "work change" },
  };
  const env = {
    ...fixture.env,
    ARTIFACTS: {
      get: async (name: string) => ({
        readBlob: async (oid: string) => {
          reads.push(`${name}:${oid}`);
          const value = content[name]?.[oid];
          return value === undefined ? null : new Blob([value]);
        },
        [Symbol.dispose]: () => closed.push(name),
      }),
    },
  } as unknown as Env;
  vi.stubGlobal("caches", { default: { match: async () => undefined, put: async () => {} } });
  await saveSnapshot(env.DB, "repo", "pinned", [
    { path: "base.ts", blob: "allowed", mode: "100644" },
  ]);
  await withOverlayReader(
    env,
    "repo",
    "work_one",
    "pinned",
    () => {},
    async (reader) => {
      expect(new TextDecoder().decode((await reader.blob("changed"))!.bytes)).toBe("work change");
      expect(new TextDecoder().decode((await reader.blob("allowed"))!.bytes)).toBe(
        "pinned canonical",
      );
      expect(await reader.blob("forbidden")).toBeNull();
    },
  );
  expect(reads).not.toContain(`${prefix}-main:forbidden`);
  expect(closed.sort()).toEqual([`${prefix}-main`, `${prefix}-work`]);
  const readsBeforeRevocation = reads.length;
  sqlite.exec("UPDATE timeline_work_sources SET state='archived' WHERE source_id='work_one'");
  await expect(
    withOverlayReader(
      env,
      "repo",
      "work_one",
      "pinned",
      () => {},
      async (reader) => reader.blob("allowed"),
    ),
  ).rejects.toThrow("Timeline source is read-only or unavailable");
  expect(reads).toHaveLength(readsBeforeRevocation);
  sqlite.exec("UPDATE timeline_work_sources SET state='ready' WHERE source_id='work_one'");
  sqlite.exec("UPDATE repos SET deleted_at='deleted' WHERE id='repo'");
  await expect(
    withOverlayReader(
      env,
      "repo",
      "work_one",
      "pinned",
      () => {},
      async (reader) => reader.blob("allowed"),
    ),
  ).rejects.toThrow("Repository not found");
});
