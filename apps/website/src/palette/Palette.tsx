// The global palette (⌘K / Ctrl+K, or Search in the rail): go to a page, run
// an action, or find a repository, person, organization or conversation.
// Local commands answer at once; remote categories arrive as they load.

import { Dialog } from "@base-ui/react/dialog";
import {
  ArrowRightIcon,
  BuildingsIcon,
  ChatCenteredDotsIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  FolderSimpleIcon,
  GitBranchIcon,
  LightningIcon,
  MagnifyingGlassIcon,
  PackageIcon,
  PlusCircleIcon,
  UserCircleIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate, useRouteLoaderData } from "react-router";
import type { RepoDetail } from "../../shared/api.ts";
import type { SearchCategory, SearchResponse, SearchResult } from "../../shared/search.ts";
import type { TrackerList } from "../../shared/tracker.ts";
import { useAssistant } from "../assistant/state.tsx";
import { dialogMotion, fadeMotion, Tip } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { useViewer } from "../lib/session.ts";
import {
  COMMAND_SOURCES,
  matchCommands,
  type Command,
  type CommandGroup,
  type PaletteContext,
  type PaletteEnv,
} from "./commands.ts";
import { remoteSearch, type RemoteState } from "./remote.ts";
import { edge, FRESH, move, reconcile, type Selection } from "./selection.ts";

const Context = createContext<{ open(): void } | null>(null);

export function usePalette() {
  const palette = useContext(Context);
  if (!palette) throw new Error("usePalette needs a PaletteProvider");
  return palette;
}

/** True for ⌘K on a Mac and Ctrl+K elsewhere (either works anywhere). */
function isPaletteKey(event: KeyboardEvent | React.KeyboardEvent) {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "k"
  );
}

export function PaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPaletteKey(event)) return;
      event.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const value = useMemo(() => ({ open: () => setOpen(true) }), []);
  return (
    <Context.Provider value={value}>
      {children}
      <Palette open={open} onOpenChange={setOpen} />
    </Context.Provider>
  );
}

/** The rail's Search button. */
export function SearchButton() {
  const palette = usePalette();
  return (
    <Tip label="Search (⌘K)" side="right">
      <button
        type="button"
        className="mk-place max-sm:before:hidden"
        aria-label="Search"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={() => palette.open()}
      >
        <MagnifyingGlassIcon size={22} aria-hidden />
      </button>
    </Tip>
  );
}

const CATEGORY_LABEL: Record<SearchCategory, string> = {
  repositories: "Repositories",
  issues: "Issues",
  packages: "Packages",
  accounts: "People and organizations",
  conversations: "Conversations",
};

/** One row in the list, local or remote. */
interface Option {
  id: string;
  title: string;
  detail: string;
  icon: ReactNode;
  activate(env: PaletteEnv): void;
}

interface Section {
  key: string;
  label: string;
  options: Option[];
}

const iconClass = "size-4 shrink-0 text-ink-muted";

function commandOption(command: Command): Option {
  const run = command.run;
  return {
    id: command.id,
    title: command.title,
    detail: command.hint ?? "",
    icon: command.id.startsWith("create") ? (
      <PlusCircleIcon className={iconClass} aria-hidden />
    ) : command.id === "ask" ? (
      <ChatCenteredDotsIcon className={iconClass} aria-hidden />
    ) : command.group === "actions" ? (
      <LightningIcon className={iconClass} aria-hidden />
    ) : command.group === "repository" ? (
      <FolderSimpleIcon className={iconClass} aria-hidden />
    ) : (
      <ArrowRightIcon className={iconClass} aria-hidden />
    ),
    activate: (env) =>
      run.kind === "navigate" ? env.navigate(run.to, run.state) : run.perform(env),
  };
}

function resultOption(result: SearchResult): Option {
  const target = result.target;
  const detail =
    result.category === "repositories"
      ? result.subtitle
      : result.category === "issues"
        ? `${result.subtitle} · ${result.tracker.slug}`
        : result.category === "packages"
          ? result.subtitle
          : result.category === "accounts"
            ? `@${result.slug}`
            : "Conversation";
  return {
    id: result.id,
    title: result.title,
    detail,
    icon:
      result.category === "repositories" ? (
        <GitBranchIcon className={iconClass} aria-hidden />
      ) : result.category === "issues" ? (
        result.status === "done" ? (
          <CheckCircleIcon className={iconClass} aria-hidden />
        ) : result.status === "canceled" ? (
          <XCircleIcon className={iconClass} aria-hidden />
        ) : (
          <CircleDashedIcon className={iconClass} aria-hidden />
        )
      ) : result.category === "packages" ? (
        <PackageIcon className={iconClass} aria-hidden />
      ) : result.category === "accounts" ? (
        result.kind === "org" ? (
          <BuildingsIcon className={iconClass} aria-hidden />
        ) : (
          <UserCircleIcon className={iconClass} aria-hidden />
        )
      ) : (
        <ChatCenteredDotsIcon className={iconClass} aria-hidden />
      ),
    activate: (env) => {
      if (target.kind === "path") env.navigate(target.path);
      else {
        env.assistant.openChat(target.chatId);
        env.assistant.show();
      }
    },
  };
}

function groupLabel(group: CommandGroup, context: PaletteContext) {
  if (group === "repository" && context.repo)
    return `In ${context.repo.owner.slug}/${context.repo.name}`;
  return group === "actions" ? "Actions" : "Go to";
}

/** What screen readers hear after each change: counts, then what's still loading or failed. */
function announce(count: number, query: string, remote: RemoteState): string {
  const parts = [query ? `${count} result${count === 1 ? "" : "s"}` : ""];
  if (remote.status === "loading") parts.push("searching");
  if (remote.status === "failed") parts.push(`search failed: ${remote.error}`);
  if (remote.status === "done")
    for (const group of remote.response.groups)
      if (group.status === "unavailable") parts.push(group.error);
      else if (group.incomplete)
        parts.push(`${CATEGORY_LABEL[group.category]}: ${group.incomplete}`);
  return parts.filter(Boolean).join(". ");
}

function fetchSearch(query: string, signal: AbortSignal) {
  return api<SearchResponse>(`/search?${new URLSearchParams({ q: query }).toString()}`, {
    signal,
  });
}

function Palette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const viewer = useViewer();
  const { pathname } = useLocation();
  const repo = (useRouteLoaderData("repo") as RepoDetail | undefined) ?? null;
  const navigate = useNavigate();
  const assistant = useAssistant();
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const helpId = useId();

  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<RemoteState>({ status: "idle", query: "" });
  const [selection, setSelection] = useState<Selection>(FRESH);

  // Only a signed-in viewer searches the server; signed out, the palette is navigation.
  const client = useMemo(() => (viewer ? remoteSearch(fetchSearch, setRemote) : null), [viewer]);
  useEffect(() => () => client?.dispose(), [client]);
  useEffect(() => {
    if (open) client?.search(query);
  }, [client, open, query]);
  useEffect(() => {
    if (open) return;
    client?.dispose();
    setQuery("");
    setRemote({ status: "idle", query: "" });
    setSelection(FRESH);
  }, [client, open]);

  // The trackers create-issue can target, fetched once per opening.
  const [trackers, setTrackers] = useState<TrackerList | null>(null);
  useEffect(() => {
    if (!open || !viewer) return;
    const controller = new AbortController();
    api<TrackerList>("/tracker", { signal: controller.signal }).then(
      (list) => setTrackers(list),
      () => setTrackers(null),
    );
    return () => controller.abort();
  }, [open, viewer]);

  const context: PaletteContext = {
    viewer,
    pathname,
    repo,
    trackers: trackers?.trackers ?? null,
    defaultTrackerId: trackers?.defaultOwnerId ?? null,
    query,
  };
  const commands = COMMAND_SOURCES.flatMap((source) => source(context));
  const local = matchCommands(commands, query);
  const sections: Section[] = [];
  // Commands that act on the query itself ("Create issue “…”") are fallbacks:
  // listed last and never selected by default, so Enter on a search opens a
  // result rather than a form.
  const fallbacks: Command[] = [];
  for (const group of ["repository", "pages", "actions"] as const) {
    const matched = (local.get(group) ?? []).filter(({ command }) => {
      if (command.always) fallbacks.push(command);
      return !command.always;
    });
    if (matched.length)
      sections.push({
        key: group,
        label: groupLabel(group, context),
        options: matched.map(({ command }) => commandOption(command)),
      });
  }
  // Remote groups only ever show the answer to the current query.
  const normalized = query.trim().replace(/\s+/g, " ");
  const current = remote.status === "done" && remote.query === normalized;
  if (current)
    for (const group of remote.response.groups)
      if (group.status === "ok" && group.results.length)
        sections.push({
          key: group.category,
          label: CATEGORY_LABEL[group.category],
          options: group.results.map(resultOption),
        });

  const found = sections.reduce((count, section) => count + section.options.length, 0);
  if (fallbacks.length)
    sections.push({ key: "fallback", label: "Or", options: fallbacks.map(commandOption) });

  const options = sections.flatMap((section) => section.options);
  const ids = options.map((option) => option.id);
  const active = reconcile(
    selection,
    ids,
    ids.filter((id) => !fallbacks.some((command) => command.id === id)),
  );
  const activeIndex = active.id === null ? -1 : ids.indexOf(active.id);
  const optionId = (index: number) => `${listId}-${index}`;

  useEffect(() => {
    if (activeIndex >= 0)
      document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, listId]);

  const env: PaletteEnv = {
    navigate: (to, state) => void navigate(to, state === undefined ? undefined : { state }),
    assistant: {
      show: () => assistant.show(),
      openChat: (id) => assistant.openChat(id),
      ask: (prompt) => assistant.ask(prompt),
    },
  };
  const activate = (option: Option) => {
    onOpenChange(false);
    option.activate(env);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // The page's own shortcuts (tracker, editor, assistant) don't fire while
    // the palette has focus; Escape and Tab stay with the dialog.
    if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
    if (isPaletteKey(event)) {
      event.preventDefault();
      // A toggle: the popup keeps focus while it animates closed, and ⌘K
      // pressed then must reopen it, not close it again.
      onOpenChange(!open);
      return;
    }
    // Still animating closed after an activation: a quick second Enter must
    // not run the same option again (a second Ask, a second navigation).
    if (!open) {
      event.preventDefault();
      return;
    }
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setSelection(move(active, ids, event.key === "ArrowDown" ? 1 : -1));
    } else if ((event.key === "Home" || event.key === "End") && event.ctrlKey) {
      event.preventDefault();
      setSelection(edge(ids, event.key === "Home" ? "first" : "last"));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = activeIndex >= 0 ? options[activeIndex] : undefined;
      if (option) activate(option);
    }
  };

  // A finished answer to an older query is still waiting on the newer one.
  const loading = remote.status === "loading" || (remote.status === "done" && !current);
  const unavailable =
    current && remote.status === "done"
      ? remote.response.groups.flatMap((group) => (group.status === "unavailable" ? [group] : []))
      : [];
  const incomplete =
    current && remote.status === "done"
      ? remote.response.groups.flatMap((group) =>
          group.status === "ok" && group.incomplete
            ? [{ category: group.category, note: group.incomplete }]
            : [],
        )
      : [];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={`mk-backdrop ${fadeMotion}`} />
        <Dialog.Viewport className="fixed inset-0 z-50 flex items-start justify-center p-3 pt-[max(0.75rem,10dvh)]">
          <Dialog.Popup
            initialFocus={input}
            className={`flex max-h-[min(36rem,calc(100dvh-1.5rem))] w-full max-w-xl flex-col overflow-hidden rounded-pane bg-pane shadow-[var(--shadow-float),0_0_0_1px_var(--line-soft)] ${dialogMotion}`}
            onKeyDown={onKeyDown}
          >
            <Dialog.Title className="sr-only">Search</Dialog.Title>
            <div className="relative border-b border-line-soft">
              <MagnifyingGlassIcon
                className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-ink-faint"
                aria-hidden
              />
              <input
                ref={input}
                className="h-14 w-full bg-transparent pr-4 pl-11 text-body text-ink outline-none placeholder:text-ink-faint"
                role="combobox"
                aria-expanded
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
                aria-describedby={helpId}
                aria-label={viewer ? "Search or go to" : "Go to"}
                placeholder={viewer ? "Search or go to…" : "Go to…"}
                value={query}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSelection(FRESH);
                }}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
              <div id={listId} role="listbox" aria-label="Results">
                {(() => {
                  let index = 0;
                  return sections.map((section) => {
                    const headingId = `${listId}-${section.key}`;
                    return (
                      <div key={section.key} role="group" aria-labelledby={headingId}>
                        <div
                          id={headingId}
                          className="px-2.5 pt-2 pb-1 text-micro font-semibold text-ink-faint"
                        >
                          {section.label}
                        </div>
                        {section.options.map((option) => {
                          const at = index++;
                          const selected = at === activeIndex;
                          return (
                            <div
                              key={option.id}
                              id={optionId(at)}
                              role="option"
                              aria-selected={selected}
                              data-option-id={option.id}
                              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-plate px-2.5 py-1.5 text-body-sm aria-selected:bg-raised sm:min-h-10"
                              onMouseDown={(event) => event.preventDefault()}
                              onMouseMove={() => {
                                if (!selected) setSelection({ id: option.id, chosen: true });
                              }}
                              onClick={() => activate(option)}
                            >
                              {option.icon}
                              <span className="min-w-0 flex-1 truncate">
                                <span className="font-semibold text-ink">{option.title}</span>
                                {option.detail && (
                                  <span className="ml-2 text-ink-faint">{option.detail}</span>
                                )}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    );
                  });
                })()}
              </div>
              {normalized && !found && !loading && (
                <p className="m-0 px-2.5 py-6 text-center text-body-sm text-ink-muted">
                  Nothing matches “{normalized}”.
                </p>
              )}
              {loading && <p className="m-0 px-2.5 py-2 text-body-sm text-ink-faint">Searching…</p>}
              {remote.status === "failed" && remote.query === normalized && (
                <p className="m-0 px-2.5 py-2 text-body-sm text-danger-text">
                  Search failed: {remote.error}
                </p>
              )}
              {incomplete.map((group) => (
                <p key={group.category} className="m-0 px-2.5 py-2 text-body-sm text-ink-muted">
                  {CATEGORY_LABEL[group.category]}: {group.note}
                </p>
              ))}
              {unavailable.map((group) => (
                <p key={group.category} className="m-0 px-2.5 py-2 text-body-sm text-danger-text">
                  {group.error}
                </p>
              ))}
            </div>
            <div
              id={helpId}
              className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line-soft px-4 py-2 text-micro text-ink-faint max-sm:hidden"
            >
              <span>
                <kbd className="mk-kbd">↑</kbd> <kbd className="mk-kbd">↓</kbd> to choose
              </span>
              <span>
                <kbd className="mk-kbd">Enter</kbd> to open
              </span>
              <span>
                <kbd className="mk-kbd">Esc</kbd> to close
              </span>
            </div>
            <div role="status" className="sr-only">
              {announce(found, normalized, remote)}
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
