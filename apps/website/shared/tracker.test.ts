import { describe, expect, test } from "vite-plus/test";
import { parseQuery, TrackerQueryUpgradeError } from "./tracker-query.ts";
import {
  attribution,
  attributionText,
  claimAttribution,
  claimHolder,
  fallbackTeam,
  type IssueClaim,
  type Snapshot,
} from "./tracker.ts";

describe("Project query contract", () => {
  test("preserves the Project filter instead of widening legacy queries", () => {
    expect(parseQuery("project:release")).toEqual({
      filters: [{ key: "project", value: "release", negated: false }],
      words: [],
      unknown: [],
    });
    for (const query of ["workspace:release", "-ws:release", "WORKSPACE:release"])
      expect(() => parseQuery(query)).toThrow(TrackerQueryUpgradeError);
  });
});

const ann = { id: "ann", slug: "ann", displayName: "Ann Lee" };
const people = {
  members: [ann],
  agents: [
    {
      id: "agt",
      name: "builder",
      accountable: ann,
      capabilities: null,
      capabilitiesUpdatedAt: null,
      revokedAt: null,
    },
  ],
};
const claim = (actorId: string, agent: string): IssueClaim => ({
  actorId,
  accountableId: "ann",
  agent,
  expiresAt: "2026-10-02T00:00:00Z",
});

describe("who's accountable", () => {
  test("recorded agents keep their name and accountable person after rename or deletion", () => {
    const actor = { id: "agt", kind: "agent" as const, name: "original", accountable: ann };
    const expected = { name: "original", kind: "agent", person: ann };
    expect(attribution(people, "agt", actor)).toEqual(expected);
    expect(attribution({ members: [], agents: [] }, "agt", actor)).toEqual(expected);
  });

  test("a human author is not their agent and legacy unknowns are not inferred from accountability", () => {
    expect(attribution(people, "ann")).toEqual({ name: "Ann Lee", kind: "person", person: ann });
    expect(
      attribution(people, "ann", {
        id: "ann",
        kind: "person",
        name: "Ann before rename",
        accountable: null,
      }),
    ).toEqual({ name: "Ann before rename", kind: "person", person: ann });
    expect(
      attribution(people, "deleted", {
        id: "deleted",
        kind: "unknown",
        name: null,
        accountable: ann,
      }),
    ).toEqual({ name: "deleted", kind: "unknown", person: null });
    expect(attribution(people, "agt")).toEqual({ name: "builder", kind: "agent", person: ann });
    expect(attribution(people, "deleted")).toEqual({
      name: "deleted",
      kind: "unknown",
      person: null,
    });
  });

  test("an agent names its person; a person's session keeps them first", () => {
    expect(claimAttribution(people, claim("agt", "session-7"))).toEqual({
      name: "builder",
      kind: "agent",
      person: ann,
    });
    expect(claimHolder(people, claim("agt", "session-7"))).toBe("builder for Ann Lee");
    // A person claiming with a session label is still visibly that person.
    const laptop = claimAttribution(people, claim("ann", "ann-laptop"));
    expect(laptop).toEqual({ name: "ann-laptop", kind: "session", person: ann });
    expect(attributionText(laptop)).toBe("Ann Lee (ann-laptop)");
    // A label that is just their name or slug adds nothing.
    expect(claimHolder(people, claim("ann", "ann"))).toBe("Ann Lee");
  });
});

describe("the fallback team for quick capture", () => {
  const team = (id: string, memberIds: string[] = [], archived = false) =>
    ({ id, memberIds, archived }) as Snapshot["teams"][number];
  const filed = (teamId: string, by: string, createdAt: string) =>
    ({
      teamId,
      createdAt,
      createdBy: { id: by, kind: "user", name: by },
    }) as unknown as Snapshot["issues"][number];
  const agents = [{ id: "bot", accountable: { id: "ann" } }] as unknown as Snapshot["agents"];
  test("is your team when you're on exactly one", () => {
    expect(
      fallbackTeam({ teams: [team("a"), team("b", ["ann"])], issues: [], agents }, "ann"),
    ).toBe("b");
  });
  test("is the team you or your agents last filed into, among your teams", () => {
    const teams = [team("a", ["ann"]), team("b", ["ann"]), team("c")];
    const issues = [
      filed("a", "ann", "2026-01-01"),
      filed("c", "ann", "2026-03-01"),
      filed("b", "bot", "2026-02-01"),
      filed("a", "ben", "2026-04-01"),
    ];
    expect(fallbackTeam({ teams, issues, agents }, "ann")).toBe("b");
  });
  test("is the last team you filed into when you're on none, else the first open team", () => {
    const teams = [team("a", [], true), team("b"), team("c")];
    expect(fallbackTeam({ teams, issues: [filed("c", "ann", "2026-01-01")], agents }, "ann")).toBe(
      "c",
    );
    expect(fallbackTeam({ teams, issues: [], agents }, "ann")).toBe("b");
    expect(fallbackTeam({ teams: [team("a", [], true)], issues: [], agents }, "ann")).toBeNull();
  });
});
