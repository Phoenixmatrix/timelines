import { describe, expect, it } from "vite-plus/test";
import type { Issue, MutationResult, Snapshot, TrackerEvent } from "../../../shared/tracker.ts";
import { acknowledge, assertTrackerSnapshot } from "./snapshot.ts";

const now = "2026-10-03T12:00:00Z";
const issue = (id: string, fields: Partial<Issue> = {}): Issue => ({
  id,
  key: `CORE-${id}`,
  title: id,
  description: "Original description",
  acceptance: "",
  version: 1,
  createdAt: now,
  updatedAt: now,
  teamId: "core",
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
const snapshot = (issues: Issue[]): Snapshot => ({
  contractVersion: 4,
  spaceId: "space",
  migrationEpoch: 1,
  space: {
    id: "space",
    slug: "space",
    displayName: "Space",
    organizationId: "organization",
    organization: {
      id: "organization",
      slug: "organization",
      displayName: "Organization",
      avatarUrl: null,
      kind: "company",
      personalAccountId: null,
      defaultSpaceId: "space",
      createdAt: now,
    },
    archivedAt: null,
    authorizationVersion: 1,
    createdAt: now,
  },
  canAdmin: true,
  members: [],
  agents: [],
  teams: [],
  projects: [],
  labels: [],
  issues,
  links: [],
  comments: [],
  requests: [],
  subscriptions: [],
  cursor: 10,
  serverTime: now,
});
const event = (
  cursor: number,
  entityId: string,
  entity: TrackerEvent["entity"],
  fields: Partial<TrackerEvent> = {},
): TrackerEvent => ({
  cursor,
  operationId: "save",
  actorId: "person",
  kind: "issue.update",
  entityType: "issue",
  entityId,
  entity,
  createdAt: now,
  ...fields,
});
const result = (events: TrackerEvent[]): MutationResult => ({
  contractVersion: 4,
  spaceId: "space",
  migrationEpoch: 1,
  cursor: events.at(-1)!.cursor,
  events,
  results: [],
  serverTime: "2026-10-03T12:00:01Z",
});

describe("committed mutation acknowledgements", () => {
  it("applies native epoch-zero writes without accepting a different installation epoch", () => {
    const before = { ...snapshot([issue("1")]), migrationEpoch: 0 };
    const receipt = {
      ...result([event(11, "1", issue("1", { version: 2, title: "Native write" }))]),
      migrationEpoch: 0,
    };
    const after = acknowledge(before, receipt);
    expect(after.migrationEpoch).toBe(0);
    expect(after.cursor).toBe(11);
    expect(after.issues[0]).toMatchObject({ id: "1", version: 2, title: "Native write" });
    expect(() => acknowledge(before, { ...receipt, migrationEpoch: 1 })).toThrow();
    expect(() => acknowledge({ ...before, migrationEpoch: 1 }, receipt)).toThrow();
  });

  it("rejects incompatible, cross-Space and stale-epoch acknowledgements even at older cursors", () => {
    const before = snapshot([]);
    const receipt = result([event(1, "1", issue("1"))]);
    for (const patch of [
      { contractVersion: 3 },
      { spaceId: "another-space" },
      { migrationEpoch: 2 },
      { migrationEpoch: -1 },
      { migrationEpoch: undefined },
    ]) {
      expect(() => acknowledge(before, { ...receipt, ...patch } as MutationResult)).toThrow();
    }
    expect(before.issues).toEqual([]);
    expect(before.cursor).toBe(10);
  });

  it("requires the snapshot envelope to match its immutable Space identity", () => {
    const before = snapshot([]);
    expect(() => assertTrackerSnapshot({ ...before, spaceId: "another-space" })).toThrow(/Space/);
    expect(() =>
      assertTrackerSnapshot({ ...before, contractVersion: 3 } as unknown as Snapshot),
    ).toThrow(/client_upgrade_required/);
    expect(() => assertTrackerSnapshot({ ...before, migrationEpoch: 2 }, before)).toThrow(
      /migration_epoch_mismatch/,
    );
  });

  it("does not silently discard obsolete or unknown scope-bearing event kinds", () => {
    for (const entityType of ["workspace", "unknown-scope"]) {
      const receipt = result([event(11, "1", null)]);
      receipt.events[0] = { ...receipt.events[0]!, entityType } as TrackerEvent;
      expect(() => acknowledge(snapshot([]), receipt)).toThrow(/client_upgrade_required/);
    }
  });

  it("applies Project events without changing issue membership IDs", () => {
    const before = snapshot([issue("1", { projectIds: ["project-1", "project-2"] })]);
    const project = {
      id: "project-1",
      slug: "shipping",
      name: "Shipping",
      description: "",
      archived: false,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const next = acknowledge(
      before,
      result([event(11, project.id, project, { kind: "project.create", entityType: "project" })]),
    );
    expect(next.projects).toEqual([project]);
    expect(next.issues[0]!.projectIds).toEqual(["project-1", "project-2"]);
  });
  it("keeps definitions after removal and learns tags from timeline-only events on main", () => {
    const before = snapshot([]);
    before.labels = ["existing"];
    const next = acknowledge(
      before,
      result([
        event(11, "1", null, { view: { before: null, entity: issue("1", { labels: ["new"] }) } }),
        event(12, "1", null, { view: { before: null, entity: issue("1", { labels: [] }) } }),
      ]),
    );
    expect(next.labels).toEqual(["existing", "new"]);
    expect(next.issues).toEqual([]);
    expect(before.labels).toEqual(["existing"]);
  });
  it("applies a batch's final issue state without losing unrelated issues or mutating the prior view", () => {
    const before = snapshot([issue("1"), issue("2")]);
    const saved = issue("1", { version: 2, description: "Server-confirmed description" });
    const next = acknowledge(
      before,
      result([
        event(11, "1", saved),
        event(12, "3", issue("3"), { kind: "issue.create" }),
        event(13, "3", null, { kind: "issue.delete" }),
        event(14, "1", { ...saved, version: 3, status: "in_progress" }),
      ]),
    );
    expect(next.issues).toEqual([{ ...saved, version: 3, status: "in_progress" }, issue("2")]);
    expect(next.cursor).toBe(14);
    expect(before.issues[0]!.description).toBe("Original description");
    expect(before.cursor).toBe(10);
  });

  it("does not roll back a newer snapshot when an old receipt arrives late or is retried", () => {
    const fresh = snapshot([
      issue("1", { version: 4, description: "Another writer's newer edit" }),
    ]);
    fresh.cursor = 15;
    const receipt = result([event(11, "1", issue("1", { version: 2, description: "Older save" }))]);
    expect(acknowledge(fresh, receipt).issues[0]).toEqual(fresh.issues[0]);
    expect(acknowledge(fresh, receipt).cursor).toBe(15);
  });

  it("applies timeline-local entities, including an issue that does not exist on main", () => {
    const before = snapshot([]);
    before.timeline = { id: "timeline", slug: "work", name: "Work", status: "active" };
    const created = issue("1", { status: "in_progress" });
    const receipt = result([
      event(11, "1", null, {
        kind: "issue.create",
        timelineId: "timeline",
        view: { before: null, entity: created },
      }),
    ]);
    expect(acknowledge(before, receipt).issues).toEqual([created]);
    expect(acknowledge(snapshot([]), receipt).issues).toEqual([]);
  });

  it("removes a timeline-local entity without resurrecting its surviving main version", () => {
    const main = issue("1");
    const before = snapshot([main]);
    before.timeline = { id: "timeline", slug: "work", name: "Work", status: "active" };
    const receipt = result([
      event(11, "1", main, {
        kind: "issue.delete",
        timelineId: "timeline",
        view: { before: main, entity: null },
      }),
    ]);
    expect(acknowledge(before, receipt).issues).toEqual([]);
    expect(acknowledge(snapshot([main]), receipt).issues).toEqual([main]);
  });
});

describe("approve-when-green (CORE-378)", () => {
  it("follows the setting's own events, without a refresh", () => {
    const setting = (cursor: number, id: string, on: boolean) =>
      event(
        cursor,
        id,
        { id, approveWhenGreen: on, enabledAt: on ? now : null },
        { entityType: "automation", kind: "automation.approveWhenGreen" },
      );
    const before = { ...snapshot([]), approveWhenGreen: ["ann"] };
    const on = acknowledge(before, result([setting(11, "ben", true)]));
    expect(on.approveWhenGreen).toEqual(["ann", "ben"]);
    expect(acknowledge(on, result([setting(12, "ann", false)])).approveWhenGreen).toEqual(["ben"]);
    // Already seen: nothing changes.
    expect(acknowledge(on, result([setting(9, "ben", false)]))).toBe(on);
  });
});
