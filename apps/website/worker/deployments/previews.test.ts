import { expect, test } from "vite-plus/test";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { issueToken } from "../api/tokens.ts";
import { captureWorkAuthority } from "../ci/admission.ts";
import type { Checkpoint } from "../../shared/timelines.ts";
import { checkpointRecords } from "./previews.ts";

test("preview revival selects its source record, not a newer identical canonical commit", async () => {
  const { sqlite, env, close } = await createFreshSpaceTestEnvironment();
  sqlite.exec(
    "INSERT INTO accounts(id,kind,slug,display_name) VALUES('person','user','person','Person')",
  );
  await seedSpaceFixture(env.DB, {
    organization: { id: "org", slug: "company", displayName: "Company", kind: "company" },
    space: { id: "space", slug: "owner", displayName: "Owner" },
    actorId: "person",
    members: [
      {
        accountId: "person",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
  });
  sqlite.exec(
    "INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote) VALUES('repo','space','app','private','a','https://a')",
  );
  const token = await issueToken(env.DB, "person", "preview", "write");
  const authority = await captureWorkAuthority(env, "repo", {
    id: "person",
    credential: { kind: "token", id: token.id },
  });
  sqlite.exec(`
    INSERT INTO timeline_work_sources(source_id,repo_id,timeline_id,timeline_slug,space_id,artifacts_name,artifacts_remote,state,allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at)
    VALUES('work_a','repo','timeline','search','space','work-a','https://work-a','archived','allocate','canonical','commit','tree','refs/heads/main','canonical','commit','tree','refs/heads/main','2026-01-01','2026-01-01');
    INSERT INTO deployments(repo_id,source_id,environment,timeline_slug,checkpoint_id,commit_oid,status,authority) VALUES('repo','work_a','timeline/search','search','checkpoint','commit','active','${JSON.stringify(authority)}');
    INSERT INTO deployments(repo_id,source_id,environment,timeline_slug,checkpoint_id,commit_oid,status,authority) VALUES('repo','canonical','timeline/search','search','checkpoint','commit','active','${JSON.stringify(authority)}');
  `);
  const checkpoint: Checkpoint = {
    id: "checkpoint",
    timelineId: "timeline",
    number: 1,
    summary: "",
    actorId: "person",
    accountableId: "person",
    createdAt: "2026-01-01",
    repos: [
      {
        id: "repo",
        space: "owner",
        name: "app",
        commit: "commit",
        base: "base",
        changes: [],
        source: {
          repoId: "repo",
          sourceId: "work_a",
          kind: "timeline-work",
          timelineId: "timeline",
          ref: "refs/heads/work",
          commit: "commit",
          tree: "tree",
        },
      },
    ],
  };
  expect(await checkpointRecords(env.DB, checkpoint)).toEqual(new Map([["repo", 1]]));
  expect(sqlite.prepare("SELECT source_id,consumer_kind FROM timeline_source_roots").all()).toEqual(
    [{ source_id: "work_a", consumer_kind: "deployment" }],
  );
  sqlite.exec("DELETE FROM deployments WHERE id=1");
  expect(sqlite.prepare("SELECT source_id FROM timeline_source_roots").all()).toEqual([]);
  close();
});
