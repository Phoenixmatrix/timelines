// What the palette can do without asking the server: go to a page, or run an
// action. Each source returns the commands available to this viewer here; a
// new action (create an issue, ask the assistant) adds a source.

import type { RepoDetail, Viewer } from "../../shared/api.ts";
import { MATCH_RANK, matchFields, type SearchMatch } from "../../shared/search.ts";
import { packagesPath } from "../lib/packages.ts";
import { repoSections } from "../lib/repoSections.ts";

/** Where the palette was opened. */
export interface PaletteContext {
  viewer: Viewer | null;
  pathname: string;
  /** The repository being viewed, when on one of its pages. */
  repo: RepoDetail | null;
}

/** What an action can reach when it runs. */
export interface PaletteEnv {
  navigate(to: string): void;
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
  run: { kind: "navigate"; to: string } | { kind: "action"; perform(env: PaletteEnv): void };
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

export const COMMAND_SOURCES: readonly CommandSource[] = [pages, repository, actions];

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
    const match: SearchMatch | null = blank
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
    // Stable sort: equal matches keep catalog order.
    list.sort((a, b) => MATCH_RANK[a.match] - MATCH_RANK[b.match]);
    groups.set(group, blank ? list : list.slice(0, perGroup));
  }
  return groups;
}
