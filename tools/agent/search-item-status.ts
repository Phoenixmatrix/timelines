import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { command, validateEnvironment, type Environment } from "./environment.ts";
import type { IndexedItem } from "./index-visibility.ts";
import type { HarnessContext } from "./types.ts";

/** Read only the exact fixture item in this invocation's owned namespace. */
export async function searchItemStatus(ctx: HarnessContext, key: string) {
  const env = JSON.parse(await readFile(join(ctx.dir, "environment.json"), "utf8")) as Environment;
  validateEnvironment(env);
  if (
    env.root !== ctx.root ||
    env.dir !== ctx.dir ||
    env.id !== ctx.env.GITMATRIX_SEARCH_NAMESPACE ||
    env.id !== ctx.env.GITMATRIX_AGENT_ID ||
    env.status !== "ready" ||
    env.resources.search !== "created"
  )
    throw new Error("Item status requires this invocation's owned AI Search namespace");
  return async (remainingMs: number): Promise<IndexedItem | null> => {
    const output = await command(
      "cf",
      [
        "ai-search",
        "items",
        "list",
        "--name",
        env.id,
        "--id",
        "knowledge",
        "--key",
        key,
        "--source",
        "builtin",
        ...(env.profile ? ["--profile", env.profile] : []),
      ],
      {
        // cf credentials belong to the host; product HOME/XDG remains isolated.
        env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: env.account },
        timeout: Math.min(30_000, remainingMs),
      },
    );
    const items: IndexedItem[] = JSON.parse(output);
    if (!Array.isArray(items) || items.length > 1)
      throw new Error("Exact item lookup returned an unexpected response");
    const item = items[0];
    if (!item) return null;
    if (typeof item.id !== "string" || item.key !== key || typeof item.status !== "string")
      throw new Error("Exact item lookup returned invalid identity or status");
    return { id: item.id, key: item.key, status: item.status };
  };
}
