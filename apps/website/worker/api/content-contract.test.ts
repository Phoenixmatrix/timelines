import { describe, expect, test } from "vite-plus/test";
import { isContentApiPath } from "./content-contract.ts";

describe("JSON content negotiation boundary", () => {
  test("includes content reads, mutations and registry JSON extras", () => {
    for (const path of [
      "/api/spaces",
      "/api/spaces/alpha/settings/ai",
      "/api/organizations/company/members",
      "/api/repos/alpha/private",
      "/api/tracker/alpha",
      "/api/packages/alpha",
      "/api/registry/feeds",
      "/api/search",
      "/api/refs",
      "/api/ci/runner",
      "/api/release-notes",
    ])
      expect(isContentApiPath(path)).toBe(true);
  });
  test("person, authentication and native protocols never require the JSON version", () => {
    for (const path of [
      "/api/session",
      "/api/accounts/person",
      "/api/account/skills",
      "/api/tokens",
      "/api/identity/sign-in",
      "/api/auth/ssh",
      "/api/admin/space-cutover",
      "/alpha/repo.git/info/refs",
      "/v2/alpha/image/manifests/latest",
      "/npm/alpha/pkg",
      "/pypi/alpha/simple",
      "/api/spaceship",
    ])
      expect(isContentApiPath(path)).toBe(false);
  });
});
