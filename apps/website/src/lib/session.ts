import { redirect, useRouteLoaderData, type ShouldRevalidateFunction } from "react-router";
import type { SessionResponse, Viewer } from "../../shared/api.ts";
import { api, load } from "./api.ts";
import { scopeSpace } from "./timelineScope.ts";

/** Loaders of one navigation share its Request; a new navigation, revalidation or
 * action brings a new one, so the viewer is never reused across them. */
const sessions = new WeakMap<Request, Promise<SessionResponse>>();

// ---- access changes ---------------------------------------------------------
//
// Client caches (repository reads, timeline lists) hold what this browser was
// allowed to read. They are dropped whenever who is signed in, what they hold
// or where their defaults open changes:
//
// - a sign-in, sign-out or account switch in this tab (announceAccessChange),
//   which every other tab of this origin hears too, clearing its caches and
//   reading its root route again;
// - a session read that differs from the one before it: on a navigation, or on
//   returning to the tab (focus or visibility, at most every RECHECK_MS);
// - any read refused as unauthenticated (401), which means the session ended.
//
// Every cache entry is stamped with the access epoch it was read in and is
// served only in that epoch, so nothing read for one identity reaches another.

const accessListeners = new Set<() => void>();
let lastAccess: string | null = null;
let epoch = 0;

/** Run `forget` whenever access may have changed. Returns the unsubscribe. */
export function onAccessChange(forget: () => void): () => void {
  accessListeners.add(forget);
  return () => accessListeners.delete(forget);
}

/** Which identity client caches are for; it changes whenever access may have. */
export function accessEpoch(): number {
  return epoch;
}

/** Drop every client cache in this tab only (a test's new world uses this too). */
export function accessChanged(): void {
  epoch++;
  lastAccess = null;
  lastViewer = null;
  for (const forget of accessListeners) forget();
}

// Other tabs hear of a change through a BroadcastChannel, or where there is
// none through a localStorage write (the `storage` event). Both receivers are
// installed; a message id keeps one change from being handled twice.
const CHANNEL = "gitmatrix:access";
/** The channel (and storage key) in use; a browser test's app gets its own. */
let channelName = CHANNEL;
const sent = new Set<string>();
const heard = new Set<string>();
let channel: BroadcastChannel | null = null;

function openChannel(): BroadcastChannel | null {
  if (channel?.name === channelName) return channel;
  channel?.close();
  channel = null;
  if (typeof BroadcastChannel === "undefined") return null;
  const opened = new BroadcastChannel(channelName);
  // Node (unit tests) would otherwise keep running for the channel.
  (opened as { unref?: () => void }).unref?.();
  opened.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data === "string") received(event.data);
  });
  channel = opened;
  return opened;
}

function received(id: string): void {
  if (sent.has(id) || heard.has(id)) return;
  heard.add(id);
  accessChanged();
  revalidateRoot();
}

/**
 * Who is signed in changed here (sign-in, sign-out, account switch): drop this
 * tab's caches and tell the others. The action's own revalidation reads this
 * tab's session again.
 */
export function announceAccessChange(): void {
  accessChanged();
  const id = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  sent.add(id);
  const open = openChannel();
  if (open) open.postMessage(id);
  else {
    try {
      localStorage.setItem(channelName, id);
    } catch {
      // No storage either: other tabs notice on their next session read.
    }
  }
}

// The root route's revalidation, registered by whoever owns the router
// (router.tsx, or a browser test's renderApp): session.ts can't import it.
let rootRevalidator: (() => void) | null = null;

function revalidateRoot(): void {
  rootRevalidator?.();
}

/** The epoch whose 401 already asked the root to read again. */
let refusedEpoch = -1;

/**
 * A read was refused as unauthenticated: the session ended (signed out or
 * expired elsewhere). Drop every cache and, if someone was signed in as far as
 * this tab knew, read the root again, once per change, so the page shows who
 * is signed in now. Signed out, a private page's 401 is just its answer.
 */
export function accessRefused(): void {
  const signedIn = lastAccess !== null && lastAccess !== ANONYMOUS;
  const first = refusedEpoch !== epoch;
  accessChanged();
  if (signedIn && first) {
    refusedEpoch = epoch;
    revalidateRoot();
  }
}

/** Returning to a tab reads the session again, at most this often... */
const RECHECK_MS = 15_000;
/** ...and gives up on a read that takes longer than this. */
const RECHECK_TIMEOUT_MS = 10_000;
let lastSessionRead = 0;
let rechecking = false;

/**
 * Read the session in the background (focus, visibility) and act on a change.
 * Cache hits don't wait for this read (track): a change it finds empties the
 * caches and reads the root route again, which runs the page's loaders anew.
 */
function recheck(): void {
  if (rechecking || Date.now() - lastSessionRead < RECHECK_MS) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  rechecking = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECHECK_TIMEOUT_MS);
  void track(api<SessionResponse>("/session", { signal: controller.signal }), "recheck")
    .then(noteSession, () => {})
    .finally(() => {
      clearTimeout(timer);
      rechecking = false;
    });
}

/**
 * Keep this tab's caches to the current identity for as long as `router`
 * lives: hear other tabs' changes, re-read the session on returning to the
 * tab, and read the root route again whenever access changed. `name` is the
 * cross-tab channel (a browser test gives each app its own). Returns the
 * teardown.
 */
export function syncAccess(
  router: { revalidate(): Promise<void> | void },
  name = CHANNEL,
): () => void {
  const revalidate = () => void router.revalidate();
  rootRevalidator = revalidate;
  channelName = name;
  openChannel();
  if (typeof window === "undefined")
    return () => {
      if (rootRevalidator === revalidate) rootRevalidator = null;
    };
  const onStorage = (event: StorageEvent) => {
    if (event.key === name && event.newValue) received(event.newValue);
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") recheck();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener("focus", recheck);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    if (rootRevalidator === revalidate) rootRevalidator = null;
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("focus", recheck);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

const ANONYMOUS = "anonymous";

/** Who is signed in, what they hold and where their defaults open, as far as client caches are concerned. */
function accessOf(viewer: Viewer | null): string {
  if (!viewer) return ANONYMOUS;
  return JSON.stringify([
    viewer.id,
    viewer.agent?.id ?? null,
    viewer.isSiteAdmin,
    viewer.organizations.map((organization) => organization.id).sort(),
    viewer.spaces.map((space) => `${space.id}:${space.authorizationVersion}`).sort(),
    viewer.defaultSpaceId,
    viewer.savedDefault.organizationId,
    viewer.savedDefault.spaceId,
  ]);
}

let lastViewer: Viewer | null = null;

/**
 * Record a session read. One that differs from the last means access changed
 * meanwhile (in another tab, or by someone else): every cache goes, and the
 * root route reads again, so loaders that ran alongside this read with what
 * was cached then run again against the empty cache.
 */
function noteSession(session: SessionResponse): void {
  const access = accessOf(session.viewer);
  const changed = lastAccess !== null && lastAccess !== access;
  if (changed) accessChanged();
  lastAccess = access;
  lastViewer = session.viewer;
  if (changed) revalidateRoot();
}

/** A navigation's session read in flight, if any: cache hits wait for it (lib/repoData.ts). */
let pendingSession: Promise<unknown> | null = null;

/**
 * Note when the session was last read. A navigation's read is also what cache
 * hits wait for, since the loaders running alongside it would otherwise serve
 * entries an identity change it finds makes stale; a background recheck isn't
 * (see recheck).
 */
function track(
  session: Promise<SessionResponse>,
  source: "navigation" | "recheck",
): Promise<SessionResponse> {
  if (source === "navigation") pendingSession = session;
  const settle = () => {
    lastSessionRead = Date.now();
    if (pendingSession === session) pendingSession = null;
  };
  session.then(settle, settle);
  return session;
}

/**
 * A navigation's session read still in flight, settled (never rejected) once
 * it has been noted; null when there is none.
 */
export function sessionSettling(): Promise<void> | null {
  const pending = pendingSession;
  return pending
    ? pending.then(
        () => {},
        () => {},
      )
    : null;
}

/**
 * Whether the session last read listed a grant in this Space: a hint for
 * starting a read early, never authorization (the read authorizes itself, and
 * the page's own capabilities decide whether its result is used).
 */
export function likelyGrantedSpace(slug: string): boolean {
  const wanted = slug.toLowerCase();
  return lastViewer?.spaces.some((space) => space.slug.toLowerCase() === wanted) ?? false;
}

/** The navigation's one /api/session read, shared by the root loader and any
 * page loader that needs the viewer. */
export function loadSession(request: Request): Promise<SessionResponse> {
  let session = sessions.get(request);
  if (!session) {
    session = load<SessionResponse>("/session", request);
    void track(session, "navigation").then(noteSession, () => {});
    sessions.set(request, session);
  }
  return session;
}

export async function rootLoader({ request }: { request: Request }): Promise<SessionResponse> {
  return loadSession(request);
}

/**
 * The Space or Organization a page is in, as far as the session's selectors
 * go; "" outside any (Home, settings without a Space, a person's page).
 */
export function sessionScope(url: URL): string {
  const [first, second] = url.pathname.split("/").slice(1);
  if (first === "organizations" && second) return `organization:${decodeURIComponent(second)}`;
  const space = scopeSpace(url.pathname, url.search);
  return space ? `space:${space}` : "";
}

/**
 * When the root reads /api/session again (the viewer with their Organizations
 * and Spaces: the account menu's switchers and admin links):
 *
 * - after any submission (a form or fetcher action: sign-in, sign-out, account
 *   switch, grants, membership, default scope), as React Router does by default;
 * - on an explicit revalidation or a navigation to the same address
 *   (Preferences and Profile revalidate after saving);
 * - on every navigation into another Space or Organization, or into or out of
 *   one, so the selectors are current for the scope being opened.
 *
 * Moving around inside one scope (a tracker's issues, filters and tabs, a
 * repository's files, ?tl=) reuses the read made on entering it: the selectors
 * are navigation, never authority. Every API call authorizes itself, so a grant
 * revoked meanwhile fails that page's own reads, and the next scope change or
 * submission brings the selectors up to date. A page loader that needs the
 * viewer (requireViewer) still reads the session for itself.
 */
export const rootShouldRevalidate: ShouldRevalidateFunction = ({
  formMethod,
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}) => {
  if (formMethod || currentUrl.href === nextUrl.href) return defaultShouldRevalidate;
  return sessionScope(currentUrl) !== sessionScope(nextUrl);
};

export function useViewer(): Viewer | null {
  const session = useRouteLoaderData("root") as SessionResponse | undefined;
  return session?.viewer ?? null;
}

/** For loaders of pages that need someone signed in. */
export async function requireViewer(request: Request): Promise<Viewer> {
  const { viewer } = await loadSession(request);
  if (!viewer) {
    const url = new URL(request.url);
    throw redirect(`/signin?next=${encodeURIComponent(url.pathname + url.search)}`);
  }
  return viewer;
}
