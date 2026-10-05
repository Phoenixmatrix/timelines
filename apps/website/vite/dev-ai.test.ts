// Paid AI is opt-in in development (CORE-284): `vp dev` binds no Workers AI,
// AI Gateway, Vectorize or AI Search unless GITMATRIX_DEV_AI=enabled, while a
// deployed Worker always binds them.

import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import config from "../cloudflare.config.ts";

const AI_BINDINGS = ["AI", "AI_GATEWAY", "VECTORS", "SEARCH"];

async function bindings(mode: string, variables: Record<string, string | undefined> = {}) {
  // Whatever the shell running the tests exported, start from the canonical server.
  for (const key of ["GITMATRIX_AGENT_ID", "GITMATRIX_AGENT_AI", "GITMATRIX_DEV_AI"])
    vi.stubEnv(key, undefined);
  vi.stubEnv("GITMATRIX_CI_RUNNER", "local");
  for (const [key, value] of Object.entries(variables)) vi.stubEnv(key, value);
  const factory = config as unknown as (context: { mode: string; isPreview: boolean }) =>
    | { worker: { env: Record<string, unknown> } }
    | Promise<{
        worker: { env: Record<string, unknown> };
      }>;
  return Object.keys((await factory({ mode, isPreview: false })).worker.env);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("AI bindings in development", () => {
  test("the dev server binds no AI without the opt-in", async () => {
    const bound = await bindings("development");
    for (const name of AI_BINDINGS) expect(bound).not.toContain(name);
    // Everything else still binds: the app runs, with its AI-off states.
    expect(bound).toEqual(expect.arrayContaining(["DB", "ARTIFACTS", "KNOWLEDGE_BUILD"]));
    for (const value of ["1", "true", "disabled"])
      expect(await bindings("development", { GITMATRIX_DEV_AI: value })).not.toContain("AI");
  });

  test("GITMATRIX_DEV_AI=enabled binds them", async () => {
    expect(await bindings("development", { GITMATRIX_DEV_AI: "enabled" })).toEqual(
      expect.arrayContaining(AI_BINDINGS),
    );
  });

  test("gateway logs keep bodies by default in development, never once deployed (CORE-290)", async () => {
    vi.stubEnv("GITMATRIX_CONTAINER_IMAGES", "skip");
    const factory = config as unknown as (context: {
      mode: string;
      isPreview: boolean;
    }) => Promise<{ worker: { env: Record<string, unknown> } }>;
    const value = async (mode: string) =>
      JSON.stringify((await factory({ mode, isPreview: false })).worker.env.AI_LOG_BODIES);
    expect(await value("development")).toMatch(/"on"/);
    expect(await value("production")).toMatch(/"off"/);
  });

  test("a deployed Worker always binds them", async () => {
    vi.stubEnv("GITMATRIX_CONTAINER_IMAGES", "skip");
    expect(await bindings("production")).toEqual(expect.arrayContaining(AI_BINDINGS));
  });
});
