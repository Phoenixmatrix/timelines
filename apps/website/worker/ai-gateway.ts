// How model calls reach AI Gateway, and what its logs keep (CORE-213, CORE-290).
//
// Every call is labelled with its component, and with the account and feature
// its usage is recorded under in ai_usage (CORE-285), so the gateway's logs
// and ai_usage reconcile. The logs always keep metadata (model, time, tokens);
// they keep request and response bodies only where "Keep AI request and
// response bodies in gateway logs" is on for the call's component and account:
// the account's override, else the site default, else the environment's
// default (AI_LOG_BODIES: off once deployed, on in development). Where it's
// off each call says so with `cf-aig-collect-log-payload: false`.
//
// The settings are read once a minute per isolate (one small query for every
// component and account), never per call; changes made here apply at once.

import type { AiLogComponent } from "../shared/ai.ts";
import { db } from "./schema.ts";

/** The labels calls carry in the gateway's logs, and the setting each follows. */
const SETTING = {
  knowledge: "knowledge",
  assistant: "assistant",
  "assistant-title": "assistant-titles",
  "assistant-status": "assistant-titles",
  avatars: "avatars",
  "release-notes": "release-notes",
  // Highlights (CORE-359) keep their own label and follow the release notes setting.
  "release-highlights": "release-notes",
  // Custom release notes written on demand (CORE-151) follow it too.
  "release-notes-compose": "release-notes",
  "merge-queue": "merge-queue",
} as const satisfies Record<string, AiLogComponent>;

export type GatewayComponent = keyof typeof SETTING;

/** Which component a call made for `feature` (worker/usage/ai.ts) belongs to. */
export function componentOf(feature: string): GatewayComponent {
  switch (feature) {
    case "assistant":
      return "assistant";
    case "release_notes":
      return "release-notes";
    case "release_highlights":
      return "release-highlights";
    case "release_notes_compose":
      return "release-notes-compose";
    case "merge_queue":
      return "merge-queue";
    case "avatars":
      return "avatars";
    default:
      // knowledge, wiki, knowledge_overlay, search, Atlas, unattributed.
      return "knowledge";
  }
}

/** This environment's default, when the site hasn't chosen. */
export function environmentKeepsBodies(env: object): boolean {
  return Reflect.get(env, "AI_LOG_BODIES") === "on";
}

export interface LogBodySettings {
  site: Map<string, boolean>;
  accounts: Map<string, Map<string, boolean>>;
}

const CACHE_MS = 60_000;
const cache = new WeakMap<object, { at: number; settings: Promise<LogBodySettings> }>();

async function read(d1: D1Database): Promise<LogBodySettings> {
  const [site, accounts] = await Promise.all([
    db(d1).selectFrom("site_ai_log_bodies").select(["component", "keep"]).execute(),
    db(d1)
      .selectFrom("account_ai_log_bodies")
      .select(["account_id", "component", "keep"])
      .execute(),
  ]);
  const settings: LogBodySettings = { site: new Map(), accounts: new Map() };
  for (const row of site) settings.site.set(row.component, row.keep === 1);
  for (const row of accounts) {
    let account = settings.accounts.get(row.account_id);
    if (!account) settings.accounts.set(row.account_id, (account = new Map()));
    account.set(row.component, row.keep === 1);
  }
  return settings;
}

/** Every stored choice, from this isolate's copy when it is under a minute old. */
export function logBodySettings(d1: D1Database, now = Date.now()): Promise<LogBodySettings> {
  const cached = cache.get(d1);
  if (cached && now - cached.at < CACHE_MS) return cached.settings;
  const settings = read(d1);
  cache.set(d1, { at: now, settings });
  // A failed read isn't kept: the next call asks again.
  settings.catch(() => {
    if (cache.get(d1)?.settings === settings) cache.delete(d1);
  });
  return settings;
}

/** After a change: this isolate's next call reads the settings again. */
export function forgetLogBodySettings(d1: D1Database) {
  cache.delete(d1);
}

/** The effective setting for one component and account ('' or none: the site's). */
export function keepsBodies(
  env: object,
  settings: LogBodySettings | null,
  component: AiLogComponent,
  account?: string | null,
): boolean {
  const override = account ? settings?.accounts.get(account)?.get(component) : undefined;
  return override ?? settings?.site.get(component) ?? environmentKeepsBodies(env);
}

/**
 * The gateway options for one model call: its log labels, and the header
 * that drops bodies from the log where body logging is off. Never throws: if
 * the settings can't be read, bodies are dropped.
 */
export async function aiGatewayOptions(
  env: Pick<Env, "AI_GATEWAY">,
  component: GatewayComponent,
  work?: { account?: string | null; feature: string },
) {
  const metadata: Record<string, string> = { component };
  if (work) Object.assign(metadata, { account: work.account ?? "", feature: work.feature });
  const d1 = Reflect.get(env, "DB") as D1Database | undefined;
  let keep = false;
  try {
    keep = keepsBodies(
      env,
      d1 ? await logBodySettings(d1) : null,
      SETTING[component],
      work?.account,
    );
  } catch (error) {
    console.warn("AI Gateway: reading body logging settings failed; not logging bodies", error);
  }
  return {
    gateway: { id: env.AI_GATEWAY, metadata },
    ...(keep ? {} : { extraHeaders: { "cf-aig-collect-log-payload": "false" } }),
  };
}
