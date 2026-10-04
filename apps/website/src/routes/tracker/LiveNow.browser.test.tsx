// "Live now" on a timeline (CORE-239) in a real browser: the latest step of
// each agent from the repository's live feed, linked into the story. The
// in-memory API has no Durable Objects, so the feed is canned here.

import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { StepFeedRecord } from "../../../shared/steps.ts";
import { commitId } from "../../testing/atlas.ts";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";

test("live now: each agent's latest step, from the feed, into the story", async () => {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "engine");
  await server.push("orbit/engine", "main", commitId());
  const slug = "search";
  await server.call("POST", "/api/tracker/orbit/timelines", {
    slug,
    name: "Search v2",
    repos: ["orbit/engine"],
  });
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const record = (seq: number, over: Partial<StepFeedRecord>): StepFeedRecord => ({
    seq,
    repo: "orbit/engine",
    timeline: slug,
    changeId: `change${seq}`,
    commitOid: commitId(),
    summary: `Step ${seq}`,
    issue: null,
    author: { id: "agt_builder", kind: "agent", name: "builder" },
    tests: null,
    why: "",
    committedAt: at(30 - seq),
    at: at(30 - seq),
    ...over,
  });
  const latest = record(3, {
    summary: "Rank results by recency",
    tests: { passed: 4, failed: 0 },
    why: "People look for what changed lately.",
  });
  const feed = [
    record(1, { at: at(25) }),
    record(2, {
      author: { id: "agt_docs", kind: "agent", name: "docs-bot" },
      tests: { passed: 1, failed: 1 },
      at: at(10),
    }),
    { ...latest, at: at(2) },
  ];
  let asked = 0;
  server.on("GET", "/api/repos/:owner/:name/steps/live", ({ url }) => {
    asked += 1;
    expect(url.searchParams.get("timeline")).toBe(slug);
    return new Response(
      feed.map((r) => `id: ${r.seq}\nevent: step\ndata: ${JSON.stringify(r)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  });

  const app = renderApp(`/tracker/orbit/timelines?tl=${slug}`);
  const live = page.getByRole("region", { name: "Live now" });
  const agents = live.getByRole("listitem");
  await expect.poll(() => agents.elements().length).toBe(2);
  // Newest first, one row per agent, with its latest step.
  await expect.element(agents.nth(0)).toMatchTextContent(/builder\s*Rank results by recency/);
  await expect.element(agents.nth(0)).toMatchTextContent(/4 passed/);
  await expect.element(agents.nth(0)).toMatchTextContent(/2 steps since/);
  await expect.element(agents.nth(0)).toMatchTextContent(/People look for what changed lately\./);
  await expect.element(agents.nth(1)).toMatchTextContent(/docs-bot\s*Step 2/);
  await expect.element(agents.nth(1)).toMatchTextContent(/1 failed/);
  expect(asked).toBeGreaterThanOrEqual(1);

  // The step opens in the story.
  await userEvent.click(agents.nth(0).getByRole("link", { name: "Rank results by recency" }));
  await app.waitForUrl(
    (url) =>
      url.pathname === `/tracker/orbit/timelines/${slug}/story` &&
      url.searchParams.get("step") === latest.commitOid &&
      url.searchParams.get("repo") === "orbit/engine",
  );
  app.unmount();
});

test("live now says how steps arrive, and stays quiet without access", async () => {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "engine");
  await server.push("orbit/engine", "main", commitId());
  await server.call("POST", "/api/tracker/orbit/timelines", {
    slug: "quiet",
    name: "Quiet",
    repos: ["orbit/engine"],
  });
  let asked = 0;
  server.on("GET", "/api/repos/:owner/:name/steps/live", () => {
    asked += 1;
    return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
  });
  const app = renderApp("/tracker/orbit/timelines?tl=quiet");
  await expect
    .element(page.getByRole("region", { name: "Live now" }))
    .toMatchTextContent(/No steps yet\. An agent.s steps show here seconds after gm step\./);
  // A 404 isn't retried: still the same requests past the 5 s retry delay
  // (development React may mount the effect twice).
  await expect.poll(() => asked).toBeGreaterThanOrEqual(1);
  const first = asked;
  await new Promise((resolve) => setTimeout(resolve, 5_500));
  expect(asked).toBe(first);
  app.unmount();
});
