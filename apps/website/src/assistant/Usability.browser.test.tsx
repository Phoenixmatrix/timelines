// Real Chat/Dock and app layout; only the agent transport is replaced. No AI,
// WebSocket, or write-tool execution is involved in these browser regressions.
import { act, useState } from "react";
import { expect, onTestFinished, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { PageContext } from "../../shared/assistant.ts";
import type { AssistantSkillSummary } from "../../shared/assistant-skills.ts";
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
const catalog: AssistantSkillSummary[] = [
  { id: "review", name: "review", description: "Inspect a change for defects", source: "builtin" },
  { id: "plan", name: "plan", description: "Break work into actionable steps", source: "personal" },
  { id: "quiet", name: "quiet", description: "", source: "repository" },
];

async function setup(
  width: number,
  height: number,
  approval = false,
  receipt = false,
  recovery = false,
  options: { fresh?: boolean; chatsReady?: Promise<void> } = {},
) {
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
  if (options.fresh) localStorage.removeItem("gm.assistant.chat");
  else localStorage.setItem("gm.assistant.chat", "usability-fixture");
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
                space: "orbit",
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
    : receipt
      ? [
          {
            id: "saved-answer",
            role: "assistant",
            parts: [
              { type: "data-skill", id: "skill-saved-user", data: catalog[1] },
              { type: "text", text: "Here is the saved plan." },
            ],
          },
        ]
      : [];
  await page.viewport(width, height);
  const server = await TestServer.start({ world: true });
  server.on("GET", "/api/assistant/chats", {
    chats: recovery
      ? [
          {
            id: "usability-fixture",
            title: "Content unavailable",
            source: "web",
            createdAt: "2026-10-11T00:00:00Z",
            updatedAt: "2026-10-11T00:00:00Z",
            expiresAt: null,
            contentUnavailable: true,
          },
        ]
      : [],
  });
  if (options.chatsReady)
    server.on("GET", "/api/assistant/chats", async () => {
      await options.chatsReady;
      return { chats: [] };
    });
  server.on("GET", "/api/assistant/skills", { skills: catalog });
  const app = renderApp("/tracker/orbit");
  if (!recovery) await expect.element(composer()).toBeEnabled();
  return { ...app, server };
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

test("a new conversation keeps slash completion when its delayed history arrives", async () => {
  let releaseHistory!: () => void;
  const history = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  try {
    await setup(1440, 900, false, false, false, {
      fresh: true,
      chatsReady: history,
    });
    await userEvent.fill(composer(), "/pl");
    const option = dock().getByRole("option", { name: /^\/plan/ });
    await expect.element(option).toBeVisible();
    await act(async () => releaseHistory());
    await expect.element(option).toBeVisible();
    await press("Tab");
    await expect.element(composer()).toHaveValue("/plan ");
    await expect.element(composer()).toHaveFocus();
  } finally {
    releaseHistory();
  }
});

test("a fresh conversation retains its first sent message while chat access history loads", async () => {
  let releaseHistory!: () => void;
  const history = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  try {
    await setup(1440, 900, false, false, false, {
      fresh: true,
      chatsReady: history,
    });
    const prompt = "Keep this first message while history finishes loading.";
    await userEvent.fill(composer(), prompt);
    await userEvent.click(dock().getByRole("button", { name: "Send", exact: true }));
    await expect
      .element(dock().getByRole("list", { name: "Conversation" }))
      .toHaveTextContent(prompt);
    await act(async () => releaseHistory());
    await expect
      .element(dock().getByRole("list", { name: "Conversation" }))
      .toHaveTextContent(prompt);
    await expect.element(composer()).toBeEnabled();
  } finally {
    releaseHistory();
  }
});

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

for (const theme of ["light", "dark"]) {
  test(`slash completion lists and filters names and descriptions in ${theme} at narrow width`, async () => {
    await setup(390, 640);
    const previous = document.documentElement.getAttribute("data-theme");
    document.documentElement.setAttribute("data-theme", theme);
    onTestFinished(() => {
      if (previous === null) document.documentElement.removeAttribute("data-theme");
      else document.documentElement.setAttribute("data-theme", previous);
    });
    await userEvent.fill(composer(), "/");
    const list = dock().getByRole("listbox", { name: "Assistant skills" });
    await expect.element(list).toBeVisible();
    await expect
      .element(list.getByRole("option", { name: "/review Inspect a change for defects" }))
      .toBeVisible();
    await expect.element(list.getByRole("option", { name: "/quiet No description" })).toBeVisible();
    await userEvent.fill(composer(), "/actionable");
    await expect
      .element(list.getByRole("option", { name: "/plan Break work into actionable steps" }))
      .toBeVisible();
    await expect.element(list.getByRole("option", { name: /^\/review/ })).not.toBeInTheDocument();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
    await press("Enter");
    await expect.element(composer()).toHaveValue("/plan ");
    await expect.element(composer()).toHaveFocus();
    await expect
      .element(dock().getByRole("list", { name: "Conversation" }))
      .not.toBeInTheDocument();
  });
}

test("arrows wrap, Tab completes without sending, and the chosen prefix survives collapse", async () => {
  await setup(1440, 900);
  await userEvent.fill(composer(), "/");
  const quiet = dock().getByRole("option", { name: "/quiet No description" });
  await expect.element(quiet).toBeVisible();
  await press("ArrowUp");
  await expect.element(quiet).toHaveAttribute("aria-selected", "true");
  await press("ArrowDown");
  await expect
    .element(dock().getByRole("option", { name: /^\/review/ }))
    .toHaveAttribute("aria-selected", "true");
  await press("ArrowDown");
  await press("Tab");
  await expect.element(composer()).toHaveValue("/plan ");
  await expect.element(composer()).toHaveFocus();
  await userEvent.click(dock().getByRole("button", { name: "Expand the assistant" }));
  await focusOn(composer());
  await press("Escape");
  await expect.element(composer()).toHaveValue("/plan ");
  await expect.element(dock().getByRole("list", { name: "Conversation" })).not.toBeInTheDocument();
});

test("pointer selection retains focus and preserves arguments when editing the leading token", async () => {
  await setup(1440, 900);
  await userEvent.fill(composer(), "/rev keep these arguments\nand this line");
  await press("Control+Home");
  for (let i = 0; i < 4; i++) await press("ArrowRight");
  expect((composer().element() as HTMLTextAreaElement).selectionStart).toBe(4);
  const option = dock().getByRole("option", { name: /^\/review/ });
  await expect.element(option).toBeVisible();
  await userEvent.click(option);
  await expect.element(composer()).toHaveValue("/review keep these arguments\nand this line");
  await expect.element(composer()).toHaveFocus();
  await userEvent.click(dock().getByRole("button", { name: "Send", exact: true }));
  await expect
    .element(dock().getByRole("list", { name: "Conversation" }))
    .toHaveTextContent("/review keep these arguments and this line");
});

test("Escape dismisses only the picker and unknown slash commands still send unchanged", async () => {
  await setup(1440, 900);
  await userEvent.click(dock().getByRole("button", { name: "Expand the assistant" }));
  await userEvent.fill(composer(), "/");
  await expect.element(dock().getByRole("listbox", { name: "Assistant skills" })).toBeVisible();
  await press("Escape");
  await expect
    .element(dock().getByRole("listbox", { name: "Assistant skills" }))
    .not.toBeInTheDocument();
  await expect
    .element(dock().getByRole("button", { name: "Collapse the assistant" }))
    .toBeVisible();
  await expect.element(composer()).toHaveValue("/");
  await expect.element(composer()).toHaveFocus();
  await userEvent.fill(composer(), "/unknown-command");
  await expect
    .element(dock().getByText("No matching skills. Send as a regular message."))
    .toBeVisible();
  await press("Enter");
  await expect
    .element(dock().getByRole("list", { name: "Conversation" }))
    .toHaveTextContent("/unknown-command");
  await expect.element(composer()).toHaveValue("");
});

test("IME confirmation never completes or sends; Shift+Enter remains multiline", async () => {
  await setup(1440, 900);
  await userEvent.fill(composer(), "/rev");
  await expect.element(dock().getByRole("option", { name: /^\/review/ })).toBeVisible();
  const field = composer().element() as HTMLTextAreaElement;
  field.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
  );
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true }));
  await expect.element(composer()).toHaveValue("/rev");
  await expect.element(dock().getByRole("list", { name: "Conversation" })).not.toBeInTheDocument();
  await press("Shift+Enter");
  await expect.element(composer()).toHaveValue("/rev\n");
  await expect
    .element(dock().getByRole("listbox", { name: "Assistant skills" }))
    .not.toBeInTheDocument();
});

test("a persisted skill receipt retains its name and accessible source when the chat reloads", async () => {
  const app = await setup(1440, 900, false, true);
  const conversation = () => dock().getByRole("list", { name: "Conversation" });
  await expect.element(conversation().getByText("Used /plan", { exact: true })).toBeVisible();
  await expect.element(conversation().getByText("Personal skill", { exact: true })).toBeVisible();
  app.unmount();
  renderApp("/tracker/orbit");
  await expect.element(conversation().getByText("Used /plan", { exact: true })).toBeVisible();
  await expect.element(conversation().getByText("Personal skill", { exact: true })).toBeVisible();
});

test("a skill with no description can be selected and sent as ordinary visible text", async () => {
  await setup(1440, 900);
  await userEvent.fill(composer(), "/quiet");
  await expect.element(dock().getByRole("option", { name: "/quiet No description" })).toBeVisible();
  await press("Enter");
  await expect.element(composer()).toHaveValue("/quiet ");
  await press("Enter");
  await expect
    .element(dock().getByRole("list", { name: "Conversation" }))
    .toHaveTextContent("/quiet");
  await expect.element(composer()).toHaveValue("");
});

test("refocusing the composer refreshes changed personal skill configuration", async () => {
  const { server } = await setup(1440, 900);
  await userEvent.fill(composer(), "/");
  await expect.element(dock().getByRole("option", { name: /^\/plan/ })).toBeVisible();
  server.on("GET", "/api/assistant/skills", {
    skills: [
      {
        id: "new",
        name: "new-skill",
        description: "Recently saved instructions",
        source: "personal",
      },
    ],
  });
  await focusOn(dock().getByRole("button", { name: "Send", exact: true }));
  await focusOn(composer());
  await expect
    .element(dock().getByRole("option", { name: "/new-skill Recently saved instructions" }))
    .toBeVisible();
  await expect.element(dock().getByRole("option", { name: /^\/plan/ })).not.toBeInTheDocument();
});

test("slashes in prose and command arguments do not open completion", async () => {
  await setup(1440, 900);
  for (const text of ["Please inspect /review", "/review inspect /plan"]) {
    await userEvent.fill(composer(), text);
    await expect
      .element(dock().getByRole("listbox", { name: "Assistant skills" }))
      .not.toBeInTheDocument();
    await expect.element(composer()).toHaveValue(text);
  }
});

test("unverifiable retained conversations expose neither a composer nor a download", async () => {
  await setup(1440, 900, false, false, true);
  await expect
    .element(dock().getByRole("region", { name: "Unavailable conversation" }))
    .toBeVisible();
  await expect.element(dock().getByRole("link")).not.toBeInTheDocument();
  await expect.element(composer()).not.toBeInTheDocument();
  expect(transport.sent).toHaveLength(0);
});
