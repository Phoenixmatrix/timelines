import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, onTestFinished, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { AgentPresence } from "../../shared/agent-presence.ts";
import { RecentAgents } from "./RecentAgents.tsx";
import "../styles/app.css";

function presence(name: string, lifetime = 600_000): AgentPresence {
  const now = Date.parse("2026-10-09T12:00:00Z");
  return {
    asOf: new Date(now).toISOString(),
    windowSeconds: 600,
    truncated: false,
    agents: [
      {
        id: name,
        name,
        accountable: { slug: "marco", displayName: "Marco" },
        lastSeenAt: new Date(now).toISOString(),
        expiresAt: new Date(now + lifetime).toISOString(),
      },
    ],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  // Keep real HTTP status semantics without waiting for a streamed body on frozen clocks.
  const response = new Response(null, { status });
  vi.spyOn(response, "json").mockResolvedValue(body);
  return response;
}

async function mount(endpoint: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const render = async (next: string) => {
    await act(async () => root.render(<RecentAgents endpoint={next} />));
  };
  // Register cleanup before rendering so failures cannot leak roots or fake clocks.
  onTestFinished(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  await render(endpoint);
  return render;
}

const region = () => page.getByRole("region", { name: "Agents seen recently" });
const agent = (name: string) => region().getByText(name, { exact: true });

test("resource changes clear names, abort old reads, and ignore late responses", async () => {
  let resolveOld!: (response: Response) => void;
  let oldSignal: AbortSignal | undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("source=old")) {
      oldSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        resolveOld = resolve;
      });
    }
    return jsonResponse(presence(url.includes("source=first") ? "first-agent" : "new-agent"));
  });
  const render = await mount("/repos/orbit/engine/commits/abc/presence?source=first");
  await expect.element(agent("first-agent")).toBeVisible();
  await render("/repos/orbit/engine/commits/abc/presence?source=old");
  expect(agent("first-agent").elements()).toHaveLength(0);
  expect(oldSignal).toBeDefined();
  await render("/repos/orbit/engine/commits/abc/presence?source=new");
  expect(oldSignal?.aborted).toBe(true);
  await expect.element(agent("new-agent")).toBeVisible();
  await act(async () => {
    resolveOld(jsonResponse(presence("stale-agent")));
  });
  expect(agent("stale-agent").elements()).toHaveLength(0);
  await expect.element(agent("new-agent")).toBeVisible();
  const row = agent("new-agent").element().closest("li");
  expect(row?.textContent).toContain("Marco");
  expect(row?.textContent).toContain("@marco");
  expect(row?.querySelector("time")?.dateTime).toBeTruthy();
});

test("a failed initial read recovers with the keyboard-accessible retry button", async () => {
  const requests = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(jsonResponse({ error: "Unavailable" }, 503))
    .mockResolvedValueOnce(jsonResponse(presence("recovered-agent")));
  await mount("/tracker/orbit/timelines/search/presence");
  const retry = region().getByRole("button", { name: "Retry", exact: true });
  await expect.element(retry).toBeEnabled();
  expect(region().getByRole("listitem").elements()).toHaveLength(0);
  await act(async () => {
    (retry.element() as HTMLButtonElement).focus();
    await userEvent.keyboard("{Enter}");
  });
  await expect.element(agent("recovered-agent")).toBeVisible();
  expect(requests).toHaveBeenCalledTimes(2);
  expect(retry.elements()).toHaveLength(0);
});

test("expired names disappear even when recurring refresh fails; polling pauses while hidden", async () => {
  // Advance expiry and monotonic snapshot age together; act drains resolved JSON/render work.
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    now: new Date("2026-10-09T12:00:00Z"),
  });
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const requests = vi
    .spyOn(globalThis, "fetch")
    .mockImplementationOnce(async () => jsonResponse(presence("watcher", 31_000)))
    .mockImplementation(async () => jsonResponse({ error: "Unavailable" }, 503));
  await mount("/repos/orbit/engine/ci/runs/7/presence");
  expect(agent("watcher").elements()).toHaveLength(1);
  expect(requests).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(requests).toHaveBeenCalledTimes(2);
  expect(region().getByRole("button", { name: "Retry", exact: true }).elements()).toHaveLength(1);
  expect(agent("watcher").elements()).toHaveLength(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(999);
  });
  expect(agent("watcher").elements()).toHaveLength(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(agent("watcher").elements()).toHaveLength(0);
  expect(region().getByRole("listitem").elements()).toHaveLength(0);
  expect(requests).toHaveBeenCalledTimes(2);
  visibility.mockReturnValue("hidden");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const beforeHidden = requests.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(requests.mock.calls.length).toBe(beforeHidden);
  visibility.mockReturnValue("visible");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(requests.mock.calls.length).toBe(beforeHidden + 1);
  expect(agent("watcher").elements()).toHaveLength(0);
});

test("wall clock rollback cannot prolong or revive presence when refresh fails", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    now: new Date("2026-10-09T12:00:00Z"),
  });
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const requests = vi
    .spyOn(globalThis, "fetch")
    .mockImplementationOnce(async () => jsonResponse(presence("watcher", 31_000)))
    .mockImplementation(async () => jsonResponse({ error: "Unavailable" }, 503));
  await mount("/repos/orbit/engine/ci/runs/7/presence");
  expect(agent("watcher").elements()).toHaveLength(1);
  expect(agent("watcher").element().closest("li")?.querySelector("time")?.dateTime).toBe(
    "2026-10-09T12:00:00.000Z",
  );

  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(requests).toHaveBeenCalledTimes(2);
  expect(region().getByRole("button", { name: "Retry", exact: true }).elements()).toHaveLength(1);
  vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(999);
  });
  expect(agent("watcher").elements()).toHaveLength(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(agent("watcher").elements()).toHaveLength(0);

  // Re-evaluating the expired snapshot on visibility changes must not resurrect it.
  vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
  visibility.mockReturnValue("hidden");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(agent("watcher").elements()).toHaveLength(0);
  visibility.mockReturnValue("visible");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(requests).toHaveBeenCalledTimes(3);
  expect(agent("watcher").elements()).toHaveLength(0);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(requests).toHaveBeenCalledTimes(4);
  expect(region().getByRole("listitem").elements()).toHaveLength(0);
});
