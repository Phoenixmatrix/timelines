// The global palette (⌘K / Ctrl+K, or Search in the rail): go to a page, run
// an action, or find a repository, person, organization or conversation.
// Local commands answer at once; remote categories arrive as they load.

import { Dialog } from "@base-ui/react/dialog";
import {
  ArrowRightIcon,
  BookOpenTextIcon,
  BuildingsIcon,
  ChatCenteredDotsIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  CompassIcon,
  FileCodeIcon,
  FolderSimpleIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitForkIcon,
  LightningIcon,
  MagnifyingGlassIcon,
  PackageIcon,
  PlayCircleIcon,
  PlusCircleIcon,
  TreeStructureIcon,
  UserCircleIcon,
  XCircleIcon,
  XIcon,
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
import {
  SEARCH_LIMITS,
  MATCH_RANK,
  matchFields,
  type SearchCategory,
  type SearchResponse,
  type SearchResult,
} from "../../shared/search.ts";
import type { TimelineList } from "../../shared/timelines.ts";
import type { TrackerList } from "../../shared/tracker.ts";
import { useAssistant } from "../assistant/state.tsx";
import { dialogMotion, fadeMotion, Tip } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { readRecent, type PlaceKind, type RecentPlace } from "../lib/recentPlaces.ts";
import {
  parseRef,
  resolveJump,
  timelineJump,
  type Jump,
  type JumpContext,
  type ParsedRef,
} from "../lib/resolveRefs.ts";
import { useViewer } from "../lib/session.ts";
import { scopeOwner } from "../lib/timelineScope.ts";
import { refContextFromPath } from "../refs/context.ts";
import {
  COMMAND_SOURCES,
  destinations,
  contextTracker,
  matchCommands,
  type Command,
  type CommandGroup,
  type PaletteContext,
  type PaletteEnv,
  type PaletteScope,
} from "./commands.ts";
import {
  knowledgeResults,
  knowledgeSearch,
  repoKey,
  type AtlasHandoff,
  type KnowledgeState,
  type ScopedRepo,
} from "./knowledge.ts";
import { DEBOUNCE_MS, remoteSearch, type RemoteState } from "./remote.ts";
import { edge, FRESH, move, reconcile, type Selection } from "./selection.ts";

/**
 * Opening the palette already narrowed to one repository's code and wiki
 * search, e.g. from the Atlas's lookup (CORE-171). `submit` searches at once:
 * only for an opener that was itself an explicit search action.
 */
export interface PaletteRequest {
  repo: ScopedRepo;
  query?: string;
  submit?: boolean;
  atlas?: AtlasHandoff;
}

const Context = createContext<{ open(request?: PaletteRequest): void } | null>(null);

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
  const [request, setRequest] = useState<PaletteRequest | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPaletteKey(event)) return;
      event.preventDefault();
      setRequest(null);
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const value = useMemo(
    () => ({
      open: (next?: PaletteRequest) => {
        setRequest(next ?? null);
        setOpen(true);
      },
    }),
    [],
  );
  return (
    <Context.Provider value={value}>
      {children}
      <Palette
        open={open}
        request={request}
        onOpenChange={(next) => {
          if (!next) setRequest(null);
          setOpen(next);
        }}
      />
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
  /** Narrows the palette instead of leaving it. */
  keepOpen?: boolean;
  /**
   * Moves focus somewhere else (the assistant's composer), so closing the
   * palette mustn't hand it back to whatever opened it.
   */
  takesFocus?: boolean;
}

interface Section {
  key: string;
  label: string;
  options: Option[];
}

const iconClass = "size-4 shrink-0 text-ink-muted";

const CATEGORY_ICON: Record<SearchCategory, ReactNode> = {
  repositories: <GitBranchIcon className={iconClass} aria-hidden />,
  issues: <CircleDashedIcon className={iconClass} aria-hidden />,
  packages: <PackageIcon className={iconClass} aria-hidden />,
  accounts: <UserCircleIcon className={iconClass} aria-hidden />,
  conversations: <ChatCenteredDotsIcon className={iconClass} aria-hidden />,
};

/** What one kind of result is called in a sentence: "Find issues". */
const CATEGORY_NOUN: Record<SearchCategory, string> = {
  repositories: "repositories",
  issues: "issues",
  packages: "packages",
  accounts: "people and organizations",
  conversations: "conversations",
};

function commandOption(command: Command): Option {
  const run = command.run;
  return {
    id: command.id,
    title: command.title,
    detail: command.hint ?? "",
    icon:
      command.id === "go" ? (
        <CompassIcon className={iconClass} aria-hidden />
      ) : run.kind === "scope" && run.scope.kind === "find" ? (
        CATEGORY_ICON[run.scope.category]
      ) : command.id.startsWith("knowledge") ? (
        <FileCodeIcon className={iconClass} aria-hidden />
      ) : command.id.startsWith("create") ? (
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
      run.kind === "navigate"
        ? env.navigate(run.to, run.state)
        : run.kind === "scope"
          ? env.scope(run.scope)
          : run.perform(env),
    keepOpen: run.kind === "scope",
    takesFocus: command.id === "ask" || command.id === "action:assistant",
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
    takesFocus: target.kind === "chat",
  };
}

function groupLabel(
  group: CommandGroup,
  context: PaletteContext,
  scope: PaletteScope | null,
  blank: boolean,
) {
  const going = scope?.kind === "go";
  if (group === "repository" && context.repo) {
    const name = `${context.repo.owner.slug}/${context.repo.name}`;
    return going ? name : `In ${name}`;
  }
  if (group === "actions") return "Actions";
  if (group === "find") return "Find";
  return going ? "Pages" : blank && context.viewer ? "Navigate" : "Go to";
}

/** The second step's banner, the input's name and its placeholder. */
function scopeText(scope: PaletteScope | null, signedIn: boolean) {
  if (!scope) {
    const label = signedIn ? "Search or go to" : "Go to";
    return { label, placeholder: `${label}…` };
  }
  switch (scope.kind) {
    case "go":
      return {
        label: "Go to a page",
        placeholder: "Filter pages and settings…",
        banner: <span className="font-semibold text-ink">Go to</span>,
        leave: "Leave Go to",
      };
    case "find": {
      const noun = CATEGORY_NOUN[scope.category];
      return {
        label: `Find ${noun}`,
        placeholder: `Find ${noun}…`,
        banner: (
          <>
            Find <span className="font-semibold text-ink">{noun}</span>
          </>
        ),
        leave: `Leave ${noun} search`,
      };
    }
    case "pick":
      return {
        label: "Choose a repository",
        placeholder: "Find a repository…",
        banner: "Code and wiki search: choose a repository",
        leave: "Leave code and wiki search",
      };
    case "repo":
      return {
        label: `Search code and wiki in ${repoKey(scope)}`,
        placeholder: "A name, or describe the behavior, then Enter",
        banner: (
          <>
            Code and wiki in <span className="font-semibold text-ink">{repoKey(scope)}</span>
            <span className="text-ink-faint"> · searches when you press Enter</span>
          </>
        ),
        leave: "Leave code and wiki search",
      };
  }
}

function scopeIcon(scope: PaletteScope) {
  const className = "size-4 shrink-0 text-ink-muted";
  if (scope.kind === "go") return <CompassIcon className={className} aria-hidden />;
  if (scope.kind === "find") return CATEGORY_ICON[scope.category];
  return <FileCodeIcon className={className} aria-hidden />;
}

/** One icon per kind of place, for jumps and recent places alike. */
const PLACE_ICON: Record<PlaceKind, ReactNode> = {
  repo: <GitBranchIcon className={iconClass} aria-hidden />,
  issue: <CircleDashedIcon className={iconClass} aria-hidden />,
  run: <PlayCircleIcon className={iconClass} aria-hidden />,
  package: <PackageIcon className={iconClass} aria-hidden />,
  timeline: <GitForkIcon className={iconClass} aria-hidden />,
  commit: <GitCommitIcon className={iconClass} aria-hidden />,
};

const PLACE_LABEL: Record<PlaceKind, string> = {
  repo: "Repository",
  issue: "Issue",
  run: "CI run",
  package: "Package",
  timeline: "Timeline",
  commit: "Commit",
};

function jumpOption(jump: Jump): Option {
  return {
    id: jump.id,
    title: jump.title,
    detail: jump.detail,
    icon: PLACE_ICON[jump.kind],
    activate: (env) => env.navigate(jump.to, jump.state),
  };
}

function recentOption(place: RecentPlace): Option {
  return {
    id: `recent:${place.to}`,
    title: place.title,
    detail: place.detail || PLACE_LABEL[place.kind],
    icon: PLACE_ICON[place.kind],
    activate: (env) => env.navigate(place.to),
  };
}

/**
 * What typed text jumps to, if anything: a reference (CORE-22), or in a
 * repository a bare run number, or a timeline's exact slug.
 */
function jumpRef(typed: string, inRepo: boolean, timelines: { slug: string }[]): ParsedRef | null {
  const ref = parseRef(typed);
  if (ref) return ref;
  if (inRepo && /^\d{1,6}$/.test(typed)) return { kind: "run", number: Number(typed) };
  const slug = typed.toLowerCase();
  return timelines.some((timeline) => timeline.slug === slug) ? { kind: "timeline", slug } : null;
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

function fetchSearch(query: string, signal: AbortSignal, scope: PaletteScope | null) {
  const params = new URLSearchParams({ q: query });
  if (scope?.kind === "pick") params.set("categories", "repositories");
  // Narrowed to one kind, it's worth seeing more of it than instant search shows.
  if (scope?.kind === "find") {
    params.set("categories", scope.category);
    params.set("limit", String(SEARCH_LIMITS.maxLimit));
  }
  return api<SearchResponse>(`/search?${params.toString()}`, { signal });
}

const KNOWLEDGE_ICON = {
  entities: <TreeStructureIcon className={iconClass} aria-hidden />,
  code: <FileCodeIcon className={iconClass} aria-hidden />,
  wiki: <BookOpenTextIcon className={iconClass} aria-hidden />,
};

function Palette({
  open,
  request,
  onOpenChange,
}: {
  open: boolean;
  request: PaletteRequest | null;
  onOpenChange: (open: boolean) => void;
}) {
  const viewer = useViewer();
  const location = useLocation();
  const { pathname } = location;
  const repo = (useRouteLoaderData("repo") as RepoDetail | undefined) ?? null;
  const navigate = useNavigate();
  const assistant = useAssistant();
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const helpId = useId();

  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<RemoteState>({ status: "idle", query: "" });
  const [selection, setSelection] = useState<Selection>(FRESH);
  // Narrowed to picking a repository, or to one repository's code and wiki.
  const [scope, setScopeState] = useState<PaletteScope | null>(null);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [knowledge, setKnowledge] = useState<KnowledgeState>({ status: "idle" });
  const knowledgeClient = useMemo(() => knowledgeSearch(setKnowledge), []);

  // Only a signed-in viewer searches the server; signed out, the palette is
  // navigation. Picking a repository searches repositories alone.
  const client = useMemo(
    () =>
      viewer
        ? remoteSearch((q, signal) => fetchSearch(q, signal, scopeRef.current), setRemote)
        : null,
    [viewer],
  );
  useEffect(() => () => client?.dispose(), [client]);
  useEffect(() => {
    if (!open) return;
    // Code and wiki search waits for Enter; nothing goes out while typing.
    // Go to only filters the app's own places.
    client?.search(scope?.kind === "repo" || scope?.kind === "go" ? "" : query);
  }, [client, open, query, scope]);
  useEffect(() => {
    if (open) return;
    client?.dispose();
    knowledgeClient.reset();
    setQuery("");
    setScopeState(null);
    setRemote({ status: "idle", query: "" });
    setSelection(FRESH);
  }, [client, knowledgeClient, open]);
  // Opened for one repository's code and wiki: narrow to it, fill in the
  // query and, when the opener asked, search it.
  const atlas = request?.atlas ?? null;
  useEffect(() => {
    if (!open || !request) return;
    client?.dispose();
    knowledgeClient.reset();
    setScopeState({ kind: "repo", ...request.repo });
    const q = request.query ?? "";
    setQuery(q);
    setSelection(FRESH);
    if (request.submit && q.trim())
      knowledgeClient.submit(request.repo, q.trim().replace(/\s+/g, " "));
  }, [client, knowledgeClient, open, request]);
  const setScope = (next: PaletteScope | null) => {
    client?.dispose();
    knowledgeClient.reset();
    setScopeState(next);
    setQuery("");
    setRemote({ status: "idle", query: "" });
    setSelection(FRESH);
    input.current?.focus();
  };

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
    search: location.search,
    hash: location.hash,
  };
  // Read on the render that opens it, so a previous opening's list never shows.
  const viewerId = viewer?.id ?? null;
  const recents = useMemo<RecentPlace[]>(
    () => (open ? readRecent(viewerId) : []),
    [open, viewerId],
  );

  // The timelines of the tracker in view (else the one /tracker opens), once per opening.
  const defaultTracker =
    trackers?.trackers.find((tracker) => tracker.id === trackers.defaultOwnerId)?.slug ?? null;
  const timelineOwner = contextTracker(context)?.slug ?? defaultTracker;
  // Switching scopes the page in view, so it offers the timelines of the
  // account the page is about (as the banner reads them), else the default's.
  const switchOwner =
    scopeOwner(pathname, location.search) ?? defaultTracker ?? trackers?.trackers[0]?.slug ?? null;
  const [timelines, setTimelines] = useState<JumpContext["timelines"]>([]);
  const [switchable, setSwitchable] = useState<NonNullable<PaletteContext["timelines"]>>([]);
  useEffect(() => {
    setTimelines([]);
    setSwitchable([]);
    if (!open || !viewer) return;
    const controller = new AbortController();
    const read = (owner: string) =>
      api<TimelineList>(`/tracker/${encodeURIComponent(owner)}/timelines`, {
        signal: controller.signal,
      });
    // Open ones first: they're what a person switches to.
    const ended = (t: { status: string }) => t.status === "landed" || t.status === "abandoned";
    const offer = (list: TimelineList) =>
      setSwitchable(
        [...list.timelines]
          .sort((a, b) => Number(ended(a)) - Number(ended(b)))
          .map((t) => ({ slug: t.slug, name: t.name, status: t.status, repos: t.repos })),
      );
    if (timelineOwner)
      read(timelineOwner).then(
        (list) => {
          setTimelines(
            list.timelines.map((t) => ({ slug: t.slug, name: t.name, owner: timelineOwner })),
          );
          if (switchOwner === timelineOwner) offer(list);
        },
        () => {},
      );
    if (switchOwner && switchOwner !== timelineOwner) read(switchOwner).then(offer, () => {});
    return () => controller.abort();
  }, [open, viewer, timelineOwner, switchOwner]);

  // Direct jumps: what a reference names, through the one resolver.
  const typed = query.trim().replace(/\s+/g, " ");
  const ref = scope ? null : jumpRef(typed, !!repo, timelines);
  const refKey = ref ? JSON.stringify(ref) : null;
  const jumpContext: JumpContext = {
    here: { pathname, search: location.search, state: location.state as unknown },
    repo,
    tracker: contextTracker(context)?.slug ?? repo?.owner.slug ?? null,
    owner: refContextFromPath(pathname).owner ?? null,
    recentRepos: recents
      .filter((place) => place.kind === "repo")
      .map((place) => {
        const [owner = "", name = ""] = place.title.split("/");
        return { owner, name };
      }),
    timelines,
  };
  const jumpContextRef = useRef(jumpContext);
  jumpContextRef.current = jumpContext;
  const [jumpState, setJumpState] = useState<{
    key: string;
    status: "loading" | "done" | "failed";
    jumps: Jump[];
    error?: string;
  } | null>(null);
  const contextKey = `${pathname}${location.search}|${repo?.id ?? ""}|${timelines.length}|${recents.length}`;
  useEffect(() => {
    if (!open || !refKey) return;
    const parsed = JSON.parse(refKey) as ParsedRef;
    // Issues and packages are found through search, which is for signed-in viewers.
    if (!viewer && (parsed.kind === "issue" || parsed.kind === "package")) return;
    const controller = new AbortController();
    setJumpState({ key: refKey, status: "loading", jumps: [] });
    const timer = setTimeout(() => {
      resolveJump(parsed, jumpContextRef.current, controller.signal).then(
        (jumps) => {
          if (!controller.signal.aborted) setJumpState({ key: refKey, status: "done", jumps });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          setJumpState({
            key: refKey,
            status: "failed",
            jumps: [],
            error: error instanceof Error ? error.message : "Couldn't look that up.",
          });
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, refKey, viewer, contextKey]);
  const jumping = jumpState && jumpState.key === refKey ? jumpState : null;

  const going = scope?.kind === "go";
  const commands = going
    ? destinations(context)
    : scope
      ? []
      : COMMAND_SOURCES.flatMap((source) => source({ ...context, timelines: switchable }));
  const local = matchCommands(
    commands,
    query,
    going ? { perGroup: Infinity, everything: true } : undefined,
  );
  const blank = !query.trim();
  const sections: Section[] = [];
  if (jumping?.jumps.length)
    sections.push({ key: "jumps", label: "Jump to", options: jumping.jumps.map(jumpOption) });
  // Before anything is typed: where the viewer has been, newest first,
  // right under Go to… (which stays first and selected).
  const here = `${pathname}${location.search}`;
  const recentShown = !scope && !typed ? recents.filter((place) => place.to !== here) : [];
  let recentsShown = false;
  const pushRecents = () => {
    if (recentsShown || !recentShown.length) return;
    recentsShown = true;
    sections.push({ key: "recent", label: "Recent", options: recentShown.map(recentOption) });
  };
  // Commands that act on the query itself ("Create issue “…”") are fallbacks:
  // listed last and never selected by default, so Enter on a search opens a
  // result rather than a form.
  const fallbacks: Command[] = [];
  // Before anything's typed, Go to leads and what you can do follows it.
  const order: CommandGroup[] =
    blank && !scope
      ? ["pages", "repository", "actions", "find"]
      : ["repository", "pages", "actions", "find"];
  for (const group of order) {
    const matched = (local.get(group) ?? []).filter(({ command }) => {
      if (command.always) fallbacks.push(command);
      return !command.always;
    });
    if (matched.length)
      sections.push({
        key: group,
        label: groupLabel(group, context, scope, blank),
        options: matched.map(({ command }) => commandOption(command)),
      });
    if (group === order[0]) pushRecents();
  }
  pushRecents();
  // Timelines in view, matched here: the list is already loaded.
  if (typed && !scope) {
    const jumped = new Set(jumping?.jumps.map((jump) => jump.id));
    const matched = timelines
      .map((timeline) => ({
        timeline,
        match: matchFields(typed, {
          identifiers: [timeline.slug, `timeline/${timeline.slug}`, timeline.name],
          names: [timeline.name, timeline.slug],
          searched: [],
        }),
      }))
      .filter((m) => m.match !== null)
      .sort((a, b) => MATCH_RANK[a.match!] - MATCH_RANK[b.match!])
      .map((m) => timelineJump(m.timeline))
      .filter((jump) => !jumped.has(jump.id))
      .slice(0, 5);
    if (matched.length)
      sections.push({ key: "timelines", label: "Timelines", options: matched.map(jumpOption) });
  }

  // Remote groups only ever show the answer to the current query.
  const normalized = typed;
  const current = remote.status === "done" && remote.query === normalized;
  if (current)
    for (const group of remote.response.groups)
      if (group.status === "ok" && group.results.length)
        sections.push({
          key: group.category,
          label: CATEGORY_LABEL[group.category],
          options: group.results.map((result) =>
            // Picking a repository narrows to it instead of opening it.
            scope?.kind === "pick" && result.category === "repositories"
              ? {
                  ...resultOption(result),
                  keepOpen: true,
                  activate: (env: PaletteEnv) =>
                    env.scope({
                      kind: "repo",
                      owner: result.owner,
                      name: result.name,
                      defaultBranch: result.defaultBranch,
                    }),
                }
              : resultOption(result),
          ),
        });

  // One repository's code and wiki: only the answer to what was submitted, in
  // this scope, ever shows.
  const scopedRepo: ScopedRepo | null = scope?.kind === "repo" ? scope : null;
  const answered =
    scopedRepo &&
    knowledge.status === "done" &&
    knowledge.repo === repoKey(scopedRepo) &&
    knowledge.query === normalized
      ? knowledgeResults(
          scopedRepo,
          knowledge.results,
          atlas && request && repoKey(request.repo) === repoKey(scopedRepo) ? atlas : null,
        )
      : null;
  const submitted =
    scopedRepo && knowledge.status !== "idle" && knowledge.repo === repoKey(scopedRepo)
      ? knowledge.query
      : null;
  for (const group of answered?.groups ?? [])
    sections.push({
      key: group.key,
      label: group.label,
      options: group.options.map((option) => ({
        id: option.id,
        title: option.title,
        detail: option.detail,
        icon: KNOWLEDGE_ICON[group.key],
        activate: (env: PaletteEnv) => env.navigate(option.to),
      })),
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
    scope: (next) => setScope(next),
  };
  // Whether closing returns focus to whatever opened the palette.
  const restoreFocus = useRef(true);
  useEffect(() => {
    if (open) restoreFocus.current = true;
  }, [open]);
  const activate = (option: Option) => {
    if (option.takesFocus) restoreFocus.current = false;
    if (!option.keepOpen) onOpenChange(false);
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
      // Code and wiki search runs only when submitted: Enter on new text
      // searches, Enter on results already shown opens the selected one.
      if (scopedRepo && normalized !== submitted) {
        knowledgeClient.submit(scopedRepo, normalized);
        setSelection(FRESH);
        return;
      }
      const option = activeIndex >= 0 ? options[activeIndex] : undefined;
      if (option) activate(option);
    } else if (event.key === "Backspace" && scope && !query) {
      event.preventDefault();
      setScope(null);
    }
  };

  const text = scopeText(scope, !!viewer);
  // A finished answer to an older query is still waiting on the newer one.
  const loading =
    remote.status === "loading" ||
    (remote.status === "done" && !current) ||
    jumping?.status === "loading";
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
            finalFocus={() => restoreFocus.current}
            className={`flex max-h-[min(36rem,calc(100dvh-1.5rem))] w-full max-w-xl flex-col overflow-hidden rounded-pane bg-pane shadow-[var(--shadow-float),0_0_0_1px_var(--line-soft)] ${dialogMotion}`}
            onKeyDown={onKeyDown}
          >
            <Dialog.Title className="sr-only">Search</Dialog.Title>
            {scope && (
              <div className="flex items-center gap-2 border-b border-line-soft px-4 py-2 text-body-sm">
                {scopeIcon(scope)}
                <span className="min-w-0 flex-1 truncate text-ink-muted">{text.banner}</span>
                <button
                  type="button"
                  className="mk-btn mk-btn--ghost mk-btn--sm"
                  aria-label={text.leave}
                  onClick={() => setScope(null)}
                >
                  <XIcon className="size-3.5" aria-hidden />
                </button>
              </div>
            )}
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
                aria-label={text.label}
                placeholder={text.placeholder}
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
              {scopedRepo && knowledge.status === "loading" && knowledge.query === normalized && (
                <p className="m-0 px-2.5 py-2 text-body-sm text-ink-faint">
                  Searching code and wiki…
                </p>
              )}
              {scopedRepo && knowledge.status === "failed" && knowledge.query === normalized && (
                <p className="m-0 px-2.5 py-2 text-body-sm text-danger-text">{knowledge.message}</p>
              )}
              {answered?.notes.map((note) => (
                <p key={note} className="m-0 px-2.5 py-2 text-body-sm text-ink-muted">
                  {note}
                </p>
              ))}
              {scopedRepo && normalized && normalized !== submitted && (
                <p className="m-0 px-2.5 py-2 text-body-sm text-ink-faint">
                  Press Enter to search {repoKey(scopedRepo)}.
                </p>
              )}
              {scope?.kind === "find" && !normalized && (
                <p className="m-0 px-2.5 py-6 text-center text-body-sm text-ink-muted">
                  Type to find {CATEGORY_NOUN[scope.category]}.
                </p>
              )}
              {!scopedRepo && normalized && !found && !loading && (
                <p className="m-0 px-2.5 py-6 text-center text-body-sm text-ink-muted">
                  Nothing matches “{normalized}”.
                </p>
              )}
              {loading && <p className="m-0 px-2.5 py-2 text-body-sm text-ink-faint">Searching…</p>}
              {jumping?.status === "failed" && (
                <p className="m-0 px-2.5 py-2 text-body-sm text-danger-text">
                  Couldn't look up “{typed}”: {jumping.error}
                </p>
              )}
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
              {scope && (
                <span>
                  <kbd className="mk-kbd">⌫</kbd> to go back
                </span>
              )}
              <span>
                <kbd className="mk-kbd">Esc</kbd> to close
              </span>
            </div>
            <div role="status" className="sr-only">
              {scopedRepo
                ? knowledge.status === "loading"
                  ? "Searching code and wiki"
                  : knowledge.status === "failed"
                    ? knowledge.message
                    : answered
                      ? [`${found} result${found === 1 ? "" : "s"}.`, ...answered.notes].join(" ")
                      : ""
                : announce(found, normalized, remote)}
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
