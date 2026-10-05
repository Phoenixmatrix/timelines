import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect as playwrightExpect } from "@playwright/test";
import type { HarnessContext, SeedManifest } from "./types.ts";
import type { AiSettingsView, AiSnapshot } from "../../apps/website/shared/ai.ts";
import type {
  AssistantSkillInvocation,
  PersonalAssistantSkill,
} from "../../apps/website/shared/assistant-skills.ts";
import type { CodeSource, SourceSnapshot } from "../../apps/website/shared/code-source.ts";
import type { Landing } from "../../apps/website/shared/timelines.ts";
import type {
  ReleaseFeed,
  ReleaseNoteEntry,
  ReleaseNotesIndex,
  ReleaseNotesRelease,
} from "../../apps/website/shared/release-notes.ts";
import { waitForIndexVisibility, type VisibilityReport } from "./index-visibility.ts";
import { searchItemStatus } from "./search-item-status.ts";
import { runAtlasProviderE2E } from "./atlas-provider-e2e.ts";
import { command, validateEnvironment, type Environment } from "./environment.ts";
import { runQueueAiE2E } from "./queue-ai-e2e.ts";
import { collectGatewayLogs, reconcileUsage, type UsageRow } from "./usage-reconciliation.ts";
import type { Outcome, Selection, StageDefinition } from "./ai-stages.ts";

const WORKER = "apps/website/worker";
const SRC = "apps/website/src";
const SHARED = "apps/website/shared";
const KNOWLEDGE = `${WORKER}/knowledge/**`;
const HARNESS = "tools/agent/provider-e2e.ts";

/**
 * The Copper Finch stages of `vp run agent test-ai`, in execution order, and
 * the changed paths that run each (ai-stages.ts selects them). Each runs with
 * every real assertion it always had; `requires` names the stages whose state
 * it builds on (commits pushed, a build indexed), which run first.
 */
export const COPPER_FINCH_STAGES = [
  {
    id: "knowledge",
    covers:
      "AI settings admission and the running build's immutable policy; the knowledge build, graph and generated wiki overview; Gateway knowledge and embedding records",
    requires: [],
    paths: [
      HARNESS,
      KNOWLEDGE,
      // Metering and Gateway labels: the stage reconciles them (CORE-285).
      `${WORKER}/usage/ai.ts`,
      `${WORKER}/ai-gateway.ts`,
      "tools/agent/usage-reconciliation.ts",
      `${WORKER}/git/effects.ts`,
      `${SRC}/components/KnowledgeStatus.tsx`,
      `${SRC}/routes/repo/KnowledgeBar.tsx`,
      `${SRC}/routes/repo/Wiki.tsx`,
    ],
  },
  {
    id: "search",
    covers:
      "Embeddings in Vectorize and AI Search passages becoming visible; repository isolation; the palette's code and wiki search",
    requires: ["knowledge"],
    paths: [
      HARNESS,
      KNOWLEDGE,
      `${WORKER}/search/**`,
      `${SRC}/palette/**`,
      `${SRC}/lib/knowledgeSearch.ts`,
      `${SHARED}/search.ts`,
      "tools/agent/index-visibility.ts",
      "tools/agent/search-item-status.ts",
    ],
  },
  {
    id: "assistant",
    covers:
      "A real assistant turn answered from the index; personal slash-skill creation, private instructions and persisted receipts; approval-gated writes, follow-ups, retry and redirect; status between steps; Gateway assistant records",
    requires: ["search"],
    paths: [
      HARNESS,
      `${WORKER}/assistant/**`,
      `${WORKER}/api/assistant.ts`,
      `${WORKER}/api/personal-skills.ts`,
      `${WORKER}/knowledge/api.ts`,
      `${WORKER}/knowledge/indexes.ts`,
      `${SRC}/assistant/**`,
      `${SRC}/routes/AssistantSkills.tsx`,
      `${SHARED}/assistant.ts`,
      `${SHARED}/assistant-skills.ts`,
      "apps/website/migrations/*_assistant_personal_skills.sql",
    ],
  },
  {
    id: "avatars",
    covers: "Real avatar generation within its ten-call Gateway budget",
    requires: [],
    paths: [HARNESS, `${WORKER}/avatars/**`, `${SRC}/routes/AvatarEditor.tsx`],
  },
  {
    id: "knowledge-edit",
    covers:
      "An edit's incremental rebuild, re-analysis and concept naming; the successor build's settings; a disabled wiki kept readable",
    requires: ["knowledge"],
    paths: [HARNESS, KNOWLEDGE],
  },
  {
    id: "release-notes",
    covers:
      "Daily notes and their rollover, a named tag, a tracker issue's entry and the team feed",
    requires: ["knowledge-edit"],
    paths: [
      HARNESS,
      `${WORKER}/release-notes/**`,
      `${WORKER}/git/effects.ts`,
      `${SHARED}/release-notes.ts`,
      `${SRC}/routes/repo/Releases.tsx`,
      `${SRC}/routes/tracker/Releases.tsx`,
      `${SRC}/components/ReleaseNoteDetails.tsx`,
    ],
  },
  {
    id: "overlays",
    covers: "A timeline bookmark's knowledge overlay across two pushes, leaving main untouched",
    requires: ["knowledge-edit"],
    paths: [HARNESS, KNOWLEDGE, `${WORKER}/timelines/**`, `${SRC}/routes/repo/TimelineOverlay.tsx`],
  },
  {
    id: "timeline-pages",
    covers:
      "A checkpoint's wiki pages for a tracked timeline, leaving main untouched; its compact landing's release notes",
    // Compact landing purges and regenerates release notes, which only that stage turns on.
    requires: ["knowledge-edit", "release-notes"],
    paths: [
      HARNESS,
      KNOWLEDGE,
      `${WORKER}/timelines/**`,
      `${SRC}/components/TimelinePages.tsx`,
      `${SRC}/routes/tracker/Checkpoint.tsx`,
    ],
  },
  {
    id: "repository-deletion",
    covers:
      "Deleting the fixture purges its vectors, AI Search items and Artifacts repository through a killed and resumed purge; the orphan sweep",
    requires: ["search"],
    paths: [
      HARNESS,
      `${WORKER}/retention/repo-*.ts`,
      `${WORKER}/knowledge/indexes.ts`,
      `${WORKER}/api/dev.ts`,
    ],
  },
  {
    id: "queue",
    covers: "The merge queue's real conflict repair and classification, without a retry loop",
    requires: [],
    paths: [
      HARNESS,
      `${WORKER}/merge-queue/**`,
      `${SHARED}/merge-queue.ts`,
      "tools/agent/queue-ai-e2e.ts",
      "tools/agent/queue-e2e.ts",
    ],
  },
] as const satisfies readonly StageDefinition[];

export type CopperFinchStage = (typeof COPPER_FINCH_STAGES)[number]["id"];

/** A test-ai run's stages, and where each one's outcome is recorded. */
export interface AiRun {
  selection: Selection;
  outcomes: Record<string, Outcome>;
}

/** What a knowledge build's stats say of how it ran (only the fields read here). */
interface BuildStats {
  analyzed?: number;
  reused?: number;
  ai?: AiSnapshot;
  atlasSpend?: { calls: number };
  /** CORE-286: an update after a push, or a full rebuild, and its own metered calls. */
  mode?: string;
  aiUsage?: {
    calls: number;
    failedCalls?: number;
    costUsd: number;
    byModel: Record<string, unknown>;
  };
}

interface GatewayLog {
  id: string;
  created_at: string;
  model: string;
  provider: string;
  success: boolean;
  cached: boolean;
  metadata?: { component?: string; account?: string; feature?: string };
  request: string;
  response: string;
  response_content_type: string;
  tokens_in: number;
  tokens_out: number;
  cost?: number;
}

interface GatewayLogSummary {
  id: string;
  createdAt: string;
  component: string;
  model: string;
  provider: string;
  success: boolean;
  cached: boolean;
  responseContentType: string;
  tokensIn: number;
  tokensOut: number;
  cost?: number;
  account?: string;
  feature?: string;
}

// List metadata only: never persist request/response bodies or raw cf output.
async function gatewayLogs(
  owned: Environment,
  since: string,
  component: string,
  model?: string,
  page = 1,
) {
  let output: string;
  try {
    output = await command(
      "cf",
      [
        "ai-gateway",
        "logs",
        "list",
        "--gateway-id",
        owned.id,
        "--start-date",
        since,
        "--per-page",
        "50",
        "--page",
        String(page),
        "--order-by",
        "created_at",
        "--order-by-direction",
        "asc",
        "--filters",
        JSON.stringify([
          { key: "metadata.key", operator: "eq", value: ["component"] },
          { key: "metadata.value", operator: "eq", value: [component] },
          ...(model ? [{ key: "model", operator: "eq", value: [model] }] : []),
        ]),
        ...(owned.profile ? ["--profile", owned.profile] : []),
      ],
      { env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: owned.account }, timeout: 30_000 },
    );
  } catch {
    throw new Error(`Gateway metadata lookup failed for ${component}`);
  }
  let logs: GatewayLog[];
  try {
    logs = JSON.parse(output);
  } catch {
    throw new Error("Gateway metadata lookup returned invalid JSON");
  }
  assert(Array.isArray(logs), "Gateway metadata lookup must return a list");
  const selected: GatewayLogSummary[] = logs.flatMap((log) => {
    assert(
      typeof log.id === "string" &&
        typeof log.model === "string" &&
        typeof log.provider === "string" &&
        typeof log.success === "boolean" &&
        Number.isFinite(Date.parse(log.created_at)),
      "Gateway log has invalid identity or outcome",
    );
    if (
      log.metadata?.component !== component ||
      Date.parse(log.created_at) < Date.parse(since) ||
      (model && log.model !== model)
    )
      return [];
    return [
      {
        id: log.id,
        createdAt: log.created_at,
        component,
        model: log.model,
        provider: log.provider,
        success: log.success,
        cached: log.cached,
        responseContentType: log.response_content_type,
        tokensIn: log.tokens_in,
        tokensOut: log.tokens_out,
        cost: log.cost,
        account: log.metadata?.account,
        feature: log.metadata?.feature,
      },
    ];
  });
  return { logs: selected, rawCount: logs.length };
}

/**
 * Whether one log kept its request and response bodies (CORE-290): their
 * sizes in bytes, or null where the gateway has none. Never their content.
 */
async function gatewayBodies(owned: Environment, id: string) {
  const size = async (which: "get-request" | "get-response") => {
    try {
      const output = await command(
        "cf",
        [
          "ai-gateway",
          "logs",
          which,
          id,
          "--gateway-id",
          owned.id,
          ...(owned.profile ? ["--profile", owned.profile] : []),
        ],
        { env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: owned.account }, timeout: 30_000 },
      );
      return Buffer.byteLength(output);
    } catch (error) {
      // "[7002] Request body not available" (or response): nothing was kept.
      if (/\b7002\b|not available/i.test(String(error))) return null;
      throw new Error(`Gateway ${which} lookup failed for ${id}`);
    }
  };
  return { request: await size("get-request"), response: await size("get-response") };
}

/**
 * What this run's application inference cost, from the owned Gateway's logs
 * (every page, metadata only). AI Search's built-in embedding and reranking
 * aren't Gateway logged, so they're not in it.
 */
async function gatewaySpend(owned: Environment, since: string) {
  const byModel: Record<
    string,
    { calls: number; tokensIn: number; tokensOut: number; usd: number }
  > = {};
  let calls = 0;
  let usd = 0;
  let truncated = false;
  for (let page = 1; ; page++) {
    if (page > 100) {
      truncated = true;
      break;
    }
    const output = await command(
      "cf",
      [
        "ai-gateway",
        "logs",
        "list",
        "--gateway-id",
        owned.id,
        "--start-date",
        since,
        "--per-page",
        "50",
        "--page",
        String(page),
        "--order-by",
        "created_at",
        "--order-by-direction",
        "asc",
        ...(owned.profile ? ["--profile", owned.profile] : []),
      ],
      { env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: owned.account }, timeout: 30_000 },
    );
    const logs = JSON.parse(output) as GatewayLog[];
    assert(Array.isArray(logs), "Gateway log listing must return a list");
    for (const log of logs) {
      const model = (byModel[log.model] ??= { calls: 0, tokensIn: 0, tokensOut: 0, usd: 0 });
      model.calls++;
      model.tokensIn += log.tokens_in ?? 0;
      model.tokensOut += log.tokens_out ?? 0;
      model.usd += log.cost ?? 0;
      calls++;
      usd += log.cost ?? 0;
    }
    if (logs.length < 50) break;
  }
  return { source: "AI Gateway logs", since, calls, usd, byModel, truncated };
}

// Real git http-backend provides the target; all state belongs to this invocation.
interface MirrorTarget {
  url: string;
  counts: { authenticated: number; rejected: number; pushes: number };
  close(): Promise<void>;
}

async function targetServer(
  root: string,
  authorization: string,
  env: NodeJS.ProcessEnv,
): Promise<MirrorTarget> {
  const children = new Set<ChildProcess>();
  const counts = { authenticated: 0, rejected: 0, pushes: 0 };
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== authorization) {
      counts.rejected++;
      res.writeHead(401, { "www-authenticate": 'Basic realm="agent-mirror"' }).end();
      req.resume();
      return;
    }
    counts.authenticated++;
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!["/target.git/info/refs", "/target.git/git-receive-pack"].includes(url.pathname)) {
      res.writeHead(404).end();
      req.resume();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new Error("Fixture pack exceeded 2 MiB");
        chunks.push(Buffer.from(chunk));
      }
      const child = spawn("git", ["http-backend"], {
        cwd: root,
        env: {
          ...env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: req.method,
          CONTENT_TYPE: req.headers["content-type"] ?? "",
          CONTENT_LENGTH: String(size),
          REMOTE_USER: "agent",
          REMOTE_ADDR: "127.0.0.1",
          SERVER_PROTOCOL: "HTTP/1.1",
          GATEWAY_INTERFACE: "CGI/1.1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(child);
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      let output = Buffer.alloc(0);
      let overflow = false;
      child.stdout.on("data", (chunk: Buffer) => {
        if (output.length + chunk.length > 2 * 1024 * 1024) {
          overflow = true;
          child.kill("SIGKILL");
        } else output = Buffer.concat([output, chunk]);
      });
      child.stderr.resume();
      child.stdin.on("error", () => undefined);
      child.stdin.end(Buffer.concat(chunks));
      child.on("error", () => {
        if (!res.writableEnded) res.writeHead(502).end();
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        children.delete(child);
        if (res.writableEnded) return;
        const end = output.indexOf("\r\n\r\n");
        if (code !== 0 || overflow || end < 0) {
          res.writeHead(502).end();
          return;
        }
        let status = 200;
        for (const line of output.subarray(0, end).toString().split("\r\n")) {
          const colon = line.indexOf(":");
          if (colon < 1) continue;
          const key = line.slice(0, colon);
          const value = line.slice(colon + 1).trim();
          if (key.toLowerCase() === "status") status = Number(value.split(" ")[0]);
          else res.setHeader(key, value);
        }
        if (url.pathname.endsWith("/git-receive-pack") && status === 200) counts.pushes++;
        res.writeHead(status).end(output.subarray(end + 4));
      });
    } catch {
      if (!res.writableEnded) res.writeHead(502).end();
    }
  });
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/target.git`,
    counts,
    async close() {
      const stopped = [...children].map(
        (child) =>
          new Promise<void>((resolve) => {
            child.once("close", () => resolve());
            child.kill("SIGKILL");
          }),
      );
      server.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        ...stopped,
      ]);
    },
  };
}

export async function runProviderE2E(
  ctx: HarnessContext,
  fixtures: SeedManifest,
  mode: "mirror" | "ai",
  run?: AiRun,
): Promise<void> {
  if (mode === "ai" && !run) throw new Error("An AI run needs its stage selection.");
  const selected = new Set(run?.selection.stages ?? []);
  const want = (id: CopperFinchStage) => selected.has(id);
  // The test-ai stage the current work belongs to: a failure is recorded against it.
  let stageOwner: string | undefined;
  const begin = (id: CopperFinchStage) => (stageOwner = id);
  const passed = (id: CopperFinchStage) => {
    if (run) run.outcomes[id] = "passed";
  };
  await mkdir(ctx.artifacts, { recursive: true });
  const root = await mkdtemp(join(ctx.work, "providers-"));
  const work = join(root, "source");
  await mkdir(work);
  const token = randomBytes(24).toString("hex");
  const authorization = `Basic ${Buffer.from(`agent:${token}`).toString("base64")}`;
  // Per-build model usage of the full build and the push's update (CORE-286).
  const knowledgeUpdates: {
    full?: { mode?: string; aiUsage: NonNullable<BuildStats["aiUsage"]> };
    edit?: { mode?: string; aiUsage: NonNullable<BuildStats["aiUsage"]> };
  } = {};
  const evidence: Record<string, unknown> = {
    version: 1,
    mode,
    startedAt: new Date().toISOString(),
    outcome: "running",
  };
  if (run) {
    // Which stages ran and why (CORE-284), and each one's outcome.
    evidence.selection = run.selection;
    evidence.stages = run.outcomes;
  }
  evidence.knowledgeUpdates = knowledgeUpdates;
  const events: unknown[] = [];
  evidence.events = events;
  let stage = "setup";
  let stageStarted = Date.now();
  const timings: { stage: string; elapsedMs: number; outcome: string }[] = [];
  evidence.timings = timings;
  const enter = (next: string) => {
    timings.push({ stage, elapsedMs: Date.now() - stageStarted, outcome: "passed" });
    stage = next;
    stageStarted = Date.now();
  };
  let target: MirrorTarget | undefined;
  let generatedAvatarCount = 0;
  // Use the owning organization's member for AI scenarios; site administration
  // does not grant access to another account's tracker.
  const persona = mode === "ai" ? "marco" : "priya";
  const env: NodeJS.ProcessEnv = {
    ...ctx.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
  for (const key of Object.keys(env))
    if (/^GIT_CONFIG_(?:COUNT|KEY_|VALUE_)/.test(key)) delete env[key];
  const git = (args: string[], cwd = work, authenticated = false) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        args,
        {
          cwd,
          timeout: 90_000,
          maxBuffer: 2 * 1024 * 1024,
          env: authenticated
            ? {
                ...env,
                GIT_CONFIG_COUNT: "1",
                GIT_CONFIG_KEY_0: `http.${ctx.origin}/.extraHeader`,
                GIT_CONFIG_VALUE_0: `Authorization: Bearer ${fixtures.tokens[persona]}`,
              }
            : env,
        },
        (error, stdout) => {
          // execFile errors embed command arguments/stderr; never persist those.
          if (error)
            reject(new Error(`git ${args[0]} failed (${String(error.code ?? "unknown")})`));
          else resolve(stdout.trim());
        },
      );
    });
  const api = async (
    path: string,
    method = "GET",
    body?: unknown,
    expected = 200,
    timeoutMs = 120_000,
  ) => {
    const response = await fetch(`${ctx.origin}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${fixtures.tokens[persona]}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    events.push({ stage, method, path, status: response.status });
    assert.equal(
      response.status,
      expected,
      `${stage}: ${method} ${path} HTTP ${response.status}, expected ${expected}`,
    );
    return response.json();
  };
  const waitFor = async (label: string, timeout: number, check: () => Promise<boolean>) => {
    const started = Date.now();
    const deadline = Date.now() + timeout;
    let attempts = 0;
    while (Date.now() < deadline) {
      attempts++;
      if (await check()) {
        events.push({ label, attempts, elapsedMs: Date.now() - started, outcome: "passed" });
        return;
      }
      await delay(5_000);
    }
    throw new Error(`${label}: deadline exceeded after ${attempts} observations`);
  };
  // The Atlas against the real providers (CORE-179) runs beside the Copper
  // Finch scenario in its own repositories; its evidence is `atlas` here.
  const atlasEvidence: Record<string, unknown> = { outcome: "running" };
  // It starts once the assistant's turns are done (or that part failed).
  let searchable = () => {};
  const visible = new Promise<void>((resolve) => (searchable = resolve));
  const atlasStages = [...selected].filter((id) => id.startsWith("atlas"));
  const atlas =
    mode === "ai" && atlasStages.length
      ? runAtlasProviderE2E(ctx, fixtures, atlasEvidence, visible, run!).then(
          () => undefined,
          (error: unknown) => error ?? new Error("Atlas provider verification failed"),
        )
      : Promise.resolve(undefined);
  if (mode === "ai" && atlasStages.length) evidence.atlas = atlasEvidence;
  // Stages that work on the Copper Finch repository; the rest need none.
  const copper = (
    [
      "knowledge",
      "search",
      "assistant",
      "knowledge-edit",
      "release-notes",
      "overlays",
      "timeline-pages",
      "repository-deletion",
    ] as const
  ).some(want);
  const needsEdit = (
    ["knowledge-edit", "release-notes", "overlays", "timeline-pages"] as const
  ).some(want);
  // This invocation's owned environment record: Gateway evidence reads its gateway.
  const ownedEnvironment = async () => {
    const owned = JSON.parse(
      await readFile(join(ctx.dir, "environment.json"), "utf8"),
    ) as Environment;
    validateEnvironment(owned);
    assert(
      owned.root === ctx.root &&
        owned.dir === ctx.dir &&
        owned.status === "ready" &&
        owned.id === ctx.env.GITMATRIX_AGENT_ID &&
        owned.id === ctx.env.GITMATRIX_AI_GATEWAY,
      "Gateway evidence must target this invocation's owned gateway",
    );
    return owned;
  };
  let failure: unknown;
  try {
    if (mode === "mirror") {
      await git(["init", "--bare", "--initial-branch=main", join(root, "target.git")]);
      await git(["--git-dir", join(root, "target.git"), "config", "http.receivepack", "true"]);
      target = await targetServer(root, authorization, env);
    }
    // Account policy changes here must not affect the concurrent priya Atlas fixtures.
    const owner = mode === "ai" ? "orbit" : "priya";
    const name = `provider-${randomBytes(5).toString("hex")}`;
    const base = `/repos/${encodeURIComponent(owner)}/${name}`;
    evidence.repo = `${owner}/${name}`;
    const settingsPath = `/accounts/${owner}/settings/ai`;
    const aiSettingsEvidence: Record<string, unknown> = {};
    let capturedAi: AiSnapshot | undefined;
    let nextAi: AiSettingsView | undefined;
    if (mode === "ai") {
      evidence.aiSettings = aiSettingsEvidence;
      aiSettingsEvidence.disabled = await api(settingsPath, "PATCH", {
        features: { knowledge: false, wiki: false, atlas: false, releaseNotes: false },
        models: {
          classification: "clef",
          fast: "gemma-4-26b-a4b-it",
          task: "gemma-4-26b-a4b-it",
        },
      });
    }
    await api(
      "/repos",
      "POST",
      {
        owner,
        name,
        visibility: "private",
        description: "Tiny isolated provider integration fixture",
      },
      201,
    );
    await git(["init", "--initial-branch=main"]);
    await git(["config", "user.name", "Agent Fixture"]);
    await git(["config", "user.email", "agent-fixture@example.invalid"]);
    await writeFile(
      join(work, "README.md"),
      "# Copper Finch\n\nCopper Finch computes a parcel checksum using copperFinchChecksum. It adds UTF-16 character codes modulo 65521. This tiny library has no network or filesystem side effects.\n",
    );
    await writeFile(
      join(work, "checksum.ts"),
      "/** Copper Finch parcel checksum: UTF-16 code units modulo 65521. */\nexport function copperFinchChecksum(parcel: string): number {\n  let checksum = 0;\n  for (let i = 0; i < parcel.length; i++) checksum = (checksum + parcel.charCodeAt(i)) % 65521;\n  return checksum;\n}\n",
    );
    await git(["add", "README.md", "checksum.ts"]);
    await git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "Copper Finch fixture"]);
    await git(["remote", "add", "origin", `${ctx.origin}/${owner}/${name}.git`]);
    let final!: string;
    // Shared by the Copper Finch stages; only the selected ones run.
    type Json = Awaited<ReturnType<typeof api>>;
    let graph: Json, page: Json, symbol: Json, file: Json;
    let edited!: string;
    let cited!: string;
    if (mode === "mirror") {
      assert(target);
      const dev = async (path: string, body?: unknown) => {
        assert(ctx.env.GITMATRIX_AGENT_SECRET, "Mirror fixtures require the agent secret");
        const response = await fetch(`${ctx.origin}/api/dev/${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${ctx.env.GITMATRIX_AGENT_SECRET}`,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(180_000),
        });
        assert.equal(response.status, 200, `Owned mirror ${path} control failed`);
        return response.json();
      };
      let mirrorRepoId: string | undefined;
      try {
        enter("mirror-configure");
        await api(`${base}/mirror`, "PUT", {
          url: target.url,
          username: "agent",
          token,
          enabled: true,
          prune: true,
        });
        enter("mirror-initial-queue");
        await git(["push", "origin", "main"], work, true);
        const initial = await git(["rev-parse", "HEAD"]);
        mirrorRepoId = (await api(base)).id;
        assert(mirrorRepoId, "Mirror cleanup needs the canonical repository identity");
        const refs = async () => {
          const result = new Map<string, string>(
            (
              await git([
                "--git-dir",
                join(root, "target.git"),
                "for-each-ref",
                "--format=%(refname) %(objectname)",
              ])
            )
              .split("\n")
              .filter(Boolean)
              .map((line) => {
                const [ref, oid] = line.split(" ");
                return [ref!, oid!];
              }),
          );
          evidence.observedMirrorRefs = Object.fromEntries(result);
          return result;
        };
        await waitFor(
          stage,
          120_000,
          async () => (await refs()).get("refs/heads/main") === initial,
        );
        // Pruning covers only what is mirrored: the stale tag goes, the stale
        // branch (not the default) stays.
        for (const ref of ["refs/heads/stale-fixture", "refs/tags/stale-fixture"]) {
          await git(["--git-dir", join(root, "target.git"), "update-ref", ref, initial]);
        }
        enter("mirror-update-tag-prune");
        await git([
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "--allow-empty",
          "-m",
          "Verify mirror update",
        ]);
        await git(["tag", "-a", "provider-v1", "-m", "Provider fixture tag"]);
        final = await git(["rev-parse", "HEAD"]);
        let tag = await git(["rev-parse", "refs/tags/provider-v1"]);
        // Only the default branch and tags are mirrored; the timeline stays here.
        await git(
          ["push", "origin", "main", "refs/tags/provider-v1", "HEAD:refs/heads/timeline-fixture"],
          work,
          true,
        );
        const mirrored = (actual: Map<string, string>) =>
          actual.size === 3 &&
          actual.get("refs/heads/main") === final &&
          actual.get("refs/tags/provider-v1") === tag &&
          actual.get("refs/heads/stale-fixture") === initial;
        await waitFor(stage, 120_000, async () => mirrored(await refs()));
        evidence.mirrorRefs = { main: final, tag };
        enter("mirror-owned-work");
        const slug = `mirror-work-${name.slice("provider-".length)}`;
        const timelinePath = `/tracker/${owner}/timelines/${slug}`;
        const forked = await api(
          `/tracker/${owner}/timelines`,
          "POST",
          { slug, policy: "auto", repos: [{ repo: `${owner}/${name}`, commit: final }] },
          201,
        );
        assert.equal(forked.timeline.repos.length, 1);
        const entry = forked.timeline.repos[0] as {
          source: CodeSource;
          logicalBase: SourceSnapshot;
          bookmark: string;
        };
        assert.equal(entry.source.kind, "timeline-work");
        assert.match(entry.source.sourceId, /^work_/);
        assert.equal(entry.source.repoId, mirrorRepoId);
        assert.equal(entry.source.timelineId, forked.timeline.id);
        assert.equal(entry.source.ref, "refs/heads/work");
        assert.equal(entry.bookmark, "work");
        assert.equal(entry.logicalBase.sourceId, "canonical");
        assert.equal(entry.logicalBase.commit, final);
        const remote = `${ctx.origin}/${owner}/${name}@${slug}.git`;
        const workCommits: string[] = [];
        const excludedObjects: string[] = [];
        const observations: unknown[] = [];
        evidence.ownedMirror = {
          actor: persona,
          timeline: slug,
          source: entry.source,
          logicalBase: entry.logicalBase,
          workCommits,
          excludedObjects,
          observations,
        };
        // A fresh private source is not readable merely by knowing its opaque ID.
        const denied = await fetch(`${remote}/info/refs?service=git-upload-pack`, {
          signal: AbortSignal.timeout(30_000),
        });
        assert([401, 403, 404].includes(denied.status), "Anonymous work transport was authorized");
        await denied.arrayBuffer();
        const outsider = await fetch(`${remote}/info/refs?service=git-upload-pack`, {
          headers: { authorization: `Bearer ${fixtures.tokens.sam}` },
          signal: AbortSignal.timeout(30_000),
        });
        assert([403, 404].includes(outsider.status), "An unrelated person read private work");
        await outsider.arrayBuffer();
        const assertIsolated = async (label: string) => {
          const { mirror } = await api(`${base}/mirror/sync`, "POST");
          assert.equal(mirror.status, "ok");
          assert.equal(mirror.lastSyncedCommit, final);
          const actual = await refs();
          assert(mirrored(actual), `${label}: canonical filtering or stale-ref controls changed`);
          // Enumerate all stored objects, including unreachable ones: absence from
          // refs alone would miss WIP objects leaked inside an otherwise valid pack.
          const objects = new Set(
            (
              await git([
                "--git-dir",
                join(root, "target.git"),
                "cat-file",
                "--batch-all-objects",
                "--batch-check=%(objectname)",
              ])
            )
              .split("\n")
              .filter(Boolean),
          );
          for (const oid of excludedObjects)
            assert(!objects.has(oid), `${label}: mirror object database contains WIP ${oid}`);
          observations.push({
            label,
            sourceId: entry.source.sourceId,
            canonical: final,
            refs: Object.fromEntries(actual),
            excludedObjects: [...excludedObjects],
            objectCount: objects.size,
          });
        };
        await git(["fetch", remote, "refs/heads/work"], work, true);
        assert.equal(await git(["rev-parse", "FETCH_HEAD"]), final);
        await git(["checkout", "--detach", "FETCH_HEAD"]);
        for (const revision of [1, 2]) {
          await writeFile(
            join(work, "mirror-work.txt"),
            `Owned mirror work revision ${revision}\n`,
          );
          await git(["add", "mirror-work.txt"]);
          await git(["-c", "core.hooksPath=/dev/null", "commit", "-m", `Mirror WIP ${revision}`]);
          const oid = await git(["rev-parse", "HEAD"]);
          workCommits.push(oid);
          excludedObjects.push(oid);
          if (revision === 1)
            excludedObjects.push(await git(["rev-parse", "HEAD:mirror-work.txt"]));
          await git(["push", remote, "HEAD:refs/heads/work"], work, true);
          assert.equal(
            await git(["ls-remote", remote, "refs/heads/work"], work, true),
            `${oid}\trefs/heads/work`,
          );
          const sourceHistory = await api(
            `${base}/commits?source=${entry.source.sourceId}&ref=${oid}`,
          );
          assert.equal(sourceHistory.source.sourceId, entry.source.sourceId);
          await api(`${base}/commits?ref=${oid}`, "GET", undefined, 404);
          await assertIsolated(`work-push-${revision}`);
        }
        assert.notEqual(workCommits[0], workCommits[1]);
        assert.equal(await git(["show", "-s", "--format=%P", workCommits[1]!]), workCommits[0]);
        const approvedTree = await git(["rev-parse", "HEAD^{tree}"]);
        const canonicalParent = final;
        enter("mirror-compact-landing");
        const checkpoint = await api(
          `${timelinePath}/checkpoints`,
          "POST",
          { summary: "Mirror only the compact canonical result, never owned WIP history." },
          201,
        );
        assert.equal(checkpoint.checkpoint.repos[0].source.sourceId, entry.source.sourceId);
        assert.equal(checkpoint.checkpoint.repos[0].source.commit, workCommits[1]);
        let landing: Landing | null = null;
        await waitFor(stage, 12 * 60_000, async () => {
          landing = (await api(`${timelinePath}/landing`)).landing;
          if (
            landing &&
            ["failed", "conflict", "partly_landed", "blocked_dependency"].includes(landing.state)
          )
            throw new Error(`Mirror compact landing ${landing.state}`);
          return landing?.state === "landed";
        });
        await git(["fetch", "origin", "main"], work, true);
        final = await git(["rev-parse", "FETCH_HEAD"]);
        assert.equal(await git(["show", "-s", "--format=%P", final]), canonicalParent);
        assert.equal(await git(["rev-list", "--count", `${canonicalParent}..${final}`]), "1");
        assert.equal(await git(["rev-parse", `${final}^{tree}`]), approvedTree);
        assert(!workCommits.includes(final), "Landing reused a WIP commit");
        // Move the existing annotated tag to the canonical result, keeping the
        // original exact three-ref assertion and stale-tag/nondefault controls.
        await git(["tag", "-f", "-a", "provider-v1", final, "-m", "Compact provider fixture"]);
        tag = await git(["rev-parse", "refs/tags/provider-v1"]);
        await git(["push", "--force", "origin", "refs/tags/provider-v1"], work, true);
        await waitFor("mirror-compact-convergence", 120_000, async () => mirrored(await refs()));
        const archived = await api(timelinePath);
        assert.equal(archived.timeline.status, "landed");
        const archivedSource = await api(`${base}?source=${entry.source.sourceId}`);
        assert.equal(archivedSource.source.sourceId, entry.source.sourceId);
        assert.equal(archivedSource.sourceState, "archived");
        assert.equal(
          await git(["ls-remote", remote, "refs/heads/work"], work, true),
          `${workCommits[1]}\trefs/heads/work`,
        );
        await assertIsolated("compact-landed-archive");
        assert.equal(
          await git(["--git-dir", join(root, "target.git"), "show", "-s", "--format=%P", final]),
          canonicalParent,
        );
        assert.equal(
          await git([
            "--git-dir",
            join(root, "target.git"),
            "rev-parse",
            "refs/tags/provider-v1^{}",
          ]),
          final,
        );
        enter("mirror-owned-source-expiry");
        const expiry = await dev("source-retention", {
          action: "expire",
          repo: `${owner}/${name}`,
          timeline: slug,
          sourceId: entry.source.sourceId,
        });
        assert.equal(expiry.sourceId, entry.source.sourceId);
        assert.equal(expiry.state, "purged");
        await api(
          `${base}/commits?source=${entry.source.sourceId}&ref=${workCommits[1]}`,
          "GET",
          undefined,
          410,
        );
        await assertIsolated("owned-source-deleted");
        Object.assign(evidence.ownedMirror as Record<string, unknown>, {
          anonymousStatus: denied.status,
          outsider: "sam",
          outsiderStatus: outsider.status,
          checkpoint: checkpoint.checkpoint.id,
          canonicalParent,
          compact: final,
          approvedTree,
          landing,
          archivedSourceState: archivedSource.sourceState,
          expiry,
        });
        evidence.mirrorRefs = { main: final, tag };
        // Observe the persisted queue result before attempting synchronous auth checks.
        await waitFor("mirror-queue-settled", 30_000, async () => {
          const { mirror } = await api(`${base}/mirror`);
          return mirror.status === "ok" && mirror.lastSyncedCommit === final;
        });
        enter("mirror-auth-rejection");
        await api(`${base}/mirror`, "PUT", { token: randomBytes(24).toString("hex") });
        await api(`${base}/mirror/sync`, "POST", undefined, 502);
        const { mirror: failed } = await api(`${base}/mirror`);
        assert.equal(failed.status, "failed");
        assert.match(failed.lastError, /401|token/i);
        assert(target.counts.rejected > 0, "Real HTTP target did not reject invalid credentials");
        enter("mirror-auth-recovery");
        await api(`${base}/mirror`, "PUT", { token });
        const { mirror: recovered } = await api(`${base}/mirror/sync`, "POST");
        assert.equal(recovered.status, "ok");
        assert.equal(recovered.lastSyncedCommit, final);
        assert.equal(recovered.lastError, null);
        assert(mirrored(await refs()), "A sync mirrored a non-default branch or pruned too much");
        evidence.mirrorRequests = target.counts;
        enter("non-ai-boundary");
        const status = await api(`${base}/knowledge/status`);
        assert.equal(status.current, null, "Automatic fixture push launched knowledge work");
        assert.deepEqual(status.recent, [], "Automatic fixture push created knowledge builds");
        assert.equal(status.indexedCommit, null);
        await api(`${base}/knowledge/rebuild`, "POST", undefined, 503);
        await api(`${base}/knowledge/search?q=checksum`, "GET", undefined, 503);
        await delay(2_000); // Past the coordinator debounce: status reads must not start a build either.
        const afterRead = await api(`${base}/knowledge/status`);
        assert.equal(afterRead.current, null, "Status read launched knowledge work");
        assert.deepEqual(afterRead.recent, [], "Status read created knowledge builds");
        evidence.knowledge = {
          current: status.current,
          recent: status.recent,
          indexedCommit: status.indexedCommit,
        };
      } finally {
        const deleted = await fetch(`${ctx.origin}/api${base}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${fixtures.tokens[persona]}` },
          signal: AbortSignal.timeout(60_000),
        });
        assert.equal(deleted.status, 204, "Delete only this owned mirror repository");
        if (mirrorRepoId) {
          await dev("repo-purge", { repo: mirrorRepoId, action: "resume" });
          await waitFor("mirror-owned-cleanup", 15 * 60_000, async () => {
            const inventory = await dev(`repo-inventory?repo=${encodeURIComponent(mirrorRepoId!)}`);
            if (inventory.deletion?.phase !== "done") return false;
            assert.equal(inventory.repo, null);
            assert.deepEqual(inventory.d1, {});
            assert.equal(inventory.artifacts.exists, false);
            evidence.mirrorCleanup = { repoId: mirrorRepoId, phase: "done", providerExists: false };
            return true;
          });
        }
      }
    } else {
      if (copper) {
        begin("knowledge");
        await git(["push", "origin", "main"], work, true);
        final = await git(["rev-parse", "HEAD"]);
        enter("ai-settings-disabled");
        // Both reads ordinarily repair missing generated data. Account policy must
        // stop that admission as well as the original push-triggered work.
        await api(`${base}/knowledge/status`);
        await api(`${base}/release-notes`);
        await delay(10_000); // Beyond the Knowledge coordinator's maximum debounce.
        const disabledKnowledge = await api(`${base}/knowledge/status`);
        const disabledNotes: ReleaseNotesIndex = await api(`${base}/release-notes`);
        assert.equal(disabledKnowledge.current, null, "Disabled knowledge started a build");
        assert.deepEqual(disabledKnowledge.recent, [], "Disabled knowledge created build history");
        assert.equal(disabledKnowledge.indexedCommit, null);
        assert.equal(disabledNotes.status.state, "disabled");
        assert.deepEqual(disabledNotes.releases, [], "Disabled release generation wrote notes");
        aiSettingsEvidence.disabledKnowledge = disabledKnowledge;
        aiSettingsEvidence.disabledNotes = disabledNotes;
        // Release notes generate only when their stage runs (CORE-284).
        await api(settingsPath, "PATCH", {
          features: {
            knowledge: true,
            wiki: true,
            atlas: true,
            releaseNotes: want("release-notes"),
          },
        });
        await api(`${base}/knowledge/rebuild`, "POST", undefined, 202);
        enter("ai-settings-running-snapshot");
        await waitFor(stage, 60_000, async () => {
          const status = await api(`${base}/knowledge/status`);
          if (status.state === "failed") throw new Error("Configured provider build failed");
          if (status.current?.toCommit !== final || !status.current.stats?.ai) return false;
          capturedAi = status.current.stats.ai as AiSnapshot;
          aiSettingsEvidence.runningBuild = status.current.id;
          return true;
        });
        assert(capturedAi, "The running build must expose its immutable policy");
        assert.equal(capturedAi.models.classification, "@cf/cloudflare/clef");
        assert.equal(capturedAi.models.fast, "@cf/google/gemma-4-26b-a4b-it");
        assert.equal(capturedAi.models.task, "@cf/google/gemma-4-26b-a4b-it");
        assert.equal(capturedAi.features.wiki, true);
        assert.equal(capturedAi.features.atlas, true);
        aiSettingsEvidence.startedWith = capturedAi;
        nextAi = await api(settingsPath, "PATCH", {
          features: { wiki: false, atlas: false },
          models: { classification: "clef", fast: "glm-5.3-flash", task: "glm-5.3-flash" },
        });
        aiSettingsEvidence.futureSettings = nextAi;
        enter("knowledge-build");
        await waitFor(stage, 12 * 60_000, async () => {
          const status = await api(`${base}/knowledge/status`);
          evidence.knowledge = status;
          const build = status.recent.find(
            (entry: { toCommit: string; status: string }) =>
              entry.toCommit === final && entry.status === "succeeded",
          );
          if (status.state === "failed")
            throw new Error("Knowledge build failed; see redacted provider evidence");
          return status.state === "up-to-date" && status.indexedCommit === final && Boolean(build);
        });
        // The explicit rebuild runs in full and meters its own calls (CORE-286).
        {
          const full = (
            evidence.knowledge as {
              recent: { toCommit: string; status: string; stats: BuildStats }[];
            }
          ).recent.find((entry) => entry.toCommit === final && entry.status === "succeeded");
          assert.equal(full?.stats.mode, "full", "The explicit rebuild must run in full");
          assert(
            full?.stats.aiUsage && full.stats.aiUsage.calls > 0,
            "The full build metered no calls",
          );
          knowledgeUpdates.full = { mode: full.stats.mode, aiUsage: full.stats.aiUsage };
        }
        enter("knowledge-graph");
        graph = await api(`${base}/knowledge/graph/export`);
        symbol = graph.nodes.find(
          (node: { kind: string; name: string; path: string }) =>
            node.kind === "symbol" &&
            node.name === "copperFinchChecksum" &&
            node.path === "checksum.ts",
        );
        file = graph.nodes.find(
          (node: { kind: string; path: string }) =>
            node.kind === "file" && node.path === "checksum.ts",
        );
        assert(symbol && file, "Graph lacks the fixture file and exported checksum symbol");
        assert(
          graph.edges.some(
            (edge: { src: string; dst: string }) => edge.src === file.id && edge.dst === symbol.id,
          ),
          "Graph lacks file-to-symbol membership",
        );
        evidence.graph = { file: file.id, symbol: symbol.id };
        enter("knowledge-wiki");
        const catalog = await api(`${base}/knowledge/wiki`);
        const overview = catalog.pages.find((page: { slug: string }) => page.slug === "overview");
        assert(overview, "Generated wiki has no overview");
        page = await api(`${base}/knowledge/wiki/page?slug=overview`);
        assert.match(
          page.body,
          /Copper Finch|copperFinchChecksum/i,
          "Wiki must explain the fixture",
        );
        assert.match(page.body, /65521|checksum/i, "Wiki must describe checksum behavior");
        assert.equal(page.generatedIn, final, "Wiki must describe the indexed fixture commit");
        assert(page.model, "Wiki must record its real generation model");
        assert.equal(page.model, capturedAi.models.task, "Running wiki work retargeted its model");
        const completedPolicy = evidence.knowledge as {
          recent: { id: string; stats: { ai?: AiSnapshot } }[];
        };
        assert.deepEqual(
          completedPolicy.recent.find((build) => build.id === aiSettingsEvidence.runningBuild)
            ?.stats.ai,
          capturedAi,
          "A settings edit changed the running build's persisted policy",
        );
        evidence.wiki = page;
      }
      if (want("search")) {
        begin("search");
        enter("index-visibility");
        const fixtureRepo = await api(base);
        const visibility = {} as VisibilityReport;
        evidence.indexVisibilitySummary = visibility;
        await waitForIndexVisibility({
          target: {
            repo: `${owner}/${name}`,
            key: `${fixtureRepo.id}/file:checksum.ts.md`,
            path: "checksum.ts",
            symbolId: symbol.id,
            fileId: file.id,
          },
          item: await searchItemStatus(ctx, `${fixtureRepo.id}/file:checksum.ts.md`),
          search: async (remainingMs) => {
            const result = await api(
              `${base}/knowledge/search?q=${encodeURIComponent("Copper Finch copperFinchChecksum parcel checksum modulo 65521")}`,
              "GET",
              undefined,
              200,
              Math.min(120_000, remainingMs),
            );
            evidence.search = result;
            return result;
          },
          report: visibility,
        }).finally(() => {
          evidence.indexVisibility = visibility.attempts;
        });
        enter("palette-knowledge");
        // CORE-97: the search says which providers answered and which index it
        // read, so an empty list can be told from a failure or a missing index.
        const answered = evidence.search as {
          providers: { entities: string; passages: string };
          index: { state: string; indexedCommit: string | null };
        };
        assert.deepEqual(answered.providers, { entities: "ok", passages: "ok" });
        assert.equal(answered.index.indexedCommit, final, "Search must report the indexed commit");
        // The same discriminating query in another repository never returns this one's results.
        const elsewhere = await api(
          `/repos/orbit/website/knowledge/search?q=${encodeURIComponent("Copper Finch copperFinchChecksum parcel checksum modulo 65521")}`,
        );
        evidence.paletteKnowledgeIsolation = {
          index: elsewhere.index,
          providers: elsewhere.providers,
          entities: elsewhere.entities.map((e: { id: string }) => e.id),
          passages: elsewhere.passages.map((p: { path: string }) => p.path),
        };
        assert(
          !elsewhere.entities.some((e: { name: string }) => /copperFinch/i.test(e.name)) &&
            !elsewhere.passages.some((p: { path: string; text: string }) =>
              /checksum\.ts|copperFinch/i.test(`${p.path} ${p.text}`),
            ),
          "Another repository's search returned the fixture's results",
        );
        {
          // The palette's code and wiki mode, against these real providers:
          // nothing is searched until Enter, and the code result opens the file.
          const browser = await chromium.launch({ headless: true });
          const context = await browser.newContext({ baseURL: ctx.origin });
          const page = await context.newPage();
          const expect = playwrightExpect.configure({ timeout: 120_000 });
          page.setDefaultTimeout(120_000);
          const searches: string[] = [];
          page.on("request", (request) => {
            if (request.url().includes("/knowledge/search")) searches.push(request.url());
          });
          try {
            await page.goto("/signin");
            await page
              .getByRole("button", { name: new RegExp(`Continue as ${persona}`, "i") })
              .click();
            await page.waitForURL((url) => url.pathname !== "/signin");
            await page.goto(`/${owner}/${name}`);
            await page.waitForLoadState("networkidle");
            await page.keyboard.press("Control+k");
            await page
              .getByRole("combobox", { name: "Search or go to" })
              .fill("search code and wiki");
            await page.getByRole("option", { name: /^Search code and wiki/ }).click();
            const box = page.getByRole("combobox", {
              name: `Search code and wiki in ${owner}/${name}`,
            });
            await box.fill("Copper Finch copperFinchChecksum parcel checksum modulo 65521");
            await delay(1_000);
            assert.equal(searches.length, 0, "Typing in code and wiki search must not search");
            await box.press("Enter");
            const code = page.getByRole("group", { name: "Code" });
            await expect(code.getByRole("option", { name: /checksum\.ts/ })).toBeVisible();
            assert.equal(searches.length, 1, "One submission, one search");
            await expect(page.getByRole("group", { name: "Entities" })).toBeVisible();
            evidence.paletteKnowledge = {
              groups: await page.getByRole("listbox").getByRole("group").allInnerTexts(),
              searches: searches.length,
            };
            await code.getByRole("option", { name: /checksum\.ts/ }).click();
            await page.waitForURL((url) => url.pathname.endsWith("/checksum.ts"));
            assert.match(new URL(page.url()).pathname, new RegExp(`^/${owner}/${name}/blob/`));
            await expect(page.getByText("copperFinchChecksum").first()).toBeVisible();
          } catch (error) {
            await page
              .screenshot({ path: join(ctx.artifacts, "palette-knowledge-failure.png") })
              .catch(() => {});
            throw error;
          } finally {
            await context.close();
            await browser.close();
          }
        }
        passed("search");
      }
      if (want("assistant")) {
        begin("assistant");
        enter("assistant");
        // CORE-290: the persona keeps its conversations' bodies (the agent
        // environment's default) but not its titles' and status lines', so the
        // gateway evidence below sees both sides of the header.
        await api(`/accounts/${persona}/settings/ai`, "PATCH", {
          logBodies: { assistant: null, "assistant-titles": false },
        });
        // The assistant (CORE-25/26): one real turn through clef routing, the
        // orchestrator model and its tools, answered from the indexed fixture.
        const asked = await fetch(`${ctx.origin}/api/assistant/ask`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${fixtures.tokens[persona]}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            repo: `${owner}/${name}`,
            question: "What does copperFinchChecksum compute, and modulo what number?",
          }),
          signal: AbortSignal.timeout(180_000),
        });
        events.push({ stage, method: "POST", path: "/assistant/ask", status: asked.status });
        assert.equal(asked.status, 200, `assistant: HTTP ${asked.status}`);
        const turn = (await asked.text())
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { type: string; [key: string]: unknown });
        const done = turn.find((e) => e.type === "done") as { answer: string } | undefined;
        const plan = turn.find((e) => e.type === "plan") as
          | { routedMs: number | null; groups: string[]; model: string }
          | undefined;
        const chat = turn.find((e) => e.type === "chat") as { chatId: string } | undefined;
        evidence.assistant = {
          plan,
          tools: turn.filter((e) => e.type === "tool").map((e) => e.label),
          answer: done?.answer,
          error: turn.find((e) => e.type === "error"),
        };
        assert(done, "The assistant's turn didn't finish");
        assert(plan && typeof plan.routedMs === "number", "clef didn't route the turn in time");
        assert(
          turn.some((e) => e.type === "tool"),
          "The assistant answered without looking anything up",
        );
        assert.match(
          done.answer,
          /65521/,
          "The assistant's answer must come from the fixture code",
        );
        const chats = await api("/assistant/chats");
        assert(
          chats.chats.some(
            (c: { id: string; source: string }) => c.id === chat?.chatId && c.source === "cli",
          ),
          "The conversation must be in the person's directory",
        );
      }
      if (want("assistant") || want("avatars")) {
        const teamKey = `C${randomBytes(2).toString("hex").toUpperCase()}`;
        if (want("assistant"))
          await api(`/tracker/${persona}/mutate`, "POST", {
            operationId: randomUUID(),
            mutations: [
              {
                kind: "team.create",
                id: randomUUID(),
                data: { key: teamKey, name: "Assistant verification" },
              },
            ],
          });
        const browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ baseURL: ctx.origin });
        const page = await context.newPage();
        const expect = playwrightExpect.configure({ timeout: 120_000 });
        page.setDefaultTimeout(120_000);
        await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
        let rejectNextResponse = false;
        // The turn's stream chunks, in order, for the between-steps status check.
        const chunks: { type: string; data?: { text?: string } }[] = [];
        await page.routeWebSocket(/\/api\/assistant\/chats\//, (socket) => {
          const server = socket.connectToServer();
          server.onMessage((message) => {
            const frame = JSON.parse(message.toString());
            if (frame.type === "cf_agent_use_chat_response" && frame.body)
              try {
                chunks.push(JSON.parse(frame.body));
              } catch {
                // Not a chunk.
              }
            if (
              rejectNextResponse &&
              frame.type === "cf_agent_use_chat_response" &&
              frame.body &&
              JSON.parse(frame.body).type === "start"
            ) {
              rejectNextResponse = false;
              socket.send(
                JSON.stringify({
                  ...frame,
                  body: JSON.stringify({ type: "error", errorText: "Injected stream failure" }),
                }),
              );
            } else socket.send(message);
          });
        });
        try {
          await page.goto("/signin");
          await page
            .getByRole("button", { name: new RegExp(`Continue as ${persona}`, "i") })
            .click();
          await page.waitForURL((url) => url.pathname !== "/signin");
          if (want("assistant")) {
            enter("assistant-approval-continuation");
            const skillName = `approval-${randomBytes(4).toString("hex")}`;
            const skillDescription = "Create one approved tracker task and open its receipt.";
            const skillMarker = `SKILL-APPLIED-${randomBytes(8).toString("hex")}`;
            const skillBody = [
              "For this explicit invocation only, use the owner, team and title supplied in the message.",
              "Call create_issue now to propose exactly one task with those values.",
              "The tool's built-in approval card must obtain approval before the write executes;",
              "do not ask for a separate conversational confirmation.",
              "After the card is approved, open the new issue.",
              `In your final answer after the approved write, include the exact standalone marker ${skillMarker}.`,
              "These instructions and the marker apply only to this invocation, not later ordinary turns.",
            ].join("\n");
            const skillEvidence: Record<string, unknown> = { name: skillName, outcome: "running" };
            evidence.assistantSkill = skillEvidence;
            await page.goto("/settings/skills");
            const skillForm = page.getByRole("form", { name: "Add an assistant skill" });
            await skillForm.getByRole("textbox", { name: "Name", exact: true }).fill(skillName);
            await skillForm
              .getByRole("textbox", { name: "Description (optional)", exact: true })
              .fill(skillDescription);
            await skillForm
              .getByRole("textbox", { name: "Markdown instructions", exact: true })
              .fill(skillBody);
            await skillForm.getByRole("checkbox", { name: "Enabled", exact: true }).check();
            const savedResponse = page.waitForResponse(
              (response) =>
                new URL(response.url()).pathname === "/api/account/skills" &&
                response.request().method() === "POST",
            );
            await skillForm.getByRole("button", { name: "Add skill", exact: true }).click();
            assert.equal(
              (await savedResponse).status(),
              201,
              "Personal skill creation must succeed",
            );
            await page.reload();
            await expect(page.getByRole("list", { name: "Your assistant skills" })).toContainText(
              skillName,
            );
            const personalResponse = await context.request.get("/api/account/skills");
            assert.equal(personalResponse.status(), 200);
            const personalSkills = (await personalResponse.json()) as {
              skills: PersonalAssistantSkill[];
            };
            const personalSkill = personalSkills.skills.find((skill) => skill.name === skillName);
            assert(personalSkill, "The current persona's skill must persist after settings reload");
            assert(personalSkill.id, "A personal skill must have a stable identity");
            assert.equal(personalSkill.description, skillDescription);
            assert.equal(personalSkill.body, skillBody);
            assert.equal(personalSkill.enabled, true);
            assert(Number.isFinite(Date.parse(personalSkill.createdAt)));
            assert(Number.isFinite(Date.parse(personalSkill.updatedAt)));
            skillEvidence.personal = {
              id: personalSkill.id,
              name: personalSkill.name,
              description: personalSkill.description,
              enabled: personalSkill.enabled,
              createdAt: personalSkill.createdAt,
              updatedAt: personalSkill.updatedAt,
            };
            await page.goto(`/${owner}/${name}`);
            await page.getByRole("button", { name: "Assistant", exact: true }).click();
            const composer = page.getByRole("textbox", { name: "Message the assistant" });
            const title = `Approval continuity ${randomBytes(4).toString("hex")}`;
            await composer.fill(`/${skillName.slice(0, -2)}`);
            const skillPicker = page.getByRole("listbox", { name: "Assistant skills" });
            await expect(
              skillPicker.getByRole("option", { name: new RegExp(`/${skillName}\\b`) }),
            ).toBeVisible();
            await composer.press("ArrowDown");
            await composer.press("Enter");
            await expect(composer).toHaveValue(`/${skillName} `);
            await expect(skillPicker).toBeHidden();
            await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeHidden();
            const invocation = `/${skillName} Owner: ${persona}. Team: ${teamKey}. Title: "${title}".`;
            skillEvidence.userInvocation = invocation;
            await composer.fill(invocation);
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
            const chatId = await page.evaluate(() => localStorage.getItem("gm.assistant.chat"));
            assert(chatId, "The browser must retain its conversation");
            const messagesPath = `/assistant/chats/${chatId}/agent/get-messages`;
            type Message = {
              id: string;
              role: string;
              parts: {
                type: string;
                state?: string;
                toolCallId?: string;
                text?: string;
                output?: { created?: string };
                data?: AssistantSkillInvocation;
              }[];
            };
            const pending: Message[] = await api(messagesPath);
            assert(
              pending.some(
                (message) =>
                  message.role === "user" &&
                  message.parts.some((part) => part.type === "text" && part.text === invocation),
              ),
              "The explicit slash invocation must persist unchanged in conversation history",
            );
            const approval = pending.findLast((message) =>
              message.parts.some((part) => part.state === "approval-requested"),
            );
            assert(approval, "The pending tool invocation must already be persisted");
            const call = approval.parts.find((part) => part.state === "approval-requested")!;
            const pendingSkills = pending.flatMap((message) =>
              message.parts.filter((part) => part.type === "data-skill"),
            );
            assert.equal(
              pendingSkills.length,
              1,
              "An explicit invocation must persist one receipt",
            );
            assert.deepEqual(pendingSkills[0]!.data, {
              id: personalSkill.id,
              name: skillName,
              description: skillDescription,
              source: "personal",
            });
            const matchingIssues = async () =>
              (await api(`/tracker/${persona}/snapshot`)).issues.filter(
                (issue: { title: string }) => issue.title === title,
              );
            assert.equal((await matchingIssues()).length, 0, "No write may precede approval");
            await page.getByRole("button", { name: "Approve", exact: true }).click();
            await waitFor(stage, 120_000, async () => {
              const messages: Message[] = await api(messagesPath);
              return messages.some(
                (message) =>
                  message.id === approval.id &&
                  message.parts.some(
                    (part) =>
                      part.toolCallId === call.toolCallId && part.state === "output-available",
                  ),
              );
            });
            const created = await matchingIssues();
            assert.equal(created.length, 1, "One approval must create exactly one issue");
            await expect(
              page
                .locator(
                  `[aria-label="Conversation"] a[href="/tracker/${persona}/issues/${created[0].key}"]`,
                )
                .first(),
            ).toBeVisible();
            await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
            await expect(page.getByRole("alert")).toBeHidden();
            const invoked: Message[] = await api(messagesPath);
            const invocationAnswer = invoked
              .filter((message) => message.role === "assistant")
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "text")
              .map((part) => part.text ?? "")
              .join("\n");
            assert(
              invocationAnswer.includes(skillMarker),
              "The real model must follow the distinctive instruction present only in the skill body",
            );
            await expect(page.getByRole("list", { name: "Conversation" })).toContainText(
              skillMarker,
            );
            await expect(page.getByText(`Used /${skillName}`, { exact: true })).toHaveCount(1);
            skillEvidence.invocation = pendingSkills[0]!.data;
            skillEvidence.markerObserved = skillMarker;
            skillEvidence.approvedIssue = created[0].key;
            await composer.fill(
              "What exact issue title did I just ask you to create? Answer with that title only from this conversation without tools.",
            );
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await waitFor(stage, 120_000, async () => {
              const messages: Message[] = await api(messagesPath);
              const last = messages.at(-1);
              return (
                last?.role === "assistant" &&
                last.id !== approval.id &&
                last.parts.some((part) => part.type === "text" && part.text?.includes(title))
              );
            });
            await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
            await expect(page.getByRole("alert")).toBeHidden();
            const followup: Message[] = await api(messagesPath);
            const ordinaryAnswer = followup.at(-1)!;
            assert.equal(ordinaryAnswer.role, "assistant");
            assert(
              !ordinaryAnswer.parts.some(
                (part) =>
                  part.type === "data-skill" ||
                  (part.type === "text" && part.text?.includes(skillMarker)),
              ),
              "An ordinary follow-up must not inherit the explicit skill instruction or receipt",
            );
            await expect(page.getByText(`Used /${skillName}`, { exact: true })).toHaveCount(1);
            skillEvidence.ordinaryTurn = { messageId: ordinaryAnswer.id, inheritedSkill: false };
            rejectNextResponse = true;
            const retryMarker = `recovered-${randomBytes(4).toString("hex")}`;
            await composer.fill(`Reply with "${retryMarker}" only. Do not call tools.`);
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await expect(page.getByRole("alert")).toBeVisible();
            let failedMessageId: string | undefined;
            await waitFor(stage, 120_000, async () => {
              const messages: Message[] = await api(messagesPath);
              const last = messages.at(-1);
              if (
                last?.role === "assistant" &&
                last.parts.some((part) => part.type === "text" && part.text?.includes(retryMarker))
              ) {
                failedMessageId = last.id;
                return true;
              }
              return false;
            });
            await page.getByRole("button", { name: "Try again", exact: true }).click();
            await waitFor(stage, 120_000, async () => {
              const messages: Message[] = await api(messagesPath);
              const last = messages.at(-1);
              return (
                last?.role === "assistant" &&
                last.id !== failedMessageId &&
                last.parts.some((part) => part.type === "text" && part.text?.includes(retryMarker))
              );
            });
            await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
            await expect(page.getByRole("alert")).toBeHidden();
            await expect(page.getByRole("list", { name: "Conversation" })).toContainText(
              retryMarker,
            );
            const declinedTitle = `Declined ${title}`;
            await composer.fill(
              `Create one task in owner ${persona}, team ${teamKey}, titled "${declinedTitle}". Ask for my approval.`,
            );
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
            const beforeRedirect: Message[] = await api(messagesPath);
            const declined = beforeRedirect.findLast((message) =>
              message.parts.some((part) => part.state === "approval-requested"),
            );
            assert(declined);
            const redirectMarker = `redirected-${randomBytes(4).toString("hex")}`;
            await composer.fill(
              `Do not create that issue. Reply with "${redirectMarker}" only instead.`,
            );
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await waitFor(stage, 120_000, async () => {
              const messages: Message[] = await api(messagesPath);
              const last = messages.at(-1);
              return (
                last?.role === "assistant" &&
                last.id !== declined.id &&
                last.parts.some(
                  (part) => part.type === "text" && part.text?.includes(redirectMarker),
                )
              );
            });
            await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
            await expect(page.getByRole("alert")).toBeHidden();
            assert.equal(
              (await api(`/tracker/${persona}/snapshot`)).issues.filter(
                (issue: { title: string }) => issue.title === declinedTitle,
              ).length,
              0,
              "A replacement prompt must not authorize the pending write",
            );
            await page.reload();
            await expect(page.getByRole("list", { name: "Conversation" })).toContainText(title);
            await expect(page.getByRole("alert")).toBeHidden();
            await expect(page.getByText(`Used /${skillName}`, { exact: true })).toHaveCount(1);
            assert.equal(
              (await matchingIssues()).length,
              1,
              "Follow-ups and retries must not replay the write",
            );
            const retained: Message[] = await api(messagesPath);
            assert(
              !retained
                .find((message) => message.id === declined.id)
                ?.parts.some((part) => part.type === "text" && part.text?.includes(redirectMarker)),
              "A replacement prompt must not also generate a reply on the declined turn",
            );
            const receipt = retained
              .find((message) => message.id === approval.id)
              ?.parts.find((part) => part.toolCallId === call.toolCallId);
            assert.equal(
              receipt?.state,
              "output-available",
              "Continuation must retain the original tool result",
            );
            assert.equal(receipt?.output?.created, created[0].key);
            const retainedSkills = retained.flatMap((message) =>
              message.parts.filter((part) => part.type === "data-skill"),
            );
            assert.equal(
              retainedSkills.length,
              1,
              "Continuation and reload must not duplicate skills",
            );
            assert.deepEqual(retainedSkills[0]!.data, pendingSkills[0]!.data);
            skillEvidence.reloadRetainedInvocation = retainedSkills[0]!.data;
            skillEvidence.writeCount = created.length;
            skillEvidence.outcome = "passed";
            assert.equal(
              new Set(retained.map((message) => message.id)).size,
              retained.length,
              "Continuation must not duplicate assistant message IDs",
            );
            evidence.assistantApproval = {
              chatId,
              messageId: approval.id,
              toolCallId: call.toolCallId,
              issue: created[0].key,
              followupRetainedHistory: true,
              retryRecovered: true,
              redirectSkippedWrite: true,
              skill: skillEvidence,
            };
            enter("assistant-between-steps");
            // CORE-87: once a tool returns, the chat says the turn is still
            // working, and asks the small status model for the words.
            chunks.length = 0;
            await composer.fill(
              `Use show_issue to read ${created[0].key} in owner ${persona}, then reply with its title.`,
            );
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await waitFor(stage, 120_000, async () => {
              const messages: Message[] = await api(messagesPath);
              const last = messages.at(-1);
              return (
                last?.role === "assistant" &&
                last.parts.some((part) => part.type === "tool-show_issue") &&
                last.parts.some((part) => part.type === "text" && part.text?.includes(title))
              );
            });
            await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
            const toolReturned = chunks.findIndex(
              (chunk) => chunk.type === "tool-output-available",
            );
            assert(toolReturned >= 0, "The between-steps turn must call a tool");
            const statuses = chunks
              .slice(toolReturned + 1)
              .filter((chunk) => chunk.type === "data-status")
              .map((chunk) => chunk.data?.text ?? "");
            assert(
              statuses.includes("Thinking"),
              `A status must follow the tool's result, before the next step: ${JSON.stringify(chunks.map((c) => c.type))}`,
            );
            evidence.assistantProgress = { chatId, statuses };
          }
          if (want("avatars")) {
            begin("avatars");
            enter("avatar-generation");
            // A real person's cookie session is required: agent bearer tokens cannot
            // spend their one-time image generation allowance.
            const before = await context.request.get("/api/account/avatar/options");
            assert.equal(before.status(), 200);
            assert.equal((await before.json()).status, "none");
            const generated = await context.request.post("/api/account/avatar/options", {
              timeout: 240_000,
            });
            assert.equal(generated.status(), 201, "Real avatar generation must succeed");
            const options = (await generated.json()) as { status: string; options: string[] };
            assert.equal(options.status, "ready");
            // The API retains partial success when a provider refuses one style.
            generatedAvatarCount = options.options.length;
            assert(generatedAvatarCount >= 1 && generatedAvatarCount <= 4);
            const images = [];
            for (const path of options.options) {
              assert.match(path, /^\/api\/account\/avatar\/options\/[0-3]$/);
              const image = await context.request.get(path);
              assert.equal(image.status(), 200);
              assert.match(image.headers()["content-type"] ?? "", /^image\/(jpeg|png|webp)$/);
              const bytes = await image.body();
              const dimensions = await page.evaluate(
                async ({ bytes, type }) => {
                  const bitmap = await createImageBitmap(
                    new Blob([new Uint8Array(bytes)], { type }),
                  );
                  const result = { width: bitmap.width, height: bitmap.height };
                  bitmap.close();
                  return result;
                },
                { bytes: [...bytes], type: image.headers()["content-type"]! },
              );
              assert(
                dimensions.width > 0 && dimensions.height > 0,
                "Avatar must decode as an image",
              );
              images.push({ path, bytes: bytes.length, ...dimensions });
            }
            evidence.avatars = { status: options.status, images };
          }
        } finally {
          await page
            .screenshot({ path: join(ctx.artifacts, "assistant-approval.png"), fullPage: true })
            .catch(() => {});
          await context.tracing
            .stop({ path: join(ctx.artifacts, "assistant-approval.zip") })
            .catch(() => {});
          await browser.close();
        }
      }
      const waitForNotes = async (names: string[], exact = true) => {
        await waitFor(stage, 5 * 60_000, async () => {
          const index: ReleaseNotesIndex = await api(`${base}/release-notes`);
          evidence.releaseIndex = index;
          if (index.status.state === "failed")
            throw new Error("Release-note generation failed; see provider evidence");
          return (
            index.status.state === "ready" &&
            (exact
              ? JSON.stringify(index.releases.map((release) => release.name).sort()) ===
                JSON.stringify([...names].sort())
              : names.every((name) => index.releases.some((release) => release.name === name)))
          );
        });
      };
      const notesFor = async (name: string): Promise<ReleaseNotesRelease> =>
        api(`${base}/release-notes/release?name=${encodeURIComponent(name)}`);
      // The interactive assistant is done: the Atlas fixtures' model load can't
      // rate-limit its turns now (Knowledge and release notes back off).
      searchable();
      if (want("release-notes")) {
        begin("release-notes");
        enter("release-daily-initial");
        await waitForNotes(["@day:2026-01-01"]);
        const firstDay = await notesFor("day:2026-01-01");
        evidence.initialDailyNotes = firstDay;
        assert.equal(firstDay.release.kind, "daily");
        assert.equal(firstDay.release.toOid, final);
        assert.equal(firstDay.release.lastCommitAt, "2026-01-01T00:00:00.000Z");
        assert.deepEqual(
          firstDay.entries.map((entry) => entry.commits),
          [[final]],
        );
        assert.equal(firstDay.entries[0]?.model, "@cf/zai-org/glm-5.3-flash");
        assert.match(
          `${firstDay.entries[0]?.title} ${firstDay.entries[0]?.summary}`,
          /checksum|65521/i,
          "Daily notes must describe the committed checksum behavior",
        );
      }
      if (needsEdit) {
        begin("knowledge-edit");
        enter("knowledge-edit");
        // A meaningful edit re-analyzes checksum.ts; the concepts it still deals
        // with must keep their names, or every edit becomes new concepts to align.
        const conceptsOf = (g: {
          nodes: { id: string; kind: string; path: string; data: { topics?: string[] } }[];
          edges: { src: string; dst: string; kind: string }[];
        }) => {
          const node = g.nodes.find((n) => n.kind === "file" && n.path === "checksum.ts");
          assert(node, "Graph lacks the fixture file");
          const linked = g.edges
            .filter((e) => e.src === node.id && e.kind === "mentions")
            .map((e) => e.dst.replace(/^concept:/, ""));
          const topics = (node.data.topics ?? []).map((t) => t.toLowerCase());
          return [...new Set([...linked, ...topics])].sort();
        };
        const conceptsBefore = conceptsOf(graph);
        await writeFile(
          join(work, "checksum.ts"),
          "/** Copper Finch parcel checksum: UTF-16 code units modulo 65521. */\nexport function copperFinchChecksum(parcel: string): number {\n  let checksum = 0;\n  for (let i = 0; i < parcel.length; i++) checksum = (checksum + parcel.charCodeAt(i)) % 65521;\n  return checksum;\n}\n\n/** Whether a received parcel still matches the checksum sent with it. */\nexport function copperFinchVerify(parcel: string, expected: number): boolean {\n  return copperFinchChecksum(parcel) === expected;\n}\n",
        );
        // Authorship stays on Jan 1; the new daily group must follow the committer date.
        env.GIT_COMMITTER_DATE = "2026-01-02T00:00:00Z";
        await git([
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "-am",
          "Verify Copper Finch parcels",
        ]);
        await git(["push", "origin", "main"], work, true);
        edited = await git(["rev-parse", "HEAD"]);
        let editBuild: { stats: BuildStats } | undefined;
        await waitFor(stage, 12 * 60_000, async () => {
          const status = await api(`${base}/knowledge/status`);
          if (status.state === "failed")
            throw new Error("Knowledge build of the edit failed; see redacted provider evidence");
          editBuild = status.recent.find(
            (entry: { toCommit: string; status: string }) =>
              entry.toCommit === edited && entry.status === "succeeded",
          );
          return status.state === "up-to-date" && status.indexedCommit === edited;
        });
        // A cosmetic verdict would reuse the old card and prove nothing about naming.
        assert.equal(editBuild?.stats.analyzed, 1, "The edit was not re-analyzed by the model");
        // The push is an update, not a rebuild (CORE-286): driven by its diff,
        // metered, and asking the model far less than the full build did.
        assert.equal(
          editBuild?.stats.mode,
          "update",
          "A push must update Knowledge, not rebuild it",
        );
        assert(editBuild?.stats.aiUsage, "The update metered no calls");
        assert(
          editBuild.stats.aiUsage.calls < (knowledgeUpdates.full?.aiUsage.calls ?? 0),
          "An update asked the model as much as a full rebuild",
        );
        knowledgeUpdates.edit = { mode: editBuild.stats.mode, aiUsage: editBuild.stats.aiUsage };
        const editedGraph = await api(`${base}/knowledge/graph/export`);
        assert(
          editedGraph.nodes.some(
            (n: { kind: string; name: string }) =>
              n.kind === "symbol" && n.name === "copperFinchVerify",
          ),
          "Graph lacks the symbol the edit added",
        );
        assert.equal(editBuild?.stats.ai?.models.task, "@cf/zai-org/glm-5.3-flash");
        assert.equal(editBuild?.stats.ai?.features.wiki, false);
        assert.equal(editBuild?.stats.ai?.features.atlas, false);
        assert.equal(
          editBuild?.stats.atlasSpend?.calls,
          0,
          "Disabled Atlas descriptions spent calls",
        );
        const retainedWiki = await api(`${base}/knowledge/wiki/page?slug=overview`);
        assert.equal(
          retainedWiki.generatedIn,
          final,
          "Disabled wiki generation rewrote an old page",
        );
        assert.equal(
          retainedWiki.body,
          page.body,
          "Disabling wiki must preserve its readable content",
        );
        aiSettingsEvidence.successorPolicy = editBuild?.stats.ai;
        aiSettingsEvidence.disabledAtlasSpend = editBuild?.stats.atlasSpend;
        aiSettingsEvidence.retainedWikiCommit = retainedWiki.generatedIn;
        // Restore generation for the subsequent ordinary push and timeline scenarios.
        await api(settingsPath, "PATCH", { features: { wiki: true, atlas: true } });
        const conceptsAfter = conceptsOf(editedGraph);
        const kept = conceptsBefore.filter((c) => conceptsAfter.includes(c));
        evidence.conceptRetention = {
          before: conceptsBefore,
          after: conceptsAfter,
          kept,
          analyzed: editBuild?.stats.analyzed,
          reused: editBuild?.stats.reused,
        };
        assert(conceptsBefore.length > 0, "The fixture file named no concepts");
        assert(
          kept.length * 2 >= conceptsBefore.length,
          "A meaningful edit renamed most of the file's concepts",
        );
        passed("knowledge-edit");
      }
      if (want("release-notes")) {
        begin("release-notes");
        enter("release-daily-rollover");
        await waitForNotes(["@day:2026-01-01", "@day:2026-01-02"]);
        const secondDay = await notesFor("day:2026-01-02");
        assert.equal(secondDay.release.kind, "daily");
        assert.equal(secondDay.release.toOid, edited);
        assert.equal(secondDay.release.lastCommitAt, "2026-01-02T00:00:00.000Z");
        assert.deepEqual(
          secondDay.entries.map((entry) => entry.commits),
          [[edited]],
        );
        assert.equal(secondDay.entries[0]?.lastCommitAt, "2026-01-02T00:00:00.000Z");
        assert(secondDay.entries[0]?.model, "Rollover notes must record the real generation model");
        assert.match(
          `${secondDay.entries[0]?.title} ${secondDay.entries[0]?.summary}`,
          /verif|validat|match|integrity|check/i,
          "Rollover notes must describe parcel verification",
        );
        assert.deepEqual(
          (await notesFor("day:2026-01-01")).entries.map((entry) => entry.commits),
          [[final]],
          "A new day must retain the earlier day's commit provenance",
        );
        evidence.rolloverDailyNotes = secondDay;
        enter("release-tag-checkpoint");
        await git(["tag", "-a", "provider-v1", "-m", "Copper Finch named checkpoint"]);
        await git(["push", "origin", "refs/tags/provider-v1"], work, true);
        await waitForNotes(["@day:2026-01-01", "@day:2026-01-02", "provider-v1"]);
        const tagged = await notesFor("provider-v1");
        assert.equal(tagged.release.kind, "tag");
        assert.equal(tagged.release.toOid, edited);
        assert.deepEqual(
          tagged.entries.flatMap((entry) => entry.commits).sort(),
          [final, edited].sort(),
        );
        const feed: ReleaseFeed = await api(
          `/tracker/${owner}/release-notes?q=${encodeURIComponent(`repo:${owner}/${name}`)}`,
        );
        assert.deepEqual(
          feed.entries.flatMap((entry) => entry.commits).sort(),
          [final, edited].sort(),
        );
        assert(feed.entries.every((entry) => entry.releaseKind === "daily"));
        const tagFeed: ReleaseFeed = await api(
          `/tracker/${owner}/release-notes?q=${encodeURIComponent(`repo:${owner}/${name} release:provider-v1`)}`,
        );
        assert.deepEqual(
          tagFeed.entries.flatMap((entry) => entry.commits).sort(),
          [final, edited].sort(),
        );
        assert(tagFeed.entries.every((entry) => entry.releaseKind === "tag"));
        evidence.taggedNotes = tagged;
        evidence.releaseFeeds = { daily: feed.entries, tag: tagFeed.entries };
        enter("release-issue-tracker");
        // A tracker issue, completed with evidence in a workspace subscribed to
        // the fixture, that the next commit cites by key.
        const repo = await api(base);
        const operation = () => `provider-${randomBytes(8).toString("hex")}`;
        await api(`/tracker/${owner}/mutate`, "POST", {
          operationId: operation(),
          mutations: [
            { kind: "team.create", id: "copper-team", data: { key: "CF", name: "Copper Finch" } },
            { kind: "workspace.create", id: "copper-ws", data: { slug: "copper", name: "Copper" } },
            {
              kind: "subscription.add",
              id: "copper-sub",
              data: { workspaceId: "copper-ws", repoId: repo.id },
            },
            {
              kind: "issue.create",
              id: "copper-issue",
              data: {
                teamId: "copper-team",
                title: "Let receivers verify a batch of Copper Finch parcels",
                description:
                  "Receivers check many parcels at once. Add copperFinchVerifyAll, which is true only when every parcel matches its expected checksum.",
              },
            },
          ],
        });
        const claim = await api(`/tracker/${owner}/mutate`, "POST", {
          operationId: operation(),
          mutations: [{ kind: "issue.claim", id: "copper-issue", data: { agent: "provider-e2e" } }],
        });
        await api(`/tracker/${owner}/mutate`, "POST", {
          operationId: operation(),
          mutations: [
            {
              kind: "issue.complete",
              id: "copper-issue",
              data: {
                leaseToken: claim.results[0].leaseToken,
                evidence: "copperFinchVerifyAll checks every parcel against its checksum.",
              },
            },
          ],
        });
      }
      if (want("release-notes") || want("overlays") || want("timeline-pages")) {
        // The commit citing CF-1: release notes assert its entry; the timelines fork around it.
        begin(
          want("release-notes")
            ? "release-notes"
            : want("overlays")
              ? "overlays"
              : "timeline-pages",
        );
        enter(want("release-notes") ? "release-issue-entry" : "cited-commit");
        await writeFile(
          join(work, "verify-all.ts"),
          'import { copperFinchVerify } from "./checksum.ts";\n\n/** Whether every parcel matches its expected Copper Finch checksum. */\nexport function copperFinchVerifyAll(parcels: [string, number][]): boolean {\n  return parcels.every(([parcel, expected]) => copperFinchVerify(parcel, expected));\n}\n',
        );
        env.GIT_COMMITTER_DATE = "2026-01-03T00:00:00Z";
        await git(["add", "verify-all.ts"]);
        await git([
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "-m",
          "Verify a batch of Copper Finch parcels (CF-1)",
        ]);
        await git(["push", "origin", "main"], work, true);
        cited = await git(["rev-parse", "HEAD"]);
      }
      if (want("release-notes")) {
        await waitForNotes([
          "@day:2026-01-01",
          "@day:2026-01-02",
          "@day:2026-01-03",
          "provider-v1",
        ]);
        const thirdDay = await notesFor("day:2026-01-03");
        const issueEntry = thirdDay.entries.find((entry) => entry.issue?.key === "CF-1");
        evidence.issueNotes = thirdDay;
        assert(
          issueEntry,
          "A commit citing a completed tracker issue must become that issue's entry",
        );
        assert.equal(issueEntry.kind, "issue");
        assert.equal(issueEntry.issue!.trackerOwner, owner);
        assert.equal(issueEntry.issue!.team.key, "CF");
        assert.deepEqual(issueEntry.commits, [cited], "The issue entry must cite the commit");
        assert.equal(issueEntry.model, "@cf/zai-org/glm-5.3-flash");
        assert.notEqual(
          issueEntry.category,
          "internal",
          "A new verification function is not internal work",
        );
        // Internal-only seed releases legitimately omit introductions. This
        // user-facing release must actually exercise the newly selected Task model.
        assert.equal(thirdDay.release.introModel, "@cf/zai-org/glm-5.3-flash");
        assert.match(
          `${issueEntry.title} ${issueEntry.summary}`,
          /verif|check|match/i,
          "The issue entry must describe verifying parcels against checksums",
        );
        assert.match(
          `${issueEntry.title} ${issueEntry.summary}`,
          /batch|all|every|multiple|several|many/i,
          "The issue entry must describe checking several parcels at once",
        );
        assert.deepEqual(
          (await notesFor("provider-v1")).entries.flatMap((entry) => entry.commits).sort(),
          [final, edited].sort(),
          "Work after a named tag must not change that tag's notes",
        );
        const teamFeed: ReleaseFeed = await api(
          `/tracker/${owner}/release-notes?q=${encodeURIComponent("team:cf")}`,
        );
        evidence.teamFeed = teamFeed.entries;
        assert(
          teamFeed.entries.some(
            (entry) => entry.issue?.key === "CF-1" && entry.commits.includes(cited),
          ),
          "The team's release feed must include the shipped issue",
        );
        passed("release-notes");
      }
      if (want("overlays") || want("timeline-pages")) {
        begin(want("overlays") ? "overlays" : "timeline-pages");
        enter("knowledge-timeline-overlay");
        // Owned work pushes update only their source's graph diff and wiki.
        await waitFor("knowledge-main-before-overlay", 12 * 60_000, async () => {
          const status = await api(`${base}/knowledge/status`);
          if (status.state === "failed")
            throw new Error("Knowledge build of the cited commit failed; see provider evidence");
          return status.state === "up-to-date" && status.indexedCommit === cited;
        });
        const mainView = async () => {
          const [g, wiki, status] = await Promise.all([
            api(`${base}/knowledge/graph/export`),
            api(`${base}/knowledge/wiki`),
            api(`${base}/knowledge/status`),
          ]);
          return {
            indexedCommit: status.indexedCommit as string | null,
            builds: (status.recent as { id: string }[]).map((b) => b.id).sort(),
            nodes: (g.nodes as { id: string; changedIn: string; summary: string }[])
              .map((n) => `${n.id}@${n.changedIn}:${n.summary}`)
              .sort(),
            edges: (g.edges as { src: string; dst: string; kind: string }[])
              .map((e) => `${e.src}>${e.kind}>${e.dst}`)
              .sort(),
            wiki: (wiki.pages as { slug: string; updatedAt: string }[])
              .map((p) => `${p.slug}@${p.updatedAt}`)
              .sort(),
          };
        };
        const mainBefore = await mainView();
        const canonicalRefsBefore = await git(["ls-remote", "origin"], work, true);
        const forkWork = async (slug: string, commit: string) => {
          const forked = await api(
            `/tracker/${owner}/timelines`,
            "POST",
            { slug, repos: [{ repo: `${owner}/${name}`, commit }] },
            201,
          );
          const entry = forked.timeline.repos[0] as {
            source: CodeSource;
            logicalBase: SourceSnapshot;
            bookmark: string;
          };
          assert.equal(forked.timeline.repos.length, 1);
          assert.equal(entry.source.kind, "timeline-work");
          assert.match(entry.source.sourceId, /^work_/);
          assert.equal(entry.source.timelineId, forked.timeline.id);
          assert.equal(entry.source.ref, "refs/heads/work");
          assert.equal(entry.bookmark, "work");
          assert.equal(entry.logicalBase.sourceId, "canonical");
          assert.equal(entry.logicalBase.repoId, entry.source.repoId);
          assert.equal(entry.logicalBase.commit, commit);
          assert.match(entry.logicalBase.tree, /^[0-9a-f]{40}$/);
          return {
            ...entry,
            remote: `${ctx.origin}/${owner}/${name}@${slug}.git`,
          };
        };
        type Overlay = {
          sourceId: string;
          state: string;
          commit: string | null;
          baseCommit: string | null;
          mergeBase: string | null;
          changes: { id: string; change: string; kind: string }[];
        };
        const has = (o: Overlay, change: string, id: string) =>
          o.changes.some((c) => c.change === change && c.id === id);
        // The first source, for the cross-source checks after both stages.
        let limits:
          | {
              work: Awaited<ReturnType<typeof forkWork>>;
              ref: string;
              head: string;
              overlay: Overlay;
              overlayAt: (commit: string) => Promise<Overlay>;
            }
          | undefined;
        // The second source, for the cross-source checks and its compact landing.
        let pagesInfo:
          | {
              pagesWork: Awaited<ReturnType<typeof forkWork>>;
              pagesSlug: string;
              checkpointId: string;
              pagesFirst: string;
              pagesHead: string;
              timelinePagePath: string;
              timelinePage: { body: unknown };
            }
          | undefined;
        if (want("overlays")) {
          begin("overlays");
          // Forked before verify-all.ts landed on main: the overlay must count
          // changes from the merge base, not report main's later file as removed.
          const timelineRef = "timeline/copper-limits";
          const limitsWork = await forkWork("copper-limits", edited);
          await git(["checkout", "-q", "-b", timelineRef, edited]);
          await writeFile(
            join(work, "limits.ts"),
            "/** The most parcels one Copper Finch batch may carry. */\nexport function copperFinchBatchLimit(): number {\n  return 64;\n}\n",
          );
          await git(["add", "limits.ts"]);
          await git([
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "-m",
            "Limit Copper Finch batches",
          ]);
          await git(["push", limitsWork.remote, "HEAD:refs/heads/work"], work, true);
          const timelineHead = await git(["rev-parse", "HEAD"]);
          const overlayAt = async (commit: string): Promise<Overlay> => {
            let overlay: Overlay | undefined;
            await waitFor("knowledge-overlay", 10 * 60_000, async () => {
              overlay = await api(
                `${base}/knowledge/overlay?ref=${encodeURIComponent(timelineRef)}&source=${limitsWork.source.sourceId}&limit=2000`,
              );
              if (overlay!.state === "failed")
                throw new Error("Timeline overlay failed; see provider evidence");
              return overlay!.state === "up-to-date" && overlay!.commit === commit;
            });
            assert.equal(overlay!.sourceId, limitsWork.source.sourceId);
            return overlay!;
          };
          const first = await overlayAt(timelineHead);
          evidence.overlay = {
            source: limitsWork.source,
            logicalBase: limitsWork.logicalBase,
            first,
          };
          assert.equal(
            first.baseCommit,
            cited,
            "The overlay must be measured against main's graph",
          );
          assert.equal(first.mergeBase, edited, "The overlay must count from the fork point");
          assert(has(first, "added", "file:limits.ts"), "Overlay lacks the timeline's new file");
          assert(
            has(first, "added", "sym:limits.ts#copperFinchBatchLimit"),
            "Overlay lacks the timeline's new symbol",
          );
          assert(
            !first.changes.some(
              (c) => c.id === "file:verify-all.ts" || c.id === "file:checksum.ts",
            ),
            "Main's own files must not appear in the timeline's overlay",
          );
          // A second push updates the overlay to the new head.
          await writeFile(
            join(work, "limits.ts"),
            "/** The most parcels one Copper Finch batch may carry. */\nexport function copperFinchBatchLimit(): number {\n  return 64;\n}\n\n/** Whether a batch of parcels fits in one Copper Finch batch. */\nexport function copperFinchFitsBatch(count: number): boolean {\n  return count >= 0 && count <= copperFinchBatchLimit();\n}\n",
          );
          await git([
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "-am",
            "Check Copper Finch batch size",
          ]);
          await git(["push", limitsWork.remote, "HEAD:refs/heads/work"], work, true);
          const timelineNext = await git(["rev-parse", "HEAD"]);
          const second = await overlayAt(timelineNext);
          evidence.overlay = {
            source: limitsWork.source,
            logicalBase: limitsWork.logicalBase,
            first,
            second,
          };
          assert.equal(second.baseCommit, cited);
          assert.equal(second.mergeBase, edited);
          assert(has(second, "added", "file:limits.ts"));
          assert(has(second, "added", "sym:limits.ts#copperFinchBatchLimit"));
          assert(
            !second.changes.some(
              (c) => c.id === "file:verify-all.ts" || c.id === "file:checksum.ts",
            ),
            "The second work push must still exclude canonical-only changes",
          );
          assert.equal(
            await git(["ls-remote", limitsWork.remote, "refs/heads/work"], work, true),
            `${timelineNext}\trefs/heads/work`,
            "Owned transport must expose the exact acknowledged work head",
          );
          const timelineAtlas = await api(
            `${base}/atlas/timeline?ref=${encodeURIComponent(timelineRef)}&source=${limitsWork.source.sourceId}`,
          );
          assert.equal(timelineAtlas.repos[0].sourceId, limitsWork.source.sourceId);
          assert.equal(timelineAtlas.repos[0].commit, timelineNext);
          assert(timelineAtlas.items.some((item: { path: string }) => item.path === "limits.ts"));
          assert(
            !timelineAtlas.items.some((item: { path: string }) => item.path === "verify-all.ts"),
          );
          (evidence.overlay as Record<string, unknown>).atlas = timelineAtlas;
          assert(
            has(second, "added", "sym:limits.ts#copperFinchFitsBatch"),
            "The overlay did not follow the timeline's second push",
          );
          const listed = await api(
            `${base}/knowledge/overlays?source=${limitsWork.source.sourceId}`,
          );
          assert(
            listed.overlays.some(
              (o: { ref: string; commit: string; sourceId: string }) =>
                o.ref === timelineRef &&
                o.commit === timelineNext &&
                o.sourceId === limitsWork.source.sourceId,
            ),
            "The overlay list must show the timeline at its head",
          );
          const mainAfter = await mainView();
          evidence.overlayMain = {
            before: mainBefore.indexedCommit,
            after: mainAfter.indexedCommit,
          };
          assert.deepEqual(
            mainAfter,
            mainBefore,
            "A timeline push changed main's graph, wiki or builds",
          );
          limits = {
            work: limitsWork,
            ref: timelineRef,
            head: timelineNext,
            overlay: second,
            overlayAt,
          };
        }
        if (want("timeline-pages")) {
          begin("timeline-pages");
          enter("knowledge-timeline-pages");
          // CORE-84: a checkpoint writes the wiki pages a timeline affects, kept
          // apart from main's wiki. A tracked timeline forked from main's tip.
          const pagesSlug = "copper-pages";
          const pagesRef = `timeline/${pagesSlug}`;
          const pagesWork = await forkWork(pagesSlug, cited);
          if (limits) assert.notEqual(pagesWork.source.sourceId, limits.work.source.sourceId);
          await git(["checkout", "-q", "-b", pagesRef, cited]);
          await writeFile(
            join(work, "receipts.ts"),
            "/** A signed receipt that a Copper Finch batch was delivered. */\nexport interface CopperFinchReceipt {\n  batch: string;\n  parcels: number;\n  signedBy: string;\n}\n\n/** Issue the delivery receipt for a verified Copper Finch batch. */\nexport function copperFinchReceipt(batch: string, parcels: number, signedBy: string): CopperFinchReceipt {\n  return { batch, parcels, signedBy };\n}\n",
          );
          await git(["add", "receipts.ts"]);
          await git([
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "-m",
            "Receipts for Copper Finch batches",
          ]);
          const pagesFirst = await git(["rev-parse", "HEAD"]);
          await writeFile(
            join(work, "receipt-valid.ts"),
            'import type { CopperFinchReceipt } from "./receipts.ts";\n/** A delivered batch must have a signer and at least one parcel. */\nexport function copperFinchReceiptValid(receipt: CopperFinchReceipt): boolean {\n  return receipt.signedBy.length > 0 && receipt.parcels > 0;\n}\n',
          );
          await git(["add", "receipt-valid.ts"]);
          await git([
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "-m",
            "Validate signed Copper Finch receipts",
          ]);
          await git(["push", pagesWork.remote, "HEAD:refs/heads/work"], work, true);
          const pagesHead = await git(["rev-parse", "HEAD"]);
          const made = await api(
            `/tracker/${owner}/timelines/${pagesSlug}/checkpoints`,
            "POST",
            { summary: "Copper Finch batches get delivery receipts." },
            201,
          );
          const checkpointId = made.checkpoint.id as string;
          const checkpointRepo = made.checkpoint.repos[0] as {
            source: SourceSnapshot;
            logicalBase: SourceSnapshot;
          };
          assert.deepEqual(checkpointRepo.logicalBase, pagesWork.logicalBase);
          assert.equal(checkpointRepo.source.sourceId, pagesWork.source.sourceId);
          assert.equal(checkpointRepo.source.commit, pagesHead);
          assert.equal(checkpointRepo.source.tree, await git(["rev-parse", "HEAD^{tree}"]));
          type PageSet = {
            sourceId: string;
            key: string;
            state: string;
            commit: string;
            baseCommit: string | null;
            counts: Record<string, { added: number; changed: number; removed: number }>;
            pages: { slug: string; outcome: string; change: string; model: string | null }[];
            error: string | null;
          };
          let set: PageSet | undefined;
          // Queued after the checkpoint's response; one model-written page or so.
          await waitFor("knowledge-timeline-pages", 12 * 60_000, async () => {
            const listed = await api(
              `${base}/knowledge/overlay/pages?ref=${encodeURIComponent(pagesRef)}&source=${pagesWork.source.sourceId}&checkpoint=${encodeURIComponent(checkpointId)}`,
            );
            set = (listed.sets as PageSet[])[0];
            if (set?.state === "failed" || set?.state === "ended")
              throw new Error(`Timeline pages ${set.state}; see provider evidence`);
            return set?.state === "succeeded";
          });
          const pages = set!;
          evidence.timelinePages = {
            source: pagesWork.source,
            logicalBase: pagesWork.logicalBase,
            key: pages.key,
            commit: pages.commit,
            baseCommit: pages.baseCommit,
            counts: pages.counts,
            pages: pages.pages,
          };
          assert.equal(pages.key, checkpointId, "The page set must belong to the checkpoint");
          assert.equal(pages.sourceId, pagesWork.source.sourceId);
          assert.equal(pages.commit, pagesHead, "The pages must describe the checkpoint's commit");
          assert.equal(pages.baseCommit, cited, "The pages must be measured against main's graph");
          const completedPagesOverlay: Overlay = await api(
            `${base}/knowledge/overlay?ref=${encodeURIComponent(pagesRef)}&source=${pagesWork.source.sourceId}&limit=2000`,
          );
          assert.equal(completedPagesOverlay.sourceId, pagesWork.source.sourceId);
          assert.equal(completedPagesOverlay.commit, pagesHead);
          assert(has(completedPagesOverlay, "added", "file:receipts.ts"));
          assert(has(completedPagesOverlay, "added", "sym:receipts.ts#copperFinchReceipt"));
          assert(
            !completedPagesOverlay.changes.some((c) => c.id.includes("limits.ts")),
            "Two owned sources using the same physical work ref must not share graph changes",
          );
          (evidence.timelinePages as Record<string, unknown>).overlay = completedPagesOverlay;
          assert(
            (pages.counts.file?.added ?? 0) >= 1,
            "The pages' diff lacks the timeline's new file",
          );
          const written = pages.pages.filter(
            (p) =>
              p.outcome === "written" &&
              (p.slug.startsWith("components/") || p.slug === "glossary"),
          );
          assert(written.length > 0, "The checkpoint wrote no component or glossary page");
          const shown = written.find((p) => p.slug.startsWith("components/")) ?? written[0]!;
          const timelinePagePath = `${base}/knowledge/overlay/page?ref=${encodeURIComponent(pagesRef)}&source=${pagesWork.source.sourceId}&slug=${encodeURIComponent(shown.slug)}&set=${encodeURIComponent(checkpointId)}`;
          const timelinePage = await api(timelinePagePath);
          (evidence.timelinePages as Record<string, unknown>).page = {
            slug: timelinePage.slug,
            model: timelinePage.model,
            generatedIn: timelinePage.generatedIn,
            body: String(timelinePage.body).slice(0, 1200),
          };
          assert.equal(timelinePage.sourceId, pagesWork.source.sourceId);
          assert.equal(
            timelinePage.generatedIn,
            pagesHead,
            "A timeline page must be written at its commit",
          );
          if (shown.slug.startsWith("components/")) {
            assert(timelinePage.model, "A timeline component page must record its model");
            assert.match(
              String(timelinePage.body),
              /receipt/i,
              "The timeline's component page must describe its new receipts",
            );
          } else
            assert.match(
              String(timelinePage.body),
              /receipt/i,
              "The glossary must describe receipts",
            );
          // The approval card shows them: the checkpoint view carries the set.
          const view = await api(`/tracker/${owner}/timelines/${pagesSlug}/checkpoints/1`);
          assert(
            (view.knowledge as { key: string; state: string }[]).some(
              (k) => k.key === checkpointId && k.state === "succeeded",
            ),
            "The checkpoint view must show the timeline's pages",
          );
          const mainFinally = await mainView();
          assert.deepEqual(
            mainFinally,
            mainBefore,
            "Writing a timeline's pages changed main's graph, wiki or builds",
          );
          pagesInfo = {
            pagesWork,
            pagesSlug,
            checkpointId,
            pagesFirst,
            pagesHead,
            timelinePagePath,
            timelinePage,
          };
        }
        if (limits && pagesInfo) {
          begin("timeline-pages");
          assert.deepEqual(
            await limits.overlayAt(limits.head),
            limits.overlay,
            "A different source's checkpoint changed the first source's overlay",
          );
        }
        assert.equal(
          await git(["ls-remote", "origin"], work, true),
          canonicalRefsBefore,
          "Owned timeline work must not create or move any canonical Git ref",
        );
        if (limits || (pagesInfo && want("release-notes"))) {
          const devFixture = async (path: string, body: Record<string, unknown>) => {
            assert(ctx.env.GITMATRIX_AGENT_SECRET, "Owned AI fixtures require the agent secret");
            const response = await fetch(`${ctx.origin}/api/dev/${path}`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${ctx.env.GITMATRIX_AGENT_SECRET}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ repo: `${owner}/${name}`, ...body }),
              signal: AbortSignal.timeout(180_000),
            });
            events.push({ stage, method: "POST", path: `/dev/${path}`, status: response.status });
            assert.equal(response.status, 200, `Owned ${path} control failed`);
            return response.json();
          };
          type KnowledgeObservation = {
            barrier: { build_id: string | null; released: number } | null;
            workflow: string | null;
            outcome: string | null;
            commit: string | null;
            roots: string[];
            vectors: { id: string; metadata: Record<string, unknown> }[];
          };
          const knowledgeFixture = (action: string, sourceId: string, extra = {}) =>
            devFixture("knowledge-fixtures", { action, sourceId, ...extra });
          if (limits) {
            begin("overlays");
            const { work: limitsWork, ref: timelineRef, head: timelineNext } = limits;
            enter("knowledge-ended-publication-fence");
            const vectorsBefore = (await knowledgeFixture("inspect", limitsWork.source.sourceId))
              .vectors;
            assert.equal(
              vectorsBefore.length,
              1,
              "Only the canonical checksum, not work limits, may have a vector",
            );
            assert.equal(vectorsBefore[0].metadata.sourceId, "canonical");
            assert.equal(vectorsBefore[0].metadata.node, "sym:checksum.ts#copperFinchChecksum");
            await knowledgeFixture("arm", limitsWork.source.sourceId);
            try {
              await git(["checkout", timelineRef]);
              await writeFile(
                join(work, "late-only.ts"),
                "/** This unpublished limit must never replace an ended timeline snapshot. */\nexport function copperFinchLateLimit(): number { return 128; }\n",
              );
              await git(["add", "late-only.ts"]);
              await git([
                "-c",
                "core.hooksPath=/dev/null",
                "commit",
                "-m",
                "Late Copper Finch limit",
              ]);
              await git(["push", limitsWork.remote, "HEAD:refs/heads/work"], work, true);
              const lateHead = await git(["rev-parse", "HEAD"]);
              let paused: KnowledgeObservation | undefined;
              await waitFor("knowledge-publication-paused", 12 * 60_000, async () => {
                const observed: KnowledgeObservation = await knowledgeFixture(
                  "inspect",
                  limitsWork.source.sourceId,
                );
                paused = observed;
                if (observed.workflow === "errored")
                  throw new Error("Late real knowledge build failed");
                return Boolean(observed.barrier?.build_id);
              });
              await api(`/tracker/${owner}/timelines/copper-limits/abandon`, "POST", {});
              const endedPath = `${base}/knowledge/overlay?ref=${encodeURIComponent(timelineRef)}&source=${limitsWork.source.sourceId}&limit=2000`;
              const ended = await api(endedPath);
              assert.equal(ended.state, "ended");
              assert.equal(ended.commit, timelineNext);
              const atlasEnded = await api(
                `${base}/atlas/timeline?ref=${encodeURIComponent(timelineRef)}&source=${limitsWork.source.sourceId}`,
              );
              await knowledgeFixture("release", limitsWork.source.sourceId);
              let finished: KnowledgeObservation | undefined;
              await waitFor("knowledge-late-build-finished", 12 * 60_000, async () => {
                const observed: KnowledgeObservation = await knowledgeFixture(
                  "inspect",
                  limitsWork.source.sourceId,
                );
                finished = observed;
                if (observed.workflow === "errored")
                  throw new Error("Late real knowledge build failed");
                return observed.workflow === "complete";
              });
              assert(finished);
              assert.equal(
                finished.outcome,
                "succeeded",
                "Late workflow must reach the real publication fence",
              );
              assert.equal(finished.commit, lateHead);
              assert.deepEqual(
                finished.roots,
                [],
                "Ended late workflow must release its source claim",
              );
              assert.deepEqual(
                await api(endedPath),
                ended,
                "Late build overwrote the ended overlay",
              );
              assert.deepEqual(
                await api(
                  `${base}/atlas/timeline?ref=${encodeURIComponent(timelineRef)}&source=${limitsWork.source.sourceId}`,
                ),
                atlasEnded,
                "Late build replaced the ended Atlas snapshot",
              );
              assert.deepEqual(
                finished.vectors,
                vectorsBefore,
                "Work source contaminated canonical vectors",
              );
              assert.deepEqual(
                await mainView(),
                mainBefore,
                "Late work changed canonical graph/pages",
              );
              evidence.endedKnowledge = { lateHead, paused, finished, ended, atlas: atlasEnded };
            } finally {
              await knowledgeFixture("delete", limitsWork.source.sourceId);
            }
          }
          // Compact landing's release notes need the release-notes stage's generation on.
          if (pagesInfo && want("release-notes")) {
            begin("timeline-pages");
            const {
              pagesWork,
              pagesSlug,
              checkpointId,
              pagesFirst,
              pagesHead,
              timelinePagePath,
              timelinePage,
            } = pagesInfo;
            enter("release-compact-landing");
            await api(`/tracker/${owner}/mutate`, "POST", {
              operationId: `provider-${randomBytes(8).toString("hex")}`,
              mutations: [
                {
                  kind: "issue.create",
                  id: "copper-receipt-issue",
                  data: { teamId: "copper-team", title: "Ship signed batch receipts" },
                },
                {
                  kind: "request.open",
                  id: "copper-receipt-approval",
                  data: {
                    issueId: "copper-receipt-issue",
                    kind: "approval",
                    prompt: "Land the exact signed receipt checkpoint.",
                    checkpoint: checkpointId,
                  },
                },
              ],
            });
            const approvalBrowser = await chromium.launch({ headless: true });
            try {
              const context = await approvalBrowser.newContext({ baseURL: ctx.origin });
              const page = await context.newPage();
              await page.goto("/signin");
              await page.getByRole("button", { name: /Continue as marco/i }).click();
              await page.waitForURL((url) => url.pathname !== "/signin");
              const approved = await context.request.post(`/api/tracker/${owner}/mutate`, {
                headers: { origin: ctx.origin },
                data: {
                  operationId: `provider-${randomBytes(8).toString("hex")}`,
                  mutations: [
                    {
                      kind: "request.answer",
                      id: "copper-receipt-approval",
                      data: { approved: true },
                    },
                  ],
                },
              });
              assert.equal(
                approved.status(),
                200,
                "A real person must approve the exact checkpoint",
              );
            } finally {
              await approvalBrowser.close();
            }
            let compactLanding: Landing | null = null;
            await waitFor("compact-landing", 12 * 60_000, async () => {
              compactLanding = (await api(`/tracker/${owner}/timelines/${pagesSlug}/landing`))
                .landing;
              if (
                compactLanding &&
                ["failed", "conflict", "partly_landed", "blocked_dependency"].includes(
                  compactLanding.state,
                )
              )
                throw new Error(`Compact AI fixture landing ${compactLanding.state}`);
              return compactLanding?.state === "landed";
            });
            await git(["fetch", "origin", "main"], work, true);
            const compactOid = await git(["rev-parse", "FETCH_HEAD"]);
            assert.equal(await git(["show", "-s", "--format=%P", compactOid]), cited);
            assert.equal(await git(["rev-list", "--count", `${cited}..${compactOid}`]), "1");
            await git(["tag", "provider-compact", compactOid]);
            await git(["push", "origin", "refs/tags/provider-compact"], work, true);
            await waitForNotes(["provider-compact"], false);
            const compactNotes = await notesFor("provider-compact");
            const compactEntry = compactNotes.entries.find((entry) =>
              entry.commits.includes(compactOid),
            );
            assert(compactEntry?.model, "Compact landing must generate real model-written notes");
            assert.equal(compactEntry.kind, "landing");
            assert.equal(compactEntry.timeline?.kind, "compact");
            assert.deepEqual(compactEntry.commits, [compactOid]);
            assert.deepEqual(
              compactEntry.provenance?.[0]?.commits.slice().sort(),
              [pagesFirst, pagesHead].sort(),
            );
            assert.equal(compactEntry.provenance?.[0]?.source.sourceId, pagesWork.source.sourceId);
            assert.equal(compactEntry.provenance?.[0]?.source.commit, pagesHead);
            assert.match(`${compactEntry.title} ${compactEntry.summary}`, /receipt/i);
            for (const oid of [pagesFirst, pagesHead]) {
              await api(`${base}/commits?source=${pagesWork.source.sourceId}&ref=${oid}`);
              await api(`${base}/commits?ref=${oid}`, "GET", undefined, 404);
            }
            const compactRange = await api(
              `${base}/release-notes/range?from=${cited}&to=${compactOid}`,
            );
            enter("release-source-purge-regeneration");
            const purge = await devFixture("source-retention", {
              action: "expire",
              timeline: pagesSlug,
            });
            await api(
              `${base}/commits?source=${pagesWork.source.sourceId}&ref=${pagesHead}`,
              "GET",
              undefined,
              410,
            );
            const retainedPage = await api(timelinePagePath);
            assert.equal(retainedPage.sourceId, pagesWork.source.sourceId);
            assert.equal(retainedPage.generatedIn, pagesHead);
            assert.equal(
              retainedPage.body,
              timelinePage.body,
              "Source expiry removed independently retained wiki output",
            );
            assert.deepEqual(
              await api(`${base}/release-notes/range?from=${cited}&to=${compactOid}`),
              compactRange,
              "Source purge lost retained compact grouping",
            );
            const regeneration = await knowledgeFixture("regenerate", pagesWork.source.sourceId, {
              landing: compactOid,
            });
            await waitForNotes(["provider-compact"], false);
            let regenerated: ReleaseNoteEntry | undefined;
            await waitFor("compact-notes-regenerated", 12 * 60_000, async () => {
              regenerated = (await notesFor("provider-compact")).entries.find((entry) =>
                entry.commits.includes(compactOid),
              );
              return Boolean(regenerated?.model && regenerated.id !== compactEntry.id);
            });
            assert(regenerated);
            assert.equal(regenerated.kind, compactEntry.kind);
            assert.deepEqual(regenerated.commits, compactEntry.commits);
            assert.deepEqual(regenerated.provenance, compactEntry.provenance);
            assert.deepEqual(regenerated.timeline, compactEntry.timeline);
            assert.match(`${regenerated.title} ${regenerated.summary}`, /receipt/i);
            evidence.compactRelease = {
              landing: compactLanding,
              compactOid,
              workCommits: [pagesFirst, pagesHead],
              before: compactEntry,
              after: regenerated,
              range: compactRange,
              retainedPage: {
                sourceId: retainedPage.sourceId,
                generatedIn: retainedPage.generatedIn,
                body: retainedPage.body,
              },
              purge,
              regeneration,
            };
            enter("release-historical-merge-grouping");
            // Import a real two-parent history shape; compact landing must not reinterpret it.
            env.GIT_COMMITTER_DATE = new Date().toISOString();
            await git(["checkout", "-q", "-b", "historical-receipts", compactOid]);
            await writeFile(
              join(work, "receipt-label.ts"),
              "/** Render a signed delivery receipt label. */\nexport function copperFinchReceiptLabel(batch: string): string { return `Receipt: ${batch}`; }\n",
            );
            await git(["add", "receipt-label.ts"]);
            await git([
              "-c",
              "core.hooksPath=/dev/null",
              "commit",
              "-m",
              "Label delivery receipts",
            ]);
            const historicalWork = await git(["rev-parse", "HEAD"]);
            await git(["checkout", "-q", "-B", "main", compactOid]);
            await git([
              "-c",
              "core.hooksPath=/dev/null",
              "merge",
              "--no-ff",
              "historical-receipts",
              "-m",
              "Merge branch 'historical-receipts'",
            ]);
            const historicalMerge = await git(["rev-parse", "HEAD"]);
            assert.equal(
              await git(["show", "-s", "--format=%P", historicalMerge]),
              `${compactOid} ${historicalWork}`,
            );
            await git(["push", "origin", "main"], work, true);
            await git(["tag", "provider-historical"]);
            await git(["push", "origin", "refs/tags/provider-historical"], work, true);
            await waitForNotes(["provider-historical"], false);
            const historical = await notesFor("provider-historical");
            const historicalEntry = historical.entries.find((entry) =>
              entry.commits.includes(historicalWork),
            );
            assert(historicalEntry?.model, "Historical real merges must still generate notes");
            assert.equal(historicalEntry.kind, "landing");
            assert.equal(historicalEntry.timeline?.landing, historicalMerge);
            assert.notEqual(historicalEntry.timeline?.kind, "compact");
            assert.equal(historicalEntry.provenance?.length ?? 0, 0);
            assert.match(`${historicalEntry.title} ${historicalEntry.summary}`, /receipt|label/i);
            const retainedCompact = (await notesFor("provider-compact")).entries.find((entry) =>
              entry.commits.includes(compactOid),
            );
            assert(retainedCompact);
            assert.deepEqual(retainedCompact.commits, regenerated.commits);
            assert.deepEqual(retainedCompact.provenance, regenerated.provenance);
            assert.deepEqual(retainedCompact.timeline, regenerated.timeline);
            evidence.historicalMergeRelease = {
              historicalWork,
              historicalMerge,
              entry: historicalEntry,
            };
          }
        }
        if (want("overlays")) passed("overlays");
        if (want("timeline-pages")) passed("timeline-pages");
      }
      // Each stage that calls models through the Gateway passes only once its records do.
      // CORE-290: agent environments keep bodies by default, and the persona
      // turned them off for its own assistant titles and status lines.
      const requirements: {
        stage: CopperFinchStage;
        key: string;
        component: string;
        model?: string;
        minimum: number;
        bodies?: boolean;
      }[] = [
        ...(want("knowledge")
          ? [
              {
                stage: "knowledge" as const,
                key: "knowledge",
                component: "knowledge",
                model: capturedAi!.models.task,
                minimum: 1,
                bodies: true,
              },
              {
                stage: "knowledge" as const,
                key: "embedding",
                component: "knowledge",
                model: "@cf/qwen/qwen3-embedding-0.6b",
                minimum: 1,
              },
            ]
          : []),
        ...(want("assistant")
          ? [
              {
                stage: "assistant" as const,
                key: "assistant",
                component: "assistant",
                minimum: 1,
                bodies: true,
              },
              {
                stage: "assistant" as const,
                key: "assistant-title",
                component: "assistant-title",
                minimum: 1,
                bodies: false,
              },
              {
                stage: "assistant" as const,
                key: "assistant-status",
                component: "assistant-status",
                minimum: 1,
                bodies: false,
              },
            ]
          : []),
        ...(want("avatars")
          ? [
              {
                stage: "avatars" as const,
                key: "avatars",
                component: "avatars",
                model: "@cf/black-forest-labs/flux-1-schnell",
                minimum: generatedAvatarCount,
              },
            ]
          : []),
      ];
      if (requirements.length) {
        enter("gateway-evidence");
        const owned = await ownedEnvironment();
        const gatewayEvidence: Record<string, unknown> = {
          id: owned.id,
          since: evidence.startedAt,
          // Cloudflare's built-in AI Search embedding/reranking are not Gateway logged.
          excluded: ["AI Search built-in embedding", "AI Search built-in reranking"],
        };
        evidence.gateway = gatewayEvidence;
        for (const requirement of requirements) {
          begin(requirement.stage);
          await waitFor(`gateway-${requirement.key}`, 120_000, async () => {
            const { logs } = await gatewayLogs(
              owned,
              String(evidence.startedAt),
              requirement.component,
              requirement.model,
            );
            const successful = logs.filter(
              (log) =>
                log.success &&
                !log.cached &&
                (requirement.component !== "assistant" ||
                  log.responseContentType === "text/event-stream"),
            );
            gatewayEvidence[requirement.key] = {
              observedCount: logs.length,
              successfulUncachedCount: successful.length,
              tokensIn: logs.reduce((sum, log) => sum + (log.tokensIn ?? 0), 0),
              tokensOut: logs.reduce((sum, log) => sum + (log.tokensOut ?? 0), 0),
              cost: logs.reduce((sum, log) => sum + (log.cost ?? 0), 0),
              logs,
            };
            if (requirement.key === "avatars") {
              if (logs.length < 4 || successful.length < generatedAvatarCount) return false;
              assert(logs.length <= 10, "Avatar inference must stay within its ten-call budget");
              assert.equal(
                successful.length,
                generatedAvatarCount,
                "Successful Gateway calls must match the returned avatar images",
              );
            }
            return successful.length >= requirement.minimum;
          });
          if (requirement.bodies !== undefined) {
            // A few successful calls' bodies: kept, or not, as their settings
            // say. Bodies can land a while after a log's metadata, so a kept
            // one is waited for (any of the first few; a very large request
            // may not be stored whole), and none may appear where they're off.
            const { logs } = await gatewayLogs(
              owned,
              String(evidence.startedAt),
              requirement.component,
              requirement.model,
            );
            const inspected = logs.filter((entry) => entry.success && !entry.cached).slice(0, 3);
            assert(inspected.length, `${requirement.key}: no successful Gateway log to inspect`);
            const seen: Record<string, Awaited<ReturnType<typeof gatewayBodies>>> = {};
            const deadline = Date.now() + 180_000;
            for (;;) {
              for (const log of inspected) seen[log.id] = await gatewayBodies(owned, log.id);
              const kept = Object.values(seen).some((b) => b.request && b.response);
              if (!requirement.bodies || kept || Date.now() > deadline) break;
              await delay(10_000);
            }
            (gatewayEvidence[requirement.key] as Record<string, unknown>).bodies = {
              expected: requirement.bodies,
              logs: seen,
            };
            if (requirement.bodies)
              assert(
                Object.values(seen).some((b) => b.request && b.response),
                `${requirement.key}: the Gateway logs must keep request and response bodies`,
              );
            else
              assert(
                Object.values(seen).every((b) => b.request === null && b.response === null),
                `${requirement.key}: the Gateway logs must not keep request or response bodies`,
              );
          }
        }
        for (const requirement of requirements) passed(requirement.stage);
      }
      if (want("knowledge")) {
        // CORE-285: what the app records equals what the gateway saw, per
        // feature and model, for the fixture repository's owner: every
        // knowledge, edit, overlay, page-set and release-note call this run made.
        begin("knowledge");
        enter("usage-reconciliation");
        const owned = await ownedEnvironment();
        const usageEvidence: Record<string, unknown> = {};
        evidence.usageReconciliation = usageEvidence;
        const appUsage = async () => {
          const response = await fetch(
            `${ctx.origin}/api/dev/ai-usage?since=${String(evidence.startedAt).slice(0, 10)}`,
            {
              headers: { authorization: `Bearer ${ctx.env.GITMATRIX_AGENT_SECRET ?? ""}` },
              signal: AbortSignal.timeout(60_000),
            },
          );
          assert.equal(response.status, 200, "Reading the app's AI usage failed");
          return ((await response.json()) as { usage: UsageRow[] }).usage;
        };
        const ownerAccount = (await appUsage()).find((row) => row.slug === owner)?.account_id;
        assert(ownerAccount, `The fixture owner ${owner} recorded no AI usage`);
        usageEvidence.account = ownerAccount;
        let rows: ReturnType<typeof reconcileUsage>["rows"] = [];
        await waitFor("usage-reconciliation", 180_000, async () => {
          // Release notes log under their own component (CORE-290's componentOf).
          const logs = (
            await Promise.all(
              ["knowledge", "release-notes"].map((component) =>
                collectGatewayLogs((page) =>
                  gatewayLogs(owned, String(evidence.startedAt), component, undefined, page),
                ),
              ),
            )
          ).flat();
          const result = reconcileUsage(await appUsage(), logs, ownerAccount);
          rows = result.rows;
          usageEvidence.rows = result.rows;
          usageEvidence.mismatched = result.mismatched;
          usageEvidence.unlabelledLogs = logs.filter((log) => !log.account).length;
          return result.rows.length > 0 && result.mismatched.length === 0;
        });
        // Agreeing isn't enough: the builds' calls must be the owner's, not
        // the site's `unattributed` (the Workflow step context bug).
        const features = ["knowledge", ...(want("timeline-pages") ? ["wiki"] : [])];
        for (const feature of features)
          assert(
            rows.some((row) => row.feature === feature && row.app.calls > 0),
            `The fixture owner's ${feature} calls must be attributed to it`,
          );
      }
      if (want("repository-deletion")) {
        begin("repository-deletion");
        enter("repository-deletion");
        // CORE-199 against the real providers: the fixture repository, with its
        // vectors, AI Search items, coordinator and Artifacts repository, is
        // deleted; its purge is killed mid-way and resumed; nothing of it is
        // left in any store. Then the one-off orphan sweep finds what a
        // repository deleted before the purge existed left in each store. The
        // Atlas fixtures create repositories, so the sweep waits for them.
        const deletionEvidence: Record<string, unknown> = {};
        evidence.repositoryDeletion = deletionEvidence;
        const secret = ctx.env.GITMATRIX_AGENT_SECRET ?? "";
        const dev = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
          const response = await fetch(`${ctx.origin}/api/dev${path}`, {
            method,
            headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(120_000),
          });
          events.push({ stage, method, path: `/dev${path}`, status: response.status });
          assert.equal(
            response.status,
            200,
            `${stage}: ${method} /dev${path} HTTP ${response.status}`,
          );
          return (await response.json()) as T;
        };
        interface Inventory {
          repo: unknown;
          d1: Record<string, number>;
          registry: { packageSources: number; publishes: number };
          durable: {
            class: string;
            purgedAt: string | null;
            storage: { tables: string[]; keys: number; alarm: number | null } | null;
          }[];
          artifacts: { exists: boolean | null };
          vectors: number | null;
          searchItems: number | null;
          deletion: { phase: string; workflowId: string | null; attempts: number } | null;
        }
        // The local runtime's D1 sometimes fails a query under load: retry a read.
        const inventoryOf = async (repo: string): Promise<Inventory> => {
          for (let attempt = 1; ; attempt++) {
            try {
              return await dev<Inventory>(`/repo-inventory?repo=${encodeURIComponent(repo)}`);
            } catch (error) {
              if (attempt === 3) throw error;
              await delay(1000);
            }
          }
        };
        const fixture = `${owner}/${name}`;
        const before = await inventoryOf(fixture);
        deletionEvidence.before = before;
        assert((before.vectors ?? 0) > 0, "The fixture has vectors before its deletion");
        assert(
          (before.searchItems ?? 0) > 0,
          "The fixture has AI Search items before its deletion",
        );
        assert.equal(before.artifacts.exists, true);
        assert(
          before.durable.some((d) => d.class === "KnowledgeCoordinator" && !d.purgedAt),
          "The fixture's coordinator is registered",
        );
        const deleted = await fetch(`${ctx.origin}/api${base}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${fixtures.tokens[persona]}` },
          signal: AbortSignal.timeout(60_000),
        });
        events.push({ stage, method: "DELETE", path: base, status: deleted.status });
        assert.equal(deleted.status, 204, "Deleting the fixture repository");
        const hidden = await fetch(`${ctx.origin}/api${base}`, {
          headers: { authorization: `Bearer ${fixtures.tokens[persona]}` },
          signal: AbortSignal.timeout(60_000),
        });
        assert.equal(hidden.status, 404, "A deleted repository is missing at once");
        // Kill the purge once it deletes from the providers (vectors, search
        // items, or a later phase short of done), then resume it as the cron would.
        let killedAt: string | undefined;
        await waitFor("repository-deletion-running", 300_000, async () => {
          const now = await inventoryOf(fixture);
          const phase = now.deletion?.phase;
          assert(phase && phase !== "done", "The purge must be killed before it ends");
          if (!now.deletion?.workflowId || ["stop", "previews"].includes(phase)) return false;
          await dev("/repo-purge", "POST", { repo: fixture, action: "terminate" });
          killedAt = phase;
          return true;
        });
        const resumed = await dev<{ started: string[]; deletion: Inventory["deletion"] }>(
          "/repo-purge",
          "POST",
          { repo: fixture, action: "resume" },
        );
        assert(resumed.started.length >= 1, "The resume starts a new purge");
        assert.equal(resumed.deletion?.attempts, 2);
        deletionEvidence.killedAt = killedAt;
        let after: Inventory | undefined;
        await waitFor("repository-deletion-done", 15 * 60_000, async () => {
          after = await inventoryOf(fixture);
          deletionEvidence.after = after;
          return after.deletion?.phase === "done" && after.vectors === 0 && after.searchItems === 0;
        });
        assert.equal(after!.repo, null);
        assert.deepEqual(after!.d1, {}, "No D1 row names the deleted repository");
        assert.deepEqual(after!.registry, { packageSources: 0, publishes: 0 });
        assert.equal(after!.artifacts.exists, false, "Its Artifacts repository is deleted");
        for (const instance of after!.durable) {
          assert(instance.purgedAt, `${instance.class} was purged`);
          if (instance.storage)
            assert.deepEqual(
              {
                tables: instance.storage.tables,
                keys: instance.storage.keys,
                alarm: instance.storage.alarm,
              },
              { tables: [], keys: 0, alarm: null },
              `${instance.class} holds nothing`,
            );
        }

        enter("repository-orphan-sweep");
        const atlasError = await atlas;
        if (atlasError) throw atlasError;
        const planted = await dev<{
          repoId: string;
          artifactsName: string;
          itemId: string | null;
          vectorId: string | null;
        }>("/repo-orphans", "POST", { action: "plant" });
        deletionEvidence.planted = planted;
        assert(planted.itemId && planted.vectorId, "An orphan was planted in each provider");
        // Vectorize applies upserts asynchronously: the orphan must be findable first.
        await waitFor("repository-orphan-planted", 300_000, async () => {
          const seen = await inventoryOf(planted.repoId).catch(() => null);
          return Boolean(seen && seen.vectors === 1 && seen.searchItems === 1);
        });
        const sweep = await dev<{
          stage: string;
          orphans: number;
          artifacts: number;
          deletedArtifacts?: string[];
          vectors?: { indexed: number; expected: number };
        }>("/repo-orphans", "POST", { action: "sweep" });
        deletionEvidence.sweep = sweep;
        assert.equal(sweep.stage, "done");
        assert(sweep.orphans >= 1, "The sweep found the orphaned repository id");
        assert(
          sweep.deletedArtifacts?.includes(planted.artifactsName),
          "The sweep deleted the Artifacts repository no row names",
        );
        let orphan: Inventory | undefined;
        await waitFor("repository-orphan-purged", 15 * 60_000, async () => {
          orphan = await inventoryOf(planted.repoId);
          // The latest observation is evidence even when the deadline passes.
          deletionEvidence.orphan = orphan;
          return (
            orphan.deletion?.phase === "done" && orphan.vectors === 0 && orphan.searchItems === 0
          );
        });
        passed("repository-deletion");
      }
      if (want("queue")) {
        begin("queue");
        // Atlas's builds finish before the queue's usage window opens; its
        // failure is reported on its own below.
        await atlas;
        const owned = await ownedEnvironment();
        enter("queue-real-conflict-repair");
        // Run last: Atlas and the orphan sweep's real embedding have finished
        // before the queue usage window begins. Keep the prior AI policy intact
        // through deletion; only these queue fixtures disable background inference.
        await api(settingsPath, "PATCH", {
          features: { knowledge: false, wiki: false, atlas: false, releaseNotes: false },
          models: { classification: "clef", task: "gemma-4-26b-a4b-it" },
        });
        const queueEvidence: Record<string, unknown> = { outcome: "running" };
        evidence.queue = queueEvidence;
        await runQueueAiE2E(ctx, fixtures, queueEvidence);
        await waitFor("queue-gateway-evidence", 120_000, async () => {
          const { logs } = await gatewayLogs(owned, String(queueEvidence.startedAt), "knowledge");
          queueEvidence.usage = logs;
          const successful = logs.filter((log) => log.success && !log.cached);
          const repair = successful.filter((log) => log.model.includes("gemma-4-26b"));
          const classifier = successful.filter((log) => log.model.toLowerCase().includes("clef"));
          assert(logs.length <= 8, "Queue submissions must not create an inference retry loop");
          if (!repair.length || !classifier.length) return false;
          assert.equal(repair.length, 1, "Only the safe documentation conflict may invoke repair");
          assert(
            repair[0]!.tokensIn > 0 && repair[0]!.tokensOut > 0,
            "Real repair must record token usage",
          );
          return true;
        });
        passed("queue");
      }
    }
    evidence.outcome = "passed";
  } catch (error) {
    searchable();
    evidence.outcome = "failed";
    evidence.failedStage = stage;
    if (run && stageOwner) run.outcomes[stageOwner] = "failed";
    evidence.error = error instanceof Error ? error.message : "Unknown provider failure";
    failure = new Error(`Provider E2E failed at ${stage}; inspect ${mode}-e2e.json`, {
      cause: error,
    });
  } finally {
    timings.push({
      stage,
      elapsedMs: Date.now() - stageStarted,
      outcome: String(evidence.outcome),
    });
    const atlasFailure = await atlas;
    if (atlasFailure) {
      const wrapped = new Error(
        `Atlas provider verification failed at ${String(atlasEvidence.failedStage)}; inspect ${mode}-e2e.json (atlas)`,
        { cause: atlasFailure },
      );
      failure = failure
        ? new AggregateError([failure, wrapped], "Provider verifications failed")
        : wrapped;
      evidence.outcome = "failed";
      evidence.failedStage ??= `atlas:${String(atlasEvidence.failedStage)}`;
    }
    if (target) evidence.mirrorRequests = target.counts;
    try {
      await target?.close();
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], "Provider verification and mirror shutdown failed")
        : error;
      evidence.outcome = "failed";
      evidence.failedStage ??= "mirror-shutdown";
      evidence.cleanupError = error instanceof Error ? error.message : "Mirror shutdown failed";
    }
    if (mode === "ai") {
      // What the run spent (CORE-284); a failed lookup is recorded, never fatal.
      try {
        evidence.cost = {
          gateway: await gatewaySpend(await ownedEnvironment(), String(evidence.startedAt)),
          atlas: (atlasEvidence.providerUsage as { totals?: unknown } | undefined)?.totals ?? null,
        };
      } catch (error) {
        evidence.cost = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    evidence.finishedAt = new Date().toISOString();
    let serialized = JSON.stringify(evidence, null, 2);
    for (const secret of [
      token,
      authorization,
      ...Object.values(fixtures.tokens),
      fixtures.readToken,
    ]) {
      if (secret) serialized = serialized.replaceAll(secret, "[REDACTED]");
    }
    await writeFile(join(ctx.artifacts, `${mode}-e2e.json`), serialized + "\n", { mode: 0o600 });
  }
  if (failure) throw failure;
}
