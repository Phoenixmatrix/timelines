// Retention policy and cleanup are scoped independently to a Space, person, or Instance.
import { redirect, useLoaderData, useNavigation, useSearchParams } from "react-router";
import type { RetentionRunPage, RetentionSettings } from "../../shared/retention.ts";
import { RetentionView } from "../components/RetentionView.tsx";
import { SettingsPage } from "../components/SettingsPage.tsx";
import { FormError, SelectField } from "../components/ui.tsx";
import { api, ApiError, load } from "../lib/api.ts";
import { requireViewer } from "../lib/session.ts";

const INSTANCE_PATHS = { settings: "/admin/retention", runs: "/admin/retention/runs" };

export async function retentionLoader({ request }: { request: Request }) {
  const viewer = await requireViewer(request);
  const params = new URL(request.url).searchParams;
  const space = params.get("space");
  const person = params.get("person");
  if (params.has("owner") || (space && person))
    throw new Response("Choose a Space or your personal retention, not an ambiguous scope.", {
      status: 400,
    });
  if (!space && !person) {
    params.set("person", viewer.slug);
    throw redirect(`/settings/retention?${params}`);
  }
  if (person && person !== viewer.slug)
    throw new Response("Personal retention is only available to that person.", { status: 403 });
  const subject = space ?? person!;
  const scope = space ? "space" : "person";
  const base = `/${space ? "spaces" : "accounts"}/${encodeURIComponent(subject)}/retention`;
  const paths = { settings: base, runs: `${base}/runs` };
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
  const preselect = params.get("cleanup");
  try {
    const [settings, runs] = await Promise.all([
      api<RetentionSettings>(paths.settings, { signal: request.signal }),
      api<RetentionRunPage>(paths.runs, { signal: request.signal }),
    ]);
    return {
      space,
      subject,
      scope,
      selected,
      options,
      paths,
      settings,
      runs,
      preselect,
      error: "",
    };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return {
      space,
      subject,
      scope,
      selected,
      options,
      paths,
      settings: null,
      runs: null,
      preselect,
      error: error.message,
    };
  }
}

export function DataRetention() {
  const data = useLoaderData<typeof retentionLoader>();
  const [, setParams] = useSearchParams();
  const navigation = useNavigation();
  return (
    <SettingsPage space={data.space ?? undefined} wide>
      <h1 className="m-0 text-headline">Data retention</h1>
      <p className="mt-1.5 mb-0 max-w-[65ch] text-ink-muted">
        Choose what Timelines deletes and when. Nothing is deleted until you turn a category on or
        run a cleanup yourself, and each category says what it never deletes.
      </p>
      <div className="mt-6 flex max-w-md flex-col gap-1 text-field-label">
        Retention scope
        <SelectField
          ariaLabel="Scope for data retention"
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
          ? "Loading data retention…"
          : `${data.scope === "space" ? "Space" : "Personal"} retention for @${data.subject}`}
      </p>
      {data.settings && data.runs ? (
        <RetentionView
          key={data.selected}
          initial={data.settings}
          initialRuns={data.runs}
          paths={data.paths}
          preselect={data.preselect}
          usageHref={`/settings/usage?${data.scope}=${encodeURIComponent(data.subject)}`}
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
    load<RetentionSettings>(INSTANCE_PATHS.settings, request),
    load<RetentionRunPage>(INSTANCE_PATHS.runs, request),
  ]);
  return { settings, runs, preselect: new URL(request.url).searchParams.get("cleanup") };
}

export function SiteRetention() {
  const data = useLoaderData<typeof siteRetentionLoader>();
  return (
    <SettingsPage wide>
      <h1 className="m-0 text-headline">Instance data retention</h1>
      <p className="mt-1.5 mb-0 max-w-[65ch] text-ink-muted">
        Retention for Instance infrastructure and the defaults for Spaces and people. Nothing is
        deleted until a category is on or you run a cleanup yourself.
      </p>
      <RetentionView
        initial={data.settings}
        initialRuns={data.runs}
        paths={INSTANCE_PATHS}
        preselect={data.preselect}
        usageHref="/settings/site-usage"
      />
    </SettingsPage>
  );
}
