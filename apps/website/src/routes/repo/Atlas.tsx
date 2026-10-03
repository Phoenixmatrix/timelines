// The Semantic Code Atlas for a repository (CORE-168): capability territory
// from the bounded Atlas API, never the whole graph. It lives at
// /:owner/:repo/atlas, unlinked, until the Knowledge cutover makes it the
// default; the full inspector, outline and deep links come in their own
// tickets (CORE-169 to CORE-171).

import { ArrowClockwiseIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import type { AtlasEntitySummary, AtlasOverview, AtlasRegion } from "../../../shared/atlas.ts";
import { ApiError } from "../../lib/api.ts";
import { atlasApi } from "../../lib/atlas.ts";
import { timeAgo } from "../../lib/format.ts";
import { AtlasTerritory } from "./AtlasTerritory.tsx";
import { useRepo } from "./RepoLayout.tsx";
import { buildTerritory, ChildLoader, type Load, type TerritoryCell } from "./territory.ts";

export async function atlasLoader({ params }: LoaderFunctionArgs) {
  const repo = { owner: params.owner ?? "", name: params.repo ?? "" };
  try {
    return { overview: await atlasApi.overview(repo) };
  } catch (error) {
    if (error instanceof ApiError && error.code === "atlas_unavailable") return { overview: null };
    throw error;
  }
}

/** Regions and entities that hold others, and so can be opened. */
const OPENS = new Set(["capability", "area", "group", "component", "directory", "repository"]);

const files = (n: number | undefined) =>
  n === undefined ? "" : `${n.toLocaleString()} file${n === 1 ? "" : "s"}`;

export function Atlas() {
  const { overview } = useLoaderData<typeof atlasLoader>();
  if (!overview)
    return (
      <div className="mk-empty">
        The Atlas for this repository isn't built yet.
        <br />
        <span className="text-body-sm text-ink-faint">
          It's made by the next Knowledge build, after a push.
        </span>
      </div>
    );
  return <Territory key={overview.snapshot.id} overview={overview} />;
}

function Territory({ overview }: { overview: AtlasOverview }) {
  const repo = useRepo();
  const ref = { owner: repo.owner.slug, name: repo.name };
  const snapshot = overview.snapshot;
  const [loads, setLoads] = useState<ReadonlyMap<string, Load>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);

  const loader = useMemo(
    () =>
      new ChildLoader(
        snapshot.id,
        async (id, cursor, signal) => {
          const page = await atlasApi.children(ref, id, {
            snapshot: snapshot.id,
            cursor,
            signal,
            limit: 100,
          });
          return { items: page.items, next: page.next, total: page.counts.knownTotal };
        },
        (id, load) => setLoads((current) => new Map(current).set(id, load)),
      ),
    // One loader per snapshot: a new snapshot remounts this component anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot.id],
  );
  useEffect(() => () => loader.reset(""), [loader]);

  const expanded = useMemo(() => {
    const ready = new Map<string, AtlasEntitySummary[]>();
    for (const [id, load] of loads) if (load.state === "ready") ready.set(id, load.items);
    return ready;
  }, [loads]);
  const territory = useMemo(
    () => buildTerritory(overview.regions, expanded, snapshot.seq),
    [overview.regions, expanded, snapshot.seq],
  );
  const loading = useMemo(
    () => new Set([...loads].filter(([, l]) => l.state === "loading").map(([id]) => id)),
    [loads],
  );

  const choose = (entity: AtlasEntitySummary) => {
    setSelected(entity.id);
    if (OPENS.has(entity.kind) && !loads.has(entity.id)) void loader.load(entity.id);
  };
  const pickCell = (cell: TerritoryCell) => choose(cell.entity);

  const commit = snapshot.vector[0]?.commit.slice(0, 7);
  const capabilities = overview.regions.filter((r) => !r.structural).length;
  const selectedEntity = selected ? territory.byId.get(selected)?.entity : undefined;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-body-sm text-ink-muted">
        <span className="tabular-nums">
          {overview.totalRegions.toLocaleString()} region{overview.totalRegions === 1 ? "" : "s"}
          {overview.totalRegions > overview.regions.length &&
            ` · showing the ${overview.regions.length} largest`}
        </span>
        <span className="text-ink-faint">
          Built from {commit ? <span className="font-mono">{commit}</span> : "the indexed commit"}
          {snapshot.publishedAt && ` · ${timeAgo(snapshot.publishedAt)}`}
          {snapshot.partial && " · some files not analyzed yet, so counts are a floor"}
        </span>
        {overview.capacityFailure && (
          <span className="text-danger-text">
            The newest build didn't fit the Atlas storage limit; this is the previous one.
          </span>
        )}
      </div>

      <div className="grid gap-3 lg:h-[max(34rem,calc(100dvh-16rem))] lg:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="h-[62dvh] min-h-[22rem] lg:h-auto lg:min-h-0">
          <AtlasTerritory
            territory={territory}
            selected={selected}
            loading={loading}
            onSelect={pickCell}
            label={`Capability map: ${capabilities} capabilities${
              overview.regions.length > capabilities ? " and structural groups" : ""
            }. The list beside it has the same regions.`}
          />
        </div>
        <aside
          aria-label="Regions"
          className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-pane bg-pane p-3"
        >
          {selectedEntity && (
            <Selection
              entity={selectedEntity}
              load={loads.get(selectedEntity.id)}
              onPick={choose}
              onRetry={() => void loader.load(selectedEntity.id)}
              onMore={(cursor, items) => void loader.load(selectedEntity.id, cursor, items)}
              changed={snapshot.seq > 1 && selectedEntity.since === snapshot.seq}
            />
          )}
          <RegionList
            regions={overview.regions}
            selected={selected}
            seq={snapshot.seq}
            onPick={choose}
          />
          {overview.catalogue.items.length > 0 && (
            <p className="m-0 text-micro text-ink-faint">
              {(overview.totalRegions - overview.regions.length).toLocaleString()} smaller regions
              are in the catalogue.
            </p>
          )}
          <Legend />
        </aside>
      </div>
    </div>
  );
}

function summaryLine(entity: AtlasEntitySummary): string {
  if (entity.summary) return entity.summary;
  switch (entity.summaryState?.status) {
    case "stale":
      return "Summary out of date: it describes an earlier build.";
    case "unavailable":
      return "Summary unavailable for this build.";
    default:
      return "";
  }
}

function RegionList({
  regions,
  selected,
  seq,
  onPick,
}: {
  regions: readonly AtlasRegion[];
  selected: string | null;
  seq: number;
  onPick: (entity: AtlasEntitySummary) => void;
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {regions.map((region) => (
        <li key={region.id}>
          <button
            type="button"
            aria-current={region.id === selected || undefined}
            onClick={() => onPick(region)}
            className="flex w-full cursor-pointer flex-col gap-0.5 rounded-plate border-0 bg-transparent px-2.5 py-2 text-left hover:bg-raised aria-[current]:bg-signal-wash"
          >
            <span className="flex w-full items-baseline gap-2">
              <span
                className={`min-w-0 flex-1 truncate text-body-sm font-semibold ${region.structural ? "text-ink-muted" : "text-ink"}`}
              >
                {region.name}
              </span>
              {seq > 1 && region.since === seq && (
                <span className="text-micro text-ink-faint" title="Changed in this build">
                  changed
                </span>
              )}
              <span className="text-micro text-ink-faint tabular-nums">
                {region.structural
                  ? `${region.size.members.toLocaleString()} item${region.size.members === 1 ? "" : "s"}`
                  : files(region.size.files)}
              </span>
            </span>
            {summaryLine(region) && (
              <span className="line-clamp-2 text-micro text-ink-muted">{summaryLine(region)}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

function Selection({
  entity,
  load,
  changed,
  onPick,
  onRetry,
  onMore,
}: {
  entity: AtlasEntitySummary;
  load: Load | undefined;
  changed: boolean;
  onPick: (entity: AtlasEntitySummary) => void;
  onRetry: () => void;
  onMore: (cursor: string, items: AtlasEntitySummary[]) => void;
}) {
  return (
    <section
      aria-label={entity.name}
      className="flex flex-col gap-2 border-b border-line-soft pb-3"
    >
      <h2 className="m-0 text-body font-semibold">{entity.name}</h2>
      <p className="m-0 text-micro text-ink-faint">
        {entity.structural
          ? "Structural group: not a capability."
          : entity.kind === "capability" || entity.kind === "area"
            ? "Grouped from imports and shared concepts in the code, never folders alone."
            : entity.kind}
        {changed && " · changed in this build"}
      </p>
      {summaryLine(entity) && (
        <p className="m-0 text-body-sm text-ink-muted">{summaryLine(entity)}</p>
      )}
      {load?.state === "loading" && (
        <p className="m-0 text-body-sm text-ink-faint" aria-live="polite">
          Loading what's inside…
        </p>
      )}
      {load?.state === "error" && (
        <div className="flex items-center gap-2 text-body-sm text-danger-text" role="alert">
          Couldn't load what's inside.
          <button type="button" className="mk-btn mk-btn--ghost mk-btn--sm" onClick={onRetry}>
            <ArrowClockwiseIcon weight="bold" aria-hidden /> Retry
          </button>
        </div>
      )}
      {load?.state === "ready" && (
        <>
          <ul className="m-0 flex list-none flex-col p-0" aria-label={`Inside ${entity.name}`}>
            {load.items.map((child) => (
              <li key={child.id}>
                <button
                  type="button"
                  onClick={() => onPick(child)}
                  className="flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-plate border-0 bg-transparent px-2 text-left text-body-sm hover:bg-raised"
                >
                  {OPENS.has(child.kind) && (
                    <CaretRightIcon className="size-3 shrink-0 text-ink-faint" aria-hidden />
                  )}
                  <span className="min-w-0 flex-1 truncate">{child.name}</span>
                  <span className="text-micro text-ink-faint tabular-nums">
                    {files(child.counts.files)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="m-0 text-micro text-ink-faint">
            {load.total !== null
              ? `${load.items.length.toLocaleString()} of ${load.total.toLocaleString()}`
              : `${load.items.length.toLocaleString()} loaded`}
          </p>
          {load.next && (
            <button
              type="button"
              className="mk-btn mk-btn--sm self-start"
              onClick={() => onMore(load.next!, load.items)}
            >
              Show more
            </button>
          )}
        </>
      )}
    </section>
  );
}

/** What the map's shapes mean, and what they don't. */
function Legend() {
  return (
    <details className="text-micro text-ink-muted">
      <summary className="cursor-pointer text-ink-faint">Reading the map</summary>
      <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
        <li>
          <strong className="text-ink">Area</strong> is how many files live there, in power-of-two
          steps: not complexity, importance or quality.
        </li>
        <li>
          <strong className="text-ink">Position</strong> is a stable landmark: a capability keeps
          its place while it continues. Being near another doesn't mean they depend on each other.
        </li>
        <li>
          <strong className="text-ink">Boundaries</strong> are primary membership: each file lives
          in exactly one capability; ties to others are listed as references, not drawn twice.
        </li>
        <li>
          <strong className="text-ink">Dashed regions</strong> are structural groups (unclassified
          files, concepts, dependencies, folders), not capabilities.
        </li>
        <li>
          <span className="mr-1 inline-block size-2 rounded-full bg-data-berry align-middle" />
          Changed in the build this map shows.
        </li>
      </ul>
    </details>
  );
}
