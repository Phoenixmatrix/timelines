import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  isRouteErrorResponse,
  useLocation,
  useMatches,
  useNavigation,
  useRouteError,
  type RouteObject,
  type UIMatch,
} from "react-router";
import type {
  BlobResponse,
  KnowledgeTimelinePage,
  TreeResponse,
  WikiPage,
} from "../../shared/api.ts";
import type { PackageDetail } from "../../shared/packages.ts";
import type { Timeline } from "../../shared/timelines.ts";
import type { TrackerView } from "../../shared/tracker.ts";

const labels: Record<string, string> = {
  home: "Home",
  signin: "Sign in",
  device: "Authorize device",
  ":space/-/repositories/new": "New repository",
  organizations: "Organizations",
  instance: "Instance",
  tracker: "Issues",
  timelines: "Timelines",
  "release-notes": "Release notes",
  packages: "Packages",
  "needs-you": "Needs you",
  "agent-work": "Agent work",
  "-/go/*": "Open reference",
  "settings/agents": "Agents",
  "settings/tokens": "Access tokens",
  "settings/profile": "Profile",
  "settings/skills": "Assistant skills",
  "settings/preferences": "Preferences",
  "settings/ai": "AI settings",
  "settings/ai-providers": "AI providers",
  "settings/site-ai": "Instance AI settings",
  "settings/usage": "Usage and costs",
  "settings/site-usage": "Instance usage and costs",
  "settings/retention": "Data retention",
  "settings/site-retention": "Instance data retention",
  "settings/invites": "Invites",
  "settings/accounts": "Accounts",
  "settings/ssh-keys": "SSH keys",
  "cli-auth/npm/:id": "Authorize npm",
  "tracker/:space": "Issues",
  projects: "Projects",
  teams: "Teams",
  "tracker/:space/releases": "Release notes",
  "tracker/:space/timelines": "Timelines",
  ":space/-/packages": "Packages",
  ":space/-/feeds": "Package feeds",
  ":space/-/atlas": "Atlas scope",
  code: "Code",
  "commits/*": "Commits",
  changes: "Changes",
  knowledge: "Knowledge",
  atlas: "Knowledge",
  ci: "CI",
  settings: "Repository settings",
};

/** Stamp the declared route, not a second URL matcher. Index routes inherit their context. */
export function withPageTitles(routes: RouteObject[], inRepo = false): RouteObject[] {
  return routes.map((route) => {
    const repo = inRepo || route.id === "repo";
    return {
      ...route,
      handle: {
        ...route.handle,
        pageTitle: route.index ? (repo ? "code" : "home") : route.path,
      },
      ...(route.children ? { children: withPageTitles(route.children, repo) } : {}),
    } as RouteObject;
  });
}

function join(...parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(" · ");
}

// Projection of existing loader values; the declared route is the discriminator.
interface RouteTitleData {
  displayName?: string;
  space?: { displayName: string };
  organization?: { displayName: string };
  tree?: TreeResponse | null;
  blob?: BlobResponse;
  page?: WikiPage | null;
  timelinePage?: KnowledgeTimelinePage | null;
  name?: string | null;
  detail?: PackageDetail;
  timeline?: Timeline;
}

interface TitleHandle {
  pageTitle?: string;
}

function titleKind(match: UIMatch): string | undefined {
  // withPageTitles owns the handle on every application route.
  const handle = match.handle as TitleHandle | undefined;
  return handle?.pageTitle;
}

function routeTitle(matches: UIMatch[], search: string): string {
  const match = matches.findLast((item) => titleKind(item));
  if (!match) return "Page unavailable";
  const kind = titleKind(match)!;
  const { space, repo, number, slug, person, organization } = match.params;
  const data = match.loaderData as RouteTitleData | undefined;
  const resource = repo ? `${space}/${repo}` : space;
  const scope = new URLSearchParams(search).get("tl");
  const timeline = scope && scope !== "main" && space ? `Timeline ${scope}` : null;
  const label = labels[kind];
  switch (kind) {
    case ":space": {
      return join(data?.space?.displayName, space, "Space");
    }
    case "accounts/:person":
      return join(data?.displayName, person, "Account");
    case "organizations/:organization":
      return join(data?.organization?.displayName, organization, "Organization");
    case ":space/:repo":
      return join(resource, "Code", timeline);
    case "tree/*":
    case "code": {
      return join(data?.tree?.path, resource, "Code", timeline);
    }
    case "blob/*": {
      return join(data?.blob?.path, resource, "File", timeline);
    }
    case "ci/:number":
      return join(resource, `CI #${number}`, timeline);
    case "wiki/*": {
      const page = data?.timelinePage?.outcome === "written" ? data.timelinePage : data?.page;
      return join(page?.title, resource, "Wiki", timeline);
    }
    case "releases/*": {
      return join(data?.name, resource, "Releases", timeline);
    }
    case ":space/-/packages/:format/*": {
      return join(data?.detail?.package.name, "Packages", space, match.params.format);
    }
    case "tracker/:space/timelines/:slug/changes": {
      return join(data?.timeline?.name ?? slug, "Changes", space);
    }
    case "tracker/:space/timelines/:slug/story": {
      return join(data?.timeline?.name ?? slug, "Story", space);
    }
    case "issues/:issue": {
      const tracker = matches.find((item) => titleKind(item) === "tracker/:space");
      const view = tracker?.loaderData as TrackerView | undefined;
      const issue = view?.snapshot.issues.find(
        (item) => item.id === match.params.issue || item.key === match.params.issue,
      );
      return issuePageTitle(issue, space ?? "", view?.snapshot.timeline?.name);
    }
    case "*":
      return "Page not found";
    default:
      return join(resource, label ?? "Page", timeline);
  }
}

/** Shared by the loader fallback and the tracker snapshot, including deletion/live edits. */
export function issuePageTitle(
  issue: { key: string; title: string } | null | undefined,
  space: string,
  timeline?: string,
): string {
  return join(
    issue ? `${issue.key} ${issue.title}` : "Issue unavailable",
    "Issues",
    space,
    timeline,
  );
}

type Override = { key: string; title: string };
const TitleContext = createContext<Dispatch<SetStateAction<Override | null>> | null>(null);

/** Publish data already owned by a mounted page. Location keys prevent stale overrides. */
export function usePageTitle(title: string | null): void {
  const publish = useContext(TitleContext);
  const { key } = useLocation();
  useLayoutEffect(() => {
    if (!publish || title === null) return;
    const value = { key, title };
    publish(value);
    return () => publish((current) => (current === value ? null : current));
  }, [key, title, publish]);
}

/** Mounted around the shell, so titles survive leaf loaders and route errors. */
export function PageTitle({
  children,
  loading = false,
}: {
  children: ReactNode;
  loading?: boolean;
}) {
  const matches = useMatches();
  const location = useLocation();
  const navigation = useNavigation();
  const [override, publish] = useState<Override | null>(null);
  // Never expose the previous page's name while the next page is being authorized.
  const title =
    loading || navigation.state !== "idle"
      ? "Loading"
      : override?.key === location.key
        ? override.title
        : routeTitle(matches, location.search);
  useLayoutEffect(() => {
    document.title = join(title, "Timelines");
  }, [title]);
  return <TitleContext.Provider value={publish}>{children}</TitleContext.Provider>;
}

/** Errors deliberately omit URL/resource names: even the URL may name a private resource. */
export function PageTitleError({ children }: { children: ReactNode }) {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  usePageTitle(
    status === 404
      ? "Page not found"
      : status === 401
        ? "Sign in required"
        : status === 403
          ? "Access denied"
          : "Page unavailable",
  );
  return children;
}
