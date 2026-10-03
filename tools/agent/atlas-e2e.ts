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
