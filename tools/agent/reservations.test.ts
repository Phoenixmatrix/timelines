import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { advanceQuota } from "./quota.ts";
import { mergeOwnershipQuota } from "./remote-protocol.ts";
import {
  EXPIRED_GRACE_MS,
  classifyReservation,
  parseReservationArgs,
  readJournals,
} from "./reservations.ts";

const authority = "https://quota.example";
const host = "this-host";
const quota = (state: "pending" | "reserved" | "released", from = authority) => ({
  authority: from,
  state,
});

await test("quota state only moves forward", () => {
  assert.equal(advanceQuota(quota("released"), quota("reserved"))?.state, "released");
  assert.equal(advanceQuota(quota("reserved"), quota("pending"))?.state, "reserved");
  assert.equal(advanceQuota(quota("pending"), quota("reserved"))?.state, "reserved");
  assert.equal(advanceQuota(quota("reserved"), quota("released"))?.state, "released");
  assert.equal(advanceQuota(quota("released"), undefined)?.state, "released");
  assert.equal(advanceQuota(undefined, quota("pending"))?.state, "pending");
  assert.equal(advanceQuota(undefined, undefined), undefined);
  assert.throws(
    () => advanceQuota(quota("reserved"), quota("released", "https://other.example")),
    /authority changed/,
  );
});

await test("reconciliation classifies rows against every journal on this machine", async () => {
  const root = await mkdtemp(join(tmpdir(), "gitmatrix-reservations-"));
  try {
    await mkdir(join(root, "environments"));
    await mkdir(join(root, "remote", "environments"), { recursive: true });
    const write = (path: string, value: unknown) =>
      writeFile(join(root, path), JSON.stringify(value));
    await write("environments/gma-live.json", { id: "gma-live", quota: quota("reserved") });
    await write("environments/gma-pending.json", { id: "gma-pending", quota: quota("pending") });
    await write("environments/gma-legacy.json", { id: "gma-legacy" });
    await write("environments/gma-done.json", { id: "gma-done", quota: quota("released") });
    await write("environments/gma-moved.json", {
      id: "gma-moved",
      quota: quota("released", "https://other.example"),
    });
    await write("remote/environments/gmr-parent.json", {
      id: "gmr-parent",
      quota: quota("reserved"),
      resources: [
        { id: "gma-child", quota: quota("reserved") },
        { id: "gma-unadmitted", resources: {} },
        { id: "gma-child-done", quota: quota("released") },
      ],
    });
    await write("remote/environments/gmr-gone.json", {
      id: "gmr-gone",
      quota: quota("released"),
      resources: [],
    });
    const view = await readJournals(root);
    const classify = (id: string, rowHost: string | null = null, mine: string | undefined = host) =>
      classifyReservation({ id, host: rowHost }, view, mine, authority);
    // Unreleased journals of every kind are live, whatever host the row names.
    for (const id of ["gma-live", "gma-pending", "gma-legacy", "gmr-parent"])
      assert.equal(classify(id, host), "live", id);
    // CRITICAL: a hosted child its parent still holds is live even when its
    // row claims this host and no local journal exists for it.
    assert.equal(classify("gma-child", host), "live");
    assert.equal(classify("gma-unadmitted", host), "live");
    assert.equal(classify("gma-done"), "released-locally");
    assert.equal(classify("gma-child-done"), "released-locally");
    assert.equal(classify("gmr-gone", host), "released-locally");
    // Released at a different authority than the one listing it: not ours to judge.
    assert.equal(classify("gma-moved", host), "foreign");
    assert.equal(classify("gma-lost", host), "own-orphan");
    // No host on the row (legacy rows, hosted children) is never an orphan here.
    assert.equal(classify("gma-lost", null), "foreign");
    assert.equal(classify("gma-lost", "other-host"), "foreign");
    assert.equal(classify("gma-lost", null, undefined), "foreign");
    // Live wins when one journal released an id another still holds.
    await write("environments/gma-child.json", { id: "gma-child", quota: quota("released") });
    assert.equal(
      classifyReservation({ id: "gma-child", host }, await readJournals(root), host, authority),
      "live",
    );
    // An unreadable journal aborts reconciliation instead of hiding a live id.
    await writeFile(join(root, "remote/environments/gmr-broken.json"), "{");
    await assert.rejects(readJournals(root));
    await write("remote/environments/gmr-broken.json", { id: "gmr-broken" });
    await assert.rejects(readJournals(root), /Unreadable remote ownership journal/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("missing journal directories are empty, not an error", async () => {
  const root = await mkdtemp(join(tmpdir(), "gitmatrix-reservations-empty-"));
  try {
    const view = await readJournals(root);
    assert.equal(view.live.size, 0);
    assert.equal(view.released.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("only unjournaled rows expired past the grace become expired-foreign", async () => {
  const root = await mkdtemp(join(tmpdir(), "gitmatrix-reservations-expired-"));
  try {
    await mkdir(join(root, "environments"));
    await mkdir(join(root, "remote", "environments"), { recursive: true });
    await writeFile(
      join(root, "environments/gma-live.json"),
      JSON.stringify({ id: "gma-live", quota: quota("reserved") }),
    );
    await writeFile(
      join(root, "environments/gma-done.json"),
      JSON.stringify({ id: "gma-done", quota: quota("released") }),
    );
    await writeFile(
      join(root, "remote/environments/gmr-parent.json"),
      JSON.stringify({
        id: "gmr-parent",
        quota: quota("reserved"),
        resources: [{ id: "gma-child", quota: quota("reserved") }],
      }),
    );
    const view = await readJournals(root);
    const now = 10 * EXPIRED_GRACE_MS;
    const long = now - EXPIRED_GRACE_MS - 1;
    const classify = (id: string, expires: number | undefined, rowHost: string | null = null) =>
      classifyReservation({ id, host: rowHost, expires }, view, host, authority, now);
    assert.equal(classify("gma-legacy", long), "expired-foreign");
    assert.equal(classify("gma-elsewhere", long, "other-host"), "expired-foreign");
    // Within the grace, at its edge, or without a usable expiry: plain foreign.
    assert.equal(classify("gma-legacy", now - EXPIRED_GRACE_MS), "foreign");
    assert.equal(classify("gma-legacy", now - 1), "foreign");
    assert.equal(classify("gma-legacy", undefined), "foreign");
    assert.equal(classify("gma-legacy", Number.NaN), "foreign");
    // A journal here always wins, however long ago the row expired.
    for (const id of ["gma-live", "gmr-parent", "gma-child"])
      assert.equal(classify(id, 0, host), "live", id);
    assert.equal(classify("gma-done", 0), "released-locally");
    assert.equal(classify("gma-mine", 0, host), "own-orphan");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("--expired is an explicit addition to --release", () => {
  assert.deepEqual(parseReservationArgs([]), { release: false, expired: false });
  assert.deepEqual(parseReservationArgs(["--release"]), { release: true, expired: false });
  assert.deepEqual(parseReservationArgs(["--release", "--expired"]), {
    release: true,
    expired: true,
  });
  assert.throws(() => parseReservationArgs(["--expired"]), /--release \[--expired\]/);
  assert.throws(() => parseReservationArgs(["--release", "--all"]), /Use maintenance/);
});

await test("the ownership Durable Object merges quota forward and never re-pins it", () => {
  const merge = (
    stored?: ReturnType<typeof quota>,
    written?: ReturnType<typeof quota>,
  ): { state?: string; authority?: string; conflict: boolean } => {
    const result = mergeOwnershipQuota(stored, written);
    return { ...result.quota, conflict: result.conflict };
  };
  // A late or replayed write never undoes progress.
  assert.deepEqual(merge(quota("released"), quota("reserved")), {
    ...quota("released"),
    conflict: false,
  });
  assert.deepEqual(merge(quota("reserved"), quota("pending")), {
    ...quota("reserved"),
    conflict: false,
  });
  assert.deepEqual(merge(quota("pending"), quota("reserved")), {
    ...quota("reserved"),
    conflict: false,
  });
  assert.deepEqual(merge(quota("reserved"), quota("released")), {
    ...quota("released"),
    conflict: false,
  });
  // A write without quota keeps the stored one; a first write is taken as is.
  assert.deepEqual(merge(quota("reserved"), undefined), { ...quota("reserved"), conflict: false });
  assert.deepEqual(merge(undefined, quota("pending")), { ...quota("pending"), conflict: false });
  assert.deepEqual(merge(undefined, undefined), { conflict: false });
  // A different authority is refused, keeping the stored reservation, even when
  // the write claims more progress.
  assert.deepEqual(merge(quota("reserved"), quota("released", "https://other.example")), {
    ...quota("reserved"),
    conflict: true,
  });
});
