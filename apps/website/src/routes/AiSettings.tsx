import { useEffect, useRef, useState } from "react";
import {
  Link,
  redirect,
  useLoaderData,
  useNavigation,
  useRevalidator,
  useSearchParams,
  type LoaderFunctionArgs,
} from "react-router";
import type { AccountSummary } from "../../shared/api.ts";
import {
  AI_PROVIDERS,
  MAX_KNOWLEDGE_WAIT_MINUTES,
  type AiFeatures,
  type AiLogBodiesPatch,
  type AiLogComponent,
  type AiModelOption,
  type AiModelSelection,
  type AiRole,
  type AiSettingsPatch,
  type AiSettingsView,
  type KnowledgeUpdateSchedule,
} from "../../shared/ai.ts";
import { modelPriceParts } from "../components/ModelPrices.tsx";
import { SettingsPage } from "../components/SettingsPage.tsx";
import { FormError, SelectField, link } from "../components/ui.tsx";
import { api, ApiError } from "../lib/api.ts";
import { requireViewer } from "../lib/session.ts";

export async function aiSettingsLoader({ request }: LoaderFunctionArgs) {
  const viewer = await requireViewer(request);
  const url = new URL(request.url);
  const owner = url.searchParams.get("owner");
  if (!owner) throw redirect(`/settings/ai?owner=${encodeURIComponent(viewer.slug)}`);
  const accounts = [...viewer.canCreateIn];
  try {
    const settings = await api<AiSettingsView>(
      `/accounts/${encodeURIComponent(owner)}/settings/ai`,
      { signal: request.signal },
    );
    if (!accounts.some((account) => account.slug === owner)) {
      accounts.push(
        await api<AccountSummary>(`/accounts/${encodeURIComponent(owner)}`, {
          signal: request.signal,
        }),
      );
    }
    return { owner, accounts, settings, error: "" };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { owner, accounts, settings: null, error: error.message };
  }
}

const FEATURES: { key: keyof AiFeatures; title: string; description: string }[] = [
  {
    key: "knowledge",
    title: "Knowledge",
    description:
      "Analyze repository changes, create embeddings, and ingest content into AI Search.",
  },
  {
    key: "wiki",
    title: "Wiki",
    description:
      "Generate repository wiki pages and timeline checkpoint pages. Requires Knowledge.",
  },
  {
    key: "atlas",
    title: "Atlas descriptions",
    description:
      "Generate AI capability descriptions. The deterministic Atlas map remains available. Requires Knowledge.",
  },
  {
    key: "releaseNotes",
    title: "Release notes",
    description: "Automatically generate release notes for new repository changes.",
  },
];
const SCHEDULE: { key: keyof KnowledgeUpdateSchedule; label: string; hint: string }[] = [
  {
    key: "quietMinutes",
    label: "Quiet period",
    hint: "Update once pushes have paused this long.",
  },
  {
    key: "maxWaitMinutes",
    label: "Longest wait",
    hint: "Never wait longer than this after the first push.",
  },
];

const ROLES: { key: AiRole; title: string; description: string }[] = [
  {
    key: "classification",
    title: "Classification",
    description: "Structured decisions about repository changes.",
  },
  { key: "fast", title: "Fast", description: "Lightweight analysis and generation." },
  {
    key: "task",
    title: "Task",
    description: "Longer synthesis, wiki pages, and Atlas descriptions.",
  },
];
/** A provider model's name says whose it is; the built-in ones run on Workers AI. */
function modelName(option: AiModelOption) {
  const provider = AI_PROVIDERS.find((info) => info.kind === option.provider);
  return provider ? `${option.name} (${provider.name})` : option.name;
}
const releaseDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function AiSettings() {
  const data = useLoaderData<typeof aiSettingsLoader>();
  const [, setParams] = useSearchParams();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const switching = navigation.state !== "idle";
  return (
    <SettingsPage owner={data.owner}>
      <div className="max-w-3xl">
        <h1 className="m-0 text-headline">AI settings</h1>
        <p className="mt-1.5 mb-0 max-w-[65ch] text-ink-muted">
          Control automatic AI work across every repository owned by an account. Agent chat and
          interactive search are unchanged.
        </p>
        <div className="mt-6 flex max-w-md flex-col gap-1 text-field-label">
          Account
          <SelectField
            ariaLabel="Account for AI settings"
            value={data.owner}
            options={[
              ...data.accounts.map((account) => ({
                value: account.slug,
                label: `${account.displayName} (@${account.slug})`,
              })),
              ...(!data.accounts.some((account) => account.slug === data.owner)
                ? [{ value: data.owner, label: `@${data.owner}` }]
                : []),
            ]}
            onChange={(owner) => setParams({ owner })}
            className="w-full"
          />
        </div>
        <p role="status" className="mt-2 mb-0 text-body-sm text-ink-muted">
          {switching ? "Loading account settings…" : `Settings for @${data.owner}`}
        </p>
        {data.settings ? (
          <AiSettingsForm
            key={data.owner}
            owner={data.owner}
            initial={data.settings}
            switching={switching}
          />
        ) : (
          <div className="mt-6 flex flex-col items-start gap-3">
            <FormError message={data.error} />
            <button
              type="button"
              className="mk-btn mk-btn--secondary min-h-11"
              disabled={switching || revalidator.state !== "idle"}
              onClick={() => void revalidator.revalidate()}
            >
              {revalidator.state !== "idle" ? "Loading…" : "Retry loading settings"}
            </button>
          </div>
        )}
      </div>
    </SettingsPage>
  );
}

function AiSettingsForm({
  owner,
  initial,
  switching,
}: {
  owner: string;
  initial: AiSettingsView;
  switching: boolean;
}) {
  const [saved, setSaved] = useState(initial);
  const [features, setFeatures] = useState(initial.features);
  const [models, setModels] = useState(initial.models);
  // Kept as typed text, so a field can be cleared while editing.
  const scheduleText = (v: AiSettingsView) => ({
    quietMinutes: String(v.knowledgeUpdates.quietMinutes),
    maxWaitMinutes: String(v.knowledgeUpdates.maxWaitMinutes),
  });
  const [schedule, setSchedule] = useState(scheduleText(initial));
  // Gateway body logging overrides (CORE-290): null follows the site default.
  const overrides = (v: AiSettingsView) =>
    Object.fromEntries(
      v.logBodies.components.map((e) => [e.component, e.account ?? null]),
    ) as Record<AiLogComponent, boolean | null>;
  const [logBodies, setLogBodies] = useState(overrides(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const busy = saving || switching;
  const patch: AiSettingsPatch = {};
  for (const { key } of FEATURES) {
    if (features[key] !== saved.features[key]) (patch.features ??= {})[key] = features[key];
  }
  if (models.classification !== saved.models.classification)
    (patch.models ??= {}).classification = models.classification;
  if (models.fast !== saved.models.fast) (patch.models ??= {}).fast = models.fast;
  if (models.task !== saved.models.task) (patch.models ??= {}).task = models.task;
  const minutes = (text: string) =>
    /^\d+$/.test(text.trim()) && Number(text) <= MAX_KNOWLEDGE_WAIT_MINUTES ? Number(text) : null;
  const invalidSchedule = SCHEDULE.filter(({ key }) => minutes(schedule[key]) === null);
  for (const { key } of SCHEDULE) {
    const value = minutes(schedule[key]);
    if (value !== null && value !== saved.knowledgeUpdates[key])
      (patch.knowledgeUpdates ??= {})[key] = value;
  }
  for (const entry of saved.logBodies.components) {
    const choice = logBodies[entry.component];
    if (choice !== (entry.account ?? null))
      (patch.logBodies ??= {} as AiLogBodiesPatch)[entry.component] = choice;
  }
  const dirty = !!(patch.features || patch.models || patch.knowledgeUpdates || patch.logBodies);
  const changed = () => {
    setNotice("");
    setError("");
  };

  return (
    <form
      className="mk-card mt-6 flex flex-col gap-8"
      aria-busy={busy}
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || !saved.canManage || !dirty || invalidSchedule.length) return;
        setSaving(true);
        changed();
        try {
          const persisted = await api<AiSettingsView>(
            `/accounts/${encodeURIComponent(owner)}/settings/ai`,
            { method: "PATCH", json: patch },
          );
          if (!active.current) return;
          setSaved(persisted);
          setFeatures(persisted.features);
          setModels(persisted.models);
          setSchedule(scheduleText(persisted));
          setLogBodies(overrides(persisted));
          setNotice(`AI settings saved for @${owner}. New jobs will use these settings.`);
        } catch (cause) {
          if (active.current)
            setError(cause instanceof Error ? cause.message : "Couldn't save settings. Try again.");
        } finally {
          if (active.current) setSaving(false);
        }
      }}
    >
      <div className="flex flex-col gap-2 text-body-sm text-ink-muted">
        <p className="m-0">
          Changes apply only to jobs that start after you save. Running work, including retries,
          keeps its original settings and models. Existing knowledge, wiki pages, Atlas
          descriptions, and release notes remain readable.
        </p>
        <p className="m-0">
          Saving does not rebuild repositories. Re-enabled features resume on the next ordinary
          trigger.
        </p>
        {!saved.canManage && (
          <p className="m-0 font-semibold text-ink">
            Read-only access. Only a signed-in human account owner, organization owner, or site
            admin can change this account’s AI settings. Agents cannot change spending policy.
          </p>
        )}
      </div>
      <fieldset disabled={busy || !saved.canManage} className="m-0 min-w-0 border-0 p-0">
        <legend className="mb-3 text-title">Automatic features</legend>
        <div className="flex flex-col gap-4">
          {FEATURES.map(({ key, title, description }) => (
            <div key={key}>
              <label className="flex min-h-11 cursor-pointer items-center gap-3 font-semibold">
                <input
                  type="checkbox"
                  className="m-0 size-4 shrink-0 cursor-pointer accent-signal"
                  checked={features[key]}
                  aria-describedby={`ai-${key}-help`}
                  onChange={(event) => {
                    setFeatures({ ...features, [key]: event.target.checked });
                    changed();
                  }}
                />
                {title}
              </label>
              <p
                id={`ai-${key}-help`}
                className="mt-0 mb-0 ml-7 max-w-[65ch] text-body-sm text-ink-muted"
              >
                {description}
              </p>
            </div>
          ))}
        </div>
        <p className="mt-4 mb-0 text-body-sm text-ink-muted">
          {features.knowledge
            ? "Turning Knowledge off also stops new Wiki and Atlas AI work. Their individual preferences are kept."
            : "Knowledge is off: no new Knowledge, Wiki, or Atlas AI work will start, even if Wiki or Atlas descriptions are checked. Their preferences are kept for when Knowledge is re-enabled."}
        </p>
      </fieldset>
      <fieldset disabled={busy || !saved.canManage} className="m-0 min-w-0 border-0 p-0">
        <legend className="mb-2 text-title">Knowledge updates</legend>
        <p className="mt-0 mb-4 max-w-[65ch] text-body-sm text-ink-muted">
          Pushes to a repository’s default branch are batched: one update runs at the latest commit
          once pushes pause, and never later than the longest wait after the first one. Repository
          admins can start a waiting update at once. 0 means no wait.
        </p>
        <div className="flex flex-wrap gap-6">
          {SCHEDULE.map(({ key, label, hint }) => {
            const inputId = `knowledge-${key}`;
            const bad = invalidSchedule.some((s) => s.key === key);
            return (
              <div key={key} className="flex min-w-0 flex-col gap-1">
                <label htmlFor={inputId} className="text-field-label">
                  {label}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id={inputId}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={MAX_KNOWLEDGE_WAIT_MINUTES}
                    step={1}
                    required
                    value={schedule[key]}
                    aria-invalid={bad || undefined}
                    aria-describedby={`${inputId}-hint`}
                    onChange={(event) => {
                      setSchedule({ ...schedule, [key]: event.target.value });
                      changed();
                    }}
                    className="mk-input w-28 tabular-nums"
                  />
                  <span className="text-body-sm text-ink-muted">minutes</span>
                </div>
                <span id={`${inputId}-hint`} className="text-body-sm text-ink-faint">
                  {bad ? `A whole number from 0 to ${MAX_KNOWLEDGE_WAIT_MINUTES}.` : hint}
                </span>
              </div>
            );
          })}
        </div>
      </fieldset>
      <fieldset disabled={busy || !saved.canManage} className="m-0 min-w-0 border-0 p-0">
        <legend className="mb-2 text-title">Models for new work</legend>
        <p className="mt-0 mb-5 text-body-sm text-ink-muted">
          Published provider prices in USD per million tokens, not an estimate of your bill. Release
          dates help compare model recency. Embedding models are fixed and are not changed here.
        </p>
        <p className="mt-0 mb-5 text-body-sm text-ink-muted">
          More models: connect this account’s own TypeSafe or OpenRouter key in{" "}
          <Link to={`/settings/ai-providers?owner=${encodeURIComponent(owner)}`} className={link}>
            AI providers
          </Link>
          . Their calls are billed to that key.
        </p>
        <div className="flex flex-col gap-6">
          {ROLES.map(({ key, title, description }) => (
            <div key={key} className="min-w-0">
              <h3 className="m-0 text-field-label">{title}</h3>
              <p className="mt-1 mb-2 text-body-sm text-ink-muted">{description}</p>
              {saved.canManage && saved.catalog[key].length > 1 ? (
                <SelectField
                  ariaLabel={`${title} model`}
                  value={models[key]}
                  options={saved.catalog[key].map((option) => ({
                    value: option.id,
                    label: modelName(option),
                  }))}
                  className="w-full max-w-md"
                  onChange={(value) => {
                    if (busy) return;
                    setModels({ ...models, [key]: value } as AiModelSelection);
                    changed();
                  }}
                />
              ) : (
                <p className="mt-0 mb-2 font-semibold">
                  {(() => {
                    const option = saved.catalog[key].find((entry) => entry.id === models[key]);
                    return option ? modelName(option) : models[key];
                  })()}
                </p>
              )}
              <ul className="mt-3 mb-0 flex list-none flex-col gap-3 p-0 text-body-sm">
                {saved.catalog[key].map((option) => (
                  <li key={option.id} className="flex flex-wrap gap-x-2 gap-y-1">
                    <a href={option.url} className={link} target="_blank" rel="noreferrer">
                      {modelName(option)}
                      <span className="sr-only"> provider details (opens in a new tab)</span>
                    </a>
                    <span className="text-ink-muted">
                      {modelPriceParts(option).join(" / ")}
                      {option.releasedAt && (
                        <>
                          {" "}
                          · Released{" "}
                          <time dateTime={option.releasedAt}>
                            {releaseDate.format(new Date(`${option.releasedAt}T00:00:00Z`))}
                          </time>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </fieldset>
      <fieldset
        disabled={busy || !saved.canManage}
        className="m-0 min-w-0 border-0 p-0"
        data-log-bodies="account"
      >
        <legend className="mb-2 text-title">
          Keep AI request and response bodies in gateway logs
        </legend>
        <p className="mt-0 mb-2 max-w-[65ch] text-body-sm text-ink-muted">
          AI Gateway records model, time and token metadata when logging is available. Choose, for
          this account’s calls, whether it also stores what was sent and returned, subject to
          Cloudflare’s log limits. By default each part follows the site’s setting. Changes reach
          new model calls within a minute, including running work.
        </p>
        <p
          className="mt-0 mb-4 max-w-[65ch] text-body-sm font-semibold text-ink"
          data-log-bodies-note
        >
          {saved.logBodies.note}
        </p>
        <p className="mt-0 mb-4 max-w-[65ch] text-body-sm text-ink-muted">
          <a
            href="https://developers.cloudflare.com/ai-gateway/reference/limits/"
            className={link}
            target="_blank"
            rel="noreferrer"
          >
            Cloudflare log limits
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
        <div className="flex flex-col gap-5">
          {saved.logBodies.components.map((entry) => {
            const choice = logBodies[entry.component];
            const effective = choice ?? entry.site;
            const helpId = `log-bodies-${entry.component}-help`;
            return (
              <div
                key={entry.component}
                className="min-w-0"
                data-log-bodies-component={entry.component}
              >
                <h3 className="m-0 text-field-label">{entry.label}</h3>
                <p id={helpId} className="mt-1 mb-2 max-w-[65ch] text-body-sm text-ink-muted">
                  {entry.description} Now: {effective ? "kept" : "not kept"}
                  {choice === null ? " (site default)" : ""}.
                </p>
                {saved.canManage ? (
                  <SelectField
                    ariaLabel={`${entry.label}: keep request and response bodies`}
                    ariaDescribedBy={helpId}
                    value={choice === null ? "site" : choice ? "on" : "off"}
                    options={[
                      { value: "site", label: `Site default (${entry.site ? "on" : "off"})` },
                      { value: "on", label: "On: keep bodies" },
                      { value: "off", label: "Off: metadata only" },
                    ]}
                    className="w-full max-w-md"
                    onChange={(value) => {
                      if (busy) return;
                      setLogBodies({
                        ...logBodies,
                        [entry.component]: value === "site" ? null : value === "on",
                      });
                      changed();
                    }}
                  />
                ) : (
                  <p className="m-0 font-semibold">
                    {choice === null
                      ? `Site default (${entry.site ? "on" : "off"})`
                      : choice
                        ? "On"
                        : "Off"}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </fieldset>
      <div className="flex flex-col items-start gap-3 border-t border-line pt-5">
        <p className="m-0 text-body-sm text-ink-muted">
          {saved.updatedAt
            ? `Last saved ${new Date(saved.updatedAt).toLocaleString()}.`
            : "Using account defaults; no custom settings have been saved."}
        </p>
        <FormError message={error} />
        <p role="status" aria-live="polite" className="m-0 text-body-sm">
          {saving
            ? `Saving settings for @${owner}…`
            : notice || (dirty ? "You have unsaved changes." : "")}
        </p>
        {saved.canManage && (
          <div className="mk-form-actions">
            <button
              type="submit"
              className="mk-btn mk-btn--primary min-h-11"
              disabled={busy || !dirty || invalidSchedule.length > 0}
            >
              {saving ? "Saving…" : "Save AI settings"}
            </button>
            <button
              type="button"
              className="mk-btn mk-btn--ghost min-h-11"
              disabled={busy || (!dirty && !invalidSchedule.length)}
              onClick={() => {
                setFeatures(saved.features);
                setModels(saved.models);
                setSchedule(scheduleText(saved));
                setLogBodies(overrides(saved));
                changed();
              }}
            >
              Discard changes
            </button>
          </div>
        )}
      </div>
    </form>
  );
}
