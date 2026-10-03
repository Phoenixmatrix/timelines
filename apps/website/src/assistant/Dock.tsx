// The assistant's column. From 1280px it docks beside the page, which reflows
// and stays usable (the assistant opens pages there for you); narrower, it
// floats over the right edge; on phones it takes the screen.

import { Popover } from "@base-ui/react/popover";
import { ClockCounterClockwiseIcon, NotePencilIcon, TrashIcon, XIcon } from "@phosphor-icons/react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { AssistantChat } from "../../shared/assistant.ts";
import { popMotion, Tip } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { timeAgo } from "../lib/format.ts";
import { usePageContext } from "./page.ts";
import { useAssistant } from "./state.tsx";

let loaded: typeof import("./Chat.tsx") | null = null;
const loadChat = () => import("./Chat.tsx").then((module) => (loaded = module));
const LazyChat = lazy(loadChat);

/**
 * Fetch the chat's code before it's asked for (idle time, or a hover on the
 * button), so opening the assistant shows the conversation at once instead of
 * an empty column that fills in a moment later.
 */
export function preloadAssistant() {
  void loadChat().catch(() => {});
}

function useMedia(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const change = () => setMatches(list.matches);
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, [query]);
  return matches;
}

const iconButton = "mk-btn mk-btn--ghost mk-btn--sm size-8 p-0 max-sm:size-11 [&_svg]:size-[18px]";

export function AssistantDock() {
  const assistant = useAssistant();
  const page = usePageContext();
  const phone = useMedia("(max-width: 639px)");
  const docked = useMedia("(min-width: 1280px)");
  const [chats, setChats] = useState<AssistantChat[] | null>(null);

  const refresh = useCallback(() => {
    api<{ chats: AssistantChat[] }>("/assistant/chats")
      .then((r) => setChats(r.chats))
      .catch(() => setChats((c) => c ?? []));
  }, []);
  useEffect(() => {
    if (assistant.open) refresh();
  }, [assistant.open, refresh]);

  // Escape steps out: closes the floating panel (a docked one stays put).
  useEffect(() => {
    if (!assistant.open || docked) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) assistant.hide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [assistant, docked]);

  // Load the chat's code while the browser is idle, ready for the first open.
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((run: () => void) => setTimeout(run, 1500));
    const cancel = window.cancelIdleCallback ?? clearTimeout;
    const handle = idle(preloadAssistant);
    return () => cancel(handle as number);
  }, []);

  if (!assistant.open) return null;
  // Once preloaded, render it directly: even a resolved lazy() waits a frame.
  const Chat = loaded?.default ?? LazyChat;
  const current = chats?.find((c) => c.id === assistant.chatId);
  const title = assistant.fresh ? "New conversation" : current?.title || "Conversation";

  return (
    <aside
      aria-label="Assistant"
      // Docked, it's part of the layout: it fades in rather than sliding, since
      // a slide would push it past the window and flash a horizontal scrollbar.
      data-docked={docked ? "" : undefined}
      className={[
        "gm-dock flex flex-col bg-pane",
        docked
          ? "sticky top-0 h-dvh w-[26rem] shrink-0"
          : phone
            ? "fixed inset-0 z-40"
            : "fixed inset-y-0 right-0 z-40 w-[min(26rem,100vw)] shadow-[var(--shadow-float),0_0_0_1px_var(--line-soft)]",
      ].join(" ")}
    >
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-line-soft pr-2 pl-4">
        <h2 className="m-0 min-w-0 flex-1 truncate text-body font-semibold" title={title}>
          {title}
        </h2>
        <History
          chats={chats}
          current={assistant.chatId}
          onPick={(id) => assistant.openChat(id)}
          onDelete={async (id) => {
            await api(`/assistant/chats/${id}`, { method: "DELETE" });
            if (id === assistant.chatId) assistant.newChat();
            refresh();
          }}
        />
        <Tip label="New conversation" side="bottom">
          <button
            type="button"
            className={iconButton}
            aria-label="New conversation"
            onClick={() => assistant.newChat()}
          >
            <NotePencilIcon aria-hidden />
          </button>
        </Tip>
        <Tip label="Close (⌘J)" side="bottom">
          <button
            type="button"
            className={iconButton}
            aria-label="Close the assistant"
            onClick={() => assistant.hide()}
          >
            <XIcon aria-hidden />
          </button>
        </Tip>
      </header>
      <Suspense
        fallback={
          loaded ? (
            <loaded.ChatPlaceholder page={page} />
          ) : (
            <div className="flex-1" aria-busy="true" />
          )
        }
      >
        <Chat
          key={assistant.chatId}
          chatId={assistant.chatId}
          fresh={assistant.fresh}
          page={page}
          compact={phone}
          onTurnEnd={refresh}
        />
      </Suspense>
    </aside>
  );
}

function History({
  chats,
  current,
  onPick,
  onDelete,
}: {
  chats: AssistantChat[] | null;
  current: string;
  onPick: (id: string) => void;
  onDelete: (id: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tip label="Conversations" side="bottom">
        <Popover.Trigger className={iconButton} aria-label="Conversations">
          <ClockCounterClockwiseIcon aria-hidden />
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-50">
          <Popover.Popup className={`mk-popup ${popMotion} w-[min(22rem,calc(100vw-2rem))] p-1.5`}>
            <Popover.Title className="m-0 px-2.5 pt-1.5 pb-1 text-label text-ink-muted">
              Conversations
            </Popover.Title>
            {chats === null ? (
              <p className="m-0 px-2.5 py-2 text-body-sm text-ink-faint">Loading…</p>
            ) : chats.length === 0 ? (
              <p className="m-0 px-2.5 py-2 text-body-sm text-ink-faint">
                Nothing yet. Conversations from the web and <span className="mk-mono">gm ask</span>{" "}
                show up here.
              </p>
            ) : (
              <ul className="m-0 max-h-[60vh] list-none overflow-y-auto p-0">
                {chats.map((chat) => (
                  <li key={chat.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => {
                        onPick(chat.id);
                        setOpen(false);
                      }}
                      aria-current={chat.id === current || undefined}
                      className="flex min-h-9 w-full cursor-pointer flex-col justify-center rounded-plate border-0 bg-transparent py-1.5 pr-9 pl-2.5 text-left hover:bg-raised aria-[current]:bg-signal-wash max-sm:min-h-11"
                    >
                      <span className="w-full truncate text-body-sm text-ink">
                        {chat.title || "Untitled"}
                      </span>
                      <span className="text-micro text-ink-faint">
                        {timeAgo(chat.updatedAt)}
                        {chat.source === "cli" && " · gm ask"}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDelete(chat.id)}
                      className="absolute top-1/2 right-1 grid size-7 -translate-y-1/2 cursor-pointer place-items-center rounded-plate border-0 bg-transparent text-ink-faint opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-pressed hover:text-danger-text max-sm:opacity-100"
                      aria-label={`Delete “${chat.title || "Untitled"}”`}
                    >
                      <TrashIcon className="size-4" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
