type Environment = Record<string, string | undefined>;

/** How to turn paid AI on for the canonical development server. */
export const DEV_AI_OPT_IN = "GITMATRIX_DEV_AI=enabled vp dev";

/** Shared by cf's config evaluator and Vite; never fall back to shared resources in agent mode. */
export function developmentEnvironment(env: Environment) {
  const agentId = env.GITMATRIX_AGENT_ID;
  const agent = agentId !== undefined;
  // Paid AI (Workers AI, AI Gateway, Vectorize, AI Search) is opt-in in
  // development (CORE-284): Knowledge builds of real repositories cost money.
  // An agent environment says which it provisioned; the canonical server
  // binds them only with GITMATRIX_DEV_AI=enabled.
  const ai = agent ? env.GITMATRIX_AGENT_AI === "enabled" : env.GITMATRIX_DEV_AI === "enabled";
  const required = (key: string) => {
    const value = env[key];
    if (!value?.trim()) throw new Error(`Agent mode requires ${key}`);
    return value;
  };
  const port = Number(env.GITMATRIX_PORT ?? 5180);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("GITMATRIX_PORT must be a valid TCP port");
  }
  const host = agent ? "127.0.0.1" : "localhost";
  const publicUrl = env.GITMATRIX_PUBLIC_URL ?? `http://${host}:${port}`;
  const stateDir = env.GITMATRIX_STATE_DIR ?? ".wrangler/state";
  const runnerHomes = {
    XDG_CONFIG_HOME: env.GITMATRIX_RUNNER_CONFIG_HOME ?? env.XDG_CONFIG_HOME,
    XDG_CACHE_HOME: env.GITMATRIX_RUNNER_CACHE_HOME ?? env.XDG_CACHE_HOME,
    XDG_DATA_HOME: env.GITMATRIX_RUNNER_DATA_HOME ?? env.XDG_DATA_HOME,
  };
  if (agent) {
    required("GITMATRIX_AGENT_ID");
    required("GITMATRIX_PORT");
    required("GITMATRIX_PUBLIC_URL");
    if (port === 5180 || publicUrl !== `http://127.0.0.1:${port}`) {
      throw new Error(
        "Agent mode requires a dedicated port and matching loopback GITMATRIX_PUBLIC_URL",
      );
    }
    const state = required("GITMATRIX_STATE_DIR");
    const gm = required("GITMATRIX_GM");
    const suffix = "/apps/cli/target/debug/gm";
    if (!gm.startsWith("/") || !gm.endsWith(suffix) || /\/(?:\.{1,2})?\//.test(gm)) {
      throw new Error("GITMATRIX_GM must be the worktree's debug gm binary");
    }
    const root = gm.slice(0, -suffix.length);
    const base = `${root}/.gitmatrix-agent`;
    if (
      !/^[a-zA-Z0-9_-]+$/.test(agentId!) ||
      (state !== `${base}/state` && state !== `${base}/runs/${agentId}/state`)
    ) {
      throw new Error("GITMATRIX_STATE_DIR must belong to this worktree's exact environment");
    }
    const temporary = required("TMPDIR");
    if (
      !temporary.startsWith("/") ||
      /\/(?:\.{1,2})?\//.test(temporary) ||
      !temporary.endsWith(`/gitmatrix-agent/workspaces/${agentId}/tmp`) ||
      temporary.startsWith(`${root}/`)
    ) {
      throw new Error(
        "TMPDIR must be this environment's owned workspace outside the source checkout",
      );
    }
    const directory = state.slice(0, -"/state".length);
    for (const [key, value] of Object.entries(runnerHomes)) {
      if (!value) throw new Error(`Agent mode requires a scoped runner ${key}`);
      const leaf =
        key === "XDG_CONFIG_HOME" ? "config" : key === "XDG_CACHE_HOME" ? "cache" : "data";
      if (value !== `${directory}/${leaf}`) {
        throw new Error(`${key} must belong to this exact worktree environment`);
      }
    }
    for (const key of [
      "GITMATRIX_ARTIFACTS_NAMESPACE",
      "GITMATRIX_VECTORIZE_INDEX",
      "GITMATRIX_SEARCH_NAMESPACE",
    ]) {
      if (required(key) !== agentId)
        throw new Error(`${key} must match the owned environment resource namespace`);
    }
    if (env.GITMATRIX_AGENT_AI !== "enabled" && env.GITMATRIX_AGENT_AI !== "disabled")
      throw new Error("Agent mode requires GITMATRIX_AGENT_AI=enabled or disabled");
    if (ai && required("GITMATRIX_AI_GATEWAY") !== agentId)
      throw new Error("GITMATRIX_AI_GATEWAY must match the owned environment resource namespace");
    required("GITMATRIX_AGENT_SECRET");
    required("GITMATRIX_CI_DISPATCH_SECRET");
    if (!["local", "sandbox"].includes(env.GITMATRIX_CI_RUNNER ?? ""))
      throw new Error("Agent mode requires an explicit local or sandbox CI runner");
  }
  return { agent, agentId, ai, port, host, publicUrl, stateDir, runnerHomes };
}
