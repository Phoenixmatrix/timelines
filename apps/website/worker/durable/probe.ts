// DEVELOPMENT ONLY (POST /api/dev/durable): the purge contract in the real
// runtime, for the E2E scenario durable-objects-register-and-purge. For each
// class: reach a fresh instance through the registry helper (recording it),
// give it storage and an alarm through retire(), purge it before that alarm
// is due, and report what it held before, what purge left, and its row.
//
// The alarm is due well after the probe ends (CORE-267): at retire()'s
// default second, a slow host let it fire mid-probe, so the instance purged
// itself first (an empty "before") or, for the assistant, destroyed itself
// under the probe's storage read (a 500).

import { db } from "../schema.ts";
import { DURABLE_CLASS_NAMES, type DurableClass } from "./classes.ts";
import type { PurgeReport, StorageReport } from "./contract.ts";
import {
  durableAgent,
  durableStub,
  instanceStorage,
  purgeInstance,
  retireInstance,
} from "./registry.ts";

/** Far beyond any probe: its purge, not the alarm, must be what clears the instance. */
export const PROBE_RETIRE_DELAY_MS = 10 * 60_000;

export interface ProbeResult {
  class: DurableClass;
  name: string;
  registered: boolean;
  before: StorageReport;
  purged: PurgeReport;
  row: { purged_at: string | null; purge_reason: string | null } | null;
}

async function waitForRow(env: Env, cls: DurableClass, name: string): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    const row = await db(env.DB)
      .selectFrom("do_instances")
      .select("name")
      .where("class", "=", cls)
      .where("name", "=", name)
      .executeTakeFirst();
    if (row) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function probeDurableObjects(
  env: Env,
  personaId: string,
  only?: DurableClass[],
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const cls of only ?? DURABLE_CLASS_NAMES) {
    const id = crypto.randomUUID().replaceAll("-", "");
    const name = cls === "Assistant" ? `${personaId}:probe${id}` : `probe-${id}`;
    // Name the class and stage on failure: the runtime's own errors are often opaque.
    let stage = "use";
    try {
      // A use, as the app makes them: recorded in the background.
      if (cls === "Assistant") await durableAgent(env, cls, name);
      else durableStub(env, cls, name);
      stage = "registry row";
      const registered = await waitForRow(env, cls, name);
      // Storage and an alarm: retire()'s marker and wake-up, not due during the probe.
      stage = "retire";
      await retireInstance(env, cls, name, "probe", PROBE_RETIRE_DELAY_MS);
      stage = "storage report";
      const before = await instanceStorage(env, cls, name);
      stage = "purge";
      const purged = await purgeInstance(env, cls, name, "probe");
      stage = "purge row";
      const row =
        (await db(env.DB)
          .selectFrom("do_instances")
          .select(["purged_at", "purge_reason"])
          .where("class", "=", cls)
          .where("name", "=", name)
          .executeTakeFirst()) ?? null;
      results.push({ class: cls, name, registered, before, purged, row });
    } catch (error) {
      throw new Error(`Durable probe: ${cls} ${name} failed at ${stage}: ${String(error)}`, {
        cause: error,
      });
    }
  }
  return results;
}
