// Settings → AI providers (CORE-294): an account connects its own TypeSafe or
// OpenRouter key and chooses which of the provider's models automatic AI work
// may use. Choosing the model for each role stays in AI settings.

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
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
import type {
  AiModelSelection,
  AiProviderCatalogEntry,
  AiProviderCatalogView,
  AiProviderModel,
  AiProvidersView,
  AiProviderView,
} from "../../shared/ai.ts";
import { ModelPrices } from "../components/ModelPrices.tsx";
import { SettingsPage } from "../components/SettingsPage.tsx";
import { ConfirmDialog, FormError, SelectField, TextField, link } from "../components/ui.tsx";
import { api, ApiError } from "../lib/api.ts";
import { requireViewer } from "../lib/session.ts";

export async function aiProvidersLoader({ request }: LoaderFunctionArgs) {
  const viewer = await requireViewer(request);
  const url = new URL(request.url);
  const owner = url.searchParams.get("owner");
  if (!owner) throw redirect(`/settings/ai-providers?owner=${encodeURIComponent(viewer.slug)}`);
  const accounts = [...viewer.canCreateIn];
  try {
    const view = await api<AiProvidersView>(`/accounts/${encodeURIComponent(owner)}/ai-providers`, {
      signal: request.signal,
    });
    if (!accounts.some((account) => account.slug === owner)) {
      accounts.push(
        await api<AccountSummary>(`/accounts/${encodeURIComponent(owner)}`, {
          signal: request.signal,
        }),
      );
    }
    return { owner, accounts, view, error: "" };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { owner, accounts, view: null, error: error.message };
  }
}

const ROLE_NAMES = { classification: "Classification", fast: "Fast", task: "Task" } as const;

/** The roles a model is chosen for, in words, or "" when it isn't in use. */
function usedFor(selection: AiModelSelection, id: string): string {
  return (Object.keys(ROLE_NAMES) as (keyof typeof ROLE_NAMES)[])
    .filter((role) => selection[role] === id)
    .map((role) => ROLE_NAMES[role])
    .join(" and ");
}

const tokens = new Intl.NumberFormat("en-US", { notation: "compact" });
const checkedDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function AiProviders() {
  const data = useLoaderData<typeof aiProvidersLoader>();
  const [, setParams] = useSearchParams();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const switching = navigation.state !== "idle";
  return (
    <SettingsPage owner={data.owner}>
      <div className="max-w-3xl">
        <h1 className="m-0 text-headline">AI providers</h1>
        <p className="mt-1.5 mb-0 max-w-[65ch] text-ink-muted">
          Connect an account’s own API keys to make more models available to its automatic AI work.
          Calls to these models go straight to the provider and are billed to the key; AI Gateway
          doesn’t see or log them. Choose which model does each job in{" "}
          <Link to={`/settings/ai?owner=${encodeURIComponent(data.owner)}`} className={link}>
            AI settings
          </Link>
          .
        </p>
        <div className="mt-6 flex max-w-md flex-col gap-1 text-field-label">
          Account
          <SelectField
            ariaLabel="Account for AI providers"
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
          {switching ? "Loading account providers…" : `Providers for @${data.owner}`}
        </p>
        {data.view ? (
          <Providers key={data.owner} owner={data.owner} initial={data.view} />
        ) : (
          <div className="mt-6 flex flex-col items-start gap-3">
            <FormError message={data.error} />
            <button
              type="button"
              className="mk-btn mk-btn--secondary min-h-11"
              disabled={switching || revalidator.state !== "idle"}
              onClick={() => void revalidator.revalidate()}
            >
              {revalidator.state !== "idle" ? "Loading…" : "Retry loading providers"}
            </button>
          </div>
        )}
      </div>
    </SettingsPage>
  );
}

function Providers({ owner, initial }: { owner: string; initial: AiProvidersView }) {
  const [view, setView] = useState(initial);
  return (
    <div className="mt-6 flex flex-col gap-10">
      {!view.canManage && (
        <p className="m-0 text-body-sm font-semibold text-ink">
          Read-only access. Only a signed-in human account owner, organization owner, or site admin
          can connect providers, since a key spends money. Agents cannot change them.
        </p>
      )}
      {view.providers.map((provider) => (
        <ProviderSection
          key={provider.kind}
          owner={owner}
          provider={provider}
          canManage={view.canManage}
          selection={view.selection}
          onChange={setView}
        />
      ))}
    </div>
  );
}

/** Run a change against the providers API; its answer is the new view. */
function useMutation(onChange: (view: AiProvidersView) => void) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function run(
    label: string,
    path: string,
    init: RequestInit & { json?: unknown },
    done: string,
  ) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      const view = await api<AiProvidersView>(path, init);
      if (!active.current) return false;
      onChange(view);
      setNotice(done);
      return true;
    } catch (cause) {
      if (active.current)
        setError(cause instanceof Error ? cause.message : "That didn't work. Try again.");
      return false;
    } finally {
      if (active.current) setBusy("");
    }
  }
  return { busy, error, notice, run };
}

function ProviderSection({
  owner,
  provider,
  canManage,
  selection,
  onChange,
}: {
  owner: string;
  provider: AiProviderView;
  canManage: boolean;
  selection: AiModelSelection;
  onChange: (view: AiProvidersView) => void;
}) {
  const base = `/accounts/${encodeURIComponent(owner)}/ai-providers/${provider.kind}`;
  const { busy, error, notice, run } = useMutation(onChange);
  const [apiKey, setApiKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  const headingId = `provider-${provider.kind}`;
  const inUse = provider.models.filter((model) => usedFor(selection, model.id));
  const addModel = (entry: AiProviderCatalogEntry) =>
    run(
      `add:${entry.model}`,
      `${base}/models`,
      { method: "POST", json: { model: entry.model } },
      `Added ${entry.name}. Choose it for a job in AI settings.`,
    );

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4 border-t border-line pt-6">
      <div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id={headingId} className="m-0 text-title text-ink">
            {provider.name}
          </h2>
          <span className="text-body-sm text-ink-muted">
            {provider.connected
              ? `Connected · key ending ${provider.keyLastFour}${
                  provider.connectedBy ? ` · by @${provider.connectedBy}` : ""
                }`
              : "Not connected"}
          </span>
        </div>
        <p className="mt-1 mb-0 max-w-[65ch] text-body-sm text-ink-muted">{provider.description}</p>
      </div>

      {canManage && provider.connected && !replacing && (
        <div>
          <button
            type="button"
            className="mk-btn mk-btn--secondary min-h-11"
            disabled={Boolean(busy)}
            onClick={() => setReplacing(true)}
          >
            Replace key
          </button>
        </div>
      )}
      {canManage && (!provider.connected || replacing) && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy || !apiKey.trim()) return;
            const saved = await run(
              "key",
              base,
              { method: "PUT", json: { apiKey } },
              provider.connected
                ? `Replaced the ${provider.name} key. Running work uses the new key.`
                : `Connected ${provider.name}. Add the models this account may use below.`,
            );
            if (saved) {
              setApiKey("");
              setReplacing(false);
            }
          }}
        >
          <TextField
            label={provider.connected ? `New ${provider.name} API key` : `${provider.name} API key`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            autoFocus={replacing}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            className="w-full max-w-md"
            hint={
              <>
                The key is checked with {provider.name}, then stored encrypted; only its last four
                characters are shown again.{" "}
                <a href={provider.keysUrl} className={link} target="_blank" rel="noreferrer">
                  Get a {provider.name} key
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </>
            }
          />
          <button
            type="submit"
            className="mk-btn mk-btn--primary min-h-11"
            disabled={Boolean(busy) || !apiKey.trim()}
          >
            {busy === "key" ? "Checking key…" : provider.connected ? "Save new key" : "Connect"}
          </button>
          {replacing && (
            <button
              type="button"
              className="mk-btn mk-btn--ghost min-h-11"
              disabled={busy === "key"}
              onClick={() => {
                setReplacing(false);
                setApiKey("");
              }}
            >
              Keep current key
            </button>
          )}
        </form>
      )}

      <div className="flex flex-col gap-2">
        <FormError message={error} />
        <p role="status" aria-live="polite" className="m-0 text-body-sm">
          {notice}
        </p>
      </div>

      {(provider.connected || provider.models.length > 0) && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="m-0 text-field-label text-ink">Available to this account</h3>
            {canManage && provider.models.length > 0 && (
              <button
                type="button"
                className="mk-btn mk-btn--ghost min-h-11"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run(
                    "refresh",
                    `${base}/models/refresh`,
                    { method: "POST" },
                    `Prices re-read from ${provider.name}.`,
                  )
                }
              >
                {busy === "refresh" ? "Refreshing…" : "Refresh prices"}
              </button>
            )}
          </div>
          {provider.models.length === 0 ? (
            <p className="m-0 text-body-sm text-ink-muted">
              No models yet. Until one is added, nothing uses this provider.
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {provider.models.map((model) => (
                <ChosenModel
                  key={model.id}
                  model={model}
                  usedFor={usedFor(selection, model.id)}
                  canManage={canManage}
                  busy={busy === `remove:${model.model}`}
                  disabled={Boolean(busy)}
                  onRemove={() =>
                    void run(
                      `remove:${model.model}`,
                      `${base}/models?model=${encodeURIComponent(model.model)}`,
                      { method: "DELETE" },
                      `Removed ${model.name}.`,
                    )
                  }
                />
              ))}
            </ul>
          )}
        </div>
      )}

      {canManage && provider.connected && (
        <AddModels
          provider={provider}
          base={base}
          busy={busy}
          onAdd={(entry) => void addModel(entry)}
        />
      )}

      {canManage && provider.connected && (
        <div>
          <ConfirmDialog
            trigger={
              <button
                type="button"
                className="mk-btn mk-btn--ghost min-h-11"
                disabled={Boolean(busy) || inUse.length > 0}
                aria-describedby={inUse.length ? `${headingId}-in-use` : undefined}
              >
                Disconnect {provider.name}
              </button>
            }
            title={`Disconnect ${provider.name}?`}
            description={`Its key and ${provider.models.length === 1 ? "its model" : `its ${provider.models.length} models`} are removed from @${owner}. Work already running with them fails instead of continuing.`}
            confirmLabel="Disconnect"
            busy={busy === "disconnect"}
            onConfirm={() =>
              void run(
                "disconnect",
                base,
                { method: "DELETE" },
                `Disconnected ${provider.name}. Its key was deleted.`,
              )
            }
          />
          {inUse.length > 0 && (
            <p id={`${headingId}-in-use`} className="mt-1 mb-0 text-body-sm text-ink-muted">
              Choose other models in AI settings before disconnecting:{" "}
              {inUse.length === 1 ? "one" : inUse.length} of its models{" "}
              {inUse.length === 1 ? "is" : "are"} in use.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function ModelFacts({ model }: { model: AiProviderModel | AiProviderCatalogEntry }) {
  return (
    <>
      <span className="font-mono text-body-sm text-ink-faint break-all">{model.model}</span>
      <span className="text-body-sm">
        <ModelPrices option={model} />
        <span className="text-ink-muted">
          {model.variablePricing ? "" : " per million tokens"}
          {model.contextLength ? ` · ${tokens.format(model.contextLength)} context` : ""}
          {model.capability === "generation" && !model.jsonMode ? " · no JSON mode" : ""}
        </span>
      </span>
    </>
  );
}

function ChosenModel({
  model,
  usedFor,
  canManage,
  busy,
  disabled,
  onRemove,
}: {
  model: AiProviderModel;
  usedFor: string;
  canManage: boolean;
  busy: boolean;
  disabled: boolean;
  onRemove: () => void;
}) {
  const id = `chosen-${model.id}`;
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 border-t border-line pt-3">
      <div className="flex min-w-0 flex-1 basis-80 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2">
          <a href={model.url} className={`${link} font-semibold`} target="_blank" rel="noreferrer">
            {model.name}
            <span className="sr-only"> provider details (opens in a new tab)</span>
          </a>
          {usedFor && <span className="mk-chip mk-chip--tag">Used for {usedFor}</span>}
        </span>
        <ModelFacts model={model} />
        <span className="text-body-sm text-ink-faint">
          Prices checked {checkedDate.format(new Date(model.pricesCheckedAt))}
        </span>
      </div>
      {canManage && (
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <button
            type="button"
            className="mk-btn mk-btn--secondary min-h-11"
            disabled={disabled || Boolean(usedFor)}
            aria-describedby={usedFor ? `${id}-why` : undefined}
            aria-label={`Remove ${model.name}`}
            onClick={onRemove}
          >
            {busy ? "Removing…" : "Remove"}
          </button>
          {usedFor && (
            <span id={`${id}-why`} className="text-body-sm text-ink-muted">
              Choose another {usedFor} model first
            </span>
          )}
        </div>
      )}
    </li>
  );
}

type Sort = "name" | "newest" | "cheapest";
const SORTS: { value: Sort; label: string }[] = [
  { value: "name", label: "Best match" },
  { value: "newest", label: "Newest first" },
  { value: "cheapest", label: "Lowest input price" },
];
const SHOWN = 25;

/** Rank catalog entries for a query: every word must match; earlier, name matches rank higher. */
export function searchModels(
  models: readonly AiProviderCatalogEntry[],
  query: string,
  sort: Sort,
): AiProviderCatalogEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matched = models
    .map((model) => {
      const name = model.name.toLowerCase();
      const haystack = `${name} ${model.model.toLowerCase()} ${model.description.toLowerCase()}`;
      if (!words.every((word) => haystack.includes(word))) return null;
      // Lower is better: name hits, then identifier hits, then description-only.
      const score = words.reduce((total, word) => {
        if (name.startsWith(word) || model.model.toLowerCase().startsWith(word)) return total;
        if (name.includes(word)) return total + 1;
        if (model.model.toLowerCase().includes(word)) return total + 2;
        return total + 4;
      }, 0);
      return { model, score };
    })
    .filter((entry): entry is { model: AiProviderCatalogEntry; score: number } => entry !== null);
  const price = (model: AiProviderCatalogEntry) =>
    model.variablePricing ? Infinity : model.inputUsdPerMillion;
  matched.sort((a, b) => {
    if (sort === "newest" && a.model.releasedAt !== b.model.releasedAt)
      return b.model.releasedAt.localeCompare(a.model.releasedAt);
    if (sort === "cheapest" && price(a.model) !== price(b.model))
      return price(a.model) - price(b.model);
    return a.score - b.score || a.model.name.localeCompare(b.model.name);
  });
  return matched.map((entry) => entry.model);
}

function AddModels({
  provider,
  base,
  busy,
  onAdd,
}: {
  provider: AiProviderView;
  base: string;
  busy: string;
  onAdd: (entry: AiProviderCatalogEntry) => void;
}) {
  const [catalog, setCatalog] = useState<AiProviderCatalogView | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("name");
  const deferredQuery = useDeferredValue(query);
  const searchable = provider.kind === "openrouter";

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api<AiProviderCatalogView>(`${base}/catalog`, { signal: controller.signal })
      .then(setCatalog)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Couldn't load the models.");
      });
    return () => controller.abort();
  }, [base, attempt]);

  const added = useMemo(
    () => new Set(provider.models.map((model) => model.model)),
    [provider.models],
  );
  const results = useMemo(
    () => (catalog ? searchModels(catalog.models, deferredQuery, sort) : []),
    [catalog, deferredQuery, sort],
  );
  // A short list just offers what's left; search results keep showing what's added.
  const shown = searchable ? results.slice(0, SHOWN) : results.filter((m) => !added.has(m.model));
  if (catalog && !searchable && shown.length === 0) return null;
  const listId = `catalog-${provider.kind}`;

  return (
    <div className="flex flex-col gap-3">
      <h3 className="m-0 text-field-label text-ink">Add models</h3>
      {error ? (
        <div className="flex flex-col items-start gap-2">
          <FormError message={error} />
          <button
            type="button"
            className="mk-btn mk-btn--secondary min-h-11"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Retry loading models
          </button>
        </div>
      ) : !catalog ? (
        <p role="status" className="m-0 text-body-sm text-ink-muted">
          Loading {provider.name}’s models…
        </p>
      ) : (
        <>
          {searchable && (
            <div className="flex flex-wrap items-end gap-3">
              <TextField
                label={`Search ${provider.name} models`}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Name, vendor or model id"
                autoComplete="off"
                spellCheck={false}
                aria-controls={listId}
                className="min-w-0 flex-1 basis-64"
              />
              <div className="flex flex-col gap-1 text-field-label text-ink">
                Sort
                <SelectField
                  ariaLabel="Sort models"
                  value={sort}
                  options={SORTS}
                  onChange={(value) => setSort(value as Sort)}
                  className="w-52"
                />
              </div>
            </div>
          )}
          {searchable && (
            <p role="status" aria-live="polite" className="m-0 text-body-sm text-ink-muted">
              {results.length === 0
                ? `No ${provider.name} text models match “${deferredQuery.trim()}”.`
                : results.length > shown.length
                  ? `Showing ${shown.length} of ${results.length} models. Search to narrow them down.`
                  : `${results.length} ${results.length === 1 ? "model" : "models"}.`}
            </p>
          )}
          <ul id={listId} className="m-0 flex list-none flex-col gap-3 p-0">
            {shown.map((entry) => {
              const isAdded = added.has(entry.model);
              return (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-start justify-between gap-3 border-t border-line pt-3"
                >
                  <div className="flex min-w-0 flex-1 basis-80 flex-col gap-0.5">
                    <a
                      href={entry.url}
                      className={`${link} font-semibold`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {entry.name}
                      <span className="sr-only"> provider details (opens in a new tab)</span>
                    </a>
                    <ModelFacts model={entry} />
                    {entry.description && (
                      <span className="max-w-[65ch] text-body-sm text-ink-faint">
                        {entry.description}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="mk-btn mk-btn--secondary min-h-11"
                    disabled={isAdded || Boolean(busy)}
                    aria-label={isAdded ? `${entry.name} added` : `Add ${entry.name}`}
                    onClick={() => onAdd(entry)}
                  >
                    {isAdded ? "Added" : busy === `add:${entry.model}` ? "Adding…" : "Add"}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
