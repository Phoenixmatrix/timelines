// Needs you in a real browser, against an in-memory server: each request says
// what the work behind it is doing (CORE-386), and History keeps answered and
// withdrawn requests with what was said on the issue next (CORE-387).

import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { renderApp } from "../testing/render.tsx";
import { TestServer } from "../testing/server.ts";
import { mutate, timelineWorld } from "../testing/timelines.ts";

/** A team, an issue, and an agent of the signed-in person holding it in session "laptop". */
async function world() {
  const server = await TestServer.start({ world: true });
  await mutate(server, [
    { kind: "team.create", id: "nyt", data: { key: "NYT", name: "Needs you" } },
    { kind: "issue.create", id: "cache", data: { teamId: "nyt", title: "Add a cache" } },
  ]);
  const { agent } = await server.call<{ agent: { id: string } }>("POST", "/api/agents", {
    name: "builder",
  });
  const contract = await server.trackerContract("orbit");
  const asAgent = (mutations: unknown[]) =>
    server.callAsAgent(agent.id, "POST", "/api/tracker/orbit/mutate", {
      ...contract,
      operationId: crypto.randomUUID(),
      mutations,
    });
  await asAgent([{ kind: "issue.claim", id: "cache", data: { agent: "laptop" } }]);
  return { server, asAgent };
}

const ask = (id: string, prompt: string) => ({
  kind: "request.open",
  id,
  data: { issueId: "cache", kind: "question", prompt },
});
const note = (id: string, kind: string, body: string) => ({
  kind: "comment.add",
  id,
  data: { issueId: "cache", kind, body },
});

test("Needs you: a request says who is on its issue, where it stands and what it's doing (CORE-386)", async () => {
  const { asAgent } = await world();
  await asAgent([
    note(
      "cp",
      "checkpoint",
      "Cache wired; next: pick a region\n\nTried us-east and eu-west locally.",
    ),
    ask("q1", "Which region should the cache use?"),
  ]);
  renderApp("/needs-you");
  const card = page.getByRole("article").filter({ hasText: "Which region should the cache use?" });
  const work = card.getByRole("region", { name: "The work behind it" });
  await expect.element(work.getByText(/^builder for /)).toBeVisible();
  await expect.element(work.getByText("laptop", { exact: true })).toBeVisible();
  await expect.element(work.getByText(/In progress/)).toBeVisible();
  // The checkpoint's first line, the rest on request.
  await expect.element(work.getByText("Cache wired; next: pick a region")).toBeVisible();
  await expect.element(work.getByText("Tried us-east and eu-west locally.")).not.toBeVisible();
  await userEvent.click(work.getByText("Cache wired; next: pick a region"));
  await expect.element(work.getByText("Tried us-east and eu-west locally.")).toBeVisible();
});

test("Needs you: a request whose issue has no checkpoint says so", async () => {
  const { asAgent } = await world();
  await asAgent([ask("q1", "Should retries back off?")]);
  renderApp("/needs-you");
  const work = page
    .getByRole("article")
    .filter({ hasText: "Should retries back off?" })
    .getByRole("region", { name: "The work behind it" });
  await expect.element(work.getByText(/No checkpoint yet/)).toBeVisible();
});

test("Needs you: History keeps answered and withdrawn requests, and what came next (CORE-387)", async () => {
  const { server, asAgent } = await world();
  await mutate(server, [ask("a0", "Is the old index safe to drop?")]);
  await asAgent([ask("q1", "Which region should the cache use?")]);
  await mutate(server, [{ kind: "request.answer", id: "q1", data: { answer: "us-east" } }]);
  await asAgent([note("after", "comment", "Using us-east now.")]);
  // Asked before the answered one, withdrawn after it: nothing has been said
  // on the issue since, and it's first, by when it closed.
  await mutate(server, [{ kind: "request.cancel", id: "a0" }]);

  const app = renderApp("/needs-you");
  await expect.element(page.getByText("Nothing is waiting on you.")).toBeVisible();
  await userEvent.click(page.getByRole("link", { name: "History" }));
  await app.waitForUrl((url) => url.search === "?view=history");
  await expect
    .element(page.getByRole("link", { name: "History" }))
    .toHaveAttribute("aria-current", "page");

  const answered = page
    .getByRole("article")
    .filter({ hasText: "Which region should the cache use?" });
  await expect.element(answered.getByText("us-east", { exact: true })).toBeVisible();
  await expect.element(answered.getByText("Using us-east now.")).toBeVisible();
  await expect.element(answered.getByText(/^Next on the issue from builder for /)).toBeVisible();
  const withdrawn = page.getByRole("article").filter({ hasText: "Is the old index safe to drop?" });
  await expect.element(withdrawn.getByText("Canceled.")).toBeVisible();
  await expect
    .element(withdrawn.getByText(/Nothing has been said on the issue since/))
    .toBeVisible();
  // Newest first by when each closed: the withdrawal came after the answer,
  // though it was asked first (and its id sorts first).
  const prompts = page
    .getByRole("article")
    .elements()
    .map((article) => article.textContent ?? "");
  expect(prompts.findIndex((text) => text.includes("old index"))).toBeLessThan(
    prompts.findIndex((text) => text.includes("Which region")),
  );
});

test("Needs you: History shows older requests a page at a time", async () => {
  const { server, asAgent } = await world();
  const ids = Array.from({ length: 27 }, (_, i) => `h${String(i).padStart(2, "0")}`);
  await asAgent(ids.map((id) => ask(id, `Question ${id}?`)));
  await mutate(
    server,
    ids.map((id) => ({ kind: "request.answer", id, data: { answer: `Answer ${id}` } })),
  );
  renderApp("/needs-you?view=history");
  const cards = page.getByRole("article");
  await expect.element(cards.nth(24)).toBeVisible();
  expect(cards.elements()).toHaveLength(25);
  await userEvent.click(page.getByRole("button", { name: "Show older" }));
  await expect.element(cards.nth(26)).toBeVisible();
  expect(cards.elements()).toHaveLength(27);
  // Newest first (answered together: then by id), every request once, and
  // nothing left to show.
  expect(
    cards.elements().map((card) => /Question (h\d+)\?/.exec(card.textContent ?? "")?.[1]),
  ).toEqual(ids.toReversed());
  const shown = new Set(
    cards.elements().map((card) => /Question (h\d+)\?/.exec(card.textContent ?? "")?.[1]),
  );
  expect(shown.size).toBe(27);
  await expect.element(page.getByRole("button", { name: "Show older" })).not.toBeInTheDocument();
});

test("Needs you: work in a timeline says what it's doing there (CORE-386)", async () => {
  const server = await TestServer.start({ world: true });
  const timeline = await timelineWorld(server);
  const { agent } = await server.call<{ agent: { id: string } }>("POST", "/api/agents", {
    name: "builder",
  });
  const contract = await server.trackerContract("orbit");
  const inTimeline = (mutations: unknown[]) =>
    server.callAsAgent(agent.id, "POST", "/api/tracker/orbit/mutate", {
      ...contract,
      operationId: crypto.randomUUID(),
      timeline: timeline.slug,
      mutations,
    });
  await inTimeline([
    { kind: "issue.claim", id: timeline.issue, data: { agent: "laptop" } },
    {
      kind: "comment.add",
      id: "tcp",
      data: { issueId: timeline.issue, kind: "checkpoint", body: "Index rebuilt in the timeline" },
    },
    {
      kind: "request.open",
      id: "tq",
      data: { issueId: timeline.issue, kind: "question", prompt: "Keep the old index around?" },
    },
  ]);
  renderApp("/needs-you");
  const work = page
    .getByRole("article")
    .filter({ hasText: "Keep the old index around?" })
    .getByRole("region", { name: "The work behind it" });
  await expect.element(work.getByText("Index rebuilt in the timeline")).toBeVisible();
  await expect.element(work.getByText(/In progress/)).toBeVisible();
});
