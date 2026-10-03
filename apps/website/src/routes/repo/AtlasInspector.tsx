// The Atlas inspector (CORE-169): what the selected capability, area, file or
// symbol is, where it sits, the evidence behind it, and a one-hop
// relationship lens. Everything is a bounded, paged request against the
// snapshot on screen; a late answer for an earlier selection is dropped.
//
// It reads through an AtlasReader (src/lib/atlas.ts), so the workspace Atlas
// (CORE-184) shows the same inspector over namespaced ids; `repo` is then the
// entity's own repository, for its source and wiki links.
//
// The lens shows static, indexed links: never a complete runtime call graph,
// a guarantee that something breaks, or proof a change is safe. "No indexed
// link" is said as such, not as "no dependencies".

import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { WikiPageSummary } from "../../../shared/api.ts";
import { repoPath } from "../../lib/refs.ts";
import type {
  AtlasContribution,
  AtlasCounts,
  AtlasDetail as AtlasDetailResponse,
  AtlasDirection,
  AtlasEntitySummary,
  AtlasError,
  AtlasEvidence,
  AtlasRelation,
  AtlasSnapshotRef,
} from "../../../shared/atlas.ts";
import { fileNote, summaryNote } from "./atlasStates.ts";
import {
  atlasErrorOf,
  atlasNeedsRestart,
  repoReader,
  type AtlasReader,
  type AtlasRepo,
} from "../../lib/atlas.ts";
import type { AtlasLens } from "./atlasUrl.ts";
import { lineAnchor } from "../../lib/lineAnchors.ts";
import { blobUrl } from "../../lib/refs.ts";

const KIND: Record<string, string> = {
  capability: "Capability",
  area: "Area",
  group: "Group",
  component: "Component (folder-based)",
  directory: "Folder",
  file: "File",
  symbol: "Symbol",
  concept: "Concept",
  package: "Package",
  repository: "Repository",
};

const VERB: Record<AtlasDirection, Record<string, string>> = {
  out: {
    depends_on: "Depends on",
    imports: "Imports",
    contains: "Contains",
    defines: "Defines",
    mentions: "Mentions",
    part_of: "Part of",
  },
  in: {
    depends_on: "Depended on by",
    imports: "Imported by",
    contains: "Contained in",
    defines: "Defined in",
    mentions: "Mentioned by",
    part_of: "Includes",
  },
};

type AtlasDetail = Omit<AtlasDetailResponse, "scope" | "snapshot">;

interface Paged<T> {
  items: T[];
  counts: AtlasCounts;
  next: string | null;
}

/** One paged list, reloaded when `key` changes; stale answers are dropped. */
function usePaged<T>(
  key: string | null,
  fetchPage: (cursor: string | null, signal: AbortSignal) => Promise<Paged<T>>,
) {
  const [state, setState] = useState<{
    key: string;
    status: "loading" | "ready" | "error";
    page: Paged<T> | null;
    error?: string;
  } | null>(null);
  const generation = useRef(0);
  const run = (cursor: string | null, previous: T[]) => {
    if (!key) return;
    const mine = ++generation.current;
    const controller = new AbortController();
    if (!cursor) setState({ key, status: "loading", page: null });
    fetchPage(cursor, controller.signal)
      .then((page) => {
        if (mine !== generation.current) return;
        setState({ key, status: "ready", page: { ...page, items: [...previous, ...page.items] } });
      })
      .catch((error: unknown) => {
        if (mine !== generation.current || controller.signal.aborted) return;
        setState({
          key,
          status: "error",
          page: null,
          error: error instanceof Error ? error.message : "Couldn't load this.",
        });
      });
    return () => controller.abort();
  };
  useEffect(() => run(null, []), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = state?.key === key ? state : null;
  return {
    status: current?.status ?? "loading",
    page: current?.page ?? null,
    error: current?.error,
    retry: () => void run(null, []),
    more: () => current?.page?.next && void run(current.page.next, current.page.items),
  };
}

function countLine(counts: AtlasCounts, noun: string) {
  const loaded = counts.loaded.toLocaleString();
  if (counts.knownTotal === null) return `${loaded} ${noun} loaded`;
  const total = counts.knownTotal.toLocaleString();
  return counts.unknownTotal
    ? `${loaded} of at least ${total} ${noun} (some files aren't analyzed yet)`
    : `${loaded} of ${total} ${noun}`;
}

export function AtlasInspector({
  repo,
  reader,
  snapshot,
  entity,
  contents,
  lens,
  autoFocus = false,
  onPick,
  onLens,
  onRestart,
  wiki = null,
}: {
  /** The entity's repository: where its sources and wiki pages are. */
  repo: AtlasRepo;
  /** What it's read through; the repository's own Atlas when omitted. */
  reader?: AtlasReader;
  snapshot: AtlasSnapshotRef;
  entity: AtlasEntitySummary;
  /** What's inside it, as the map already loads it. */
  contents: ReactNode;
  /** The relationship lens, kept in the address. */
  lens: AtlasLens;
  /** Move focus to its heading once shown (a restored link, Back or Forward). */
  autoFocus?: boolean;
  onPick: (entity: AtlasEntitySummary) => void;
  onLens: (lens: AtlasLens) => void;
  /** The pinned snapshot can't be read any more. */
  onRestart?: (error: AtlasError) => void;
  /** The wiki page written about it, if any. */
  wiki?: Pick<WikiPageSummary, "slug" | "title"> | null;
}) {
  const read = reader ?? repoReader(repo);
  const [detail, setDetail] = useState<AtlasDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (autoFocus) heading.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on showing only
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setDetailError(null);
    read
      .detail(entity.id, { snapshot: snapshot.id, signal: controller.signal })
      .then(setDetail)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const atlasError = atlasErrorOf(error);
        if (atlasError && atlasNeedsRestart(error)) onRestart?.(atlasError);
        setDetailError(error instanceof Error ? error.message : "Couldn't load this.");
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity.id, snapshot.id]);

  const data = detail?.entity.data as Record<string, unknown> | undefined;
  const inferred = (
    data?.provenance as { inferred?: { model?: string; basis?: { commit?: string } } } | undefined
  )?.inferred;
  const membership = data?.membership as
    | {
        rationale?: { kind: string; with: string; weight: number }[];
        crossCutting?: { capability: string }[];
      }
    | undefined;
  const changed = snapshot.seq > 1 && entity.since === snapshot.seq;

  return (
    <section
      aria-label={`Inspector: ${entity.name}`}
      className="flex flex-col gap-3 border-b border-line-soft pb-3"
    >
      <div className="flex flex-col gap-1">
        {detail && detail.ancestors.length > 1 && (
          <nav
            aria-label="Where it sits"
            className="flex flex-wrap gap-x-1 text-micro text-ink-faint"
          >
            {detail.ancestors.slice(1).map((a) => (
              <span key={a.id}>
                <button
                  type="button"
                  className="cursor-pointer border-0 bg-transparent p-0 text-ink-faint hover:text-ink hover:underline pointer-coarse:min-h-11 pointer-coarse:px-1"
                  onClick={() => onPick(a)}
                >
                  {a.name}
                </button>{" "}
                ›
              </span>
            ))}
          </nav>
        )}
        <h2 ref={heading} tabIndex={-1} className="m-0 text-body font-semibold break-words">
          {entity.name}
        </h2>
        <p className="m-0 text-micro text-ink-faint">
          {KIND[entity.kind] ?? entity.kind}
          {entity.path && <span className="font-mono"> · {entity.path}</span>}
          {changed && " · changed in this build"}
        </p>
      </div>

      {entity.summary ? (
        <p className="m-0 text-body-sm text-ink-muted">{entity.summary}</p>
      ) : summaryNote(entity.summaryState) ? (
        <p className="m-0 text-body-sm text-ink-faint">
          {summaryNote(entity.summaryState, inferred?.basis?.commit)}
        </p>
      ) : null}
      {entity.kind === "file" && fileNote(data) && (
        <p className="m-0 text-body-sm text-ink-faint">{fileNote(data)}</p>
      )}

      <p className="m-0 text-micro text-ink-faint">
        {entity.structural
          ? "Structural group, not a capability."
          : entity.kind === "capability" || entity.kind === "area"
            ? "Members grouped from imports and shared concepts in the code, never folders alone."
            : "From the indexed source."}
        {inferred?.model &&
          ` Summary written by ${inferred.model}${inferred.basis?.commit ? ` from ${inferred.basis.commit.slice(0, 7)}` : ""}, a model's reading, not verified behavior.`}
      </p>
      {wiki && (
        <Link
          to={repoPath(repo.owner, repo.name, "wiki", wiki.slug)}
          className="self-start text-body-sm text-ink underline"
        >
          Wiki: {wiki.title}
        </Link>
      )}
      {detailError && (
        <p className="m-0 text-body-sm text-danger-text" role="alert">
          {detailError}
        </p>
      )}

      {membership?.rationale && membership.rationale.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="m-0 text-label text-ink-muted">Why it's here</h3>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-micro text-ink-muted">
            {membership.rationale.map((r) => (
              <li key={`${r.kind}:${r.with}`}>
                {r.kind === "concept"
                  ? "Shares the concept "
                  : r.kind === "imports"
                    ? "Imports "
                    : "Imported by "}
                <span className="font-mono">{r.with.replace(/^(file|concept):/, "")}</span>
              </li>
            ))}
          </ul>
          {membership.crossCutting && membership.crossCutting.length > 0 && (
            <p className="m-0 text-micro text-ink-faint">
              Also tied to {membership.crossCutting.length} other capabilit
              {membership.crossCutting.length === 1 ? "y" : "ies"} (listed as references, not
              counted twice).
            </p>
          )}
        </div>
      )}

      {contents}

      {detail && (
        <Lens
          repo={repo}
          reader={read}
          snapshot={snapshot}
          entity={entity}
          detail={detail}
          lens={lens}
          onLens={onLens}
          onPick={onPick}
        />
      )}
      <Evidence repo={repo} reader={read} snapshot={snapshot} entity={entity} />
    </section>
  );
}

function Lens({
  repo,
  reader,
  snapshot,
  entity,
  detail,
  lens,
  onLens,
  onPick,
}: {
  repo: AtlasRepo;
  reader: AtlasReader;
  snapshot: AtlasSnapshotRef;
  entity: AtlasEntitySummary;
  detail: AtlasDetail;
  lens: AtlasLens;
  onLens: (lens: AtlasLens) => void;
  onPick: (entity: AtlasEntitySummary) => void;
}) {
  const direction = lens.direction;
  const kind = lens.kind;
  const kinds = Object.entries(
    direction === "out" ? detail.counts.outgoing : detail.counts.incoming,
  )
    .filter(([kind]) => kind !== "contains")
    .sort((a, b) => b[1] - a[1]);
  const active = kind && kinds.some(([k]) => k === kind) ? kind : (kinds[0]?.[0] ?? null);
  const list = usePaged<AtlasRelation>(
    active ? `${entity.id}|${direction}|${active}|${snapshot.id}` : null,
    (cursor, signal) =>
      reader.relations(entity.id, direction, {
        kind: active ?? undefined,
        snapshot: snapshot.id,
        cursor,
        signal,
        limit: 25,
      }),
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="m-0 mr-auto text-label text-ink-muted">Relationships</h3>
        <div role="group" aria-label="Direction" className="flex gap-1">
          {(["out", "in"] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={direction === d}
              className="mk-btn mk-btn--ghost mk-btn--sm aria-pressed:bg-signal-wash aria-pressed:text-ink pointer-coarse:min-h-11"
              onClick={() => onLens({ direction: d, kind: null })}
            >
              {d === "out" ? "Uses" : "Used by"}
            </button>
          ))}
        </div>
      </div>
      {kinds.length === 0 ? (
        <p className="m-0 text-body-sm text-ink-faint">
          No indexed links {direction === "out" ? "from" : "to"} it. That isn't proof there are
          none: dynamic and unsupported references aren't indexed.
        </p>
      ) : (
        <>
          {kinds.length > 1 && (
            <div role="group" aria-label="Kind of link" className="flex flex-wrap gap-1">
              {kinds.map(([k, n]) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={active === k}
                  className="mk-chip cursor-pointer border-0 pointer-coarse:min-h-11"
                  onClick={() => onLens({ direction, kind: k })}
                >
                  {VERB[direction][k] ?? k} {n.toLocaleString()}
                </button>
              ))}
            </div>
          )}
          {list.status === "loading" && (
            <p role="status" className="m-0 text-body-sm text-ink-faint">
              Loading links…
            </p>
          )}
          {list.status === "error" && (
            <p className="m-0 text-body-sm text-danger-text" role="alert">
              Couldn't load these links.{" "}
              <button
                type="button"
                className="mk-btn mk-btn--ghost mk-btn--sm"
                onClick={list.retry}
              >
                Retry
              </button>
            </p>
          )}
          {list.page && (
            <>
              <ul
                className="m-0 flex list-none flex-col p-0"
                aria-label={`${VERB[direction][active ?? ""] ?? "Links"}`}
              >
                {list.page.items.map((r) => (
                  <RelationRow
                    key={`${r.src}|${r.dst}|${r.kind}`}
                    repo={repo}
                    reader={reader}
                    snapshot={snapshot}
                    entity={entity}
                    relation={r}
                    direction={direction}
                    onPick={onPick}
                  />
                ))}
              </ul>
              <p className="m-0 text-micro text-ink-faint">
                {countLine(list.page.counts, "links")}
              </p>
              {list.page.next && (
                <button type="button" className="mk-btn mk-btn--sm self-start" onClick={list.more}>
                  Show more
                </button>
              )}
            </>
          )}
          <p className="m-0 text-micro text-ink-faint">
            Static links from the indexed source: not a full runtime call graph, and not a guarantee
            that a change here breaks or spares anything.
          </p>
        </>
      )}
    </div>
  );
}

function RelationRow({
  repo,
  reader,
  snapshot,
  entity,
  relation,
  direction,
  onPick,
}: {
  repo: AtlasRepo;
  reader: AtlasReader;
  snapshot: AtlasSnapshotRef;
  entity: AtlasEntitySummary;
  relation: AtlasRelation;
  direction: AtlasDirection;
  onPick: (entity: AtlasEntitySummary) => void;
}) {
  const [open, setOpen] = useState(false);
  const other = direction === "out" ? relation.dst : relation.src;
  // Between two capabilities (ids are `<repoId>/cap:…` in a workspace).
  const capabilityLink =
    relation.kind === "depends_on" &&
    (relation.neighbor ? relation.neighbor.kind === "capability" : other.startsWith("cap:"));
  return (
    <li className="flex flex-col">
      <div className="flex min-h-8 items-center gap-1 pointer-coarse:min-h-11">
        {capabilityLink ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? "Hide the imports behind this" : "Show the imports behind this"}
            className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-plate border-0 bg-transparent text-ink-faint hover:bg-raised pointer-coarse:size-11"
            onClick={() => setOpen(!open)}
          >
            {open ? <CaretDownIcon aria-hidden /> : <CaretRightIcon aria-hidden />}
          </button>
        ) : (
          <span className="size-6 shrink-0 pointer-coarse:size-11" />
        )}
        {relation.neighbor ? (
          <button
            type="button"
            className="min-w-0 flex-1 cursor-pointer truncate rounded-plate border-0 bg-transparent px-1 text-left text-body-sm hover:bg-raised"
            onClick={() => onPick(relation.neighbor!)}
          >
            {relation.neighbor.name}
          </button>
        ) : (
          <span
            className="min-w-0 flex-1 truncate px-1 font-mono text-body-sm text-ink-faint"
            title="Not in this snapshot (external or unresolved)"
          >
            {(entity.repoId && other.startsWith(`${entity.repoId}/`)
              ? other.slice(entity.repoId.length + 1)
              : other
            ).replace(/^(file|pkg|concept):/, "")}
          </span>
        )}
        <span className="text-micro text-ink-faint tabular-nums">
          {capabilityLink
            ? `${relation.weight.toLocaleString()} import${relation.weight === 1 ? "" : "s"}`
            : ""}
        </span>
      </div>
      {open && (
        <Contributing
          repo={repo}
          reader={reader}
          snapshot={snapshot}
          entity={entity}
          other={other}
          direction={direction}
        />
      )}
    </li>
  );
}

function Contributing({
  repo,
  reader,
  snapshot,
  entity,
  other,
  direction,
}: {
  repo: AtlasRepo;
  reader: AtlasReader;
  snapshot: AtlasSnapshotRef;
  entity: AtlasEntitySummary;
  other: string;
  direction: AtlasDirection;
}) {
  const list = usePaged<AtlasContribution>(
    `${entity.id}|${other}|${direction}|${snapshot.id}`,
    (cursor, signal) =>
      reader.contributing(entity.id, other, direction, {
        snapshot: snapshot.id,
        cursor,
        signal,
        limit: 25,
      }),
  );
  const commit = snapshot.vector[0]?.commit;
  if (list.status === "loading")
    return (
      <p role="status" className="m-0 ml-7 text-micro text-ink-faint">
        Loading the imports behind it…
      </p>
    );
  if (list.status === "error")
    return (
      <p className="m-0 ml-7 text-micro text-danger-text">
        Couldn't load them.{" "}
        <button type="button" className="mk-btn mk-btn--ghost mk-btn--sm" onClick={list.retry}>
          Retry
        </button>
      </p>
    );
  return (
    <div className="ml-7 flex flex-col gap-1">
      <ul className="m-0 flex list-none flex-col p-0 font-mono text-micro">
        {list.page?.items.map((l) => (
          <li key={`${l.src}|${l.dst}`} className="truncate">
            {commit && l.srcPath ? (
              <Link
                to={blobUrl(repo.owner, repo.name, commit, l.srcPath)}
                className="text-ink-muted hover:text-ink"
              >
                {l.srcPath}
              </Link>
            ) : (
              l.srcPath
            )}{" "}
            → <span className="text-ink-faint">{l.dstPath}</span>
          </li>
        ))}
      </ul>
      {list.page && (
        <p className="m-0 text-micro text-ink-faint">{countLine(list.page.counts, "imports")}</p>
      )}
      {list.page?.next && (
        <button
          type="button"
          className="mk-btn mk-btn--ghost mk-btn--sm self-start"
          onClick={list.more}
        >
          Show more
        </button>
      )}
    </div>
  );
}

function Evidence({
  repo,
  reader,
  snapshot,
  entity,
}: {
  repo: AtlasRepo;
  reader: AtlasReader;
  snapshot: AtlasSnapshotRef;
  entity: AtlasEntitySummary;
}) {
  const list = usePaged<AtlasEvidence>(`${entity.id}|${snapshot.id}`, (cursor, signal) =>
    reader.evidence(entity.id, { snapshot: snapshot.id, cursor, signal, limit: 10 }),
  );
  if (list.status === "loading")
    return (
      <p role="status" className="m-0 text-micro text-ink-faint">
        Loading sources…
      </p>
    );
  if (list.status === "error")
    return (
      <p className="m-0 text-micro text-danger-text">
        Couldn't load its sources.{" "}
        <button type="button" className="mk-btn mk-btn--ghost mk-btn--sm" onClick={list.retry}>
          Retry
        </button>
      </p>
    );
  if (!list.page?.items.length) return null;
  return (
    <div className="flex flex-col gap-1">
      <h3 className="m-0 text-label text-ink-muted">Source</h3>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {list.page.items.map((e) => {
          const anchor =
            e.range.status === "start-line" && e.range.startLine
              ? lineAnchor(e.range.startLine)
              : e.range.status === "whole-file" && e.range.startLine && e.range.endLine
                ? ""
                : "";
          return (
            <li key={`${e.entityId}|${e.via}`} className="flex items-baseline gap-2 text-micro">
              <Link
                to={`${blobUrl(repo.owner, repo.name, e.commit, e.path)}${anchor}`}
                className="min-w-0 flex-1 truncate font-mono text-ink-muted hover:text-ink pointer-coarse:py-2.5"
                title={`${e.path} at ${e.commit.slice(0, 7)}`}
              >
                {e.path}
                {e.range.status === "start-line" && e.range.startLine
                  ? `:${e.range.startLine}`
                  : ""}
              </Link>
              <span className="text-ink-faint">
                {e.analysis !== "analyzed" ? e.analysis : e.via === "self" ? "" : e.via}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="m-0 text-micro text-ink-faint">
        {countLine(list.page.counts, "sources")} at {list.page.items[0]!.commit.slice(0, 7)}, the
        indexed commit.
      </p>
      {list.page.next && (
        <button
          type="button"
          className="mk-btn mk-btn--ghost mk-btn--sm self-start"
          onClick={list.more}
        >
          Show more
        </button>
      )}
    </div>
  );
}
