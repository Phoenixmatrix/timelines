import { GearSixIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import type { FormatId } from "@gitmatrix/formats/info";
import type {
  OwnerPackages as OwnerPackagesData,
  PackageSummary,
} from "../../../shared/packages.ts";
import { Page } from "../../components/AppShell.tsx";
import { Monogram } from "../../components/Monogram.tsx";
import { PrefetchLink } from "../../components/PrefetchLink.tsx";
import { load } from "../../lib/api.ts";
import { fullDate, timeAgo } from "../../lib/format.ts";
import { count, feedsPath, formatLabel, packagePath, plural } from "../../lib/packages.ts";

export async function ownerPackagesLoader({ request, params }: LoaderFunctionArgs) {
  return load<OwnerPackagesData>(`/packages/${params.owner}`, request);
}

/** The last day of publishes, an hour per cell: what's busy right now. */
export function Activity({ spark, label }: { spark: number[]; label: string }) {
  const peak = Math.max(1, ...spark);
  return (
    <span className="flex h-5 items-end gap-px" role="img" aria-label={label}>
      {spark.map((n, i) => (
        <span
          key={i}
          className="min-h-0.5 w-[3px] rounded-t-[4px] bg-data-teal data-[zero]:bg-line-soft"
          data-zero={n === 0 || undefined}
          style={{ height: `${(n / peak) * 100}%` }}
        />
      ))}
    </span>
  );
}

export function PackageRow({ pkg, owner }: { pkg: PackageSummary; owner: string }) {
  // The name's link covers the row; source repositories are their own links on top.
  return (
    <li className="mk-enter-up">
      <div className="relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-ink transition-colors hover:bg-raised md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_7.5rem_6rem]">
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <PrefetchLink
              to={packagePath(owner, pkg.format, pkg.name)}
              className="truncate font-semibold text-ink no-underline after:absolute after:inset-0"
            >
              <bdi>{pkg.name}</bdi>
            </PrefetchLink>
            <span className="mk-chip mk-chip--tag">{formatLabel(pkg.format)}</span>
          </span>
          <span className="mt-0.5 block truncate text-body-sm text-ink-muted mk-tabular">
            {pkg.latest ? (
              <>
                <span className="mk-mono text-ink">{pkg.latest}</span>
                {` · ${plural(pkg.versions, "version")}`}
              </>
            ) : (
              "Nothing installable"
            )}
          </span>
        </span>
        <span className="hidden min-w-0 truncate text-body-sm text-ink-muted md:block">
          {pkg.sources.length
            ? pkg.sources.map((source, index) => (
                <span key={source}>
                  {index > 0 && ", "}
                  <Link
                    to={`/${source.split("/").map(encodeURIComponent).join("/")}`}
                    className="relative z-10 text-ink-muted no-underline hover:text-ink"
                  >
                    {source}
                  </Link>
                </span>
              ))
            : "Published by hand"}
        </span>
        <span className="hidden items-center gap-2 md:flex">
          <Activity spark={pkg.spark} label={`${pkg.publishes24h} publishes in the last day`} />
          <span className="text-micro text-ink-faint mk-tabular">{count(pkg.publishes24h)}</span>
        </span>
        <span
          className="text-right text-micro text-ink-faint"
          title={pkg.lastPublishedAt ? fullDate(pkg.lastPublishedAt) : undefined}
        >
          {pkg.lastPublishedAt ? timeAgo(pkg.lastPublishedAt) : ""}
        </span>
      </div>
    </li>
  );
}

export function OwnerPackages() {
  const data = useLoaderData<typeof ownerPackagesLoader>();
  const [filter, setFilter] = useState("");
  const [format, setFormat] = useState<FormatId | "all">("all");
  const formats = useMemo(
    () => [...new Set(data.packages.map((p) => p.format))].sort(),
    [data.packages],
  );
  const shown = data.packages.filter(
    (p) =>
      (format === "all" || p.format === format) &&
      (!filter || p.name.toLowerCase().includes(filter.toLowerCase())),
  );
  const isOrg = data.owner.kind === "org";
  const busiest = data.packages.reduce((sum, p) => sum + p.publishes24h, 0);

  return (
    <Page wide>
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <Monogram
            name={data.owner.displayName}
            shape={isOrg ? "place" : "person"}
            size="lg"
            src={data.owner.avatarUrl}
          />
          <div className="min-w-0">
            <h1 className="m-0 text-headline">Packages</h1>
            <p className="m-0 text-ink-muted">
              <Link
                to={`/${data.owner.slug}`}
                className="text-ink-muted no-underline hover:text-ink"
              >
                @{data.owner.slug}
              </Link>
              {data.packages.length > 0 &&
                ` · ${plural(data.packages.length, "package")}, ${count(busiest)} publishes in the last day`}
            </p>
          </div>
        </div>
        {data.access === "admin" && (
          <Link to={feedsPath(data.owner.slug)} className="mk-btn mk-btn--sm no-underline">
            <GearSixIcon weight="bold" aria-hidden />
            Feeds and proxies
          </Link>
        )}
      </header>

      {data.packages.length === 0 ? (
        <section className="mk-card mt-8">
          <h2 className="mk-card-title">Nothing published yet</h2>
          <p className="mk-card-desc max-w-[48ch]">
            CI jobs in {data.owner.slug}'s repositories publish here with nothing to configure: npm,
            docker, twine, cargo, mvn and helm come set up with the job's credential. From your
            machine, sign in with <code className="mk-mono">gm auth login</code> and run{" "}
            <code className="mk-mono">gm pkg setup</code>.
          </p>
          <pre className="mk-mono mt-3 mb-0 overflow-x-auto rounded-control bg-sunken p-3 text-mono">
            {`# .gitmatrix/ci.yml
jobs:
  release:
    steps:
      - run: npm publish
      - run: docker build -t $GITMATRIX_IMAGE_PREFIX/app:$GITMATRIX_COMMIT . && docker push $GITMATRIX_IMAGE_PREFIX/app:$GITMATRIX_COMMIT`}
          </pre>
        </section>
      ) : (
        <>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <label className="mk-search relative min-w-0 flex-1 basis-60">
              <MagnifyingGlassIcon
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint"
                aria-hidden
              />
              <input
                className="mk-input w-full pl-9"
                value={filter}
                onChange={(e) => setFilter(e.currentTarget.value)}
                placeholder="Find a package"
                aria-label="Find a package"
              />
            </label>
            {formats.length > 1 && (
              <div className="flex flex-wrap gap-2" role="group" aria-label="Format">
                <button
                  type="button"
                  className="mk-chip"
                  aria-pressed={format === "all"}
                  onClick={() => setFormat("all")}
                >
                  All
                </button>
                {formats.map((f) => (
                  <button
                    key={f}
                    type="button"
                    className="mk-chip"
                    aria-pressed={format === f}
                    onClick={() => setFormat(f)}
                  >
                    {formatLabel(f)}
                  </button>
                ))}
              </div>
            )}
          </div>
          {shown.length === 0 ? (
            <div className="mk-empty mt-4">No package matches “{filter}”.</div>
          ) : (
            <ul className="m-0 mt-4 list-none divide-y divide-line-soft overflow-hidden rounded-pane bg-pane p-0">
              {shown.map((pkg) => (
                <PackageRow key={pkg.id} pkg={pkg} owner={data.owner.slug} />
              ))}
            </ul>
          )}
        </>
      )}

      {data.feeds.some((f) => f.kind !== "local") && (
        <section className="mt-10">
          <h2 className="mt-0 mb-3 text-title">Proxies and virtual feeds</h2>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {data.feeds
              .filter((f) => f.kind !== "local")
              .map((feed) => (
                <li key={feed.id} className="flex flex-wrap items-baseline gap-x-3 text-body-sm">
                  <span className="mk-mono text-ink">{feed.key}</span>
                  <span className="text-ink-muted">
                    {formatLabel(feed.format)}{" "}
                    {feed.kind === "remote"
                      ? `proxy of ${feed.upstream ?? "an upstream"}`
                      : `feed over ${feed.members.join(", ") || "nothing yet"}`}
                  </span>
                </li>
              ))}
          </ul>
        </section>
      )}
    </Page>
  );
}
