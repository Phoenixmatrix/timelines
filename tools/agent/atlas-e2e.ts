// The repository Atlas in a real browser against the isolated server (CORE-171):
// a pushed multi-folder repository whose Atlas is projected without a model
// (POST /api/dev/atlas), then cold deep links, the catalogue lookup,
// Back/Forward, copied links, the explicit code-and-wiki handoff, a retired
// capability's lineage and an expired snapshot, with every request the page
// makes captured to prove what browsing reads, and what it never does.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chromium, expect as playwrightExpect, type Page } from "@playwright/test";
import type { RepoDetail } from "../../apps/website/shared/api.ts";
import type { AtlasAncestors } from "../../apps/website/shared/atlas.ts";
import { atlasFixtureFiles, atlasFixtureSource } from "../../apps/website/shared/atlasFixture.ts";
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
export async function atlasFixtureRepo(t: AtlasE2E) {
  const owner = "orbit";
  const name = `atlas-${randomUUID().slice(0, 8)}`;
  await t.gm(["repo", "create", name, "--owner", owner, "--description", "Atlas E2E fixture"]);
  const dir = join(t.work, name);
  await t.gm(["clone", `${owner}/${name}`, dir]);
  for (const file of atlasFixtureFiles("base")) {
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
  const first = await dev<{ snapshotId: string; seq: number }>({ action: "publish", commit: head });
  return { owner, name, api, head, dev, first };
}

const ATLAS_ROUTE = /\/atlas\/([a-z]+)$/;

export async function atlasBrowserScenario(t: AtlasE2E) {
  const browserTimeout = 15_000;
  const expect = playwrightExpect.configure({ timeout: browserTimeout });
  const { owner, name, api, head, dev, first } = await atlasFixtureRepo(t);
  const base = `/${owner}/${name}/atlas`;
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

    // 8. Retention expires the first snapshot: its link explains, and only an
    // explicit action opens the current view.
    await dev({ action: "expire" });
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
  const base = `/${owner}/${name}/atlas`;
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
    await pressUntil(page, "Tab", (f) => f.name === "Used by", "Used by");
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

    // What changed: a later build merges operations into search; the outline
    // and the inspector say it in words.
    await dev({ action: "publish", commit: head, variant: "merged" });
    await page.goto(`${base}?view=outline`);
    const changed = tree.getByRole("treeitem", { name: /changed in this build/ }).first();
    await expect(changed).toBeVisible();
    await changed.focus();
    await page.keyboard.press("Enter");
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
