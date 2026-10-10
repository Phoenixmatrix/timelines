// The rail's Needs you place (CORE-301) in a real browser, against an in-memory
// server: it counts every request the Needs you page shows you (routed to you,
// or open to anyone in your trackers) as an amber count, says how many are
// yours to screen readers, follows new requests as you move around, drops what
// is answered, and goes back to the plain icon when the page is empty.

import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { renderApp } from "../testing/render.tsx";
import { TestServer } from "../testing/server.ts";
import { mutate } from "../testing/timelines.ts";

const ask = (id: string, prompt: string, routeTo?: string) => ({
  kind: "request.open",
  id,
  data: { issueId: "nyi", kind: "question", prompt, ...(routeTo ? { routeTo } : {}) },
});

test("Needs you: the rail counts every request on the page, follows new ones and drops answered ones", async () => {
  const server = await TestServer.start({ world: true });
  await mutate(server, [
    { kind: "team.create", id: "nyt", data: { key: "NYT", name: "Needs you" } },
    { kind: "issue.create", id: "nyi", data: { teamId: "nyt", title: "Pick a region" } },
    ask("q1", "Which region should the cache use?"),
    // Routed to Jun, but anyone in the tracker can answer it: it's on your page too.
    ask("q3", "Is the old index safe to drop?", "acc_jun"),
  ]);
  const app = renderApp("/");
  const rail = page.getByRole("navigation", { name: "Places" });
  const count = rail.getByTestId("needs-you-count");
  const place = (name: string) => rail.getByRole("link", { name, exact: true });

  // Both requests count; the name says how many are yours.
  await expect.element(place("Needs you: 2 requests waiting, 1 for you")).toBeVisible();
  await expect.element(count).toHaveTextContent("2");
  await expect.element(count).toHaveClass(/mk-badge/);

  // A new request shows up as you move around.
  await mutate(server, [ask("q2", "Should retries back off?")]);
  await userEvent.click(rail.getByRole("link", { name: /^Needs you/ }));
  await app.waitForUrl((url) => url.pathname === "/needs-you");
  await expect.element(place("Needs you: 3 requests waiting, 2 for you")).toBeVisible();
  await expect.element(count).toHaveTextContent("3");

  // Answering lowers the count right away; with only Jun's left it still shows,
  // and answering that one too clears it.
  for (const [prompt, answer, left] of [
    ["Which region should the cache use?", "us-east", "Needs you: 2 requests waiting, 1 for you"],
    ["Should retries back off?", "Yes, exponentially", "Needs you: 1 request waiting"],
    ["Is the old index safe to drop?", "Yes, nothing reads it", "Needs you"],
  ] as const) {
    const card = page.getByRole("article").filter({ hasText: prompt });
    await userEvent.fill(card.getByRole("textbox", { name: "Answer" }), answer);
    await userEvent.click(card.getByRole("button", { name: "Answer" }));
    await expect.element(place(left)).toBeVisible();
  }
  await expect.element(count).not.toBeInTheDocument();
});
