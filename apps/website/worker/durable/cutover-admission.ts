import type { WorkflowStep } from "cloudflare:workers";
import type { CUTOVER_CONSUMERS, SpaceCutover } from "../space-cutover/control.ts";
import { CONTENT_CONTRACT_VERSION } from "../../shared/spaces.ts";
import type { Timing } from "../timing.ts";

export type CutoverConsumer = (typeof CUTOVER_CONSUMERS)[number];

/** Instance control is deliberately outside the restorable business registry. */
export function cutoverControl(env: Env): DurableObjectStub<SpaceCutover> {
  return controlNamespace(env).getByName("instance");
}

/** How long an isolate trusts a positive admission read before reading again. */
export const ADMISSION_CACHE_TTL_MS = 60_000;

type Admission = { allowed: boolean; epoch: number };
type OpenAdmission = { allowed: true; epoch: number };

/**
 * Per isolate, by control binding: the last verified positive contract-4
 * admission, as a settled value. Contract-4 admission is absorbing
 * (space-cutover/control.ts SpaceCutover.save refuses to close it or move its
 * epoch), so a positive read stays true; the TTL only bounds how long an
 * isolate goes without checking. Denials and failures are never kept.
 *
 * Only settled values are shared. In workerd a request's I/O belongs to that
 * request (or Durable Object call): a read another request started can be
 * cancelled with it and never settle, so no caller ever awaits a read it did
 * not start. And only a verified read writes here (primeCachedAdmission): the
 * Worker's fetch gate, or verifiedAdmission for callers without that gate,
 * since a hit lets the gate skip its installation check.
 */
let admissions = new WeakMap<object, { open: OpenAdmission; until: number }>();

function controlNamespace(env: Env): DurableObjectNamespace<SpaceCutover> {
  const namespace = Reflect.get(env, "SPACE_CUTOVER") as
    | DurableObjectNamespace<SpaceCutover>
    | undefined;
  if (!namespace) throw new Error("Missing independent Space cutover control binding");
  return namespace;
}

function opened(admission: Admission): OpenAdmission | null {
  return admission.allowed && Number.isSafeInteger(admission.epoch) && admission.epoch >= 0
    ? { allowed: true, epoch: admission.epoch }
    : null;
}

/** This isolate's unexpired verified positive admission, without a round trip; null when none. */
export function peekCachedAdmission(env: Env): OpenAdmission | null {
  const entry = admissions.get(controlNamespace(env));
  return entry && Date.now() < entry.until ? entry.open : null;
}

/**
 * Keep a positive admission read that started at `readAt` (local time, before
 * the call). Only for a read verified as the fetch gate verifies it
 * (space-cutover/installation.ts initializeFreshSpaceInstallation): a run's
 * open admission, or an active native installation that verifyFreshInstallation
 * accepted.
 */
export function primeCachedAdmission(env: Env, admission: Admission, readAt: number): void {
  const open = opened(admission);
  if (!open) return;
  admissions.set(controlNamespace(env), { open, until: readAt + ADMISSION_CACHE_TTL_MS });
}

/**
 * Contract-4 admission (CONTENT_CONTRACT_VERSION): this isolate's verified
 * open admission, else this caller's own read of the control object. That read
 * answers this caller only and is never kept: it does not verify the
 * installation, so it must not let the fetch gate skip its check. Callers
 * that need one read per request share it themselves (api/content-contract.ts
 * requestAdmission). Server-Timing counts admission-cache-hit / -miss.
 */
export function cachedAdmission(env: Env, timing?: Timing): Promise<Admission> {
  const open = peekCachedAdmission(env);
  if (open) {
    timing?.count("admission-cache-hit");
    return Promise.resolve(open);
  }
  timing?.count("admission-cache-miss");
  return new Promise<Admission>((resolve) =>
    resolve(cutoverControl(env).admission(CONTENT_CONTRACT_VERSION)),
  ).then((admission) => ({ allowed: admission.allowed, epoch: admission.epoch }));
}

/**
 * Whether contract-4 admission is open, verified as the Worker's fetch gate
 * verifies it, for callers without that gate (the Tracker Durable Object).
 * On a miss this caller reads installationState() and, for a native
 * installation, verifyFreshInstallation(); only then does it prime the
 * isolate's cache. It never advances an installation, and any failure answers
 * false without priming, leaving the decision to a ticket.
 */
export async function verifiedAdmission(env: Env, timing?: Timing): Promise<boolean> {
  if (peekCachedAdmission(env)) {
    timing?.count("admission-cache-hit");
    return true;
  }
  timing?.count("admission-cache-miss");
  try {
    const control = cutoverControl(env);
    const readAt = Date.now();
    const state = await control.installationState();
    if (!opened(state.admission)) return false;
    if (state.runPhase === null) {
      if (state.fresh?.phase !== "active") return false;
      await control.verifyFreshInstallation();
    }
    primeCachedAdmission(env, state.admission, readAt);
    return true;
  } catch {
    return false;
  }
}

/** Tests: forget one environment's cached admission, or every one. */
export function forgetCachedAdmission(env?: Env): void {
  if (env) admissions.delete(controlNamespace(env));
  else admissions = new WeakMap();
}

/**
 * `work` under steady contract-4 admission. Once admission is open it never
 * closes, and the only thing that reads tickets then is the post-open ref
 * barrier, for Git and registry HTTP: so this consumer's work runs without a
 * ticket. Before admission is verified open (a denial, or a read or
 * verification that failed) it takes one as before, and acquire decides.
 */
export async function withSteadyAdmission<T>(
  env: Env,
  consumer: CutoverConsumer,
  work: () => Promise<T>,
): Promise<T> {
  if (await verifiedAdmission(env)) return work();
  return withCutoverAdmission(env, consumer, work);
}

export async function withCutoverAdmission<T>(
  env: Env,
  consumer: CutoverConsumer,
  work: () => Promise<T>,
): Promise<T> {
  const control = cutoverControl(env);
  const { ticket } = await control.acquire(consumer, CONTENT_CONTRACT_VERSION);
  try {
    return await work();
  } finally {
    await control.release(ticket);
  }
}

function cutoverTasks() {
  const pending = new Set<Promise<void>>();
  const errors: unknown[] = [];
  const add = (work: Promise<unknown>) => {
    const settled = Promise.resolve(work).then(
      () => {
        pending.delete(settled);
      },
      (error: unknown) => {
        pending.delete(settled);
        errors.push(error);
      },
    );
    pending.add(settled);
  };
  return {
    add,
    async settle() {
      // A registered task may itself register another task before it settles.
      while (pending.size) await Promise.all(pending);
      if (errors.length) throw new AggregateError(errors, "Background content work failed");
    },
  };
}

export function trackedContext<T extends Pick<ExecutionContext, "waitUntil">>(original: T) {
  const tasks = cutoverTasks();
  const waitUntil = (work: Promise<unknown>) => {
    tasks.add(work);
    original.waitUntil(work);
  };
  const context = new Proxy(original, {
    get(target, property) {
      if (property === "waitUntil") return waitUntil;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { context, settle: () => tasks.settle() };
}

export async function withCutoverAlarmAdmission(
  env: Env,
  consumer: CutoverConsumer,
  storage: Pick<DurableObjectStorage, "getAlarm" | "setAlarm">,
  work: () => Promise<void>,
): Promise<void> {
  let control: ReturnType<typeof cutoverControl>;
  let ticket: string;
  try {
    control = cutoverControl(env);
    ({ ticket } = await control.acquire(consumer, CONTENT_CONTRACT_VERSION));
  } catch (error) {
    const now = Date.now();
    const retryAt = now + 60_000;
    const current = await storage.getAlarm();
    if (current === null || current <= now || current > retryAt) await storage.setAlarm(retryAt);
    if (error instanceof Error && error.message === "space_cutover_fenced") return;
    throw error;
  }
  try {
    await work();
  } finally {
    await control.release(ticket);
  }
}

export async function withWorkflowCutoverAdmission<T>(
  env: Env,
  consumer: CutoverConsumer,
  event: { instanceId: string },
  step: WorkflowStep,
  binding: "CI_RUN" | "KNOWLEDGE_BUILD" | "REPO_PURGE",
  work: (waitUntil: (pending: Promise<unknown>) => void) => Promise<T>,
): Promise<T> {
  if (typeof event.instanceId !== "string" || !event.instanceId)
    throw new Error("Provider Workflow instance identity required");
  const control = cutoverControl(env);
  const { ticket, epoch } = await step.do("Space cutover admission", async () => {
    const lease = await control.acquire(consumer, CONTENT_CONTRACT_VERSION, {
      kind: "workflow",
      binding,
      instanceId: event.instanceId,
    });
    return { ticket: lease.ticket, epoch: lease.epoch };
  });
  // This check is deliberately not a cached Workflow step.
  await control.assertTicket(ticket, epoch, CONTENT_CONTRACT_VERSION);
  const tasks = cutoverTasks();
  try {
    return await work(tasks.add);
  } finally {
    try {
      await tasks.settle();
    } finally {
      await step.do("Space cutover admission release", () => control.release(ticket));
    }
  }
}

export async function wrapCutoverBackground(
  env: Env,
  consumer: CutoverConsumer,
  ctx: ExecutionContext,
  handler: (context: ExecutionContext) => Promise<void>,
): Promise<void> {
  return withCutoverAdmission(env, consumer, async () => {
    const tracked = trackedContext(ctx);
    try {
      await handler(tracked.context);
    } finally {
      await tracked.settle();
    }
  });
}

/** Methods that never write Artifacts refs or the push log (no GET route does). */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Git smart HTTP (/:space/:repo.git/…): its reads keep tickets all the same. */
const GIT_SMART_HTTP = /\.git(?:\/|$)/;

/**
 * Headers do not finish a Git/registry stream, nor the writes in waitUntil.
 * Under steady admission a read skips the ticket: in an open installation the
 * only ticket reader is the post-open ref barrier (space-cutover/ref-barrier.ts),
 * which waits on live http-git-registry tickets because a push may be between
 * Artifacts accepting it and logging it, and no read route pushes.
 */
export async function wrapCutoverFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  handler: (request: Request, env: Env, context: ExecutionContext) => Promise<Response>,
  timing?: Timing,
): Promise<Response> {
  if (
    READ_METHODS.has(request.method) &&
    !GIT_SMART_HTTP.test(new URL(request.url).pathname) &&
    peekCachedAdmission(env)
  )
    return handler(request, env, ctx);
  const control = cutoverControl(env);
  let ticket: string;
  try {
    const acquired = control.acquire("http-git-registry", CONTENT_CONTRACT_VERSION);
    ({ ticket } = await (timing ? timing.measure("cutover-acquire", acquired) : acquired));
  } catch (error) {
    console.error("Content admission unavailable", error);
    return new Response("Content admission is unavailable. Retry after maintenance completes.", {
      status: 503,
      headers: { "Retry-After": "30", "Cache-Control": "no-store" },
    });
  }
  const tracked = trackedContext(ctx);
  const finish = async () => {
    try {
      await tracked.settle();
    } finally {
      await control.release(ticket);
    }
  };
  let response: Response;
  try {
    response = await handler(request, env, tracked.context);
  } catch (error) {
    await finish();
    throw error;
  }
  if (!response.body) {
    // Upgraded sockets acquire separately on their DO message callbacks.
    ctx.waitUntil(finish());
    return response;
  }
  const reader = response.body.getReader();
  let end!: () => void;
  let ended = false;
  let cancelling = false;
  const bodyDone = new Promise<void>((resolve) => {
    end = resolve;
  });
  const finishBody = () => {
    if (ended || cancelling) return;
    ended = true;
    end();
  };
  ctx.waitUntil(bodyDone.then(finish));
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          finishBody();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        controller.error(error);
        finishBody();
      }
    },
    async cancel(reason) {
      cancelling = true;
      try {
        await reader.cancel(reason);
      } finally {
        cancelling = false;
        finishBody();
      }
    },
  });
  return new Response(body, response);
}
