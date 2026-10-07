export type GmWork = {
  key: string;
  title: string;
  status: string;
  priority: number | null;
  /** Who holds the claim when it is not this checkout's agent. */
  claimedBy: string | null;
  leaseExpiresAt: string | null;
  timeline: string | null;
  checkpoint: string | null;
  /** Other in-progress issues this agent also holds a claim on. */
  otherClaims: number;
};

export type GmSnapshot = {
  work: GmWork | null;
  error: string | null;
  fetchedAt: number;
};

declare module "claude-code" {
  interface PluginState {
    "gitmatrix-work": {
      isShown: boolean;
      snapshot: GmSnapshot | null;
      focusKey: string | null;
    };
  }
}
