// The way to reach a business Durable Object instance (CORE-197). `durableStub`
// returns the stub and records the instance in the D1 registry (do_instances)
// so it can be found and purged from outside later, even after whatever named
// it is gone. Recording never blocks or fails the caller: it runs in the
// background, at most about once an hour per instance and isolate, and a
// failure is only logged.
//
// `purgeInstance` and `retireInstance` are how anything (retention, repository
// deletion) gets rid of an instance; never a hand-built stub.
//
// Independent cutover control stays outside this tenant lifecycle registry.

import type { Assistant } from "../assistant/agent.ts";
import type { KnowledgeCoordinator } from "../knowledge/coordinator.ts";
import type { StepFeed } from "../steps/feed.ts";
import type { CiSandbox } from "../ci/sandbox.ts";
import type { Tracker } from "../tracker/object.ts";
import type { RepoDO } from "../../registry/do/repo-do.ts";
import type { UploadDO } from "../../registry/do/upload-do.ts";
import type { LoginDO } from "../../registry/do/login-do.ts";
import { DURABLE_CLASSES, type DurableClass } from "./classes.ts";
import type { Purgeable, PurgeReport, StorageReport } from "./contract.ts";
import { recordPurge, recordRetiring, recordUse, resolveDurableOwner } from "./record.ts";
import { withCutoverAdmission } from "./cutover-admission.ts";

/** Each class's RPC type, for typed stubs. */
export interface DurableTypes {
  Tracker: Tracker;
  Assistant: Assistant;
  KnowledgeCoordinator: KnowledgeCoordinator;
  StepFeed: StepFeed;
  CiSandbox: CiSandbox;
  RegistryRepo: RepoDO;
  RegistryUpload: UploadDO;
  RegistryLogin: LoginDO;
}

export interface DurableOwner {
  /** Genuine person hint only; never used for named content classes. */
  account?: string | null;
  /** Stable app repository id for a sandbox not yet backed by its job/run row. */
  repo?: string | null;
}

/** Record an instance's use at most this often per isolate (and the database, per row). */
export const TOUCH_EVERY_MS = 60 * 60_000;
/** Instances an isolate remembers recording before it starts over. */
const MEMORY_LIMIT = 10_000;
const recorded = new Map<string, { at: number; hint: string }>();

function key(cls: DurableClass, name: string) {
  return `${cls}\u0000${name}`;
}

export function durableNamespace<C extends DurableClass>(
  env: Env,
  cls: C,
): DurableObjectNamespace<DurableTypes[C]> {
  // The config names the classes by string, so their bindings can't infer the RPC type.
  return Reflect.get(env, DURABLE_CLASSES[cls].binding) as DurableObjectNamespace<DurableTypes[C]>;
}

/** The stub for an instance, recorded in the registry. */
export function durableStub<C extends Exclude<DurableClass, "Assistant">>(
  env: Env,
  cls: C,
  name: string,
  owner?: DurableOwner,
): DurableObjectStub<DurableTypes[C]> {
  const stub = durableNamespace(env, cls).getByName(name);
  touchInstance(env, cls, name, owner);
  return stub;
}

/**
 * A typed stub that isn't a use: for looking at an instance before purging it
 * (repository deletion reads a coordinator's running builds), so it neither
 * records the instance nor revives a purged registry row.
 */
export function peekStub<C extends Exclude<DurableClass, "Assistant">>(
  env: Env,
  cls: C,
  name: string,
): DurableObjectStub<DurableTypes[C]> {
  return durableNamespace(env, cls).getByName(name);
}

/**
 * The assistant facade uses the same named-instance/startup contract as the
 * Agents SDK. Its admission precedes SDK construction and persistent recovery.
 */
export async function durableAgent(
  env: Env,
  cls: "Assistant",
  name: string,
  owner?: DurableOwner,
): Promise<DurableObjectStub<Assistant>> {
  touchInstance(env, cls, name, owner);
  return agentStub(env, name);
}

async function agentStub(env: Env, name: string): Promise<DurableObjectStub<Assistant>> {
  const stub = durableNamespace(env, "Assistant").getByName(name);
  // Match getAgentByName's default startup retries (agents/agent-routing):
  // only platform retryable failures, never overload/admission failures.
  for (let attempt = 1; ; attempt++) {
    try {
      await stub.__unsafe_ensureInitialized();
      return stub;
    } catch (error) {
      if (
        attempt >= 3 ||
        typeof error !== "object" ||
        error === null ||
        Reflect.get(error, "retryable") !== true ||
        Reflect.get(error, "overloaded") === true
      )
        throw error;
      const pause = Promise.withResolvers<void>();
      setTimeout(
        pause.resolve,
        Math.floor(Math.random() * Math.min(800, 100 * 2 ** (attempt - 1))),
      );
      await pause.promise;
    }
  }
}

/** A stub that isn't a use: purging or sizing must not count as activity. */
async function contractStub(env: Env, cls: DurableClass, name: string): Promise<Purgeable> {
  if (cls === "Assistant") return (await agentStub(env, name)) as unknown as Purgeable;
  return durableNamespace(env, cls).getByName(name) as unknown as Purgeable;
}

/** Record the instance in the background; never throws, never blocks. */
export function touchInstance(
  env: Env,
  cls: DurableClass,
  name: string,
  owner?: DurableOwner,
): void {
  try {
    const d1 = Reflect.get(env, "DB") as D1Database | undefined;
    if (!d1) return;
    const id = key(cls, name);
    const hint = JSON.stringify([owner?.repo ?? null, owner?.account ?? null]);
    const now = Date.now();
    const last = recorded.get(id);
    if (last !== undefined && last.hint === hint && now - last.at < TOUCH_EVERY_MS) return;
    if (recorded.size >= MEMORY_LIMIT) recorded.clear();
    recorded.set(id, { at: now, hint });
    const at = new Date(now).toISOString();
    const freshAfter = new Date(now - TOUCH_EVERY_MS).toISOString();
    background(
      withCutoverAdmission(env, "durable-registry", async () => {
        const resolved = await resolveDurableOwner(env, cls, name, owner);
        await recordUse(d1, { class: cls, name, ...resolved }, at, freshAfter);
      }).catch((error: unknown) => {
        recorded.delete(id);
        console.warn("Durable: recording an instance failed", cls, error);
      }),
    );
  } catch (error) {
    console.warn("Durable: recording an instance failed", cls, error);
  }
}

/** Forget what this isolate recorded (tests). */
export function forgetRecorded(): void {
  recorded.clear();
}

type WaitUntil = (promise: Promise<unknown>) => void;
let waitUntil: WaitUntil | null | undefined;
let loading: Promise<void> | undefined;

/**
 * Keep the request alive until `work` settles, with the runtime's waitUntil
 * (cloudflare:workers), loaded lazily so plain unit tests don't need it.
 */
function background(work: Promise<unknown>): void {
  if (waitUntil !== undefined) {
    waitUntil?.(work);
    return;
  }
  loading ??= import("cloudflare:workers").then(
    (runtime) => {
      try {
        waitUntil = typeof runtime.waitUntil === "function" ? runtime.waitUntil : null;
      } catch {
        // A test's mock of the module without it.
        waitUntil = null;
      }
    },
    () => {
      waitUntil = null;
    },
  );
  void loading.then(() => {
    try {
      waitUntil?.(work);
    } catch {
      // Outside a request (a test): the work runs on its own.
    }
  });
}

/**
 * A purge call's report. The Agents SDK's destroy() deletes the assistant's
 * storage, then aborts the instance on the next tick, which can beat the
 * RPC's reply: that abort means the purge happened, with nothing left.
 */
async function settled<T extends PurgeReport | null>(
  cls: DurableClass,
  reason: string,
  call: () => Promise<T>,
): Promise<T | PurgeReport> {
  try {
    return await call();
  } catch (error) {
    const reset =
      (error as { durableObjectReset?: boolean } | null)?.durableObjectReset === true &&
      error instanceof Error &&
      error.message === "destroyed";
    if (cls !== "Assistant" || !reset) throw error;
    return {
      reason,
      purgedAt: new Date().toISOString(),
      bytes: 0,
      tables: [],
      keys: 0,
      alarm: null,
    };
  }
}

/**
 * Purge an instance now (its purge(): alarm cancelled, external resources
 * released, storage deleted) and record it. Idempotent.
 */
export async function purgeInstance(
  env: Env,
  cls: DurableClass,
  name: string,
  reason: string,
): Promise<PurgeReport> {
  const stub = await contractStub(env, cls, name);
  const report = (await settled(cls, reason, () => stub.purge(reason)))!;
  recorded.delete(key(cls, name));
  await recordPurge(env, cls, name, report);
  return report;
}

/**
 * Purge an assistant chat unless it's being written to (retention, CORE-204),
 * and record it. Null when a turn is in progress: nothing changed.
 */
export async function purgeIdleChat(
  env: Env,
  name: string,
  reason: string,
): Promise<PurgeReport | null> {
  const stub = await agentStub(env, name);
  const report = await settled("Assistant", reason, () => stub.purgeIfIdle(reason));
  if (!report) return null;
  recorded.delete(key("Assistant", name));
  await recordPurge(env, "Assistant", name, report);
  return report;
}

/**
 * Ask an instance to purge itself once its in-flight work ends (from its
 * alarm, due in `delayMs`), which it then records. For instances that may be
 * mid-build or mid-job; purgeInstance for the rest.
 */
export async function retireInstance(
  env: Env,
  cls: DurableClass,
  name: string,
  reason: string,
  delayMs?: number,
): Promise<void> {
  const stub = await contractStub(env, cls, name);
  await stub.retire(reason, name, delayMs);
  recorded.delete(key(cls, name));
  await recordRetiring(env, cls, name);
}

/** What an instance holds now (wakes it; the sweep sizes recently active ones). */
export async function instanceStorage(
  env: Env,
  cls: DurableClass,
  name: string,
): Promise<StorageReport> {
  return (await contractStub(env, cls, name)).storageReport();
}
