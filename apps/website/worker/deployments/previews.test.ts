import { expect, test } from "vite-plus/test";
import { d1, migratedDatabase } from "../testing/d1.ts";
import type { Checkpoint } from "../../shared/timelines.ts";
import { checkpointRecords } from "./previews.ts";

test("preview revival selects its source record, not a newer identical canonical commit", async () => {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts(id,kind,slug,display_name) VALUES('owner','user','owner','Owner');
    INSERT INTO repos(id,owner_id,name,visibility,artifacts_name,artifacts_remote) VALUES('repo','owner','app','private','a','https://a');
    INSERT INTO timeline_work_sources(source_id,repo_id,timeline_id,timeline_slug,owner_id,artifacts_name,artifacts_remote,state,allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at)
    VALUES('work_a','repo','timeline','search','owner','work-a','https://work-a','archived','allocate','canonical','commit','tree','refs/heads/main','canonical','commit','tree','refs/heads/main','2026-01-01','2026-01-01');
    INSERT INTO deployments(repo_id,source_id,environment,timeline_slug,checkpoint_id,commit_oid,status) VALUES('repo','work_a','timeline/search','search','checkpoint','commit','active');
    INSERT INTO deployments(repo_id,source_id,environment,timeline_slug,checkpoint_id,commit_oid,status) VALUES('repo','canonical','timeline/search','search','checkpoint','commit','active');
  `);
  const checkpoint: Checkpoint = {
    id: "checkpoint",
    timelineId: "timeline",
    number: 1,
    summary: "",
    actorId: "owner",
    accountableId: "owner",
    createdAt: "2026-01-01",
    repos: [
      {
        id: "repo",
        owner: "owner",
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
  expect(await checkpointRecords(d1(sqlite), checkpoint)).toEqual(new Map([["repo", 1]]));
  expect(sqlite.prepare("SELECT source_id,consumer_kind FROM timeline_source_roots").all()).toEqual(
    [{ source_id: "work_a", consumer_kind: "deployment" }],
  );
  sqlite.exec("DELETE FROM deployments WHERE id=1");
  expect(sqlite.prepare("SELECT source_id FROM timeline_source_roots").all()).toEqual([]);
  sqlite.close();
});
