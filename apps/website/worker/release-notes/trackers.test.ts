import { describe, expect, test, vi } from "vite-plus/test";
import { issuesFrom, repoIssues } from "./trackers.ts";
import {
  releaseActor,
  releaseEnvironment,
  seedReleasePerson,
  seedReleaseSpace,
} from "./test-support.ts";

async function fixture() {
  const { sqlite, env } = await releaseEnvironment();
  seedReleasePerson(sqlite, "person");
  await seedReleaseSpace(sqlite, "space", "person");
  sqlite.exec(`
    INSERT INTO spaces(id,organization_id,slug,display_name)
      VALUES ('private-space','organization-space','private-space','Private');
    INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote)
      VALUES ('repo','space','repo','private','physical','https://source'),
             ('private-repo','private-space','repo','private','other-physical','https://other');
  `);
  const getByName = vi.fn();
  env.TRACKER = { getByName } as unknown as Env["TRACKER"];
  return { sqlite, env, getByName, actor: releaseActor("person") };
}

describe("release tracker source ownership", () => {
  test("Organization ownership never grants access to another Space's tracker", async () => {
    const t = await fixture();
    expect(
      await issuesFrom(
        t.env,
        [{ id: "private-space", slug: "private-space" }],
        "private-repo",
        ["CORE-1"],
        t.actor,
      ),
    ).toEqual([]);
    expect(t.getByName).not.toHaveBeenCalled();
  });

  test("a claimed source Space must match the repository's persisted immutable Space", async () => {
    const t = await fixture();
    expect(
      await repoIssues(t.env, { id: "private-repo", space_id: "space" }, ["CORE-1"], t.actor),
    ).toEqual([]);
    expect(t.getByName).not.toHaveBeenCalled();
  });

  test("repository-only collaboration never grants release issue access", async () => {
    const t = await fixture();
    t.sqlite.exec(`
      DELETE FROM space_grants WHERE space_id='space';
      INSERT INTO repo_collaborators(repo_id,user_id,role) VALUES ('repo','person','write');
    `);
    expect(
      await issuesFrom(t.env, [{ id: "space", slug: "space" }], "repo", ["CORE-1"], t.actor),
    ).toEqual([]);
    expect(t.getByName).not.toHaveBeenCalled();
  });
});
