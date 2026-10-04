// CORE-184 in a real browser (formerly the E2E scenario
// browser-atlas-workspace-composites-and-address): the workspace Atlas
// (/:owner/-/atlas?repos=) over two repositories, one publishing the npm
// package the other's billing imports, composed into capabilities spanning
// both. From the workspace page a person finds one, reads it, drills through
// each member to a file and cites the two source locations at each
// repository's own commit; the selection, lens and snapshot are in the
// address, so Back/Forward and a copied link come back to the same place;
// an expired link explains before offering the current view; a phone opens
// on the outline. Only bounded /api/accounts/:owner/atlas pages are read.

import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { AtlasWorkspaceComposition } from "../../../shared/atlas.ts";
import { ATLAS_FIXTURE_PACKAGE } from "../../../shared/atlasFixture.ts";
import { atlasFixtureRepo, settled, sidewaysOverflow } from "../../testing/atlas.ts";
import { renderApp } from "../../testing/render.tsx";
import { TestServer, type Recorded } from "../../testing/server.ts";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const heading = (text: string) => page.getByRole("heading", { name: text, exact: true, level: 2 });
const usedBy = () => page.getByRole("button", { name: "Used by", exact: true });
const workspaceApi = "/api/accounts/orbit/atlas";

/** Browsing reads only bounded workspace pages: no graph, search or repository Atlas. */
function expectBounded(reads: Recorded[]) {
  for (const { url } of reads) {
    expect(url.pathname).not.toContain("/graph");
    expect(url.pathname).not.toContain("/knowledge/search");
    expect(url.pathname).not.toBe("/api/search");
    if (/\/atlas\/[a-z]+$/.test(url.pathname))
      expect(url.pathname.startsWith(`${workspaceApi}/`), url.pathname).toBe(true);
    const limit = url.searchParams.get("limit");
    expect(limit === null || Number(limit) <= 100, `unbounded ${url.href}`).toBe(true);
  }
}

async function setup() {
  const server = await TestServer.start({ world: true });
  const ledger = await atlasFixtureRepo(server, {
    name: "payments",
    publishes: ATLAS_FIXTURE_PACKAGE,
  });
  const shop = await atlasFixtureRepo(server, { name: "shop", variant: "consumer" });
  const repos = `${shop.name},${ledger.name}`;
  const composition = await server.call<AtlasWorkspaceComposition>(
    "GET",
    `${workspaceApi}/composition?repos=${repos}`,
  );
  const repoIds = new Map(composition.snapshot.repos.map((r) => [r.name, r.id]));
  const composite = composition.items.find(
    (x) => x.repos.includes(repoIds.get(shop.name)!) && x.repos.includes(repoIds.get(ledger.name)!),
  );
  expect(composite, "The fixture composes a capability spanning both repositories").toBeDefined();
  const member = (name: string) => composite!.members.find((m) => m.repoId === repoIds.get(name))!;
  return {
    server,
    ledger,
    shop,
    repos,
    composite: composite!,
    shopMember: member(shop.name),
    ledgerMember: member(ledger.name),
    base: "/orbit/-/atlas",
  };
}

test("a capability across repositories, read, drilled into and cited at each commit", async () => {
  const { server, ledger, shop, repos, composite, shopMember, ledgerMember, base } = await setup();
  expect(composite.counts.files, "A composite counts each file once").toBe(
    (shopMember.counts.files ?? 0) + (ledgerMember.counts.files ?? 0),
  );
  const sourceLink = (repo: string, commit: string) =>
    document.querySelector<HTMLAnchorElement>(`a[href^="/orbit/${repo}/blob/${commit}/"]`);
  const mark = server.requests.length;

  // The workspace, chosen explicitly: both repositories, each at its own commit.
  const app = renderApp(`${base}?repos=${repos}`);
  const tree = page.getByRole("tree", { name: `Outline of ${shop.name}, ${ledger.name}` });
  const compositeRow = tree
    .getByRole("treeitem", {
      name: new RegExp(`^${escape(composite.name)}.*Capability across repositories`),
    })
    .first();
  await expect.element(compositeRow).toBeVisible();
  const coverage = page.getByRole("region", { name: "Coverage" });
  await expect.element(coverage.getByText(shop.head.slice(0, 7), { exact: true })).toBeVisible();
  await expect.element(coverage.getByText(ledger.head.slice(0, 7), { exact: true })).toBeVisible();

  // Find the capability spanning both and read it.
  await userEvent.click(compositeRow);
  await app.waitForUrl((url) => url.searchParams.get("select") === composite.id);
  expect(app.url().searchParams.get("snapshot"), "Selecting pins the composite snapshot").toMatch(
    /^ws1\./,
  );
  await expect.element(heading(composite.name)).toBeVisible();
  await expect.element(page.getByText(/each file counted once/)).toBeVisible();
  const members = page.getByRole("list", { name: `Members of ${composite.name}` });
  await expect
    .poll(() => members.getByRole("button").elements().length)
    .toBe(composite.members.length);
  // Why it's one: the importing file in shop, at shop's indexed commit.
  await expect.poll(() => sourceLink(shop.name, shop.head)).not.toBeNull();

  // Drill through each member to a file, and cite it at its own commit.
  const citations: string[] = [];
  for (const [m, repo] of [
    [shopMember, shop],
    [ledgerMember, ledger],
  ] as const) {
    await userEvent.click(
      members.getByRole("button", { name: new RegExp(`^${escape(m.name)}.*${escape(repo.name)}`) }),
    );
    await app.waitForUrl((url) => url.searchParams.get("select") === m.id);
    await expect.element(heading(m.name)).toBeVisible();
    // Areas open a level further; files are the first thing a source lives in.
    let entry = page
      .getByRole("list", { name: `Inside ${m.name}` })
      .getByRole("button")
      .first();
    for (let depth = 0; depth < 3; depth++) {
      await expect.element(entry).toBeVisible();
      const label = entry.element().querySelector("span")?.textContent?.trim() ?? "";
      await userEvent.click(entry);
      await expect.element(heading(label)).toBeVisible();
      if (label.endsWith(".ts")) break;
      entry = page
        .getByRole("list", { name: `Inside ${label}` })
        .getByRole("button")
        .first();
    }
    await expect.poll(() => sourceLink(repo.name, repo.head)).not.toBeNull();
    citations.push(sourceLink(repo.name, repo.head)!.getAttribute("href") ?? "");
    if (m === shopMember) {
      await app.navigate(`${base}?repos=${repos}&select=${encodeURIComponent(composite.id)}`);
      await expect.element(heading(composite.name)).toBeVisible();
    }
  }
  expect(citations[0]).toContain(`/${shop.name}/blob/${shop.head}/`);
  expect(citations[1]).toContain(`/${ledger.name}/blob/${ledger.head}/`);

  // The lookup reads the workspace catalogue, labelled by repository.
  await userEvent.fill(
    page.getByRole("searchbox", { name: "Find a capability, file or symbol" }),
    "ledger.ts",
  );
  const matches = page.getByRole("list", { name: "Matches" });
  for (const repo of [shop, ledger])
    await expect
      .element(
        matches.getByRole("button", {
          name: new RegExp(`^ledger\\.ts\\s*File.*${escape(repo.name)}`),
        }),
      )
      .toBeVisible();
  await settled(server);
  expectBounded(server.since(mark));
});

test("the address keeps the member, lens and links; Back, Forward and copied links restore them", async () => {
  const { repos, composite, shopMember, shop, base } = await setup();
  const app = renderApp(`${base}?repos=${repos}&select=${encodeURIComponent(composite.id)}`);
  await expect.element(heading(composite.name)).toBeVisible();
  await userEvent.click(
    page.getByRole("list", { name: `Members of ${composite.name}` }).getByRole("button", {
      name: new RegExp(`^${escape(shopMember.name)}.*${escape(shop.name)}`),
    }),
  );
  await app.waitForUrl((url) => url.searchParams.get("select") === shopMember.id);
  await expect.element(heading(shopMember.name)).toBeVisible();
  await userEvent.click(usedBy());
  await app.waitForUrl((url) => url.searchParams.get("lens") === "in");
  const crossRepo = page.getByRole("region", { name: "Across repositories" });
  await expect.element(crossRepo.getByText(/Depends on/).first()).toBeVisible();
  await userEvent.click(crossRepo.getByRole("button", { name: "Related", exact: true }));
  await app.waitForUrl((url) => url.searchParams.get("links") === "related");

  // Back and Forward restore each state, and move focus to what they show.
  await app.back();
  await app.waitForUrl((url) => !url.searchParams.has("links"));
  await app.back();
  await app.waitForUrl((url) => !url.searchParams.has("lens"));
  await app.back();
  await app.waitForUrl((url) => url.searchParams.get("select") === composite.id);
  await expect.element(heading(composite.name)).toHaveFocus();
  await app.forward();
  await app.waitForUrl((url) => url.searchParams.get("select") === shopMember.id);
  await expect.element(heading(shopMember.name)).toHaveFocus();
  await app.forward();
  await app.waitForUrl((url) => url.searchParams.get("lens") === "in");
  await expect.element(usedBy()).toHaveAttribute("aria-pressed", "true");
  await app.forward();
  await app.waitForUrl((url) => url.searchParams.get("links") === "related");

  // A copied link opens the same state in a fresh page.
  const copied = app.url();
  app.unmount();
  renderApp(copied.pathname + copied.search);
  await expect.element(heading(shopMember.name)).toHaveFocus();
  await expect.element(usedBy()).toHaveAttribute("aria-pressed", "true");
  await expect
    .element(crossRepo.getByRole("button", { name: "Related", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
});

test("an expired composite link explains, then offers the current view; phones open on the outline", async () => {
  const { server, repos, composite, shop, base } = await setup();
  const app = renderApp(`${base}?repos=${repos}`);
  await userEvent.click(
    page
      .getByRole("treeitem", {
        name: new RegExp(`^${escape(composite.name)}.*Capability across repositories`),
      })
      .first(),
  );
  await expect.element(heading(composite.name)).toBeVisible();
  // Selecting pins the composite snapshot.
  await app.waitForUrl((url) => url.searchParams.has("snapshot"));
  const pinned = app.url();
  const snapshot = pinned.searchParams.get("snapshot");
  app.unmount();

  // A later build in one member expires the composite the link pinned.
  await shop.dev({ action: "publish", commit: shop.head, variant: "consumer" });
  await shop.dev({ action: "expire" });
  const mark = server.requests.length;
  const cold = renderApp(pinned.pathname + pinned.search);
  await expect.element(heading("This link's Atlas snapshot has expired")).toHaveFocus();
  await userEvent.click(page.getByRole("link", { name: "Open the current view" }));
  await cold.waitForUrl(
    (url) =>
      url.searchParams.get("snapshot") !== snapshot &&
      url.searchParams.get("select") === composite.id,
  );
  await expect.element(heading(composite.name)).toBeVisible();
  await settled(server);
  expectBounded(server.since(mark));
  cold.unmount();

  // A phone: the outline by default, with the selection in line, nothing scrolling sideways.
  await page.viewport(390, 844);
  try {
    renderApp(`${base}?repos=${repos}&select=${encodeURIComponent(composite.id)}`);
    await expect.element(heading(composite.name)).toHaveFocus();
    expect(document.querySelectorAll("canvas"), "Phones open on the outline").toHaveLength(0);
    await expect.element(page.getByRole("tree", { name: /^Outline of / })).toBeVisible();
    expect(sidewaysOverflow()).toBeLessThanOrEqual(0);
  } finally {
    await page.viewport(1280, 900);
  }
});
