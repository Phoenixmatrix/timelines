import { useEffect, useState } from "react";
import { Form, Link, useSearchParams } from "react-router";
import type {
  SemanticFeedResponse,
  SemanticLanguage,
  SemanticSource,
} from "../../../shared/semantic/types.ts";
import { HighlightedSource } from "../../components/HighlightedSource.tsx";
import { link } from "../../components/ui.tsx";
import { api } from "../../lib/api.ts";
import { firstLine, fullDate, shortOid } from "../../lib/format.ts";
import { repoPath } from "../../lib/refs.ts";
import { useRepo } from "./RepoLayout.tsx";

const languages: SemanticLanguage[] = [
  "typescript",
  "tsx",
  "rust",
  "python",
  "go",
  "markdown",
  "xml",
  "json",
  "html",
  "css",
];
const entities = [
  "symbol",
  "parameter",
  "call",
  "argument",
  "import",
  "section",
  "link",
  "element",
  "attribute",
  "property",
  "rule",
  "declaration",
  "text",
];
const kinds = [
  ...entities.flatMap((entity) =>
    ["added", "removed", "changed", "renamed"].map((action) => `${entity}.${action}`),
  ),
  "symbol.signature_changed",
];

function sourceLink(value: string | null, base: string): string | null {
  return value?.startsWith(`${base}/`) && !/[\\\r\n]/.test(value) ? value : null;
}

function Excerpt({
  label,
  source,
  href,
}: {
  label: string;
  source: SemanticSource | null;
  href: string | null;
}) {
  return (
    <section className="min-w-0 bg-sunken">
      <h4 className="m-0 flex flex-wrap items-baseline gap-x-2 px-3 py-2 text-body-sm font-semibold">
        {label}
        {source &&
          (href ? (
            <Link className={`${link} break-all font-normal`} to={href}>
              {source.path}:{source.start.line}:{source.start.column}
            </Link>
          ) : (
            <span className="break-all font-normal">
              {source.path}:{source.start.line}:{source.start.column}
            </span>
          ))}
      </h4>
      {source ? (
        <>
          <pre
            className="m-0 overflow-x-auto px-3 pb-3 font-mono text-body-sm leading-5"
            tabIndex={0}
            aria-label={`${label} source excerpt`}
          >
            <code>
              <HighlightedSource text={source.text} tokens={source.tokens} />
            </code>
          </pre>
          {source.truncated && (
            <p className="m-0 px-3 pb-3 text-body-sm text-ink-muted">
              Excerpt truncated. Open the source location to read more.
            </p>
          )}
        </>
      ) : (
        <p className="m-0 px-3 pb-3 text-body-sm text-ink-faint">
          Not present {label.toLowerCase()} this change.
        </p>
      )}
    </section>
  );
}

type FeedState = { query: string; feed: SemanticFeedResponse | null; error: string | null };

export function SemanticChanges() {
  const repo = useRepo();
  const [searchParams] = useSearchParams();
  const base = repoPath(repo.owner.slug, repo.name);
  const queryParams = new URLSearchParams();
  for (const key of ["ref", "cursor", "path", "kind", "language"]) {
    const value = searchParams.get(key);
    if (value) queryParams.set(key, value);
  }
  if (!queryParams.has("ref")) queryParams.set("ref", repo.defaultBranch);
  queryParams.set("limit", "30");
  const query = `${base}/semantic?${queryParams}`;
  const [state, setState] = useState<FeedState | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState(null);
    api<SemanticFeedResponse>(`/repos${query}`, { signal: controller.signal }).then(
      (feed) => {
        if (!controller.signal.aborted) setState({ query, feed, error: null });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            query,
            feed: null,
            error: error instanceof Error ? error.message : "Unable to load semantic changes.",
          });
      },
    );
    return () => controller.abort();
  }, [query, retry]);
  const current = state?.query === query ? state : null;
  const feed = current?.feed;
  const loading = current === null;
  function pageUrl(cursor: string | null) {
    const next = new URLSearchParams(searchParams);
    next.delete("cursor");
    if (cursor) next.set("cursor", cursor);
    return `${base}/changes${next.size ? `?${next}` : ""}`;
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h2 className="m-0 text-title">Semantic changes</h2>
        <p className="mt-2 mb-0 max-w-[72ch] text-body-sm text-ink-muted">
          Work in progress. Individual syntax changes across first-parent history, alongside the
          existing Git views. These describe source structure, not resolved types or author intent.
        </p>
      </header>
      <Form
        method="get"
        action={`${base}/changes`}
        key={searchParams.toString()}
        className="flex flex-wrap items-end gap-3"
        role="search"
        aria-label="Filter semantic changes"
      >
        <label className="flex min-w-0 flex-col gap-1 text-body-sm">
          Ref
          <input
            className="mk-input"
            name="ref"
            defaultValue={searchParams.get("ref") ?? repo.defaultBranch}
            placeholder="Branch, tag, or commit"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-body-sm">
          Exact file path
          <input
            className="mk-input"
            name="path"
            defaultValue={searchParams.get("path") ?? ""}
            placeholder="All files"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-body-sm">
          Change kind
          <select className="mk-input" name="kind" defaultValue={searchParams.get("kind") ?? ""}>
            <option value="">All kinds</option>
            {kinds.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-body-sm">
          Language
          <select
            className="mk-input"
            name="language"
            defaultValue={searchParams.get("language") ?? ""}
          >
            <option value="">All languages</option>
            {languages.map((language) => (
              <option key={language} value={language}>
                {language}
              </option>
            ))}
          </select>
        </label>
        <button className="mk-btn mk-btn--primary" type="submit">
          Apply filters
        </button>
        <Link className={link} to={`${base}/changes`}>
          Clear filters
        </Link>
      </Form>
      <div aria-busy={loading} className="flex min-w-0 flex-col gap-4">
        {loading && (
          <p role="status" className="text-ink-muted">
            Loading semantic changes…
          </p>
        )}
        {current?.error && (
          <div role="alert" className="mk-empty">
            <p className="mt-0">Could not load semantic changes: {current.error}</p>
            <button type="button" className="mk-btn" onClick={() => setRetry((value) => value + 1)}>
              Try again
            </button>
            {searchParams.has("cursor") && (
              <Link className={`${link} ml-3`} to={pageUrl(null)}>
                Restart from latest
              </Link>
            )}
          </div>
        )}
        {feed && (
          <>
            <p role="status" className="m-0 text-body-sm text-ink-muted">
              {feed.entries.length} changes on this page · Ref <bdi>{feed.ref}</bdi>
              {feed.head && (
                <>
                  {" "}
                  · Snapshot <code title={feed.head}>{shortOid(feed.head)}</code>
                </>
              )}
            </p>
            {feed.entries.length === 0 && (
              <div className="mk-empty">
                {!feed.head
                  ? "This repository has no commits yet."
                  : feed.nextCursor
                    ? "No matching changes in this portion of history. Continue to scan older history."
                    : "No matching semantic changes in the remaining history."}
              </div>
            )}
            <ol className="m-0 list-none divide-y divide-line-soft rounded-pane bg-pane p-0">
              {feed.entries.map((entry) => {
                const commitHref = sourceLink(entry.links.commit, base);
                return (
                  <li key={entry.id} className="min-w-0 p-4">
                    <article className="flex min-w-0 flex-col gap-3">
                      <div>
                        <h3 className="m-0 break-words text-title" dir="auto">
                          {entry.summary}
                        </h3>
                        <p className="mt-1 mb-0 flex flex-wrap gap-x-3 gap-y-1 text-body-sm text-ink-muted">
                          <span>{entry.kind}</span>
                          <span>{entry.language}</span>
                          {entry.scope && <span className="break-all">Scope: {entry.scope}</span>}
                          <span>Syntax evidence</span>
                        </p>
                        <p className="mt-2 mb-0 break-words text-body-sm text-ink-muted">
                          {commitHref ? (
                            <Link to={commitHref} className={link}>
                              <code>{shortOid(entry.commit.oid)}</code>{" "}
                              {firstLine(entry.commit.message)}
                            </Link>
                          ) : (
                            <span>
                              {shortOid(entry.commit.oid)} {firstLine(entry.commit.message)}
                            </span>
                          )}
                          {entry.commit.landing && (
                            <>
                              {" · landed "}
                              <span className="font-mono">
                                {entry.commit.landing.branch ??
                                  entry.commit.landing.merged.map(shortOid).join(", ")}
                              </span>
                            </>
                          )}
                          {" · "}
                          <bdi>{entry.commit.authorName}</bdi>
                          {" · "}
                          <time dateTime={entry.commit.authoredAt}>
                            {fullDate(entry.commit.authoredAt)}
                          </time>
                        </p>
                      </div>
                      <div className="grid min-w-0 gap-2 lg:grid-cols-2">
                        <Excerpt
                          label="Before"
                          source={entry.before}
                          href={sourceLink(entry.links.before, base)}
                        />
                        <Excerpt
                          label="After"
                          source={entry.after}
                          href={sourceLink(entry.links.after, base)}
                        />
                      </div>
                    </article>
                  </li>
                );
              })}
            </ol>
            <details className="rounded-pane bg-pane p-4">
              <summary className="cursor-pointer font-semibold">
                Analysis coverage ({feed.coverage.length} files in this page’s scan)
              </summary>
              <p className="text-body-sm text-ink-muted">
                Coverage is separate from the change filters. Unsupported, binary, oversized, or
                invalid source is not treated as analyzed. Syntax analysis does not resolve types or
                references.
              </p>
              {feed.coverage.length === 0 ? (
                <p className="text-body-sm text-ink-muted">
                  No file analysis results in this page’s scan.
                </p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-3 p-0">
                  {feed.coverage.map((item, index) => (
                    <li
                      key={`${item.commit}:${item.path}:${index}`}
                      className="break-words text-body-sm"
                    >
                      <code className="break-all">{item.path}</code>
                      {" · "}
                      <code>{shortOid(item.commit)}</code>
                      {" · "}
                      <strong>{item.status.replaceAll("_", " ")}</strong>
                      {item.diagnostics.map((diagnostic, diagnosticIndex) => (
                        <p key={diagnosticIndex} className="mt-1 mb-0 text-ink-muted">
                          {diagnostic.message}
                        </p>
                      ))}
                    </li>
                  ))}
                </ul>
              )}
            </details>
            <nav aria-label="Semantic change pages" className="flex flex-wrap gap-3">
              {searchParams.has("cursor") && (
                <Link className="mk-btn no-underline" to={pageUrl(null)}>
                  Back to latest
                </Link>
              )}
              {feed.nextCursor && (
                <Link className="mk-btn no-underline" to={pageUrl(feed.nextCursor)}>
                  Continue to older changes
                </Link>
              )}
              {!feed.nextCursor && feed.head && (
                <p className="m-0 self-center text-body-sm text-ink-faint">
                  End of first-parent history.
                </p>
              )}
            </nav>
          </>
        )}
      </div>
    </div>
  );
}
