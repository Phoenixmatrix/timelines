import { expect, onTestFinished, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { SessionResponse } from "../../shared/api.ts";
import type { SpacePage, SpaceSummary } from "../../shared/spaces.ts";
import type { TrackerList } from "../../shared/tracker.ts";
import type {
  ReleaseHighlights,
  ReleaseNotesIndex,
  ReleaseNotesRelease,
} from "../../shared/release-notes.ts";
import { focusOn, press } from "../testing/focus.ts";
import { renderApp } from "../testing/render.tsx";
import { reply, TestServer } from "../testing/server.ts";

const spaceApi = "/api/tracker/orbit/release-notes/highlights";
const note = { repo: { space: "orbit", name: "highlights-engine" }, release: "@day:2026-09-20" };
function overview(
  space: SpaceSummary,
  overrides: Partial<ReleaseHighlights> = {},
): ReleaseHighlights {
  return {
    scope: "tracker",
    space,
    status: { state: "ready", generatedAt: "2026-09-20T12:00:00.000Z" },
    body: "Parcel verification now checks every batch.\n<img src=x onerror=alert(1)>",
    model: "@cf/test-highlights-model",
    notes: [note],
    updatedAt: "2026-09-20T12:00:00.000Z",
    ...overrides,
  };
}

/** Fake only intervals so runner timeouts and browser interactions keep real time. */
function controlPolling() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  return {
    async tick(milliseconds = 5000) {
      await vi.advanceTimersByTimeAsync(milliseconds);
    },
  };
}

/** The world's real orbit Space, as highlights name it. */
async function orbit(server: TestServer): Promise<SpaceSummary> {
  return (await server.call<SpacePage>("GET", "/api/spaces/orbit")).space;
}

/** Make the Space the viewer's default so the top-level places land on it. */
async function defaultToOrbit(server: TestServer) {
  const trackers = await server.call<TrackerList>("GET", "/api/tracker");
  const tracker = trackers.trackers.find((entry) => entry.slug === "orbit")!;
  server.on("GET", "/api/tracker", { ...trackers, defaultSpaceId: tracker.id });
}

for (const path of ["/tracker/orbit/highlights", "/highlights"]) {
  test(`${path} shows the Space's highlights with exact daily-note backlinks`, async () => {
    const server = await TestServer.start({ world: true });
    await server.repo("orbit", "highlights-engine");
    const space = await orbit(server);
    await defaultToOrbit(server);
    server.on("GET", spaceApi, overview(space));
    const app = renderApp(path);
    await expect
      .element(page.getByRole("heading", { name: "Highlights", exact: true }))
      .toBeVisible();
    await expect.element(page.getByRole("article", { name: "Release highlights" })).toBeVisible();
    expect(app.container.querySelector("article")?.textContent).toContain(
      "<img src=x onerror=alert(1)>",
    );
    expect(app.container.querySelector("article img")).toBeNull();
    await app.waitForUrl((url) => url.pathname === "/tracker/orbit/highlights");
    expect(server.requests.some((request) => request.url.pathname === spaceApi)).toBe(true);
    const highlightsRequest = vi
      .mocked(window.fetch)
      .mock.calls.find(([input]) => input === spaceApi);
    expect(highlightsRequest?.[1]?.cache).toBe("no-store");
    expect(new Headers(highlightsRequest?.[1]?.headers).get("Cache-Control")).toBe(
      "private, no-store",
    );
    await expect.poll(() => document.title).toContain(space.displayName);
    const source = page.getByRole("link", {
      name: "orbit/highlights-engine 2026-09-20",
      exact: true,
    });
    await expect
      .element(source)
      .toHaveAttribute("href", "/orbit/highlights-engine/releases/%40day%3A2026-09-20");
    server.on("GET", "/api/repos/orbit/highlights-engine/release-notes", {
      releases: [],
      status: { state: "ready", generatedAt: null },
    });
    server.on("GET", "/api/repos/orbit/highlights-engine/release-notes/release", () =>
      reply({ error: "No notes" }, 404),
    );
    await focusOn(source);
    await press("Enter");
    await app.waitForUrl((url) => url.pathname.endsWith("/releases/%40day%3A2026-09-20"));
    await expect
      .poll(() =>
        server.requests.some(
          (request) =>
            request.url.pathname.endsWith("/release-notes/release") &&
            request.url.searchParams.get("name") === note.release,
        ),
      )
      .toBe(true);
  });
}

test("the rail's Highlights place opens the current Space, or the default one", async () => {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "highlights-engine");
  const space = await orbit(server);
  await defaultToOrbit(server);
  server.on("GET", spaceApi, overview(space));
  // The browser world's API subset has no repository release-notes route.
  server.on("GET", "/api/repos/orbit/highlights-engine/release-notes", {
    releases: [],
    status: { state: "ready", generatedAt: null },
  } satisfies ReleaseNotesIndex);
  const app = renderApp("/tracker/orbit/releases");
  const rail = page.getByRole("navigation", { name: "Places" });
  await expect
    .element(rail.getByRole("link", { name: "Highlights", exact: true }))
    .toHaveAttribute("href", "/tracker/orbit/highlights");
  await page.getByRole("link", { name: "View highlights", exact: true }).click();
  await app.waitForUrl((url) => url.pathname === "/tracker/orbit/highlights");
  await app.navigate("/orbit/highlights-engine/releases");
  await expect.element(page.getByText(/No daily updates are available yet/)).toBeVisible();
  await page.getByRole("link", { name: "View Space highlights", exact: true }).click();
  await app.waitForUrl((url) => url.pathname === "/tracker/orbit/highlights");
  await page.getByRole("link", { name: "Browse detailed notes", exact: true }).click();
  await app.waitForUrl((url) => url.pathname === "/tracker/orbit/releases");
});

test("the repository highlights page is gone", async () => {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "highlights-engine");
  server.on("GET", "/api/repos/orbit/highlights-engine/release-notes", {
    releases: [],
    status: { state: "ready", generatedAt: null },
  } satisfies ReleaseNotesIndex);
  server.on("GET", "/api/repos/orbit/highlights-engine/release-notes/release", () =>
    reply({ error: "No notes" }, 404),
  );
  const app = renderApp("/orbit/highlights-engine/releases/highlights");
  await expect.element(page.getByText(/No daily updates are available yet/)).toBeVisible();
  expect(app.container.querySelector('[aria-label="Release highlights"]')).toBeNull();
  expect(server.requests.some((request) => request.url.pathname.endsWith("/highlights"))).toBe(
    false,
  );
});

for (const state of ["disabled", "ready"] as const) {
  test(`repository ${state === "disabled" ? "disabled notes" : "detailed notes"} link to Space highlights`, async () => {
    const server = await TestServer.start({ world: true });
    await server.repo("orbit", "highlights-engine");
    const space = await orbit(server);
    const release: ReleaseNotesRelease = {
      release: {
        name: note.release,
        kind: "daily",
        toOid: "a".repeat(40),
        fromTag: null,
        lastCommitAt: "2026-09-20T12:00:00.000Z",
        updatedAt: "2026-09-20T12:00:00.000Z",
        entries: 0,
        fromOid: null,
        truncated: false,
        intro: "Parcel verification now checks every batch.",
        introModel: null,
      },
      entries: [],
    };
    server.on("GET", "/api/repos/orbit/highlights-engine/release-notes", {
      releases: state === "ready" ? [release.release] : [],
      status: { state, generatedAt: null },
    } satisfies ReleaseNotesIndex);
    server.on("GET", "/api/repos/orbit/highlights-engine/release-notes/release", release);
    server.on("GET", spaceApi, overview(space));
    const app = renderApp("/orbit/highlights-engine/releases");
    await expect
      .element(
        page.getByText(
          state === "disabled" ? "AI writing is off in this environment." : release.release.intro!,
          { exact: true },
        ),
      )
      .toBeVisible();
    const link = page.getByRole("link", { name: "View Space highlights", exact: true });
    await expect.element(link).toHaveAttribute("href", "/tracker/orbit/highlights");
    await link.click();
    await app.waitForUrl((url) => url.pathname === "/tracker/orbit/highlights");
    await expect.element(page.getByRole("article", { name: "Release highlights" })).toBeVisible();
  });
}

test.each(["grantee", "non-grantee", "signed-out"] as const)(
  "the repository release page offers Space highlights to a %s only if they can read them",
  async (who) => {
    const server = await TestServer.start({ world: true });
    await server.repo("orbit", "highlights-engine");
    const session = await server.call<SessionResponse>("GET", "/api/session");
    expect(session.viewer?.spaces.some((space) => space.slug === "orbit")).toBe(true);
    if (who !== "grantee")
      server.on("GET", "/api/session", {
        ...session,
        viewer:
          who === "signed-out"
            ? null
            : {
                ...session.viewer!,
                spaces: session.viewer!.spaces.filter((space) => space.slug !== "orbit"),
              },
      });
    server.on("GET", "/api/repos/orbit/highlights-engine/release-notes", {
      releases: [],
      status: { state: "ready", generatedAt: null },
    } satisfies ReleaseNotesIndex);
    renderApp("/orbit/highlights-engine/releases");
    await expect.element(page.getByText(/No daily updates are available yet/)).toBeVisible();
    const link = page.getByRole("link", { name: "View Space highlights", exact: true });
    if (who === "grantee") await expect.element(link).toBeVisible();
    else await expect.element(link).not.toBeInTheDocument();
  },
);

for (const state of ["disabled", "idle", "failed"] as const) {
  test(`${state} highlights hide stale prose and sources while allowing manual refresh`, async () => {
    const server = await TestServer.start({ world: true });
    const space = await orbit(server);
    server.on("GET", spaceApi, overview(space, { status: { state, generatedAt: null } }));
    renderApp("/tracker/orbit/highlights");
    await expect
      .element(page.getByRole("button", { name: "Check for updates", exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("article", { name: "Release highlights" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("link", { name: "orbit/highlights-engine 2026-09-20", exact: true }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Check for updates", exact: true }).click();
    await expect
      .poll(() => server.requests.filter((request) => request.url.pathname === spaceApi).length)
      .toBe(2);
  });
}

test("pending highlights poll within a bound, then offer a manual check and stop when ready", async () => {
  const server = await TestServer.start({ world: true });
  const space = await orbit(server);
  const pending = overview(space, { status: { state: "generating", generatedAt: null } });
  server.on("GET", spaceApi, pending);
  const clock = controlPolling();
  renderApp("/tracker/orbit/highlights");
  await expect
    .element(page.getByRole("button", { name: "Check for updates", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("article", { name: "Release highlights" }))
    .not.toBeInTheDocument();
  // Busy checks still consume the one-minute budget; a tick need not start a request.
  let release!: () => void;
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(() => release());
  let checks = 0;
  server.on("GET", spaceApi, async () => {
    checks++;
    await response;
    return pending;
  });
  await clock.tick();
  await expect.element(page.getByRole("button", { name: "Checking…", exact: true })).toBeDisabled();
  await expect.poll(() => checks).toBe(1);
  const paused = page.getByText(/Automatic checking has paused/);
  await clock.tick(54_999);
  await expect.element(paused).not.toBeInTheDocument();
  expect(checks).toBe(1);
  await clock.tick(1);
  await expect.element(paused).toBeVisible();
  expect(checks).toBe(1);
  release();
  await expect
    .element(page.getByRole("button", { name: "Check for updates", exact: true }))
    .toBeEnabled();
  await expect
    .poll(() => server.requests.filter((request) => request.url.pathname === spaceApi).length)
    .toBe(2);
  const count = server.requests.filter((request) => request.url.pathname === spaceApi).length;
  await clock.tick(60_000);
  expect(checks).toBe(1);
  expect(server.requests.filter((request) => request.url.pathname === spaceApi).length).toBe(count);
  server.on("GET", spaceApi, overview(space));
  await page.getByRole("button", { name: "Check for updates", exact: true }).click();
  await expect.element(page.getByRole("article", { name: "Release highlights" })).toBeVisible();
  expect(server.requests.filter((request) => request.url.pathname === spaceApi).length).toBe(
    count + 1,
  );
  const readyCount = server.requests.filter((request) => request.url.pathname === spaceApi).length;
  await clock.tick(60_000);
  expect(server.requests.filter((request) => request.url.pathname === spaceApi).length).toBe(
    readyCount,
  );
});

test("an authorization failure removes prior highlights instead of retaining private text", async () => {
  const server = await TestServer.start({ world: true });
  const space = await orbit(server);
  server.on("GET", spaceApi, overview(space));
  const app = renderApp("/tracker/orbit/highlights");
  await expect.element(page.getByRole("article", { name: "Release highlights" })).toBeVisible();
  server.on("GET", "/api/tracker/private/release-notes/highlights", () =>
    reply({ error: "Access denied" }, 403),
  );
  await app.navigate("/tracker/private/highlights");
  await expect
    .element(page.getByRole("article", { name: "Release highlights" }))
    .not.toBeInTheDocument();
  expect(app.container.textContent).not.toContain("Parcel verification");
});

test("a pending overview appears automatically when generation finishes", async () => {
  const server = await TestServer.start({ world: true });
  const space = await orbit(server);
  server.on(
    "GET",
    spaceApi,
    overview(space, { status: { state: "generating", generatedAt: null } }),
  );
  const clock = controlPolling();
  renderApp("/tracker/orbit/highlights");
  await expect
    .element(page.getByRole("button", { name: "Check for updates", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("article", { name: "Release highlights" }))
    .not.toBeInTheDocument();
  server.on("GET", spaceApi, overview(space));
  await clock.tick();
  await expect.element(page.getByRole("article", { name: "Release highlights" })).toBeVisible();
  await expect
    .poll(() => server.requests.filter((request) => request.url.pathname === spaceApi).length)
    .toBe(2);
  const count = server.requests.filter((request) => request.url.pathname === spaceApi).length;
  await clock.tick(60_000);
  expect(server.requests.filter((request) => request.url.pathname === spaceApi).length).toBe(count);
});
