import { describe, expect, test } from "vite-plus/test";
import { atLeast, repoRole, type RepoAccessFacts } from "./permissions.ts";

const orgRepo: RepoAccessFacts = {
  visibility: "private",
  spaceRole: null,
  repositoryRole: "read",
  viewer: { id: "acc_jun", isSiteAdmin: false },
  collaboratorRole: null,
};

describe("repoRole", () => {
  test("signed-out visitors read public repos and nothing else", () => {
    expect(repoRole({ ...orgRepo, viewer: null, visibility: "public" })).toBe("read");
    expect(repoRole({ ...orgRepo, viewer: null })).toBe("none");
  });

  test("site admins administer everything", () => {
    expect(repoRole({ ...orgRepo, viewer: { id: "acc_priya", isSiteAdmin: true } })).toBe("admin");
  });

  test("a matching legacy Space/person id confers no private access", () => {
    expect(repoRole({ ...orgRepo, viewer: { id: "acc_orbit", isSiteAdmin: false } })).toBe("none");
  });

  test("Organization administration is not a content grant", () => {
    expect(repoRole(orgRepo)).toBe("none");
    expect(repoRole({ ...orgRepo, visibility: "public" })).toBe("read");
  });

  test("explicit Space admins administer, members use their repository baseline", () => {
    expect(repoRole({ ...orgRepo, spaceRole: "admin" })).toBe("admin");
    expect(repoRole({ ...orgRepo, spaceRole: "member" })).toBe("read");
    expect(repoRole({ ...orgRepo, spaceRole: "member", repositoryRole: "none" })).toBe("none");
    expect(repoRole({ ...orgRepo, spaceRole: "member", repositoryRole: "write" })).toBe("write");
  });

  test("revoking a Space grant removes its rights without removing independent collaboration", () => {
    expect(repoRole({ ...orgRepo, spaceRole: null, repositoryRole: "write" })).toBe("none");
    expect(repoRole({ ...orgRepo, spaceRole: null, collaboratorRole: "read" })).toBe("read");
  });

  test("the strongest grant wins", () => {
    expect(repoRole({ ...orgRepo, spaceRole: "member", collaboratorRole: "write" })).toBe("write");
    expect(repoRole({ ...orgRepo, visibility: "public", collaboratorRole: "read" })).toBe("read");
  });

  test("collaborators outside the org get exactly their role", () => {
    expect(repoRole({ ...orgRepo, collaboratorRole: "read" })).toBe("read");
  });
});

test("atLeast orders roles", () => {
  expect(atLeast("admin", "write")).toBe(true);
  expect(atLeast("read", "write")).toBe(false);
  expect(atLeast("none", "read")).toBe(false);
});
