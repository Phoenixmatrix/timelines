export const AGENT_PRESENCE_WINDOW_SECONDS = 600;

export type AgentPresenceTarget = {
  kind: "ci-run" | "deployment" | "commit" | "timeline";
  scopeId: string;
  resourceId: string;
  sourceId: string;
};

export type AgentPresence = {
  agents: Array<{
    id: string;
    name: string;
    accountable: { slug: string; displayName: string };
    lastSeenAt: string;
    expiresAt: string;
  }>;
  asOf: string;
  windowSeconds: number;
  truncated: boolean;
};
