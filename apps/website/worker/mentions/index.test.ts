// Commit mention provenance and explicit Space isolation over the real D1 schema.
import { describe, expect, test } from "vite-plus/test";
import type { ShippedIssue } from "../../shared/release-notes.ts";
import { captureWorkAuthority } from "../ci/admission.ts";
import {
  releaseActor,
  releaseEnvironment,
  seedReleasePerson,
  seedReleaseSpace,
} from "../release-notes/test-support.ts";
import { indexMentions, resolveRepoKeys, trackerLookup, type IssueLookup } from "./index.ts";
import { backfillMentions, resumeMentionBackfill } from "./backfill.ts";
import { Hono } from "hono";
import type { AppEnv } from "../auth.ts";
import { refLog } from "../ref-log/api.ts";

function issue(id: string, key: string): ShippedIssue {
  return {
    id,
    key,
    title: key,
    description: "",
    type: "task",
    status: "todo",
    labels: [],
    projectIds: [],
    team: { id: "team", key: "CORE", name: "Core" },
    completedAt: null,
    evidence: [],
  };
}
async function world() {
  const { sqlite, env } = await releaseEnvironment();
  seedReleasePerson(sqlite, "ann");
  await seedReleaseSpace(sqlite, "home", "ann");
  await seedReleaseSpace(sqlite, "other", "ann");
  sqlite.exec(`INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote,pushed_at) VALUES
    ('app','home','app','private','app','https://app','2026-09-01T00:00:00Z'),
    ('lib','other','lib','private','lib','https://lib','2026-09-02T00:00:00Z');
    INSERT INTO tracker_repo_subscriptions(tracker_space_id,repo_id) VALUES ('other','app');`);
  const trackers: Record<string, ShippedIssue[]> = {
    home: [issue("home-core", "CORE-1"), issue("home-app", "APP-2")],
    other: [issue("other-core", "CORE-1"), issue("secret", "SECRET-1")],
  };
  const calls: string[] = [];
  const lookup: IssueLookup = async (space, keys) => {
    calls.push(space);
    return (trackers[space] ?? []).filter((i) => keys.includes(i.key));
  };
  const mentions = () =>
    sqlite
      .prepare(
        "SELECT commit_oid,issue_key,tracker_space_id,issue_id,source_id,first_ref,change_id,pushed_at FROM commit_issue_mentions ORDER BY issue_key",
      )
      .all();
  return { sqlite, env, lookup, calls, mentions, actor: releaseActor("ann") };
}
const commit = {
  oid: "1".repeat(40),
  changeId: null,
  message: "CORE-1 APP-2 SECRET-1 UTF-8",
  committedAt: 1790000000,
  ref: "refs/heads/work",
};

describe("commit mentions", () => {
  test("subscriptions and grants to another Space never change resolution", async () => {
    const w = await world();
    expect(await indexMentions(w.env.DB, "app", [commit], w.lookup, "work-1")).toEqual({
      linked: 2,
      ambiguous: 0,
    });
    expect(w.calls).toEqual(["home"]);
    expect(w.mentions()).toMatchObject([
      { issue_key: "APP-2", tracker_space_id: "home", issue_id: "home-app", source_id: "work-1" },
      { issue_key: "CORE-1", tracker_space_id: "home", issue_id: "home-core", source_id: "work-1" },
    ]);
  });
  test("repeated commits retain their original ref, timestamp and source", async () => {
    const w = await world();
    await indexMentions(w.env.DB, "app", [commit], w.lookup, "work-1");
    const first = w.mentions();
    await indexMentions(
      w.env.DB,
      "app",
      [{ ...commit, changeId: "change", ref: "refs/heads/main" }, commit],
      w.lookup,
    );
    expect(w.mentions()).toEqual(first.map((row) => ({ ...row, change_id: "change" })));
  });
  test("legacy ambiguous rows can resolve without rewriting source provenance", async () => {
    const w = await world();
    w.sqlite
      .prepare(
        "INSERT INTO commit_issue_mentions(repo_id,commit_oid,issue_key,resolution,source_id,first_ref) VALUES ('app',?,'CORE-1','ambiguous','work-old','refs/heads/old')",
      )
      .run(commit.oid);
    await indexMentions(w.env.DB, "app", [commit], w.lookup);
    expect(w.mentions()).toContainEqual(
      expect.objectContaining({
        issue_key: "CORE-1",
        issue_id: "home-core",
        source_id: "work-old",
        first_ref: "refs/heads/old",
      }),
    );
  });
  test("deleted repos, mismatched physical Spaces and keyless commits do not look up issues", async () => {
    const w = await world();
    expect(
      await resolveRepoKeys(w.env.DB, { id: "app", space_id: "other" }, ["CORE-1"], w.lookup),
    ).toEqual(new Map());
    await indexMentions(w.env.DB, "app", [{ ...commit, message: "No issue keys" }], w.lookup);
    w.sqlite.exec("UPDATE repos SET deleted_at='2026-09-03' WHERE id='app'");
    await indexMentions(w.env.DB, "app", [commit], w.lookup);
    expect(w.calls).toEqual([]);
    expect(w.mentions()).toEqual([]);
  });
  test("production lookup rejects a different Space and revoked originating credentials", async () => {
    const w = await world();
    const authority = await captureWorkAuthority(w.env, "app", w.actor);
    const lookup = trackerLookup(w.env, "app", authority);
    expect(await lookup("other", ["SECRET-1"])).toEqual([]);
    w.sqlite.exec("DELETE FROM access_tokens WHERE id='token-ann'");
    await expect(lookup("home", ["CORE-1"])).rejects.toThrow(/credential.*revoked|expired/i);
  });
  test("repository-only writers cannot resolve Space issues", async () => {
    const w = await world();
    const authority = await captureWorkAuthority(w.env, "app", w.actor);
    w.sqlite.exec(
      "DELETE FROM space_grants WHERE space_id='home'; INSERT INTO repo_collaborators(repo_id,user_id,role) VALUES ('app','ann','write')",
    );
    await expect(trackerLookup(w.env, "app", authority)("home", ["CORE-1"])).rejects.toThrow(
      "mention_space_access_required",
    );
  });
});

describe("durable mention backfill", () => {
  test("legacy jobs do not dispatch, and scoped resume completes on the next sweep without a push", async () => {
    const w = await world();
    w.sqlite.exec(
      "INSERT INTO mention_backfill_jobs(repo_id,authority,state,error) VALUES ('app',NULL,'blocked','originating_authority_unavailable')",
    );
    const reads: string[] = [];
    const history = async (repo: { id: string }) => {
      reads.push(repo.id);
      return [commit];
    };
    expect(await backfillMentions(w.env, history, w.lookup)).toEqual({
      repos: 0,
      linked: 0,
      ambiguous: 0,
      failed: 0,
    });
    expect(reads).toEqual([]);
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", w.actor);
      await next();
    });
    app.route("/api/repos/:space/:name", refLog);
    expect(
      (await app.request("/api/repos/home/app/mention-backfill", { method: "POST" }, w.env)).status,
    ).toBe(202);
    expect(await backfillMentions(w.env, history, w.lookup)).toEqual({
      repos: 1,
      linked: 2,
      ambiguous: 0,
      failed: 0,
    });
    expect(reads).toEqual(["app"]);
    expect(w.sqlite.prepare("SELECT * FROM mention_backfill_jobs").all()).toEqual([]);
    expect(await backfillMentions(w.env, history, w.lookup)).toEqual({
      repos: 0,
      linked: 0,
      ambiguous: 0,
      failed: 0,
    });
    const status = await app.request("/api/repos/home/app/mention-backfill", {}, w.env);
    expect(await status.json()).toMatchObject({ state: "completed", commits: 1 });
  });
  test("revoked credentials block before history reads and never mark completion", async () => {
    const w = await world();
    await resumeMentionBackfill(w.env, "app", w.actor);
    w.sqlite.exec("DELETE FROM access_tokens WHERE id='token-ann'");
    let reads = 0;
    const result = await backfillMentions(
      w.env,
      async () => {
        reads++;
        return [commit];
      },
      w.lookup,
    );
    expect(result.failed).toBe(1);
    expect(reads).toBe(0);
    expect(w.sqlite.prepare("SELECT state,error FROM mention_backfill_jobs").get()).toMatchObject({
      state: "blocked",
      error: expect.stringMatching(/credential.*revoked|expired/i),
    });
    expect(w.sqlite.prepare("SELECT * FROM commit_mention_backfills").all()).toEqual([]);
  });
  test("a failed history read is retained and deliberate resume retries without another push", async () => {
    const w = await world();
    await resumeMentionBackfill(w.env, "app", w.actor);
    expect(
      (
        await backfillMentions(
          w.env,
          async () => {
            throw new Error("Artifacts is down");
          },
          w.lookup,
        )
      ).failed,
    ).toBe(1);
    expect(w.sqlite.prepare("SELECT state,error FROM mention_backfill_jobs").get()).toMatchObject({
      state: "blocked",
      error: "Artifacts is down",
    });
    await resumeMentionBackfill(w.env, "app", w.actor);
    expect((await backfillMentions(w.env, async () => [commit], w.lookup)).linked).toBe(2);
  });
  test("repository-only and cross-Space callers cannot resume or inspect jobs", async () => {
    const w = await world();
    w.sqlite.exec(
      "DELETE FROM space_grants WHERE space_id='home'; INSERT INTO repo_collaborators(repo_id,user_id,role) VALUES ('app','ann','write')",
    );
    await expect(resumeMentionBackfill(w.env, "app", w.actor)).rejects.toThrow(
      "mention_space_access_required",
    );
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", w.actor);
      await next();
    });
    app.route("/api/repos/:space/:name", refLog);
    expect(
      (await app.request("/api/repos/home/app/mention-backfill", { method: "POST" }, w.env)).status,
    ).toBe(403);
    expect((await app.request("/api/repos/home/app/mention-backfill", {}, w.env)).status).toBe(403);
    expect(
      (await app.request("/api/repos/other/app/mention-backfill", { method: "POST" }, w.env))
        .status,
    ).toBe(404);
    expect(w.sqlite.prepare("SELECT * FROM mention_backfill_jobs").all()).toEqual([]);
  });
  test("a pending binding for another physical Space is blocked before reading history", async () => {
    const w = await world();
    const authority = await captureWorkAuthority(w.env, "lib", w.actor);
    w.sqlite
      .prepare(
        "INSERT INTO mention_backfill_jobs(repo_id,authority,state,error) VALUES ('app',?,'pending',NULL)",
      )
      .run(JSON.stringify(authority));
    let reads = 0;
    expect(
      (
        await backfillMentions(
          w.env,
          async () => {
            reads++;
            return [commit];
          },
          w.lookup,
        )
      ).failed,
    ).toBe(1);
    expect(reads).toBe(0);
    expect(w.calls).toEqual([]);
    expect(w.sqlite.prepare("SELECT state FROM mention_backfill_jobs").get()).toMatchObject({
      state: "blocked",
    });
  });
  test("revocation during history reads cannot complete even a keyless backfill", async () => {
    const w = await world();
    await resumeMentionBackfill(w.env, "app", w.actor);
    const result = await backfillMentions(
      w.env,
      async () => {
        w.sqlite.exec(
          "DELETE FROM space_grants WHERE space_id='home'; INSERT INTO repo_collaborators(repo_id,user_id,role) VALUES ('app','ann','write')",
        );
        return [{ ...commit, message: "No keys" }];
      },
      w.lookup,
    );
    expect(result.failed).toBe(1);
    expect(w.sqlite.prepare("SELECT * FROM commit_mention_backfills").all()).toEqual([]);
    expect(w.sqlite.prepare("SELECT state FROM mention_backfill_jobs").get()).toMatchObject({
      state: "blocked",
    });
  });
});
