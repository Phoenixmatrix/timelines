import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AiSettingsView } from "../../apps/website/shared/ai.ts";
import type { SpaceGrant } from "../../apps/website/shared/spaces.ts";
import { contentHeaders, fixtureSpace } from "./content-fixtures.ts";
import {
  waitForIndexVisibility,
  type SearchResult,
  type VisibilityReport,
} from "./index-visibility.ts";
import { searchItemStatus } from "./search-item-status.ts";
import type { HarnessContext, SeedManifest } from "./types.ts";

type Persona = "marco" | "jun" | "sam";
interface Answer extends SearchResult {
  providers: { entities: string; passages: string };
  index: { indexedCommit: string | null };
}
interface Source {
  space: string;
  persona: Persona;
  repoId: string;
  name: string;
  commit: string;
  path: string;
  marker: string;
  result: Answer;
}
const roles = (grant: SpaceGrant) => ({
  role: grant.role,
  repositoryRole: grant.repositoryRole,
  packageRole: grant.packageRole,
});

/** Runs inside search's selected attempt; all inference belongs to its owned Gateway. */
export async function runSpaceAiE2E(
  ctx: HarnessContext,
  fixtures: SeedManifest,
  report: Record<string, unknown>,
  baseline: Omit<Source, "space" | "persona" | "path" | "marker">,
  enter: (stage: string) => void,
  waitFor: (label: string, timeout: number, check: () => Promise<boolean>) => Promise<void>,
): Promise<void> {
  const observations: unknown[] = [];
  const positives: unknown[] = [];
  const cleanup: unknown[] = [];
  Object.assign(report, {
    outcome: "running",
    positives,
    observations,
    cleanup,
    providers: {
      entities: "Workers AI embeddings / Vectorize",
      passages: "AI Search hybrid retrieval / reranking",
    },
    cost: "Included in this attempt's Gateway totals; AI Search built-in embedding/reranking is not Gateway logged",
  });
  const request = async <T>(
    persona: Persona,
    path: string,
    method = "GET",
    body?: unknown,
    expected = 200,
    timeout = 120_000,
  ): Promise<T> => {
    const response = await fetch(`${ctx.origin}/api${path}`, {
      method,
      headers: {
        ...contentHeaders,
        authorization: `Bearer ${fixtures.tokens[persona]}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeout),
      redirect: "error",
    });
    observations.push({ persona, path, method, status: response.status });
    assert.equal(response.status, expected, `${persona} ${method} ${path}: expected ${expected}`);
    return (response.status === 204 ? undefined : await response.json()) as T;
  };
  const sources: Source[] = [
    { ...baseline, space: "orbit", persona: "marco", path: "checksum.ts", marker: "Copper Finch" },
  ];
  const owned: { space: string; persona: Persona; name: string }[] = [];
  const settings: { space: string; persona: Persona; before: AiSettingsView }[] = [];
  const research = await fixtureSpace(ctx.origin, "nova-research", fixtures.tokens.sam);
  assert(research.grant && research.capabilities.canManageGrants);
  assert.equal(
    research.grant.repositoryRole,
    "none",
    "Nova's package-only baseline must not become an implicit repository grant",
  );
  const originalGrant = research.grant;
  report.originalNovaResearchGrant = originalGrant;
  const grantPath = `/spaces/nova-research/grants/${originalGrant.accountId}`;
  const temporaryGrant = { ...roles(originalGrant), role: "admin", repositoryRole: "write" };
  let grantTouched = false;
  const restoreGrant = async () => {
    await request("sam", grantPath, "PUT", roles(originalGrant), 204);
    const restored = await fixtureSpace(ctx.origin, "nova-research", fixtures.tokens.sam);
    assert(restored.grant);
    assert.deepEqual(roles(restored.grant), roles(originalGrant));
    report.restoredNovaResearchGrant = restored.grant;
  };
  const errors: unknown[] = [];
  try {
    enter("four-space-ai-builds");
    grantTouched = true;
    await request("sam", grantPath, "PUT", temporaryGrant, 204);
    for (const [space, persona] of [
      ["orbit-research", "jun"],
      ["nova", "sam"],
      ["nova-research", "sam"],
    ] as const) {
      const scope = await fixtureSpace(ctx.origin, space, fixtures.tokens[persona]);
      const before = await request<AiSettingsView>(persona, `/spaces/${space}/settings/ai`);
      settings.push({ space, persona, before });
      // Suppress push-triggered work; admit exactly one explicit build below.
      await request(persona, `/spaces/${space}/settings/ai`, "PATCH", {
        features: { knowledge: false, wiki: false, atlas: false, releaseNotes: false },
        models: { classification: "clef", fast: "gemma-4-26b-a4b-it", task: "gemma-4-26b-a4b-it" },
      });
      const name = `space-ai-${randomBytes(5).toString("hex")}`;
      const repo = await request<{ id: string }>(
        persona,
        "/repos",
        "POST",
        {
          spaceId: scope.space.id,
          name,
          visibility: "private",
          description: "Owned four-Space real AI boundary fixture",
        },
        201,
      );
      owned.push({ space, persona, name });
      const base = `/repos/${space}/${name}`;
      const path = `${space}-checksum.ts`;
      const marker = `Copper Finch ${space} ${name}`;
      const dir = join(ctx.work, name);
      await mkdir(dir);
      const env: NodeJS.ProcessEnv = {
        ...ctx.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      };
      for (const key of Object.keys(env))
        if (/^GIT_CONFIG_(?:COUNT|KEY_|VALUE_)/.test(key)) delete env[key];
      const git = (args: string[], authenticated = false) =>
        new Promise<string>((resolve, reject) => {
          execFile(
            "git",
            args,
            {
              cwd: dir,
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
            (error, stdout) =>
              error
                ? reject(
                    new Error(
                      `Four-Space git ${args[0]} failed (${String(error.code ?? "unknown")})`,
                    ),
                  )
                : resolve(stdout.trim()),
          );
        });
      await git(["init", "--initial-branch=main"]);
      await git(["config", "user.name", "Agent Fixture"]);
      await git(["config", "user.email", "agent-fixture@example.invalid"]);
      await writeFile(
        join(dir, path),
        `/** ${marker}: parcel checksum of UTF-16 code units modulo 65521. */\nexport function copperFinchChecksum(parcel: string): number {\n  let checksum = 0;\n  for (let i = 0; i < parcel.length; i++) checksum = (checksum + parcel.charCodeAt(i)) % 65521;\n  return checksum;\n}\n`,
      );
      await git(["add", path]);
      await git(["-c", "core.hooksPath=/dev/null", "commit", "-m", marker]);
      const commit = await git(["rev-parse", "HEAD"]);
      await git(["push", `${ctx.origin}/${space}/${name}.git`, "HEAD:refs/heads/main"], true);
      await request(persona, `/spaces/${space}/settings/ai`, "PATCH", {
        features: { knowledge: true },
      });
      await request(persona, `${base}/knowledge/rebuild`, "POST", undefined, 202);
      const positive: Record<string, unknown> = {
        spaceId: scope.space.id,
        organizationId: scope.space.organizationId,
        persona,
        repoId: repo.id,
        name,
        commit,
        path,
        marker,
      };
      positives.push(positive);
      await waitFor(`four-space-build:${space}`, 12 * 60_000, async () => {
        const status = await request<{
          state: string;
          indexedCommit: string | null;
          recent: {
            id: string;
            toCommit: string;
            status: string;
            stats: { aiUsage?: { calls: number }; ai?: unknown };
          }[];
        }>(persona, `${base}/knowledge/status`);
        positive.buildStatus = status;
        assert.notEqual(status.state, "failed", `Real Knowledge build failed in ${space}`);
        const build = status.recent.find(
          (entry) => entry.toCommit === commit && entry.status === "succeeded",
        );
        if (status.state !== "up-to-date" || status.indexedCommit !== commit || !build)
          return false;
        assert(
          build.stats.aiUsage && build.stats.aiUsage.calls > 0,
          "The fixture needs real metered model completion",
        );
        assert(build.stats.ai, "The build must record model attribution");
        positive.build = build;
        return true;
      });
      const graph = await request<{
        nodes: { id: string; kind: string; name: string; path: string }[];
      }>(persona, `${base}/knowledge/graph/export`);
      const file = graph.nodes.find((node) => node.kind === "file" && node.path === path);
      const symbol = graph.nodes.find(
        (node) =>
          node.kind === "symbol" && node.path === path && node.name === "copperFinchChecksum",
      );
      assert(file && symbol, "Real graph must identify the exact committed source file and symbol");
      const visibility = {} as VisibilityReport;
      positive.visibility = visibility;
      let answer: Answer | undefined;
      await waitForIndexVisibility({
        target: {
          repo: `${space}/${name}`,
          key: `${repo.id}/file:${path}.md`,
          path,
          fileId: file.id,
          symbolId: symbol.id,
        },
        item: await searchItemStatus(ctx, `${repo.id}/file:${path}.md`),
        report: visibility,
        search: async (remaining) => {
          answer = await request<Answer>(
            persona,
            `${base}/knowledge/search?q=${encodeURIComponent(`${marker} copperFinchChecksum 65521`)}`,
            "GET",
            undefined,
            200,
            Math.min(120_000, remaining),
          );
          positive.search = answer;
          assert.deepEqual(answer.providers, { entities: "ok", passages: "ok" });
          assert.equal(answer.index.indexedCommit, commit);
          return answer;
        },
      });
      assert(answer);
      assert(
        answer.passages.some(
          (passage) =>
            passage.kind === "code" && passage.path === path && passage.text.includes(marker),
        ),
        "AI Search must return this source's unique committed content",
      );
      sources.push({ space, persona, repoId: repo.id, name, commit, path, marker, result: answer });
    }
    // All four indexes now contain real output; do not confuse an empty peer with isolation.
    enter("four-space-ai-isolation");
    const organizations = new Map<string, string>();
    const spaces = new Set<string>();
    for (const source of sources) {
      const scope = await fixtureSpace(ctx.origin, source.space, fixtures.tokens[source.persona]);
      assert(!spaces.has(scope.space.id), "Each matrix cell must resolve a distinct Space");
      spaces.add(scope.space.id);
      organizations.set(source.space, scope.space.organizationId);
      if (source.space === "orbit")
        positives.unshift({
          spaceId: scope.space.id,
          organizationId: scope.space.organizationId,
          ...source,
          reused: true,
        });
      const query = "Copper Finch copperFinchChecksum parcel checksum modulo 65521";
      const answer = await request<Answer>(
        source.persona,
        `/repos/${source.space}/${source.name}/knowledge/search?q=${encodeURIComponent(query)}`,
      );
      assert.deepEqual(answer.providers, { entities: "ok", passages: "ok" });
      assert.equal(answer.index.indexedCommit, source.commit);
      assert(
        answer.passages.some(
          (passage) =>
            passage.kind === "code" &&
            passage.path === source.path &&
            passage.text.includes("65521"),
        ),
      );
      for (const peer of sources.filter((peer) => peer !== source)) {
        assert(
          !answer.passages.some(
            (passage) =>
              passage.path === peer.path ||
              (peer.space !== "orbit" && passage.text.includes(peer.marker)),
          ),
          "AI Search crossed a populated Space boundary",
        );
        assert(
          !answer.entities.some(
            (entity) =>
              peer.result.entities.some((other) => other.id === entity.id) &&
              !source.result.entities.some((own) => own.id === entity.id),
          ),
          "Vectorize crossed a populated Space boundary",
        );
      }
      observations.push({
        kind: "populated-isolation",
        space: source.space,
        repoId: source.repoId,
        commit: source.commit,
        answer,
      });
    }
    assert.equal(organizations.get("orbit"), organizations.get("orbit-research"));
    assert.equal(organizations.get("nova"), organizations.get("nova-research"));
    assert.notEqual(organizations.get("orbit"), organizations.get("nova"));
    await restoreGrant();
    for (const source of sources) {
      const denied: Persona[] = source.space.startsWith("orbit")
        ? ["sam", ...(source.space === "orbit-research" ? ["marco" as const] : [])]
        : ["marco", "jun", ...(source.space === "nova-research" ? ["sam" as const] : [])];
      for (const persona of denied) {
        const hidden = await request(
          persona,
          `/repos/${source.space}/${source.name}/knowledge/search?q=copperFinchChecksum`,
          "GET",
          undefined,
          404,
        );
        const absent = await request(
          persona,
          `/repos/${source.space}/absent-${source.name}/knowledge/search?q=copperFinchChecksum`,
          "GET",
          undefined,
          404,
        );
        assert.deepEqual(
          hidden,
          absent,
          "Private and absent AI sources must have the same response",
        );
      }
    }
    const ownerView = await fixtureSpace(ctx.origin, "orbit-research", fixtures.tokens.marco);
    assert.equal(ownerView.grant, null);
    assert.equal(ownerView.capabilities.canManageGrants, true);
    assert.equal(ownerView.capabilities.canReadContent, false);
    report.organizationOwnerWithoutContent = {
      persona: "marco",
      spaceId: ownerView.space.id,
      capabilities: ownerView.capabilities,
    };
  } catch (error) {
    errors.push(error);
  } finally {
    // Restore configuration and remove only repositories created by this invocation.
    // Re-admit Sam explicitly for cleanup, then restore the complete independent role tuple.
    if (grantTouched) {
      try {
        await request("sam", grantPath, "PUT", temporaryGrant, 204);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const repo of owned.reverse()) {
      try {
        await request(repo.persona, `/repos/${repo.space}/${repo.name}`, "DELETE", undefined, 204);
        cleanup.push({ space: repo.space, name: repo.name, deletionAccepted: true });
      } catch (error) {
        errors.push(error);
      }
    }
    for (const setting of settings.reverse()) {
      try {
        const restored = await request<AiSettingsView>(
          setting.persona,
          `/spaces/${setting.space}/settings/ai`,
          "PATCH",
          { features: setting.before.features, models: setting.before.models },
        );
        assert.deepEqual(restored.features, setting.before.features);
        assert.deepEqual(restored.models, setting.before.models);
        cleanup.push({ space: setting.space, settingsRestored: true });
      } catch (error) {
        errors.push(error);
      }
    }
    if (grantTouched) {
      try {
        await restoreGrant();
      } catch (error) {
        errors.push(error);
      }
    }
    report.outcome = errors.length ? "failed" : "passed";
    if (errors.length)
      report.errors = errors.map((error) =>
        error instanceof Error ? error.message : "Unknown four-Space failure",
      );
  }
  if (errors.length)
    throw new AggregateError(errors, "Four-Space real AI acceptance or cleanup failed");
}
