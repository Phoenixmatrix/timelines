import { redirect, useRouteLoaderData } from "react-router";
import type { SessionResponse, Viewer } from "../../shared/api.ts";
import { load } from "./api.ts";

export async function rootLoader({ request }: { request: Request }): Promise<SessionResponse> {
  return load<SessionResponse>("/session", request);
}

export function useViewer(): Viewer | null {
  const session = useRouteLoaderData("root") as SessionResponse | undefined;
  return session?.viewer ?? null;
}

/** For loaders of pages that need a signed-in persona. */
export async function requireViewer(request: Request): Promise<Viewer> {
  const { viewer } = await load<SessionResponse>("/session", request);
  if (!viewer) {
    const url = new URL(request.url);
    throw redirect(`/signin?next=${encodeURIComponent(url.pathname + url.search)}`);
  }
  return viewer;
}
