// What the palette can do without asking the server: go to a page, or run an
// action. Each source returns the commands available to this viewer here; a
// new action (create an issue, ask the assistant) adds a source.

import type { RepoDetail, Viewer } from "../../shared/api.ts";
import { MATCH_RANK, matchFields, type SearchMatch } from "../../shared/search.ts";
import type { TrackerOwner } from "../../shared/tracker.ts";
import { createIntent } from "./intents.ts";
import { packagesPath } from "../lib/packages.ts";
import { repoSections } from "../lib/repoSections.ts";

/** Where the palette was opened. */
export interface PaletteContext {
  viewer: Viewer | null;
  pathname: string;
  /** The repository being viewed, when on one of its pages. */
  repo: RepoDetail | null;
  /** Trackers the viewer can use (GET /api/tracker); null until loaded or signed out. */
  trackers: TrackerOwner[] | null;
  /** The tracker /tracker opens for the viewer: where they last saved defaults. */
  defaultTrackerId?: string | null;
  /** What's typed, for actions that take it as input (a proposed title). */
  query: string;
}

/** What an action can reach when it runs. */
export interface PaletteEnv {
  /** In-app navigation; `state` carries one-shot intents (palette/intents.ts). */
  navigate(to: string, state?: unknown): void;
  assistant: { show(): void; openChat(id: string): void };
}

export type CommandGroup = "pages" | "repository" | "actions";

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
  run:
    | { kind: "navigate"; to: string; state?: unknown }
    | { kind: "action"; perform(env: PaletteEnv): void };
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

/** The app's own places, as the rail and account menu offer them. */
const pages: CommandSource = ({ viewer, pathname }) => {
  if (!viewer)
    return [
      page("home", "Home", "/"),
      page("signin", "Sign in", `/signin?next=${encodeURIComponent(pathname)}`, ["log in"]),
    ];
  return [
    page("home", "Home", "/", ["dashboard"]),
    page("tracker", "Issue tracker", "/tracker", ["issues", "tickets"]),
    page("needs-you", "Needs you", "/needs-you", ["requests", "inbox", "approvals"]),
    page("packages", "Packages", "/packages", ["registry"]),
    page("new", "New repository", "/new", ["create", "import"]),
    page("repos", "Your repositories", `/${viewer.slug}`, ["profile"]),
    page("your-packages", "Your packages", packagesPath(viewer.slug)),
    page("profile", "Profile settings", "/settings/profile", ["account", "username"]),
    page("preferences", "Preferences", "/settings/preferences", [
      "default team",
      "layout",
      "keyboard",
      "shortcuts",
    ]),
    page("settings", "Settings", "/tracker?manage=true", ["teams", "workspaces", "administration"]),
    page("tokens", "Access tokens", "/settings/tokens", ["pat", "api"]),
    page("agents", "Agents", "/settings/agents", ["bots"]),
    page("ssh-keys", "SSH keys", "/settings/ssh-keys"),
    ...(viewer.isSiteAdmin
      ? [page("invites", "Invitations", "/settings/invites", ["invite", "admin"])]
      : []),
  ];
};

/** The current repository's sections, from the same list as its tabs. */
const repository: CommandSource = ({ repo }) =>
  repo
    ? repoSections(repo).map((section) => ({
        id: `repo:${section.id}`,
        group: "repository" as const,
        title: section.label,
        hint: `${repo.owner.slug}/${repo.name}`,
        keywords: section.keywords,
        run: { kind: "navigate" as const, to: section.to },
      }))
    : [];

const actions: CommandSource = ({ viewer }) =>
  viewer
    ? [
        {
          id: "action:assistant",
          group: "actions",
          title: "Open the assistant",
          hint: "⌘J",
          keywords: ["ask", "chat", "help"],
          run: { kind: "action", perform: (env) => env.assistant.show() },
        },
      ]
    : [];

/** The tracker the viewer is in: the one being viewed, or the repository owner's. */
export function contextTracker({ pathname, repo, trackers }: PaletteContext) {
  const viewing = /^\/tracker\/([^/?#]+)/.exec(pathname)?.[1];
  const slug = viewing ? decodeURIComponent(viewing) : repo?.owner.slug;
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
  const open = (tracker: TrackerOwner, title: string) => ({
    kind: "navigate" as const,
    to: `/tracker/${encodeURIComponent(tracker.slug)}`,
    state: createIntent(title),
  });
  const commands: Command[] = ordered.map((tracker) => ({
    id: `create:${tracker.id}`,
    group: "actions",
    title: `Create issue in ${tracker.displayName}`,
    hint: tracker.slug,
    keywords: ["new issue", "ticket", "task", tracker.slug],
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
  const target =
    here ??
    trackers.find((tracker) => tracker.id === context.defaultTrackerId) ??
    trackers.find((tracker) => tracker.id === viewer.id) ??
    null;
  if (!proposed || !target || naming) return commands;
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

export const COMMAND_SOURCES: readonly CommandSource[] = [pages, repository, createIssue, actions];

export interface MatchedCommand {
  command: Command;
  match: SearchMatch;
}

/** Commands matching `query`, strongest first within each group; all of them for an empty query. */
export function matchCommands(
  commands: Command[],
  query: string,
  perGroup = 6,
): Map<CommandGroup, MatchedCommand[]> {
  const groups = new Map<CommandGroup, MatchedCommand[]>();
  const blank = !query.trim();
  commands.forEach((command) => {
    if (command.always && blank) return;
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
