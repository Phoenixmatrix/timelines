// Usage & costs: Space, person and Instance reports stay separate scopes, and
// a report's costs by person, agent and timeline (CORE-222), in a real browser:
// who spent what, each agent with the person it works for, timelines as a
// second view, and what can't be attributed with the reason why; empty lists
// say so, and the section fits a phone.

import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { AttributedSpend, UsageAttribution, UsageReport } from "../../shared/usage.ts";
import { renderApp } from "../testing/render.tsx";
import { TestServer } from "../testing/server.ts";

test("personal usage stays separate from the person's granted Spaces", async () => {
  const server = await TestServer.start({ world: true, persona: "marco" });
  const app = renderApp("/settings/usage?person=marco");
  await expect
    .element(page.getByRole("heading", { name: "Usage & costs", level: 1 }))
    .toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Personal usage & costs", exact: true }).first())
    .toHaveAttribute("aria-current", "page");
  const report = await server.call<UsageReport>("GET", "/api/accounts/marco/usage");
  expect(report.scope).toBe("person");
  expect(report.subject?.slug).toBe("marco");
  expect(report.subjects).toBeNull();
  expect(report.knowledgeUpdates).toBeNull();
  await userEvent.click(page.getByRole("combobox", { name: "Scope for usage and costs" }));
  await userEvent.click(
    page.getByRole("option", { name: "Orbit Labs / General (@orbit)", exact: true }),
  );
  await app.waitForUrl(
    (url) => url.searchParams.get("space") === "orbit" && !url.searchParams.has("person"),
  );
  await expect
    .element(page.getByRole("link", { name: "Space usage & costs", exact: true }).first())
    .toHaveAttribute("aria-current", "page");
  const spaceReport = await server.call<UsageReport>("GET", "/api/spaces/orbit/usage");
  expect(spaceReport.scope).toBe("space");
  expect(spaceReport.subject?.slug).toBe("orbit");
  expect(spaceReport.subjects).toBeNull();
});

test("Instance operator authority alone does not grant a Space usage report", async () => {
  const server = await TestServer.start({ world: true, persona: "priya" });
  const report = await server.call<UsageReport>("GET", "/api/admin/usage");
  expect(report.scope).toBe("instance");
  expect(report.subject).toBeNull();
  renderApp("/settings/usage?space=orbit");
  await expect.element(page.getByRole("alert")).toBeVisible();
  await expect(server.call("GET", "/api/spaces/orbit/usage")).rejects.toThrow(
    /GET \/api\/spaces\/orbit\/usage: 404/,
  );
});

test("a Space member cannot administer Space usage", async () => {
  const server = await TestServer.start({ world: true, persona: "jun" });
  renderApp("/settings/usage?space=orbit");
  await expect.element(page.getByRole("alert")).toBeVisible();
  await expect(server.call("GET", "/api/spaces/orbit/usage")).rejects.toThrow(
    /GET \/api\/spaces\/orbit\/usage: 403/,
  );
});

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
        "Repositories, databases, search indexes and files belong to the Space, whoever wrote them.",
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
    scope: "space",
    subject: { id: "spc_orbit", slug: "orbit", displayName: "Orbit Labs / General" },
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
    subjects: null,
    notes: [],
    attribution,
  };
}

const section = () => page.getByRole("region", { name: "By person, agent and timeline" });
const group = (name: string) => section().getByRole("group", { name, exact: true });

test("costs by person, agent and timeline, and what isn't attributed and why", async () => {
  const server = await TestServer.start({ world: true, persona: "marco" });
  server.on("GET", "/api/spaces/:slug/usage", report(ATTRIBUTION));
  renderApp("/settings/usage?space=orbit");

  await expect.element(section()).toBeVisible();
  await expect
    .element(
      section().getByText(
        "People and agents account for $1.50 of the $2.00 spent on CI and AI in this window (75%). The rest, and storage, belong to the Space as a whole: see Not attributed.",
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
    "Repositories, databases, search indexes and files belong to the Space, whoever wrote them.",
  );
  await text(unattributed, "$5.00 a month");
  await text(unattributed, "Knowledge and wiki builds");
  await text(unattributed, "$0.50");
});

test("empty lists say so, and the section fits a phone", async () => {
  const server = await TestServer.start({ world: true, persona: "marco" });
  server.on("GET", "/api/spaces/:slug/usage", {
    ...report({ ...ATTRIBUTION, agents: [], timelines: [], attributedUsd: 1, activityUsd: 1.5 }),
    window: { from: "2026-09-20", to: "2026-10-19", daysMeasured: 10 },
  });
  await page.viewport(390, 844);
  renderApp("/settings/usage?space=orbit");
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
