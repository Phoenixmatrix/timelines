// Data retention (CORE-210): an account's page for its administrators, and the
// site's (site categories and site-wide defaults) for site administrators.
// Both read the retention API (worker/retention/api.ts); the page itself is
// RetentionView.

import { redirect, useLoaderData, useNavigation, useSearchParams } from "react-router";
import type { RetentionRunPage, RetentionSettings } from "../../shared/retention.ts";
import { RetentionView } from "../components/RetentionView.tsx";
import { SettingsPage } from "../components/SettingsPage.tsx";
import { FormError, SelectField } from "../components/ui.tsx";
import { api, ApiError, load } from "../lib/api.ts";
import { requireViewer } from "../lib/session.ts";

const accountPaths = (owner: string) => ({
  settings: `/accounts/${encodeURIComponent(owner)}/settings/retention`,
  runs: `/accounts/${encodeURIComponent(owner)}/retention/runs`,
});
const SITE_PATHS = { settings: "/admin/retention", runs: "/admin/retention/runs" };

export async function retentionLoader({ request }: { request: Request }) {
  const viewer = await requireViewer(request);
  const url = new URL(request.url);
  const owner = url.searchParams.get("owner");
  if (!owner) throw redirect(`/settings/retention?owner=${encodeURIComponent(viewer.slug)}`);
  const accounts: { slug: string; displayName: string }[] = [
    { slug: viewer.slug, displayName: viewer.displayName },
    ...viewer.canCreateIn.filter((a) => a.slug !== viewer.slug),
  ];
  const preselect = url.searchParams.get("cleanup");
  const paths = accountPaths(owner);
  try {
    const [settings, runs] = await Promise.all([
      api<RetentionSettings>(paths.settings, { signal: request.signal }),
      api<RetentionRunPage>(paths.runs, { signal: request.signal }),
    ]);
    return { owner, accounts, settings, runs, preselect, error: "" };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { owner, accounts, settings: null, runs: null, preselect, error: error.message };
  }
}

const INTRO =
  "Choose what Gitmatrix deletes and when. Nothing is deleted until you turn a category on or run a cleanup yourself, and each category says what it never deletes.";

export function DataRetention() {
  const data = useLoaderData<typeof retentionLoader>();
  const [, setParams] = useSearchParams();
  const navigation = useNavigation();
  const options = data.accounts.map((a) => ({
    value: a.slug,
    label: `${a.displayName} (@${a.slug})`,
  }));
  if (!options.some((o) => o.value === data.owner))
    options.push({ value: data.owner, label: `@${data.owner}` });
  return (
    <SettingsPage owner={data.owner} wide>
      <h1 className="m-0 text-headline">Data retention</h1>
      <p className="mt-1.5 mb-0 max-w-[65ch] text-ink-muted">{INTRO}</p>
      <div className="mt-6 flex max-w-md flex-col gap-1 text-field-label">
        Account
        <SelectField
          ariaLabel="Account for data retention"
          value={data.owner}
          options={options}
          onChange={(owner) => setParams({ owner })}
          className="w-full"
        />
      </div>
      <p role="status" className="mt-2 mb-0 text-body-sm text-ink-muted">
        {navigation.state !== "idle"
          ? "Loading data retention…"
          : `Data retention for @${data.owner}`}
      </p>
      {data.settings && data.runs ? (
        <RetentionView
          key={data.owner}
          initial={data.settings}
          initialRuns={data.runs}
          paths={accountPaths(data.owner)}
          preselect={data.preselect}
        />
      ) : (
        <div className="mt-6">
          <FormError message={data.error} />
        </div>
      )}
    </SettingsPage>
  );
}

export async function siteRetentionLoader({ request }: { request: Request }) {
  const viewer = await requireViewer(request);
  if (!viewer.isSiteAdmin) throw redirect("/");
  const [settings, runs] = await Promise.all([
    load<RetentionSettings>(SITE_PATHS.settings, request),
    load<RetentionRunPage>(SITE_PATHS.runs, request),
  ]);
  return { settings, runs, preselect: new URL(request.url).searchParams.get("cleanup") };
}

export function SiteRetention() {
  const data = useLoaderData<typeof siteRetentionLoader>();
  return (
    <SettingsPage wide>
      <h1 className="m-0 text-headline">Site data retention</h1>
      <p className="mt-1.5 mb-0 max-w-[65ch] text-ink-muted">
        Retention for data no account owns, and the defaults every account starts from. Nothing is
        deleted until a category is on or you run a cleanup yourself.
      </p>
      <RetentionView
        initial={data.settings}
        initialRuns={data.runs}
        paths={SITE_PATHS}
        preselect={data.preselect}
      />
    </SettingsPage>
  );
}
