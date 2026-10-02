// Exercises real Artifacts-backed git, the Worker API and the worktree's gm.
// Requires `vp run agent setup` and `vp run agent up`. Only this invocation's
// disposable repository and clone are removed; the scoped environment stays up.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { command, context, loadEnvironment } from "../../../tools/agent/environment.ts";
import type { SeedManifest } from "../../../tools/agent/types.ts";
import { programmingFixtures } from "../shared/semantic/fixtures/programming.ts";
import { documentFixtures } from "../shared/semantic/fixtures/documents.ts";
import type { SemanticFeedEntry, SemanticFeedResponse } from "../shared/semantic/types.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const environment = await loadEnvironment(root);
const ctx = await context(environment);
const seed = JSON.parse(await readFile(join(ctx.dir, "seed.json"), "utf8")) as SeedManifest;
assert.equal(seed.origin, ctx.origin, "Seed credentials must belong to this scoped origin");
const token = seed.tokens.priya;
assert(token, "Run vp run agent setup to seed scoped credentials");
const origin = ctx.origin;
const temporary = await mkdtemp(join(ctx.work, "semantic-smoke-"));
const keep = process.env.SEMANTIC_SMOKE_KEEP === "1";
let repoCreated = false;
const name = `semantic-smoke-${crypto.randomUUID()}`;
const repository = `priya/${name}`;

async function runGm(args: string[], cwd: string): Promise<string> {
  return (
    await command(
      process.execPath,
      [join(root, "tools/agent/main.ts"), "gm", "--", "-C", cwd, ...args],
      { cwd: root },
    )
  ).trim();
}

async function request<T>(path: string, init: RequestInit = {}, bearer = token): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  const response = await fetch(`${origin}/api${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok)
    throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

try {
  const identity = await request<{ id: string; ready: boolean }>(
    "/dev/environment",
    {},
    environment.secret,
  );
  assert.equal(identity.id, environment.id, "Smoke must use its owned agent environment");
  assert.equal(identity.ready, true, "Run vp run agent up before the smoke");
  console.log("Exercising semantic fixtures through the scoped agent environment…");
  await request("/repos", {
    method: "POST",
    body: JSON.stringify({
      owner: "priya",
      name,
      visibility: "private",
      description: "Disposable semantic integration fixtures",
    }),
  });
  repoCreated = true;
  const checkout = join(temporary, "repo");
  await runGm(["clone", repository, checkout], temporary);
  const fixtures = [...programmingFixtures, ...documentFixtures];
  const extensions = new Set(fixtures.map((fixture) => fixture.path.split(".").pop()));
  for (const extension of ["ts", "tsx", "rs", "py", "go", "md", "xml", "json", "html", "css"]) {
    assert(extensions.has(extension), `Missing ${extension} integration fixtures`);
  }
  const files = fixtures.map((fixture, index) => ({
    ...fixture,
    path: `fixtures/${index}/${fixture.path}`,
  }));
  for (const fixture of files) {
    const file = join(checkout, fixture.path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, fixture.before);
  }
  await writeFile(join(checkout, "unsupported.txt"), "before\n");
  await runGm(["commit", "-m", "Semantic smoke baseline"], checkout);
  await runGm(["push"], checkout);
  for (const fixture of files) await writeFile(join(checkout, fixture.path), fixture.after);
  await writeFile(join(checkout, "unsupported.txt"), "after\n");
  await writeFile(join(checkout, "invalid.ts"), "function ( {\n");
  const ordinaryDiff = JSON.parse(await runGm(["diff", "-o", "json"], checkout)) as {
    files: { path: string; status: string }[];
    patch: string;
  };
  assert(ordinaryDiff.files.some((file) => file.path === "invalid.ts" && file.status === "added"));
  assert(
    ordinaryDiff.patch.includes("+function ( {"),
    "Ordinary diff must preserve source even when semantic parsing fails",
  );
  await runGm(["commit", "-m", "Semantic smoke syntax changes"], checkout);
  await runGm(["push"], checkout);
  const detail = await request<{ head: string }>(`/repos/${repository}`);
  assert.match(detail.head, /^[a-f0-9]{40}$/);
  const commit = detail.head;
  const entries: SemanticFeedEntry[] = [];
  const coverage: SemanticFeedResponse["coverage"] = [];
  const ids = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    const args = [
      "semantic",
      "list",
      "--repo",
      repository,
      "--ref",
      commit,
      "--limit",
      "7",
      "-o",
      "json",
    ];
    if (cursor) args.push("--cursor", cursor);
    const page = JSON.parse(await runGm(args, checkout)) as SemanticFeedResponse;
    assert.equal(page.version, 1);
    assert.equal(page.head, commit, "Pagination must preserve its immutable snapshot");
    assert(page.entries.length <= 7, "Page limit applies to semantic entries, not commits");
    for (const entry of page.entries) {
      assert(!ids.has(entry.id), `Duplicate paged event ${entry.id}`);
      ids.add(entry.id);
      assert(entry.links.commit.includes(entry.commit.oid));
      for (const link of [entry.links.before, entry.links.after].filter(Boolean))
        assert.match(link!, /#L\d+$/);
      entries.push(entry);
    }
    coverage.push(...page.coverage);
    cursor = page.nextCursor;
    assert(++pages <= 500, "Feed pagination did not terminate");
  } while (cursor);
  assert(pages > 1, "Fixtures must exercise pagination");
  for (const fixture of files) {
    for (const expected of fixture.expected) {
      assert(
        entries.some(
          (entry) =>
            entry.commit.oid === commit &&
            (entry.after ?? entry.before)?.path === fixture.path &&
            entry.kind === expected.kind &&
            entry.name === expected.name,
        ),
        `${fixture.name}: missing ${expected.kind} ${expected.name}`,
      );
    }
    const blob = await request<{ text: string }>(
      `/repos/${repository}/blob?ref=${commit}&path=${encodeURIComponent(fixture.path)}`,
    );
    assert.equal(blob.text, fixture.after, `${fixture.path}: existing blob view must remain exact`);
  }
  assert(coverage.some((item) => item.path === "unsupported.txt" && item.status === "unsupported"));
  assert(coverage.some((item) => item.path === "invalid.ts" && item.status === "parse_error"));
  assert(!entries.some((entry) => (entry.after ?? entry.before)?.path === "invalid.ts"));
  const chosen = entries.find(
    (entry) => entry.commit.oid === commit && entry.kind === "call.added",
  );
  assert(chosen, "Fixture must include an added call");
  const filtered = JSON.parse(
    await runGm(
      [
        "semantic",
        "list",
        "--repo",
        repository,
        "--ref",
        commit,
        "--path",
        (chosen.after ?? chosen.before)!.path,
        "--kind",
        chosen.kind,
        "--language",
        chosen.language,
        "-o",
        "json",
      ],
      checkout,
    ),
  ) as SemanticFeedResponse;
  assert(
    filtered.entries.some((entry) => entry.id === chosen.id),
    "CLI filters must retain matching event",
  );
  assert(
    filtered.entries.every(
      (entry) => entry.kind === chosen.kind && entry.language === chosen.language,
    ),
  );
  const denied = await fetch(`${origin}/api/repos/${repository}/semantic`);
  assert.equal(denied.status, 404, "Private feed must not leak through cached analysis");
  const commits = await request<{ commits: { oid: string }[] }>(
    `/repos/${repository}/commits?ref=${commit}`,
  );
  assert.equal(commits.commits[0]?.oid, commit, "Existing commit history remains available");
  console.log(
    JSON.stringify({
      status: "passed",
      repository,
      origin,
      commit,
      fixtures: files.length,
      pages,
      entries: entries.length,
      url: `${origin}/${repository}/changes`,
      checkout,
      pid: process.pid,
    }),
  );
  if (keep) {
    console.log(`SEMANTIC_SMOKE_READY ${origin}/${repository}/changes`);
    const stopped = Promise.withResolvers<void>();
    process.once("SIGINT", stopped.resolve);
    process.once("SIGTERM", stopped.resolve);
    const expiry = setTimeout(stopped.resolve, Math.max(0, environment.expires - Date.now()));
    try {
      await stopped.promise;
    } finally {
      clearTimeout(expiry);
      process.off("SIGINT", stopped.resolve);
      process.off("SIGTERM", stopped.resolve);
    }
  }
} finally {
  try {
    if (repoCreated) await request(`/repos/${repository}`, { method: "DELETE" });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
