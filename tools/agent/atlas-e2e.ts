// The repository Atlas against the isolated server: a pushed multi-folder
// repository whose Atlas is projected without a model (POST /api/dev/atlas).
// What needs the real stack stays here: one browser journey across git, the
// projection, sessions and the page (atlasSmokeScenario), and revocation
// through real tokens (atlasRevocationScenario). The Atlas's UI behaviour
// (deep links, lookup, history, comparison, expiry, keyboard, touch, themes,
// motion, timelines, workspaces) is in apps/website's browser-mode tests
// (src/routes/repo/Atlas*.browser.test.tsx, routes/atlas/WorkspaceAtlas...).

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chromium, expect as playwrightExpect } from "@playwright/test";
import type { RepoDetail } from "../../apps/website/shared/api.ts";
import {
  atlasFixtureFiles,
  atlasFixtureSource,
  type AtlasFixtureVariant,
} from "../../apps/website/shared/atlasFixture.ts";
import type { HarnessContext, Persona } from "./types.ts";

export interface AtlasE2E {
  ctx: HarnessContext;
  work: string;
  token: string;
  gm(args: string[], persona?: Persona, cwd?: string): Promise<string>;
  json<T>(
    path: string,
    token: string | null,
    method?: string,
    body?: unknown,
    statuses?: number[],
  ): Promise<T>;
  record(value: unknown): void;
}

/** A pushed repository with a published fixture Atlas: what the browser scenarios share. */
export async function atlasFixtureRepo(
  t: AtlasE2E,
  {
    prefix = "atlas",
    variant = "base" as AtlasFixtureVariant,
    /** An npm package the registry should say this repository publishes. */
    publishes = undefined as string | undefined,
  } = {},
) {
  const owner = "orbit";
  const name = `${prefix}-${randomUUID().slice(0, 8)}`;
  await t.gm(["repo", "create", name, "--owner", owner, "--description", "Atlas E2E fixture"]);
  const dir = join(t.work, name);
  await t.gm(["clone", `${owner}/${name}`, dir]);
  for (const file of atlasFixtureFiles(variant)) {
    const path = join(dir, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, atlasFixtureSource(file).text);
  }
  await t.gm(["commit", "-m", "Atlas fixture: billing, search, ops and misc"], "marco", dir);
  await t.gm(["push"], "marco", dir);
  const api = `/api/repos/${owner}/${name}`;
  const detail = await t.json<RepoDetail>(api, t.token);
  const head = detail.branches.find((b) => b.shortName === detail.defaultBranch)?.oid;
  assert(head && /^[0-9a-f]{40}$/.test(head), "The fixture push must land on the default branch");
  const secret = t.ctx.env.GITMATRIX_AGENT_SECRET ?? "";
  const dev = <T>(body: Record<string, unknown>) =>
    t.json<T>("/api/dev/atlas", secret, "POST", { repo: `${owner}/${name}`, ...body }, [200, 201]);
  const first = await dev<{ snapshotId: string; seq: number }>({
    action: "publish",
    commit: head,
    ...(variant === "base" ? {} : { variant }),
    ...(publishes ? { publishes } : {}),
  });
  return { owner, name, api, head, dev, first };
}

const ATLAS_ROUTE = /\/atlas\/([a-z]+)$/;

/**
 * One journey across the real stack: a repository pushed with gm, its Atlas
 * projected by the Worker, a persona's real session, a cold link to a symbol
 * served by the dev server, a lookup through the catalogue, and the cited
 * source opened from git at the indexed commit. Browsing never reaches
 * search, a model-backed index or the whole graph.
 */
export async function atlasSmokeScenario(t: AtlasE2E) {
  const browserTimeout = 15_000;
  const expect = playwrightExpect.configure({ timeout: browserTimeout });
  const { owner, name, api, head } = await atlasFixtureRepo(t);
  const base = `/${owner}/${name}/knowledge`;
  const target = "sym:billing/ledger/ledger.ts#post";
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    baseURL: t.ctx.origin,
    viewport: { width: 1280, height: 900 },
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await context.newPage();
  page.setDefaultTimeout(browserTimeout);
  const seen: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) seen.push(url);
  });
  const heading = (text: string) =>
    page.getByRole("heading", { name: text, exact: true, level: 2 });
  try {
    await page.goto("/signin");
    await page.getByRole("button", { name: /Continue as marco/i }).click();
    await page.waitForURL((url) => url.pathname !== "/signin");

    // A cold link: the Worker's projection, read in bounded pages.
    await page.goto(`${base}?select=${encodeURIComponent(target)}&tl=main`);
    await expect(heading("post")).toBeFocused();
    // The cited source, from git at the commit the Atlas indexed; Back returns.
    await page.locator(`a[href*="/blob/${head}/billing/ledger/ledger.ts"]`).first().click();
    await page.waitForURL((url) => url.pathname.includes(`/blob/${head}/billing/ledger/ledger.ts`));
    await expect(page.getByText("export function post() {}")).toBeVisible();
    await page.goBack();
    await expect(heading("post")).toBeFocused();
    // The catalogue lookup.
    // (Typing key by key is the browser-mode tests'; here the query just has to reach the catalogue.)
    const box = page.getByRole("searchbox", { name: "Find a capability, file or symbol" });
    await box.fill("ledger");
    await expect(box).toHaveValue("ledger");
    await page
      .getByRole("list", { name: "Matches" })
      .getByRole("button", { name: /^ledger\.ts File/ })
      .click();
    await page.waitForURL(
      (url) => url.searchParams.get("select") === "file:billing/ledger/ledger.ts",
    );
    await expect(heading("ledger.ts")).toBeVisible();
    for (const url of seen) {
      assert(!url.pathname.includes("/knowledge/search"), url.pathname);
      assert(url.pathname !== "/api/search", url.pathname);
      if (ATLAS_ROUTE.test(url.pathname))
        assert(url.pathname.startsWith(`${api}/atlas/`), url.pathname);
    }
    const reads = [...new Set(seen.flatMap((u) => ATLAS_ROUTE.exec(u.pathname)?.[1] ?? []))];
    for (const needed of ["overview", "ancestors", "detail", "catalogue"])
      assert(reads.includes(needed), `The journey didn't read ${needed}`);
    await page.screenshot({ path: join(t.ctx.artifacts, "browser-atlas.png") });
    await context.tracing.stop();
    t.record({ repo: `${owner}/${name}`, atlasReads: reads.sort() });
  } catch (error) {
    await page
      .screenshot({ path: join(t.ctx.artifacts, "browser-atlas-failure.png"), fullPage: true })
      .catch(() => {});
    await context.tracing
      .stop({ path: join(t.ctx.artifacts, "browser-atlas-failure.zip") })
      .catch(() => {});
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}

/**
 * CORE-178, through real tokens: sam reads a private repository's Atlas as a
 * collaborator, and its owner removes him. Every Atlas read he can still
 * name (a page cursor, a pinned snapshot, an entity, the build status)
 * answers exactly as a repository that never existed. (That his open view
 * clears is the page's: src/routes/repo/Atlas.browser.test.tsx.)
 */
export async function atlasRevocationScenario(t: AtlasE2E & { readerToken: string }) {
  const { owner, api } = await atlasFixtureRepo(t);
  const ghost = `/api/repos/${owner}/ghost-${randomUUID().slice(0, 8)}`;
  const file = "file:billing/ledger/ledger.ts";
  await t.json(api, t.token, "PATCH", { visibility: "private" });
  // sam isn't in orbit: only the collaboration lets him read it.
  await t.json(api, t.readerToken, "GET", undefined, [404]);
  await t.json(`${api}/collaborators/sam`, t.token, "PUT", { role: "read" });
  const overview = await t.json<{ snapshot: { id: string }; catalogue: { next: string | null } }>(
    `${api}/atlas/overview`,
    t.readerToken,
  );
  await t.json(`${api}/atlas/detail?id=${encodeURIComponent(file)}`, t.readerToken);
  const removed = await fetch(`${t.ctx.origin}${api}/collaborators/sam`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${t.token}` },
  });
  assert.equal(removed.status, 204, "Removing the collaborator");
  const paths = [
    `/atlas/regions?cursor=${encodeURIComponent(overview.catalogue.next ?? "")}`,
    `/atlas/overview?snapshot=${encodeURIComponent(overview.snapshot.id)}`,
    `/atlas/detail?id=${encodeURIComponent(file)}`,
    `/atlas/catalogue?q=ledger`,
    "/knowledge/status",
  ];
  for (const path of paths) {
    const hidden = await fetch(`${t.ctx.origin}${api}${path}`, {
      headers: { authorization: `Bearer ${t.readerToken}` },
    });
    const missing = await fetch(`${t.ctx.origin}${ghost}${path}`, {
      headers: { authorization: `Bearer ${t.readerToken}` },
    });
    assert.equal(hidden.status, 404, path);
    assert.equal(await hidden.text(), await missing.text(), path);
  }
  t.record({ revoked: paths.length });
}
