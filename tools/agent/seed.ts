import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { MutationRequest } from "../../apps/website/shared/tracker.ts";
import type { HarnessContext, Persona, SeedManifest } from "./types.ts";

const exec = promisify(execFile);
const personas: Persona[] = ["priya", "marco", "jun", "sam"];
const repos: SeedManifest["repos"] = [
  { space: "orbit", name: "engine", visibility: "private" },
  { space: "orbit", name: "website", visibility: "public" },
  { space: "marco", name: "hello-world", visibility: "public" },
  { space: "sam", name: "notes", visibility: "private" },
];
const tracker: SeedManifest["tracker"] = {
  space: "orbit",
  team: "agent-team",
  ready: "agent-ready",
  blocked: "agent-blocked",
  blocker: "agent-blocker",
};
interface Journal {
  id: string;
  origin: string;
  tokens: Partial<Record<Persona, string>>;
  readToken?: string;
}

class SeedApiError extends Error {
  readonly status: number;
  constructor(path: string, status: number) {
    super(`Seed API ${path} failed (${status}).`);
    this.status = status;
  }
}

async function privateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

/** Bootstrap only the explicitly identified worktree service; no global CLI state. */
export async function seed(ctx: HarnessContext): Promise<SeedManifest> {
  const id = ctx.env.GITMATRIX_AGENT_ID;
  const secret = ctx.env.GITMATRIX_AGENT_SECRET ?? "";
  const url = new URL(ctx.origin);
  if (
    !id ||
    !secret ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.port === "5180"
  )
    throw new Error("Seeding requires an identified, non-canonical loopback environment.");
  const base = join(resolve(ctx.root), ".gitmatrix-agent");
  const directory = resolve(ctx.dir);
  if (
    !/^[a-zA-Z0-9_-]+$/.test(id) ||
    resolve(ctx.gm) !== join(resolve(ctx.root), "apps/cli/target/debug/gm") ||
    (directory !== base && directory !== join(base, "runs", id)) ||
    ctx.env.XDG_CONFIG_HOME !== join(directory, "config")
  )
    throw new Error("Seed paths must belong to this exact worktree environment.");
  const { tokens, readToken } = await seedFixtures({
    id,
    secret,
    origin: ctx.origin,
    gm: ctx.gm,
    dir: ctx.dir,
    work: ctx.work,
    env: ctx.env,
  });
  const manifest: SeedManifest = {
    version: 4,
    origin: ctx.origin,
    tokens,
    readToken,
    repos,
    tracker,
  };
  await privateJson(join(ctx.dir, "seed.json"), manifest);
  const configDirectory = join(directory, "config", "gitmatrix");
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await privateJson(join(configDirectory, "gm.json"), {
    server: ctx.origin,
    token: tokens.priya,
    user: "priya",
  });
  return manifest;
}

/**
 * A server to reconcile the fixtures against: one that runs with DEV_MODE and
 * reports `id` from /api/dev/environment, which it guards with `secret` (its
 * AGENT_ID and AGENT_SECRET). The agent harness's loopback environments are
 * one; timeline previews (tools/preview) are the other.
 */
export interface FixtureTarget {
  id: string;
  secret: string;
  origin: string;
  /** The gm executable that clones and pushes the fixture repositories. */
  gm: string;
  /** Private state: the token journal, and gm's config, cache and data. */
  dir: string;
  /** Where disposable clones go. */
  work: string;
  env: NodeJS.ProcessEnv;
  /** Sent with every API request, e.g. Cloudflare Access service-token headers. */
  headers?: Record<string, string>;
}

/**
 * Reconcile the deterministic fixtures, idempotently: persona tokens, the
 * sample repositories with their pinned contents, and the tracker fixtures.
 */
export async function seedFixtures(
  ctx: FixtureTarget,
): Promise<{ tokens: Record<Persona, string>; readToken: string }> {
  const { id, secret } = ctx;
  async function request<T>(path: string, token: string, body?: unknown): Promise<T> {
    const response = await fetch(`${ctx.origin}/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...ctx.headers,
        "X-Gitmatrix-Content-Version": "4",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120_000),
      redirect: "error",
    });
    // Never include response bodies: token bootstrap replies contain credentials.
    if (!response.ok) throw new SeedApiError(path, response.status);
    return (await response.json()) as T;
  }
  const identity = await request<{ id: string; ready: boolean; fixtures: boolean }>(
    "/dev/environment",
    secret,
  );
  if (identity.id !== id || !identity.ready)
    throw new Error("Seed server identity or database readiness does not match this worktree.");
  await mkdir(ctx.dir, { recursive: true, mode: 0o700 });
  const journalPath = join(ctx.dir, "seed-state.json");
  let journal: Journal = { id, origin: ctx.origin, tokens: {} };
  try {
    const saved = JSON.parse(await readFile(journalPath, "utf8")) as Journal;
    if (saved.id !== id || saved.origin !== ctx.origin)
      throw new Error("Saved seed belongs to another environment.");
    journal = saved;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  async function validToken(
    token: string | undefined,
    persona: Persona,
    scope: "read" | "write",
  ): Promise<boolean> {
    if (!token) return false;
    try {
      const session = await request<{ viewer: { slug: string } | null }>("/session", token);
      if (session.viewer?.slug !== persona) return false;
      const listing = await request<{
        tokens: { scope: string; lastFour: string; name: string }[];
      }>("/tokens", token);
      return listing.tokens.some(
        (entry) =>
          entry.scope === scope &&
          entry.lastFour === token.slice(-4) &&
          entry.name === `agent-${id}-${scope}`,
      );
    } catch (error) {
      if (error instanceof SeedApiError && error.status === 401) return false;
      throw error;
    }
  }
  async function tokenFor(
    persona: Persona,
    scope: "read" | "write",
    previous?: string,
  ): Promise<string> {
    if (await validToken(previous, persona, scope)) return previous!;
    return (
      await request<{ secret: string }>("/dev/tokens", secret, {
        persona,
        scope,
        name: `agent-${id}-${scope}`,
      })
    ).secret;
  }
  for (const persona of personas) {
    journal.tokens[persona] = await tokenFor(persona, "write", journal.tokens[persona]);
    await privateJson(journalPath, journal);
  }
  journal.readToken = await tokenFor("marco", "read", journal.readToken);
  await privateJson(journalPath, journal);
  const tokens = journal.tokens as Record<Persona, string>;
  await request("/dev/seed", secret, {});

  // Each attempt clones from the real service. Interrupted pushes are recovered by
  // examining the remote contents, not by trusting a local completion marker.
  // The repositories are independent (own clone directory, own env copy), so they run
  // concurrently; every settled result is awaited before the first failure is rethrown,
  // so no clone is still running when the caller tears the environment down.
  const pushed = await Promise.allSettled(
    repos.map(async (repo) => {
      const directory = await mkdtemp(join(ctx.work, "seed-clone-"));
      const token = repo.space === "sam" ? tokens.sam : tokens.marco;
      const env = { ...ctx.env };
      for (const key of Object.keys(env)) {
        if (
          key.startsWith("GIT_CONFIG_") ||
          key.startsWith("GITMATRIX_TOKEN") ||
          key === "SSH_AUTH_SOCK" ||
          key === "GM_TOKEN"
        )
          delete env[key];
      }
      Object.assign(env, {
        GM_SERVER: ctx.origin,
        GM_TOKEN: token,
        XDG_CONFIG_HOME: join(ctx.dir, "config"),
        XDG_CACHE_HOME: join(ctx.dir, "cache"),
        XDG_DATA_HOME: join(ctx.dir, "data"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "Gitmatrix Fixtures",
        GIT_AUTHOR_EMAIL: "fixtures@gitmatrix.invalid",
        GIT_COMMITTER_NAME: "Gitmatrix Fixtures",
        GIT_COMMITTER_EMAIL: "fixtures@gitmatrix.invalid",
        GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      });
      async function gm(args: string[], cwd: string): Promise<void> {
        try {
          await exec(ctx.gm, args, { cwd, env, timeout: 120_000, maxBuffer: 1024 * 1024 });
        } catch {
          throw new Error(
            `Seed gm ${args[0]} failed for ${repo.space}/${repo.name}; credentials and child output withheld.`,
          );
        }
      }
      try {
        const checkout = join(directory, "repo");
        await gm(["clone", `${repo.space}/${repo.name}`, checkout], directory);
        const contents = `# ${repo.space}/${repo.name}\n\nDeterministic Gitmatrix agent fixture, version 1.\n`;
        let existing: string | undefined;
        try {
          existing = await readFile(join(checkout, "README.md"), "utf8");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        if (existing !== contents) {
          if (existing !== undefined)
            throw new Error(
              `Fixture ${repo.space}/${repo.name} has unexpected contents; refusing to overwrite.`,
            );
          await writeFile(join(checkout, "README.md"), contents);
          await gm(["commit", "-m", "Seed deterministic agent fixture"], checkout);
          await gm(["push"], checkout);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }),
  );
  for (const result of pushed) if (result.status === "rejected") throw result.reason;
  const scope = await request<{ contractVersion: 4; spaceId: string; migrationEpoch: number }>(
    "/tracker/orbit/snapshot",
    tokens.marco,
  );
  const mutation: MutationRequest = {
    contractVersion: scope.contractVersion,
    spaceId: scope.spaceId,
    migrationEpoch: scope.migrationEpoch,
    operationId: "agent-fixtures-v1",
    mutations: [
      {
        kind: "team.create",
        id: tracker.team,
        data: { key: "AGENT", name: "Agent fixtures", memberIds: ["acc_marco", "acc_jun"] },
      },
      {
        kind: "issue.create",
        id: tracker.ready,
        data: { teamId: tracker.team, title: "Agent ready fixture", status: "todo" },
      },
      {
        kind: "issue.create",
        id: tracker.blocker,
        data: { teamId: tracker.team, title: "Agent blocker fixture", status: "todo" },
      },
      {
        kind: "issue.create",
        id: tracker.blocked,
        data: { teamId: tracker.team, title: "Agent blocked fixture", status: "todo" },
      },
      {
        kind: "issue.create",
        id: "agent-done",
        data: { teamId: tracker.team, title: "Agent done fixture", status: "done" },
      },
      {
        kind: "link.add",
        id: "agent-blocking-link",
        data: { fromId: tracker.blocker, toId: tracker.blocked, kind: "blocks" },
      },
    ],
  };
  // The tracker applies the batch atomically and deduplicates this exact receipt.
  await request("/tracker/orbit/mutate", tokens.marco, mutation);
  return { tokens, readToken: journal.readToken };
}
