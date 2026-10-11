// Usage & costs by person, agent and timeline (CORE-222), in a real browser:
// who spent what, each agent with the person it works for, timelines as a
// second view, and what can't be attributed with the reason why; empty lists
// say so, and the section fits a phone.

import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { AttributedSpend, UsageAttribution, UsageReport } from "../../shared/usage.ts";
import { renderApp } from "../testing/render.tsx";
import { TestServer } from "../testing/server.ts";

const spend = (over: Partial<AttributedSpend> & Pick<AttributedSpend, "id" | "name">) => ({
  accountable: null,
  ciUsd: 0,
  aiUsd: 0,
  totalUsd: 0,
  ciJobs: 0,
  ciMinutes: 0,
  aiCalls: 0,
  ...over,
});

const ATTRIBUTION: UsageAttribution = {
  from: "2026-09-20",
  to: "2026-10-19",
  people: [
    spend({
      id: "acc_ann",
      name: "Ann",
      ciUsd: 0.6,
      aiUsd: 0.4,
      totalUsd: 1,
      ciJobs: 2,
      ciMinutes: 12,
      aiCalls: 4,
    }),
  ],
  agents: [
    spend({
      id: "agt_bot",
      name: "ann-bot",
      accountable: { id: "acc_ann", name: "Ann" },
      ciUsd: 0.45,
      aiUsd: 0.05,
      totalUsd: 0.5,
      ciJobs: 1,
      ciMinutes: 20,
      aiCalls: 6,
    }),
  ],
  timelines: [
    spend({
      id: "search-v2",
      name: "search-v2",
      ciUsd: 0.45,
      aiUsd: 0.05,
      totalUsd: 0.5,
      ciJobs: 1,
      ciMinutes: 20,
      aiCalls: 6,
    }),
  ],
  activityUsd: 2,
  attributedUsd: 1.5,
  unattributed: [
    {
      id: "storage",
      label: "Storage",
      costUsd: 5,
      reason:
        "Repositories, databases, search indexes and files belong to the account, whoever wrote them.",
    },
    {
      id: "ai-builds",
      label: "Knowledge and wiki builds",
      costUsd: 0.5,
      reason:
        "A build covers several pushes at once, often from different people, so it is nobody's in particular.",
    },
  ],
};

function report(attribution: UsageAttribution): UsageReport {
  return {
    scope: "account",
    account: { slug: "orbit", displayName: "Orbit" },
    asOf: "2026-10-20",
    window: { from: "2026-09-20", to: "2026-10-19", daysMeasured: 30 },
    collectedAt: "2026-10-20T05:00:00.000Z",
    monthlyUsd: 7,
    constructs: [],
    // A collected report always has its 30 days.
    trend: Array.from({ length: 30 }, (_, i) => ({
      day: new Date(Date.UTC(2026, 8, 21 + i)).toISOString().slice(0, 10),
      costUsd: 0.2,
      byConstruct: {},
      measured: true,
    })),
    catalog: { version: 1, sources: [] },
    accounts: null,
    notes: [],
    attribution,
  };
}

const section = () => page.getByRole("region", { name: "By person, agent and timeline" });
const group = (name: string) => section().getByRole("group", { name, exact: true });

test("costs by person, agent and timeline, and what isn't attributed and why", async () => {
  const server = await TestServer.start({ world: true });
  server.on("GET", "/api/accounts/:slug/usage", report(ATTRIBUTION));
  renderApp("/settings/usage?owner=orbit");

  await expect.element(section()).toBeVisible();
  await expect
    .element(
      section().getByText(
        "People and agents account for $1.50 of the $2.00 spent on CI and AI in this window (75%). The rest, and storage, belong to the account as a whole: see Not attributed.",
      ),
    )
    .toBeVisible();

  const text = (scope: ReturnType<typeof group>, value: string) =>
    expect.element(scope.getByText(value, { exact: true })).toBeVisible();
  const people = group("People");
  await text(people, "Ann");
  await text(people, "2 CI jobs (12 min) · 4 AI calls");
  await text(people, "$1.00");
  await text(people, "CI $0.60 · AI $0.40");

  // An agent shows the person it works for; its costs are its own.
  const agents = group("Agents");
  await text(agents, "ann-bot");
  await text(agents, "for Ann");
  await text(agents, "What an agent does counts here, not under the person it works for.");
  await text(group("Timelines"), "search-v2");
  await text(
    group("Timelines"),
    "CI that ran for each timeline: its pushes, previews and landing. The same costs also count under whoever started each run. AI isn't tied to timelines yet.",
  );
  expect(document.querySelector("[data-usage-attribution-recorded]")).toBeNull();

  const unattributed = group("Not attributed");
  await expect.element(unattributed.getByRole("listitem")).toHaveLength(2);
  await text(unattributed, "Storage");
  await text(
    unattributed,
    "Repositories, databases, search indexes and files belong to the account, whoever wrote them.",
  );
  await text(unattributed, "$5.00 a month");
  await text(unattributed, "Knowledge and wiki builds");
  await text(unattributed, "$0.50");
});

test("empty lists say so, and the section fits a phone", async () => {
  const server = await TestServer.start({ world: true });
  server.on("GET", "/api/accounts/:slug/usage", {
    ...report({ ...ATTRIBUTION, agents: [], timelines: [], attributedUsd: 1, activityUsd: 1.5 }),
    window: { from: "2026-09-20", to: "2026-10-19", daysMeasured: 10 },
  });
  await page.viewport(390, 844);
  renderApp("/settings/usage?owner=orbit");
  await expect
    .element(group("Agents").getByText("No CI or AI was started by an agent in this window."))
    .toBeVisible();
  await expect
    .element(group("Timelines").getByText("No CI ran for a timeline in this window."))
    .toBeVisible();
  // The report above is extrapolated from 10 days; attribution is what was recorded.
  await expect
    .element(
      section().getByText(
        "The rest of this page extrapolates 10 measured days to 30; these are the costs actually recorded, so they can be lower.",
      ),
    )
    .toBeVisible();
  const root = document.documentElement;
  expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
});
