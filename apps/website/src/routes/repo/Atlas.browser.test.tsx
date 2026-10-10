// The repository Atlas (the Knowledge tab) in a real browser, against the
// Worker's Atlas routes in memory with the fixture's Atlas published
// (CORE-171, CORE-175, CORE-178; formerly the E2E scenarios
// browser-atlas-deep-links-lookup-and-expiry and the browser half of
// browser-atlas-revocation-clears-the-open-view): cold deep links, the
// catalogue lookup, Back/Forward, copied links, the explicit search handoff,
// a retired capability's lineage, snapshot comparison and expiry, the phone
// layout, and a revoked reader's open view. Every request the page makes is
// recorded, to prove what browsing reads and what it never does.

import { describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { AtlasAncestors } from "../../../shared/atlas.ts";
import {
  atlasCalls,
  atlasFixtureRepo,
  expectNoPaidFanOut,
  settled,
  sidewaysOverflow,
} from "../../testing/atlas.ts";
import { cannedFiles } from "../../testing/git.ts";
import { focusOn } from "../../testing/focus.ts";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";

const TARGET = "sym:billing/ledger/ledger.ts#post";
const LEDGER = "file:billing/ledger/ledger.ts";

const heading = (text: string) => page.getByRole("heading", { name: text, exact: true, level: 2 });
const lookup = () => page.getByRole("searchbox", { name: "Find a capability, file or symbol" });
const usedBy = () => page.getByRole("button", { name: "Used by", exact: true });

async function setup() {
  const server = await TestServer.start({ world: true });
  const repo = await atlasFixtureRepo(server);
  return { server, repo };
}

describe("deep links", () => {
  test("a cold link to a symbol reads its path, its detail and nothing else", async () => {
    const { server, repo } = await setup();
    const ancestry = await server.call<AtlasAncestors>(
      "GET",
      `${repo.api}/atlas/ancestors?id=${encodeURIComponent(TARGET)}`,
    );
    const path = ancestry.ancestors.slice(1).map((a) => a.id);
    const mark = server.requests.length;
    renderApp(`${repo.base}?select=${encodeURIComponent(TARGET)}&tl=main`);
    await expect.element(heading("post")).toHaveFocus();
    await expect
      .poll(
        () =>
          page.getByRole("status").filter({ hasText: "Selected post, Symbol" }).elements().length,
      )
      .toBe(1);
    await settled(server);
    const cold = atlasCalls(server, mark);
    for (const call of cold)
      expect(
        call.route === "overview" ||
          (call.route === "children" && path.includes(call.id ?? "")) ||
          (["ancestors", "detail", "relations", "evidence"].includes(call.route) &&
            call.id === TARGET),
        `A cold link read something unrelated: ${call.route} ${call.id}`,
      ).toBe(true);
    const routes = cold.map((c) => c.route);
    for (const needed of ["overview", "ancestors", "detail"]) expect(routes).toContain(needed);
    expectNoPaidFanOut(server, mark, repo.api);
  });

  test("links from before the Knowledge cutover keep their view", async () => {
    const { server, repo } = await setup();
    const mark = server.requests.length;
    const app = renderApp(`/orbit/fixture/atlas?select=${encodeURIComponent(TARGET)}&tl=main`);
    await app.waitForUrl(
      (url) =>
        url.pathname === repo.base &&
        url.searchParams.get("select") === TARGET &&
        url.searchParams.get("tl") === "main",
    );
    await expect.element(heading("post")).toBeVisible();
    app.unmount();
    const old = renderApp(`${repo.base}?node=${encodeURIComponent(TARGET)}&tl=main`);
    await old.waitForUrl(
      (url) =>
        url.searchParams.get("select") === TARGET &&
        !url.searchParams.has("node") &&
        url.searchParams.get("tl") === "main",
    );
    await expect.element(heading("post")).toBeVisible();
    await settled(server);
    expectNoPaidFanOut(server, mark, repo.api);
    await expect.element(page.getByRole("button", { name: "Export graph" })).toBeVisible();
  });
});

describe("lookup, lens and history", () => {
  test("typing reads only the catalogue; the address keeps the choice, lens and query", async () => {
    const { server, repo } = await setup();
    const app = renderApp(`${repo.base}?select=${encodeURIComponent(TARGET)}&tl=main`);
    await expect.element(heading("post")).toHaveFocus();
    await settled(server);

    // Typing in the lookup reads only this repository's catalogue.
    const mark = server.requests.length;
    await userEvent.click(lookup());
    await userEvent.keyboard("ledger");
    const ledgerFile = page
      .getByRole("list", { name: "Matches" })
      .getByRole("button", { name: /^ledger\.ts File/ });
    await expect.element(ledgerFile).toBeVisible();
    await expect.element(page.getByRole("status").filter({ hasText: /match/ })).toBeVisible();
    expect(app.url().searchParams.get("q")).toBe("ledger");
    const typed = atlasCalls(server, mark);
    expect(typed.length).toBeGreaterThan(0);
    expect(typed.map((c) => c.route)).toEqual(typed.map(() => "catalogue"));
    expectNoPaidFanOut(server, mark, repo.api);

    // Keyboard: choose the file; the address names it and keeps the scope.
    await focusOn(ledgerFile);
    await userEvent.keyboard("{Enter}");
    await app.waitForUrl((url) => url.searchParams.get("select") === LEDGER);
    expect(app.url().searchParams.get("tl"), "The timeline scope travels").toBe("main");
    await expect.element(heading("ledger.ts")).toBeVisible();

    // The lens is in the address too.
    await userEvent.click(usedBy());
    await app.waitForUrl((url) => url.searchParams.get("lens") === "in");

    // Back and Forward restore each state, and move focus to it.
    await app.back();
    await app.waitForUrl((url) => !url.searchParams.has("lens"));
    await app.back();
    await app.waitForUrl((url) => url.searchParams.get("select") === TARGET);
    await expect.element(heading("post")).toHaveFocus();
    await app.forward();
    await app.waitForUrl((url) => url.searchParams.get("select") === LEDGER);
    await expect.element(heading("ledger.ts")).toHaveFocus();
    await app.forward();
    await app.waitForUrl((url) => url.searchParams.get("lens") === "in");
    await expect.element(usedBy()).toHaveAttribute("aria-pressed", "true");

    // A copied link opens the same state in a fresh page.
    const copied = app.url();
    app.unmount();
    renderApp(copied.pathname + copied.search);
    await expect.element(heading("ledger.ts")).toHaveFocus();
    await expect.element(usedBy()).toHaveAttribute("aria-pressed", "true");
    await expect.element(lookup()).toHaveValue("ledger");
  });

  test("code and wiki search is an explicit handoff, for this repository only", async () => {
    const { server, repo } = await setup();
    renderApp(`${repo.base}?select=${encodeURIComponent(LEDGER)}&q=ledger`);
    await expect.element(heading("ledger.ts")).toBeVisible();
    await settled(server);
    const mark = server.requests.length;
    await userEvent.click(
      page.getByRole("button", { name: "Search code and wiki in orbit/fixture", exact: true }),
    );
    const dialog = page.getByRole("dialog", { name: "Search" });
    await expect.element(dialog.getByText("orbit/fixture", { exact: true })).toBeVisible();
    await expect
      .element(dialog.getByRole("combobox", { name: "Search code and wiki in orbit/fixture" }))
      .toHaveValue("ledger");
    // Without AI it says search is off (the in-memory server has no model, as non-AI E2E).
    await expect
      .element(dialog.getByRole("paragraph").filter({ hasText: /off on this server \(no AI\)/ }))
      .toBeVisible();
    const searches = server
      .since(mark)
      .filter(
        (r) => r.url.pathname.includes("/knowledge/search") || r.url.pathname === "/api/search",
      );
    expect(searches.map((r) => r.url.pathname)).toEqual([`${repo.api}/knowledge/search`]);
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
  });
});

describe("snapshots", () => {
  test("lineage, comparison and expiry, never a silent switch", async () => {
    const { server, repo } = await setup();
    // The comparison's History link opens the commits page.
    cannedFiles(server, repo.head);
    const ops = await server.call<AtlasAncestors>(
      "GET",
      `${repo.api}/atlas/ancestors?id=${encodeURIComponent("file:ops/deploy.ts")}`,
    );
    const opsCapability = ops.ancestors.find((a) => a.kind === "capability");
    expect(opsCapability, "Operations is a capability in the base fixture").toBeDefined();
    const capability = opsCapability!;
    // A later build merges operations into search.
    const second = await repo.dev<{ snapshotId: string; seq: number }>({
      action: "publish",
      commit: repo.head,
      variant: "merged",
    });

    // The old link keeps its snapshot; the current one says where it went.
    const app = renderApp(
      `${repo.base}?select=${encodeURIComponent(capability.id)}&snapshot=${repo.first.snapshotId}`,
    );
    await expect.element(heading(capability.name)).toHaveFocus();
    await expect.element(page.getByText(/A linked earlier snapshot, kept until/)).toBeVisible();
    await app.navigate(`${repo.base}?select=${encodeURIComponent(capability.id)}`);
    const gone = page.getByRole("region", { name: "Not in this snapshot" });
    await expect
      .element(gone)
      .toMatchTextContent(`“${capability.name}” was merged in a later build`);
    const successor = gone.getByRole("link").first();
    await expect.element(successor).not.toMatchTextContent(/^A successor$/);
    const successorName = successor.element().textContent?.trim() ?? "";
    await userEvent.click(successor);
    await expect.element(heading(successorName)).toBeVisible();

    // Comparison (CORE-175): both snapshots named, the merge's regrouping apart
    // from source and summary-only changes, filters in the address, and a
    // history handoff that Back returns from with the comparison intact.
    let mark = server.requests.length;
    await app.navigate(`${repo.base}?snapshot=${second.snapshotId}`);
    await userEvent.click(page.getByText("Compare with an earlier snapshot", { exact: true }));
    await userEvent.click(
      page
        .getByRole("list", { name: "Earlier snapshots" })
        .getByRole("button", { name: new RegExp(`^#${repo.first.seq} `) }),
    );
    await app.waitForUrl(
      (url) =>
        url.searchParams.get("compare") === repo.first.snapshotId &&
        url.searchParams.get("snapshot") === second.snapshotId,
    );
    const comparison = page.getByRole("region", { name: "Changes between snapshots" });
    const short = repo.head.slice(0, 7);
    await expect.element(comparison).toMatchTextContent(`From #${repo.first.seq} (${short}`);
    await expect.element(comparison).toMatchTextContent(`to #${second.seq} (${short}`);
    const changes = comparison.getByRole("list", { name: "Changes", exact: true });
    const retired = changes
      .getByRole("listitem")
      .filter({ hasText: `Merged into “${successorName}”` });
    await expect.element(retired.getByText(capability.name, { exact: true })).toBeVisible();
    await expect.element(retired).toMatchTextContent("Capability · gone");
    await expect.element(comparison).toMatchTextContent("Source: 3 edited files");
    await userEvent.click(comparison.getByRole("button", { name: /^Regrouping \d+$/ }));
    await app.waitForUrl((url) => url.searchParams.get("changes") === "regrouping");
    const deploy = changes.getByRole("listitem").filter({ hasText: "ops/deploy.ts" });
    await expect
      .element(deploy)
      .toMatchTextContent(`Moved from ${capability.name} to ${successorName}`);
    await expect.element(deploy).toMatchTextContent("Its source changed");
    await userEvent.click(comparison.getByRole("button", { name: /^Summary only 0$/ }));
    await expect.element(comparison.getByText("No summary only changes.")).toBeVisible();
    await userEvent.click(comparison.getByRole("button", { name: /^Regrouping \d+$/ }));
    await userEvent.click(changes.getByRole("button", { name: successorName, exact: true }));
    await expect.element(heading(successorName)).toBeVisible();
    await userEvent.click(
      comparison.getByRole("button", { name: `Only changes in ${successorName}` }),
    );
    await app.waitForUrl((url) => url.searchParams.has("within"));
    await expect.element(comparison).toMatchTextContent(`Only in ${successorName}`);
    await expect.element(deploy).toBeVisible();
    await expect.element(changes).not.toMatchTextContent("billing/");
    const compared = app.url();
    await userEvent.click(deploy.getByRole("link", { name: "History", exact: true }));
    await app.waitForUrl((url) => url.pathname.startsWith(`/orbit/fixture/commits/${repo.head}/`));
    await app.back();
    await app.waitForUrl((url) => url.href === compared.href);
    await expect
      .element(deploy)
      .toMatchTextContent(`Moved from ${capability.name} to ${successorName}`);
    expect(atlasCalls(server, mark).filter((c) => c.route === "compare").length).toBeGreaterThan(0);
    expectNoPaidFanOut(server, mark, repo.api);

    // Retention expires the first snapshot: the comparison it named is
    // unavailable, said as such (not "no changes"), and its link explains,
    // with only an explicit action opening the current view.
    await repo.dev({ action: "expire" });
    mark = server.requests.length;
    app.unmount();
    const fresh = renderApp(compared.pathname + compared.search);
    await expect
      .element(comparison.getByRole("alert"))
      .toMatchTextContent("Comparison unavailable. The older snapshot has expired");
    await expect.element(comparison).toMatchTextContent("That doesn't mean nothing changed.");
    await fresh.navigate(
      `${repo.base}?select=${encodeURIComponent(capability.id)}&snapshot=${repo.first.snapshotId}`,
    );
    await expect.element(heading("This link's Atlas snapshot has expired")).toHaveFocus();
    await userEvent.click(page.getByRole("link", { name: "Open the current view" }));
    await fresh.waitForUrl((url) => url.searchParams.get("snapshot") === second.snapshotId);
    expect(fresh.url().searchParams.get("select")).toBe(capability.id);
    await expect
      .element(page.getByRole("region", { name: "Not in this snapshot" }))
      .toMatchTextContent("was merged");
    await settled(server);
    expectNoPaidFanOut(server, mark, repo.api);
  });
});

test("the phone layout never scrolls sideways", async () => {
  const { server, repo } = await setup();
  await page.viewport(390, 844);
  renderApp(`${repo.base}?select=${encodeURIComponent(LEDGER)}&q=ledger`);
  await expect.element(heading("ledger.ts")).toBeVisible();
  await expect.element(page.getByRole("status").filter({ hasText: /match/ })).toBeVisible();
  await settled(server);
  expect(sidewaysOverflow()).toBeLessThanOrEqual(0);
  await page.viewport(1280, 900);
});

/**
 * CORE-178: sam reads a private repository's Atlas as a collaborator; its
 * owner removes him. His next Atlas read finds the repository gone, and the
 * whole view gives way to "Nothing here": what he had on screen doesn't
 * outlive his access, and a cold start says the same. (That his still-valid
 * cursors and pinned snapshot answer exactly like a repository that never
 * existed is the API's: worker/atlas/authorization.test.ts and the E2E.)
 */
test("revocation clears a reader's open view", async () => {
  const server = await TestServer.start({ world: true, persona: "sam" });
  const repo = await atlasFixtureRepo(server, { visibility: "private" });
  await server.call("PUT", `${repo.api}/collaborators/sam`, { role: "read" }, "marco");
  const app = renderApp(`${repo.base}?select=${encodeURIComponent(LEDGER)}`);
  const selected = heading("ledger.ts");
  await expect.element(selected).toBeVisible();
  await expect.element(lookup()).toBeVisible();
  await settled(server);

  // The owner removes sam while his view is open.
  await server.call("DELETE", `${repo.api}/collaborators/sam`, undefined, "marco");
  const mark = server.requests.length;

  // His next Atlas read (a lookup) finds the repository gone: the view goes with it.
  await userEvent.click(lookup());
  await userEvent.keyboard("search");
  await expect.element(page.getByRole("heading", { name: "Nothing here", level: 1 })).toBeVisible();
  await expect.element(selected).not.toBeInTheDocument();
  await expect.element(lookup()).not.toBeInTheDocument();
  expect(page.getByText("ledger.ts").elements()).toHaveLength(0);
  const after = server.since(mark).filter((r) => /\/atlas\/[a-z]+$/.test(r.url.pathname));
  expect(after.length, "The lookup made an Atlas read after revocation").toBeGreaterThan(0);
  for (const read of after) expect(read.status, read.url.pathname).toBe(404);

  // A cold start says the same.
  app.unmount();
  renderApp(`${repo.base}?select=${encodeURIComponent(LEDGER)}`);
  await expect.element(page.getByRole("heading", { name: "Nothing here", level: 1 })).toBeVisible();
  expect(page.getByText("ledger.ts").elements()).toHaveLength(0);
});

describe("the map view's inspector and controls (CORE-212)", () => {
  const separator = () => page.getByRole("separator", { name: "Inspector width" });
  const inspectorWidth = () =>
    Math.round(page.getByRole("complementary", { name: "Regions" }).element().clientWidth);

  test("the inspector grows with the screen, resizes from the keyboard, is remembered and resets", async () => {
    localStorage.clear();
    const { repo } = await setup();
    await page.viewport(1440, 900);
    const first = renderApp(`${repo.base}?select=${encodeURIComponent(LEDGER)}&view=map`);
    await expect.element(heading("ledger.ts")).toBeVisible();
    // 30% of the window, between 23rem and 36rem.
    await expect.poll(inspectorWidth).toBe(432);
    await focusOn(separator());
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    await expect.poll(inspectorWidth).toBe(464);
    await expect.element(separator()).toHaveAttribute("aria-valuenow", "464");
    // Back after a reload, then Home returns to the default width.
    first.unmount();
    renderApp(`${repo.base}?select=${encodeURIComponent(LEDGER)}&view=map`);
    await expect.poll(inspectorWidth).toBe(464);
    await focusOn(separator());
    await userEvent.keyboard("{Home}");
    await expect.poll(inspectorWidth).toBe(432);
    expect(localStorage.getItem("gitmatrix:atlas-pane")).toBeNull();
  });

  test("a delayed selection preserves the reader's focus and keyboard resize controls", async () => {
    localStorage.clear();
    const { server, repo } = await setup();
    await page.viewport(1440, 900);
    let entered!: () => void;
    let release!: () => void;
    const requested = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.on("GET", `${repo.api}/atlas/ancestors`, async ({ url }) => {
      const response = await server.call<AtlasAncestors>("GET", `${url.pathname}${url.search}`);
      entered();
      await blocked;
      return response;
    });
    renderApp(`${repo.base}?select=${encodeURIComponent(LEDGER)}&view=map`);
    await requested;
    try {
      await focusOn(separator());
      await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
      await expect.poll(inspectorWidth).toBe(464);
    } finally {
      release();
    }
    await expect.element(heading("ledger.ts")).toBeVisible();
    await expect.element(separator()).toHaveFocus();
    await userEvent.keyboard("{Home}");
    await expect.poll(inspectorWidth).toBe(432);
    expect(localStorage.getItem("gitmatrix:atlas-pane")).toBeNull();
  });

  test("change dots are off until asked for, and the choice is remembered", async () => {
    localStorage.clear();
    const { repo } = await setup();
    await page.viewport(1440, 900);
    const first = renderApp(`${repo.base}?view=map`);
    const toggle = page.getByRole("button", { name: "Show changes", exact: true });
    await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(toggle);
    await expect.element(toggle).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem("gitmatrix:atlas-changes")).toBe("true");
    first.unmount();
    renderApp(`${repo.base}?view=map`);
    await expect
      .element(page.getByRole("button", { name: "Show changes", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
  });

  test("narrowing by kind appears only while looking something up", async () => {
    const { repo } = await setup();
    await page.viewport(1440, 900);
    renderApp(`${repo.base}?view=map`);
    await expect.element(lookup()).toBeVisible();
    expect(page.getByRole("group", { name: "Kind" }).elements()).toHaveLength(0);
    await userEvent.type(lookup(), "ledger");
    await expect.element(page.getByRole("group", { name: "Kind" })).toBeVisible();
  });
});
