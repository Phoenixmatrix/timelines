import { expect, onTestFinished, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type {
  ReleaseHighlights,
  ReleaseNotesIndex,
  ReleaseNotesRelease,
} from "../../shared/release-notes.ts";
import { focusOn, press } from "../testing/focus.ts";
import { renderApp } from "../testing/render.tsx";
import { reply, TestServer } from "../testing/server.ts";

const siteApi = "/api/release-notes/highlights";
const note = { repo: { owner: "orbit", name: "highlights-engine" }, release: "@day:2026-09-20" };
function overview(overrides: Partial<ReleaseHighlights> = {}): ReleaseHighlights {
  return {
    scope: "site",
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

for (const scope of ["site", "tracker", "repo"] as const) {
  test(`${scope} highlights use the matching API and exact daily-note backlinks`, async () => {
    const server = await TestServer.start({ world: true });
    await server.repo("orbit", "highlights-engine");
    const path =
      scope === "site"
        ? "/highlights"
        : scope === "tracker"
          ? "/tracker/orbit/highlights"
          : "/orbit/highlights-engine/releases/highlights";
    const endpoint =
      scope === "site"
        ? siteApi
        : scope === "tracker"
          ? "/api/tracker/orbit/release-notes/highlights"
          : "/api/repos/orbit/highlights-engine/release-notes/highlights";
    server.on(
      "GET",
      endpoint,
      overview({
        scope,
        ...(scope === "tracker" ? { owner: { slug: "orbit", displayName: "Orbit" } } : {}),
        ...(scope === "repo" ? { repo: note.repo } : {}),
      }),
    );
    const app = renderApp(path);
    await expect
      .element(page.getByRole("heading", { name: "Highlights", exact: true }))
      .toBeVisible();
    await expect.element(page.getByRole("article", { name: "Release highlights" })).toBeVisible();
    expect(app.container.querySelector("article")?.textContent).toContain(
      "<img src=x onerror=alert(1)>",
    );
    expect(app.container.querySelector("article img")).toBeNull();
    expect(server.requests.some((request) => request.url.pathname === endpoint)).toBe(true);
    const highlightsRequest = vi
      .mocked(window.fetch)
      .mock.calls.find(([input]) => input === endpoint);
    expect(highlightsRequest?.[1]?.cache).toBe("no-store");
    expect(new Headers(highlightsRequest?.[1]?.headers).get("Cache-Control")).toBe(
      "private, no-store",
    );
    await expect
      .poll(() => document.title)
      .toContain(
        scope === "repo"
          ? "orbit/highlights-engine"
          : scope === "tracker"
            ? "Orbit"
            : "Your repositories",
      );
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

test("Highlights is discoverable from the rail and detailed release-note pages", async () => {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "highlights-engine");
  server.on("GET", siteApi, overview());
  server.on(
    "GET",
    "/api/tracker/orbit/release-notes/highlights",
    overview({ scope: "tracker", owner: { slug: "orbit", displayName: "Orbit" } }),
  );
  server.on(
    "GET",
    "/api/repos/orbit/highlights-engine/release-notes/highlights",
    overview({ scope: "repo", repo: note.repo }),
  );
  // The browser world's API subset has no repository release-notes route.
  server.on("GET", "/api/repos/orbit/highlights-engine/release-notes", {
    releases: [],
    status: { state: "ready", generatedAt: null },
  } satisfies ReleaseNotesIndex);
  const app = renderApp("/tracker/orbit/releases");
  await page.getByRole("link", { name: "View highlights", exact: true }).click();
  await app.waitForUrl((url) => url.pathname === "/tracker/orbit/highlights");
  await page
    .getByRole("navigation", { name: "Places" })
    .getByRole("link", { name: "Highlights", exact: true })
    .click();
  await app.waitForUrl((url) => url.pathname === "/highlights");
  await app.navigate("/orbit/highlights-engine/releases");
  await expect.element(page.getByText(/No daily updates are available yet/)).toBeVisible();
  await page.getByRole("link", { name: "View highlights", exact: true }).click();
  await app.waitForUrl((url) => url.pathname === "/orbit/highlights-engine/releases/highlights");
  await page.getByRole("link", { name: "Browse detailed notes", exact: true }).click();
  await app.waitForUrl((url) => url.pathname === "/orbit/highlights-engine/releases");
});

for (const state of ["disabled", "ready"] as const) {
  test(`repository ${state === "disabled" ? "disabled notes" : "detailed notes"} link to highlights`, async () => {
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
    server.on(
      "GET",
      "/api/repos/orbit/highlights-engine/release-notes/highlights",
      overview({
        scope: "repo",
        repo: note.repo,
      }),
    );
    const app = renderApp("/orbit/highlights-engine/releases");
    await expect
      .element(
        page.getByText(
          state === "disabled" ? "AI writing is off in this environment." : release.release.intro!,
          { exact: true },
        ),
      )
      .toBeVisible();
    const link = page.getByRole("link", { name: "View highlights", exact: true });
    await expect
      .element(link)
      .toHaveAttribute("href", "/orbit/highlights-engine/releases/highlights");
    await link.click();
    await app.waitForUrl((url) => url.pathname === "/orbit/highlights-engine/releases/highlights");
    await expect.element(page.getByRole("article", { name: "Release highlights" })).toBeVisible();
  });
}

for (const state of ["disabled", "idle", "failed"] as const) {
  test(`${state} highlights hide stale prose and sources while allowing manual refresh`, async () => {
    const server = await TestServer.start({ world: true });
    server.on("GET", siteApi, overview({ status: { state, generatedAt: null } }));
    renderApp("/highlights");
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
      .poll(() => server.requests.filter((request) => request.url.pathname === siteApi).length)
      .toBe(2);
  });
}

test("pending highlights poll within a bound, then offer a manual check and stop when ready", async () => {
  const server = await TestServer.start({ world: true });
  server.on("GET", siteApi, overview({ status: { state: "generating", generatedAt: null } }));
  const clock = controlPolling();
  const app = renderApp("/highlights");
  await expect
    .element(page.getByRole("button", { name: "Check for updates", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("article", { name: "Release highlights" }))
    .not.toBeInTheDocument();
  for (let tick = 1; tick <= 12; tick++) {
    await clock.tick();
    await expect
      .poll(() => server.requests.filter((request) => request.url.pathname === siteApi).length)
      .toBe(tick + 1);
    await expect.poll(() => app.router.state.revalidation).toBe("idle");
    await expect
      .element(page.getByRole("button", { name: "Check for updates", exact: true }))
      .toBeEnabled();
  }
  await expect.poll(() => app.router.state.revalidation).toBe("idle");
  const count = server.requests.filter((request) => request.url.pathname === siteApi).length;
  expect(count).toBe(13);
  await clock.tick(60_000);
  expect(server.requests.filter((request) => request.url.pathname === siteApi).length).toBe(count);
  server.on("GET", siteApi, overview());
  await page.getByRole("button", { name: "Check for updates", exact: true }).click();
  await expect.element(page.getByRole("article", { name: "Release highlights" })).toBeVisible();
  await expect
    .poll(() => server.requests.filter((request) => request.url.pathname === siteApi).length)
    .toBe(count + 1);
  const readyCount = server.requests.filter((request) => request.url.pathname === siteApi).length;
  await clock.tick(60_000);
  expect(server.requests.filter((request) => request.url.pathname === siteApi).length).toBe(
    readyCount,
  );
});

test("an authorization failure removes prior highlights instead of retaining private text", async () => {
  const server = await TestServer.start({ world: true });
  server.on("GET", siteApi, overview());
  const app = renderApp("/highlights");
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
  server.on("GET", siteApi, overview({ status: { state: "generating", generatedAt: null } }));
  const clock = controlPolling();
  renderApp("/highlights");
  await expect
    .element(page.getByRole("button", { name: "Check for updates", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("article", { name: "Release highlights" }))
    .not.toBeInTheDocument();
  server.on("GET", siteApi, overview());
  await clock.tick();
  await expect.element(page.getByRole("article", { name: "Release highlights" })).toBeVisible();
  await expect
    .poll(() => server.requests.filter((request) => request.url.pathname === siteApi).length)
    .toBe(2);
  const count = server.requests.filter((request) => request.url.pathname === siteApi).length;
  await clock.tick(60_000);
  expect(server.requests.filter((request) => request.url.pathname === siteApi).length).toBe(count);
});
