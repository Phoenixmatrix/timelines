// The development probe behind E2E durable-objects-register-and-purge
// (CORE-267): on a slow host its own retire() alarm must not fire mid-probe.
import { afterEach, expect, test, vi } from "vite-plus/test";
import { d1, migratedDatabase } from "../testing/d1.ts";
import type { PurgeReport, StorageReport } from "./contract.ts";
import { forgetRecorded } from "./registry.ts";
import { probeDurableObjects } from "./probe.ts";

afterEach(() => {
  vi.useRealTimers();
  forgetRecorded();
});

test("a slow host never lets the retire alarm purge the instance before the probe does", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // An instance whose alarm, once due, has destroyed it (as the assistant's does),
  // on a host where each call takes two seconds.
  let due: number | null = null;
  const stub = {
    async retire(_reason: string, _name: string, delayMs = 1_000) {
      due = Date.now() + delayMs;
    },
    async storageReport(): Promise<StorageReport> {
      vi.setSystemTime(Date.now() + 2_000);
      if (due !== null && Date.now() >= due) throw new Error("destroyed");
      return { bytes: 8192, tables: [], keys: 1, alarm: due };
    },
    async purge(reason: string): Promise<PurgeReport> {
      due = null;
      return {
        reason,
        purgedAt: new Date().toISOString(),
        bytes: 0,
        tables: [],
        keys: 0,
        alarm: null,
      };
    },
  };
  const env = {
    DB: d1(migratedDatabase()),
    TRACKER: { getByName: () => stub },
  } as unknown as Env;
  const [result] = await probeDurableObjects(env, "acc_jun", ["Tracker"]);
  expect(result!.before).toMatchObject({ keys: 1, alarm: expect.any(Number) });
  expect(result!.purged).toMatchObject({ keys: 0, alarm: null, reason: "probe" });
  expect(result!.row?.purge_reason).toBe("probe");
});

test("a failure names the class and the stage it failed at", async () => {
  const env = {
    DB: d1(migratedDatabase()),
    TRACKER: {
      getByName: () => ({
        async retire() {},
        async storageReport(): Promise<StorageReport> {
          throw new Error("internal error; reference = 0123");
        },
      }),
    },
  } as unknown as Env;
  await expect(probeDurableObjects(env, "acc_jun", ["Tracker"])).rejects.toThrow(
    /^Durable probe: Tracker probe-[0-9a-f]+ failed at storage report: Error: internal error; reference = 0123$/,
  );
});
