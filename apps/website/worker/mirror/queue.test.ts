import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { issueToken } from "../api/tokens.ts";
import { captureWorkAuthority } from "../ci/admission.ts";
import type { Actor } from "../db.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { queueMirror, type MirrorJob } from "./queue.ts";
import { syncMirror } from "./sync.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    public ctx: unknown;
    public env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const closers: (() => void)[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const close of closers.splice(0)) close();
});

async function setup() {
  const fixture = await createFreshSpaceTestEnvironment();
  closers.push(fixture.close);
  const { env, sqlite } = fixture;
  sqlite.exec("INSERT INTO accounts(id,kind,slug,display_name) VALUES('ann','user','ann','Ann')");
  await seedSpaceFixture(env.DB, {
    organization: { id: "company", slug: "company", displayName: "Company", kind: "company" },
    space: { id: "space", slug: "team", displayName: "Team" },
    members: [
      {
        accountId: "ann",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
    actorId: "ann",
  });
  sqlite.exec(`
    INSERT INTO agents(id,name,accountable_id) VALUES('agent','builder','ann');
    INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote)
      VALUES('repo','space','app','private','opaque-original','https://artifacts');
    INSERT INTO repo_mirrors(repo_id,url,username,enabled) VALUES('repo','https://mirror/app.git','git',1);
  `);
  const token = await issueToken(env.DB, "ann", "mirror", "write", undefined, "agent");
  const actor: Actor = {
    id: "ann",
    slug: "ann",
    displayName: "Ann",
    isSiteAdmin: false,
    agent: { id: "agent", name: "builder" },
    credential: { kind: "token", id: token.id },
  };
  const send = vi.fn<(job: MirrorJob) => Promise<void>>().mockResolvedValue(undefined);
  Object.assign(env, { JOBS: { send } });
  return { ...fixture, actor, send };
}

describe("mirror work authority", () => {
  test("enqueues the initiating person, agent, credential, immutable Space and epoch", async () => {
    const { env, actor, send } = await setup();
    await queueMirror(env, "repo", actor);
    expect(send).toHaveBeenCalledWith({
      type: "mirror",
      repoId: "repo",
      authority: {
        spaceId: "space",
        migrationEpoch: 0,
        personId: "ann",
        agentId: "agent",
        credential: actor.credential,
      },
    });
  });

  test("revocation after enqueue prevents any upstream access", async () => {
    const { env, actor, send } = await setup();
    await queueMirror(env, "repo", actor);
    const job = send.mock.calls[0]![0];
    await env.DB.prepare("UPDATE agents SET revoked_at = datetime('now') WHERE id = 'agent'").run();
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    await expect(syncMirror(env, job.repoId, job.authority)).rejects.toThrow();
    expect(upstream).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT status FROM repo_mirrors WHERE repo_id = 'repo'").first(
        "status",
      ),
    ).toBe("pending");
  });

  test("an Organization owner without a Space grant cannot consume queued work", async () => {
    const { env, actor } = await setup();
    const authority = await captureWorkAuthority(env, "repo", actor);
    await env.DB.prepare("DELETE FROM space_grants WHERE space_id = 'space'").run();
    await expect(syncMirror(env, "repo", authority)).rejects.toThrow();
  });

  test("credentials, epochs and Space identities cannot be substituted", async () => {
    const { env, actor, send } = await setup();
    const authority = await captureWorkAuthority(env, "repo", actor);
    await expect(
      syncMirror(env, "repo", { ...authority, migrationEpoch: authority.migrationEpoch + 1 }),
    ).rejects.toThrow();
    await expect(syncMirror(env, "repo", { ...authority, spaceId: "other" })).rejects.toThrow();
    await env.DB.prepare("DELETE FROM access_tokens WHERE id = ?")
      .bind(authority.credential.id)
      .run();
    await expect(syncMirror(env, "repo", authority)).rejects.toThrow();
    await expect(queueMirror(env, "repo", null)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
