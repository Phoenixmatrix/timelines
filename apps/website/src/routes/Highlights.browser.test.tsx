import { expect, onTestFinished, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { SessionResponse } from "../../shared/api.ts";
import type { TrackerList } from "../../shared/tracker.ts";
import type {
  ReleaseHighlights,
  ReleaseNotesIndex,
  ReleaseNotesRelease,
} from "../../shared/release-notes.ts";
import { focusOn, press } from "../testing/focus.ts";
import { renderApp } from "../testing/render.tsx";
import { reply, TestServer } from "../testing/server.ts";

const orgApi = "/api/tracker/orbit/release-notes/highlights";
const note = { repo: { owner: "orbit", name: "highlights-engine" }, release: "@day:2026-09-20" };
function overview(overrides: Partial<ReleaseHighlights> = {}): ReleaseHighlights {
  return {
    scope: "tracker",
    owner: { slug: "orbit", displayName: "Orbit" },
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

/** Make the organization the viewer's default so the top-level places land on it. */
async function defaultToOrbit(server: TestServer) {
  const trackers = await server.call<TrackerList>("GET", "/api/tracker");
  const orbit = trackers.trackers.find((tracker) => tracker.slug === "orbit")!;
  server.on("GET", "/api/tracker", { ...trackers, defaultOwnerId: orbit.id });
}

for (const path of ["/tracker/orbit/highlights", "/highlights"]) {
  test(`${path} shows the organization's highlights with exact daily-note backlinks`, async () => {
    const server = await TestServer.start({ world: true });
    await server.repo("orbit", "highlights-engine");
    await defaultToOrbit(server);
    server.on("GET", orgApi, overview());
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
    expect(server.requests.some((request) => request.url.pathname === orgApi)).toBe(true);
    const highlightsRequest = vi
      .mocked(window.fetch)
      .mock.calls.find(([input]) => input === orgApi);
    expect(highlightsRequest?.[1]?.cache).toBe("no-store");
    expect(new Headers(highlightsRequest?.[1]?.headers).get("Cache-Control")).toBe(
      "private, no-store",
    );
    await expect.poll(() => document.title).toContain("Orbit");
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

test("the rail's Highlights place opens the current organization, or the default one", async () => {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "highlights-engine");
  await defaultToOrbit(server);
  server.on("GET", orgApi, overview());
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
  await page.getByRole("link", { name: "View organization highlights", exact: true }).click();
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
  test(`repository ${state === "disabled" ? "disabled notes" : "detailed notes"} link to organization highlights`, async () => {
    const server = await TestServer.start({ world: true });
    await server.repo("orbit", "highlights-engine");
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
    server.on("GET", orgApi, overview());
    const app = renderApp("/orbit/highlights-engine/releases");
    await expect
      .element(
        page.getByText(
          state === "disabled" ? "AI writing is off in this environment." : release.release.intro!,
          { exact: true },
        ),
      )
      .toBeVisible();
    const link = page.getByRole("link", { name: "View organization highlights", exact: true });
    await expect.element(link).toHaveAttribute("href", "/tracker/orbit/highlights");
    await link.click();
    await app.waitForUrl((url) => url.pathname === "/tracker/orbit/highlights");
    await expect.element(page.getByRole("article", { name: "Release highlights" })).toBeVisible();
  });
}

test.each(["member", "non-member", "signed-out"] as const)(
  "the repository release page offers organization highlights to a %s only if they can read them",
  async (who) => {
    const server = await TestServer.start({ world: true });
    await server.repo("orbit", "highlights-engine");
    const session = await server.call<SessionResponse>("GET", "/api/session");
    expect(session.viewer?.canCreateIn.some((account) => account.slug === "orbit")).toBe(true);
    if (who !== "member")
      server.on("GET", "/api/session", {
        ...session,
        viewer:
          who === "signed-out"
            ? null
            : {
                ...session.viewer!,
                canCreateIn: session.viewer!.canCreateIn.filter(
                  (account) => account.slug !== "orbit",
                ),
              },
      });
    server.on("GET", "/api/repos/orbit/highlights-engine/release-notes", {
      releases: [],
      status: { state: "ready", generatedAt: null },
    } satisfies ReleaseNotesIndex);
    renderApp("/orbit/highlights-engine/releases");
    await expect.element(page.getByText(/No daily updates are available yet/)).toBeVisible();
    const link = page.getByRole("link", { name: "View organization highlights", exact: true });
    if (who === "member") await expect.element(link).toBeVisible();
    else await expect.element(link).not.toBeInTheDocument();
  },
);

for (const state of ["disabled", "idle", "failed"] as const) {
  test(`${state} highlights hide stale prose and sources while allowing manual refresh`, async () => {
    const server = await TestServer.start({ world: true });
    server.on("GET", orgApi, overview({ status: { state, generatedAt: null } }));
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
      .poll(() => server.requests.filter((request) => request.url.pathname === orgApi).length)
      .toBe(2);
  });
}

test("pending highlights poll within a bound, then offer a manual check and stop when ready", async () => {
  const server = await TestServer.start({ world: true });
  server.on("GET", orgApi, overview({ status: { state: "generating", generatedAt: null } }));
  const clock = controlPolling();
  const app = renderApp("/tracker/orbit/highlights");
  await expect
    .element(page.getByRole("button", { name: "Check for updates", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("article", { name: "Release highlights" }))
    .not.toBeInTheDocument();
  for (let tick = 1; tick <= 12; tick++) {
    await clock.tick();
    // A loaded CI host can take longer than poll's default second to deliver the request.
    await expect
      .poll(() => server.requests.filter((request) => request.url.pathname === orgApi).length, {
        timeout: 10_000,
      })
      .toBe(tick + 1);
    await expect.poll(() => app.router.state.revalidation).toBe("idle");
    await expect
      .element(page.getByRole("button", { name: "Check for updates", exact: true }))
      .toBeEnabled();
  }
  await expect.poll(() => app.router.state.revalidation).toBe("idle");
  const count = server.requests.filter((request) => request.url.pathname === orgApi).length;
  expect(count).toBe(13);
  await clock.tick(60_000);
  expect(server.requests.filter((request) => request.url.pathname === orgApi).length).toBe(count);
  server.on("GET", orgApi, overview());
  await page.getByRole("button", { name: "Check for updates", exact: true }).click();
  await expect.element(page.getByRole("article", { name: "Release highlights" })).toBeVisible();
  await expect
    .poll(() => server.requests.filter((request) => request.url.pathname === orgApi).length, {
      timeout: 10_000,
    })
    .toBe(count + 1);
  const readyCount = server.requests.filter((request) => request.url.pathname === orgApi).length;
  await clock.tick(60_000);
  expect(server.requests.filter((request) => request.url.pathname === orgApi).length).toBe(
    readyCount,
  );
});

test("an authorization failure removes prior highlights instead of retaining private text", async () => {
  const server = await TestServer.start({ world: true });
  server.on("GET", orgApi, overview());
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
  server.on("GET", orgApi, overview({ status: { state: "generating", generatedAt: null } }));
  const clock = controlPolling();
  renderApp("/tracker/orbit/highlights");
  await expect
    .element(page.getByRole("button", { name: "Check for updates", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("article", { name: "Release highlights" }))
    .not.toBeInTheDocument();
  server.on("GET", orgApi, overview());
  await clock.tick();
  await expect.element(page.getByRole("article", { name: "Release highlights" })).toBeVisible();
  await expect
    .poll(() => server.requests.filter((request) => request.url.pathname === orgApi).length)
    .toBe(2);
  const count = server.requests.filter((request) => request.url.pathname === orgApi).length;
  await clock.tick(60_000);
  expect(server.requests.filter((request) => request.url.pathname === orgApi).length).toBe(count);
});
