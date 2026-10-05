// /-/go/<ref> (CORE-22): open whatever a ref names, for links from plain text,
// the CLI and the palette. One match redirects straight there; several get a
// chooser; none says so, without guessing at another tracker's key.

import { Link, redirect, useLoaderData, type LoaderFunctionArgs } from "react-router";
import type { RefContext, RefResolution, ResolveRefsResponse } from "../../shared/refs.ts";
import { Page } from "../components/AppShell.tsx";
import { api } from "../lib/api.ts";
import { useViewer } from "../lib/session.ts";

const KIND_LABEL = {
  issue: "Issue",
  commit: "Commit",
  repo: "Repository",
  package: "Package",
} as const;

export async function goLoader({ params, request }: LoaderFunctionArgs) {
  const ref = (params["*"] ?? "").trim();
  const url = new URL(request.url);
  const context: RefContext = {};
  for (const key of ["owner", "repo", "tracker"] as const) {
    const value = url.searchParams.get(key);
    if (value) context[key] = value;
  }
  if (!ref) return { ref, resolution: null, failed: false };
  try {
    const { results } = await api<ResolveRefsResponse>("/refs/resolve", {
      method: "POST",
      json: { refs: [ref], context },
      signal: request.signal,
    });
    const resolution: RefResolution | null = results[0] ?? null;
    if (resolution?.status === "resolved") throw redirect(resolution.target.path);
    return { ref, resolution, failed: false };
  } catch (error) {
    if (error instanceof Response) throw error;
    return { ref, resolution: null, failed: true };
  }
}

export function GoPage() {
  const { ref, resolution, failed } = useLoaderData<typeof goLoader>();
  const viewer = useViewer();
  const candidates = resolution?.status === "ambiguous" ? resolution.candidates : [];
  return (
    <Page>
      <h1 className="m-0 text-headline">
        {candidates.length ? (
          <>
            <span className="font-mono">{ref}</span> could be several things
          </>
        ) : (
          <>
            Nothing here matches <span className="font-mono">{ref || "that"}</span>
          </>
        )}
      </h1>
      {candidates.length ? (
        <ul className="mt-6 mb-0 list-none divide-y divide-line-soft overflow-hidden rounded-pane bg-pane p-0">
          {candidates.map((target) => (
            <li key={target.path}>
              <Link
                to={target.path}
                className="flex min-h-11 flex-col justify-center px-4 py-2.5 text-ink no-underline hover:bg-raised"
              >
                <span className="font-semibold">{target.label}</span>
                <span className="text-body-sm text-ink-faint">
                  {KIND_LABEL[target.kind]}
                  {target.kind === "issue" ? ` in the ${target.tracker} tracker` : ""}
                  {target.kind === "package" ? ` in ${target.owner}'s packages` : ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 mb-0 max-w-[60ch] text-ink-muted">
          {failed
            ? "Couldn't look that up right now. Try again in a moment."
            : viewer
              ? "It isn't an issue, commit, repository or package you can open here. Keys from other trackers aren't guessed at."
              : "It isn't anything public. Sign in to open issues and private repositories."}
        </p>
      )}
    </Page>
  );
}
