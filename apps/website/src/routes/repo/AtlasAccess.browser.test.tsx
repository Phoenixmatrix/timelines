// CORE-170 and CORE-187 in a real browser (formerly the E2E scenario
// browser-atlas-keyboard-touch-themes-and-motion): the Atlas's journeys by
// keyboard alone and by touch at 320 CSS pixels, never through the canvas
// (lookup, drilldown in the outline, provenance and the source handoff,
// relationships, switching to a workspace scope and back); a Knowledge build
// landing under a keyboard reader; light and dark themes; and reduced motion
// keeping the camera still.

import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";
import { type Locator, page, userEvent } from "vite-plus/test/browser";
import type { AtlasAncestors } from "../../../shared/atlas.ts";
import { atlasFixtureRepo, settled, sidewaysOverflow } from "../../testing/atlas.ts";
import { focused, focusOn, press, pressUntil, tap } from "../../testing/focus.ts";
import { renderApp } from "../../testing/render.tsx";
import { browserCommands, TestServer } from "../../testing/server.ts";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TARGET = "sym:billing/ledger/ledger.ts#post";
const LEDGER = "file:billing/ledger/ledger.ts";

async function setup() {
  const server = await TestServer.start({ world: true });
  const repo = await atlasFixtureRepo(server);
  const chain = await server.call<AtlasAncestors>(
    "GET",
    `${repo.api}/atlas/ancestors?id=${encodeURIComponent(TARGET)}`,
  );
  // The path the outline is walked down: capability (and area), file, symbol.
  const steps = [...chain.ancestors.slice(1).map((a) => a.name), chain.entity.name];
  const capability = chain.ancestors[1]!;
  return { server, repo, chain, steps, capability };
}

const outline = (name: string) => page.getByRole("tree", { name: `Outline of orbit/${name}` });
const selection = () => page.getByRole("complementary", { name: "Selection" });
const treeitem = (tree: ReturnType<typeof outline>, start: string) =>
  tree.getByRole("treeitem", { name: new RegExp(`^${escape(start)}`) }).first();
const busyRows = () => document.querySelectorAll('[role="treeitem"][aria-busy="true"]').length;

describe("by keyboard alone", () => {
  test("lookup, drilldown, provenance, relationships and a workspace scope", async () => {
    const { server, repo, chain, steps, capability } = await setup();
    // A second repository, so the workspace scope has one to add.
    await server.repo("orbit", "engine");
    const app = renderApp(`${repo.base}?view=outline`);
    const tree = outline(repo.name);
    await expect.element(tree.getByRole("treeitem").first()).toBeVisible();
    await expect
      .element(
        tree.getByRole("treeitem", {
          name: new RegExp(`^${escape(capability.name)} Capability · \\d+ files`),
        }),
      )
      .toBeVisible();
    expect(document.querySelectorAll("canvas"), "The outline view draws no canvas").toHaveLength(0);
    await expect.element(selection()).toMatchTextContent("Choose an entry in the outline");

    // Into the tree from the lookup, by Tab; down the path, opening each level.
    await focusOn(page.getByRole("searchbox", { name: "Find a capability, file or symbol" }));
    await pressUntil("Tab", (f) => f.role === "treeitem", "the outline");
    for (const [i, step] of steps.entries()) {
      await pressUntil("ArrowDown", (f) => f.role === "treeitem" && f.name.startsWith(step), step);
      const item = treeitem(tree, step);
      await expect.element(item).toHaveFocus();
      if (i < steps.length - 1) {
        await press("ArrowRight");
        await expect.element(item).toHaveAttribute("aria-expanded", "true");
        await expect
          .poll(() => tree.element().querySelector(`[role="treeitem"][aria-level="${i + 2}"]`))
          .not.toBeNull();
        // Its children, not the "Loading…" row in their place.
        await expect.poll(busyRows).toBe(0);
      }
    }
    // Enter selects; the address and the live region say where it is.
    await press("Enter");
    await app.waitForUrl((url) => url.searchParams.get("select") === chain.entity.id);
    const reader = selection().getByRole("heading", { name: chain.entity.name, level: 2 });
    await expect.element(reader).toBeVisible();
    await expect
      .poll(
        () =>
          page
            .getByRole("status")
            .filter({ hasText: `Selected ${chain.entity.name}, Symbol, in` })
            .elements().length,
      )
      .toBe(1);
    const where = selection().getByRole("navigation", { name: "Where it sits" });
    await expect.element(where.getByRole("button", { name: capability.name })).toBeVisible();
    await expect
      .element(selection().getByRole("heading", { name: "Source", level: 3 }))
      .toBeVisible();
    await expect
      .element(selection().getByRole("link", { name: /billing\/ledger\/ledger\.ts:\d+/ }))
      .toBeVisible();
    // Left goes back up to the file; the selection stays.
    await press("ArrowLeft");
    await expect.element(treeitem(tree, steps.at(-2)!)).toHaveFocus();

    // Provenance: the source link, by Tab, opens the file at the indexed commit.
    await pressUntil(
      "Tab",
      (f) => (f.href ?? "").includes(`/blob/${repo.head}/billing/ledger/ledger.ts`),
      "the source link",
    );
    await press("Enter");
    await app.waitForUrl((url) =>
      url.pathname.includes(`/blob/${repo.head}/billing/ledger/ledger.ts`),
    );
    // Return: Back restores the selection and puts focus on it.
    await app.back();
    await app.waitForUrl((url) => url.searchParams.get("select") === chain.entity.id);
    await expect.element(reader).toHaveFocus();

    // Relationships: up to the file by the breadcrumb, then who uses it.
    await expect.element(where.getByRole("button", { name: "ledger.ts" })).toBeVisible();
    await press("Shift+Tab");
    await pressUntil("Shift+Tab", (f) => f.name === "ledger.ts", "the breadcrumb", 10);
    await press("Enter");
    await app.waitForUrl((url) => url.searchParams.get("select") === LEDGER);
    const file = selection().getByRole("heading", { name: "ledger.ts", level: 2 });
    await expect.element(file).toBeVisible();
    await focusOn(file);
    // The lens comes right after the heading, whether or not the file's detail
    // has loaded yet: tabbing in early doesn't leave the inspector (CORE-187).
    await pressUntil("Tab", (f) => f.name === "Used by", "Used by", 3);
    await press("Enter");
    await app.waitForUrl((url) => url.searchParams.get("lens") === "in");
    const users = selection().getByRole("list", { name: /^Imported by/ });
    await expect.element(users.getByRole("button").first()).toBeVisible();
    await expect.element(selection().getByText(/^\d+ of \d+ links$/)).toBeVisible();
    const neighbour = users.getByRole("button").first().element().textContent?.trim() ?? "";
    expect(neighbour).not.toBe("");
    await pressUntil("Tab", (f) => f.name === neighbour, `the neighbour ${neighbour}`);
    await press("Enter");
    await app.waitForUrl((url) => url.searchParams.get("select") !== LEDGER);
    const next = selection().getByRole("heading", { name: neighbour, level: 2 });
    await expect.element(next).toBeVisible();

    // Scope: to a workspace of this repository and engine, by keyboard, and back.
    await pressUntil("Shift+Tab", (f) => f.name === "Across repositories", "the scope link", 120);
    await press("Enter");
    await app.waitForUrl((url) => url.pathname === "/orbit/-/atlas");
    await focusOn(page.getByRole("checkbox", { name: /engine/ }));
    await press("Space");
    await app.waitForUrl((url) =>
      (url.searchParams.get("repos") ?? "").split(",").includes("engine"),
    );
    await expect
      .element(page.getByRole("checkbox", { name: new RegExp(escape(repo.name)) }))
      .toBeChecked();
    await app.back();
    await app.back();
    await app.waitForUrl((url) => url.pathname === repo.base);
    await expect.element(next).toHaveFocus();
  });

  test("a build lands under a keyboard reader without moving them", async () => {
    const { repo, capability } = await setup();
    // What changed: a later build merges operations into search, and it lands
    // while someone reads the outline by keyboard (CORE-187). The view isn't
    // pinned, so it moves to the new map on its own: no page reload, the same
    // entries open and focus on the same row; the outline and the inspector
    // say what changed in words. The page checks a build's status every 2 s,
    // on a fake clock here.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const polled = (locator: Locator) =>
      expect
        .poll(async () => (await vi.advanceTimersByTimeAsync(2_000), locator.elements().length))
        .toBeGreaterThan(0);
    const app = renderApp(`${repo.base}?view=outline`);
    const tree = outline(repo.name);
    const status = (text: RegExp) => page.getByRole("status").filter({ hasText: text }).first();
    await expect.element(status(/ · update queued$/)).toBeVisible();
    const opened = treeitem(tree, capability.name);
    await expect.element(opened).toBeVisible();
    await focusOn(opened);
    await press("ArrowRight");
    await expect.element(opened).toHaveAttribute("aria-expanded", "true");
    await expect.poll(busyRows).toBe(0);
    const inside = tree.element().querySelector<HTMLElement>('[role="treeitem"][aria-level="2"]');
    expect(inside).not.toBeNull();
    await press("ArrowDown");
    expect(document.activeElement).toBe(inside);
    const reading = inside!.querySelector("span > span")?.textContent?.trim() ?? "";
    expect(reading, "The row being read has a name").not.toBe("");
    // (A page reload would end this test: it runs in the page.)
    await repo.dev({ action: "publish", commit: repo.head, variant: "merged", land: true });
    const changed = tree.getByRole("treeitem", { name: /changed in this build/ }).first();
    await polled(changed);
    await expect.element(changed).toBeVisible();
    await expect.element(status(/^Up to date with/)).toBeVisible();
    expect(app.url().searchParams.get("snapshot")).toBeNull();
    await expect.element(opened).toHaveAttribute("aria-expanded", "true");
    await expect.element(treeitem(tree, reading)).toHaveFocus();

    // Pinned (anything selected), a landing build leaves the view as it is:
    // same address and snapshot, focus kept in the inspector.
    await repo.dev({ action: "queue" });
    await focusOn(changed);
    await press("Enter");
    await expect.element(selection().getByText(/changed in this build/)).toBeVisible();
    await polled(status(/ · update queued$/));
    const pinnedAt = app.url().href;
    expect(app.url().searchParams.get("snapshot"), "A selection pins the snapshot").toBeTruthy();
    const reader = selection().getByRole("heading", { level: 2 });
    await focusOn(reader);
    await repo.dev({ action: "publish", commit: repo.head, variant: "merged", land: true });
    await polled(status(/^Up to date with/));
    await expect.element(reader).toHaveFocus();
    expect(app.url().href, "A landing build must not move a pinned view").toBe(pinnedAt);
    await expect.element(selection().getByText(/changed in this build/)).toBeVisible();
  });
});

describe("themes and motion", () => {
  test("with reduced motion, choosing a region moves the camera at once", async () => {
    const { server, repo, capability } = await setup();
    await browserCommands.emulateMedia({ reducedMotion: "reduce" });
    try {
      const app = renderApp(`${repo.base}?view=map`);
      const aside = page.getByRole("complementary", { name: "Regions" });
      const regions = aside.getByRole("tree");
      await expect.element(regions.getByRole("treeitem").first()).toBeVisible();
      const other = regions
        .getByRole("treeitem")
        .elements()
        .find((el) => !el.textContent?.startsWith(capability.name));
      expect(other, "The map has a second region").toBeDefined();
      const choose = async (row: Element, name: string) => {
        (row as HTMLElement).focus();
        await press("Enter");
        await expect.element(aside.getByRole("list", { name: `Inside ${name}` })).toBeVisible();
        await settled(server);
      };
      // Each region's contents load once; after that, choosing one only moves the camera.
      const region = regions
        .getByRole("treeitem", { name: new RegExp(`^${escape(capability.name)}`) })
        .element();
      await choose(region, capability.name);
      await choose(other!, other!.querySelector("span > span")?.textContent?.trim() ?? "");
      (region as HTMLElement).focus();
      await press("Enter");
      await app.waitForUrl((url) => url.searchParams.get("select") === capability.id);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const canvas = page.elementLocator(document.querySelector("canvas")!);
      // A flight takes 420ms: mid-flight and long after must be the same frame.
      const early = await canvas.screenshot({ save: false });
      await new Promise((resolve) => setTimeout(resolve, 600));
      const late = await canvas.screenshot({ save: false });
      expect(early === late, "With reduced motion the camera must not animate").toBe(true);
    } finally {
      await browserCommands.emulateMedia({ reducedMotion: "no-preference" });
    }
  });

  test("the light theme reads the same view", async () => {
    const { repo, capability } = await setup();
    localStorage.setItem("gitmatrix.theme", "light");
    try {
      renderApp(`${repo.base}?view=outline&select=${encodeURIComponent(capability.id)}`);
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
      await expect
        .element(selection().getByRole("heading", { name: capability.name, level: 2 }))
        .toHaveFocus();
      // The theme's own ink, not the dark default, on the selection.
      const ink = getComputedStyle(document.documentElement).getPropertyValue("--ink").trim();
      localStorage.setItem("gitmatrix.theme", "dark");
      document.documentElement.setAttribute("data-theme", "dark");
      expect(getComputedStyle(document.documentElement).getPropertyValue("--ink").trim()).not.toBe(
        ink,
      );
    } finally {
      localStorage.removeItem("gitmatrix.theme");
      document.documentElement.setAttribute("data-theme", "dark");
    }
  });
});

describe("a 320px phone, by touch", () => {
  // In the light theme: dark is the default, and no step depends on it.
  const scheme = "light";
  test("the outline is the default, in the light theme", async () => {
    const { repo, chain, capability } = await setup();
    localStorage.setItem("gitmatrix.theme", scheme);
    await page.viewport(320, 640);
    try {
      const app = renderApp(repo.base);
      const tree = outline(repo.name);
      await expect.element(tree).toBeVisible();
      expect(document.documentElement.getAttribute("data-theme")).toBe(scheme);
      expect(document.querySelectorAll("canvas"), "Phones open on the outline").toHaveLength(0);
      expect(sidewaysOverflow(), "The phone outline scrolls sideways").toBeLessThanOrEqual(0);
      // Tap a capability: it's read in line, with focus on it.
      await tap(treeitem(tree, capability.name));
      await expect
        .element(page.getByRole("heading", { name: capability.name, level: 2 }))
        .toHaveFocus();
      // Drill down from what's inside, by tap.
      const inside = page.getByRole("list", { name: `Inside ${capability.name}` });
      const child = inside.getByRole("button").first();
      await expect.element(child).toBeVisible();
      const childName = child.element().querySelector("span")?.textContent?.trim() ?? "";
      await tap(child);
      await expect.element(page.getByRole("heading", { name: childName, level: 2 })).toHaveFocus();
      expect(sidewaysOverflow(), "The phone reader scrolls sideways").toBeLessThanOrEqual(0);
      // Back to the outline, at the same place.
      await tap(page.getByRole("button", { name: "Back to the outline" }));
      await expect
        .poll(() => document.activeElement?.matches('[role="treeitem"][aria-selected="true"]'))
        .toBe(true);
      // Lookup by touch.
      await tap(page.getByRole("searchbox", { name: "Find a capability, file or symbol" }));
      await userEvent.keyboard("post");
      await tap(page.getByRole("list", { name: "Matches" }).getByRole("button").first());
      await app.waitForUrl((url) => url.searchParams.get("select") === chain.entity.id);
      await expect
        .element(page.getByRole("heading", { name: chain.entity.name, level: 2 }))
        .toHaveFocus();
      expect(sidewaysOverflow(), "The phone after a lookup").toBeLessThanOrEqual(0);
      expect(focused().role).not.toBe("body");
    } finally {
      localStorage.removeItem("gitmatrix.theme");
      document.documentElement.setAttribute("data-theme", "dark");
      await page.viewport(1280, 900);
    }
  });
});
