import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  HANDOFF_ENV,
  announceHandoff,
  awaitHandoff,
  backgroundCleanupSpawn,
  cleanupMode,
  gatesWriteBindingTypes,
  isEnvironmentLimitRefusal,
  overlapSetup,
  seedMayBeAffected,
  type OverlapSteps,
} from "./live-run.ts";

interface Fake {
  id: number;
  error?: unknown;
}

/** Fake steps recording the order of calls; each can be made to fail or wait. */
function harness(
  options: {
    gate?: () => Promise<void>;
    setups?: (Fake | Promise<Fake>)[];
    abort?: () => Promise<void>;
    finish?: () => Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const setups = [...(options.setups ?? [{ id: 1 }])];
  const steps: OverlapSteps<Fake> = {
    async runGates() {
      calls.push("gates:start");
      await options.gate?.();
      calls.push("gates:end");
    },
    async startLive(signal) {
      signals.push(signal);
      calls.push("setup:start");
      const next = await setups.shift()!;
      calls.push(`setup:end:${next.id}`);
      return next;
    },
    setupFailure: (setup) => setup.error,
    async finishLive(setup, overlapped) {
      calls.push(`finish:${setup.id}:${overlapped}`);
      await options.finish?.();
    },
    async abortLive(setup) {
      calls.push(`abort:${setup.id}`);
      await options.abort?.();
    },
  };
  return { calls, signals, steps };
}

const quota = new Error("Machine environment limit reached (4). Destroy unused environments.");

await test("setup starts before the gates and the scenarios run once both pass", async () => {
  const { calls, signals, steps } = harness();
  const outcome = await overlapSetup(steps);
  assert.deepEqual(outcome, { overlapped: true, quotaFallback: false });
  assert.equal(signals[0]?.aborted, false, "passing gates never abort the setup");
  assert.equal(calls[0], "setup:start");
  assert.deepEqual(calls.slice(-1), ["finish:1:true"]);
  assert.ok(calls.indexOf("gates:end") < calls.indexOf("finish:1:true"));
});

await test("a failing gate tears the setup down and throws the gate error", async () => {
  const gateError = new Error("website-tests failed");
  const { calls, steps } = harness({
    gate: async () => {
      throw gateError;
    },
  });
  await assert.rejects(overlapSetup(steps), (error) => error === gateError);
  assert.ok(calls.includes("setup:end:1"));
  assert.ok(calls.includes("abort:1"));
  assert.ok(!calls.some((call) => call.startsWith("finish")));
});

await test("a gate failure aborts the setup instead of waiting for it to complete", async () => {
  const gateError = new Error("gate");
  const { calls, steps } = harness({
    gate: async () => {
      throw gateError;
    },
  });
  // A setup that never finishes on its own: it settles only when aborted, with the abort's error.
  steps.startLive = (signal) => {
    calls.push("setup:start");
    return new Promise<Fake>((accept) =>
      signal!.addEventListener("abort", () => {
        calls.push("setup:aborted");
        accept({ id: 7, error: signal!.reason });
      }),
    );
  };
  // The abort's own error is not reported: only the gate's.
  await assert.rejects(overlapSetup(steps), (error) => error === gateError);
  assert.deepEqual(calls.slice(-2), ["setup:aborted", "abort:7"]);
  assert.ok(!calls.some((call) => call.startsWith("finish")));
});

await test("a setup aborted outright still reports only the gate failure", async () => {
  const gateError = new Error("gate");
  const { steps } = harness({
    gate: async () => {
      throw gateError;
    },
  });
  steps.startLive = (signal) =>
    new Promise<Fake>((_, reject) =>
      signal!.addEventListener("abort", () => reject(signal!.reason)),
    );
  await assert.rejects(overlapSetup(steps), (error) => error === gateError);
});

await test("a setup failure with passing gates is the live run's failure", async () => {
  const error = new Error("seed failed");
  const { calls, steps } = harness({ setups: [{ id: 2, error }] });
  const outcome = await overlapSetup(steps);
  assert.equal(outcome.quotaFallback, false);
  // finishLive reports it, with the same teardown and completion as a sequential run.
  assert.deepEqual(calls.slice(-1), ["finish:2:true"]);
});

await test("a setup that rejects outright is rethrown after the gates", async () => {
  const error = new Error("boom");
  const steps = harness().steps;
  steps.startLive = async () => {
    throw error;
  };
  await assert.rejects(overlapSetup(steps), (thrown) => thrown === error);
});

await test("both failing reports the gate failure with the setup error", async () => {
  const gateError = new Error("gate");
  const setupError = new Error("provision failed");
  const { calls, steps } = harness({
    gate: async () => {
      throw gateError;
    },
    setups: [{ id: 3, error: setupError }],
  });
  await assert.rejects(overlapSetup(steps), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [gateError, setupError]);
    return true;
  });
  assert.ok(calls.includes("abort:3"));
});

await test("a setup error after the abort is still reported when the abort did not cause it", async () => {
  const gateError = new Error("gate");
  const provisionError = new AggregateError([], "Provisioning failed and cleanup remains pending");
  const { calls, steps } = harness({
    gate: async () => {
      throw gateError;
    },
  });
  // Provisioning takes no signal: it fails on its own, after the abort was signalled.
  steps.startLive = (signal) =>
    new Promise<Fake>((accept) =>
      signal!.addEventListener("abort", () =>
        setImmediate(() => accept({ id: 8, error: provisionError })),
      ),
    );
  await assert.rejects(overlapSetup(steps), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [gateError, provisionError]);
    return true;
  });
  assert.ok(calls.includes("abort:8"));
});

await test("a failing abort is reported beside the gate error", async () => {
  const gateError = new Error("gate");
  const abortError = new Error("destroy failed");
  const { steps } = harness({
    gate: async () => {
      throw gateError;
    },
    abort: async () => {
      throw abortError;
    },
  });
  await assert.rejects(overlapSetup(steps), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [gateError, abortError]);
    return true;
  });
});

await test("a refused environment quota falls back to a setup after the gates", async () => {
  const { calls, steps } = harness({ setups: [{ id: 4, error: quota }, { id: 5 }] });
  const outcome = await overlapSetup(steps);
  assert.deepEqual(outcome, { overlapped: false, quotaFallback: true });
  assert.equal(calls.filter((call) => call === "setup:start").length, 2);
  assert.ok(calls.lastIndexOf("setup:start") > calls.indexOf("gates:end"));
  assert.deepEqual(calls.slice(-1), ["finish:5:false"]);
});

await test("a quota refusal does not hide a gate failure", async () => {
  const gateError = new Error("gate");
  const { steps } = harness({
    gate: async () => {
      throw gateError;
    },
    setups: [{ id: 6, error: quota }],
  });
  await assert.rejects(overlapSetup(steps), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [gateError, quota]);
    return true;
  });
});

await test("environment limit refusals are recognised, other errors are not", () => {
  assert.ok(isEnvironmentLimitRefusal(quota));
  assert.ok(
    isEnvironmentLimitRefusal(new Error("Installation environment limit reached (4/4) on host")),
  );
  assert.ok(isEnvironmentLimitRefusal(new AggregateError([quota])));
  assert.ok(!isEnvironmentLimitRefusal(new Error("seed failed")));
});

await test("the setup skips binding types only when a gate regenerates them", () => {
  assert.ok(gatesWriteBindingTypes([{ name: "check" }, { name: "website-types" }]));
  assert.ok(gatesWriteBindingTypes([{ name: "bindings" }]));
  assert.ok(!gatesWriteBindingTypes([{ name: "check" }, { name: "cli-check" }]));
});

await test("the seed repeats unless no changed path can reach it", () => {
  // The bootstrap, the endpoints and gm it drives, and anything not known to be inert.
  assert.ok(seedMayBeAffected(["tools/agent/seed.ts"]));
  assert.ok(seedMayBeAffected(["README.md", "apps/website/seed/0001_dev.sql"]));
  assert.ok(seedMayBeAffected(["apps/website/worker/routes/dev.ts"]));
  assert.ok(seedMayBeAffected(["apps/website/shared/tracker.ts"]));
  assert.ok(seedMayBeAffected(["apps/cli/src/main.rs"]));
  assert.ok(seedMayBeAffected(["tools/agent/e2e.ts"]));
  assert.ok(seedMayBeAffected(["apps/website/src/testing/fixtures.ts"]));
  assert.ok(seedMayBeAffected(["docs/guide.md"]));
  assert.ok(seedMayBeAffected(["apps/website/src/app.tsx", "apps/website/worker/index.ts"]));
  // Frontend, tests, documentation and coding-agent configuration only.
  assert.ok(
    !seedMayBeAffected([
      "apps/website/src/app.tsx",
      "apps/website/src/routes/home.browser.test.tsx",
      "tools/agent/seed.test.ts",
      "README.md",
      "apps/website/README.md",
      ".claude/agents/runner.md",
      ".agents/skills/gitmatrix-graph-work/SKILL.md",
    ]),
  );
  assert.ok(!seedMayBeAffected([]));
});

await test("only a local ready run cleans up in the background", () => {
  assert.equal(cleanupMode({ ready: true, foregroundFlag: false, hosted: false }), "background");
  assert.equal(cleanupMode({ ready: true, foregroundFlag: true, hosted: false }), "foreground");
  assert.equal(cleanupMode({ ready: true, foregroundFlag: false, hosted: true }), "foreground");
  assert.equal(cleanupMode({ ready: false, foregroundFlag: false, hosted: false }), "foreground");
});

await test("the detached cleanup runs the same script on one validated environment id", () => {
  const spawned = backgroundCleanupSpawn({
    execPath: "/usr/bin/node",
    execArgv: ["--experimental-strip-types"],
    script: "/repo/tools/agent/main.ts",
    id: "gma-abcdefgh-0123456789ab",
  });
  assert.deepEqual(spawned, {
    command: "/usr/bin/node",
    args: [
      "--experimental-strip-types",
      "/repo/tools/agent/main.ts",
      "destroy-environment",
      "gma-abcdefgh-0123456789ab",
    ],
  });
  assert.throws(() =>
    backgroundCleanupSpawn({ execPath: "node", execArgv: [], script: "m.ts", id: "../x" }),
  );
});

/** A fake detached child: its fd 3 pipe and its process events. */
function handoffFake() {
  return { channel: new PassThrough(), child: new EventEmitter() };
}

await test("the handoff is the announced line, even split across chunks", async () => {
  const { channel, child } = handoffFake();
  const outcome = awaitHandoff({ channel, child, timeoutMs: 5_000 });
  channel.write("lo");
  channel.write("cked\n");
  assert.equal(await outcome, "locked");
});

await test("a child whose pipe closes without the line has not taken over", async () => {
  const { channel, child } = handoffFake();
  const outcome = awaitHandoff({ channel, child, timeoutMs: 5_000 });
  // Garbage, and the line without its end, are not the announcement.
  channel.write("unlocked\nlocked");
  channel.end();
  assert.equal(await outcome, "exited");
});

await test("a child that never announces times out", async () => {
  const { channel, child } = handoffFake();
  assert.equal(await awaitHandoff({ channel, child, timeoutMs: 20 }), "timeout");
});

await test("a child that cannot start rejects the handoff", async () => {
  const { channel, child } = handoffFake();
  const outcome = awaitHandoff({ channel, child, timeoutMs: 5_000 });
  const error = new Error("spawn ENOENT");
  child.emit("error", error);
  await assert.rejects(outcome, (thrown) => thrown === error);
});

await test("a real child that exits before announcing is seen as exited", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(3)"], {
    stdio: ["ignore", "ignore", "ignore", "pipe"],
  });
  assert.equal(
    await awaitHandoff({ channel: child.stdio[3]!, child, timeoutMs: 30_000 }),
    "exited",
  );
});

await test("a real child announces only when the parent asked", async () => {
  const script = `import {announceHandoff} from ${JSON.stringify(new URL("./live-run.ts", import.meta.url).pathname)}; announceHandoff(); setTimeout(() => {}, 200);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, [HANDOFF_ENV]: "1" },
    stdio: ["ignore", "ignore", "inherit", "pipe"],
  });
  assert.equal(
    await awaitHandoff({ channel: child.stdio[3]!, child, timeoutMs: 30_000 }),
    "locked",
  );
});

await test("a destroy-environment started by hand never writes to fd 3", () => {
  const writes: number[] = [];
  const io = {
    write: (fd: number) => void writes.push(fd),
    close: (fd: number) => void writes.push(-fd),
  };
  announceHandoff({}, io);
  assert.deepEqual(writes, []);
  announceHandoff({ [HANDOFF_ENV]: "1" }, io);
  assert.deepEqual(writes, [3, -3]);
  // A parent that is gone does not stop the destroy.
  announceHandoff(
    { [HANDOFF_ENV]: "1" },
    {
      write: () => {
        throw new Error("EPIPE");
      },
      close: () => {},
    },
  );
});
