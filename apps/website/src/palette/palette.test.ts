import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { RepoDetail, Viewer } from "../../shared/api.ts";
import { matchFields, type SearchResponse } from "../../shared/search.ts";
import {
  COMMAND_SOURCES,
  contextTracker,
  destinations,
  matchCommands,
  type PaletteContext,
} from "./commands.ts";
import { CREATE_INTENT, createIntentOf } from "./intents.ts";
import { remoteSearch, type RemoteState } from "./remote.ts";
import { edge, FRESH, move, reconcile } from "./selection.ts";

const viewer: Viewer = {
  id: "ann",
  kind: "user",
  slug: "ann",
  displayName: "Ann Lee",
  avatarUrl: null,
  isSiteAdmin: false,
  email: null,
  organizations: [],
  spaces: [],
  personalOrganizationId: null,
  defaultSpaceId: null,
  agent: null,
};

const repo = {
  space: {
    id: "orbit",
    organizationId: "org-orbit",
    slug: "orbit",
    displayName: "Orbit",
    archivedAt: null,
    authorizationVersion: 1,
    createdAt: "2026-01-01T00:00:00Z",
    organization: {
      id: "org-orbit",
      slug: "orbit",
      displayName: "Orbit",
      kind: "company",
      avatarUrl: null,
      personalAccountId: null,
      defaultSpaceId: "orbit",
      createdAt: "2026-01-01T00:00:00Z",
    },
  },
  name: "engine",
  defaultBranch: "main",
  head: "abc",
  viewerRole: "read",
} as RepoDetail;

function commands(context: Partial<PaletteContext> = {}) {
  const full: PaletteContext = {
    viewer,
    pathname: "/",
    repo: null,
    trackers: null,
    query: "",
    ...context,
  };
  return COMMAND_SOURCES.flatMap((source) => source(full));
}

describe("local matching", () => {
  test("ranks like the server: exact, prefix, word, contains", () => {
    const fields = (name: string, searched: string[] = []) => ({
      identifiers: [name],
      names: [name],
      searched,
    });
    expect(matchFields("ci", fields("CI"))).toBe("exact");
    expect(matchFields("issue", fields("Issue tracker"))).toBe("prefix");
    expect(matchFields("tracker", fields("Issue tracker"))).toBe("word");
    expect(matchFields("engine", fields("rocket-engine"))).toBe("word");
    expect(matchFields("tickets", fields("Issue tracker", ["tickets"]))).toBe("contains");
    // Several words match as a phrase or not at all, as on the server.
    expect(matchFields("issue tickets", fields("Issue tracker", ["tickets"]))).toBe("contains");
    expect(matchFields("missing", fields("Issue tracker"))).toBeNull();
    expect(matchFields("   ", fields("Issue tracker"))).toBeNull();
  });
});

describe("commands", () => {
  test("offer only what the viewer can use", () => {
    const signedOut = commands({ viewer: null, pathname: "/orbit/engine" });
    expect(signedOut.map((c) => c.id)).toEqual(["page:home", "page:signin"]);
    expect(signedOut[1]!.run).toEqual({ kind: "navigate", to: "/signin?next=%2Forbit%2Fengine" });

    const ids = commands().map((c) => c.id);
    expect(ids).toContain("page:tracker");
    expect(ids).toContain("action:assistant");
    expect(ids).not.toContain("page:invites");
    expect(commands({ viewer: { ...viewer, isSiteAdmin: true } }).map((c) => c.id)).toContain(
      "page:invites",
    );
  });

  test("include the current repository's sections from its tab list", () => {
    const inRepo = commands({ repo }).filter((c) => c.id.startsWith("repo:"));
    expect(inRepo.map((c) => c.title)).toEqual([
      "Code",
      "Commits",
      "Changes",
      "CI",
      "Packages",
      "Issues",
      "Releases",
      "Wiki",
      "Knowledge",
    ]);
    expect(inRepo[0]!.run).toEqual({ kind: "navigate", to: "/orbit/engine" });
    const admin = commands({ repo: { ...repo, viewerRole: "admin" } });
    expect(admin.map((c) => c.id)).toContain("repo:settings");
  });

  test("match by title and keyword, strongest first within a group", () => {
    const matched = matchCommands(commands({ repo }), "iss");
    expect(matched.get("repository")?.map((m) => [m.command.title, m.match])).toEqual([
      ["Issues", "prefix"],
    ]);
    expect(matched.get("pages")?.map((m) => m.command.title)).toEqual(["Issue tracker"]);
    expect(matchCommands(commands(), "tickets").get("pages")?.[0]?.command.id).toBe("page:tracker");
  });
});

describe("before anything's typed", () => {
  const trackers = [
    {
      ...repo.space,
      id: "ann",
      slug: "ann",
      displayName: "Ann Lee",
      organizationId: "org-ann",
      organization: {
        ...repo.space.organization,
        id: "org-ann",
        slug: "ann",
        displayName: "Ann Lee",
        kind: "personal" as const,
        personalAccountId: "ann",
        defaultSpaceId: "ann",
      },
    },
    repo.space,
  ];
  const home = (context: Partial<PaletteContext>) =>
    Object.fromEntries(
      [...matchCommands(commands(context), "")].map(([group, list]) => [
        group,
        list.map((m) => m.command.id),
      ]),
    );

  test("offers one Go to, then things to do, instead of every page", () => {
    expect(home({ trackers })).toEqual({
      pages: ["go"],
      find: [
        "knowledge:pick",
        "find:repositories",
        "find:issues",
        "find:accounts",
        "find:packages",
        "find:conversations",
      ],
      actions: ["create:ann", "action:assistant"],
    });
    // On a repository: its code search, and its tracker for a new issue.
    expect(home({ trackers, repo, pathname: "/orbit/engine" })).toEqual({
      pages: ["go"],
      repository: ["knowledge:here"],
      actions: ["create:orbit", "action:assistant"],
      find: [
        "find:repositories",
        "find:issues",
        "find:accounts",
        "find:packages",
        "find:conversations",
      ],
    });
    // Signed out there are only a few places, so they're listed directly.
    expect(home({ viewer: null, repo })).toMatchObject({
      pages: ["page:home", "page:signin"],
      repository: expect.arrayContaining(["repo:code", "repo:ci"]),
    });
  });

  test("typing still reaches every page and section directly", () => {
    const matched = matchCommands(commands({ repo }), "tokens");
    expect(matched.get("pages")?.map((m) => m.command.id)).toEqual(["page:tokens"]);
    expect(matchCommands(commands({ repo }), "wiki").get("repository")?.[0]?.command.id).toBe(
      "repo:wiki",
    );
    expect(matchCommands(commands(), "go to").get("pages")?.[0]?.command.id).toBe("go");
  });

  test("Go to lists every place, the repository's first, and filters without a cap", () => {
    const go = commands().find((c) => c.id === "go")!;
    expect(go.run).toEqual({ kind: "scope", scope: { kind: "go" } });
    const context: PaletteContext = { viewer, pathname: "/", repo, trackers: null, query: "" };
    const places = destinations(context);
    expect(places.map((c) => c.id)).not.toContain("go");
    expect(places[0]!.id).toBe("repo:code");
    const all = matchCommands(places, "", { perGroup: Infinity, everything: true });
    expect(all.get("repository")).toHaveLength(9);
    expect(all.get("pages")?.length).toBeGreaterThan(10);
    const settings = matchCommands(places, "s", { perGroup: Infinity, everything: true });
    expect(settings.get("pages")?.length).toBeGreaterThan(6);
  });

  test("each Find narrows to one kind of result", () => {
    const finds = commands().filter((c) => c.id.startsWith("find:"));
    expect(finds.map((c) => c.run)).toEqual(
      ["repositories", "issues", "accounts", "packages", "conversations"].map((category) => ({
        kind: "scope",
        scope: { kind: "find", category },
      })),
    );
    expect(commands({ viewer: null }).some((c) => c.id.startsWith("find:"))).toBe(false);
  });
});

describe("create issue", () => {
  const trackers = [{ ...repo.space, id: "ann", slug: "ann", displayName: "Ann Lee" }, repo.space];
  const creates = (context: Partial<PaletteContext>) =>
    commands({ trackers, ...context }).filter((c) => c.id.startsWith("create"));

  test("offers each usable tracker, the current one first, as a form to open", () => {
    expect(creates({ trackers: null })).toEqual([]);
    expect(creates({ viewer: null })).toEqual([]);
    expect(creates({}).map((c) => c.title)).toEqual([
      "Create issue in Ann Lee",
      "Create issue in Orbit",
    ]);
    const inRepo = creates({ repo, pathname: "/orbit/engine" });
    expect(inRepo.map((c) => c.title)).toEqual([
      "Create issue in Orbit",
      "Create issue in Ann Lee",
    ]);
    expect(inRepo[0]!.run).toEqual({
      kind: "navigate",
      to: "/tracker/orbit",
      state: { [CREATE_INTENT]: { title: "" } },
    });
    expect(
      contextTracker({
        viewer,
        pathname: "/tracker/orbit/issues/x",
        repo: null,
        trackers,
        query: "",
      })?.slug,
    ).toBe("orbit");
  });

  test("proposes what's typed as a title, in the current tracker or else your own", () => {
    const titled = creates({ query: "  Fix the login  " })[0]!;
    expect(titled).toMatchObject({
      title: "Create issue “Fix the login”",
      hint: "in ann",
      run: { to: "/tracker/ann", state: { [CREATE_INTENT]: { title: "Fix the login" } } },
    });
    expect(creates({ query: "x", pathname: "/tracker/orbit" })[0]!.hint).toBe("in orbit");
    // Away from any tracker, the one /tracker opens wins over your own.
    expect(creates({ query: "x", defaultTrackerId: "orbit" })[0]!.hint).toBe("in orbit");
    // Typing the command's name finds the commands, not a titled draft.
    for (const query of [
      "create issue",
      "new issue",
      "Create",
      "create issue in orbit",
      "new issue ann",
    ])
      expect(creates({ query }).map((c) => c.id)).not.toContain("create-titled:ann");
    // A reference is somewhere to go (the palette jumps to it), never a title (CORE-22).
    for (const query of [
      "3f9a2c1",
      "3f9a2c1d0e4b5a6978877665544332211aabbccd",
      "CORE-22",
      "#12",
      "kit@1.2.0",
    ])
      expect(creates({ query }).map((c) => c.id)).not.toContain("create-titled:ann");
    // It's offered for any text, ahead of other actions.
    const matched = matchCommands(commands({ trackers, query: "qqq zzz" }), "qqq zzz");
    expect(matched.get("actions")?.[0]?.command.id).toBe("create-titled:ann");
  });

  test("intents are read defensively and never carry more than a title", () => {
    expect(createIntentOf(null)).toBeNull();
    expect(createIntentOf({ other: 1 })).toBeNull();
    expect(createIntentOf({ [CREATE_INTENT]: { title: 7 } })).toEqual({ title: "" });
    expect(createIntentOf({ [CREATE_INTENT]: { title: "x".repeat(600) } })?.title).toHaveLength(
      500,
    );
  });
});

describe("ask", () => {
  test("is offered only for typed text, signed in, as a fallback that submits explicitly", () => {
    const ask = (context: Partial<PaletteContext>) => commands(context).find((c) => c.id === "ask");
    expect(ask({ query: "" })).toBeUndefined();
    expect(ask({ query: "   " })).toBeUndefined();
    expect(ask({ viewer: null, query: "why" })).toBeUndefined();
    const command = ask({ query: " why is CI slow? " })!;
    expect(command).toMatchObject({
      always: true,
      run: { kind: "action" },
    });
    const calls: string[] = [];
    if (command.run.kind === "action")
      command.run.perform({
        navigate: () => {},
        assistant: { show: () => {}, openChat: () => {}, ask: (p) => calls.push(p) },
        scope: () => {},
      });
    expect(calls).toEqual(["why is CI slow?"]);
  });
});

describe("selection", () => {
  test("defaults to the first option and stays on it as results arrive", () => {
    const first = reconcile(FRESH, ["page:tracker"]);
    expect(first).toEqual({ id: "page:tracker", chosen: false });
    // Remote results land above and below: the active option doesn't jump.
    expect(reconcile(first, ["repositories:1", "page:tracker", "accounts:2"])).toBe(first);
  });

  test("never defaults to a fallback that acts on the query", () => {
    const ids = ["repositories:1", "create-titled:ann"];
    expect(reconcile(FRESH, ids, ["repositories:1"])).toEqual({
      id: "repositories:1",
      chosen: false,
    });
    // With only the fallback, nothing is selected until the person moves to it.
    expect(reconcile(FRESH, ["create-titled:ann"], [])).toEqual(FRESH);
    expect(move(FRESH, ["create-titled:ann"], 1)).toEqual({
      id: "create-titled:ann",
      chosen: true,
    });
  });

  test("never moves a chosen option to one the person didn't pick", () => {
    const chosen = move(reconcile(FRESH, ["a", "b", "c"]), ["a", "b", "c"], 1);
    expect(chosen).toEqual({ id: "b", chosen: true });
    expect(reconcile(chosen, ["c", "a", "b"])).toBe(chosen);
    expect(reconcile(chosen, ["a", "c"])).toEqual({ id: null, chosen: true });
    // Until they move again.
    expect(move({ id: null, chosen: true }, ["a", "c"], 1)).toEqual({ id: "a", chosen: true });
  });

  test("wraps with the arrows and jumps to the ends", () => {
    expect(move({ id: "c", chosen: true }, ["a", "b", "c"], 1).id).toBe("a");
    expect(move({ id: "a", chosen: true }, ["a", "b", "c"], -1).id).toBe("c");
    expect(move(FRESH, ["a", "b"], -1).id).toBe("b");
    expect(move(FRESH, [], 1)).toBe(FRESH);
    expect(edge(["a", "b", "c"], "last")).toEqual({ id: "c", chosen: true });
    expect(edge([], "first")).toBe(FRESH);
  });
});

describe("remote search", () => {
  afterEach(() => vi.useRealTimers());

  const response = (query: string): SearchResponse => ({ query, groups: [] });

  test("debounces typing and only ever shows the newest query's answer", async () => {
    vi.useFakeTimers();
    const resolvers = new Map<string, (r: SearchResponse) => void>();
    const signals = new Map<string, AbortSignal>();
    const fetch = vi.fn(
      (query: string, signal: AbortSignal) =>
        new Promise<SearchResponse>((resolve) => {
          resolvers.set(query, resolve);
          signals.set(query, signal);
        }),
    );
    const states: RemoteState[] = [];
    const client = remoteSearch(fetch, (state) => states.push(state), 100);

    client.search("o");
    client.search("or");
    client.search("orb");
    await vi.advanceTimersByTimeAsync(100);
    expect(fetch.mock.calls.map(([q]) => q)).toEqual(["orb"]);

    client.search("orbit");
    await vi.advanceTimersByTimeAsync(100);
    expect(signals.get("orb")!.aborted).toBe(true);

    // The older request answers last: it's ignored.
    resolvers.get("orbit")!(response("orbit"));
    await vi.advanceTimersByTimeAsync(0);
    resolvers.get("orb")!(response("orb"));
    await vi.advanceTimersByTimeAsync(0);
    const done = states.filter((s) => s.status === "done");
    expect(done.map((s) => s.query)).toEqual(["orbit"]);
    expect(states.at(-1)).toMatchObject({ status: "done", query: "orbit" });
  });

  test("reports failures for the current query and stays quiet for queries the server rejects", async () => {
    vi.useFakeTimers();
    const states: RemoteState[] = [];
    const fetch = vi.fn(() => Promise.reject(new Error("Couldn't reach the server.")));
    const client = remoteSearch(fetch, (state) => states.push(state), 10);
    client.search("engine");
    await vi.advanceTimersByTimeAsync(10);
    expect(states.at(-1)).toEqual({
      status: "failed",
      query: "engine",
      error: "Couldn't reach the server.",
    });
    client.search("a b c d e f g");
    client.search("");
    await vi.advanceTimersByTimeAsync(10);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toEqual({ status: "idle", query: "" });
  });

  test("stops in-flight work when disposed", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const client = remoteSearch(
      (_, s) => {
        signal = s;
        return new Promise(() => {});
      },
      () => {},
      10,
    );
    client.search("engine");
    await vi.advanceTimersByTimeAsync(10);
    client.dispose();
    expect(signal?.aborted).toBe(true);
  });
});
