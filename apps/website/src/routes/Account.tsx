import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import type { AccountPage } from "../../shared/api.ts";
import { Page } from "../components/AppShell.tsx";
import { Monogram } from "../components/Monogram.tsx";
import { link } from "../components/ui.tsx";
import { load } from "../lib/api.ts";
import { useViewer } from "../lib/session.ts";

export async function accountLoader({ request, params }: LoaderFunctionArgs) {
  return load<AccountPage>(`/accounts/${encodeURIComponent(params.person!)}`, request);
}

export function Account() {
  const account = useLoaderData<typeof accountLoader>();
  const viewer = useViewer();
  return (
    <Page>
      <header className="flex items-center gap-4">
        <Monogram name={account.displayName} shape="person" size="lg" src={account.avatarUrl} />
        <div className="min-w-0">
          <h1 className="m-0 text-headline">
            <bdi>{account.displayName}</bdi>
          </h1>
          <p className="m-0 text-ink-muted">@{account.slug} · Person</p>
        </div>
        {viewer?.id === account.id && (
          <Link to="/settings/profile" className={`${link} ml-auto`}>
            Edit profile
          </Link>
        )}
      </header>
      {account.bio && (
        <p className="mt-4 mb-0 max-w-[65ch] text-ink-muted" dir="auto">
          {account.bio}
        </p>
      )}
      <p className="mt-8 text-ink-muted">
        Repositories and work belong to Spaces. This profile identifies the person behind their
        contributions.
      </p>
      {viewer?.id === account.id && (
        <Link to="/organizations" className={link}>
          Your Organizations and Spaces
        </Link>
      )}
    </Page>
  );
}
