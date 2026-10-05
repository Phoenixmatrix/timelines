/**
 * Usage visibility without retaining repository contents or conversations in
 * Gateway logs. `work` labels a log with the account id and feature its call
 * is recorded under in ai_usage, so the two reconcile (CORE-285).
 */
export function aiGatewayOptions(
  env: Pick<Env, "AI_GATEWAY">,
  component: "knowledge" | "assistant" | "assistant-title" | "assistant-status" | "avatars",
  work?: { account: string; feature: string },
) {
  const metadata: Record<string, string> = { component };
  if (work) Object.assign(metadata, { account: work.account, feature: work.feature });
  return {
    gateway: { id: env.AI_GATEWAY, metadata },
    extraHeaders: { "cf-aig-collect-log-payload": "false" },
  };
}
