import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, test } from "vite-plus/test";
import type { Issue, Snapshot } from "../../../shared/tracker.ts";
import { StateDot, StateLabel, StateLegend } from "./Log.tsx";
import { IssueBoard } from "./Panels.tsx";
import { buildIndex } from "./query.ts";
import { IssueState } from "./ui.tsx";

const issue = (key: string, fields: Partial<Issue> = {}): Issue => ({
  id: key.toLowerCase(),
  key,
  version: 1,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  teamId: "t",
  title: `Issue ${key}`,
  description: "",
  acceptance: "",
  type: "task",
  status: "todo",
  priority: 2,
  assigneeId: null,
  parentId: null,
  projectIds: [],
  labels: [],
  claim: null,
  ...fields,
});
// CORE-1 is a container: CORE-2 done, CORE-3 and CORE-4 open, CORE-5 canceled.
// CORE-6 is blocked by CORE-4, and CORE-7 is ready.
const issues = [
  issue("CORE-1"),
  issue("CORE-2", { parentId: "core-1", status: "done" }),
  issue("CORE-3", { parentId: "core-1" }),
  issue("CORE-4", { parentId: "core-1", status: "in_progress" }),
  issue("CORE-5", { parentId: "core-1", status: "canceled" }),
  issue("CORE-6"),
  issue("CORE-7"),
];
const snapshot = {
  space: { id: "o", slug: "priya", displayName: "Priya" },
  members: [],
  agents: [],
  teams: [],
  projects: [],
  requests: [],
  links: [{ id: "l", fromId: "core-4", toId: "core-6", kind: "blocks" }],
  issues,
  serverTime: "2026-10-02T00:00:00Z",
} as unknown as Snapshot;
const index = buildIndex(snapshot, snapshot.serverTime);
const html = (node: ReactNode) => renderToStaticMarkup(createElement(MemoryRouter, null, node));
const lens = "/tracker/priya/issues/core-1?view=graph";

describe("a To do issue with open sub-issues (CORE-108)", () => {
  test("shows a container badge with its progress, not the plain To do label", () => {
    const badge = html(createElement(IssueState, { issue: issues[0]!, snapshot, index }));
    expect(badge).toContain('data-state="container"');
    expect(badge).toContain("Sub-issues · 1/3 done");
    expect(badge).not.toContain("To do");
    expect(badge).toContain('title="Open sub-issues: CORE-3, CORE-4"');
    // Without an index (a page of its own), readiness gives the same badge.
    expect(html(createElement(IssueState, { issue: issues[0]!, snapshot }))).toContain(
      "Sub-issues · 1/3 done",
    );
  });

  test("leads to its sub-issues, and a blocked badge to its blockers, where it can link", () => {
    const container = html(
      createElement(IssueState, { issue: issues[0]!, snapshot, index, lensHref: lens }),
    );
    expect(container).toMatch(/^<a [^>]*href="\/tracker\/priya\/issues\/core-1\?view=graph"/);
    const blocked = html(
      createElement(IssueState, {
        issue: issues[5]!,
        snapshot,
        index,
        lensHref: "/tracker/priya/issues/core-6?view=graph",
      }),
    );
    expect(blocked).toMatch(/^<a [^>]*href="\/tracker\/priya\/issues\/core-6\?view=graph"/);
    expect(blocked).toContain('title="Blocked by CORE-4"');
    // Inside a row that is already a link, it stays text.
    expect(html(createElement(IssueState, { issue: issues[0]!, snapshot, index }))).toMatch(
      /^<span /,
    );
  });

  test("has its own neutral square mark in lists and the legend", () => {
    const dot = html(createElement(StateDot, { state: "container" }));
    expect(dot).toContain("rounded-[2px]");
    expect(dot).toContain("border-ink-muted");
    expect(dot).not.toMatch(/bg-online|bg-signal|rounded-full/);
    expect(html(createElement(StateLegend))).toContain("Sub-issues");
    const label = html(createElement(StateLabel, { issue: issues[0]!, index }));
    expect(label).toContain("Sub-issues · 1/3 done");
    expect(label).toContain('title="Open sub-issues: CORE-3, CORE-4"');
  });

  test("is counted in the To do lane header beside ready and blocked", () => {
    const board = html(
      createElement(IssueBoard, {
        issues,
        index,
        selected: null,
        href: (id: string) => `/tracker/priya/issues/${id}`,
        query: "is:open",
        listHref: (q: string) => `/tracker/priya?q=${q}`,
        now: Date.parse(snapshot.serverTime),
      }),
    );
    // CORE-1 (container), CORE-3 (ready), CORE-6 (blocked), CORE-7 (ready).
    expect(board).toContain("2 ready · 1 blocked · 1 in sub-issues");
  });
});
