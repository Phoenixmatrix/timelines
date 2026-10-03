// The repository Atlas in a real browser against the isolated server (CORE-171):
// a pushed multi-folder repository whose Atlas is projected without a model
// (POST /api/dev/atlas), then cold deep links, the catalogue lookup,
// Back/Forward, copied links, the explicit code-and-wiki handoff, a retired
// capability's lineage and an expired snapshot, with every request the page
// makes captured to prove what browsing reads, and what it never does.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chromium, expect as playwrightExpect, type Page } from "@playwright/test";
import type { RepoDetail } from "../../apps/website/shared/api.ts";
import type {
  AtlasAncestors,
  AtlasTimeline,
  AtlasWorkspaceComposition,
} from "../../apps/website/shared/atlas.ts";
import {
  ATLAS_FIXTURE_PACKAGE,
  atlasFixtureFiles,
  atlasFixtureSource,
  atlasFixtureTimelineFiles,
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

export async function atlasBrowserScenario(t: AtlasE2E) {
  const browserTimeout = 15_000;
  const expect = playwrightExpect.configure({ timeout: browserTimeout });
  const { owner, name, api, head, dev, first } = await atlasFixtureRepo(t);
  const base = `/${owner}/${name}/knowledge`;
  const target = "sym:billing/ledger/ledger.ts#post";
  const ancestry = await t.json<AtlasAncestors>(
    `${api}/atlas/ancestors?id=${encodeURIComponent(target)}`,
    t.token,
  );
  const path = ancestry.ancestors.slice(1).map((a) => a.id);

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
  const since = (mark: number) => seen.slice(mark);
  const atlasCalls = (mark: number) =>
    since(mark).flatMap((url) => {
      const route = ATLAS_ROUTE.exec(url.pathname)?.[1];
      return route ? [{ path: url.pathname, route, id: url.searchParams.get("id") }] : [];
    });
  /** Nothing browsing does may reach search, a model-backed index or another repository's graph. */
  const assertNoPaidFanOut = (mark: number, label: string) => {
    for (const url of since(mark)) {
      assert(!url.pathname.includes("/knowledge/search"), `${label}: ${url.pathname}`);
      assert(url.pathname !== "/api/search", `${label}: ${url.pathname}`);
      assert(!url.pathname.includes("/graph"), `${label}: ${url.pathname}`);
      if (url.pathname.includes("/atlas/"))
        assert(url.pathname.startsWith(`${api}/atlas/`), `${label}: ${url.pathname}`);
    }
  };
  const heading = (p: Page, text: string) =>
    p.getByRole("heading", { name: text, exact: true, level: 2 });

  try {
    await page.goto("/signin");
    await page.getByRole("button", { name: /Continue as marco/i }).click();
    await page.waitForURL((url) => url.pathname !== "/signin");

    // 1. A cold link to a symbol: its ancestors, a children page per level of
    // the path, and its own detail, relations and evidence. Nothing else.
    let mark = seen.length;
    await page.goto(`${base}?select=${encodeURIComponent(target)}&tl=main`);
    await expect(heading(page, "post")).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "Selected post, Symbol" })).toHaveCount(
      1,
    );
    await page.waitForLoadState("networkidle");
    const cold = atlasCalls(mark);
    for (const call of cold)
      assert(
        call.route === "overview" ||
          (call.route === "children" && path.includes(call.id ?? "")) ||
          (["ancestors", "detail", "relations", "evidence"].includes(call.route) &&
            call.id === target),
        `A cold link read something unrelated: ${call.route} ${call.id}`,
      );
    const routes = cold.map((c) => c.route);
    for (const needed of ["overview", "ancestors", "detail"])
      assert(routes.includes(needed), `A cold link didn't read ${needed}`);
    assertNoPaidFanOut(mark, "cold link");
    t.record({ coldLink: cold.map((c) => `${c.route}${c.id ? ` ${c.id}` : ""}`) });

    // 1b. Links from before the Knowledge cutover (CORE-174) keep their view:
    // the old /atlas address and the old map's `?node=` both land here, and
    // the whole graph is never read.
    mark = seen.length;
    await page.goto(`/${owner}/${name}/atlas?select=${encodeURIComponent(target)}&tl=main`);
    await page.waitForURL(
      (url) =>
        url.pathname === base &&
        url.searchParams.get("select") === target &&
        url.searchParams.get("tl") === "main",
    );
    await expect(heading(page, "post")).toBeVisible();
    await page.goto(`${base}?node=${encodeURIComponent(target)}&tl=main`);
    await page.waitForURL(
      (url) =>
        url.searchParams.get("select") === target &&
        !url.searchParams.has("node") &&
        url.searchParams.get("tl") === "main",
    );
    await expect(heading(page, "post")).toBeVisible();
    await page.waitForLoadState("networkidle");
    assertNoPaidFanOut(mark, "pre-cutover links");
    await expect(page.getByRole("button", { name: "Export graph" })).toBeVisible();

    // 2. Typing in the lookup reads only this repository's catalogue.
    mark = seen.length;
    const box = page.getByRole("searchbox", { name: "Find a capability, file or symbol" });
    await box.focus();
    await page.keyboard.type("ledger", { delay: 40 });
    const matches = page.getByRole("list", { name: "Matches" });
    const ledgerFile = matches.getByRole("button", { name: /^ledger\.ts File/ });
    await expect(ledgerFile).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /match/ })).toBeVisible();
    assert.equal(new URL(page.url()).searchParams.get("q"), "ledger");
    const typed = atlasCalls(mark);
    assert(
      typed.length > 0 && typed.every((c) => c.route === "catalogue"),
      "Typing read more than the catalogue",
    );
    assertNoPaidFanOut(mark, "lookup");
    t.record({ lookupRequests: typed.length });

    // Keyboard: choose the file; the address names it and keeps the scope.
    await ledgerFile.focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(
      (url) => url.searchParams.get("select") === "file:billing/ledger/ledger.ts",
    );
    assert.equal(new URL(page.url()).searchParams.get("tl"), "main", "The timeline scope travels");
    await expect(heading(page, "ledger.ts")).toBeVisible();

    // 3. The lens is in the address too.
    await page.getByRole("button", { name: "Used by", exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get("lens") === "in");

    // 4. Back and Forward restore each state, and move focus to it.
    await page.goBack();
    await page.waitForURL((url) => !url.searchParams.has("lens"));
    await page.goBack();
    await page.waitForURL((url) => url.searchParams.get("select") === target);
    await expect(heading(page, "post")).toBeFocused();
    await page.goForward();
    await page.waitForURL(
      (url) => url.searchParams.get("select") === "file:billing/ledger/ledger.ts",
    );
    await expect(heading(page, "ledger.ts")).toBeFocused();
    await page.goForward();
    await page.waitForURL((url) => url.searchParams.get("lens") === "in");
    await expect(page.getByRole("button", { name: "Used by", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // 5. A copied link opens the same state in a fresh page.
    const copied = page.url();
    const fresh = await context.newPage();
    fresh.setDefaultTimeout(browserTimeout);
    await fresh.goto(copied);
    await expect(heading(fresh, "ledger.ts")).toBeFocused();
    await expect(fresh.getByRole("button", { name: "Used by", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(
      fresh.getByRole("searchbox", { name: "Find a capability, file or symbol" }),
    ).toHaveValue("ledger");
    await fresh.close();

    // 6. Code and wiki search is an explicit handoff, for this repository only.
    mark = seen.length;
    const answered = page.waitForResponse((response) =>
      response.url().includes("/knowledge/search"),
    );
    await page
      .getByRole("button", { name: `Search code and wiki in ${owner}/${name}`, exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Search" });
    await expect(dialog.getByText(`${owner}/${name}`, { exact: true })).toBeVisible();
    await expect(
      dialog.getByRole("combobox", { name: `Search code and wiki in ${owner}/${name}` }),
    ).toHaveValue("ledger");
    const answer = await answered;
    // Without AI (the automatic E2E) it says search is off; with it, the
    // results say how the index lines up with the Atlas.
    if (answer.status() === 503)
      await expect(
        dialog.getByRole("paragraph").filter({ hasText: /off on this server \(no AI\)/ }),
      ).toBeVisible();
    else
      await expect(
        dialog.getByRole("paragraph").filter({
          hasText: /the Atlas (from|are both)|aren't verified against the Atlas|isn't indexed yet/,
        }),
      ).toBeVisible();
    const searches = since(mark).filter(
      (url) => url.pathname.includes("/knowledge/search") || url.pathname === "/api/search",
    );
    assert.deepEqual(
      searches.map((url) => url.pathname),
      [`${api}/knowledge/search`],
      "The handoff searches this repository once, and nothing else",
    );
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // 7. A later build merges operations into search: the old link keeps its
    // snapshot; the current one says where it went.
    const ops = await t.json<AtlasAncestors>(
      `${api}/atlas/ancestors?id=${encodeURIComponent("file:ops/deploy.ts")}`,
      t.token,
    );
    const opsCapability = ops.ancestors.find((a) => a.kind === "capability");
    assert(opsCapability, "Operations must be a capability in the base fixture");
    const second = await dev<{ snapshotId: string; seq: number }>({
      action: "publish",
      commit: head,
      variant: "merged",
    });
    await page.goto(
      `${base}?select=${encodeURIComponent(opsCapability.id)}&snapshot=${first.snapshotId}`,
    );
    await expect(heading(page, opsCapability.name)).toBeFocused();
    mark = seen.length;
    await expect(page.getByText(/A linked earlier snapshot, kept until/)).toBeVisible();
    await page.goto(`${base}?select=${encodeURIComponent(opsCapability.id)}`);
    const gone = page.getByRole("region", { name: "Not in this snapshot" });
    await expect(gone).toContainText(`“${opsCapability.name}” was merged in a later build`);
    const successor = gone.getByRole("link").first();
    await expect(successor).not.toHaveText("A successor");
    const successorName = (await successor.textContent())?.trim() ?? "";
    await successor.click();
    await expect(heading(page, successorName)).toBeVisible();

    // 7b. Main snapshot comparison (CORE-175): both snapshots named, the
    // merge's regrouping apart from source and summary-only changes, a class
    // and capability filter in the address, and a history handoff that Back
    // returns from with the comparison intact. Bounded reads of this
    // repository only.
    mark = seen.length;
    await page.goto(`${base}?snapshot=${second.snapshotId}`);
    await page.getByText("Compare with an earlier snapshot", { exact: true }).click();
    await page
      .getByRole("list", { name: "Earlier snapshots" })
      .getByRole("button", { name: new RegExp(`^#${first.seq} `) })
      .click();
    await page.waitForURL(
      (url) =>
        url.searchParams.get("compare") === first.snapshotId &&
        url.searchParams.get("snapshot") === second.snapshotId,
    );
    const comparison = page.getByRole("region", { name: "Changes between snapshots" });
    await expect(comparison).toContainText(`From #${first.seq} (${head.slice(0, 7)}`);
    await expect(comparison).toContainText(`to #${second.seq} (${head.slice(0, 7)}`);
    const changeList = comparison.getByRole("list", { name: "Changes", exact: true });
    const retired = changeList
      .getByRole("listitem")
      .filter({ hasText: `Merged into “${successorName}”` });
    await expect(retired.getByText(opsCapability.name, { exact: true })).toBeVisible();
    await expect(retired).toContainText("Capability · gone");
    await expect(comparison).toContainText("Source: 3 edited files");
    await comparison.getByRole("button", { name: /^Regrouping \d+$/ }).click();
    await page.waitForURL((url) => url.searchParams.get("changes") === "regrouping");
    const deploy = changeList.getByRole("listitem").filter({ hasText: "ops/deploy.ts" });
    await expect(deploy).toContainText(`Moved from ${opsCapability.name} to ${successorName}`);
    await expect(deploy).toContainText("Its source changed");
    await comparison.getByRole("button", { name: /^Summary only 0$/ }).click();
    await expect(comparison.getByText("No summary only changes.")).toBeVisible();
    await comparison.getByRole("button", { name: /^Regrouping \d+$/ }).click();
    await changeList.getByRole("button", { name: successorName, exact: true }).click();
    await expect(heading(page, successorName)).toBeVisible();
    await comparison.getByRole("button", { name: `Only changes in ${successorName}` }).click();
    await page.waitForURL((url) => url.searchParams.has("within"));
    await expect(comparison).toContainText(`Only in ${successorName}`);
    await expect(deploy).toBeVisible();
    await expect(changeList).not.toContainText("billing/");
    const compared = page.url();
    await page.screenshot({ path: join(t.ctx.artifacts, "browser-atlas-compare.png") });
    await deploy.getByRole("link", { name: "History", exact: true }).click();
    await page.waitForURL((url) => url.pathname.startsWith(`/${owner}/${name}/commits/${head}/`));
    await page.goBack();
    await page.waitForURL((url) => url.href === compared);
    await expect(deploy).toContainText(`Moved from ${opsCapability.name} to ${successorName}`);
    assertNoPaidFanOut(mark, "comparison");
    const compareCalls = atlasCalls(mark).filter((c) => c.route === "compare");
    assert(compareCalls.length > 0, "The comparison read GET /atlas/compare");
    t.record({ comparison: { reads: compareCalls.length, url: compared } });

    // 8. Retention expires the first snapshot: its link explains, and only an
    // explicit action opens the current view.
    await dev({ action: "expire" });
    // The comparison it named is unavailable, said as such: not "no changes".
    await page.goto(compared);
    await expect(comparison.getByRole("alert")).toContainText(
      "Comparison unavailable. The older snapshot has expired",
    );
    await expect(comparison).toContainText("That doesn't mean nothing changed.");
    await page.goto(
      `${base}?select=${encodeURIComponent(opsCapability.id)}&snapshot=${first.snapshotId}`,
    );
    await expect(heading(page, "This link's Atlas snapshot has expired")).toBeFocused();
    await page.getByRole("link", { name: "Open the current view" }).click();
    await page.waitForURL((url) => url.searchParams.get("snapshot") === second.snapshotId);
    assert.equal(new URL(page.url()).searchParams.get("select"), opsCapability.id);
    await expect(page.getByRole("region", { name: "Not in this snapshot" })).toContainText(
      "was merged",
    );

    // What it looks like, desktop and phone.
    await page.goto(
      `${base}?select=${encodeURIComponent("file:billing/ledger/ledger.ts")}&q=ledger`,
    );
    await expect(heading(page, "ledger.ts")).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /match/ })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: join(t.ctx.artifacts, "browser-atlas-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    assert(overflow <= 0, `The phone layout scrolls sideways by ${overflow}px`);
    await page.screenshot({
      path: join(t.ctx.artifacts, "browser-atlas-phone.png"),
      fullPage: true,
    });

    assertNoPaidFanOut(mark, "lineage, expiry and the phone layout");
    await context.tracing.stop();
    t.record({ repo: `${owner}/${name}`, snapshots: [first.snapshotId, second.snapshotId] });
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

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The accessibility tree under `locator` has each pattern (Playwright's aria snapshot). */
async function ariaHas(locator: import("@playwright/test").Locator, patterns: RegExp[]) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const tree = await locator.ariaSnapshot();
    const missing = patterns.find((pattern) => !pattern.test(tree));
    if (!missing) return;
    if (Date.now() > deadline) assert.fail(`The accessibility tree lacks ${missing}:\n${tree}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** The accessible name of whatever has focus, and its role. */
async function focused(page: Page): Promise<{ role: string; name: string; href: string | null }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      role: el?.getAttribute("role") ?? el?.tagName.toLowerCase() ?? "",
      name: (el?.getAttribute("aria-label") ?? el?.textContent ?? "").trim(),
      href: el?.getAttribute("href") ?? null,
    };
  });
}

/** Press `key` until focus lands on something matching, as a keyboard user would. */
async function pressUntil(
  page: Page,
  key: string,
  match: (f: { role: string; name: string; href: string | null }) => boolean,
  label: string,
  limit = 60,
) {
  for (let i = 0; i < limit; i++) {
    if (match(await focused(page))) return;
    await page.keyboard.press(key);
    // Let the page finish reacting before reading where focus went.
    await page.waitForTimeout(25);
  }
  const last = await focused(page);
  assert(
    match(last),
    `Keyboard never reached ${label} with ${key}; focus is on ${JSON.stringify(last)}`,
  );
}

/**
 * CORE-170: the Atlas's journeys by keyboard alone and by touch at 320 CSS
 * pixels, never touching the canvas: lookup, drilldown in the outline,
 * provenance and the source handoff, relationships, what changed, switching
 * to a workspace scope and returning, with accessibility-tree assertions;
 * light and dark themes, and reduced motion keeping the camera still.
 */
export async function atlasAccessibleScenario(t: AtlasE2E) {
  const browserTimeout = 15_000;
  const expect = playwrightExpect.configure({ timeout: browserTimeout });
  const { owner, name, api, head, dev } = await atlasFixtureRepo(t);
  const base = `/${owner}/${name}/knowledge`;
  const chain = await t.json<AtlasAncestors>(
    `${api}/atlas/ancestors?id=${encodeURIComponent("sym:billing/ledger/ledger.ts#post")}`,
    t.token,
  );
  // The path the outline is walked down: capability (and area), file, symbol.
  const steps = [...chain.ancestors.slice(1).map((a) => a.name), chain.entity.name];
  const capability = chain.ancestors[1]!;

  const browser = await chromium.launch({ headless: true });
  const signIn = async (page: Page) => {
    await page.goto("/signin");
    await page.getByRole("button", { name: /Continue as marco/i }).press("Enter");
    await page.waitForURL((url) => url.pathname !== "/signin");
  };
  const shots: string[] = [];
  const shot = async (page: Page, file: string, fullPage = false) => {
    await page.screenshot({ path: join(t.ctx.artifacts, file), fullPage });
    shots.push(file);
  };
  const noSidewaysScroll = async (page: Page, label: string) => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 0) {
      const wide = await page.evaluate(() =>
        [...document.querySelectorAll("body *")]
          .filter(
            (el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1,
          )
          .slice(-3)
          .map((el) => `${el.tagName}.${el.className}: ${(el.textContent ?? "").slice(0, 60)}`),
      );
      assert.fail(`${label} scrolls sideways by ${overflow}px: ${wide.join(" | ")}`);
    }
  };

  // ---- desktop, keyboard only, reduced motion, light theme -------------------------
  const desk = await browser.newContext({
    baseURL: t.ctx.origin,
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  await desk.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await desk.newPage();
  page.setDefaultTimeout(browserTimeout);
  let failure: Page = page;
  try {
    await signIn(page);
    await page.goto(`${base}?view=outline`);
    const tree = page.getByRole("tree", { name: `Outline of ${owner}/${name}` });
    await expect(tree.getByRole("treeitem").first()).toBeVisible();
    await ariaHas(tree, [
      new RegExp(`^- tree "Outline of ${escape(`${owner}/${name}`)}"`),
      new RegExp(`- treeitem "${escape(capability.name)} Capability · \\d+ files`),
    ]);
    assert.equal(await page.locator("canvas").count(), 0, "The outline view draws no canvas");
    const selection = page.getByRole("complementary", { name: "Selection" });
    await expect(selection).toContainText("Choose an entry in the outline");

    // Into the tree from the lookup, by Tab; down to the capability; open it.
    await page.getByRole("searchbox", { name: "Find a capability, file or symbol" }).focus();
    await pressUntil(page, "Tab", (f) => f.role === "treeitem", "the outline");
    for (const [i, step] of steps.entries()) {
      await pressUntil(
        page,
        "ArrowDown",
        (f) => f.role === "treeitem" && f.name.startsWith(step),
        step,
      );
      const item = tree.getByRole("treeitem", { name: new RegExp(`^${escape(step)}`) }).first();
      await expect(item).toBeFocused();
      if (i < steps.length - 1) {
        await page.keyboard.press("ArrowRight");
        await expect(item).toHaveAttribute("aria-expanded", "true");
        await expect(
          tree.locator(`[role="treeitem"][aria-level="${i + 2}"]`).first(),
        ).toBeVisible();
        // Its children, not the "Loading…" row in their place: Down on that
        // row moves on past it, as it should, before the children arrive.
        await expect(tree.locator('[role="treeitem"][aria-busy="true"]')).toHaveCount(0);
      }
    }
    // Enter selects; the address and the live region say where it is.
    await page.keyboard.press("Enter");
    await page.waitForURL((url) => url.searchParams.get("select") === chain.entity.id);
    await expect(
      selection.getByRole("heading", { name: chain.entity.name, level: 2 }),
    ).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: `Selected ${chain.entity.name}, Symbol, in` }),
    ).toHaveCount(1);
    await ariaHas(selection, [
      /- navigation "Where it sits":/,
      new RegExp(`- button "${escape(capability.name)}"`),
      new RegExp(`- heading "${escape(chain.entity.name)}" \\[level=2\\]`),
      /- heading "Source" \[level=3\]/,
      /- link "billing\/ledger\/ledger\.ts:\d+"/,
    ]);
    // Left goes back up to the file; the selection stays.
    await page.keyboard.press("ArrowLeft");
    await expect(
      tree.getByRole("treeitem", { name: new RegExp(`^${escape(steps.at(-2)!)}`) }).first(),
    ).toBeFocused();

    // Provenance: the source link, by Tab, opens the file at the indexed commit.
    await pressUntil(
      page,
      "Tab",
      (f) => (f.href ?? "").includes(`/blob/${head}/billing/ledger/ledger.ts`),
      "the source link",
    );
    await page.keyboard.press("Enter");
    await page.waitForURL((url) => url.pathname.includes(`/blob/${head}/billing/ledger/ledger.ts`));
    // Return: Back restores the selection and puts focus on it.
    await page.goBack();
    await page.waitForURL((url) => url.searchParams.get("select") === chain.entity.id);
    await expect(
      selection.getByRole("heading", { name: chain.entity.name, level: 2 }),
    ).toBeFocused();

    // Relationships: up to the file by the breadcrumb, then who uses it.
    await expect(
      selection.getByRole("navigation", { name: "Where it sits" }).getByRole("button", {
        name: "ledger.ts",
      }),
    ).toBeVisible();
    await page.keyboard.press("Shift+Tab");
    await pressUntil(page, "Shift+Tab", (f) => f.name === "ledger.ts", "the breadcrumb", 10);
    await page.keyboard.press("Enter");
    await page.waitForURL(
      (url) => url.searchParams.get("select") === "file:billing/ledger/ledger.ts",
    );
    await expect(selection.getByRole("heading", { name: "ledger.ts", level: 2 })).toBeVisible();
    await selection.getByRole("heading", { name: "ledger.ts", level: 2 }).focus();
    // The lens comes right after the heading, whether or not the file's detail
    // has loaded yet: tabbing in early doesn't leave the inspector (CORE-187).
    await pressUntil(page, "Tab", (f) => f.name === "Used by", "Used by", 3);
    await page.keyboard.press("Enter");
    await page.waitForURL((url) => url.searchParams.get("lens") === "in");
    const users = selection.getByRole("list", { name: /^Imported by/ });
    await expect(users.getByRole("button").first()).toBeVisible();
    await expect(selection.getByText(/^\d+ of \d+ links$/)).toBeVisible();
    const neighbour = ((await users.getByRole("button").first().textContent()) ?? "").trim();
    await pressUntil(page, "Tab", (f) => f.name === neighbour, `the neighbour ${neighbour}`);
    await page.keyboard.press("Enter");
    await page.waitForURL(
      (url) => url.searchParams.get("select") !== "file:billing/ledger/ledger.ts",
    );
    await expect(selection.getByRole("heading", { name: neighbour, level: 2 })).toBeVisible();

    // Scope: to a workspace of this repository and engine, by keyboard, and back.
    await pressUntil(
      page,
      "Shift+Tab",
      (f) => f.name === "Across repositories",
      "the scope link",
      120,
    );
    await page.keyboard.press("Enter");
    await page.waitForURL((url) => url.pathname === `/${owner}/-/atlas`);
    const engine = page.getByRole("checkbox", { name: /engine/ });
    await engine.focus();
    await page.keyboard.press("Space");
    await page.waitForURL((url) =>
      (url.searchParams.get("repos") ?? "").split(",").includes("engine"),
    );
    await expect(page.getByRole("checkbox", { name: new RegExp(escape(name)) })).toBeChecked();
    await page.goBack();
    await page.goBack();
    await page.waitForURL((url) => url.pathname === base);
    await expect(selection.getByRole("heading", { name: neighbour, level: 2 })).toBeFocused();

    // What changed: a later build merges operations into search, and it lands
    // while someone reads the outline by keyboard (CORE-187). The view isn't
    // pinned, so it moves to the new map on its own: no page reload, the
    // same entries open and focus on the same row. The outline and the
    // inspector say what changed in words.
    await page.goto(`${base}?view=outline`);
    const status = (text: RegExp) => page.getByRole("status").filter({ hasText: text }).first();
    await expect(status(/^Update queued$/)).toBeVisible();
    const opened = tree
      .getByRole("treeitem", { name: new RegExp(`^${escape(capability.name)}`) })
      .first();
    await opened.focus();
    await page.keyboard.press("ArrowRight");
    await expect(opened).toHaveAttribute("aria-expanded", "true");
    await expect(tree.locator('[role="treeitem"][aria-busy="true"]')).toHaveCount(0);
    const inside = tree.locator('[role="treeitem"][aria-level="2"]').first();
    await expect(inside).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(inside).toBeFocused();
    const reading = ((await inside.locator("span > span").first().textContent()) ?? "").trim();
    assert(reading, "The row being read has a name");
    await page.evaluate(() => Object.assign(window, { atlasStayed: true }));
    await dev({ action: "publish", commit: head, variant: "merged", land: true });
    const changed = tree.getByRole("treeitem", { name: /changed in this build/ }).first();
    await expect(changed).toBeVisible();
    await expect(status(/^Up to date with/)).toBeVisible();
    assert(
      await page.evaluate(() => "atlasStayed" in window),
      "A build landing must not reload the page under the reader",
    );
    assert.equal(new URL(page.url()).searchParams.get("snapshot"), null);
    await expect(opened).toHaveAttribute("aria-expanded", "true");
    await expect(
      tree.getByRole("treeitem", { name: new RegExp(`^${escape(reading)}`) }).first(),
    ).toBeFocused();

    // Pinned (anything selected), a landing build leaves the view as it is:
    // same address and snapshot, focus kept in the inspector.
    await dev({ action: "queue" });
    await changed.focus();
    await page.keyboard.press("Enter");
    await expect(selection.getByText(/changed in this build/)).toBeVisible();
    await expect(status(/^Update queued$/)).toBeVisible();
    const pinnedAt = page.url();
    assert(new URL(pinnedAt).searchParams.get("snapshot"), "A selection pins the snapshot");
    const reader = selection.getByRole("heading", { level: 2 });
    await reader.focus();
    await dev({ action: "publish", commit: head, variant: "merged", land: true });
    await expect(status(/^Up to date with/)).toBeVisible();
    await expect(reader).toBeFocused();
    assert.equal(page.url(), pinnedAt, "A landing build must not move a pinned view");
    assert(await page.evaluate(() => "atlasStayed" in window), "Nor reload it");
    await expect(selection.getByText(/changed in this build/)).toBeVisible();
    await shot(page, "browser-atlas-outline-desktop-dark.png");

    // Reduced motion: choosing a region on the map moves the camera at once.
    await page.goto(`${base}?view=map`);
    const aside = page.getByRole("complementary", { name: "Regions" });
    const region = aside
      .getByRole("tree")
      .getByRole("treeitem", { name: new RegExp(`^${escape(capability.name)}`) });
    await region.focus();
    await page.keyboard.press("Enter");
    await page.waitForURL((url) => url.searchParams.get("select") === capability.id);
    const canvas = page.locator("canvas");
    // Its contents have loaded; the camera has been asked to fly to it.
    await expect(aside.getByRole("list", { name: `Inside ${capability.name}` })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    const a = await canvas.screenshot();
    await page.waitForTimeout(120);
    const b = await canvas.screenshot();
    assert(a.equals(b), "With reduced motion the camera must not animate");

    // Light theme: the same view, readable.
    await page.evaluate(() => {
      localStorage.setItem("gitmatrix.theme", "light");
      document.documentElement.setAttribute("data-theme", "light");
    });
    await page.goto(`${base}?view=outline&select=${encodeURIComponent(capability.id)}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(selection.getByRole("heading", { name: capability.name, level: 2 })).toBeFocused();
    await shot(page, "browser-atlas-outline-desktop-light.png");
    await desk.tracing.stop();

    // ---- a 320px phone, touch only: the outline is the default ------------------------
    for (const scheme of ["light", "dark"] as const) {
      const phone = await browser.newContext({
        baseURL: t.ctx.origin,
        viewport: { width: 320, height: 640 },
        isMobile: true,
        hasTouch: true,
      });
      await phone.addInitScript((theme) => localStorage.setItem("gitmatrix.theme", theme), scheme);
      const mobile = await phone.newPage();
      failure = mobile;
      mobile.setDefaultTimeout(browserTimeout);
      try {
        await signIn(mobile);
        await mobile.goto(base);
        const phoneTree = mobile.getByRole("tree", { name: `Outline of ${owner}/${name}` });
        await expect(phoneTree).toBeVisible();
        assert.equal(await mobile.locator("canvas").count(), 0, "Phones open on the outline");
        await noSidewaysScroll(mobile, "The phone outline");
        // Tap a capability: it's read in line, with focus on it.
        await phoneTree
          .getByRole("treeitem", { name: new RegExp(`^${escape(capability.name)}`) })
          .tap();
        const heading = mobile.getByRole("heading", { name: capability.name, level: 2 });
        await expect(heading).toBeFocused();
        // Drill down from what's inside, by tap.
        const inside = mobile.getByRole("list", { name: `Inside ${capability.name}` });
        const child = inside.getByRole("button").first();
        const childName = ((await child.locator("span").first().textContent()) ?? "").trim();
        await child.tap();
        await expect(mobile.getByRole("heading", { name: childName, level: 2 })).toBeFocused();
        await noSidewaysScroll(mobile, "The phone reader");
        // Back to the outline, at the same place.
        await mobile.getByRole("button", { name: "Back to the outline" }).tap();
        await expect(phoneTree.locator('[role="treeitem"][aria-selected="true"]')).toBeFocused();
        // Lookup by touch.
        await mobile.getByRole("searchbox", { name: "Find a capability, file or symbol" }).tap();
        await mobile.keyboard.type("post");
        const match = mobile.getByRole("list", { name: "Matches" }).getByRole("button").first();
        await match.tap();
        await mobile.waitForURL((url) => url.searchParams.get("select") === chain.entity.id);
        await expect(
          mobile.getByRole("heading", { name: chain.entity.name, level: 2 }),
        ).toBeFocused();
        await noSidewaysScroll(mobile, "The phone after a lookup");
        await shot(mobile, `browser-atlas-phone-320-${scheme}.png`, true);
      } finally {
        await phone.close();
      }
    }
    t.record({ repo: `${owner}/${name}`, steps, screenshots: shots });
  } catch (error) {
    await failure
      .screenshot({ path: join(t.ctx.artifacts, "browser-atlas-a11y-failure.png"), fullPage: true })
      .catch(() => {});
    await desk.tracing
      .stop({ path: join(t.ctx.artifacts, "browser-atlas-a11y-failure.zip") })
      .catch(() => {});
    throw error;
  } finally {
    await desk.close().catch(() => {});
    await browser.close();
  }
}

/**
 * CORE-184: the workspace Atlas (/:owner/-/atlas?repos=) in a real browser.
 * Two pushed repositories, one publishing the npm package the other's billing
 * imports, compose into capabilities spanning both. From the workspace page a
 * person finds one, reads it, drills through each member to a file and cites
 * the two source locations at each repository's immutable commit; the
 * selection, lens and snapshot are in the address, so Back/Forward and a
 * copied link come back to the same place, and an expired link explains
 * before offering the current view. Every request the page makes is captured:
 * only bounded /api/accounts/:owner/atlas pages, never a whole graph.
 */
export async function atlasWorkspaceScenario(t: AtlasE2E) {
  const browserTimeout = 15_000;
  const expect = playwrightExpect.configure({ timeout: browserTimeout });
  const ledger = await atlasFixtureRepo(t, { prefix: "ledger", publishes: ATLAS_FIXTURE_PACKAGE });
  const shop = await atlasFixtureRepo(t, { prefix: "shop", variant: "consumer" });
  const owner = shop.owner;
  const repos = `${shop.name},${ledger.name}`;
  const workspaceApi = `/api/accounts/${owner}/atlas`;
  const composition = await t.json<AtlasWorkspaceComposition>(
    `${workspaceApi}/composition?repos=${repos}`,
    t.token,
  );
  const repoIds = new Map(composition.snapshot.repos.map((r) => [r.name, r.id]));
  const composite = composition.items.find(
    (x) => x.repos.includes(repoIds.get(shop.name)!) && x.repos.includes(repoIds.get(ledger.name)!),
  );
  assert(composite, "The fixture must compose a capability spanning both repositories");
  const member = (name: string) => composite.members.find((m) => m.repoId === repoIds.get(name))!;
  const shopMember = member(shop.name);
  const ledgerMember = member(ledger.name);
  assert.equal(
    composite.counts.files,
    (shopMember.counts.files ?? 0) + (ledgerMember.counts.files ?? 0),
    "A composite counts each file once",
  );
  const base = `/${owner}/-/atlas`;

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
  /** Browsing reads only bounded workspace pages: no graph, search or repository Atlas. */
  const assertBounded = (mark: number, label: string) => {
    for (const url of seen.slice(mark)) {
      assert(!url.pathname.includes("/graph"), `${label}: ${url.pathname}`);
      assert(!url.pathname.includes("/knowledge/search"), `${label}: ${url.pathname}`);
      assert(url.pathname !== "/api/search", `${label}: ${url.pathname}`);
      if (url.pathname.includes("/atlas/"))
        assert(url.pathname.startsWith(`${workspaceApi}/`), `${label}: ${url.pathname}`);
      const limit = url.searchParams.get("limit");
      assert(limit === null || Number(limit) <= 100, `${label}: unbounded ${url.href}`);
    }
  };
  const heading = (p: Page, text: string) =>
    p.getByRole("heading", { name: text, exact: true, level: 2 });
  const sourceLink = (p: Page, repo: string, commit: string) =>
    p.locator(`a[href^="/${owner}/${repo}/blob/${commit}/"]`).first();
  const citations: string[] = [];

  try {
    await page.goto("/signin");
    await page.getByRole("button", { name: /Continue as marco/i }).click();
    await page.waitForURL((url) => url.pathname !== "/signin");

    // 1. The workspace, chosen explicitly: both repositories, each at its own commit.
    let mark = seen.length;
    await page.goto(`${base}?repos=${repos}`);
    const tree = page.getByRole("tree", { name: `Outline of ${shop.name}, ${ledger.name}` });
    const compositeRow = tree.getByRole("treeitem", {
      name: new RegExp(`^${escape(composite.name)}.*Capability across repositories`),
    });
    await expect(compositeRow.first()).toBeVisible();
    // Coverage names each repository's own indexed commit: no common head.
    const coverage = page.getByRole("region", { name: "Coverage" });
    await expect(coverage.getByText(shop.head.slice(0, 7), { exact: true })).toBeVisible();
    await expect(coverage.getByText(ledger.head.slice(0, 7), { exact: true })).toBeVisible();

    // 2. Find the capability spanning both and read it.
    await compositeRow.first().click();
    await page.waitForURL((url) => url.searchParams.get("select") === composite.id);
    const snapshot = new URL(page.url()).searchParams.get("snapshot");
    assert(snapshot?.startsWith("ws1."), "Selecting pins the composite snapshot");
    await expect(heading(page, composite.name)).toBeVisible();
    await expect(page.getByText(/each file counted once/)).toBeVisible();
    const members = page.getByRole("list", { name: `Members of ${composite.name}` });
    await expect(members.getByRole("button")).toHaveCount(composite.members.length);
    // Why it's one: the importing file in shop, at shop's indexed commit.
    await expect(sourceLink(page, shop.name, shop.head)).toBeVisible();

    // 3. Drill through each member to a file, and cite it at its own commit.
    for (const [m, repo] of [
      [shopMember, shop],
      [ledgerMember, ledger],
    ] as const) {
      await members
        .getByRole("button", { name: new RegExp(`^${escape(m.name)}.*${escape(repo.name)}`) })
        .click();
      await page.waitForURL((url) => url.searchParams.get("select") === m.id);
      await expect(heading(page, m.name)).toBeVisible();
      const inside = page.getByRole("list", { name: `Inside ${m.name}` });
      // Areas open a level further; files are the first thing a source lives in.
      let entry = inside.getByRole("button").first();
      await expect(entry).toBeVisible();
      for (let depth = 0; depth < 3; depth++) {
        const label = ((await entry.locator("span").first().textContent()) ?? "").trim();
        await entry.click();
        await expect(heading(page, label)).toBeVisible();
        if (label.endsWith(".ts")) break;
        entry = page
          .getByRole("list", { name: `Inside ${label}` })
          .getByRole("button")
          .first();
        await expect(entry).toBeVisible();
      }
      const source = sourceLink(page, repo.name, repo.head);
      await expect(source).toBeVisible();
      citations.push((await source.getAttribute("href")) ?? "");
      if (m === shopMember) {
        // Back to the composite for the other member.
        await page.goto(`${base}?repos=${repos}&select=${encodeURIComponent(composite.id)}`);
        await expect(heading(page, composite.name)).toBeVisible();
      }
    }
    assert.equal(citations.length, 2);
    assert(citations[0]!.includes(`/${shop.name}/blob/${shop.head}/`), citations[0]);
    assert(citations[1]!.includes(`/${ledger.name}/blob/${ledger.head}/`), citations[1]);
    t.record({ workspaceCitations: citations });

    // 4. The member's lens and cross-repository links are in the address too.
    await page.goto(`${base}?repos=${repos}&select=${encodeURIComponent(composite.id)}`);
    await expect(heading(page, composite.name)).toBeVisible();
    await members
      .getByRole("button", {
        name: new RegExp(`^${escape(shopMember.name)}.*${escape(shop.name)}`),
      })
      .click();
    await page.waitForURL((url) => url.searchParams.get("select") === shopMember.id);
    await expect(heading(page, shopMember.name)).toBeVisible();
    await page.getByRole("button", { name: "Used by", exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get("lens") === "in");
    const crossRepo = page.getByRole("region", { name: "Across repositories" });
    await expect(crossRepo.getByText(/Depends on/).first()).toBeVisible();
    await crossRepo.getByRole("button", { name: "Related", exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get("links") === "related");

    // 5. Back and Forward restore each state, and move focus to what they show.
    await page.goBack();
    await page.waitForURL((url) => !url.searchParams.has("links"));
    await page.goBack();
    await page.waitForURL((url) => !url.searchParams.has("lens"));
    await page.goBack();
    await page.waitForURL((url) => url.searchParams.get("select") === composite.id);
    await expect(heading(page, composite.name)).toBeFocused();
    await page.goForward();
    await page.waitForURL((url) => url.searchParams.get("select") === shopMember.id);
    await expect(heading(page, shopMember.name)).toBeFocused();
    await page.goForward();
    await page.waitForURL((url) => url.searchParams.get("lens") === "in");
    await expect(page.getByRole("button", { name: "Used by", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.goForward();
    await page.waitForURL((url) => url.searchParams.get("links") === "related");

    // 6. A copied link opens the same state in a fresh page.
    const copied = page.url();
    const fresh = await context.newPage();
    fresh.setDefaultTimeout(browserTimeout);
    await fresh.goto(copied);
    await expect(heading(fresh, shopMember.name)).toBeFocused();
    await expect(fresh.getByRole("button", { name: "Used by", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(
      fresh.getByRole("region", { name: "Across repositories" }).getByRole("button", {
        name: "Related",
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    await fresh.close();

    // 7. The lookup reads the workspace catalogue, labelled by repository.
    const box = page.getByRole("searchbox", { name: "Find a capability, file or symbol" });
    await box.fill("ledger.ts");
    const matches = page.getByRole("list", { name: "Matches" });
    for (const repo of [shop, ledger])
      await expect(
        matches.getByRole("button", {
          name: new RegExp(`^ledger\\.ts\\s*File.*${escape(repo.name)}`),
        }),
      ).toBeVisible();
    await page.waitForLoadState("networkidle");
    assertBounded(mark, "workspace browsing");
    const routes = new Set(
      seen
        .slice(mark)
        .filter((u) => u.pathname.startsWith(`${workspaceApi}/`))
        .map((u) => u.pathname.slice(workspaceApi.length + 1)),
    );
    t.record({ workspaceRoutes: [...routes].sort() });

    // 8. A link to a composite snapshot that has since expired explains, and
    // only an explicit action opens the current view.
    const pinned = `${base}?repos=${repos}&select=${encodeURIComponent(composite.id)}&snapshot=${snapshot}`;
    await shop.dev({ action: "publish", commit: shop.head, variant: "consumer" });
    await shop.dev({ action: "expire" });
    mark = seen.length;
    await page.goto(pinned);
    await expect(heading(page, "This link's Atlas snapshot has expired")).toBeFocused();
    await page.getByRole("link", { name: "Open the current view" }).click();
    await page.waitForURL(
      (url) =>
        url.searchParams.get("snapshot") !== snapshot &&
        url.searchParams.get("select") === composite.id,
    );
    await expect(heading(page, composite.name)).toBeVisible();
    await page.waitForLoadState("networkidle");
    assertBounded(mark, "an expired link");
    await page.screenshot({ path: join(t.ctx.artifacts, "browser-atlas-workspace-desktop.png") });

    // 9. A phone: the outline by default, nothing scrolling sideways.
    const phone = await browser.newContext({
      baseURL: t.ctx.origin,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const mobile = await phone.newPage();
      mobile.setDefaultTimeout(browserTimeout);
      await mobile.goto("/signin");
      await mobile.getByRole("button", { name: /Continue as marco/i }).tap();
      await mobile.waitForURL((url) => url.pathname !== "/signin");
      await mobile.goto(`${base}?repos=${repos}&select=${encodeURIComponent(composite.id)}`);
      await expect(heading(mobile, composite.name)).toBeFocused();
      assert.equal(await mobile.locator("canvas").count(), 0, "Phones open on the outline");
      await expect(mobile.getByRole("tree", { name: /^Outline of / })).toBeVisible();
      const overflow = await mobile.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      assert(overflow <= 0, `The phone workspace scrolls sideways by ${overflow}px`);
      await mobile.screenshot({
        path: join(t.ctx.artifacts, "browser-atlas-workspace-phone.png"),
        fullPage: true,
      });
    } finally {
      await phone.close();
    }

    await context.tracing.stop();
    t.record({ workspace: repos, composite: composite.id, files: composite.counts.files });
  } catch (error) {
    await page
      .screenshot({
        path: join(t.ctx.artifacts, "browser-atlas-workspace-failure.png"),
        fullPage: true,
      })
      .catch(() => {});
    await context.tracing
      .stop({ path: join(t.ctx.artifacts, "browser-atlas-workspace-failure.zip") })
      .catch(() => {});
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}

/**
 * CORE-178: revocation reaches an open Knowledge tab. sam reads a private
 * repository's Atlas as a collaborator; its owner removes him. His next Atlas
 * read finds the repository gone, and the whole view gives way to "Nothing
 * here": what he had on screen doesn't outlive his access, a reload shows the
 * same, and his still-valid page link and pinned snapshot answer exactly as a
 * repository that never existed.
 */
export async function atlasRevocationScenario(t: AtlasE2E & { readerToken: string }) {
  const browserTimeout = 15_000;
  const expect = playwrightExpect.configure({ timeout: browserTimeout });
  const { owner, name, api } = await atlasFixtureRepo(t);
  const base = `/${owner}/${name}/knowledge`;
  const ghost = `/api/repos/${owner}/ghost-${randomUUID().slice(0, 8)}`;
  await t.json(api, t.token, "PATCH", { visibility: "private" });
  // sam isn't in orbit: only the collaboration lets him read it.
  await t.json(api, t.readerToken, "GET", undefined, [404]);
  await t.json(`${api}/collaborators/sam`, t.token, "PUT", { role: "read" });
  const overview = await t.json<{ snapshot: { id: string }; catalogue: { next: string | null } }>(
    `${api}/atlas/overview`,
    t.readerToken,
  );
  const cursor = overview.catalogue.next;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    baseURL: t.ctx.origin,
    viewport: { width: 1280, height: 900 },
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await context.newPage();
  page.setDefaultTimeout(browserTimeout);
  const answers: { route: string; status: number }[] = [];
  page.on("response", (response) => {
    const route = ATLAS_ROUTE.exec(new URL(response.url()).pathname)?.[1];
    if (route) answers.push({ route, status: response.status() });
  });
  try {
    await page.goto("/signin");
    await page.getByRole("button", { name: /Continue as sam/i }).click();
    await page.waitForURL((url) => url.pathname !== "/signin");
    const file = "file:billing/ledger/ledger.ts";
    await page.goto(`${base}?select=${encodeURIComponent(file)}`);
    const selected = page.getByRole("heading", { name: "ledger.ts", exact: true, level: 2 });
    await expect(selected).toBeVisible();
    const lookup = page.getByRole("searchbox", { name: "Find a capability, file or symbol" });
    await expect(lookup).toBeVisible();
    await page.waitForLoadState("networkidle");

    // The owner removes sam while his view is open.
    const removed = await fetch(`${t.ctx.origin}${api}/collaborators/sam`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${t.token}` },
    });
    assert.equal(removed.status, 204, "Removing the collaborator");
    const mark = answers.length;

    // His next Atlas read (a lookup) finds the repository gone: the view goes with it.
    await lookup.focus();
    await page.keyboard.type("search", { delay: 40 });
    await expect(page.getByRole("heading", { name: "Nothing here", level: 1 })).toBeVisible();
    await expect(selected).toHaveCount(0);
    await expect(lookup).toHaveCount(0);
    await expect(page.getByText("ledger.ts")).toHaveCount(0);
    const after = answers.slice(mark);
    assert(after.length > 0, "The lookup made no Atlas read after revocation");
    for (const a of after) assert.equal(a.status, 404, `${a.route} answered ${a.status}`);
    await page.screenshot({ path: join(t.ctx.artifacts, "browser-atlas-revoked.png") });

    // A reload (a cold start) says the same.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Nothing here", level: 1 })).toBeVisible();
    await expect(page.getByText("ledger.ts")).toHaveCount(0);

    // His still-valid page link and pinned snapshot read like a missing repository.
    for (const path of [
      `/atlas/regions?cursor=${encodeURIComponent(cursor ?? "")}`,
      `/atlas/overview?snapshot=${encodeURIComponent(overview.snapshot.id)}`,
      `/atlas/detail?id=${encodeURIComponent(file)}`,
      "/knowledge/status",
    ]) {
      const hidden = await fetch(`${t.ctx.origin}${api}${path}`, {
        headers: { authorization: `Bearer ${t.readerToken}` },
      });
      const missing = await fetch(`${t.ctx.origin}${ghost}${path}`, {
        headers: { authorization: `Bearer ${t.readerToken}` },
      });
      assert.equal(hidden.status, 404, path);
      assert.equal(await hidden.text(), await missing.text(), path);
    }
    await context.tracing.stop();
    t.record({ repo: `${owner}/${name}`, afterRevocation: after });
  } catch (error) {
    await page
      .screenshot({ path: join(t.ctx.artifacts, "browser-atlas-revoked-failure.png") })
      .catch(() => {});
    await context.tracing
      .stop({ path: join(t.ctx.artifacts, "browser-atlas-revoked-failure.zip") })
      .catch(() => {});
    throw error;
  } finally {
    await context.close().catch(() => {});
    await browser.close();
  }
}

/**
 * CORE-176: a timeline in Atlas terms. A pushed `timeline/<slug>` bookmark
 * whose overlay (stored as the overlay step would, without a build) is read
 * on the Knowledge tab with `?tl=`: the repository's bookmark, overlay, main
 * base and merge base; the capabilities it touches; each file placed where
 * main's map puts it, a new one provisionally; a capability filter in the
 * address; a source handoff on the timeline's commit that Back returns from.
 * Then it ends: read-only, nothing asks for a computation. Then the map's
 * snapshot expires: the link explains and keeps the route to the overlay.
 */
export async function atlasTimelineScenario(t: AtlasE2E) {
  const browserTimeout = 15_000;
  const expect = playwrightExpect.configure({ timeout: browserTimeout });
  const { owner, name, api, head, dev, first } = await atlasFixtureRepo(t);
  const base = `/${owner}/${name}/knowledge`;
  const slug = `atlas-${randomUUID().slice(0, 8)}`;
  const bookmark = `timeline/${slug}`;

  // The timeline's work, pushed for real to its bookmark; main stays at `head`.
  const dir = join(t.work, name);
  for (const file of atlasFixtureTimelineFiles()) {
    const path = join(dir, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, atlasFixtureSource(file).text);
  }
  await rm(join(dir, "misc/legacy.ts"));
  await t.gm(["commit", "-m", `Timeline ${slug}: suggestions, notify, ranking`], "marco", dir);
  await t.gm(["push", "-b", bookmark], "marco", dir);
  const detail = await t.json<RepoDetail>(api, t.token);
  const tip = detail.branches.find((b) => b.shortName === bookmark)?.oid;
  assert(tip && tip !== head, "The timeline push must land on its own bookmark");
  assert.equal(
    detail.branches.find((b) => b.shortName === detail.defaultBranch)?.oid,
    head,
    "Main stays where it was",
  );
  await dev({ action: "overlay", ref: bookmark, commit: tip, base: head });
  const expected = await t.json<AtlasTimeline>(
    `${api}/atlas/timeline?ref=${encodeURIComponent(bookmark)}`,
    t.token,
  );
  const search = expected.regions?.find((r) => r.id !== "group:unclassified");
  assert(search, "The timeline touches search's capability");
  const reached = search.imports.added[0]?.name;
  assert(reached, "Search's new import reaches another capability");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    baseURL: t.ctx.origin,
    viewport: { width: 1280, height: 900 },
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await context.newPage();
  page.setDefaultTimeout(browserTimeout);
  const seen: { method: string; url: URL }[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) seen.push({ method: request.method(), url });
  });
  const since = (mark: number) => seen.slice(mark);
  /**
   * Bounded Atlas reads of this repository only; never the overlay's whole list
   * or the graph. The source handoff opens the file view, whose knowledge rail
   * reads that one node (`/graph/node`): bounded, so allowed; the whole-graph
   * routes (the list, `/graph/map`, `/graph/export`) are not.
   */
  const assertBounded = (mark: number, label: string) => {
    for (const { url } of since(mark)) {
      if (url.pathname.includes("/graph"))
        assert(url.pathname.endsWith("/knowledge/graph/node"), `${label}: ${url.pathname}`);
      assert(!url.pathname.endsWith("/knowledge/overlay"), `${label}: ${url.pathname}`);
      assert(!url.pathname.includes("/knowledge/search"), `${label}: ${url.pathname}`);
      if (url.pathname.includes("/atlas/"))
        assert(url.pathname.startsWith(`${api}/atlas/`), `${label}: ${url.pathname}`);
    }
  };
  const timelineReads = (mark: number) =>
    since(mark).filter(({ url }) => url.pathname === `${api}/atlas/timeline`);

  try {
    await page.goto("/signin");
    await page.getByRole("button", { name: /Continue as marco/i }).click();
    await page.waitForURL((url) => url.pathname !== "/signin");

    // 1. The timeline in the Selection pane: its repository's facts, each known.
    let mark = seen.length;
    await page.goto(`${base}?tl=${slug}`);
    const panel = page.getByRole("region", { name: `Timeline ${slug}` });
    await expect(panel.getByRole("heading", { name: bookmark, level: 2 })).toBeVisible();
    const facts = panel.getByRole("region", { name: `${owner}/${name} on ${bookmark}` });
    await expect(facts).toContainText("Up to date");
    await expect(facts).toContainText(`Bookmark${tip.slice(0, 7)}`);
    await expect(facts).toContainText(`Main base${head.slice(0, 7)} · the same main as this map`);
    await expect(facts).toContainText(`Merge base${head.slice(0, 7)}`);
    await expect(facts).toContainText(`This map${head.slice(0, 7)}`);

    // 2. The capabilities it touches, and its files placed in them: the new
    // file by the timeline's regrouping (CORE-186), computed when its overlay
    // was stored over the capabilities it touches, and said to be.
    const touched = panel.getByRole("region", { name: "Capabilities it touches" });
    await expect(touched.getByRole("button", { name: search.name, exact: true })).toBeVisible();
    await expect(touched).toContainText(`1 new, 1 changed files`);
    await expect(touched).not.toContainText("provisionally");
    await expect(touched).toContainText(`New imports reach ${reached}.`);
    await expect(touched.getByRole("button", { name: "Unclassified", exact: true })).toBeVisible();
    const files = panel.getByRole("region", { name: "Files it changes" });
    const suggest = files.getByRole("listitem").filter({ hasText: "search/suggest.ts" });
    await expect(suggest).toContainText(
      `New: the timeline's regrouping puts it in ${search.name}.`,
    );
    await expect(files.getByRole("listitem").filter({ hasText: "notify/email.ts" })).toContainText(
      "Unclassified: the timeline's regrouping finds nothing to place it by.",
    );
    await expect(files.getByRole("listitem").filter({ hasText: "search/rank.ts" })).toContainText(
      `Now imports from ${reached}`,
    );
    await expect(panel).toContainText(
      "Regrouping was computed for this timeline over the 2 capabilities it touches (13 files), not the whole repository, against main's build #1, this map.",
    );
    await expect(panel).toContainText("Syntax changes cover all 4 changed files");
    // The capabilities it touches, marked on the map and in the outline, in words.
    const marked = `touched by timeline ${slug}`;
    await expect(
      page.getByRole("img", { name: new RegExp(`1 outlined with a dashed line: ${marked}`) }),
    ).toBeVisible();
    const outline = page.getByRole("tree", { name: `Outline of ${owner}/${name}` });
    await expect(
      outline.getByRole("treeitem", { name: new RegExp(`^${escape(search.name)}.*${marked}`) }),
    ).toHaveCount(1);
    await expect(outline.getByRole("treeitem", { name: new RegExp(marked) })).toHaveCount(1);
    await page.waitForLoadState("networkidle");
    assert(timelineReads(mark).length > 0, "The panel read GET /atlas/timeline");
    assertBounded(mark, "timeline panel");
    await page.screenshot({ path: join(t.ctx.artifacts, "browser-atlas-timeline.png") });
    // Without the timeline, nothing is marked.
    await page.goto(base);
    await expect(page.getByRole("img", { name: /Capability map/ })).toBeVisible();
    await expect(page.getByRole("img", { name: new RegExp(marked) })).toHaveCount(0);
    await expect(outline.getByRole("treeitem", { name: new RegExp(marked) })).toHaveCount(0);
    await page.goto(`${base}?tl=${slug}`);
    await expect(outline.getByRole("treeitem", { name: new RegExp(marked) })).toHaveCount(1);

    // 3. Its capability on the map, then only the timeline's changes there.
    mark = seen.length;
    await touched.getByRole("button", { name: search.name, exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get("select") === search.id);
    await expect(
      page.getByRole("heading", { name: search.name, exact: true, level: 2 }),
    ).toBeVisible();
    await panel
      .getByRole("button", { name: `Only this timeline's changes in ${search.name}` })
      .click();
    await page.waitForURL((url) => url.searchParams.get("tlwithin") === search.id);
    assert.equal(new URL(page.url()).searchParams.get("tl"), slug, "The scope stays");
    await expect(panel).toContainText(`Only in ${search.name}: 2 files`);
    await expect(files).not.toContainText("notify/email.ts");
    await expect(suggest).toBeVisible();
    const filtered = page.url();

    // 4. Source on the timeline's commit, scoped to the timeline; Back returns.
    await suggest.getByRole("link", { name: `Source at ${tip.slice(0, 7)}` }).click();
    await page.waitForURL(
      (url) =>
        url.pathname === `/${owner}/${name}/blob/${tip}/search/suggest.ts` &&
        url.searchParams.get("tl") === slug,
    );
    await expect(page.getByText("export function suggest() {}")).toBeVisible();
    await page.goBack();
    await page.waitForURL((url) => url.href === filtered);
    await expect(panel).toContainText(`Only in ${search.name}: 2 files`);
    assertBounded(mark, "filter and handoff");

    // 4b. Across repositories (CORE-186): the workspace Atlas reads the same
    // timeline in each selected repository, each part on its own; engine has
    // no such timeline and says so. Its capabilities are marked there too.
    mark = seen.length;
    await page.goto(`/${owner}/-/atlas?repos=${name},engine&tl=${slug}`);
    const wsPanel = page.getByRole("region", { name: `Timeline ${slug}` });
    await expect(
      wsPanel.getByRole("region", { name: `${owner}/${name} on ${bookmark}` }),
    ).toContainText("Up to date");
    await expect(
      wsPanel.getByRole("region", { name: `${owner}/engine on ${bookmark}` }),
    ).toContainText("Not in this repository");
    const wsFiles = wsPanel.getByRole("region", { name: "Files it changes" });
    await expect(wsFiles.getByRole("listitem")).toHaveCount(4);
    await expect(
      wsFiles.getByRole("listitem").filter({ hasText: `${name}: search/suggest.ts` }),
    ).toContainText(`New: the timeline's regrouping puts it in ${search.name}.`);
    await expect(
      page
        .getByRole("tree", { name: new RegExp(`^Outline of ${escape(name)}`) })
        .getByRole("treeitem", { name: new RegExp(`touched by timeline ${slug}`) }),
    ).toHaveCount(1);
    await page.waitForLoadState("networkidle");
    for (const { url } of since(mark))
      if (url.pathname.includes("/atlas/"))
        assert(
          url.pathname.startsWith(`/api/accounts/${owner}/atlas/`),
          `workspace timeline: ${url.pathname}`,
        );
    assert(
      since(mark).some(({ url }) => url.pathname === `/api/accounts/${owner}/atlas/timeline`),
      "The workspace panel read GET /api/accounts/:owner/atlas/timeline",
    );
    await page.screenshot({ path: join(t.ctx.artifacts, "browser-atlas-workspace-timeline.png") });

    // 5. The timeline lands: its overlay is kept read-only, and reading it
    // asks for nothing (no write, no page writing offered).
    await dev({ action: "end", ref: bookmark, reason: "landed" });
    mark = seen.length;
    await page.goto(`${base}?tl=${slug}`);
    await expect(panel).toContainText("This timeline landed");
    await expect(panel).toContainText("kept read-only: nothing here computes it again");
    await expect(facts).toContainText("Ended");
    await expect(files.getByRole("listitem")).toHaveCount(4);
    await expect(panel.getByRole("region", { name: "Timeline wiki pages" })).toContainText(
      "None were written before this timeline ended.",
    );
    await expect(panel.getByRole("button", { name: "Write pages now" })).toHaveCount(0);
    await page.waitForLoadState("networkidle");
    const writes = since(mark).filter(({ method }) => method !== "GET");
    assert.deepEqual(
      writes.map(({ method, url }) => `${method} ${url.pathname}`),
      [],
      "Reading an ended timeline writes nothing",
    );
    assertBounded(mark, "ended timeline");

    // 6. The map's snapshot expires: the link explains, keeps the route to
    // the overlay, and the current view reads it there.
    await dev({ action: "publish", commit: head });
    await dev({ action: "expire" });
    await page.goto(`${base}?snapshot=${first.snapshotId}&tl=${slug}`);
    await expect(
      page.getByRole("heading", { name: "This link's Atlas snapshot has expired", level: 2 }),
    ).toBeFocused();
    await expect(page.getByText(`Timeline ${slug}'s overlay is kept apart`)).toBeVisible();
    await page.getByRole("link", { name: "Open the current view" }).click();
    await page.waitForURL(
      (url) =>
        url.searchParams.get("tl") === slug &&
        url.searchParams.get("snapshot") !== first.snapshotId,
    );
    await expect(panel).toContainText("This timeline landed");
    await expect(files.getByRole("listitem")).toHaveCount(4);

    await context.tracing.stop();
    t.record({ timeline: { repo: `${owner}/${name}`, bookmark, tip, base: head } });
  } catch (error) {
    await page
      .screenshot({
        path: join(t.ctx.artifacts, "browser-atlas-timeline-failure.png"),
        fullPage: true,
      })
      .catch(() => {});
    await context.tracing
      .stop({ path: join(t.ctx.artifacts, "browser-atlas-timeline-failure.zip") })
      .catch(() => {});
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}
