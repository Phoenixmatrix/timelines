// Real Chat/Dock and app layout; only the agent transport is replaced. No AI,
// WebSocket, or write-tool execution is involved in these browser regressions.
import { useState } from "react";
import { expect, onTestFinished, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { PageContext } from "../../shared/assistant.ts";
import { focusOn, press, pressUntil } from "../testing/focus.ts";
import { renderApp } from "../testing/render.tsx";
import { TestServer } from "../testing/server.ts";

const transport = vi.hoisted(() => ({
  messages: [] as { id: string; role: string; parts: Record<string, unknown>[] }[],
  sent: [] as { text: string; page: PageContext | null }[],
  decisions: [] as { id: string; approved: boolean }[],
}));

vi.mock("agents/react", () => ({ useAgent: () => ({ identified: true }) }));
vi.mock("@cloudflare/ai-chat/react", () => {
  return {
    useAgentChat: ({ body }: { body: () => { page: PageContext | null } }) => {
      const [messages, setMessages] = useState(transport.messages);
      return {
        messages,
        status: "ready",
        error: undefined,
        sendMessage: async ({ text }: { text: string }) => {
          transport.sent.push({ text, page: body().page });
          setMessages((current) => [
            ...current,
            { id: `user-${transport.sent.length}`, role: "user", parts: [{ type: "text", text }] },
          ]);
        },
        addToolApprovalResponse: (decision: { id: string; approved: boolean }) => {
          transport.decisions.push(decision);
          setMessages((current) =>
            current.map((message) => ({
              ...message,
              parts: message.parts.map((part) =>
                (part.approval as { id?: string } | undefined)?.id === decision.id
                  ? { ...part, state: "approval-responded", approval: decision }
                  : part,
              ),
            })),
          );
        },
        stop: async () => {},
        regenerate: async () => {},
      };
    },
  };
});

const dock = () => page.getByRole("complementary", { name: "Assistant", exact: true });
const composer = () => dock().getByRole("textbox", { name: "Message the assistant" });
const finalMarker = "Review ends here: preserve the final acceptance criterion.";
const longDraft = Array.from({ length: 50 }, (_, i) => `Unsent draft line ${i + 1}`).join("\n");

async function setup(width: number, height: number, approval = false) {
  const previous = ["gm.assistant.open", "gm.assistant.chat"].map(
    (key) => [key, localStorage.getItem(key)] as const,
  );
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  onTestFinished(async () => {
    for (const [key, value] of previous) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
    await page.viewport(viewport.width, viewport.height);
  });
  localStorage.setItem("gm.assistant.open", "1");
  localStorage.setItem("gm.assistant.chat", "usability-fixture");
  transport.sent.length = 0;
  transport.decisions.length = 0;
  transport.messages = approval
    ? [
        {
          id: "proposal",
          role: "assistant",
          parts: [
            {
              type: "tool-create_issue",
              toolCallId: "create-fixture",
              state: "approval-requested",
              approval: { id: "review-fixture" },
              input: {
                owner: "orbit",
                team: "ENG",
                title: "Review the complete proposal",
                description: [
                  ...Array.from(
                    { length: 40 },
                    (_, i) =>
                      `### Requirement ${i + 1}\n\nKeep the complete proposal readable before deciding. This paragraph must wrap within the assistant, not widen the page.`,
                  ),
                  finalMarker,
                ].join("\n\n"),
              },
            },
          ],
        },
      ]
    : [];
  await page.viewport(width, height);
  const server = await TestServer.start({ world: true });
  server.on("GET", "/api/assistant/chats", { chats: [] });
  const app = renderApp("/tracker/orbit");
  await expect.element(composer()).toBeEnabled();
  return app;
}

function box(element: Element) {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
}

// Visibility matchers do not account for overflow clipping. Hit-testing the
// center proves the person can actually see/reach the item after scrolling.
function reachable(element: Element) {
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(x, y);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    x >= 0 &&
    x < innerWidth &&
    y >= 0 &&
    y < innerHeight &&
    !!hit &&
    element.contains(hit)
  );
}

for (const [width, height] of [
  [1440, 540],
  [1440, 1000],
  [1024, 540],
]) {
  test(`expanding overlays rather than moving the page and preserves the draft at ${width}×${height}`, async () => {
    const app = await setup(width!, height!);
    await userEvent.fill(composer(), "Keep this unsent draft across expansion.");
    const main = app.container.querySelector("main")!;
    expect(main).not.toBeNull();
    const before = box(main);
    const narrow = box(dock().element());
    await userEvent.click(dock().getByRole("button", { name: "Expand the assistant" }));
    await expect
      .poll(() => dock().element().getBoundingClientRect().width)
      .toBeGreaterThan(narrow.width);
    expect(box(main)).toEqual(before);
    await expect.element(composer()).toHaveValue("Keep this unsent draft across expansion.");
    await focusOn(composer());
    await press("Escape");
    await expect.poll(() => box(dock().element()).width).toBeCloseTo(narrow.width, 2);
    expect(box(main)).toEqual(before);
    await expect.element(composer()).toHaveValue("Keep this unsent draft across expansion.");
    expect(transport.sent).toEqual([]);
  });
}

test("keyboard removal and re-inclusion change only the next message's context", async () => {
  await setup(1440, 900);
  await userEvent.fill(composer(), "First message with page context");
  await press("Enter");
  await expect.poll(() => transport.sent.length).toBe(1);
  expect(transport.sent[0]?.page).toMatchObject({ path: "/tracker/orbit", tracker: "orbit" });
  await focusOn(composer());
  await pressUntil(
    "Shift+Tab",
    (focus) => focus.role === "button" && focus.name.startsWith("Remove "),
    "remove page context",
  );
  await press("Enter");
  await expect.element(dock().getByRole("button", { name: /^Include .* context/ })).toHaveFocus();
  await userEvent.fill(composer(), "Second message without page context");
  await press("Enter");
  await expect.poll(() => transport.sent.length).toBe(2);
  expect(transport.sent[1]?.page).toBeNull();
  await focusOn(composer());
  await pressUntil(
    "Shift+Tab",
    (focus) => focus.role === "button" && focus.name.startsWith("Include "),
    "include page context",
  );
  await press("Enter");
  await expect.element(dock().getByRole("button", { name: /^Remove .* context/ })).toHaveFocus();
  await userEvent.fill(composer(), "Third message with page context restored");
  await press("Enter");
  await expect.poll(() => transport.sent.length).toBe(3);
  expect(transport.sent.map((message) => message.page?.path ?? null)).toEqual([
    "/tracker/orbit",
    null,
    "/tracker/orbit",
  ]);
  await expect
    .element(dock().getByText("First message with page context", { exact: true }))
    .toBeVisible();
});

for (const [width, height] of [
  [1440, 360],
  [390, 360],
  [1440, 1000],
]) {
  for (const approved of [true, false]) {
    test(`a long draft leaves the entire approval and ${approved ? "Approve" : "Decline"} reachable at ${width}×${height}`, async () => {
      await setup(width!, height!, true);
      await userEvent.fill(composer(), longDraft);
      const field = composer().element() as HTMLTextAreaElement;
      expect(field.scrollHeight).toBeGreaterThan(field.clientHeight);
      expect(reachable(field)).toBe(true);
      if (width! < 640) {
        expect(box(dock().element()).width).toBe(innerWidth);
        await expect
          .element(dock().getByRole("button", { name: "Expand the assistant" }))
          .not.toBeInTheDocument();
      }
      const showAll = dock().getByRole("button", { name: "Show all", exact: true });
      await userEvent.click(showAll);
      const marker = dock().getByText(finalMarker, { exact: true });
      (marker.element() as HTMLElement).scrollIntoView({ block: "center" });
      await expect.poll(() => reachable(marker.element())).toBe(true);
      for (const name of ["Approve", "Decline"]) {
        const action = dock().getByRole("button", { name, exact: true });
        await focusOn(action);
        await expect.poll(() => reachable(action.element())).toBe(true);
      }
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
      await expect.element(composer()).toHaveValue(longDraft);
      await focusOn(
        dock().getByRole("button", { name: approved ? "Approve" : "Decline", exact: true }),
      );
      await press("Enter");
      await expect.poll(() => transport.decisions).toEqual([{ id: "review-fixture", approved }]);
      await expect
        .element(dock().getByRole("button", { name: "Approve", exact: true }))
        .not.toBeInTheDocument();
      await expect.element(composer()).toHaveValue(longDraft);
      expect(transport.sent).toEqual([]);
    });
  }
}
