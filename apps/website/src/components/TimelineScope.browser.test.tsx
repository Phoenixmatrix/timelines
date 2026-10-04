// CORE-82 and CORE-86 in a real browser (formerly the E2E scenario
// browser-timeline-switcher-scopes-the-app): choosing a timeline in the rail
// scopes every page to it. The banner names it, links and navigation carry
// ?tl=, the code browser and CI follow its bookmark, the Knowledge tab's old
// ?timeline= becomes ?tl=, the graph's inspector flags it experimental (the
// banner shows it, Stalled leaves it out), and Back to main leaves it. The
// timeline, its bookmark and the flag are the Worker's own, in memory; file
// listings and CI runs are canned.

import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { CiRunList } from "../../shared/api.ts";
import type { TimelineList } from "../../shared/timelines.ts";
import { commitId } from "../testing/atlas.ts";
import { cannedFiles } from "../testing/git.ts";
import { renderApp } from "../testing/render.tsx";
import { TestServer } from "../testing/server.ts";

test("a timeline chosen in the rail scopes code, CI, Knowledge and the timelines graph", async () => {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "engine");
  const head = commitId();
  await server.push("orbit/engine", "main", head);
  const slug = `switch-${commitId().slice(0, 8)}`;
  const name = `Switcher ${slug.slice(-8)}`;
  const bookmark = `timeline/${slug}`;
  // Forking writes the bookmark in the repository at main's tip.
  await server.call("POST", "/api/tracker/orbit/timelines", {
    slug,
    name,
    repos: ["orbit/engine"],
  });
  // Files, history and runs need git objects and runners, which aren't here.
  cannedFiles(server, head);
  server.on("GET", "/api/repos/:owner/:name/ci", (): CiRunList => ({ runs: [], runner: "local" }));

  const app = renderApp("/orbit/engine");
  const banner = page.getByRole("region", { name: "Timeline scope" });
  await expect.element(page.getByRole("link", { name: "CI", exact: true })).toBeVisible();
  expect(banner.elements()).toHaveLength(0);

  await userEvent.click(page.getByRole("button", { name: /^Timeline: main/ }));
  await userEvent.click(page.getByRole("link", { name: new RegExp(name) }));
  await app.waitForUrl((url) => url.searchParams.get("tl") === slug);
  await expect.element(banner).toMatchTextContent(name);
  await expect.element(banner).toMatchTextContent(`Code on ${bookmark}`);
  await expect.element(page.getByLabelText("Branch or tag")).toMatchTextContent(bookmark);

  // Links carry the scope, and so does navigating by them.
  const ci = page.getByRole("link", { name: "CI", exact: true });
  await expect.poll(() => ci.element().getAttribute("href")).toMatch(new RegExp(`[?&]tl=${slug}`));
  await userEvent.click(ci);
  await app.waitForUrl((url) => url.pathname.endsWith("/ci"));
  expect(app.url().searchParams.get("tl"), "Navigation keeps the scope").toBe(slug);
  await expect.element(banner).toMatchTextContent(`Runs on ${bookmark}`);
  expect(
    server.requests.some(
      (r) =>
        r.url.pathname === "/api/repos/orbit/engine/ci" &&
        r.url.searchParams.get("ref") === bookmark,
    ),
    "CI lists the bookmark's runs",
  ).toBe(true);

  // The Knowledge tab's ?timeline= from before the switcher becomes ?tl=.
  await app.navigate(`/orbit/engine/knowledge?timeline=${slug}`);
  await app.waitForUrl((url) => url.searchParams.get("tl") === slug);
  expect(app.url().searchParams.get("timeline")).toBeNull();
  await expect.element(banner).toMatchTextContent(name);

  // CORE-86: the graph's inspector flags it experimental, which the banner
  // shows, and the Stalled view leaves it out.
  await app.navigate(`/tracker/orbit/timelines?tl=${slug}`);
  const flag = page.getByRole("switch", { name: "Experimental" });
  await expect.element(flag).toHaveAttribute("aria-checked", "false");
  await userEvent.click(flag);
  await expect.element(flag).toHaveAttribute("aria-checked", "true");
  await expect.element(banner.getByText("Experimental", { exact: true })).toBeVisible();
  const listed = await server.call<TimelineList>("GET", "/api/tracker/orbit/timelines");
  expect(listed.timelines.find((t) => t.slug === slug)?.experimental).toBe(true);
  await userEvent.click(page.getByRole("button", { name: /^Stalled/ }));
  await expect.element(page.getByText(/Experimental timelines are left out/)).toBeVisible();

  await userEvent.click(banner.getByRole("link", { name: "Back to main" }));
  await app.waitForUrl((url) => url.searchParams.get("tl") === "main");
  await expect.element(banner).not.toBeInTheDocument();
});
