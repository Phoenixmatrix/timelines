import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { heavyLock, parseMemAvailable, withFileLock } from "./heavy.ts";
import { abandoned, type JsonReport } from "./website-tests.ts";

// The tail of a real run whose Chromium was killed under memory pressure (CORE-306).
const crashed = `
⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯

Vitest caught 1 unhandled error during the test run.
This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.

⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
Error: Failed to run the test /w/src/routes/atlas/WorkspaceAtlas.browser.test.tsx.
Caused by: Error: [vitest] Browser connection was closed while running tests. Was the page closed unexpectedly?
Serialized Error: { code: 'VITEST_BROWSER_CONNECTION_CLOSED' }

 Test Files  223 passed | 2 skipped (245)
`;
const files = [
  "/w/src/a.browser.test.tsx",
  "/w/src/b.browser.test.tsx",
  "/w/src/c.browser.test.tsx",
];
const passed = (name: string) => ({
  name,
  status: "passed",
  assertionResults: [{ status: "passed" }],
});

await test("a crash reruns only the browser files the run didn't finish", () => {
  const report: JsonReport = {
    testResults: [
      passed("/w/src/a.browser.test.tsx"),
      // As Vitest reports them: the file it was running when Chromium died, and one it never started.
      {
        name: "/w/src/b.browser.test.tsx",
        status: "passed",
        assertionResults: [{ status: "passed" }, { status: "pending" }],
      },
      { name: "/w/src/c.browser.test.tsx", status: "passed", assertionResults: [] },
      passed("/w/worker/unit.test.ts"),
    ],
  };
  assert.deepEqual(abandoned(report, crashed, files), [
    "/w/src/b.browser.test.tsx",
    "/w/src/c.browser.test.tsx",
  ]);
});

await test("a test that failed because the browser died is rerun, not counted as its own failure", () => {
  const report: JsonReport = {
    testResults: [
      {
        name: "/w/src/a.browser.test.tsx",
        status: "failed",
        assertionResults: [
          { status: "failed", failureMessages: ["Error: Target crashed"] },
          { status: "passed" },
        ],
      },
    ],
  };
  assert.deepEqual(abandoned(report, crashed, files), files);
});

await test("a failed assertion is never retried, even alongside a crash", () => {
  const report: JsonReport = {
    testResults: [
      {
        name: "/w/src/a.browser.test.tsx",
        status: "failed",
        assertionResults: [
          { status: "failed", failureMessages: ["AssertionError: expected 1 to be 2"] },
        ],
      },
    ],
  };
  assert.equal(abandoned(report, crashed, files), null);
});

await test("failures without a crash, or other unhandled errors beside it, are not retried", () => {
  assert.equal(abandoned({ testResults: [] }, "Test Files  1 failed | 3 passed (4)", files), null);
  const alsoRejected = `${crashed}
⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
TypeError: Cannot read properties of undefined (reading 'x')
`;
  assert.equal(abandoned({ testResults: [] }, alsoRejected, files), null);
});

await test("Playwright's own crash report counts as a crash too", () => {
  const killed = `
⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
Error: The chromium page crashed while running tests. This can happen if the browser ran out of memory.
 ❯ _Page._onCrash node_modules/playwright-core/lib/client/page.js:1:1
`;
  assert.deepEqual(
    abandoned({ testResults: [passed("/w/src/a.browser.test.tsx")] }, killed, files),
    ["/w/src/b.browser.test.tsx", "/w/src/c.browser.test.tsx"],
  );
});

await test("with no report, a crash reruns every browser file", () => {
  assert.deepEqual(abandoned(null, crashed, files), files);
});

await test("available memory is read from MemAvailable", () => {
  const meminfo =
    "MemTotal:       15342336 kB\nMemFree:          512000 kB\nMemAvailable:    2097152 kB\n";
  assert.equal(parseMemAvailable(meminfo), 2 * 2 ** 30);
  assert.equal(parseMemAvailable("MemTotal: 1 kB\n"), null);
});

await test("a held file lock makes the next holder wait, and is told so", async () => {
  const directory = await mkdtemp(join(tmpdir(), "heavy-lock-"));
  try {
    const path = join(directory, "heavy.lock");
    const order: string[] = [];
    const first = Promise.withResolvers<void>();
    const holding = withFileLock(path, 30, async () => {
      order.push("first");
      await first.promise;
      order.push("first done");
    });
    // Let the first holder take the lock.
    while (!order.includes("first")) await new Promise((r) => setTimeout(r, 10));
    let waited = false;
    const second = withFileLock(
      path,
      30,
      async () => {
        order.push("second");
      },
      () => {
        waited = true;
        first.resolve();
      },
    );
    await Promise.all([holding, second]);
    assert.equal(waited, true);
    assert.deepEqual(order, ["first", "first done", "second"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("without flock the heavy lock runs the work unlocked, as in a container", async () => {
  const path = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    assert.equal(await heavyLock("test", async () => "ran"), "ran");
  } finally {
    process.env.PATH = path;
  }
});
