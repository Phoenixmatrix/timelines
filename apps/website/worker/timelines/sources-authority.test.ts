import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { RepoRow } from "../db.ts";
import type { Access } from "../tracker/store.ts";
import { ensureWorkSource, type WorkSourceInput } from "./sources.ts";

const boundary = vi.hoisted(() => ({ authorize: vi.fn(), initialize: vi.fn() }));
vi.mock(import("../ci/admission.ts"), async (original) => ({
  ...(await original()),
  resolveWorkAuthority: boundary.authorize,
}));
vi.mock("../tracker/stub.ts", () => ({
  trackerObject: () => ({ initializeWorkSource: boundary.initialize }),
}));

const repo = { id: "repo-opaque", space_id: "space-opaque" } as RepoRow;
const access = { spaceId: "space-opaque" } as Access;
const input: WorkSourceInput = {
  timelineId: "timeline-opaque",
  timelineSlug: "work",
  authority: {
    spaceId: "space-opaque",
    migrationEpoch: 7,
    personId: "person-opaque",
    agentId: "agent-opaque",
    credential: { kind: "token", id: "credential-opaque" },
  },
  base: {
    sourceId: "source-opaque",
    repoId: "repo-opaque",
    kind: "timeline-work",
    timelineId: "parent-opaque",
    ref: "refs/heads/work",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
  },
};

beforeEach(() => {
  boundary.authorize.mockReset();
  boundary.initialize.mockReset();
});

test.each(["Space grant revoked", "agent revoked", "migration_epoch_mismatch"])(
  "a delayed source retry does not reuse admission after %s",
  async (reason) => {
    boundary.authorize.mockResolvedValueOnce({ repo }).mockRejectedValueOnce(new Error(reason));
    boundary.initialize.mockRejectedValueOnce(
      Object.assign(new Error("An internal error occurred."), {
        name: "ArtifactsError",
        code: "INTERNAL_ERROR",
      }),
    );
    await expect(ensureWorkSource({} as Env, access, repo, input, async () => {})).rejects.toThrow(
      reason,
    );
    expect(boundary.initialize).toHaveBeenCalledTimes(1);
    expect(boundary.authorize).toHaveBeenCalledTimes(2);
    for (const call of boundary.authorize.mock.calls)
      expect(call.slice(1)).toEqual([input.authority, repo.id]);
  },
);

test("initial denial cannot allocate a source or replace opaque identity and roots", async () => {
  boundary.authorize.mockRejectedValueOnce(new Error("Space mismatch"));
  await expect(ensureWorkSource({} as Env, access, repo, input)).rejects.toThrow("Space mismatch");
  expect(boundary.initialize).not.toHaveBeenCalled();
  expect(input.base).toMatchObject({
    sourceId: "source-opaque",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
  });
});

test("successful admission forwards the exact authority, source root and Access", async () => {
  boundary.authorize.mockResolvedValue({ repo });
  boundary.initialize.mockResolvedValue({ ok: true, value: { source: input.base } });
  await ensureWorkSource({} as Env, access, repo, input);
  expect(boundary.initialize).toHaveBeenCalledWith(access, repo, input);
  expect(boundary.initialize.mock.calls[0]![2]).toBe(input);
});

test("revocation while allocation runs prevents publishing the source to its caller", async () => {
  boundary.authorize
    .mockResolvedValueOnce({ repo })
    .mockRejectedValueOnce(new Error("credential revoked"));
  boundary.initialize.mockResolvedValue({ ok: true, value: { source: input.base } });
  await expect(ensureWorkSource({} as Env, access, repo, input)).rejects.toThrow(
    "credential revoked",
  );
  expect(boundary.initialize).toHaveBeenCalledTimes(1);
  expect(boundary.authorize).toHaveBeenCalledTimes(2);
});
