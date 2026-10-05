import { describe, expect, test } from "vite-plus/test";
import type { KnowledgeStatus } from "../../../shared/api.ts";
import type { AtlasOverview, AtlasRegion } from "../../../shared/atlas.ts";
import { fileNote, scopeNotices, summaryNote } from "./atlasStates.ts";

const overview = (over: Partial<AtlasOverview> = {}, regions: Partial<AtlasRegion>[] = []) =>
  ({
    snapshot: {
      id: "s1",
      seq: 2,
      vector: [{ repoId: "r1", commit: "aaaaaaaaaa", buildId: "b" }],
      publishedAt: null,
      partial: false,
      projectionVersion: 3,
      expiresAt: null,
    },
    capacityFailure: null,
    regions: regions as AtlasRegion[],
    ...over,
  }) as AtlasOverview;
const status = (over: Partial<KnowledgeStatus>) =>
  ({
    state: "up-to-date",
    head: "aaaaaaaaaa",
    indexedCommit: "aaaaaaaaaa",
    ...over,
  }) as KnowledgeStatus;
const ids = (n: ReturnType<typeof scopeNotices>) => n.map((x) => x.id);

describe("Atlas states", () => {
  test("a current map says nothing", () => {
    expect(scopeNotices(status({}), overview())).toEqual([]);
  });

  test("building, failed and behind each say which commit the map shows", () => {
    const building = scopeNotices(status({ state: "building", head: "bbbbbbbbbb" }), overview());
    expect(building).toEqual([
      expect.objectContaining({
        id: "building",
        tone: "info",
        text: expect.stringMatching(/aaaaaaa.*bbbbbbb/),
      }),
    ]);
    expect(scopeNotices(status({ state: "failed" }), overview())[0]).toMatchObject({
      id: "failed",
      tone: "error",
    });
    expect(ids(scopeNotices(status({ head: "cccccccccc" }), overview()))).toEqual(["behind"]);
    // A pinned view after its build landed: the newer map is offered, not forced.
    const newer = scopeNotices(
      status({ head: "cccccccccc", indexedCommit: "cccccccccc" }),
      overview(),
    );
    expect(newer).toEqual([expect.objectContaining({ id: "newer", current: true })]);
  });

  test("capacity, partial and summary states are distinct", () => {
    const notices = scopeNotices(
      status({}),
      overview(
        {
          capacityFailure: { snapshotId: "s2", seq: 3, error: "Capacity", failedAt: "" } as never,
          snapshot: { ...overview().snapshot, partial: true },
        },
        [
          { summaryState: { status: "unavailable", reason: "budget_exhausted" } },
          { summaryState: { status: "unavailable", reason: "provider_error" } },
          { summaryState: { status: "current" } },
        ],
      ),
    );
    expect(ids(notices)).toEqual(["capacity", "partial", "summaries-paused", "summaries-failed"]);
  });

  test("summaries switched off say structure is complete, not that nothing exists", () => {
    const notices = scopeNotices(
      status({}),
      overview({}, [
        { summaryState: { status: "unavailable", reason: "disabled" } },
        { summaryState: { status: "unavailable", reason: "disabled" } },
      ]),
    );
    expect(notices).toEqual([
      expect.objectContaining({
        id: "summaries-off",
        text: expect.stringMatching(/Structure, links and sources are complete/),
      }),
    ]);
  });

  test("a missing summary is labelled with its reason; a stale one as describing an earlier build", () => {
    expect(summaryNote({ status: "current" })).toBeNull();
    expect(summaryNote({ status: "unavailable", reason: "budget_exhausted" })).toMatch(
      /budget was used up.*complete/,
    );
    expect(summaryNote({ status: "stale", reason: "provider_error" })).toMatch(
      /out of date.*earlier build/,
    );
    expect(summaryNote({ status: "stale" }, "0123456789")).toMatch(/describes 0123456\./);
  });

  test("files say why they have no summary or capability, never that they're unused", () => {
    expect(fileNote({ pending: true })).toMatch(/Not analyzed yet/);
    expect(fileNote({ skipped: "lockfile" })).toMatch(
      /Skipped as a lockfile.*source is still here/,
    );
    expect(fileNote({ skipped: "too large" })).toMatch(/too large to analyze/);
    expect(fileNote({ membership: { unclassified: "no-evidence" } })).toMatch(
      /lack of evidence, not proof it's unused/,
    );
    expect(fileNote({ language: "yaml", membership: { unclassified: "no-evidence" } })).toMatch(
      /links aren't extracted from yaml.*unsupported, not unused/,
    );
    expect(fileNote({ language: "typescript", membership: { capability: "cap:x" } })).toBeNull();
  });

  test("pushes waiting for a batched update say how many, and that the map shows the indexed commit (CORE-286)", () => {
    const notices = scopeNotices(
      status({
        state: "queued",
        head: "cccccccccc",
        pending: { pushes: 3, since: "2026-10-05T12:00:00Z", dueAt: "2026-10-05T12:20:00Z" },
      }),
      overview(),
    );
    expect(notices).toEqual([
      expect.objectContaining({
        id: "building",
        tone: "info",
        text: expect.stringMatching(
          /^This map shows aaaaaaa\. 3 pushes are waiting for the next update, at about .+; the branch is at ccccccc\.$/,
        ),
      }),
    ]);
  });
});
