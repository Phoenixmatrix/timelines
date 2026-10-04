// Usage & costs (CORE-209): an account's report for its administrators, and
// the site's report (every account and the site total) for site administrators.
// Both read the bounded report API; the report itself is UsageReportView.

import { redirect, useLoaderData, useNavigation, useSearchParams } from "react-router";
import type { AccountSummary } from "../../shared/api.ts";
import type { UsageReport } from "../../shared/usage.ts";
import { SettingsPage } from "../components/SettingsPage.tsx";
import { FormError, SelectField } from "../components/ui.tsx";
import { UsageReportView } from "../components/UsageReportView.tsx";
import { api, ApiError, load } from "../lib/api.ts";
import { requireViewer } from "../lib/session.ts";

const usagePath = (owner: string) => `/accounts/${encodeURIComponent(owner)}/usage`;

export async function usageLoader({ request }: { request: Request }) {
  const viewer = await requireViewer(request);
  const owner = new URL(request.url).searchParams.get("owner");
  if (!owner) throw redirect(`/settings/usage?owner=${encodeURIComponent(viewer.slug)}`);
  const accounts: { slug: string; displayName: string }[] = [
    { slug: viewer.slug, displayName: viewer.displayName },
    ...viewer.canCreateIn.filter((a) => a.slug !== viewer.slug),
  ];
  try {
    const report = await api<UsageReport>(usagePath(owner), { signal: request.signal });
    if (!accounts.some((a) => a.slug === owner) && report.account) accounts.push(report.account);
    return { owner, accounts, report, error: "" };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { owner, accounts, report: null, error: error.message };
  }
}

const INTRO =
  "What Gitmatrix stores and runs, priced at Cloudflare's published list prices. Figures come from a daily collection; estimated ones are marked.";

export function UsageCosts() {
  const data = useLoaderData<typeof usageLoader>();
  const [, setParams] = useSearchParams();
  const navigation = useNavigation();
  const options: { value: string; label: string }[] = data.accounts.map(
    (account: Pick<AccountSummary, "slug" | "displayName">) => ({
      value: account.slug,
      label: `${account.displayName} (@${account.slug})`,
    }),
  );
  if (!options.some((o) => o.value === data.owner))
    options.push({ value: data.owner, label: `@${data.owner}` });
  return (
    <SettingsPage owner={data.owner}>
      <h1 className="m-0 text-headline">Usage &amp; costs</h1>
      <p className="mt-1.5 mb-0 max-w-[65ch] text-ink-muted">{INTRO}</p>
      <div className="mt-6 flex max-w-md flex-col gap-1 text-field-label">
        Account
        <SelectField
          ariaLabel="Account for usage and costs"
          value={data.owner}
          options={options}
          onChange={(owner) => setParams({ owner })}
          className="w-full"
        />
      </div>
      <p role="status" className="mt-2 mb-0 text-body-sm text-ink-muted">
        {navigation.state !== "idle" ? "Loading usage…" : `Usage for @${data.owner}`}
      </p>
      {data.report ? (
        <UsageReportView
          key={data.owner}
          report={data.report}
          owner={data.owner}
          csvHref={`/api${usagePath(data.owner)}?format=csv`}
        />
      ) : (
        <div className="mt-6">
          <FormError message={data.error} />
        </div>
      )}
    </SettingsPage>
  );
}

export async function siteUsageLoader({ request }: { request: Request }) {
  const viewer = await requireViewer(request);
  if (!viewer.isSiteAdmin) throw redirect("/");
  return load<UsageReport>("/admin/usage", request);
}

export function SiteUsage() {
  const report = useLoaderData<typeof siteUsageLoader>();
  return (
    <SettingsPage>
      <h1 className="m-0 text-headline">Site usage &amp; costs</h1>
      <p className="mt-1.5 mb-0 max-w-[65ch] text-ink-muted">
        Every account&apos;s usage and the site&apos;s own data (shared caches, the registry&apos;s
        blobs counted once), priced at Cloudflare&apos;s published list prices.
      </p>
      <UsageReportView report={report} owner={null} csvHref="/api/admin/usage?format=csv" />
    </SettingsPage>
  );
}
