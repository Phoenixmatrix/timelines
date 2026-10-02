import { describe, expect, test } from "vite-plus/test";
import { attributionText, claimAttribution, claimHolder, type IssueClaim } from "./tracker.ts";

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
