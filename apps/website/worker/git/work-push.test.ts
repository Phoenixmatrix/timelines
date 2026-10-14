import { Hono } from "hono";
import { afterEach, expect, onTestFinished, test, vi } from "vite-plus/test";
import { issueToken } from "../api/tokens.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import type { TimelineChange } from "../../shared/timelines.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { findSpaceById } from "../spaces/access.ts";
import { accessFor } from "../tracker/access.ts";
import { fakeDurableObjectId, fakeDurableState } from "../testing/durable-state.ts";
import { fakeRemotes } from "../testing/remote.ts";
import { Tracker } from "../tracker/object.ts";
import { timelines } from "../timelines/api.ts";
import { gitHttp } from "./http.ts";
import { invalidateRefs, RepoReader } from "../objects.ts";
import { Timing } from "../timing.ts";
import { FLUSH, pkt } from "./pktline.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: DurableObjectState;
    env: Env;
    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
vi.mock("./effects.ts", () => ({ afterPush: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

const old = "1".repeat(40);
const next = "2".repeat(40);
const ref = "refs/heads/work";
const ok = pkt("unpack ok\n") + pkt(`ok ${ref}\n`) + FLUSH;
const ng = pkt("unpack ok\n") + pkt(`ng ${ref} hook declined\n`) + FLUSH;
const sideband = (report: string) =>
  pkt("\x02progress\n") + pkt(`\x01${report.slice(0, 7)}`) + pkt(`\x01${report.slice(7)}`) + FLUSH;

async function fixture() {
  const fresh = await createFreshSpaceTestEnvironment();
  const { sqlite } = fresh;
  onTestFinished(fresh.close);
  sqlite.exec("INSERT INTO accounts(id,kind,slug,display_name) VALUES ('ann','user','ann','Ann')");
  await seedSpaceFixture(fresh.env.DB, {
    organization: {
      id: "org-ann",
      slug: "ann",
      displayName: "Ann",
      kind: "personal",
      personalAccountId: "ann",
    },
    space: { id: "space-ann", slug: "ann", displayName: "Ann" },
    actorId: "ann",
    members: [
      {
        accountId: "ann",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
  });
  sqlite.exec(`
    INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote)
      VALUES ('app','space-ann','app','private','r-app','https://app');
  `);
  const remotes = fakeRemotes();
  remotes.add("https://app", { "refs/heads/main": old });
  vi.stubGlobal("fetch", remotes.fetch);
  const state = fakeDurableState({ name: "space-ann" });
  onTestFinished(() => state.db.close());
  const env = {
    ...fresh.env,
    ARTIFACTS: remotes.artifacts,
    TRACKER: { idFromName: fakeDurableObjectId, getByName: () => tracker },
  } as unknown as Env;
  const tracker = new Tracker(state.ctx, env);
  const app = new Hono<AppEnv>();
  app.use("*", async (c, run) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    await run();
  });
  app.route("/api/tracker/:space/timelines", timelines);
  app.route("/", gitHttp);
  const token = await issueToken(env.DB, "ann", "test", "write");
  const space = await findSpaceById(env.DB, "space-ann");
  if (!space) throw new Error("Missing fixture Space");
  const access = await accessFor(env, space, "ann", null, true, {
    kind: "token",
    id: token.id,
  });
  const headers = {
    authorization: `Bearer ${token.secret}`,
    "X-Gitmatrix-Content-Version": "4",
  };
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  const created = await app.request(
    "/api/tracker/ann/timelines",
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ slug: "work", repos: ["ann/app"] }),
    },
    env,
    ctx,
  );
  expect(created.status).toBe(201);
  const timeline = ((await created.json()) as TimelineChange).timeline;
  const sourceId = timeline.repos[0]!.source!.sourceId;
  const source = sqlite
    .prepare("SELECT artifacts_name FROM timeline_work_sources WHERE source_id=?")
    .get(sourceId) as { artifacts_name: string };
  const remote = remotes.getByName(source.artifacts_name);
  remote.commits.add(next);
  remote.parents.set(next, [old]);
  const push = async (
    report: string,
    status: number,
    observed: string,
    capabilities: string,
    authorization = headers.authorization,
  ) => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/git-receive-pack") && init?.body instanceof ReadableStream) {
        await new Response(init.body).arrayBuffer();
        remote.refs.set(ref, observed);
        return new Response(report, {
          status,
          headers: { "content-type": "application/x-git-receive-pack-result" },
        });
      }
      return remotes.fetch(input, init);
    });
    const response = await app.request(
      "/ann/app@work.git/git-receive-pack",
      {
        method: "POST",
        headers: {
          ...headers,
          authorization,
          "content-type": "application/x-git-receive-pack-request",
        },
        body: pkt(`${old} ${next} ${ref}\0${capabilities}\n`) + FLUSH,
      },
      env,
      ctx,
    );
    await Promise.all(pending.splice(0));
    return response;
  };
  return { sqlite, env, app, ctx, tracker, remote, sourceId, push, access };
}

test.each([
  {
    name: "plain accepted",
    report: ok,
    status: 200,
    observed: next,
    caps: "report-status",
    outcome: "accepted",
  },
  {
    name: "sideband v2 accepted",
    report: sideband(ok),
    status: 200,
    observed: next,
    caps: "report-status-v2 side-band-64k",
    outcome: "accepted",
  },
  {
    name: "v2 exact identity options",
    report:
      pkt("unpack ok\n") +
      pkt(`ok ${ref}\n`) +
      pkt(`option refname ${ref}\n`) +
      pkt(`option old-oid ${old}\n`) +
      pkt(`option new-oid ${next}\n`) +
      pkt("option forced-update\n") +
      FLUSH,
    status: 200,
    observed: next,
    caps: "report-status-v2",
    outcome: "accepted",
  },
  {
    name: "explicit rejection",
    report: ng,
    status: 200,
    observed: old,
    caps: "report-status",
    outcome: "rejected",
  },
  {
    name: "sideband rejection",
    report: sideband(ng),
    status: 200,
    observed: old,
    caps: "report-status-v2 side-band-64k",
    outcome: "rejected",
  },
  {
    name: "unpack rejection",
    report: pkt("unpack invalid pack\n") + pkt(`ng ${ref} unpacker error\n`) + FLUSH,
    status: 200,
    observed: old,
    caps: "report-status",
    outcome: "rejected",
  },
  {
    name: "HTTP500 with old tip",
    report: ng,
    status: 500,
    observed: old,
    caps: "report-status",
    outcome: "ambiguous",
  },
  {
    name: "HTTP500 with new tip",
    report: ok,
    status: 500,
    observed: next,
    caps: "report-status",
    outcome: "ambiguous",
  },
  {
    name: "missing report",
    report: "",
    status: 200,
    observed: old,
    caps: "report-status",
    outcome: "ambiguous",
  },
  {
    name: "missing flush",
    report: ng.slice(0, -4),
    status: 200,
    observed: old,
    caps: "report-status",
    outcome: "ambiguous",
  },
  {
    name: "missing ref result",
    report: pkt("unpack ok\n") + FLUSH,
    status: 200,
    observed: old,
    caps: "report-status",
    outcome: "ambiguous",
  },
  {
    name: "wrong ref",
    report: pkt("unpack ok\n") + pkt("ng refs/heads/other denied\n") + FLUSH,
    status: 200,
    observed: old,
    caps: "report-status",
    outcome: "ambiguous",
  },
  {
    name: "duplicate contradictory ref",
    report: ng.slice(0, -4) + pkt(`ok ${ref}\n`) + FLUSH,
    status: 200,
    observed: old,
    caps: "report-status",
    outcome: "ambiguous",
  },
  {
    name: "failed unpack with ok",
    report: pkt("unpack failed\n") + pkt(`ok ${ref}\n`) + FLUSH,
    status: 200,
    observed: next,
    caps: "report-status",
    outcome: "ambiguous",
  },
  {
    name: "rejection with new tip",
    report: ng,
    status: 200,
    observed: next,
    caps: "report-status",
    outcome: "ambiguous",
  },
  {
    name: "acceptance with old tip",
    report: ok,
    status: 200,
    observed: old,
    caps: "report-status",
    outcome: "ambiguous",
  },
  {
    name: "unnegotiated report",
    report: ng,
    status: 200,
    observed: old,
    caps: "ofs-delta",
    outcome: "ambiguous",
  },
  {
    name: "truncated outer sideband",
    report: sideband(ng).slice(0, -4),
    status: 200,
    observed: old,
    caps: "report-status side-band-64k",
    outcome: "ambiguous",
  },
  {
    name: "fatal sideband",
    report: pkt("\x03fatal\n") + sideband(ng),
    status: 200,
    observed: old,
    caps: "report-status side-band-64k",
    outcome: "ambiguous",
  },
  {
    name: "v2 rewritten ref",
    report: ok.slice(0, -4) + pkt("option refname refs/heads/other\n") + FLUSH,
    status: 200,
    observed: next,
    caps: "report-status-v2",
    outcome: "ambiguous",
  },
  {
    name: "malformed hex",
    report: "000g" + ng,
    status: 200,
    observed: old,
    caps: "report-status",
    outcome: "ambiguous",
  },
  {
    name: "trailing report bytes",
    report: ng + "x",
    status: 200,
    observed: old,
    caps: "report-status",
    outcome: "ambiguous",
  },
])("work push: $name", async ({ report, status, observed, caps, outcome }) => {
  const t = await fixture();
  try {
    const response = await t.push(report, status, observed, caps);
    expect(response.status).toBe(outcome === "ambiguous" ? 500 : 200);
    if (outcome !== "ambiguous") expect(await response.text()).toBe(report);
    expect(t.sqlite.prepare("SELECT state FROM source_operations WHERE kind='push'").all()).toEqual(
      [{ state: outcome }],
    );
    const active = await t.tracker.sourcePushes(t.access, "app");
    if (outcome === "ambiguous")
      expect(active).toMatchObject({ ok: true, value: [{ state: "ambiguous" }] });
    else expect(active).toEqual({ ok: true, value: [] });
    expect(t.remote.refs.get(`refs/gitmatrix/progress/${old}`)).toBe(old);
    expect(t.remote.refs.get(`refs/gitmatrix/progress/${next}`)).toBe(
      outcome === "accepted" ? next : undefined,
    );
  } finally {
    t.sqlite.close();
  }
});

test("an accepted work push forgets cached refs before it answers", async () => {
  // Push effects (afterPush, mocked here) reach their own invalidation only after
  // several round trips, long after the client saw the push succeed.
  const t = await fixture();
  try {
    const source = t.sqlite
      .prepare(
        "SELECT artifacts_name, artifacts_remote FROM timeline_work_sources WHERE source_id=?",
      )
      .get(t.sourceId) as { artifacts_name: string; artifacts_remote: string };
    const work = async () =>
      (
        await new RepoReader(
          t.env,
          source.artifacts_name,
          source.artifacts_remote,
          new Timing(),
          () => {},
        ).refs()
      ).branches.find((branch) => branch.name === ref)?.oid;
    // Progress already retained for both tips: the push writes no ref of its own.
    for (const oid of [old, next]) t.remote.refs.set(`refs/gitmatrix/progress/${oid}`, oid);
    invalidateRefs(source.artifacts_name);
    expect(await work()).toBe(old);
    expect((await t.push(ok, 200, next, "report-status")).status).toBe(200);
    expect(await work()).toBe(next);
  } finally {
    t.sqlite.close();
  }
});

test("a repository-only collaborator pushes to a work source with no Tracker access", async () => {
  const t = await fixture();
  try {
    t.sqlite.exec(`
      INSERT INTO accounts(id,kind,slug,display_name) VALUES
        ('jun','user','jun','Jun'), ('cat','user','cat','Cat');
      INSERT INTO repo_collaborators(repo_id,user_id,role) VALUES ('app','jun','write'), ('app','cat','read');
    `);
    const bearer = async (id: string) =>
      `Bearer ${(await issueToken(t.env.DB, id, "test", "write")).secret}`;
    const jun = await bearer("jun");
    // A read collaborator can't write the repository, so not its work source either.
    expect((await t.push(ok, 200, next, "report-status", await bearer("cat"))).status).toBe(403);
    expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM source_operations").get()).toEqual({ n: 0 });
    // Write access to the repository authorizes its work source; no Space grant is involved.
    const pushed = await t.push(ok, 200, next, "report-status", jun);
    expect(pushed.status).toBe(200);
    expect(
      t.sqlite.prepare("SELECT state, data FROM source_operations WHERE kind='push'").all(),
    ).toMatchObject([
      { state: "accepted", data: expect.stringContaining('"accountableId":"jun"') },
    ]);
    // The push grants nothing in the Tracker: its timelines stay closed to the collaborator.
    const timelines = await t.app.request(
      "/api/tracker/ann/timelines",
      { headers: { authorization: jun, "X-Gitmatrix-Content-Version": "4" } },
      t.env,
      t.ctx,
    );
    expect([403, 404]).toContain(timelines.status);
  } finally {
    t.sqlite.close();
  }
});
