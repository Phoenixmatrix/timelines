// The mod's pure logic, as Node unit tests (`node --test`, run by cli#test).
// The hooks module itself needs Claude Code: `claude --plugin-dir` this folder.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  claimedKey,
  currentTimeline,
  gmCalls,
  gmErrorMessage,
  latestCheckpoint,
  leaseLabel,
  metaLine,
  myClaims,
  nextFocus,
  toWork,
} from "../hooks/gm.ts";

const NOW = Date.parse("2026-10-07T12:00:00Z");

describe("gmCalls", () => {
  test("finds gm issue commands and their keys in a command line", () => {
    assert.deepEqual(gmCalls("vp run ready && gm issue checkpoint CORE-12 'done; next'"), [
      { sub: "checkpoint", key: "CORE-12" },
    ]);
    assert.deepEqual(gmCalls("GM_TIMELINE=x gm --owner matrixorg issue claim CORE-7"), [
      { sub: "claim", key: "CORE-7" },
    ]);
    assert.deepEqual(gmCalls("/home/me/.local/bin/gm issue release CORE-2"), [
      { sub: "release", key: "CORE-2" },
    ]);
    assert.deepEqual(gmCalls("gm push --queue --issue CORE-9"), [{ sub: null, key: null }]);
  });

  test("skips the isolated agent wrapper and other tools", () => {
    assert.deepEqual(gmCalls("vp run agent gm -- issue claim CORE-1"), []);
    assert.deepEqual(gmCalls("git status; ls gm"), []);
  });
});

describe("nextFocus", () => {
  test("follows claims and checkpoints, and clears on complete or release", () => {
    assert.equal(nextFocus(null, gmCalls("gm issue claim CORE-3"), ""), "CORE-3");
    assert.equal(nextFocus("CORE-3", gmCalls("gm issue complete CORE-3 --evidence 'x'"), ""), null);
    assert.equal(nextFocus("CORE-3", gmCalls("gm issue release CORE-4"), ""), "CORE-3");
    assert.equal(nextFocus("CORE-3", gmCalls("gm issue show CORE-8"), ""), "CORE-3");
  });

  test("reads the key gm issue next claimed", () => {
    const output = JSON.stringify({ claimed: { issueId: "i", key: "CORE-44", expiresAt: "x" } });
    assert.equal(nextFocus(null, gmCalls("gm issue next"), output), "CORE-44");
    assert.equal(claimedKey('note\n{"claimed":{"key":"CORE-5","leaseToken":"t"}}'), "CORE-5");
    assert.equal(claimedKey('{"claimed":null}'), null);
  });
});

test("myClaims keeps this agent's live claims, newest first", () => {
  const claim = (actorId: string, expiresAt: string) => ({ actorId, expiresAt });
  const list = {
    issues: [
      {
        key: "CORE-1",
        updatedAt: "2026-10-07T10:00:00Z",
        claim: claim("me", "2026-10-07T12:30:00Z"),
      },
      {
        key: "CORE-2",
        updatedAt: "2026-10-07T11:00:00Z",
        claim: claim("me", "2026-10-07T12:10:00Z"),
      },
      {
        key: "CORE-3",
        updatedAt: "2026-10-07T11:30:00Z",
        claim: claim("other", "2026-10-07T13:00:00Z"),
      },
      {
        key: "CORE-4",
        updatedAt: "2026-10-07T11:45:00Z",
        claim: claim("me", "2026-10-07T11:00:00Z"),
      },
      { key: "CORE-5", updatedAt: "2026-10-07T11:50:00Z", claim: null },
    ],
  };
  assert.deepEqual(
    myClaims(list, "me", NOW).map((issue) => issue.key),
    ["CORE-2", "CORE-1"],
  );
  assert.deepEqual(myClaims(list, null, NOW), []);
});

test("toWork reads gm issue show: the lease when it's ours, the holder otherwise", () => {
  const shown = (actorId: string) => ({
    issue: {
      key: "CORE-9",
      title: "Title",
      status: "in_progress",
      priority: 2,
      claim: { actorId, agent: "droid", expiresAt: "2026-10-07T12:41:30Z" },
    },
    notes: [{ kind: "checkpoint", body: "**Tests** pass", createdAt: "2026-10-07T11:00:00Z" }],
  });
  const context = { agentId: "me", timeline: "core-9", otherClaims: 1 };
  assert.deepEqual(toWork(shown("me"), context), {
    key: "CORE-9",
    title: "Title",
    status: "in_progress",
    priority: 2,
    claimedBy: null,
    leaseExpiresAt: "2026-10-07T12:41:30Z",
    timeline: "core-9",
    checkpoint: "Tests pass",
    otherClaims: 1,
  });
  const theirs = toWork(shown("someone"), context);
  assert.equal(theirs.claimedBy, "droid");
  assert.equal(theirs.leaseExpiresAt, null);
});

test("latestCheckpoint takes the newest checkpoint's first line", () => {
  assert.equal(
    latestCheckpoint([
      { kind: "comment", body: "not this", createdAt: "2026-10-07T12:00:00Z" },
      { kind: "checkpoint", body: "**Old** step", createdAt: "2026-10-07T10:00:00Z" },
      {
        kind: "checkpoint",
        body: "\nTests `pass`; next: push\nmore",
        createdAt: "2026-10-07T11:00:00Z",
      },
    ]),
    "Tests pass; next: push",
  );
  assert.equal(latestCheckpoint(undefined), null);
});

test("metaLine summarizes status, priority, lease and timeline", () => {
  const work = {
    key: "CORE-1",
    title: "T",
    status: "in_progress",
    priority: 1,
    claimedBy: null,
    leaseExpiresAt: "2026-10-07T12:41:30Z",
    timeline: "core-1",
    checkpoint: null,
    otherClaims: 0,
  };
  assert.equal(metaLine(work, NOW), "in progress · P1 · lease 41m · ⎇ core-1");
  assert.equal(leaseLabel("2026-10-07T13:05:00Z", NOW), "lease 1h05m");
  assert.equal(leaseLabel("2026-10-07T11:59:00Z", NOW), "lease expired");
  assert.equal(leaseLabel(null, NOW), null);
});

test("currentTimeline and gmErrorMessage read gm's JSON", () => {
  assert.equal(currentTimeline({ current: "core-7" }), "core-7");
  assert.equal(currentTimeline({ current: { name: "core-8" } }), "core-8");
  assert.equal(currentTimeline({ current: null }), null);
  assert.equal(
    gmErrorMessage('{"error":{"code":"x","message":"Not a gm workspace"}}'),
    "Not a gm workspace",
  );
  assert.equal(gmErrorMessage("\nplain failure\n"), "plain failure");
});
