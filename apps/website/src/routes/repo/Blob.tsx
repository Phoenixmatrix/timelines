import { CopyIcon, LinkSimpleIcon, MapTrifoldIcon, PackageIcon } from "@phosphor-icons/react";
import { Suspense, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  Await,
  Link,
  useLoaderData,
  useLocation,
  useNavigate,
  type LoaderFunctionArgs,
} from "react-router";
import type { BlobResponse, GraphNodeDetail, RepoDetail } from "../../../shared/api.ts";
import { HighlightedSource } from "../../components/HighlightedSource.tsx";
import { FileRow, RailSection, railClass } from "../../components/Rail.tsx";
import { link, useToast } from "../../components/ui.tsx";
import { bytes } from "../../lib/format.ts";
import { lineAnchor, parseLineAnchor } from "../../lib/lineAnchors.ts";
import { findDefinitions } from "../../lib/outline.ts";
import { blobUrl, repoPath } from "../../lib/refs.ts";
import { repoData, routeData } from "../../lib/repoData.ts";
import { useSourceHighlight } from "../../lib/useSourceHighlight.ts";
import { RefBar } from "./RefPicker.tsx";
import { useRepo } from "./RepoLayout.tsx";

export async function blobLoader({ params }: LoaderFunctionArgs) {
  const owner = params.owner ?? "";
  const name = params.repo ?? "";
  const blob = await routeData(repoData.blob(owner, name, params["*"] ?? ""));
  // The graph rail is extra: it streams in beside the code and never holds up
  // the file. No node (404) or no graph yet resolves to null.
  const knowledge = repoData.graphNode(owner, name, `file:${blob.path}`).catch(() => null);
  return { blob, knowledge };
}

export function Blob() {
  const { blob, knowledge } = useLoaderData<typeof blobLoader>();
  const repo = useRepo();
  const navigate = useNavigate();
  const { hash, search } = useLocation();
  const lines = useMemo(() => blob.text?.replace(/\n$/, "").split("\n") ?? [], [blob.text]);
  const highlights = useSourceHighlight(blob);
  const fileName = blob.path.split("/").pop();

  const selection = parseLineAnchor(hash, lines.length);
  const start = selection?.start;
  const end = selection?.end;
  const toast = useToast();
  const anchor = useRef<{ file: string; hash: string; line: number } | null>(null);
  const file = `${repo.id}:${blob.ref}:${blob.path}`;
  const [rangeOrigin, setRangeOrigin] = useState<{ file: string; hash: string } | null>(null);
  const extending = rangeOrigin?.file === file && rangeOrigin.hash === hash;
  const selectedHash = selection ? lineAnchor(selection.start, selection.end) : "";
  const permalink = `${blobUrl(repo.owner.slug, repo.name, blob.commitOid, blob.path)}${selectedHash}`;

  const selectLine = (event: MouseEvent<HTMLAnchorElement>, line: number) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    const previous = anchor.current;
    const pivot =
      event.shiftKey || extending
        ? previous?.file === file && previous.hash === hash
          ? previous.line
          : (start ?? line)
        : line;
    const next = lineAnchor(pivot, line);
    anchor.current = { file, hash: next, line: pivot };
    setRangeOrigin(null);
    void navigate({ hash: next, search }, { replace: true, preventScrollReset: true });
  };

  const copyLink = async (pinned: boolean) => {
    const path = pinned
      ? permalink
      : `${blobUrl(repo.owner.slug, repo.name, blob.ref, blob.path)}${selectedHash}`;
    try {
      await navigator.clipboard.writeText(new URL(path, window.location.origin).href);
      toast.add({ title: pinned ? "Permalink copied" : "Link copied" });
    } catch {
      toast.add({
        title: "Couldn't copy the link",
        description: "Allow clipboard access and try again.",
        type: "error",
      });
    }
  };

  // Both initial deep links and subsequent selections render after route loading.
  useEffect(() => {
    if (start) document.getElementById(`L${start}`)?.scrollIntoView({ block: "center" });
  }, [start, end, file]);

  return (
    <div className="grid gap-x-8 gap-y-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex min-w-0 flex-col gap-4">
        <RefBar
          repo={repo}
          refName={blob.ref}
          path={blob.path}
          view="blob"
          onSwitch={(ref) => navigate(blobUrl(repo.owner.slug, repo.name, ref, blob.path))}
        />
        <section className="rounded-pane bg-pane">
          <div className="sticky top-16 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-t-pane border-b border-line-soft bg-pane px-4 py-3 text-body-sm">
            <span className="min-w-0 font-semibold break-all">{fileName}</span>
            <span className="text-ink-faint">
              {blob.binary ? bytes(blob.size) : `${lines.length} lines · ${bytes(blob.size)}`}
            </span>
            {selection ? (
              <div
                role="group"
                aria-label="Selected source lines"
                className="flex w-full flex-wrap items-center gap-2"
              >
                <span className="mr-auto text-ink-muted" aria-live="polite">
                  {start === end ? `Line ${start}` : `Lines ${start}–${end}`}
                </span>
                <button
                  type="button"
                  className="mk-btn mk-btn--ghost min-h-11"
                  aria-pressed={extending}
                  onClick={() => setRangeOrigin(extending ? null : { file, hash })}
                >
                  {extending ? "Select last line" : "Extend range"}
                </button>
                <button
                  type="button"
                  className="mk-btn mk-btn--ghost min-h-11"
                  onClick={() => void copyLink(false)}
                >
                  <CopyIcon aria-hidden />
                  Copy link
                </button>
                <button
                  type="button"
                  className="mk-btn mk-btn--ghost min-h-11"
                  onClick={() => void copyLink(true)}
                  title="Copy a link pinned to this exact commit"
                >
                  <LinkSimpleIcon aria-hidden />
                  Copy permalink
                </button>
              </div>
            ) : (
              !blob.binary && (
                <span className="w-full text-ink-muted">
                  Select a line number to share. Shift-click another to select a range.
                </span>
              )
            )}
          </div>
          {blob.binary ? (
            <div className="mk-empty m-4">
              Binary file, not shown.
              <br />
              <span className="text-body-sm text-ink-faint">Clone the repository to open it.</span>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-b-pane bg-sunken py-3">
              <table className="w-full border-collapse font-mono text-body-sm leading-5">
                <tbody>
                  {lines.map((line, index) => {
                    const selected =
                      !!selection && index + 1 >= selection.start && index + 1 <= selection.end;
                    return (
                      <tr
                        key={index}
                        id={`L${index + 1}`}
                        data-line-selected={selected || undefined}
                        className={`scroll-mt-48 ${selected ? "bg-signal-wash" : ""}`}
                      >
                        <td className="w-px pr-4 pl-4 text-right align-top tabular-nums select-none">
                          <a
                            href={`#L${index + 1}`}
                            className="inline-flex min-h-6 min-w-6 items-center justify-end text-ink-faint no-underline hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-line"
                            aria-label={`Line ${index + 1}`}
                            aria-current={selected ? "location" : undefined}
                            onClick={(event) => selectLine(event, index + 1)}
                          >
                            {index + 1}
                          </a>
                        </td>
                        <td className="pr-4 whitespace-pre">
                          {highlights?.[index] ? (
                            <HighlightedSource text={line || " "} tokens={highlights[index]} />
                          ) : (
                            line || " "
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {blob.truncated && (
                <p className="mx-4 mt-3 mb-0 text-body-sm text-ink-faint">
                  Showing the first 1 MB. Clone the repository for the rest.
                </p>
              )}
            </div>
          )}
        </section>
      </div>
      <aside
        aria-label="This file in the knowledge graph"
        className={`hidden xl:block ${railClass}`}
      >
        <Suspense fallback={null}>
          <Await resolve={knowledge} errorElement={null}>
            {(detail: GraphNodeDetail | null) => (
              <FileKnowledge detail={detail} blob={blob} lines={lines} repo={repo} />
            )}
          </Await>
        </Suspense>
      </aside>
    </div>
  );
}

/** What the knowledge graph knows about this file: summary, outline, imports. */
function FileKnowledge({
  detail,
  blob,
  lines,
  repo,
}: {
  detail: GraphNodeDetail | null;
  blob: BlobResponse;
  lines: string[];
  repo: RepoDetail;
}) {
  const [more, setMore] = useState(false);
  const owner = repo.owner.slug;
  const definitions = useMemo(() => {
    if (!detail) return [];
    const names = detail.outgoing.filter((l) => l.kind === "defines").map((l) => l.node.name);
    return findDefinitions(lines, names).sort(
      (a, b) => (a.line ?? Infinity) - (b.line ?? Infinity),
    );
  }, [detail, lines]);

  if (!detail) {
    return (
      <p className="m-0 max-w-[48ch] text-body-sm text-ink-faint">
        This file isn't in the knowledge graph.
      </p>
    );
  }
  const { node, outgoing, incoming } = detail;
  const mapUrl = (id: string) =>
    `${repoPath(owner, repo.name, "knowledge")}?node=${encodeURIComponent(id)}`;
  const uses = outgoing.filter((l) => l.kind === "imports");
  const usedBy = incoming.filter((l) => l.kind === "imports" && l.node.path);
  const parts = incoming.filter((l) => l.kind === "contains" && l.node.kind === "component");
  const long = node.summary.length > 280;

  return (
    <>
      <RailSection
        title="About this file"
        action={
          <Link
            to={mapUrl(node.id)}
            className="inline-flex items-center gap-1.5 text-body-sm text-ink-muted no-underline hover:text-ink"
          >
            <MapTrifoldIcon weight="bold" aria-hidden />
            Show on the map
          </Link>
        }
      >
        {node.summary ? (
          <>
            <p
              className={`m-0 max-w-[48ch] text-body-sm text-ink-muted ${long && !more ? "line-clamp-6" : ""}`}
            >
              {node.summary}
            </p>
            {long && (
              <button
                type="button"
                className="mt-1 cursor-pointer border-0 bg-transparent p-0 text-body-sm font-semibold text-ink-muted hover:text-ink"
                aria-expanded={more}
                onClick={() => setMore(!more)}
              >
                {more ? "Less" : "More"}
              </button>
            )}
          </>
        ) : (
          <p className="m-0 text-body-sm text-ink-faint">Not summarized yet.</p>
        )}
        {parts.length > 0 && (
          <p className="mt-2 mb-0 text-body-sm text-ink-faint">
            Part of{" "}
            {parts.map((part, i) => (
              <span key={part.node.id}>
                {i > 0 && ", "}
                <Link to={mapUrl(part.node.id)} className={link}>
                  {part.node.name}
                </Link>
              </span>
            ))}
          </p>
        )}
      </RailSection>

      {definitions.length > 0 && (
        <RailSection title="Defines" count={definitions.length}>
          <ul className="m-0 list-none p-0">
            {definitions.map((d) => {
              const inner = (
                <>
                  <span className="min-w-0 flex-1 truncate font-mono text-mono text-ink">
                    {d.name}
                  </span>
                  <span className="text-micro text-ink-faint">{d.kind}</span>
                  {d.line !== null && (
                    <span className="w-8 text-right font-mono text-micro text-ink-faint tabular-nums">
                      {d.line}
                    </span>
                  )}
                </>
              );
              return (
                <li key={d.name}>
                  {d.line !== null ? (
                    <a
                      href={`#L${d.line}`}
                      className="-mx-2 flex h-8 items-center gap-2 rounded-plate px-2 no-underline transition-colors hover:bg-raised"
                    >
                      {inner}
                    </a>
                  ) : (
                    <span className="-mx-2 flex h-8 items-center gap-2 px-2 opacity-70">
                      {inner}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </RailSection>
      )}

      {uses.length > 0 && (
        <RailSection title="Uses" count={uses.length}>
          <ul className="m-0 list-none p-0">
            {uses.map((use) =>
              use.node.kind === "file" && use.node.path ? (
                <FileRow
                  key={use.node.id}
                  to={blobUrl(owner, repo.name, blob.ref, use.node.path)}
                  path={use.node.path}
                />
              ) : (
                <li
                  key={use.node.id}
                  className="flex h-8 min-w-0 items-center gap-2 font-mono text-mono text-ink-muted"
                >
                  <PackageIcon className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
                  <span className="truncate">{use.node.name}</span>
                </li>
              ),
            )}
          </ul>
        </RailSection>
      )}

      {usedBy.length > 0 && (
        <RailSection title="Used by" count={usedBy.length}>
          <ul className="m-0 list-none p-0">
            {usedBy.map((user) => (
              <FileRow
                key={user.node.id}
                to={blobUrl(owner, repo.name, blob.ref, user.node.path ?? "")}
                path={user.node.path ?? ""}
              />
            ))}
          </ul>
        </RailSection>
      )}
    </>
  );
}
