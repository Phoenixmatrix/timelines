import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { QueueEntry } from "../../apps/website/shared/merge-queue.ts";
import { queueFixture } from "./queue-e2e.ts";
import type { HarnessContext, SeedManifest } from "./types.ts";

/** No fake classifier or repair: the running merge job calls the real resolve endpoint. */
export async function runQueueAiE2E(
  ctx: HarnessContext,
  fixtures: SeedManifest,
  evidence: Record<string, unknown>,
) {
  const events: unknown[] = [];
  evidence.events = events;
  evidence.startedAt = new Date().toISOString();
  const f = await queueFixture(ctx, fixtures, (event) => events.push(event));
  evidence.repo = f.repo;
  const base = "# Visitor guide\n\nThe garden opens each morning.\n";
  const north = "\nThe north path passes a pond.\n";
  const south = "\nThe south path passes a meadow.\n";
  async function commit(file: string, content: string, message: string) {
    await writeFile(join(f.root, file), content);
    await f.git(["add", file]);
    await f.git(["-c", "core.hooksPath=/dev/null", "commit", "-m", message]);
    return f.git(["rev-parse", "HEAD"]);
  }
  async function submit(oid: string) {
    await f.git(["push", "origin", `${oid}:refs/heads/gitmatrix/queue/${oid}`]);
    return (
      await f.json<{ entry: QueueEntry }>(`${f.api}/queue`, "POST", { commit: oid }, [200, 201])
    ).entry;
  }
  const fork = await commit("docs/guide.md", base, "Visitor guide baseline");
  await f.git(["push", "origin", "HEAD:main"]);
  await f.git(["checkout", "-b", "north", fork]);
  const source = await commit("docs/guide.md", base + north, "Document north path");
  await f.git(["checkout", "main"]);
  const main = await commit("docs/guide.md", base + south, "Document south path");
  await f.git(["push", "origin", "HEAD:main"]);
  const accepted = await submit(source);
  const landed = await f.landed(accepted.id);
  evidence.repaired = landed;
  assert.equal(landed.base, main);
  assert.equal(landed.decision?.action, "repair", "Real Clef must approve the bounded repair");
  assert(landed.decision?.model, "Repair requires recorded classifier model");
  assert((landed.decision.confidence ?? 0) >= 0.95, "Every semantic check requires P(yes) >= 0.95");
  assert.equal(await f.tip(), landed.candidate);
  const actual = await f.git(["show", "origin/main:docs/guide.md"], f.root, true);
  assert(
    [base + north + south, base + south + north].includes(actual),
    "Repair must retain exactly base and both contributions, byte for byte, without new text",
  );
  evidence.content = actual;

  // A code conflict must remain manual even though the real model is available.
  await f.git(["checkout", "-B", "main", "origin/main"]);
  const codeFork = await f.git(["rev-parse", "HEAD"]);
  await f.git(["checkout", "-b", "code-conflict", codeFork]);
  const unsafeSource = await commit("value.ts", "export const value = 13;\n", "Source code change");
  await f.git(["checkout", "main"]);
  const unsafeMain = await commit(
    "value.ts",
    "export const value = 31;\n",
    "Independent code change",
  );
  await f.git(["push", "origin", "HEAD:main"]);
  const unsafe = await submit(unsafeSource);
  const manual = await f.wait(unsafe.id);
  evidence.manual = manual;
  assert.equal(manual.status, "failed");
  assert.equal(manual.decision?.action, "manual");
  assert.equal(manual.failure?.repairModel, null, "Code conflict must not invoke the repair model");
  assert.deepEqual(manual.failure?.conflictPaths, ["value.ts"]);
  assert.equal(await f.tip(), unsafeMain);
  assert.equal(manual.gateRun, null, "Unsafe conflict must not produce a candidate for gates");

  // These append-only ordinary docs pass deterministic prefilters, but the
  // real classifier must reject their mutually exclusive claims before repair.
  const hoursBase = "# Garden opening hours\n\nThis page describes opening hours.\n";
  const always = "\nThe garden is always open on Mondays.\n";
  const never = "\nThe garden is never open on Mondays.\n";
  const hoursFork = await commit("docs/hours.md", hoursBase, "Garden opening hours baseline");
  await f.git(["push", "origin", "HEAD:main"]);
  await f.git(["checkout", "-b", "contradictory-hours", hoursFork]);
  const hoursSource = await commit("docs/hours.md", hoursBase + always, "Document Monday opening");
  await f.git(["checkout", "main"]);
  const hoursMain = await commit("docs/hours.md", hoursBase + never, "Document Monday closure");
  await f.git(["push", "origin", "HEAD:main"]);
  const contradictory = await submit(hoursSource);
  const rejected = await f.wait(contradictory.id);
  evidence.contradictory = rejected;
  assert.equal(rejected.status, "failed");
  assert.equal(
    rejected.decision?.action,
    "manual",
    "Real Clef must reject contradictory documentation",
  );
  assert.equal(
    rejected.decision?.model,
    "@cf/cloudflare/clef",
    "Contradictory prose must reach the real classifier",
  );
  assert.equal(
    rejected.failure?.repairModel,
    null,
    "Semantic rejection must precede repair generation",
  );
  assert.deepEqual(rejected.failure?.conflictPaths, ["docs/hours.md"]);
  assert.equal(rejected.gateRun, null, "Semantic rejection cannot start candidate gates");
  assert.equal(await f.tip(), hoursMain, "Semantic rejection cannot advance main");
  evidence.finishedAt = new Date().toISOString();
  evidence.outcome = "passed";
}
