import { isProxy } from "node:util/types";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { Assistant } from "./agent.ts";
import { AssistantContentUnavailable, contentProbe, contentReceipt } from "./provenance.ts";
import { fakeDurableState } from "../testing/durable-state.ts";
import { installCutoverTestControl } from "../testing/space-cutover.ts";
import type { Actor } from "../db.ts";
import { findRepo, repoSummary, roleFor } from "../db.ts";
import { apiClient, type CallApi } from "./internal.ts";
import { freshInstallationDatabases, seedSpaceFixture } from "../testing/spaces.ts";
import { releaseNotesFor, viewerTrackers } from "../release-notes/read.ts";
import { d1, migratedDatabase, migratedRegistryDatabase } from "../testing/d1.ts";
import { initializeFreshSpaceInstallation } from "../space-cutover/installation.ts";
import { app } from "../app.ts";
import { resolveSpaceAccess } from "../spaces/access.ts";
import { linkedWork } from "../tracker/work.ts";

const actor: Actor = {
  id: "person",
  slug: "person",
  displayName: "Person",
  isSiteAdmin: false,
  credential: { kind: "token", id: "person-token" },
};
const actorHeaders = { "X-Gitmatrix-Assistant-Actor": JSON.stringify(actor) };

vi.mock("cloudflare:workers", () => {
  return {
    DurableObject: class {
      ctx: DurableObjectState;
      env: Env;
      constructor(ctx: DurableObjectState, env: Env) {
        // Workerd checks the native state brand; a transparent Proxy fails it.
        if (isProxy(ctx)) throw new TypeError("DurableObjectState must retain its native identity");
        this.ctx = ctx;
        this.env = env;
      }
    },
    RpcTarget: class {},
    WorkflowEntrypoint: class {},
    WorkerEntrypoint: class {},
    tracing: undefined,
    exports: {},
  };
});
vi.mock("cloudflare:email", () => ({ EmailMessage: class {} }));
vi.mock("../app.ts", () => ({ app: { fetch: vi.fn() } }));

const resources: { close(): void }[] = [];
const background: Promise<unknown>[] = [];
afterEach(async () => {
  while (background.length) await Promise.allSettled(background.splice(0));
  vi.restoreAllMocks();
  for (const resource of resources.splice(0)) resource.close();
});

async function fixture(onAbort?: () => void, native = true) {
  const fresh = native ? await freshInstallationDatabases() : undefined;
  const database = fresh?.sqlite ?? migratedDatabase();
  const registry = fresh?.registry ?? migratedRegistryDatabase();
  const env = { DB: d1(database), REGISTRY_DB: d1(registry) } as Env;
  const journal = installCutoverTestControl(env, fresh?.control);
  const state = fakeDurableState({ name: "person:chat" });
  resources.push(database, registry, journal, state.db);
  if (native) {
    await initializeFreshSpaceInstallation(env);
    database.exec(`INSERT INTO accounts(id,kind,slug,display_name)
      VALUES('person','user','person','Person');
      INSERT INTO access_tokens(id,user_id,name,scope,token_hash,last_four)
      VALUES('person-token','person','Admission test','write','person-token-hash','hash');`);
  }
  // The installed SDK stores its schema version via the platform's synchronous
  // KV API. Back it with the same SQLite KV table as the asynchronous fixture.
  Object.assign(state.ctx.storage, {
    kv: {
      get(key: string) {
        state.db.exec("CREATE TABLE IF NOT EXISTS _cf_KV (key TEXT PRIMARY KEY, value TEXT)");
        const row = state.db.prepare("SELECT value FROM _cf_KV WHERE key=?").get(key);
        return row ? JSON.parse(String(row.value)) : undefined;
      },
      put(key: string, value: unknown) {
        state.db.exec("CREATE TABLE IF NOT EXISTS _cf_KV (key TEXT PRIMARY KEY, value TEXT)");
        state.db
          .prepare(
            "INSERT INTO _cf_KV(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(key, JSON.stringify(value));
      },
    },
  });
  Object.assign(state.ctx, {
    getWebSockets: () => [],
    getTags: () => [],
    setWebSocketAutoResponse: () => {},
    waitUntil: (work: Promise<unknown>) => {
      background.push(work);
    },
  });
  if (onAbort) {
    const abort = state.ctx.abort.bind(state.ctx);
    state.ctx.abort = (...args) => {
      try {
        return abort(...args);
      } finally {
        onAbort();
      }
    };
  }
  // Observe native storage outside business admission, like the platform.
  // The actual SDK receives the original state object, decorated in place.
  const platformContext = { ...state.ctx };
  return {
    env,
    journal,
    database,
    state: { ...state, ctx: platformContext },
    sdkContext: state.ctx,
    assistant: new Assistant(state.ctx, env),
  };
}

function callbackBeforeCompletion(callback: Promise<void>, operation: Promise<unknown>) {
  return Promise.race([
    callback,
    operation.then(() => {
      throw new Error("SDK operation completed without entering the expected callback");
    }),
  ]);
}

test("closed admission precedes the real SDK constructor, live sockets and native recovery callbacks", async () => {
  const { assistant, journal, state } = await fixture(undefined, false);
  const before = state.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
  await journal.fence();
  await expect(assistant.__unsafe_ensureInitialized()).rejects.toThrow("space_cutover_fenced");
  await expect(assistant.webSocketMessage({} as WebSocket, "late-message")).rejects.toThrow(
    "space_cutover_fenced",
  );
  await expect(assistant.webSocketClose({} as WebSocket, 1000, "closed", true)).rejects.toThrow(
    "space_cutover_fenced",
  );
  await expect(assistant.webSocketError({} as WebSocket, new Error("late-error"))).rejects.toThrow(
    "space_cutover_fenced",
  );
  // Native SDK recovery RPCs use the same final instance dispatch as sockets.
  await expect(
    Reflect.apply(Reflect.get(assistant, "_cf_sealMemoryLimitedRecovery"), assistant, []),
  ).rejects.toThrow("space_cutover_fenced");
  await expect(assistant.purge("operator")).rejects.toThrow("space_cutover_fenced");
  expect(state.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(
    before,
  );
  expect(journal.control.activeTickets()).toEqual([]);
});

test("runtime probing never constructs the SDK or admits business work", async () => {
  const { assistant, env, journal, state } = await fixture(undefined, false);
  const run = await journal.fence();
  const before = state.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
  await expect(assistant.cutoverRuntime(run.runId)).rejects.toThrow();
  expect(journal.control.activeTickets()).toEqual([]);
  expect(state.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(
    before,
  );
  Reflect.deleteProperty(env, "SPACE_CUTOVER");
  await expect(assistant.cutoverRuntime(run.runId)).rejects.toThrow();
  expect(state.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(
    before,
  );
});

test("real SDK request startup and a late callback retain independent admission after response headers", async () => {
  const finish = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  vi.spyOn(AIChatAgent.prototype, "onRequest").mockImplementation(async function (
    this: AIChatAgent<Env>,
  ) {
    // An ordinary application lifecycle callback: the SDK and persistence are
    // real; only the completion timing is controlled by the test.
    const context = Reflect.get(this, "ctx") as DurableObjectState;
    context.waitUntil(
      (async () => {
        entered.resolve();
        await finish.promise;
        await context.storage.put("late-publication", "complete");
      })(),
    );
    return new Response(null, { status: 204 });
  });
  const { assistant, env, journal, state } = await fixture();
  try {
    const response = await assistant.fetch(
      new Request("https://assistant/test", { headers: actorHeaders }),
    );
    expect(response.status).toBe(204);
    await entered.promise;
    expect(journal.control.activeTickets()).toMatchObject([{ consumer: "assistant" }]);
    Reflect.deleteProperty(env, "SPACE_CUTOVER");
    await expect(assistant.webSocketMessage({} as WebSocket, "late-message")).rejects.toThrow(
      "Missing independent Space cutover control binding",
    );
    expect(await state.ctx.storage.get("late-publication")).toBeUndefined();
  } finally {
    finish.resolve();
  }
  await vi.waitFor(() => expect(journal.control.activeTickets()).toEqual([]));
  expect(await state.ctx.storage.get("late-publication")).toBe("complete");
});

test("SDK detached alarm settlement retains admission after the model work itself finishes", async () => {
  const model = Promise.withResolvers<void>();
  const dispatched = Promise.withResolvers<void>();
  const sdkAlarmReturned = Promise.withResolvers<void>();
  const finalizerEntered = Promise.withResolvers<void>();
  const finishFinalizer = Promise.withResolvers<void>();
  class DrainProbeAgent extends AIChatAgent<Env> {
    cutoverDrainProbe() {
      expect(this.lifecycle.trackAlarmWork(model.promise)).toBe(true);
      dispatched.resolve();
    }

    override async onRequest() {
      const alarm = this.alarm.bind(this);
      this.alarm = async () => {
        await alarm();
        sdkAlarmReturned.resolve();
      };
      await this.schedule(1, "cutoverDrainProbe", {});
      return new Response(null, { status: 204 });
    }
  }
  // Install the typed test agent's real callback on the SDK prototype inherited
  // by the facade's session; scheduler dispatch still resolves the actual method.
  Object.defineProperty(AIChatAgent.prototype, "cutoverDrainProbe", {
    configurable: true,
    value: Object.getOwnPropertyDescriptor(DrainProbeAgent.prototype, "cutoverDrainProbe")?.value,
  });
  vi.spyOn(AIChatAgent.prototype, "onRequest").mockImplementation(function (
    this: AIChatAgent<Env>,
  ) {
    return DrainProbeAgent.prototype.onRequest.call(this);
  });
  const { assistant, env, journal, state } = await fixture();
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    expect(
      (await assistant.fetch(new Request("https://assistant/schedule", { headers: actorHeaders })))
        .status,
    ).toBe(204);
    await vi.waitFor(() => expect(journal.control.activeTickets()).toEqual([]));
    const strikeKey = "cf_agents:oom_alarm_strikes";
    await state.ctx.storage.put(strikeKey, 1);
    const get = state.ctx.storage.get.bind(state.ctx.storage);
    vi.spyOn(state.ctx.storage, "get").mockImplementation(async (...args: unknown[]) => {
      if (args[0] === strikeKey) {
        finalizerEntered.resolve();
        await finishFinalizer.promise;
      }
      return Reflect.apply(get, state.ctx.storage, args);
    });
    vi.setSystemTime(Date.now() + 2_000);
    const alarm = assistant.alarm();
    background.push(alarm);
    await callbackBeforeCompletion(dispatched.promise, alarm);
    await callbackBeforeCompletion(sdkAlarmReturned.promise, alarm);
    model.resolve();
    await callbackBeforeCompletion(finalizerEntered.promise, alarm);
    Reflect.deleteProperty(env, "SPACE_CUTOVER");
    expect(journal.control.activeTickets()).toMatchObject([{ consumer: "assistant" }]);
    finishFinalizer.resolve();
    await alarm;
    expect(await state.ctx.storage.get(strikeKey)).toBeUndefined();
    expect(journal.control.activeTickets()).toEqual([]);
  } finally {
    model.resolve();
    finishFinalizer.resolve();
    vi.useRealTimers();
    Reflect.deleteProperty(AIChatAgent.prototype, "cutoverDrainProbe");
  }
});

test("SDK destroy cannot reset the boot before its normal admission release settles", async () => {
  const resetFinished = Promise.withResolvers<void>();
  const { assistant, journal, state, sdkContext } = await fixture(resetFinished.resolve);
  await assistant.__unsafe_ensureInitialized();
  const releasing = Promise.withResolvers<void>();
  const finishRelease = Promise.withResolvers<void>();
  const release = journal.control.release.bind(journal.control);
  const resetRequested = Promise.withResolvers<void>();
  const abort = sdkContext.abort.bind(sdkContext);
  Object.defineProperty(sdkContext, "abort", {
    configurable: true,
    value: (...args: Parameters<DurableObjectState["abort"]>) => {
      resetRequested.resolve();
      return Reflect.apply(abort, sdkContext, args);
    },
  });
  vi.spyOn(journal.control, "release").mockImplementation(async (ticket: string) => {
    releasing.resolve();
    await finishRelease.promise;
    release(ticket);
  });
  // Native timers retain AsyncLocalStorage. Fake timer dispatch directly calls
  // the callback from runAllTimersAsync's context, losing its admission origin.
  try {
    const purge = assistant.purge("test");
    background.push(purge);
    await callbackBeforeCompletion(releasing.promise, purge);
    await callbackBeforeCompletion(resetRequested.promise, purge);
    expect(state.aborted).toEqual([]);
    expect(journal.control.activeTickets()).toHaveLength(1);
    finishRelease.resolve();
    await purge;
    await resetFinished.promise;
    expect(state.aborted).toEqual(["destroyed"]);
    expect(journal.control.activeTickets()).toEqual([]);
  } finally {
    finishRelease.resolve();
  }
});

test("missing independent control never starts SDK persistence", async () => {
  const state = fakeDurableState({ name: "person:chat" });
  resources.push(state.db);
  const assistant = new Assistant(state.ctx, {} as Env);
  const before = state.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
  await expect(assistant.__unsafe_ensureInitialized()).rejects.toThrow(
    "Missing independent Space cutover control binding",
  );
  expect(state.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(
    before,
  );
});

test("revoked initiating credentials cannot read a warm or cold transcript", async () => {
  const { assistant, env, state, database } = await fixture();
  await assistant.__unsafe_ensureInitialized();
  expect(await assistant.canReadTranscript(actor)).toBe(true);
  database.exec("DELETE FROM access_tokens WHERE id='person-token'");
  await expect(assistant.transcript(actor)).rejects.toThrow("current source access");
  const cold = new Assistant(state.ctx, env);
  await expect(cold.transcript(actor)).rejects.toThrow("current source access");
});

test("personal exports cannot publish retained source content after access is revoked", async () => {
  const { assistant, env, state } = await fixture();
  vi.mocked(app.fetch).mockImplementation(async () =>
    Response.json({ error: "Not found" }, { status: 404 }),
  );
  state.db.exec(`CREATE TABLE cf_ai_chat_agent_messages(
    id TEXT PRIMARY KEY, message TEXT NOT NULL, created_at TEXT NOT NULL)`);
  const message = JSON.stringify({
    id: "source-answer",
    role: "assistant",
    parts: [{ type: "text", text: "Private repository evidence" }],
  });
  state.db
    .prepare("INSERT INTO cf_ai_chat_agent_messages VALUES(?,?,?)")
    .run("source-answer", message, "2026-01-01T00:00:00.000Z");
  await state.ctx.storage.put("content-receipts-v4", [
    {
      path: "/repos/general/private?authorization=1&metadata=1&source=canonical",
      kind: "repository",
      identity: JSON.stringify(["private-repo", "private-space", "canonical"]),
    },
  ]);
  for (const instance of [assistant, new Assistant(state.ctx, env)]) {
    expect(await instance.canReadTranscript(actor)).toBe(false);
    await expect(instance.exportTranscript(actor)).rejects.toBeInstanceOf(
      AssistantContentUnavailable,
    );
  }
  vi.mocked(app.fetch).mockImplementation(async () =>
    Response.json({
      id: "private-repo",
      space: { id: "private-space" },
      source: { sourceId: "canonical" },
    }),
  );
  expect(JSON.parse(await assistant.exportTranscript(actor)).messages).toEqual([
    JSON.parse(message),
  ]);
});

test.each(["collaborator", "public"] as const)(
  "retained tracker-derived release notes require their Space grant despite surviving %s access",
  async (access) => {
    const { assistant, env, state, database } = await fixture();
    await seedSpaceFixture(env.DB, {
      organization: { id: "company", slug: "company", displayName: "Company", kind: "company" },
      space: { id: "space", slug: "general", displayName: "General" },
      actorId: actor.id,
      members: [
        {
          accountId: actor.id,
          role: "owner",
          grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
        },
      ],
    });
    database
      .prepare(`INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote)
      VALUES('repo','space','app',?,'artifact','https://artifact')`)
      .run(access === "public" ? "public" : "private");
    if (access === "collaborator")
      database.exec(
        "INSERT INTO repo_collaborators(repo_id,user_id,role) VALUES('repo','person','read')",
      );
    database.exec(`
      INSERT INTO release_note_state(repo_id,status,format_version) VALUES('repo','ready',1);
      INSERT INTO release_notes(repo_id,release,to_oid,released_at,updated_at,intro,intro_trackers,format_version)
        VALUES('repo','v1','commit','2026-01-01','2026-01-01','Private tracker introduction','["space"]',1);
      INSERT INTO release_note_entries(id,repo_id,release,subject,kind,category,title,summary,
        tracker_space_id,issue_id,issue_key,team_id,team_key,commits,shipped_at,model,inputs_hash,updated_at)
        VALUES('entry','repo','v1','issue:private','issue','feature','Private tracker issue','Private summary',
          'space','issue','ENG-1','team','ENG','["commit"]','2026-01-01','model','inputs','2026-01-01');
    `);
    // Use the production grant calculation and release projection over real SQL.
    // Only the in-process HTTP boundary is adapted; no canned permission response.
    const fetchCurrent = async (request: Request) => {
      const row = await findRepo(env.DB, actor, "general", "app");
      if (!row || roleFor(row, actor) === "none")
        return Response.json({ error: "Not found" }, { status: 404 });
      const url = new URL(request.url);
      if (url.pathname === "/api/repos/general/app/release-notes/release")
        return Response.json(
          await releaseNotesFor(env.DB, row.id, "v1", await viewerTrackers(env.DB, actor)),
        );
      if (url.pathname === "/api/repos/general/app")
        return Response.json({ ...repoSummary(row, actor), source: { sourceId: "canonical" } });
      return Response.json({ error: "Not found" }, { status: 404 });
    };
    vi.mocked(app.fetch).mockImplementation(fetchCurrent);
    const api = apiClient(
      fetchCurrent,
      env,
      (work) => background.push(work),
      async () => "fixture",
    );
    const path = "/repos/general/app/release-notes/release?name=v1";
    const notes = await releaseNotesFor(env.DB, "repo", "v1", await viewerTrackers(env.DB, actor));
    expect(notes?.entries.map((entry) => entry.title)).toEqual(["Private tracker issue"]);
    const message = {
      id: "release-answer",
      role: "assistant",
      parts: [{ type: "text", text: JSON.stringify(notes) }],
    };
    state.db.exec(`CREATE TABLE cf_ai_chat_agent_messages(
      id TEXT PRIMARY KEY, message TEXT NOT NULL, created_at TEXT NOT NULL)`);
    state.db
      .prepare("INSERT INTO cf_ai_chat_agent_messages VALUES(?,?,?)")
      .run(message.id, JSON.stringify(message), "2026-01-01T00:00:00.000Z");
    await state.ctx.storage.put("content-receipts-v4", [
      await contentReceipt(api, contentProbe("GET", path)!),
    ]);
    expect(JSON.parse(await assistant.exportTranscript(actor)).messages).toEqual([message]);

    database.exec("DELETE FROM space_grants WHERE space_id='space' AND account_id='person'");
    const surviving = await findRepo(env.DB, actor, "general", "app");
    expect(roleFor(surviving!, actor)).toBe("read");
    const filtered = await releaseNotesFor(
      env.DB,
      "repo",
      "v1",
      await viewerTrackers(env.DB, actor),
    );
    expect(filtered?.entries).toEqual([]);
    expect(filtered?.release.intro).toBeNull();
    for (const instance of [assistant, new Assistant(state.ctx, env)]) {
      await expect(instance.transcript(actor)).rejects.toBeInstanceOf(AssistantContentUnavailable);
      await expect(instance.exportTranscript(actor)).rejects.toBeInstanceOf(
        AssistantContentUnavailable,
      );
    }
    database.exec(`INSERT INTO space_grants
      (space_id,organization_id,account_id,role,repository_role,package_role,origin,granted_by)
      VALUES('space','company','person','admin','write','write','test-fixture','person')`);
    expect(JSON.parse(await assistant.exportTranscript(actor)).messages).toEqual([message]);
  },
);

test.each(["after-read", "during-read"] as const)(
  "linked-work receipts enforce repository revocation %s while Space access survives",
  async (revocation) => {
    const { assistant, env, state, database } = await fixture();
    Object.assign(state.ctx.storage, {
      async transaction<T>(callback: (storage: DurableObjectStorage) => Promise<T>) {
        state.db.exec("SAVEPOINT receipt");
        try {
          const value = await callback(state.ctx.storage);
          state.db.exec("RELEASE receipt");
          return value;
        } catch (error) {
          state.db.exec("ROLLBACK TO receipt; RELEASE receipt");
          throw error;
        }
      },
    });
    await seedSpaceFixture(env.DB, {
      organization: { id: "company", slug: "company", displayName: "Company", kind: "company" },
      space: { id: "space", slug: "general", displayName: "General" },
      actorId: actor.id,
      members: [
        {
          accountId: actor.id,
          role: "member",
          grant: { role: "member", repositoryRole: "none", packageRole: "none" },
        },
      ],
    });
    database.exec(`
      INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote)
        VALUES('repo','space','private','private','artifact','https://artifact');
      INSERT INTO repo_collaborators(repo_id,user_id,role) VALUES('repo','person','read');
      INSERT INTO step_contexts(repo_id,change_id,commit_oid,author_id,accountable_id,
        issue_key,summary,context,committed_at)
        VALUES('repo','change','${"a".repeat(40)}','person','person',
          'ENG-1','Private implementation details','{}','2026-01-01T00:00:00.000Z');
    `);
    const work = {
      issue: { id: "issue", key: "ENG-1", title: "Issue", status: "todo" as const },
      timelines: [],
    };
    const path = "/tracker/general/issues/ENG-1/work";
    let reads = 0;
    const revoke = () => database.exec("DELETE FROM repo_collaborators WHERE repo_id='repo'");
    vi.mocked(app.fetch).mockImplementation(async (request) => {
      const access = await resolveSpaceAccess(env.DB, actor, "space");
      if (!access) return Response.json({ error: "Not found" }, { status: 404 });
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/tracker/general/authorization")
        return Response.json({ contractVersion: 4, spaceId: access.spaceId, migrationEpoch: 0 });
      if (pathname !== `/api${path}`) return Response.json({ error: "Not found" }, { status: 404 });
      const body = await linkedWork(env, actor, access.space, work);
      // Revoke after producing the actual tool response, before its post-read check.
      if (++reads === 2 && revocation === "during-read") revoke();
      return Response.json(body);
    });
    vi.spyOn(AIChatAgent.prototype, "onRequest").mockImplementation(async function (
      this: AIChatAgent<Env>,
    ) {
      const api = Reflect.apply(Reflect.get(this, "contentApi"), this, []) as CallApi;
      if (revocation === "during-read") {
        await expect(api("GET", path)).rejects.toBeInstanceOf(AssistantContentUnavailable);
        return new Response(null, { status: 204 });
      }
      const result = await api("GET", path);
      // Persist through the real SDK without starting an unrelated model turn.
      vi.spyOn(this, "onChatMessage").mockResolvedValue(undefined);
      await this.saveMessages((messages) => [
        ...messages,
        {
          id: "work-answer",
          role: "assistant",
          parts: [{ type: "text", text: JSON.stringify(result.body) }],
        },
      ]);
      return Response.json(result.body);
    });
    const response = await assistant.fetch(
      new Request("https://assistant/test", { headers: actorHeaders }),
    );
    if (revocation === "during-read") {
      await response.arrayBuffer();
      expect(response.status).toBe(204);
      expect(await state.ctx.storage.get("content-receipts-v4")).toEqual([]);
      expect(await resolveSpaceAccess(env.DB, actor, "space")).not.toBeNull();
      return;
    }
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      steps: [{ summary: "Private implementation details" }],
    });
    const original = JSON.parse(await assistant.exportTranscript(actor)).messages;
    revoke();
    expect(await resolveSpaceAccess(env.DB, actor, "space")).not.toBeNull();
    expect((await linkedWork(env, actor, { id: "space", slug: "general" }, work)).steps).toEqual(
      [],
    );
    for (const instance of [assistant, new Assistant(state.ctx, env)]) {
      await expect(instance.transcript(actor)).rejects.toBeInstanceOf(AssistantContentUnavailable);
      await expect(instance.exportTranscript(actor)).rejects.toBeInstanceOf(
        AssistantContentUnavailable,
      );
    }
    database.exec(
      "INSERT INTO repo_collaborators(repo_id,user_id,role) VALUES('repo','person','read')",
    );
    expect(JSON.parse(await assistant.exportTranscript(actor)).messages).toEqual(original);
  },
);

test("legacy transcripts without provenance are retained but never reused or published", async () => {
  const { assistant, state, database } = await fixture();
  // Persist the actual legacy SDK layout before startup, not through a current
  // publication API that would assign today's provenance.
  state.db.exec(`CREATE TABLE cf_ai_chat_agent_messages(
    id TEXT PRIMARY KEY, message TEXT NOT NULL, created_at TEXT NOT NULL)`);
  state.db.prepare("INSERT INTO cf_ai_chat_agent_messages VALUES(?,?,?)").run(
    "legacy",
    JSON.stringify({
      id: "legacy",
      role: "assistant",
      parts: [{ type: "text", text: "Private legacy evidence" }],
    }),
    "2026-01-01T00:00:00.000Z",
  );
  await assistant.__unsafe_ensureInitialized();
  await expect(assistant.transcript(actor)).rejects.toBeInstanceOf(AssistantContentUnavailable);
  expect(await state.ctx.storage.get("content-receipts-v4")).toBeUndefined();
  await expect(assistant.exportTranscript(actor)).rejects.toBeInstanceOf(
    AssistantContentUnavailable,
  );
  // Inspect the SDK's retained sync projection, not its obsolete pre-migration table.
  expect(
    await Reflect.apply(Reflect.get(assistant, "_messagesForClientSync"), assistant, []),
  ).toEqual([
    { id: "legacy", role: "assistant", parts: [{ type: "text", text: "Private legacy evidence" }] },
  ]);
  await expect(assistant.exportTranscript({ ...actor, id: "other-person" })).rejects.toBeInstanceOf(
    AssistantContentUnavailable,
  );
  database.exec(`INSERT INTO agents(id,name,accountable_id)
    VALUES('other-agent','agent','person');
    INSERT INTO access_tokens(id,user_id,name,scope,token_hash,last_four,agent_id)
    VALUES('agent-token','person','Agent export','read','agent-token-hash','hash','other-agent');`);
  await expect(
    assistant.exportTranscript({
      ...actor,
      agent: { id: "other-agent", name: "agent" },
      credential: { kind: "token", id: "agent-token" },
    }),
  ).rejects.toBeInstanceOf(Error);
});
