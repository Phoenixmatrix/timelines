import { link } from "../../components/ui.tsx";
import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import type { PackageSummary } from "../../../shared/packages.ts";
import { load } from "../../lib/api.ts";
import { packagesPath } from "../../lib/packages.ts";
import { PackageRow } from "../packages/OwnerPackages.tsx";
import { useRepo } from "./RepoLayout.tsx";
import { Link } from "react-router";

export async function repoPackagesLoader({ request, params }: LoaderFunctionArgs) {
  return load<{ packages: PackageSummary[] }>(
    `/packages/-/repo-packages?repo=${encodeURIComponent(`${params.owner}/${params.repo}`)}`,
    request,
  );
}

/** What this repository publishes: packages it's a source of, newest activity first. */
export function RepoPackages() {
  const { packages } = useLoaderData<typeof repoPackagesLoader>();
  const repo = useRepo();
  if (packages.length === 0) {
    return (
      <section className="mk-card max-w-[44rem]">
        <h2 className="mk-card-title">Nothing published from {repo.name} yet</h2>
        <p className="mk-card-desc max-w-[48ch]">
          A CI job that runs <code className="mk-mono">npm publish</code>,{" "}
          <code className="mk-mono">docker push</code>,{" "}
          <code className="mk-mono">twine upload</code> or{" "}
          <code className="mk-mono">cargo publish</code> publishes to {repo.owner.slug}'s registries
          with the job's own credential, and the package remembers it came from here.
        </p>
      </section>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="m-0 text-title">Published from {repo.name}</h2>
        <Link to={packagesPath(repo.owner.slug)} className={`${link} text-body-sm`}>
          All of {repo.owner.slug}'s packages
        </Link>
      </div>
      <ul className="m-0 list-none divide-y divide-line-soft overflow-hidden rounded-pane bg-pane p-0">
        {packages.map((pkg) => (
          <PackageRow key={pkg.id} pkg={pkg} owner={pkg.feed.split(".")[0] ?? repo.owner.slug} />
        ))}
      </ul>
    </div>
  );
}
