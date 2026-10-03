import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, test } from "vite-plus/test";
import type { Issue, Snapshot } from "../../../shared/tracker.ts";
import { DoneInTimelineCallout, LockedStatusHint, lockedIn } from "./DoneInTimeline.tsx";
import { StateDot, StateLegend } from "./Log.tsx";
import { IssueState } from "./ui.tsx";

const doneIn = { id: "tl_1", slug: "search" };
const issue = (fields: Partial<Issue> = {}): Issue => ({
  id: "a",
  key: "CORE-1",
  version: 2,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  teamId: "t",
  title: "Index the docs",
  description: "",
  acceptance: "",
  type: "task",
  status: "done_in_timeline",
  priority: 2,
  assigneeId: null,
  parentId: null,
  workspaceIds: [],
  labels: [],
  claim: null,
  doneIn,
  ...fields,
});
const snapshot = {
  owner: { id: "o", slug: "priya", displayName: "Priya" },
  members: [],
  agents: [],
  requests: [],
  links: [],
  issues: [],
  serverTime: "2026-10-02T00:00:00Z",
} as unknown as Snapshot;
const html = (node: ReactNode) => renderToStaticMarkup(createElement(MemoryRouter, null, node));

describe("done in a timeline on an issue", () => {
  test("main shows where it was done, that the status is locked, and the way there", () => {
    const callout = html(createElement(DoneInTimelineCallout, { issue: issue(), snapshot }));
    expect(callout).toContain('href="/tracker/priya/timelines?tl=search"');
    expect(callout).toContain("Its status is locked here.");
    expect(callout).toContain('href="/tracker/priya/issues/CORE-1?tl=search"');
    expect(callout).toContain("Open in the timeline");
    expect(callout).toContain("<svg");
    // In the timeline itself it's done, with no way "there".
    const inside = html(
      createElement(DoneInTimelineCallout, {
        issue: issue({ status: "done" }),
        snapshot: { ...snapshot, timeline: { ...doneIn, name: "Search", status: "active" } },
      }),
    );
    expect(inside).toContain("hasn&#x27;t landed yet");
    expect(inside).not.toContain("Open in the timeline");
    expect(
      html(createElement(DoneInTimelineCallout, { issue: issue({ doneIn: null }), snapshot })),
    ).toBe("");
  });

  test("the locked status picker explains itself and links to the issue in its timeline", () => {
    expect(lockedIn(issue())).toEqual(doneIn);
    expect(lockedIn(issue({ status: "done" }))).toBeNull();
    const hint = html(createElement(LockedStatusHint, { issue: issue(), owner: "priya" }));
    expect(hint).toContain("Locked while it");
    expect(hint).toContain('href="/tracker/priya/issues/CORE-1?tl=search"');
    expect(
      html(createElement(LockedStatusHint, { issue: issue({ status: "todo" }), owner: "priya" })),
    ).toBe("");
  });

  test("its state has its own icon everywhere states are drawn", () => {
    expect(html(createElement(StateDot, { state: "done_in_timeline" }))).toMatch(/^<svg/);
    expect(html(createElement(StateDot, { state: "ready" }))).toMatch(/^<span/);
    const legend = html(createElement(StateLegend));
    expect(legend).toContain("Done in a timeline");
    expect(legend).toContain("<svg");
    const badge = html(createElement(IssueState, { issue: issue(), snapshot }));
    expect(badge).toContain("Done in search");
    expect(badge).toContain('data-state="done_in_timeline"');
    expect(badge).toContain("<svg");
  });
});
