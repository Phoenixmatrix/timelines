// Packages in the viewer's explicitly granted Spaces, subject to each feed's ACL.

import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import type { SpacePackages as SpacePackagesData } from "../../../shared/packages.ts";
import { Page } from "../../components/AppShell.tsx";
import { Monogram } from "../../components/Monogram.tsx";
import { link } from "../../components/ui.tsx";
import { load } from "../../lib/api.ts";
import { packagesPath, plural } from "../../lib/packages.ts";
import { requireViewer } from "../../lib/session.ts";
import { PackageRow } from "./SpacePackages.tsx";

/** Packages shown per space before "All of …". */
const RECENT = 5;

export async function allPackagesLoader({ request }: LoaderFunctionArgs) {
  const viewer = await requireViewer(request);
  const spaces = await Promise.all(
    viewer.spaces.map((space) =>
      load<SpacePackagesData>(`/packages/${encodeURIComponent(space.slug)}`, request),
    ),
  );
  return { spaces };
}

export function AllPackages() {
  const { spaces } = useLoaderData<typeof allPackagesLoader>();
  return (
    <Page wide>
      <h1 className="m-0 text-headline">Packages</h1>
      <p className="mt-1.5 mb-0 max-w-[48ch] text-ink-muted">
        What your Spaces publish, most recent first.
      </p>
      <div className="mt-8 flex flex-col gap-10">
        {spaces.map((data) => {
          const recent = data.packages
            .toSorted((a, b) => (b.lastPublishedAt ?? "").localeCompare(a.lastPublishedAt ?? ""))
            .slice(0, RECENT);
          return (
            <section key={data.space.id} aria-labelledby={`packages-${data.space.slug}`}>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h2
                  id={`packages-${data.space.slug}`}
                  className="m-0 flex items-center gap-3 text-title"
                >
                  <Monogram name={data.space.displayName} shape="place" />
                  <bdi>{data.space.displayName}</bdi>
                  {data.packages.length > 0 && (
                    <span className="text-body-sm font-normal text-ink-faint">
                      {plural(data.packages.length, "package")}
                    </span>
                  )}
                </h2>
                <Link to={packagesPath(data.space.slug)} className={`${link} text-body-sm`}>
                  {data.packages.length > RECENT
                    ? `All of ${data.space.slug}'s packages`
                    : `${data.space.slug}'s packages`}
                </Link>
              </div>
              {recent.length === 0 ? (
                <p className="mk-empty m-0">Nothing published yet.</p>
              ) : (
                <ul className="m-0 list-none divide-y divide-line-soft overflow-hidden rounded-pane bg-pane p-0">
                  {recent.map((pkg) => (
                    <PackageRow key={pkg.id} pkg={pkg} space={data.space.slug} />
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
