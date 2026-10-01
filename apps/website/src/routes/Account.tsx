import { link } from "../components/ui.tsx";
import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import type { AccountPage } from "../../shared/api.ts";
import { Page } from "../components/AppShell.tsx";
import { Monogram } from "../components/Monogram.tsx";
import { RepoList } from "../components/RepoList.tsx";
import { load } from "../lib/api.ts";
import { packagesPath } from "../lib/packages.ts";

export async function accountLoader({ request, params }: LoaderFunctionArgs) {
  return load<AccountPage>(`/accounts/${params.owner}`, request);
}

export function Account() {
  const account = useLoaderData<typeof accountLoader>();
  const isOrg = account.kind === "org";

  return (
    <Page>
      <header className="flex items-center gap-4">
        <Monogram name={account.displayName} shape={isOrg ? "place" : "person"} size="lg" />
        <div className="min-w-0">
          <h1 className="m-0 text-headline">
            <bdi>{account.displayName}</bdi>
          </h1>
          <p className="m-0 text-ink-muted">
            @{account.slug}
            {isOrg && " · Organization"}
          </p>
        </div>
      </header>
      {account.bio && (
        <p className="mt-4 mb-0 max-w-[48ch] text-ink-muted" dir="auto">
          {account.bio}
        </p>
      )}

      <div className="mt-8 grid gap-6 md:grid-cols-[1fr_15rem]">
        <section>
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="m-0 text-title">Repositories</h2>
            <Link to={packagesPath(account.slug)} className={`${link} text-body-sm`}>
              Packages
            </Link>
          </div>
          <RepoList repos={account.repos} showOwner={false} empty="No repositories you can see." />
        </section>
        {isOrg && (
          <section>
            <h2 className="mt-0 mb-3 text-title">People</h2>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {account.members.map((member) => (
                <li key={member.id}>
                  <Link
                    to={`/${member.slug}`}
                    className="flex items-center gap-3 rounded-control px-2 py-1.5 text-ink no-underline hover:bg-pane"
                  >
                    <Monogram name={member.displayName} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">
                        <bdi>{member.displayName}</bdi>
                      </span>
                      <span className="block text-micro text-ink-faint">
                        {member.role === "owner" ? "Owner" : "Member"}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Page>
  );
}
