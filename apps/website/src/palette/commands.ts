// What the palette can do without asking the server: go to a page, or run an
// action. Each source returns the commands available to this viewer here; a
// new action (create an issue, ask the assistant) adds a source.

import type { RepoDetail, Viewer } from "../../shared/api.ts";
import {
  MATCH_RANK,
  matchFields,
  type SearchCategory,
  type SearchMatch,
} from "../../shared/search.ts";
import type { SpaceSummary } from "../../shared/spaces.ts";
import { createIntent } from "./intents.ts";
import type { ScopedRepo } from "./knowledge.ts";
import { packagesPath } from "../lib/packages.ts";
import { parseRef } from "../lib/resolveRefs.ts";
import { repoSections } from "../lib/repoSections.ts";
import { scopeOf, switchScope } from "../lib/timelineScope.ts";
import type { Timeline } from "../../shared/timelines.ts";

/**
 * A second step the palette narrows to, keeping it open: every place to go,
 * one kind of search result, choosing a repository for code and wiki search,
 * or one repository's code and wiki.
 */
export type PaletteScope =
  | { kind: "go" }
  | { kind: "find"; category: SearchCategory }
  | { kind: "pick" }
  | ({ kind: "repo" } & ScopedRepo);

/** Where the palette was opened. */
export interface PaletteContext {
  viewer: Viewer | null;
  pathname: string;
  /** The repository being viewed, when on one of its pages. */
  repo: RepoDetail | null;
  /** Trackers the viewer can use (GET /api/tracker); null until loaded or signed out. */
  trackers: SpaceSummary[] | null;
  /** The tracker /tracker opens for the viewer: where they last saved defaults. */
  defaultTrackerId?: string | null;
  /** What's typed, for actions that take it as input (a proposed title). */
  query: string;
  /** The page's query string, for switching its timeline in place. */
  search?: string;
  /** The page's fragment (a line, a heading), kept when switching. */
  hash?: string;
  /** The timelines of the tracker in view, to switch to (CORE-402); none until loaded. */
  timelines?: Pick<Timeline, "slug" | "name" | "status" | "repos">[];
}

/** What an action can reach when it runs. */
export interface PaletteEnv {
  /** In-app navigation; `state` carries one-shot intents (palette/intents.ts). */
  navigate(to: string, state?: unknown): void;
  assistant: { show(): void; openChat(id: string): void; ask(prompt: string): void };
  /** Narrows the palette, which stays open. */
  scope(next: PaletteScope): void;
}

export type CommandGroup = "pages" | "repository" | "actions" | "find";

export interface Command {
  /** Stable across renders and queries: selection follows it. */
  id: string;
  group: CommandGroup;
  title: string;
  /** A secondary line: where it goes, or a shortcut. */
  hint?: string;
  keywords?: string[];
  /** Offered whatever is typed, because it acts on the query itself. */
  always?: boolean;
  /**
   * Listed before anything is typed. The rest (every page and section) wait
   * for a query or for Go to, so they don't crowd out everything else.
   */
  home?: boolean;
  run:
    | { kind: "navigate"; to: string; state?: unknown }
    | { kind: "action"; perform(env: PaletteEnv): void }
    /** Narrows the palette itself (it stays open), e.g. to one repository's code. */
    | { kind: "scope"; scope: PaletteScope };
}

export type CommandSource = (context: PaletteContext) => Command[];

const page = (id: string, title: string, to: string, keywords: string[] = []): Command => ({
  id: `page:${id}`,
  group: "pages",
  title,
  hint: to,
  keywords,
  run: { kind: "navigate", to },
});

/**
 * One entry for every place to go, which opens them as a second step, so the
 * places themselves needn't fill the list before anything is typed. Signed
 * out there are only a few, listed directly.
 */
const navigate: CommandSource = ({ viewer, repo }) =>
  viewer
    ? [
        {
          id: "go",
          group: "pages",
          title: "Go to…",
          hint: repo ? `Pages, settings and ${repo.space.slug}/${repo.name}` : "Pages and settings",
          keywords: ["navigate", "pages", "open", "jump"],
          home: true,
          run: { kind: "scope", scope: { kind: "go" } },
        },
      ]
    : [];

/** The app's own places, as the rail and account menu offer them. */
const pages: CommandSource = ({ viewer, pathname }) => {
  if (!viewer)
    return [
      { ...page("home", "Home", "/"), home: true },
      {
        ...page("signin", "Sign in", `/signin?next=${encodeURIComponent(pathname)}`, ["log in"]),
        home: true,
      },
    ];
  return [
    page("home", "Home", "/", ["dashboard"]),
    page("tracker", "Issue tracker", "/tracker", ["issues", "tickets"]),
    page("needs-you", "Needs you", "/needs-you", ["requests", "inbox", "approvals"]),
    page("agent-work", "Agent work", "/agent-work", ["finished", "completed", "done", "agents"]),
    page("packages", "Packages", "/packages", ["registry"]),
    page("new", "New repository", "/new", ["create", "import"]),
    page("repos", "Your repositories", `/${viewer.slug}`, ["profile"]),
    page("your-packages", "Your packages", packagesPath(viewer.slug)),
    page("profile", "Profile settings", "/settings/profile", ["account", "username"]),
    page("assistant-skills", "Assistant skills", "/settings/skills", [
      "personal",
      "slash",
      "instructions",
    ]),
    page("preferences", "Preferences", "/settings/preferences", [
      "default team",
      "layout",
      "keyboard",
      "shortcuts",
    ]),
    page("settings", "Settings", "/tracker?manage=true", ["teams", "projects", "administration"]),
    page("tokens", "Access tokens", "/settings/tokens", ["pat", "api"]),
    page("agents", "Agents", "/settings/agents", ["bots"]),
    page("ssh-keys", "SSH keys", "/settings/ssh-keys"),
    page("usage", "Usage & costs", "/settings/usage", ["billing", "storage", "spend", "cost"]),
    page("retention", "Data retention", "/settings/retention", [
      "cleanup",
      "clean up",
      "delete",
      "storage",
    ]),
    ...(viewer.isSiteAdmin
      ? [
          page("invites", "Invitations", "/settings/invites", ["invite", "admin"]),
          page("accounts", "Accounts", "/settings/accounts", [
            "create account",
            "password",
            "user",
            "admin",
          ]),
          page("site-ai", "Site AI settings", "/settings/site-ai", ["gateway", "logs", "admin"]),
          page("site-usage", "Site usage & costs", "/settings/site-usage", [
            "billing",
            "storage",
            "admin",
          ]),
          page("site-retention", "Site data retention", "/settings/site-retention", [
            "cleanup",
            "delete",
            "admin",
          ]),
        ]
      : []),
  ];
};

/** The current repository's sections, from the same list as its tabs. */
const repository: CommandSource = ({ viewer, repo }) =>
  repo
    ? repoSections(repo).map((section) => ({
        id: `repo:${section.id}`,
        group: "repository" as const,
        title: section.label,
        hint: `${repo.space.slug}/${repo.name}`,
        keywords: section.keywords,
        home: !viewer,
        run: { kind: "navigate" as const, to: section.to },
      }))
    : [];

/** Where Go to leads: the current repository's sections, then the app's pages. */
export const destinations: CommandSource = (context) => [...repository(context), ...pages(context)];

const actions: CommandSource = ({ viewer, query }) => {
  if (!viewer) return [];
  const prompt = query.trim();
  return [
    // Submitting is explicit: typing, highlighting or closing never sends
    // anything, and this starts a new conversation rather than adding to one.
    ...(prompt
      ? [
          {
            id: "ask",
            group: "actions" as const,
            title: `Ask Timelines “${prompt}”`,
            hint: "Sends it in a new conversation",
            always: true,
            run: {
              kind: "action" as const,
              perform: (env: PaletteEnv) => env.assistant.ask(prompt),
            },
          },
        ]
      : []),
    {
      id: "action:assistant",
      group: "actions",
      title: "Open the assistant",
      hint: "⌘J",
      keywords: ["ask", "chat", "help"],
      home: true,
      run: { kind: "action", perform: (env) => env.assistant.show() },
    },
  ];
};

const FINDS: { category: SearchCategory; title: string; keywords: string[] }[] = [
  { category: "repositories", title: "Find a repository…", keywords: ["repos", "projects"] },
  { category: "issues", title: "Find an issue…", keywords: ["tickets", "tasks", "tracker"] },
  {
    category: "accounts",
    title: "Find a person…",
    keywords: ["people", "users", "members"],
  },
  { category: "packages", title: "Find a package…", keywords: ["registry"] },
  { category: "conversations", title: "Find a conversation…", keywords: ["chats", "assistant"] },
];

/** Search one kind of thing, with more results than instant search shows for each. */
const find: CommandSource = ({ viewer }) =>
  viewer
    ? FINDS.map(({ category, title, keywords }) => ({
        id: `find:${category}`,
        group: "find" as const,
        title,
        keywords: ["search", ...keywords],
        home: true,
        run: { kind: "scope" as const, scope: { kind: "find" as const, category } },
      }))
    : [];

/** The tracker the viewer is in: the one being viewed, or the repository space's. */
export function contextTracker({ pathname, repo, trackers }: PaletteContext) {
  const viewing = /^\/tracker\/([^/?#]+)/.exec(pathname)?.[1];
  const slug = viewing ? decodeURIComponent(viewing) : repo?.space.slug;
  return trackers?.find((tracker) => tracker.slug === slug) ?? null;
}

/**
 * Create issue: opens the tracker's own creator (it validates, retries and
 * creates), never creates from here. One command per tracker the viewer can
 * use, the current one first; with text typed, one more that proposes it as
 * the title, in the current tracker, else the one /tracker opens, else the
 * viewer's own, always named in its hint.
 */
const createIssue: CommandSource = (context) => {
  const { viewer, trackers, query } = context;
  if (!viewer || !trackers?.length) return [];
  const here = contextTracker(context);
  const ordered = [
    ...(here ? [here] : []),
    ...trackers.filter((tracker) => tracker.id !== here?.id),
  ];
  const open = (tracker: SpaceSummary, title: string) => ({
    kind: "navigate" as const,
    to: `/tracker/${encodeURIComponent(tracker.slug)}`,
    state: createIntent(title),
  });
  const target =
    here ??
    trackers.find((tracker) => tracker.id === context.defaultTrackerId) ??
    trackers.find((tracker) => tracker.id === viewer.id) ??
    null;
  // Before anything's typed, only the likeliest tracker; typing finds the rest.
  const commands: Command[] = ordered.map((tracker) => ({
    id: `create:${tracker.id}`,
    group: "actions",
    title: `Create issue in ${tracker.displayName}`,
    hint: tracker.slug,
    keywords: ["new issue", "ticket", "task", tracker.slug],
    home: tracker.id === (target ?? ordered[0])?.id,
    run: open(tracker, ""),
  }));
  // Text that finds one of those commands ("create issue", "new issue in
  // orbit") is looking for them; anything else is offered as a title.
  const proposed = query.trim();
  const naming = commands.some((command) =>
    matchFields(proposed, {
      identifiers: [command.title],
      names: [command.title, "New issue"],
      searched: command.keywords ?? [],
    }),
  );
  // A reference (a SHA, an issue key, #12, pkg@1.0) is somewhere to go, not
  // an issue's title: the palette jumps to it instead (CORE-22).
  if (!proposed || !target || naming || parseRef(proposed)) return commands;
  return [
    {
      id: `create-titled:${target.id}`,
      group: "actions",
      title: `Create issue “${proposed}”`,
      hint: `in ${target.slug}`,
      always: true,
      run: open(target, proposed),
    },
    ...commands,
  ];
};

/**
 * Code and wiki search: semantic, paid and per repository, so it's a mode the
 * person enters and submits, never part of instant search. The current
 * repository directly; elsewhere, pick one first.
 */
const knowledge: CommandSource = ({ viewer, repo }) => {
  if (!viewer) return [];
  const keywords = ["code", "wiki", "knowledge", "semantic", "find in files", "grep"];
  return repo
    ? [
        {
          id: "knowledge:here",
          group: "repository",
          title: "Search code and wiki",
          hint: `${repo.space.slug}/${repo.name}`,
          keywords,
          home: true,
          run: {
            kind: "scope",
            scope: {
              kind: "repo",
              space: repo.space.slug,
              name: repo.name,
              defaultBranch: repo.defaultBranch,
            },
          },
        },
      ]
    : [
        {
          id: "knowledge:pick",
          group: "find",
          title: "Search code and wiki in a repository…",
          keywords,
          home: true,
          run: { kind: "scope", scope: { kind: "pick" } },
        },
      ];
};

/**
 * Switch this page to a timeline, or back to main, in place (CORE-402): what
 * the rail's switcher did before the rail opened the graph.
 */
const switchTimeline: CommandSource = (context) => {
  const { viewer, timelines, repo } = context;
  if (!viewer) return [];
  const here = { pathname: context.pathname, search: context.search ?? "", hash: context.hash };
  const current = scopeOf(here.search);
  // On a code page, the timeline's own source for this repository (as the switcher did).
  const refs = (slug: string | null) =>
    repo
      ? {
          defaultBranch: repo.defaultBranch,
          branches: repo.branches.map((branch) => branch.shortName),
          source: repo.source,
          targetSource: timelines
            ?.find((timeline) => timeline.slug === slug)
            ?.repos.find((r) => r.id === repo.id)?.source,
        }
      : null;
  const commands: Command[] = (timelines ?? [])
    .filter((timeline) => timeline.slug !== current)
    .map((timeline) => {
      const ended = timeline.status === "landed" || timeline.status === "abandoned";
      return {
        id: `timeline:${timeline.slug}`,
        group: "actions",
        title: `Switch to timeline ${timeline.name}`,
        hint: `timeline/${timeline.slug}${ended ? ` · ${timeline.status}` : ""}`,
        keywords: ["timeline", "switch", "scope", timeline.slug],
        run: { kind: "navigate", to: switchScope(here, timeline.slug, refs(timeline.slug)) },
      };
    });
  if (current)
    commands.unshift({
      id: "timeline:main",
      group: "actions",
      title: "Switch back to main",
      hint: `leave timeline/${current}`,
      keywords: ["timeline", "switch", "main", "scope"],
      home: true,
      run: { kind: "navigate", to: switchScope(here, null, refs(null)) },
    });
  return commands;
};

export const COMMAND_SOURCES: readonly CommandSource[] = [
  navigate,
  pages,
  repository,
  knowledge,
  createIssue,
  switchTimeline,
  actions,
  find,
];

export interface MatchedCommand {
  command: Command;
  match: SearchMatch;
}

/**
 * Commands matching `query`, strongest first within each group. For an empty
 * query, the `home` ones, or every one when `everything` (inside Go to).
 */
export function matchCommands(
  commands: Command[],
  query: string,
  { perGroup = 6, everything = false }: { perGroup?: number; everything?: boolean } = {},
): Map<CommandGroup, MatchedCommand[]> {
  const groups = new Map<CommandGroup, MatchedCommand[]>();
  const blank = !query.trim();
  commands.forEach((command) => {
    if (command.always && blank) return;
    if (blank && !everything && !command.home) return;
    const match: SearchMatch | null = blank
      ? "contains"
      : command.always
        ? "contains"
        : matchFields(query, {
            identifiers: [command.title],
            names: [command.title],
            searched: command.keywords ?? [],
          });
    if (!match) return;
    const list = groups.get(command.group) ?? [];
    list.push({ command, match });
    groups.set(command.group, list);
  });
  for (const [group, list] of groups) {
    // Actions on the query itself lead; otherwise strongest match, and the
    // stable sort keeps catalog order for equal matches.
    list.sort(
      (a, b) =>
        Number(!!b.command.always) - Number(!!a.command.always) ||
        MATCH_RANK[a.match] - MATCH_RANK[b.match],
    );
    groups.set(group, blank ? list : list.slice(0, perGroup));
  }
  return groups;
}
