import { redirect, useRouteLoaderData } from "react-router";
import type { SessionResponse, Viewer } from "../../shared/api.ts";
import { load } from "./api.ts";

/** Loaders of one navigation share its Request; a new navigation, revalidation or
 * action brings a new one, so the viewer is never reused across them. */
const sessions = new WeakMap<Request, Promise<SessionResponse>>();

/** The navigation's one /api/session read, shared by the root loader (which
 * revalidates on every navigation) and any page loader that needs the viewer. */
export function loadSession(request: Request): Promise<SessionResponse> {
  let session = sessions.get(request);
  if (!session) {
    session = load<SessionResponse>("/session", request);
    sessions.set(request, session);
  }
  return session;
}

export async function rootLoader({ request }: { request: Request }): Promise<SessionResponse> {
  return loadSession(request);
}

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
