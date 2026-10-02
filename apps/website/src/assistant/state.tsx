// Whether the assistant is open, which conversation it shows, and how other
// parts of the app reach it (open it, start a chat with a prompt).

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

interface AssistantState {
  open: boolean;
  chatId: string;
  /** A chat id this tab minted and hasn't sent anything in yet. */
  fresh: boolean;
  /** A prompt to send as soon as the chat is ready (from a suggestion elsewhere). */
  queued: string | null;
  toggle(): void;
  show(prompt?: string): void;
  hide(): void;
  newChat(): void;
  openChat(id: string): void;
  sent(): void;
  takeQueued(): string | null;
}

const Context = createContext<AssistantState | null>(null);

const OPEN = "gm.assistant.open";
const CHAT = "gm.assistant.chat";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private windows: the panel just doesn't remember.
  }
}

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  // A link from `gm ask` (…/?chat=<id>) opens that conversation.
  const [linked] = useState(() => {
    const id = new URLSearchParams(window.location.search).get("chat");
    return id && /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null;
  });
  const [open, setOpen] = useState(() => linked !== null || read(OPEN) === "1");
  const [chat, setChat] = useState(() => {
    const stored = linked ?? read(CHAT);
    return stored ? { id: stored, fresh: false } : { id: crypto.randomUUID(), fresh: true };
  });
  useEffect(() => {
    if (!linked) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("chat");
    window.history.replaceState(window.history.state, "", url);
  }, [linked]);
  const [queued, setQueued] = useState<string | null>(null);

  useEffect(() => write(OPEN, open ? "1" : null), [open]);
  // Only a chat that has messages is worth coming back to.
  useEffect(() => write(CHAT, chat.fresh ? null : chat.id), [chat]);

  const toggle = useCallback(() => setOpen((o) => !o), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  const value = useMemo<AssistantState>(
    () => ({
      open,
      chatId: chat.id,
      fresh: chat.fresh,
      queued,
      toggle,
      show(prompt) {
        if (prompt) setQueued(prompt);
        setOpen(true);
      },
      hide: () => setOpen(false),
      newChat: () => setChat({ id: crypto.randomUUID(), fresh: true }),
      openChat: (id) => setChat({ id, fresh: false }),
      sent: () => setChat((c) => (c.fresh ? { ...c, fresh: false } : c)),
      takeQueued() {
        const prompt = queued;
        if (prompt) setQueued(null);
        return prompt;
      },
    }),
    [open, chat, queued, toggle],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAssistant(): AssistantState {
  const state = useContext(Context);
  if (!state) throw new Error("useAssistant needs an AssistantProvider");
  return state;
}
