// The Needs you count belongs to one identity (lib/session.ts's access epoch):
// a read made before an account switch never reaches the next account, even
// when it answers after a navigation the new identity made.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { expect, onTestFinished, test, vi } from "vite-plus/test";
import { useNeedsYou } from "./needs-you.ts";
import { announceAccessChange } from "./session.ts";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

test("a count read for the previous identity is never shown to the next", async () => {
  let releaseA!: () => void;
  const heldA = new Promise<void>((resolve) => (releaseA = resolve));
  let switched = false;
  const summaries: string[] = [];
  const fetch = vi.spyOn(window, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.endsWith("/api/requests/summary")) return json({});
    summaries.push(switched ? "B" : "A");
    if (switched) return json({ forYou: 1, open: 1 });
    await heldA;
    return json({ forYou: 5, open: 5 });
  });
  onTestFinished(() => fetch.mockRestore());
  const shown: string[] = [];
  function Probe() {
    const summary = useNeedsYou(true);
    const text = summary ? String(summary.open) : "none";
    shown.push(text);
    return <output>{text}</output>;
  }
  const router = createMemoryRouter([{ path: "*", Component: Probe }], {
    initialEntries: ["/first"],
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  onTestFinished(() => {
    act(() => root.unmount());
    host.remove();
  });
  await act(async () => root.render(<RouterProvider router={router} />));
  try {
    await expect.poll(() => summaries).toContain("A");
    // A switches to B while A's read is on its way, and B moves on.
    switched = true;
    await act(async () => announceAccessChange());
    await act(async () => router.navigate("/second"));
    await expect.poll(() => host.textContent).toBe("1");
  } finally {
    releaseA();
  }
  await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
  expect(host.textContent).toBe("1");
  expect(shown).not.toContain("5");
  expect(summaries).toContain("B");
});
