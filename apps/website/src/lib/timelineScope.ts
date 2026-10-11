// The app-wide timeline scope (CORE-82; TIMELINES-RESEARCH.md, "Visualization
// and switching timelines"). `?tl=<slug>` scopes every surface to main plus
// that timeline's work: the tracker shows the timeline's view, the code
// browser opens its bookmark, CI lists runs on it, the package console filters
// to versions built from it, knowledge overlays its graph diff and release
// notes filter to what it landed. No `tl` is main, the default; `tl=main` names
// main explicitly, which is how a link leaves a timeline.
//
// The scope is carried, not remembered: every link's href carries the current
// one (router.createHref), and so does every in-app navigation that doesn't
// name one (timelineScopeMiddleware), so the address bar is always shareable.
// Going back or reloading keeps whatever the URL says.

import { redirect, replace, type DataRouter, type MiddlewareFunction } from "react-router";
import type { CodeSource } from "../../shared/code-source.ts";

export const SCOPE_PARAM = "tl";
const MAIN = "main";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The timeline a search string scopes to; null for main. */
export function scopeOf(search: string | URLSearchParams): string | null {
  const tl = new URLSearchParams(search).get(SCOPE_PARAM);
  return tl && tl !== MAIN && SLUG.test(tl) ? tl : null;
}

/** The bookmark a timeline's work lives on in each repository it touches. */
export function scopeBookmark(slug: string): string {
  return `timeline/${slug}`;
}

function split(href: string): { path: string; params: URLSearchParams; hash: string } {
  const hashAt = href.indexOf("#");
  const hash = hashAt === -1 ? "" : href.slice(hashAt);
  const rest = hashAt === -1 ? href : href.slice(0, hashAt);
  const queryAt = rest.indexOf("?");
  return {
    path: queryAt === -1 ? rest : rest.slice(0, queryAt),
    params: new URLSearchParams(queryAt === -1 ? "" : rest.slice(queryAt + 1)),
    hash,
  };
}

function join(path: string, params: URLSearchParams, hash: string): string {
  const query = params.toString();
  return `${path}${query ? `?${query}` : ""}${hash}`;
}

/** `href` scoped to a timeline, or to main (null), written explicitly. */
export function withScope(href: string, slug: string | null): string {
  const { path, params, hash } = split(href);
  params.set(SCOPE_PARAM, slug ?? MAIN);
  if (!slug) params.delete("source");
  return join(path, params, hash);
}

/** An in-app href with the current scope, unless it names one itself. */
export function carryScope(href: string, current: string | null): string {
  if (!current || !href.startsWith("/") || href.startsWith("//") || href.startsWith("/api/"))
    return href;
  const { path, params, hash } = split(href);
  if (params.has(SCOPE_PARAM)) return href;
  params.set(SCOPE_PARAM, current);
  return join(path, params, hash);
}

/** `/:owner/:repo/knowledge` used `?timeline=` before the switcher (CORE-83). */
const KNOWLEDGE = /^\/[^/]+\/[^/]+\/knowledge\/?$/;

/**
 * Where a navigation should go instead, or null to let it be. `from` is the
 * page being left on a push; null when the target is already in the address
 * bar (going back or forward, reloading, the first load), so history keeps
 * what it recorded.
 */
export function scopeRedirect(
  target: { pathname: string; search: string; hash?: string },
  from: { search: string } | null,
): { to: string; replace: boolean } | null {
  const params = new URLSearchParams(target.search);
  if (KNOWLEDGE.test(target.pathname) && params.has("timeline")) {
    const legacy = params.get("timeline");
    params.delete("timeline");
    if (!params.has(SCOPE_PARAM)) params.set(SCOPE_PARAM, legacy || MAIN);
    return { to: join(target.pathname, params, target.hash ?? ""), replace: true };
  }
  if (!from || params.has(SCOPE_PARAM)) return null;
  const current = scopeOf(from.search);
  if (!current) return null;
  params.set(SCOPE_PARAM, current);
  return { to: join(target.pathname, params, target.hash ?? ""), replace: false };
}

/**
 * Root middleware: navigations that don't name a scope keep the current one,
 * and old Knowledge links are rewritten. Only GET navigations; forms posting
 * to actions are left alone (the action's redirect is a navigation of its own).
 */
export const timelineScopeMiddleware: MiddlewareFunction = ({ request }, next) => {
  if (request.method === "GET" && typeof window !== "undefined") {
    const target = new URL(request.url);
    const here = window.location;
    const pushing = target.pathname + target.search !== here.pathname + here.search;
    const instead = scopeRedirect(target, pushing ? here : null);
    if (instead) throw instead.replace ? replace(instead.to) : redirect(instead.to);
  }
  return next();
};

/** Every link's href carries the scope of the page it's on (see the header). */
export function scopeLinks(router: DataRouter): void {
  const createHref = router.createHref.bind(router);
  router.createHref = (location) =>
    carryScope(createHref(location), scopeOf(router.state.location.search));
}

/** First path segments that are the app's own places, not accounts. */
const PLACES = new Set([
  "",
  "api",
  "cli-auth",
  "device",
  "highlights",
  "needs-you",
  "new",
  "packages",
  "settings",
  "signin",
  "tracker",
]);

/**
 * The account whose timelines a page is about: the tracker's owner, or the
 * account in the path (`/:owner`, `/:owner/:repo/...`, `/:owner/-/...`), or
 * settings' account context. Null on pages that belong to no account.
 */
export function scopeOwner(pathname: string, search = ""): string | null {
  const [first = "", second] = pathname.split("/").slice(1);
  if (first === "tracker") return second ? decodeURIComponent(second) : null;
  if (first === "settings") {
    const params = new URLSearchParams(search);
    return (
      params.get("owner") ?? (pathname === "/settings/preferences" ? params.get("tracker") : null)
    );
  }
  return PLACES.has(first) ? null : decodeURIComponent(first);
}

/** The repository a code page is about, and the ref named in its path. */
const CODE = /^\/([^/]+)\/([^/]+)\/(tree|blob|commits)\/(.+)$/;
const RELEASES = /^\/(?:tracker\/[^/]+|[^/]+\/[^/]+)\/releases(?:\/|$)/;

/**
 * The current page scoped to another timeline (null: main). A code page whose
 * path names main or the old timeline's bookmark follows to the new one's,
 * falling back to the default branch where the repository has no bookmark.
 */
export function switchScope(
  location: { pathname: string; search: string; hash?: string },
  slug: string | null,
  repo?: {
    defaultBranch: string;
    branches: string[];
    source?: CodeSource;
    targetSource?: CodeSource;
  } | null,
): string {
  let pathname = location.pathname;
  const code = repo ? CODE.exec(pathname) : null;
  if (repo && code) {
    const [, owner, name, view, tail] = code as unknown as [string, string, string, string, string];
    const old = scopeOf(location.search);
    const from = [
      repo.defaultBranch,
      ...(repo.source ? [repo.source.ref.replace(/^refs\/heads\//, "")] : []),
      ...(old ? [scopeBookmark(old)] : []),
    ].find((ref) => tail === ref || tail.startsWith(`${ref}/`));
    if (from) {
      const bookmark = slug
        ? (repo.targetSource?.ref.replace(/^refs\/heads\//, "") ?? scopeBookmark(slug))
        : null;
      const to =
        bookmark && (repo.targetSource || repo.branches.includes(bookmark))
          ? bookmark
          : repo.defaultBranch;
      pathname = `/${owner}/${name}/${view}/${to}${tail.slice(from.length)}`;
    }
  }
  const params = new URLSearchParams(location.search);
  params.delete("source");
  if (
    slug &&
    !RELEASES.test(pathname) &&
    repo?.targetSource &&
    repo.targetSource.sourceId !== "canonical"
  ) {
    params.set("source", repo.targetSource.sourceId);
  }
  return withScope(join(pathname, params, location.hash ?? ""), slug);
}

/**
 * What an ended timeline's scope means, after the banner's status (CORE-74):
 * its view is read-only, on every page. The tracker adds what that means for
 * its issues.
 */
export function endedHint(status: "landed" | "abandoned", pathname: string): string {
  const tracker = /^\/tracker\/[^/]+(\/issues\/[^/]+)?\/?$/.test(pathname);
  if (status === "abandoned")
    return tracker
      ? "read-only, its issues as it left them. Main has its finished work back to do."
      : "read-only; progress history remains available until source retention expires.";
  return "read-only while retained; the approved result is on main and progress history has separate retention.";
}

/** What the scope means on the page you're on, for the banner. */
export function scopeHint(
  pathname: string,
  slug: string,
  repoHasBookmark?: boolean,
  status?: string,
): string {
  if (RELEASES.test(pathname))
    return "Only landed release notes from this timeline. Main shows all notes, including landed timelines.";
  if (status === "landed" || status === "abandoned") return endedHint(status, pathname);
  const bookmark = scopeBookmark(slug);
  const parts = pathname.split("/").slice(1);
  if (parts[0] === "tracker") {
    if (parts[2] === "timelines")
      return "Drawn with the timelines it came from and everything that depends on it.";
    return "Main's issues with this timeline's changes; what you change here stays in it until it lands.";
  }
  if (parts[1] === "-" && parts[2] === "packages" && parts.length > 3)
    return `Versions built from ${bookmark}.`;
  if (parts.length >= 2 && !PLACES.has(parts[0]!) && parts[1] !== "-") {
    const section = parts[2] ?? "";
    if (section === "knowledge")
      return "Main's graph, with what this timeline adds, changes and removes.";
    if (repoHasBookmark === false && ["", "tree", "commits", "ci"].includes(section))
      return `This repository isn't part of the timeline; showing main.`;
    if (section === "ci") return "Runs in this timeline's work source.";
    if (section === "" || section === "tree" || section === "blob" || section === "commits")
      return "Code in this timeline's work source, unless the path pins another commit.";
  }
  return "Main plus this timeline's work.";
}

/** The timeline's bookmark in a repository, if the timeline touches it. */
export function bookmarkIn(
  repo: { branches: { shortName: string }[]; source?: CodeSource },
  slug: string | null,
): string | null {
  if (!slug) return null;
  if (repo.source?.kind === "timeline-work") return repo.source.ref.replace(/^refs\/heads\//, "");
  const bookmark = scopeBookmark(slug);
  return repo.branches.some((branch) => branch.shortName === bookmark) ? bookmark : null;
}
