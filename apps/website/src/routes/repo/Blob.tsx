import { MapTrifoldIcon, PackageIcon } from "@phosphor-icons/react";
import { Suspense, useEffect, useMemo, useState } from "react";
import {
  Await,
  Link,
  useLoaderData,
  useLocation,
  useNavigate,
  type LoaderFunctionArgs,
} from "react-router";
import type { BlobResponse, GraphNodeDetail, RepoDetail } from "../../../shared/api.ts";
import { FileRow, RailSection, railClass } from "../../components/Rail.tsx";
import { link } from "../../components/ui.tsx";
import { bytes } from "../../lib/format.ts";
import { findDefinitions } from "../../lib/outline.ts";
import { blobUrl, repoPath } from "../../lib/refs.ts";
import { repoData, routeData } from "../../lib/repoData.ts";
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

const LINE = /^#L(\d+)$/;

export function Blob() {
  const { blob, knowledge } = useLoaderData<typeof blobLoader>();
  const repo = useRepo();
  const navigate = useNavigate();
  const { hash } = useLocation();
  const lines = useMemo(() => blob.text?.replace(/\n$/, "").split("\n") ?? [], [blob.text]);
  const fileName = blob.path.split("/").pop();

  // The code renders after the loader, so the browser's own jump to #L123 on
  // load finds nothing; do it once the lines exist.
  useEffect(() => {
    if (LINE.test(hash))
      document.getElementById(hash.slice(1))?.scrollIntoView({ block: "center" });
  }, [hash, blob.path, blob.ref]);

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
        <section className="overflow-hidden rounded-pane bg-pane">
          <div className="flex items-center gap-3 border-b border-line-soft px-4 py-3 text-body-sm">
            <span className="font-semibold">{fileName}</span>
            <span className="text-ink-faint">
              {blob.binary ? bytes(blob.size) : `${lines.length} lines · ${bytes(blob.size)}`}
            </span>
          </div>
          {blob.binary ? (
            <div className="mk-empty m-4">
              Binary file, not shown.
              <br />
              <span className="text-body-sm text-ink-faint">Clone the repository to open it.</span>
            </div>
          ) : (
            <div className="overflow-x-auto bg-sunken py-3">
              <table className="w-full border-collapse font-mono text-body-sm leading-5">
                <tbody>
                  {lines.map((line, index) => (
                    <tr
                      key={index}
                      id={`L${index + 1}`}
                      className="scroll-mt-24 target:bg-signal-wash"
                    >
                      <td className="w-px pr-4 pl-4 text-right align-top tabular-nums select-none">
                        <a
                          href={`#L${index + 1}`}
                          className="text-ink-faint no-underline hover:text-ink"
                          aria-label={`Line ${index + 1}`}
                        >
                          {index + 1}
                        </a>
                      </td>
                      <td className="pr-4 whitespace-pre">{line || " "}</td>
                    </tr>
                  ))}
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
