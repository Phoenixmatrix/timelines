/** Usage visibility without retaining repository contents or conversations in Gateway logs. */
export function aiGatewayOptions(
  env: Pick<Env, "AI_GATEWAY">,
  component: "knowledge" | "assistant" | "assistant-title" | "assistant-status" | "avatars",
) {
  return {
    gateway: { id: env.AI_GATEWAY, metadata: { component } },
    extraHeaders: { "cf-aig-collect-log-payload": "false" },
  };
}
