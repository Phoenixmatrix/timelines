// How model calls reach AI Gateway, and what its logs keep (CORE-213, CORE-290).
//
// Gateway metadata uses the same explicit Space/person/Instance scope as usage.
// Content and personal logging overrides live in distinct tables. Read current
// policy for every call: a warm isolate must not retain revoked body logging.

import { aiLogComponentScope, type AiLogComponent } from "../shared/ai.ts";
import type { UsageScope } from "../shared/usage.ts";
import type { AiWork } from "./usage/ai.ts";
import { isActorCredentialLive } from "./auth.ts";
import { resolveSpaceAccess } from "./spaces/access.ts";
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
  spaces: Map<string, Map<string, boolean>>;
  people: Map<string, Map<string, boolean>>;
}

async function logBodySettings(d1: D1Database): Promise<LogBodySettings> {
  const [site, spaces, people] = await Promise.all([
    db(d1).selectFrom("site_ai_log_bodies").select(["component", "keep"]).execute(),
    db(d1).selectFrom("space_ai_log_bodies").select(["space_id", "component", "keep"]).execute(),
    db(d1)
      .selectFrom("account_ai_log_bodies")
      .select(["account_id", "component", "keep"])
      .execute(),
  ]);
  const settings: LogBodySettings = { site: new Map(), spaces: new Map(), people: new Map() };
  for (const row of site) settings.site.set(row.component, row.keep === 1);
  for (const row of spaces) {
    let choices = settings.spaces.get(row.space_id);
    if (!choices) settings.spaces.set(row.space_id, (choices = new Map()));
    choices.set(row.component, row.keep === 1);
  }
  for (const row of people) {
    let choices = settings.people.get(row.account_id);
    if (!choices) settings.people.set(row.account_id, (choices = new Map()));
    choices.set(row.component, row.keep === 1);
  }
  return settings;
}

/** Only a matching scope's policy may override Instance defaults. */
export function keepsBodies(
  env: object,
  settings: LogBodySettings | null,
  component: AiLogComponent,
  scope?: UsageScope,
): boolean {
  const personal = aiLogComponentScope(component) === "person";
  const override =
    personal && scope?.kind === "person"
      ? settings?.people.get(scope.id)?.get(component)
      : !personal && scope?.kind === "space"
        ? settings?.spaces.get(scope.id)?.get(component)
        : undefined;
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
  work?:
    | Pick<AiWork, "feature" | "personId" | "spaceId" | "providerAuthority">
    | { scope: UsageScope; feature: string; providerAuthority?: AiWork["providerAuthority"] },
) {
  const scope: UsageScope | undefined = work
    ? "scope" in work
      ? work.scope
      : work.personId
        ? { kind: "person", id: work.personId }
        : work.spaceId
          ? { kind: "space", id: work.spaceId }
          : { kind: "instance", id: "" }
    : undefined;
  const metadata: Record<string, string> = { component };
  if (work && scope)
    Object.assign(metadata, { scopeKind: scope.kind, scopeId: scope.id, feature: work.feature });
  const d1 = Reflect.get(env, "DB") as D1Database | undefined;
  let keep = false;
  try {
    let policyScope = scope;
    if (work?.providerAuthority && aiLogComponentScope(SETTING[component]) === "space") {
      const authority = work.providerAuthority;
      if (
        !d1 ||
        scope?.kind !== "person" ||
        authority.actor.id !== scope.id ||
        !(await isActorCredentialLive(d1, authority.actor)) ||
        !(await resolveSpaceAccess(d1, authority.actor, authority.spaceId))
      )
        throw new Error("Content logging policy authority is no longer valid.");
      policyScope = { kind: "space", id: authority.spaceId };
    }
    keep = keepsBodies(env, d1 ? await logBodySettings(d1) : null, SETTING[component], policyScope);
  } catch (error) {
    console.warn("AI Gateway: reading body logging settings failed; not logging bodies", error);
  }
  return {
    gateway: { id: env.AI_GATEWAY, metadata },
    ...(keep ? {} : { extraHeaders: { "cf-aig-collect-log-payload": "false" } }),
  };
}
