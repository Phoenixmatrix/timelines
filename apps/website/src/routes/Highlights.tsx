import { useEffect, useRef, useState } from "react";
import {
  data,
  Link,
  useLoaderData,
  useLocation,
  useRevalidator,
  type LoaderFunctionArgs,
} from "react-router";
import { releaseLabel, type ReleaseHighlights } from "../../shared/release-notes.ts";
import { Page } from "../components/AppShell.tsx";
import { usePageTitle } from "../components/PageTitle.tsx";
import { api, ApiError } from "../lib/api.ts";
import { timeAgo } from "../lib/format.ts";
import { repoPath } from "../lib/refs.ts";

/** Viewer-specific prose must never be reused from a browser or intermediary cache. */
export async function highlightsLoader({ request, params }: LoaderFunctionArgs) {
  const path = `/tracker/${encodeURIComponent(params.space!)}/release-notes/highlights`;
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const highlights = await api<ReleaseHighlights>(path, {
      signal: request.signal,
      cache: "no-store",
      headers,
    });
    return data(highlights, { headers });
  } catch (error) {
    if (error instanceof ApiError)
      throw data({ message: error.message }, { status: error.status, headers });
    throw error;
  }
}

export function Highlights() {
  const highlights = useLoaderData<typeof highlightsLoader>();
  const revalidator = useRevalidator();
  const currentRevalidator = useRef(revalidator);
  currentRevalidator.current = revalidator;
  const { pathname } = useLocation();
  const [paused, setPaused] = useState(false);
  const pending = highlights.status.state === "generating";
  // Match release-note revalidation, but stop after a minute rather than polling forever.
  useEffect(() => {
    setPaused(false);
    if (!pending) return;
    let ticks = 0;
    const timer = setInterval(() => {
      const current = currentRevalidator.current;
      if (current.state === "idle") void current.revalidate();
      if (++ticks >= 12) {
        clearInterval(timer);
        setPaused(true);
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [pending, pathname]);

  const space = highlights.space;
  const scopeName = space.displayName;
  usePageTitle(`Highlights · ${scopeName}`);
  const detailsPath = `/tracker/${encodeURIComponent(space.slug)}/releases`;
  const ready = highlights.status.state === "ready" && Boolean(highlights.body?.trim());
  const stateMessage =
    highlights.status.state === "disabled"
      ? "Highlights are unavailable. AI release-note writing may be off, or you may need to sign in. Detailed release notes remain available where you have access."
      : pending
        ? paused
          ? "Highlights are still being prepared. Automatic checking has paused; check again in a moment."
          : "Preparing highlights from the daily notes you can access. This may take a moment."
        : highlights.status.state === "failed"
          ? "Highlights could not be generated. Check again later; detailed release notes are still available."
          : "No highlights are available yet. They appear after visible daily release notes have been processed.";

  const content = (
    <div className="min-w-0 max-w-[72ch]">
      <nav
        aria-label="Highlights breadcrumbs"
        className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-ink-muted"
      >
        <Link to={`/tracker/${encodeURIComponent(space.slug)}`}>{scopeName}</Link>
        <span aria-hidden>/</span>
        <Link to={detailsPath}>Release notes</Link>
        <span aria-hidden>/</span>
        <span aria-current="page">Highlights</span>
      </nav>
      <header className="mb-8">
        <h1 className="m-0 text-headline">Highlights</h1>
        <p className="mt-2 mb-0 break-words text-title text-ink">{scopeName}</p>
        <p className="mt-2 mb-0 text-body-sm text-ink-muted">
          A short overview of the past week's daily code updates in this Space, not deployments.
          Highlights refresh on the configured schedule after this page is first opened.
        </p>
      </header>
      {ready ? (
        <article aria-label="Release highlights">
          <p className="m-0 whitespace-pre-wrap break-words text-body leading-relaxed">
            {highlights.body}
          </p>
          <p className="mt-5 mb-0 break-words text-micro text-ink-faint">
            AI-generated overview
            {highlights.status.generatedAt && (
              <>
                {" "}
                · Updated{" "}
                <time dateTime={highlights.status.generatedAt}>
                  {timeAgo(highlights.status.generatedAt)}
                </time>
              </>
            )}
            {highlights.model && <> · {highlights.model.replace("@cf/", "")}</>}
          </p>
        </article>
      ) : (
        <p role="status" className="m-0 py-4 text-body text-ink-muted">
          {stateMessage}
        </p>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Link to={detailsPath} className="mk-btn mk-btn--sm">
          Browse detailed notes
        </Link>
        <button
          type="button"
          className="mk-btn mk-btn--ghost mk-btn--sm"
          disabled={revalidator.state !== "idle"}
          onClick={() => void revalidator.revalidate()}
        >
          {revalidator.state !== "idle" ? "Checking…" : "Check for updates"}
        </button>
      </div>
      {ready && highlights.notes.length > 0 && (
        <section aria-labelledby="highlights-sources" className="mt-10 border-t border-line pt-6">
          <h2 id="highlights-sources" className="m-0 text-title">
            Detailed notes behind this overview
          </h2>
          <p className="mt-2 mb-3 text-body-sm text-ink-muted">
            Read the full daily updates, including their changes and evidence.
          </p>
          <ul className="m-0 list-none p-0">
            {highlights.notes.map((note) => (
              <li key={`${note.repo.space}/${note.repo.name}/${note.release}`}>
                <Link
                  className="inline-flex min-h-11 items-center gap-2 py-2 text-body-sm"
                  to={repoPath(
                    note.repo.space,
                    note.repo.name,
                    "releases",
                    encodeURIComponent(note.release),
                  )}
                >
                  <span className="break-all">
                    {note.repo.space}/{note.repo.name}
                  </span>
                  <span className="shrink-0">{releaseLabel(note.release)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
  return <Page>{content}</Page>;
}
