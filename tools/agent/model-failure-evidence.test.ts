import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  collectModelFailureEvidence,
  FAILURE_EVIDENCE_LIMITS,
  modelFailureAttempt,
} from "./model-failure-evidence.ts";

const event = {
  event: "ai.model.failed",
  at: "2026-10-11T12:00:00.000Z",
  attempt: "d899ce7d-73a3-46da-a7f1-76bc37a8d612",
  provider: "workers-ai",
  model: "@cf/test/model",
  scopeKind: "space",
  scopeId: "acc_test",
  feature: "knowledge",
  dispatched: true,
  kind: "binding_internal",
  code: 1031,
  status: 500,
  name: "AiInternalError",
} as const;

await test("mixed logs retain only projected diagnostics, never secret fields or malformed lines", async () => {
  const artifacts = await mkdtemp(join(tmpdir(), "model-failure-evidence-"));
  try {
    const secret = "super-secret-credential";
    await writeFile(
      join(artifacts, "server.log"),
      [
        `ordinary output ${secret}`,
        JSON.stringify({ event: "another.event", token: secret }),
        JSON.stringify({
          ...event,
          message: secret,
          stack: secret,
          cause: { token: secret },
          input: secret,
          output: secret,
        }),
        `{"event":"ai.model.failed","message":"${secret}"`,
        JSON.stringify({ ...event, attempt: secret }),
        JSON.stringify({ ...event, model: `https://example.com/${secret}` }),
        JSON.stringify({ payload: event, token: secret }),
        "",
      ].join("\n"),
    );
    const report = await collectModelFailureEvidence(artifacts);
    assert.equal(report.read, "complete");
    assert.deepEqual(report.events, [event]);
    assert.equal(report.invalidEvents, 3);
    assert.equal(JSON.stringify(report).includes(secret), false);
  } finally {
    await rm(artifacts, { recursive: true, force: true });
  }
});

await test("bounded evidence records event and oversized-line overflows without raw bytes", async () => {
  const artifacts = await mkdtemp(join(tmpdir(), "model-failure-overflow-"));
  try {
    await writeFile(
      join(artifacts, "server.log"),
      [
        JSON.stringify({ ...event, secret: "x".repeat(FAILURE_EVIDENCE_LIMITS.lineBytes) }),
        ...Array.from({ length: FAILURE_EVIDENCE_LIMITS.events + 2 }, () => JSON.stringify(event)),
        "",
      ].join("\n"),
    );
    const report = await collectModelFailureEvidence(artifacts);
    assert.equal(report.events.length, FAILURE_EVIDENCE_LIMITS.events);
    assert.equal(report.omittedEvents, 2);
    assert.equal(report.oversizedLines, 1);
    assert.equal(report.omittedBytes, 0);
    assert.equal(report.invalidEvents, 0);
  } finally {
    await rm(artifacts, { recursive: true, force: true });
  }
});

await test("bounded tail drops a cut line and retains the latest complete diagnostic", async () => {
  const artifacts = await mkdtemp(join(tmpdir(), "model-failure-tail-"));
  try {
    await writeFile(
      join(artifacts, "server.log"),
      "x".repeat(FAILURE_EVIDENCE_LIMITS.bytes + 200) + "\n" + JSON.stringify(event) + "\n",
    );
    const report = await collectModelFailureEvidence(artifacts);
    assert.equal(report.scannedBytes, FAILURE_EVIDENCE_LIMITS.bytes);
    assert.equal(report.omittedBytes, FAILURE_EVIDENCE_LIMITS.bytes + 201);
    assert.deepEqual(report.events, [event]);
  } finally {
    await rm(artifacts, { recursive: true, force: true });
  }
});

await test("Gateway attempts project only bounded UUID metadata", () => {
  assert.equal(modelFailureAttempt(event.attempt), event.attempt);
  for (const value of [
    null,
    undefined,
    {},
    "secret",
    `${event.attempt}\nsecret`,
    `https://${event.attempt}`,
  ])
    assert.equal(modelFailureAttempt(value), undefined);
});

await test("known warning and ANSI framing is accepted, arbitrary surrounding text is not", async () => {
  const artifacts = await mkdtemp(join(tmpdir(), "model-failure-framing-"));
  try {
    const json = JSON.stringify(event);
    await writeFile(
      join(artifacts, "server.log"),
      [
        `[WARNING] ${json}`,
        `\x1b[33m▲ [WARNING]\x1b[0m ${json}`,
        `untrusted message ${json}`,
        `${json} arbitrary suffix`,
        "",
      ].join("\n"),
    );
    const report = await collectModelFailureEvidence(artifacts);
    assert.deepEqual(report.events, [event, event]);
    assert.equal(report.invalidEvents, 1);
  } finally {
    await rm(artifacts, { recursive: true, force: true });
  }
});

await test("a truncated matching event is counted without retaining its bytes", async () => {
  const artifacts = await mkdtemp(join(tmpdir(), "model-failure-truncated-"));
  try {
    await writeFile(join(artifacts, "server.log"), '{"event":"ai.model.failed"');
    const report = await collectModelFailureEvidence(artifacts);
    assert.equal(report.invalidEvents, 1);
    assert.deepEqual(report.events, []);
  } finally {
    await rm(artifacts, { recursive: true, force: true });
  }
});
