import { describe, expect, test } from "vite-plus/test";
import { atLeast, repoRole, type RepoAccessFacts } from "./permissions.ts";

const orgRepo: RepoAccessFacts = {
  visibility: "private",
  ownerId: "acc_orbit",
  ownerKind: "org",
  orgMemberRepoRole: "read",
  viewer: { id: "acc_jun", isSiteAdmin: false },
  orgRole: null,
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

  test("user owners administer their own repos", () => {
    const facts: RepoAccessFacts = {
      ...orgRepo,
      ownerKind: "user",
      ownerId: "acc_sam",
      orgMemberRepoRole: null,
      viewer: { id: "acc_sam", isSiteAdmin: false },
    };
    expect(repoRole(facts)).toBe("admin");
    expect(repoRole({ ...facts, viewer: { id: "acc_jun", isSiteAdmin: false } })).toBe("none");
  });

  test("org owners administer, members get the org's base role", () => {
    expect(repoRole({ ...orgRepo, orgRole: "owner" })).toBe("admin");
    expect(repoRole({ ...orgRepo, orgRole: "member" })).toBe("read");
    expect(repoRole({ ...orgRepo, orgRole: "member", orgMemberRepoRole: "none" })).toBe("none");
  });

  test("the strongest grant wins", () => {
    expect(repoRole({ ...orgRepo, orgRole: "member", collaboratorRole: "write" })).toBe("write");
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
