import type { WorkflowStep } from "cloudflare:workers";
import type { CUTOVER_CONSUMERS, SpaceCutover } from "../space-cutover/control.ts";
import { CONTENT_CONTRACT_VERSION } from "../../shared/spaces.ts";
import type { Timing } from "../timing.ts";

export type CutoverConsumer = (typeof CUTOVER_CONSUMERS)[number];

/** Instance control is deliberately outside the restorable business registry. */
export function cutoverControl(env: Env): DurableObjectStub<SpaceCutover> {
  const namespace = Reflect.get(env, "SPACE_CUTOVER") as
    | DurableObjectNamespace<SpaceCutover>
    | undefined;
  if (!namespace) throw new Error("Missing independent Space cutover control binding");
  return namespace.getByName("instance");
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

/** Headers do not finish a Git/registry stream, nor the writes in waitUntil. */
export async function wrapCutoverFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  handler: (request: Request, env: Env, context: ExecutionContext) => Promise<Response>,
  timing?: Timing,
): Promise<Response> {
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
