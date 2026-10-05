// Workers AI calls and tokens per account (CORE-207). Work that runs models
// for an account declares it once, at its entry point, with `aiWork`; every
// model call underneath (worker/knowledge/models.ts, the assistant, avatars)
// then records itself into ai_usage, per UTC day, account, feature and model.
// A call outside any declared work is recorded under account '' (site).
// Recording never throws and never fails the call it describes.
//
// AsyncLocalStorage doesn't follow a Workflow's `step.do` callbacks: the
// runtime calls them from outside the context `run` set up. Workflows re-enter
// it in each step (worker/knowledge/paid-steps.ts), or their calls land under
// the site as `unattributed` (CORE-285).

import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "../schema.ts";

export interface AiWork {
  /** What the calls are for: knowledge, wiki, release_notes, assistant, search, avatars… */
  feature: string;
  account?: string | null;
  /** The repository, when the account isn't known up front (its owner is looked up once). */
  repo?: string | null;
  /**
   * Also told of every call, after it is recorded (a Knowledge build meters
   * itself, CORE-286). Never throws into the call it describes.
   */
  onCall?: (
    model: string,
    usage: { calls: number; failed: number; input: number; output: number; total: number },
  ) => unknown;
}

interface Context extends AiWork {
  owner?: Promise<string>;
}

const current = new AsyncLocalStorage<Context>();

/** Run `work` with its model calls attributed to `context`. */
export function aiWork<T>(context: AiWork, work: () => T): T {
  return current.run({ ...context }, work);
}

/**
 * Who the current work is for, resolved: the account id ('' for the site) and
 * feature. Model calls label their AI Gateway logs with it, so the gateway and
 * ai_usage can be reconciled per account and feature.
 */
export async function attribution(env: Env): Promise<{ account: string; feature: string }> {
  const context = current.getStore();
  // Without a database there's nothing to look the owner up in (nor record to).
  const recorded = Boolean(Reflect.get(env, "DB"));
  return {
    account: recorded ? await accountOf(env, context).catch(() => "") : (context?.account ?? ""),
    feature: context?.feature ?? "unattributed",
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

async function accountOf(env: Env, context: Context | undefined): Promise<string> {
  if (!context) return "";
  if (context.account) return context.account;
  if (!context.repo) return "";
  context.owner ??= db(env.DB)
    .selectFrom("repos")
    .select("owner_id")
    .where("id", "=", context.repo)
    .executeTakeFirst()
    .then((row) => row?.owner_id ?? "")
    .catch(() => "");
  return context.owner;
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
    const account = await accountOf(env, context);
    const input = Math.round(tokens.input ?? 0);
    const output = Math.round(tokens.output ?? 0);
    const total = Math.round(tokens.total ?? input + output);
    await d1
      .prepare(
        `INSERT INTO ai_usage (day, account_id, feature, model, calls, input_tokens, output_tokens, total_tokens, failed_calls)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT (day, account_id, feature, model) DO UPDATE SET
           calls = calls + excluded.calls,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           total_tokens = total_tokens + excluded.total_tokens,
           failed_calls = failed_calls + excluded.failed_calls`,
      )
      .bind(
        (options.at ?? new Date()).toISOString().slice(0, 10),
        account,
        context?.feature ?? "unattributed",
        model,
        options.failed ? 0 : (options.calls ?? 1),
        input,
        output,
        total,
        options.failed ? (options.calls ?? 1) : 0,
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
