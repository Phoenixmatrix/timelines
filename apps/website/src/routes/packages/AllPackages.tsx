// The rail's Packages place: every owner you publish as (you, then your
// organizations), each with its most recently published packages.

import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import type { OwnerPackages as OwnerPackagesData } from "../../../shared/packages.ts";
import { Page } from "../../components/AppShell.tsx";
import { Monogram } from "../../components/Monogram.tsx";
import { link } from "../../components/ui.tsx";
import { load } from "../../lib/api.ts";
import { packagesPath, plural } from "../../lib/packages.ts";
import { requireViewer } from "../../lib/session.ts";
import { PackageRow } from "./OwnerPackages.tsx";

/** Packages shown per owner before "All of …". */
const RECENT = 5;

export async function allPackagesLoader({ request }: LoaderFunctionArgs) {
  const viewer = await requireViewer(request);
  const owners = await Promise.all(
    viewer.canCreateIn.map((owner) =>
      load<OwnerPackagesData>(`/packages/${encodeURIComponent(owner.slug)}`, request),
    ),
  );
  return { owners };
}

export function AllPackages() {
  const { owners } = useLoaderData<typeof allPackagesLoader>();
  return (
    <Page wide>
      <h1 className="m-0 text-headline">Packages</h1>
      <p className="mt-1.5 mb-0 max-w-[48ch] text-ink-muted">
        What you and your organizations publish, most recent first.
      </p>
      <div className="mt-8 flex flex-col gap-10">
        {owners.map((data) => {
          const recent = data.packages
            .toSorted((a, b) => (b.lastPublishedAt ?? "").localeCompare(a.lastPublishedAt ?? ""))
            .slice(0, RECENT);
          return (
            <section key={data.owner.id} aria-labelledby={`packages-${data.owner.slug}`}>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h2
                  id={`packages-${data.owner.slug}`}
                  className="m-0 flex items-center gap-3 text-title"
                >
                  <Monogram
                    name={data.owner.displayName}
                    shape={data.owner.kind === "org" ? "place" : "person"}
                  />
                  <bdi>{data.owner.displayName}</bdi>
                  {data.packages.length > 0 && (
                    <span className="text-body-sm font-normal text-ink-faint">
                      {plural(data.packages.length, "package")}
                    </span>
                  )}
                </h2>
                <Link to={packagesPath(data.owner.slug)} className={`${link} text-body-sm`}>
                  {data.packages.length > RECENT
                    ? `All of ${data.owner.slug}'s packages`
                    : `${data.owner.slug}'s packages`}
                </Link>
              </div>
              {recent.length === 0 ? (
                <p className="mk-empty m-0">Nothing published yet.</p>
              ) : (
                <ul className="m-0 list-none divide-y divide-line-soft overflow-hidden rounded-pane bg-pane p-0">
                  {recent.map((pkg) => (
                    <PackageRow key={pkg.id} pkg={pkg} owner={data.owner.slug} />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </Page>
  );
}
