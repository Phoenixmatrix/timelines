import { DatabaseSync } from "node:sqlite";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import { describe, expect, test } from "vite-plus/test";
import { d1 } from "./testing/d1.ts";
import { startTiming, timedCall, timedD1, timedEnv, Timing, timingFor } from "./timing.ts";

function entries(header: string) {
  return header.split(", ").map((part) => part.split(";")[0]);
}

describe("Timing", () => {
  test("names each phase, tallies repeated calls in one entry, and ends with total", async () => {
    const timing = new Timing();
    await timing.measure("admission", Promise.resolve(true));
    timing.measureSync("auth-init", () => 1);
    for (let i = 0; i < 3; i++) await timing.tally("do", "calls", Promise.resolve(i));
    const header = timing.header();
    expect(entries(header)).toEqual(["admission", "auth-init", "do", "total"]);
    expect(header).toMatch(/^admission;desc="admission #1";dur=\d+\.\d/);
    expect(header).toContain('do;desc="3 calls (summed)";dur=');
    expect(header).toMatch(/total;dur=\d+\.\d$/);
  });

  test("a measured failure is still recorded and rethrown", async () => {
    const timing = new Timing();
    await expect(timing.tally("d1", "queries", Promise.reject(new Error("no")))).rejects.toThrow(
      "no",
    );
    expect(timing.header()).toContain('d1;desc="1 queries (summed)"');
  });

  test("the fetch entry's Timing is found again from the same request only", () => {
    const request = new Request("https://example.test/api/session");
    const timing = startTiming(request);
    expect(timingFor(request)).toBe(timing);
    expect(timingFor(new Request(request))).toBeUndefined();
  });

  test("timedCall tallies only when the request is timed", async () => {
    expect(await timedCall(undefined, Promise.resolve(1))).toBe(1);
    const timing = new Timing();
    expect(await timedCall(timing, Promise.resolve(2))).toBe(2);
    expect(timing.header()).toContain('do;desc="1 calls (summed)"');
  });
});

describe("timedD1", () => {
  test("counts every round trip, through Kysely and batches, with results unchanged", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)");
    const timing = new Timing();
    const database = timedD1(d1(sqlite), timing);

    await database.prepare("INSERT INTO t(name) VALUES (?)").bind("a").run();
    // The real batch refuses statements that aren't its own, so these must be unwrapped.
    await database.batch([
      database.prepare("INSERT INTO t(name) VALUES (?)").bind("b"),
      database.prepare("INSERT INTO t(name) VALUES (?)").bind("c"),
    ]);
    expect(await database.prepare("SELECT count(*) AS n FROM t").first("n")).toBe(3);
    const kysely = new Kysely<{ t: { id: number; name: string } }>({
      dialect: new D1Dialect({ database }),
    });
    const rows = await kysely.selectFrom("t").select("name").orderBy("id").execute();
    expect(rows).toEqual([{ name: "a" }, { name: "b" }, { name: "c" }]);
    expect(timing.header()).toContain('d1;desc="4 queries (summed)"');
  });

  test("timedEnv times DB and inherits every other binding", async () => {
    const sqlite = new DatabaseSync(":memory:");
    const other = { name: "other" };
    const env = { DB: d1(sqlite), OTHER: other } as unknown as Env;
    const timing = new Timing();
    const timed = timedEnv(env, timing);
    expect(Reflect.get(timed, "OTHER")).toBe(other);
    expect(env.DB).not.toBe(timed.DB);
    await timed.DB.prepare("SELECT 1").first();
    expect(timing.header()).toContain('d1;desc="1 queries (summed)"');
  });
});
