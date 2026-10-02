import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { HarnessContext, SeedManifest } from "./types.ts";

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
): Promise<void> {
  await mkdir(ctx.artifacts, { recursive: true });
  const root = await mkdtemp(join(ctx.work, "providers-"));
  const work = join(root, "source");
  await mkdir(work);
  const token = randomBytes(24).toString("hex");
  const authorization = `Basic ${Buffer.from(`agent:${token}`).toString("base64")}`;
  const evidence: Record<string, unknown> = {
    version: 1,
    mode,
    startedAt: new Date().toISOString(),
    outcome: "running",
  };
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
                GIT_CONFIG_VALUE_0: `Authorization: Bearer ${fixtures.tokens.priya}`,
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
  const api = async (path: string, method = "GET", body?: unknown, expected = 200) => {
    const response = await fetch(`${ctx.origin}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${fixtures.tokens.priya}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120_000),
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
  let failure: unknown;
  try {
    if (mode === "mirror") {
      await git(["init", "--bare", "--initial-branch=main", join(root, "target.git")]);
      await git(["--git-dir", join(root, "target.git"), "config", "http.receivepack", "true"]);
      target = await targetServer(root, authorization, env);
    }
    const owner = "priya";
    const name = `provider-${randomBytes(5).toString("hex")}`;
    const base = `/repos/${encodeURIComponent(owner)}/${name}`;
    evidence.repo = `${owner}/${name}`;
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
    let final: string;
    if (mode === "mirror") {
      assert(target);
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
      await waitFor(stage, 120_000, async () => (await refs()).get("refs/heads/main") === initial);
      await git([
        "--git-dir",
        join(root, "target.git"),
        "update-ref",
        "refs/heads/stale-fixture",
        initial,
      ]);
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
      const tag = await git(["rev-parse", "refs/tags/provider-v1"]);
      await git(["push", "origin", "main", "refs/tags/provider-v1"], work, true);
      await waitFor(stage, 120_000, async () => {
        const actual = await refs();
        return (
          actual.size === 2 &&
          actual.get("refs/heads/main") === final &&
          actual.get("refs/tags/provider-v1") === tag
        );
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
    } else {
      await git(["push", "origin", "main"], work, true);
      final = await git(["rev-parse", "HEAD"]);
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
      enter("knowledge-graph");
      const graph = await api(`${base}/knowledge/graph/export`);
      const symbol = graph.nodes.find(
        (node: { kind: string; name: string; path: string }) =>
          node.kind === "symbol" &&
          node.name === "copperFinchChecksum" &&
          node.path === "checksum.ts",
      );
      const file = graph.nodes.find(
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
      const page = await api(`${base}/knowledge/wiki/page?slug=overview`);
      assert.match(page.body, /Copper Finch|copperFinchChecksum/i, "Wiki must explain the fixture");
      assert.match(page.body, /65521|checksum/i, "Wiki must describe checksum behavior");
      assert.equal(page.generatedIn, final, "Wiki must describe the indexed fixture commit");
      assert(page.model, "Wiki must record its real generation model");
      evidence.wiki = page;
      enter("index-visibility");
      // At most six real embedding + hybrid retrieval calls while provider indexes settle.
      let found = false;
      for (let attempt = 1; attempt <= 6; attempt++) {
        const result = await api(
          `${base}/knowledge/search?q=${encodeURIComponent("Copper Finch copperFinchChecksum parcel checksum modulo 65521")}`,
        );
        evidence.search = result;
        found =
          result.entities.some(
            (entity: { id: string }) => entity.id === symbol.id || entity.id === file.id,
          ) &&
          result.passages.some(
            (passage: { kind: string; path: string; text: string }) =>
              passage.kind === "code" &&
              passage.path === "checksum.ts" &&
              passage.text.includes("copperFinchChecksum") &&
              passage.text.includes("65521"),
          );
        if (found) break;
        if (attempt < 6) await delay(20_000);
      }
      assert(
        found,
        "Vectorize entity and AI Search source passage invariants were not both visible",
      );
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
      await git(["-c", "core.hooksPath=/dev/null", "commit", "-am", "Verify Copper Finch parcels"]);
      await git(["push", "origin", "main"], work, true);
      const edited = await git(["rev-parse", "HEAD"]);
      let editBuild: { stats: { analyzed?: number; reused?: number } } | undefined;
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
      const editedGraph = await api(`${base}/knowledge/graph/export`);
      assert(
        editedGraph.nodes.some(
          (n: { kind: string; name: string }) =>
            n.kind === "symbol" && n.name === "copperFinchVerify",
        ),
        "Graph lacks the symbol the edit added",
      );
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
    }
    evidence.outcome = "passed";
  } catch (error) {
    evidence.outcome = "failed";
    evidence.failedStage = stage;
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
