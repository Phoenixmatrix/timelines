// Person, Space, and Instance reports use independent authorization boundaries.
import { redirect, useLoaderData, useNavigation, useSearchParams } from "react-router";
import type { UsageReport } from "../../shared/usage.ts";
import { SettingsPage } from "../components/SettingsPage.tsx";
import { FormError, SelectField } from "../components/ui.tsx";
import { UsageReportView } from "../components/UsageReportView.tsx";
import { api, ApiError, load } from "../lib/api.ts";
import { requireViewer } from "../lib/session.ts";

export async function usageLoader({ request }: { request: Request }) {
  const viewer = await requireViewer(request);
  const params = new URL(request.url).searchParams;
  const space = params.get("space");
  const person = params.get("person");
  if (params.has("owner") || (space && person))
    throw new Response("Choose a Space or your personal usage, not an ambiguous scope.", {
      status: 400,
    });
  if (!space && !person)
    throw redirect(`/settings/usage?person=${encodeURIComponent(viewer.slug)}`);
  if (person && person !== viewer.slug)
    throw new Response("Personal usage is only available to that person.", { status: 403 });
  const subject = space ?? person!;
  const scope = space ? "space" : "person";
  const path = `/${space ? "spaces" : "accounts"}/${encodeURIComponent(subject)}/usage`;
  const options = [
    { value: `person:${viewer.slug}`, label: `Personal / ${viewer.displayName} (@${viewer.slug})` },
    ...viewer.spaces.map((entry) => ({
      value: `space:${entry.slug}`,
      label: `${entry.organization.displayName} / ${entry.displayName} (@${entry.slug})`,
    })),
  ];
  const selected = `${scope}:${subject}`;
  if (!options.some((entry) => entry.value === selected))
    options.push({ value: selected, label: `Space / @${subject}` });
  try {
    const report = await api<UsageReport>(path, { signal: request.signal });
    return { space, subject, scope, path, options, selected, report, error: "" };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { space, subject, scope, path, options, selected, report: null, error: error.message };
  }
}

export function UsageCosts() {
  const data = useLoaderData<typeof usageLoader>();
  const [, setParams] = useSearchParams();
  const navigation = useNavigation();
  return (
    <SettingsPage space={data.space ?? undefined} wide>
      <h1 className="m-0 text-headline">Usage &amp; costs</h1>
      <p className="mt-1.5 mb-0 max-w-[65ch] text-ink-muted">
        What Timelines stores and runs, priced at Cloudflare's published list prices. Figures come
        from a daily collection; estimated ones are marked. Space usage requires an explicit Space
        admin grant. Personal usage includes only your own activity.
      </p>
      <div className="mt-6 flex max-w-md flex-col gap-1 text-field-label">
        Usage scope
        <SelectField
          ariaLabel="Scope for usage and costs"
          value={data.selected}
          options={data.options}
          onChange={(value) => {
            const separator = value.indexOf(":");
            setParams({ [value.slice(0, separator)]: value.slice(separator + 1) });
          }}
          className="w-full"
        />
      </div>
      <p role="status" className="mt-2 mb-0 text-body-sm text-ink-muted">
        {navigation.state !== "idle"
          ? "Loading usage…"
          : `${data.scope === "space" ? "Space" : "Personal"} usage for @${data.subject}`}
      </p>
      {data.report ? (
        <UsageReportView
          key={data.selected}
          report={data.report}
          csvHref={`/api${data.path}?format=csv`}
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
    <SettingsPage wide>
      <h1 className="m-0 text-headline">Instance usage &amp; costs</h1>
      <p className="mt-1.5 mb-0 max-w-[65ch] text-ink-muted">
        Space and personal usage alongside Instance infrastructure (shared caches and the registry's
        blobs counted once), priced at Cloudflare's published list prices.
      </p>
      <UsageReportView report={report} csvHref="/api/admin/usage?format=csv" />
    </SettingsPage>
  );
}
