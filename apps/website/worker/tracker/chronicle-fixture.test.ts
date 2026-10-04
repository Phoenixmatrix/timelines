// The Chronicle's development history (CORE-251): real mutations under a
// controlled clock, reproducible from its seed, read back by the Chronicle
// exactly as planned for the showcase issue.

import { afterEach, describe, expect, test } from "vite-plus/test";
import { durableStorage } from "../testing/durable.ts";
import { runChronicleFixture } from "./chronicle-fixture.ts";
import { TrackerStore, type Access } from "./store.ts";

const databases: { close(): void }[] = [];
afterEach(() => {
  for (const db of databases) db.close();
  databases.length = 0;
});

const END = Date.parse("2026-10-04T12:00:00.000Z");

function make(seed: number, issues = 120) {
  const { db, sql, transactionSync } = durableStorage();
  databases.push(db);
  let clock = END;
  const store = new TrackerStore(sql, transactionSync, () => clock);
  const person = (id: string, admin: boolean): Access => ({
    actorId: id,
    principalId: id,
    agents: [
      {
        id: "agt-builder",
        name: "builder",
        accountable: { id: "ann", slug: "ann", displayName: "Ann" },
        capabilities: null,
        capabilitiesUpdatedAt: null,
        revokedAt: null,
      },
    ],
    owner: { id: "org", slug: "org", displayName: "Org" },
    canAdmin: admin,
    members: [
      { id: "ann", slug: "ann", displayName: "Ann" },
      { id: "bo", slug: "bo", displayName: "Bo" },
    ],
    repos: [],
  });
  const ann = person("ann", true);
  const result = runChronicleFixture(
    (access, at, request) => {
      clock = at;
      return store.mutate(access, request);
    },
    [ann, person("bo", false)],
    [{ ...ann, actorId: "agt-builder" }],
    { issues, days: 30, end: END, seed, team: "CHR" },
  );
  clock = END + 60_000;
  return { db, store, ann, result };
}

describe("the Chronicle's development history", () => {
  test("makes thousands of real events over the window, and is reproducible", () => {
    const a = make(7);
    const events = (a.db.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n;
    expect(events).toBeGreaterThan(1500);
    expect(a.result.applied).toBeGreaterThan(1500);
    // The plan rarely meets a refusal it didn't foresee.
    expect(a.result.skipped).toBeLessThan(a.result.issues / 10);
    const times = a.db
      .prepare(
        "SELECT min(json_extract(data, '$.createdAt')) AS first, max(json_extract(data, '$.createdAt')) AS last FROM events",
      )
      .get() as { first: string; last: string };
    expect(Date.parse(times.first)).toBeGreaterThanOrEqual(END - 30 * 86_400_000);
    expect(Date.parse(times.last)).toBeLessThan(END);
    const b = make(7);
    expect(b.result).toEqual(a.result);
  });

  test("the showcase issue reads back as its planned span", () => {
    const { store, ann, result } = make(3, 40);
    const page = store.chronicle(ann, {
      from: new Date(END - 30 * 86_400_000).toISOString(),
      to: new Date(END).toISOString(),
      query: "",
      cursor: null,
      limit: 200,
      quiet: true,
    });
    const showcase = page.issues.find((i) => i.key === result.showcase.key)!;
    expect(result.showcase.key).toBe("CHR-1");
    expect(showcase.spans).toMatchObject([
      {
        holder: "agt-builder",
        start: result.showcase.claimedAt,
        end: result.showcase.completedAt,
        endedBy: "complete",
      },
    ]);
    expect(showcase.markers.map((m) => m.kind)).toEqual(["created", "checkpoint", "evidence"]);
    // People and the agent worked; some spans lapsed, some parked on a person.
    const spans = page.issues.flatMap((i) => i.spans);
    expect(new Set(spans.map((s) => s.holder))).toEqual(new Set(["agt-builder", "ann", "bo"]));
    expect(spans.some((s) => s.endedBy === "expiry")).toBe(true);
    expect(spans.some((s) => s.endedBy === "release")).toBe(true);
  });
});
