import { fixtureSpace } from "./content-fixtures.ts";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect } from "@playwright/test";
import type { Timeline } from "../../apps/website/shared/timelines.ts";
import type { QueueGm, RepoInventory } from "./queue-e2e.ts";
import { sourceRetentionFixture } from "./source-retention-e2e.ts";
import type { HarnessContext, ScenarioBrowser, SeedManifest } from "./types.ts";

/** An actual expired source remains intelligible even after its timeline history is gone. */
export async function runSourceExpiredE2E(
  ctx: HarnessContext,
  fixtures: SeedManifest,
  gm: QueueGm,
  record: (value: unknown) => void,
  sharedBrowser: () => Promise<ScenarioBrowser>,
) {
  const { owner, secret, name, repo, api, timelines, root, json, git } =
    await sourceRetentionFixture(ctx, fixtures, record);
  type Observation = { sourceId: string; artifactsName: string; state: string; exists: boolean };
  const hook = <T>(body: Record<string, unknown>) =>
    json<T>("/api/dev/source-retention", "POST", { repo, ...body }, [200], secret);
  const inspect = async () =>
    (await hook<{ sources: Observation[] }>({ action: "inspect" })).sources;
  const errors: unknown[] = [];
  let created = false;
  let observed: Observation[] = [];
  try {
    await gm(["repo", "create", name, "--space", owner], "sam", root);
    created = true;
    await git(["init", "--initial-branch=main"]);
    await git(["config", "user.name", "Expired Source Fixture"]);
    await git(["config", "user.email", "expired@example.invalid"]);
    await writeFile(join(root, "README.md"), "# Owned expired source fixture\n");
    await git(["add", "."]);
    await git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "Expired source canonical base"]);
    await git(["push", `${ctx.origin}/${repo}.git`, "HEAD:main"]);
    const oid = await git(["rev-parse", "HEAD"]);
    const slug = `${name}-expired`;
    const { timeline } = await json<{ timeline: Timeline }>(
      timelines,
      "POST",
      { slug, repos: [repo] },
      [201],
    );
    const source = timeline.repos[0]?.source;
    assert(source?.sourceId && source.kind === "timeline-work");
    await json(`${api}/commits?source=${source.sourceId}&ref=${oid}`);
    await json(`${timelines}/${slug}/abandon`, "POST", {});
    observed = await inspect();
    const archived = observed.find((entry) => entry.sourceId === source.sourceId);
    assert.equal(archived?.state, "archived");
    assert.equal(archived?.exists, true);
    await hook({ action: "expire", timeline: slug, sourceId: source.sourceId });
    const deadline = Date.now() + 180_000;
    for (;;) {
      const expired = (await inspect()).find((entry) => entry.sourceId === source.sourceId);
      if (expired?.state === "purged" && !expired.exists) break;
      assert(Date.now() < deadline, "Exact expired source provider purge stalled");
      await delay(500);
    }
    const expired = await json<{ code?: string; error?: string }>(
      `${api}/commits?source=${source.sourceId}&ref=${oid}`,
      "GET",
      undefined,
      [410],
    );
    assert.match(JSON.stringify(expired), /source_expired|source has expired/i);
    await json(`${timelines}/${slug}`);
    const retention = await json<{
      run: { status: string; categories: { error: string | null }[] };
    }>(
      "/api/dev/retention",
      "POST",
      {
        target: {
          kind: "space",
          id: (await fixtureSpace(ctx.origin, owner, fixtures.tokens.sam)).space.id,
        },
        categories: { "tracker-activity": { eventDays: 365, endedTimelineDays: 180 } },
        daysAhead: 181,
        dryRun: false,
      },
      [200],
      secret,
    );
    assert.equal(retention.run.status, "succeeded");
    assert(retention.run.categories.every((category) => category.error === null));
    await json(`${timelines}/${slug}`, "GET", undefined, [404]);
    const browser = await sharedBrowser();
    try {
      const context = await browser.newContext({ baseURL: ctx.origin });
      const page = await context.newPage();
      try {
        await page.goto("/signin");
        await page.getByRole("button", { name: /Continue as sam/i }).click();
        await page.waitForURL((url) => url.pathname !== "/signin");
        await page.goto(`/${repo}?source=${source.sourceId}`);
        await expect(page.getByText(/code source has expired/i).first()).toBeVisible({
          timeout: 15_000,
        });
        await page.screenshot({
          path: join(ctx.artifacts, "source-retention-expired.png"),
          fullPage: true,
        });
      } catch (error) {
        await page
          .screenshot({ path: join(ctx.artifacts, "source-retention-failure.png"), fullPage: true })
          .catch(() => {});
        throw error;
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
    record({ expiredSource: source.sourceId, historyRemoved: true, providerPurged: true });
  } catch (error) {
    errors.push(error);
  } finally {
    if (created) {
      try {
        // Capture every owned source before deleting the canonical repository, including on failure.
        observed = await inspect();
        await json(api, "DELETE", undefined, [204]);
        await json("/api/dev/repo-purge", "POST", { repo, action: "resume" }, [200], secret);
        const deadline = Date.now() + 300_000;
        for (;;) {
          const inventory = await json<RepoInventory>(
            `/api/dev/repo-inventory?repo=${encodeURIComponent(repo)}`,
            "GET",
            undefined,
            [200],
            secret,
          );
          if (inventory.deletion?.phase === "done") {
            assert.equal(inventory.repo, null);
            assert.equal(inventory.artifacts.exists, false);
            assert.deepEqual(inventory.d1, {});
            break;
          }
          assert(Date.now() < deadline, "Expired source canonical purge stalled");
          await delay(1_000);
        }
        const after = await hook<{ sources: Observation[] }>({
          action: "inspect",
          observed: observed.map(({ sourceId, artifactsName }) => ({ sourceId, artifactsName })),
        });
        assert(
          after.sources.every((source) => !source.exists),
          "Every owned source provider is absent",
        );
        record({ ownedProviderCleanup: after.sources });
      } catch (error) {
        errors.push(error);
      }
    }
    await rm(root, { recursive: true, force: true }).catch((error) => errors.push(error));
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(errors, "Expired source browser or owned cleanup failed");
}
