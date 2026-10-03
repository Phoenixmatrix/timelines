// Whether the assistant is open, which conversation it shows, and how other
// parts of the app reach it (open it, start a chat with a prompt).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { promptQueue, type QueuedPrompt } from "./queue.ts";

interface AssistantState {
  open: boolean;
  chatId: string;
  /** A chat id this tab minted and hasn't sent anything in yet. */
  fresh: boolean;
  /**
   * A prompt to send as soon as its chat is ready (from a suggestion elsewhere).
   * It names its chat, so a conversation still on screen can't take another's.
   */
  queued: QueuedPrompt | null;
  toggle(): void;
  /** Opens the assistant; with a prompt, sends it in the current chat. */
  show(prompt?: string): void;
  /**
   * Starts a new conversation with this prompt and opens the assistant, in one
   * step: the previous chat, its draft and pending approvals stay as they were.
   */
  ask(prompt: string): void;
  hide(): void;
  newChat(): void;
  openChat(id: string): void;
  sent(): void;
  /** The prompt queued for this chat, taken at most once. */
  takeQueued(chatId: string): string | null;
  /** Unsent text per conversation, kept for this tab while switching between them. */
  draftFor(chatId: string): string;
  saveDraft(chatId: string, text: string): void;
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
  // The queue is the source of truth for taking a prompt (effects that run
  // twice, or two chats rendering at once, must not send it twice); the state
  // copy only tells chats to look.
  const queue = useRef(promptQueue()).current;
  const drafts = useRef(new Map<string, string>()).current;
  const [queued, setQueued] = useState<QueuedPrompt | null>(null);
  const enqueue = useCallback(
    (next: QueuedPrompt) => {
      if (queue.put(next)) setQueued(next);
    },
    [queue],
  );

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
        if (prompt) enqueue({ chatId: chat.id, prompt });
        setOpen(true);
      },
      ask(prompt) {
        if (!prompt.trim()) return;
        const id = crypto.randomUUID();
        setChat({ id, fresh: true });
        enqueue({ chatId: id, prompt });
        setOpen(true);
      },
      hide: () => setOpen(false),
      newChat: () => setChat({ id: crypto.randomUUID(), fresh: true }),
      openChat: (id) => setChat({ id, fresh: false }),
      sent: () => setChat((c) => (c.fresh ? { ...c, fresh: false } : c)),
      draftFor: (chatId) => drafts.get(chatId) ?? "",
      saveDraft(chatId, text) {
        if (text) drafts.set(chatId, text);
        else drafts.delete(chatId);
      },
      takeQueued(chatId) {
        const prompt = queue.take(chatId);
        if (prompt !== null) setQueued(null);
        return prompt;
      },
    }),
    [open, chat, queued, toggle, enqueue, queue, drafts],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAssistant(): AssistantState {
  const state = useContext(Context);
  if (!state) throw new Error("useAssistant needs an AssistantProvider");
  return state;
}
