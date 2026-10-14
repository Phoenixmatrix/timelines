// Creating a timeline's work source through transient Artifacts failures (CORE-302).

import { beforeEach, describe, expect, onTestFinished, test, vi } from "vite-plus/test";
import type { RepoRow } from "../db.ts";
import { isTransientArtifactsError } from "../artifacts.ts";
import { TrackerError } from "../tracker/store.ts";
import { ensureWorkSource, SOURCE_RETRY_DELAYS_MS, type WorkSourceInput } from "./sources.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { issueToken } from "../api/tokens.ts";
import { accessFor } from "../tracker/access.ts";
import { findSpaceById } from "../spaces/access.ts";
import { captureWorkAuthority } from "../ci/admission.ts";
import type { Access } from "../tracker/store.ts";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    public ctx: DurableObjectState;
    public env: Env;
    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const rpc = vi.hoisted(() => ({ initializeWorkSource: vi.fn() }));
vi.mock("../tracker/stub.ts", () => ({ trackerObject: () => rpc }));

const repo = { id: "repo", space_id: "space" } as RepoRow;
let env: Env;
let access: Access;
let input: WorkSourceInput;
const initialized = { ok: true, value: { source: { sourceId: "work_1" } } };
const internal = Object.assign(new Error("An internal error occurred."), {
  name: "ArtifactsError",
  code: "INTERNAL_ERROR",
});
const dropped = new Error(
  "Peer closed WebSocket: 1006 WebSocket disconnected without sending Close frame.",
);
// What the fork's own retry sees through the Tracker RPC: a message, no code (CORE-315).
const forking = new Error(
  'ArtifactsError: Repository "w-da0f379bf5db4b8d88e87718d34a0a87" is currently being forked from "artifacts:ns/r-b26f220bed22454f916e". The fork is still in progress and the repository is not yet available. Retry after 5 seconds.',
);

// A function beforeEach returns is its teardown: don't return the mock.
beforeEach(async () => {
  rpc.initializeWorkSource.mockReset();
  const fresh = await createFreshSpaceTestEnvironment();
  onTestFinished(fresh.close);
  env = fresh.env;
  fresh.sqlite.exec(
    "INSERT INTO accounts(id,kind,slug,display_name) VALUES('person','user','person','Person')",
  );
  await seedSpaceFixture(env.DB, {
    organization: { id: "org", slug: "org", displayName: "Organization", kind: "company" },
    space: { id: "space", slug: "space", displayName: "Space" },
    members: [
      {
        accountId: "person",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
    actorId: "person",
  });
  fresh.sqlite.exec(
    "INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote) VALUES('repo','space','repo','private','repo','https://repo')",
  );
  const token = await issueToken(env.DB, "person", "fixture", "write");
  const credential = { kind: "token", id: token.id } as const;
  const space = await findSpaceById(env.DB, "space");
  if (!space) throw new Error("Missing fixture Space");
  access = await accessFor(env, space, "person", null, true, credential);
  const authority = await captureWorkAuthority(env, "repo", {
    id: "person",
    credential,
  });
  input = { timelineId: "tl", timelineSlug: "search", authority } as WorkSourceInput;
});

describe("ensureWorkSource", () => {
  test.each(["credential", "Space grant"] as const)(
    "revoking %s during a retry prevents another allocation dispatch",
    async (kind) => {
      rpc.initializeWorkSource.mockRejectedValueOnce(internal).mockResolvedValue(initialized);
      await expect(
        ensureWorkSource(env, access, repo, input, async () => {
          if (kind === "credential")
            await env.DB.prepare("DELETE FROM access_tokens WHERE id=?")
              .bind(input.authority.credential.id)
              .run();
          else
            await env.DB.prepare("DELETE FROM space_grants WHERE space_id=? AND account_id=?")
              .bind("space", "person")
              .run();
        }),
      ).rejects.toMatchObject({ code: "work_authorization_revoked" });
      expect(rpc.initializeWorkSource).toHaveBeenCalledTimes(1);
    },
  );

  test("retries transient provider failures: initialization resumes from its reservation", async () => {
    rpc.initializeWorkSource
      .mockRejectedValueOnce(internal)
      .mockRejectedValueOnce(dropped)
      .mockResolvedValueOnce(initialized);
    const waits: number[] = [];
    const source = await ensureWorkSource(env, access, repo, input, async (ms) => {
      waits.push(ms);
    });
    expect(source).toEqual(initialized.value);
    expect(waits).toEqual(SOURCE_RETRY_DELAYS_MS.slice(0, 2));
    expect(rpc.initializeWorkSource).toHaveBeenCalledTimes(3);
    for (const call of rpc.initializeWorkSource.mock.calls)
      expect(call).toEqual([access, repo, input]);
  });

  test("a fork still in progress after a dropped connection is waited for, as long as it asks", async () => {
    rpc.initializeWorkSource
      .mockRejectedValueOnce(dropped)
      .mockRejectedValueOnce(forking)
      .mockRejectedValueOnce(forking)
      .mockResolvedValueOnce(initialized);
    const waits: number[] = [];
    const source = await ensureWorkSource(env, access, repo, input, async (ms) => {
      waits.push(ms);
    });
    expect(source).toEqual(initialized.value);
    expect(waits).toEqual([...SOURCE_RETRY_DELAYS_MS]);
    expect(waits.at(-1)).toBeGreaterThanOrEqual(5_000);
  });

  test("a failure that persists is a retryable 503, not a 500", async () => {
    rpc.initializeWorkSource.mockRejectedValue(internal);
    const error = await ensureWorkSource(env, access, repo, input, async () => {}).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TrackerError);
    expect(error).toMatchObject({ status: 503, code: "source_unavailable" });
    expect(rpc.initializeWorkSource).toHaveBeenCalledTimes(SOURCE_RETRY_DELAYS_MS.length + 1);
  });

  test("refusals and unknown failures are not retried", async () => {
    rpc.initializeWorkSource.mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: "source_not_ready",
      error: "Fenced.",
      details: {},
    });
    await expect(ensureWorkSource(env, access, repo, input, async () => {})).rejects.toMatchObject({
      status: 409,
      code: "source_not_ready",
    });
    rpc.initializeWorkSource.mockRejectedValueOnce(new Error("ls-refs failed with HTTP 403"));
    await expect(ensureWorkSource(env, access, repo, input, async () => {})).rejects.toThrow(
      "HTTP 403",
    );
    expect(rpc.initializeWorkSource).toHaveBeenCalledTimes(2);
  });
});

test("transient Artifacts errors: provider failures and dropped remote connections only", () => {
  expect(isTransientArtifactsError(internal)).toBe(true);
  expect(isTransientArtifactsError({ code: "UPSTREAM_UNAVAILABLE" })).toBe(true);
  expect(isTransientArtifactsError(dropped)).toBe(true);
  // A remote binding's error keeps only its message.
  expect(isTransientArtifactsError(new Error("ArtifactsError: An internal error occurred."))).toBe(
    true,
  );
  expect(isTransientArtifactsError(forking)).toBe(true);
  // A bounded binding call that got no answer, with or without its name across RPC (CORE-409).
  expect(
    isTransientArtifactsError(new DOMException("Timed out after 60000 ms", "TimeoutError")),
  ).toBe(true);
  expect(isTransientArtifactsError(new Error("Timed out after 60000 ms"))).toBe(true);
  expect(isTransientArtifactsError({ code: "NOT_FOUND" })).toBe(false);
  expect(isTransientArtifactsError({ code: "INVALID_INPUT" })).toBe(false);
  expect(isTransientArtifactsError(new Error("Repository was deleted."))).toBe(false);
  expect(isTransientArtifactsError("INTERNAL_ERROR")).toBe(false);
});
