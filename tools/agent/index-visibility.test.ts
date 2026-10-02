import assert from "node:assert/strict";
import { test } from "node:test";
import {
  waitForIndexVisibility,
  type IndexedItem,
  type SearchResult,
  type VisibilityReport,
} from "./index-visibility.ts";

const target = {
  repo: "priya/fixture",
  key: "repo-fixture/file:checksum.ts.md",
  path: "checksum.ts",
  symbolId: "symbol:checksum.ts:copperFinchChecksum",
  fileId: "file:checksum.ts",
};
const indexed: IndexedItem = { id: "item-fixture", key: target.key, status: "completed" };
const visible: SearchResult = {
  entities: [{ id: target.symbolId }],
  passages: [{ kind: "code", path: target.path, text: "copperFinchChecksum modulo 65521" }],
};
function clock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}

await test("waits for the exact item beyond the old window without spending retrieval calls", async () => {
  const timer = clock();
  const report = {} as VisibilityReport;
  let searches = 0;
  await waitForIndexVisibility({
    target,
    report,
    ...timer,
    item: async () => ({ ...indexed, status: timer.now() < 360_000 ? "running" : "completed" }),
    search: async () => {
      searches++;
      return visible;
    },
  });
  assert.equal(report.outcome, "passed");
  assert.equal(report.elapsedMs, 360_000);
  assert.equal(searches, 1);
  assert.equal(report.itemChecks.length, 19);
});

await test("a never-indexed item fails at the deadline with identity and elapsed wait", async () => {
  const report = {} as VisibilityReport;
  await assert.rejects(
    waitForIndexVisibility({
      target,
      report,
      ...clock(),
      timeoutMs: 100,
      pollMs: 30,
      item: async () => ({ ...indexed, status: "queued" }),
      search: async () => {
        assert.fail("Must not search a queued item");
      },
    }),
    /priya\/fixture repo-fixture\/file:checksum.ts.md \(item item-fixture, status queued\) after 100ms.*deadline exceeded/,
  );
  assert.equal(report.outcome, "failed");
  assert.equal(report.elapsedMs, 100);
  assert.equal(report.attempts.length, 0);
});

await test("a missing upload stays a failure rather than waiting forever", async () => {
  const report = {} as VisibilityReport;
  await assert.rejects(
    waitForIndexVisibility({
      target,
      report,
      ...clock(),
      timeoutMs: 100,
      pollMs: 20,
      item: async () => null,
      search: async () => visible,
    }),
    /item not found, status missing.*100ms/,
  );
  assert.equal(report.itemChecks.length, 5);
});

await test("completed indexing does not pass without the exact consumer passage", async () => {
  const report = {} as VisibilityReport;
  await assert.rejects(
    waitForIndexVisibility({
      target,
      report,
      ...clock(),
      item: async () => indexed,
      search: async () => ({
        ...visible,
        passages: [{ ...visible.passages[0], path: "README.md" }],
      }),
    }),
    /after 570000ms.*retrieval attempts exhausted.*missing: AI Search source passage/,
  );
  assert.equal(report.attempts.length, 6);
  assert.deepEqual(report.missing, ["AI Search source passage"]);
});

await test("does not combine entity and passage matches from different responses", async () => {
  const report = {} as VisibilityReport;
  let calls = 0;
  await assert.rejects(
    waitForIndexVisibility({
      target,
      report,
      ...clock(),
      retrievalDelays: [0, 1],
      item: async () => indexed,
      search: async () =>
        ++calls === 1 ? { ...visible, passages: [] } : { ...visible, entities: [] },
    }),
    /missing: Vectorize entity/,
  );
  assert.deepEqual(
    report.attempts.map(({ entityFound, passageFound }) => [entityFound, passageFound]),
    [
      [true, false],
      [false, true],
    ],
  );
});

await test("late search results cannot pass after the total deadline", async () => {
  const timer = clock();
  const report = {} as VisibilityReport;
  await assert.rejects(
    waitForIndexVisibility({
      target,
      report,
      ...timer,
      timeoutMs: 100,
      item: async () => indexed,
      search: async (remaining) => {
        assert.equal(remaining, 100);
        await timer.sleep(101);
        return visible;
      },
    }),
    /after 101ms.*deadline exceeded during retrieval/,
  );
  assert.equal(report.outcome, "failed");
});

await test("provider indexing errors fail immediately with their item identity", async () => {
  const report = {} as VisibilityReport;
  await assert.rejects(
    waitForIndexVisibility({
      target,
      report,
      ...clock(),
      item: async () => ({ ...indexed, status: "error" }),
      search: async () => {
        assert.fail("Must not search a failed item");
      },
    }),
    /item item-fixture, status error.*terminal indexing failure/,
  );
  assert.equal(report.elapsedMs, 0);
});

await test("transport errors stay failures and do not leak raw diagnostics", async () => {
  const report = {} as VisibilityReport;
  await assert.rejects(
    waitForIndexVisibility({
      target,
      report,
      ...clock(),
      item: async () => {
        throw new Error("private provider diagnostic");
      },
      search: async () => visible,
    }),
    (error: Error) => {
      assert.match(error.message, /provider observation failed/);
      assert.doesNotMatch(error.message, /private provider/);
      return true;
    },
  );
  assert.equal(report.outcome, "failed");
});

await test("reserves the final retrieval for late Vectorize visibility without extra calls", async () => {
  const timer = clock();
  const report = {} as VisibilityReport;
  await waitForIndexVisibility({
    target,
    report,
    ...timer,
    item: async () => indexed,
    search: async () => (timer.now() < 500_000 ? { ...visible, entities: [] } : visible),
  });
  assert.equal(report.outcome, "passed");
  assert.equal(report.elapsedMs, 570_000);
  assert.equal(report.attempts.length, 6);
});
