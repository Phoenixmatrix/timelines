import type { Browser } from "@playwright/test";

export interface HarnessContext {
  root: string;
  dir: string;
  /** Disposable product clones outside the source checkout. */
  work: string;
  origin: string;
  gm: string;
  env: NodeJS.ProcessEnv;
  artifacts: string;
}

export type Persona = "priya" | "marco" | "jun" | "sam";

export interface SeedManifest {
  version: 4;
  origin: string;
  tokens: Record<Persona, string>;
  readToken: string;
  repos: { space: string; name: string; visibility: "public" | "private" }[];
  tracker: { space: string; team: string; ready: string; blocked: string; blocker: string };
}

/**
 * A scenario's view of the one browser the E2E run shares: its contexts are its
 * own, and close() closes them, never the browser.
 */
export interface ScenarioBrowser {
  newContext: Browser["newContext"];
  close(): Promise<void>;
}
