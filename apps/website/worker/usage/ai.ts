// AI calls are attributed independently to a Space, person or the Instance.
// A repository always resolves its immutable Space; person identity is never
// interpreted as content ownership, even when migration preserves equal IDs.
// When the work knows them, each call also records the person, agent and
// timeline it was for (CORE-222): attribution within that scope, not ownership.
// Recording never throws and never fails the call it describes.
//
// AsyncLocalStorage doesn't follow a Workflow's `step.do` callbacks: the
// runtime calls them from outside the context `run` set up. Workflows re-enter
// it in each step (worker/knowledge/paid-steps.ts), or their calls land under
// the site as `unattributed` (CORE-285).

import { AsyncLocalStorage } from "node:async_hooks";
import type { UsageScope } from "../../shared/usage.ts";
import type { Actor } from "../db.ts";
import { db } from "../schema.ts";

export interface AiWork {
  /** What the calls are for: knowledge, wiki, release_notes, assistant, search, avatars… */
  feature: string;
  spaceId?: string | null;
  personId?: string | null;
  /** Resolve repository work to its current immutable Space. */
  repo?: string | null;
  /** Explicit, separately authorized policy Space for personal aggregate work. */
  providerAuthority?: { spaceId: string; actor: Actor };
  /**
   * Who asked, when one person or agent did (CORE-222): the person (an agent's
   * accountable person), the agent acting for them, and the timeline the work
   * is for. Work that serves several people at once (a build batching pushes)
   * leaves them unset and counts as not attributed.
   */
  actor?: string | null;
  agent?: string | null;
  timeline?: string | null;
  /**
   * Also told of every call, after it is recorded (a Knowledge build meters
   * itself, CORE-286). Never throws into the call it describes.
   */
  onCall?: (
    model: string,
    usage: { calls: number; failed: number; input: number; output: number; total: number },
  ) => unknown;
}

type Context = AiWork;

const current = new AsyncLocalStorage<Context>();

/** Run `work` with its model calls attributed to `context`. */
export function aiWork<T>(context: AiWork, work: () => T): T {
  return current.run({ ...context }, work);
}

/** Current attribution is metadata, not authorization to use a provider. */
export async function attribution(env: Env): Promise<{
  scope: UsageScope;
  feature: string;
  providerAuthority?: { spaceId: string; actor: Actor };
}> {
  const context = current.getStore();
  return {
    scope: await scopeOf(env, context),
    feature: context?.feature ?? "unattributed",
    ...(context?.providerAuthority ? { providerAuthority: context.providerAuthority } : {}),
  };
}

/** The usage a provider reported, in whichever shape it uses. */
export interface AiTokens {
  input?: number;
  output?: number;
  total?: number;
}

/** Tokens from a Workers AI result (OpenAI-shaped `usage`, or none). */
export function tokensOf(result: unknown): AiTokens {
  const usage = (result as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage || typeof usage !== "object") return {};
  const number = (value: unknown) => (typeof value === "number" && value >= 0 ? value : undefined);
  return {
    input: number(usage.prompt_tokens ?? usage.inputTokens ?? usage.input_tokens),
    output: number(usage.completion_tokens ?? usage.outputTokens ?? usage.output_tokens),
    total: number(usage.total_tokens ?? usage.totalTokens),
  };
}

async function scopeOf(env: Env, context: Context | undefined): Promise<UsageScope> {
  if (!context) return { kind: "instance", id: "" };
  if (context.personId && (context.spaceId || context.repo))
    throw new Error("AI work cannot mix personal and content attribution.");
  if (context.repo) {
    const row = await db(env.DB)
      .selectFrom("repos")
      .select("space_id")
      .where("id", "=", context.repo)
      .executeTakeFirst();
    if (!row?.space_id) throw new Error("AI work repository has no active Space.");
    if (context.spaceId && context.spaceId !== row.space_id)
      throw new Error("AI work repository does not belong to the declared Space.");
    return { kind: "space", id: row.space_id };
  }
  if (context.spaceId) return { kind: "space", id: context.spaceId };
  if (context.personId) return { kind: "person", id: context.personId };
  return { kind: "instance", id: "" };
}

/**
 * Record one model call (or `calls` of them), or with `failed` an attempt
 * that returned nothing (an error, a timeout, a stopped build). Never throws.
 */
export async function recordAiCall(
  env: Env,
  model: string,
  tokens: AiTokens,
  options: { calls?: number; failed?: boolean; work?: AiWork; at?: Date } = {},
): Promise<void> {
  try {
    const d1 = Reflect.get(env, "DB") as D1Database | undefined;
    if (!d1) return;
    const context = options.work ? { ...options.work } : current.getStore();
    const scope = await scopeOf(env, context);
    const input = Math.round(tokens.input ?? 0);
    const output = Math.round(tokens.output ?? 0);
    const total = Math.round(tokens.total ?? input + output);
    await d1
      .prepare(
        `INSERT INTO ai_usage (day, scope_kind, scope_id, feature, model, calls, input_tokens, output_tokens, total_tokens, failed_calls,
           actor_id, agent_id, timeline)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT (day, scope_kind, scope_id, feature, model, actor_id, agent_id, timeline) DO UPDATE SET
           calls = calls + excluded.calls,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           total_tokens = total_tokens + excluded.total_tokens,
           failed_calls = failed_calls + excluded.failed_calls`,
      )
      .bind(
        (options.at ?? new Date()).toISOString().slice(0, 10),
        scope.kind,
        scope.id,
        context?.feature ?? "unattributed",
        model,
        options.failed ? 0 : (options.calls ?? 1),
        input,
        output,
        total,
        options.failed ? (options.calls ?? 1) : 0,
        context?.actor ?? "",
        context?.agent ?? "",
        context?.timeline ?? "",
      )
      .run();
    const calls = options.calls ?? 1;
    await context?.onCall?.(model, {
      calls: options.failed ? 0 : calls,
      failed: options.failed ? calls : 0,
      input,
      output,
      total,
    });
  } catch (error) {
    console.warn("Usage: recording an AI call failed", model, error);
  }
}
