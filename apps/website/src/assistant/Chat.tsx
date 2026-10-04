// One conversation: the live connection to its Durable Object, the transcript
// and the composer. Loaded lazily the first time the assistant opens.

import { useAgentChat } from "@cloudflare/ai-chat/react";
import { ArrowUpIcon, PlusIcon, StopIcon, XIcon } from "@phosphor-icons/react";
import { useAgent } from "agents/react";
import {
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useNavigate, useRevalidator } from "react-router";
import { WRITE_TOOLS, type PageContext } from "../../shared/assistant.ts";
import { Tip } from "../components/ui.tsx";
import { contextLabel } from "./page.ts";
import {
  ApprovalCard,
  ChatMarkdown,
  Receipts,
  StatusLine,
  toolName,
  type ToolPart,
} from "./parts.tsx";
import { useAssistant } from "./state.tsx";
import { suggestionsFor } from "./suggestions.ts";
import { waitingFor } from "./waiting.ts";

const STALL_MS = 300;

interface Part {
  type: string;
  text?: string;
}
interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  parts: Part[];
}

const isTool = (part: Part) => part.type.startsWith("tool-") && "toolCallId" in part;

/** An assistant message as blocks: prose, runs of receipts, approval cards. */
function blocks(message: Message) {
  const out: (
    | { kind: "text"; text: string; key: string }
    | { kind: "tools"; parts: ToolPart[]; key: string }
    | { kind: "approval"; part: ToolPart; key: string }
  )[] = [];
  message.parts.forEach((part, i) => {
    if (part.type === "text" && part.text?.trim()) {
      out.push({ kind: "text", text: part.text, key: `${message.id}-${i}` });
    } else if (isTool(part)) {
      const tool = part as unknown as ToolPart;
      if (tool.state === "approval-requested") {
        out.push({ kind: "approval", part: tool, key: tool.toolCallId });
        return;
      }
      const last = out[out.length - 1];
      if (last?.kind === "tools") last.parts.push(tool);
      else out.push({ kind: "tools", parts: [tool], key: tool.toolCallId });
    }
  });
  return out;
}

export default function Chat({
  chatId,
  fresh,
  page,
  compact,
  onTurnEnd,
}: {
  chatId: string;
  fresh: boolean;
  page: PageContext;
  /** On a phone the chat covers the page: navigating closes it. */
  compact: boolean;
  onTurnEnd: () => void;
}) {
  const assistant = useAssistant();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [status, setStatus] = useState<string | null>(null);
  // Kept per conversation, so starting or opening another doesn't lose it.
  const [draft, setDraftState] = useState(() => assistant.draftFor(chatId));
  const setDraft = (text: string) => {
    setDraftState(text);
    assistant.saveDraft(chatId, text);
  };
  const [withPage, setWithPage] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const redirectedApprovals = useRef(new Set<string>());

  const agent = useAgent({ agent: "assistant", basePath: `api/assistant/chats/${chatId}/agent` });
  const chat = useAgentChat({
    agent,
    getInitialMessages: fresh ? null : undefined,
    // AI SDK 7 resumes reconnects from an empty response unless a tool is still
    // input-streaming. Submit approvals with their existing message instead.
    autoContinueAfterToolResult: false,
    sendAutomaticallyWhen: (state) => {
      const parts = state.messages.at(-1)?.parts ?? [];
      const lastStep = parts.findLastIndex((part) => part.type === "step-start");
      if (lastAssistantMessageIsCompleteWithApprovalResponses(state))
        return parts.some(
          (part, index) =>
            index > lastStep &&
            isToolUIPart(part) &&
            part.state === "approval-responded" &&
            !redirectedApprovals.current.has(part.approval.id),
        );
      // Only browser tools need another client submission; server-only batches
      // must still stop at the orchestrator's step budget.
      return (
        parts.some((part, index) => index > lastStep && part.type === "tool-navigate") &&
        lastAssistantMessageIsCompleteWithToolCalls(state)
      );
    },
    body: () => ({ page: withPage ? page : null }),
    onData: (part: { type: string; data?: unknown }) => {
      if (part.type === "data-status") setStatus((part.data as { text: string }).text);
    },
    onToolCall: ({ toolCall, addToolOutput }) => {
      if (toolCall.toolName !== "navigate") return;
      const target = (toolCall.input as { path?: unknown }).path;
      const path = typeof target === "string" ? target : "/";
      void navigate(path);
      if (compact) assistant.hide();
      addToolOutput({ toolCallId: toolCall.toolCallId, output: { opened: path } });
    },
    onTurnEnd: () => {
      setStatus(null);
      onTurnEnd();
    },
  });
  const messages = chat.messages as unknown as Message[];
  const busy = chat.status === "submitted" || chat.status === "streaming";

  // The page behind the chat refreshes once a write the person approved lands.
  const settledWrites = useMemo(
    () =>
      messages.flatMap((m) =>
        m.parts.filter(
          (p) =>
            isTool(p) &&
            (WRITE_TOOLS as readonly string[]).includes(toolName(p as unknown as ToolPart)) &&
            (p as unknown as ToolPart).state === "output-available",
        ),
      ).length,
    [messages],
  );
  const seenWrites = useRef(settledWrites);
  useEffect(() => {
    if (settledWrites > seenWrites.current) void revalidator.revalidate();
    seenWrites.current = settledWrites;
  }, [settledWrites, revalidator]);

  // Stay at the newest message unless the person scrolled up to read. Before
  // paint, so an opened conversation never shows its top for a frame first.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  const pending = messages
    .flatMap((m) => m.parts)
    .filter(
      (p) => isTool(p) && (p as unknown as ToolPart).state === "approval-requested",
    ) as unknown as ToolPart[];

  const send = (text: string) => {
    const prompt = text.trim();
    if (!prompt) return;
    // The replacement prompt owns the request; don't also submit its denials.
    for (const part of pending) {
      if (!part.approval) continue;
      redirectedApprovals.current.add(part.approval.id);
      chat.addToolApprovalResponse({ id: part.approval.id, approved: false });
    }
    setStatus("Thinking");
    void chat.sendMessage({ text: prompt });
    assistant.sent();
    setDraft("");
    pinned.current = true;
  };

  // A prompt queued for this chat from elsewhere (a suggestion, the palette's
  // Ask), taken only once this chat's own connection is up: a message sent
  // before that, or into a connection a remount tears down, would be lost.
  useEffect(() => {
    if (!agent.identified) return;
    const queued = assistant.takeQueued(chatId);
    if (queued) send(queued);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistant.queued, agent.identified]);

  useEffect(() => input.current?.focus(), [chatId]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy && !draft.trim()) void chat.stop();
    else send(draft);
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send(draft);
    }
  };

  const last = messages[messages.length - 1];
  const wait = waitingFor(messages, busy);
  // Between steps, a moment's pause (text ending before a tool call starts)
  // shouldn't flash the line; a real wait shows it, at first in generic words.
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (wait !== "step") return setStalled(false);
    setStatus(null);
    const timer = setTimeout(() => setStalled(true), STALL_MS);
    return () => clearTimeout(timer);
  }, [wait]);
  const waiting = wait === "start" || (wait === "step" && stalled);
  const closeIfCompact = compact ? () => assistant.hide() : undefined;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div
        ref={scroller}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 [overflow-wrap:anywhere]"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {messages.length === 0 && !busy ? (
          // A saved conversation renders empty for a moment while its messages
          // load: show nothing rather than flash the welcome.
          fresh ? (
            <Welcome page={page} onPick={send} />
          ) : (
            <div aria-busy="true" />
          )
        ) : (
          <ol className="m-0 flex list-none flex-col gap-5 p-0" aria-label="Conversation">
            {messages.map((message) =>
              message.role === "user" ? (
                <li
                  key={message.id}
                  className="ml-8 self-end rounded-pane bg-raised px-3 py-2 text-body whitespace-pre-wrap"
                >
                  {message.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}
                </li>
              ) : (
                <li key={message.id} className="flex flex-col gap-3">
                  {blocks(message).map((block) =>
                    block.kind === "text" ? (
                      <ChatMarkdown
                        key={block.key}
                        text={busy && message === last ? settle(block.text) : block.text}
                        onNavigate={closeIfCompact}
                      />
                    ) : block.kind === "tools" ? (
                      <Receipts key={block.key} parts={block.parts} onNavigate={closeIfCompact} />
                    ) : (
                      <ApprovalCard
                        key={block.key}
                        part={block.part}
                        onDecide={(approved) =>
                          block.part.approval &&
                          chat.addToolApprovalResponse({ id: block.part.approval.id, approved })
                        }
                      />
                    ),
                  )}
                </li>
              ),
            )}
            {waiting && (
              <li>
                <StatusLine text={status ?? "Thinking"} />
              </li>
            )}
            {chat.error && !busy && (
              <li className="flex items-center gap-3 text-body-sm text-danger-text" role="alert">
                The assistant couldn't answer that.
                <button
                  type="button"
                  className="mk-btn mk-btn--ghost mk-btn--sm"
                  onClick={() => void chat.regenerate()}
                >
                  Try again
                </button>
              </li>
            )}
          </ol>
        )}
      </div>

      <Composer
        page={page}
        withPage={withPage}
        onWithPage={setWithPage}
        onSubmit={submit}
        field={
          <textarea
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            rows={1}
            placeholder={pending.length ? "Or say what to do instead…" : placeholder(page)}
            aria-label="Message the assistant"
            className={fieldClass}
          />
        }
        stop={busy && !draft.trim()}
        canSend={busy || !!draft.trim()}
      />
    </div>
  );
}

const fieldClass =
  "max-h-[min(12rem,25dvh)] min-h-9 min-w-0 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-2 py-1.5 text-body text-ink outline-none [field-sizing:content] placeholder:text-ink-faint";

/** The page-context chip and the message box, shared by the chat and its placeholder. */
function Composer({
  page,
  withPage,
  onWithPage,
  onSubmit,
  field,
  stop,
  canSend,
}: {
  page: PageContext;
  withPage: boolean;
  onWithPage?: (next: boolean) => void;
  onSubmit?: (event: FormEvent) => void;
  field: ReactNode;
  stop: boolean;
  canSend: boolean;
}) {
  const pageLabel = contextLabel(page);
  const contextAction = withPage
    ? `Remove ${pageLabel} from context for your next message. Earlier messages are unchanged.`
    : `Include ${pageLabel} as context with your next message.`;
  return (
    <form
      onSubmit={onSubmit}
      className="flex max-h-[50%] min-h-0 shrink-0 flex-col gap-2 overflow-y-auto overscroll-contain px-3 pt-1 pb-3"
    >
      {pageLabel && (
        <div className="flex shrink-0 items-center gap-2 text-micro text-ink-muted">
          <span className="shrink-0">{withPage ? "In context:" : "Not in context:"}</span>
          <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-raised pr-1 pl-2.5">
            <span className="truncate" title={page.path}>
              {pageLabel}
            </span>
            <Tip label={contextAction}>
              <button
                type="button"
                className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-ink-muted hover:bg-pressed hover:text-ink max-sm:size-11"
                aria-label={contextAction}
                disabled={!onWithPage}
                onClick={() => onWithPage?.(!withPage)}
              >
                {withPage ? (
                  <XIcon className="size-3" weight="bold" aria-hidden />
                ) : (
                  <PlusIcon className="size-3" weight="bold" aria-hidden />
                )}
              </button>
            </Tip>
          </span>
          <span className="sr-only" role="status">
            {withPage
              ? `${pageLabel} will be included as context with your next message.`
              : `${pageLabel} will not be included as context with your next message. Earlier messages are unchanged.`}
          </span>
        </div>
      )}
      <div className="flex shrink-0 items-end gap-2 rounded-control bg-sunken p-1.5 shadow-[0_0_0_1px_var(--line-soft)] focus-within:bg-rail focus-within:shadow-[0_0_0_2px_var(--signal-line)]">
        {field}
        <button
          type="submit"
          className="mk-btn mk-btn--sm size-9 shrink-0 p-0 max-sm:size-11"
          aria-label={stop ? "Stop" : "Send"}
          disabled={!canSend}
        >
          {stop ? (
            <StopIcon weight="fill" className="size-4" aria-hidden />
          ) : (
            <ArrowUpIcon weight="bold" className="size-4" aria-hidden />
          )}
        </button>
      </div>
    </form>
  );
}

/**
 * What the dock shows while a conversation connects and loads: the same
 * layout as the chat, so the composer doesn't vanish and come back.
 */
export function ChatPlaceholder({ page }: { page: PageContext }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1" aria-busy="true" />
      <Composer
        page={page}
        withPage
        field={
          <textarea
            rows={1}
            disabled
            placeholder={placeholder(page)}
            aria-label="Message the assistant"
            className={fieldClass}
          />
        }
        stop={false}
        canSend={false}
      />
    </div>
  );
}

/** Streaming text with a link still arriving shows its words, not half its Markdown. */
function settle(text: string): string {
  return text.replace(/\[([^\]]*)\]\([^)]*$/, "$1").replace(/\[([^\]]*)$/, "$1");
}

function placeholder(page: PageContext): string {
  if (page.issue) return `Ask about ${page.issue}…`;
  if (page.run) return `Ask about run #${page.run}…`;
  if (page.file) return "Ask about this file…";
  if (page.repo) return `Ask about ${page.repo.split("/")[1]}…`;
  return "Ask anything about your work…";
}

function Welcome({ page, onPick }: { page: PageContext; onPick: (prompt: string) => void }) {
  return (
    <div className="flex flex-col gap-4 pt-2">
      <div>
        <h2 className="m-0 text-title">Ask Gitmatrix</h2>
        <p className="mt-1 mb-0 max-w-[40ch] text-body-sm text-ink-muted">
          I read code, issues, CI runs and packages, open pages for you, and make changes once you
          approve each one.
        </p>
      </div>
      <ul className="m-0 flex list-none flex-col p-0" aria-label="Suggestions">
        {suggestionsFor(page).map((prompt) => (
          <li key={prompt}>
            <button
              type="button"
              onClick={() => onPick(prompt)}
              className="-mx-2 flex min-h-10 w-[calc(100%+1rem)] cursor-pointer items-center rounded-plate border-0 bg-transparent px-2 text-left text-body-sm text-ink-muted hover:bg-raised hover:text-ink max-sm:min-h-11"
            >
              {prompt}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
