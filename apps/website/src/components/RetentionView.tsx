// Data retention (CORE-210): an account's categories (its administrators) or
// the site's (site administrators), each with its switch, thresholds, what it
// never deletes and its last run; "Clean up now" (choose categories, preview
// them with a dry run, confirm, watch the run) and the run history. Shared by
// the account and site pages in src/routes/DataRetention.tsx.

import { CircleNotchIcon } from "@phosphor-icons/react";
import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import type {
  RetentionPolicy,
  RetentionRun,
  RetentionRunPage,
  RetentionSettings,
  RetentionThreshold,
} from "../../shared/retention.ts";
import { api } from "../lib/api.ts";
import { fullDate, timeAgo } from "../lib/format.ts";
import { ConfirmDialog, FormError, link } from "./ui.tsx";
import { size, usd } from "./UsageReportView.tsx";

/** Where this level's API lives. */
export interface RetentionPaths {
  settings: string;
  runs: string;
}

const UNITS: Record<RetentionThreshold["unit"], [string, string]> = {
  days: ["day", "days"],
  months: ["month", "months"],
  count: ["", ""],
  gib: ["GiB", "GiB"],
};

/** "30 days", "24 months", "20", "2 GiB". */
export function quantity(t: Pick<RetentionThreshold, "unit">, value: number): string {
  const [one, many] = UNITS[t.unit];
  const word = value === 1 ? one : many;
  return word ? `${value.toLocaleString("en-US")} ${word}` : value.toLocaleString("en-US");
}

const records = (n: number) => `${n.toLocaleString("en-US")} record${n === 1 ? "" : "s"}`;
const terminal = (run: RetentionRun) => run.status === "succeeded" || run.status === "failed";

/** A run's estimated monthly cost: billed prices only, plus whether any part starts later. */
function runCost(run: RetentionRun) {
  const costs = run.categories.flatMap((c) => (c.cost ? [c.cost] : []));
  return {
    usd: costs.reduce((sum, c) => sum + (c.startsOn ? 0 : c.monthlyUsd), 0),
    priced: costs.length > 0,
    unpriced: run.categories.filter((c) => !c.cost).map((c) => c.label),
  };
}

function Spinner() {
  return <CircleNotchIcon weight="bold" className="size-4 shrink-0 animate-spin" aria-hidden />;
}

function Switch({
  checked,
  onChange,
  label,
  disabled,
  describedBy,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      className="mk-switch disabled:cursor-not-allowed disabled:opacity-50"
      onClick={() => onChange(!checked)}
    />
  );
}

/** Polls a queued or running run every second until it finishes. */
function usePolledRun(
  run: RetentionRun | null,
  paths: RetentionPaths,
  onUpdate: (run: RetentionRun) => void,
) {
  const update = useRef(onUpdate);
  update.current = onUpdate;
  // Every update is a new object, so this re-arms after each one until the run ends.
  useEffect(() => {
    if (!run || terminal(run)) return;
    let stopped = false;
    const timer = setTimeout(async () => {
      try {
        const next = await api<RetentionRun>(`${paths.runs}/${run.id}`);
        if (!stopped) update.current(next);
      } catch {
        // The run carries on server-side: ask again on the next tick.
        if (!stopped) update.current({ ...run });
      }
    }, 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [run, paths.runs]);
}

// ---- one category -------------------------------------------------------------------

function LastRun({ policy }: { policy: RetentionPolicy }) {
  const last = policy.lastRun;
  if (!policy.runnable) return null;
  if (!last) return <span>Never run here yet.</span>;
  const what = last.dryRun ? "Preview" : "Run";
  const by = last.trigger === "schedule" ? "scheduled" : "manual";
  return (
    <span>
      Last {by} {what.toLowerCase()} #{last.runId},{" "}
      <time dateTime={last.at} title={fullDate(last.at)}>
        {timeAgo(last.at)}
      </time>
      : {last.status === "failed" ? `failed (${last.error ?? "error"})` : ""}
      {last.status === "succeeded"
        ? `${last.dryRun ? "found" : "removed"} ${records(last.items)} (${size(last.bytes)})`
        : last.status === "failed"
          ? ""
          : last.status}
      .
    </span>
  );
}

function CategoryRow({
  policy,
  level,
  canEdit,
  paths,
  onSaved,
  onCleanUp,
  overlapLabels,
}: {
  policy: RetentionPolicy;
  /** Which page shows it: an account's, the site's own categories, or site-wide defaults. */
  level: "account" | "site" | "defaults";
  canEdit: boolean;
  paths: RetentionPaths;
  onSaved: (settings: RetentionSettings) => void;
  onCleanUp: ((id: string) => void) | null;
  /** Labels of the categories this one overlaps. */
  overlapLabels: string[];
}) {
  const id = useId();
  const [enabled, setEnabled] = useState(policy.enabled);
  const [values, setValues] = useState<Record<string, string>>(() => strings(policy.values));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    setEnabled(policy.enabled);
    setValues(strings(policy.values));
  }, [policy]);
  const policyControl = policy.control === "policy";
  const invalid = policy.thresholds.filter((t) => {
    const n = Number(values[t.key]);
    return values[t.key] === "" || !Number.isInteger(n) || n < t.min || n > t.max;
  });
  const changedThresholds = policy.thresholds.filter(
    (t) => Number(values[t.key]) !== policy.values[t.key],
  );
  const dirty = (policyControl && enabled !== policy.enabled) || changedThresholds.length > 0;
  const scope =
    level === "defaults"
      ? "Default for every account"
      : policy.scope === "site"
        ? "Site-wide"
        : "This account";

  async function save(body: {
    enabled?: boolean | null;
    thresholds?: Record<string, number | null>;
  }) {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const next = await api<RetentionSettings>(paths.settings, {
        method: "PATCH",
        json: { categories: { [policy.id]: body } },
      });
      onSaved(next);
      setNotice(`${policy.label}: saved.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  const stored =
    (level === "account" && policy.enabledFrom === "account") ||
    (level !== "account" && policy.enabledFrom === "site") ||
    policy.thresholds.some(
      (t) => policy.valuesFrom[t.key] === (level === "account" ? "account" : "site"),
    );

  return (
    <li
      id={`category-${policy.id}`}
      data-retention-row={policy.id}
      className="scroll-mt-24 border-t border-line-soft first:border-t-0 target:bg-signal-wash"
    >
      <form
        className="flex flex-col gap-3 px-4 py-4"
        aria-labelledby={`${id}-title`}
        onSubmit={(event) => {
          event.preventDefault();
          if (!dirty || invalid.length || saving) return;
          void save({
            ...(policyControl && enabled !== policy.enabled ? { enabled } : {}),
            ...(changedThresholds.length
              ? {
                  thresholds: Object.fromEntries(
                    changedThresholds.map((t) => [t.key, Number(values[t.key])]),
                  ),
                }
              : {}),
          });
        }}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 id={`${id}-title`} className="m-0 text-body font-semibold break-words">
              {policy.label}
            </h3>
            <p className="mt-1 mb-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-ink-muted">
              <span className="mk-chip mk-chip--tag">{scope}</span>
              {!policyControl && <span className="mk-chip mk-chip--tag">Always on</span>}
              {policyControl && !policy.runnable && (
                <span className="mk-chip mk-chip--tag">No cleanup yet</span>
              )}
              {policyControl && level === "account" && policy.enabledFrom === "site" && (
                <span>{policy.enabled ? "On" : "Off"} by the site-wide default</span>
              )}
            </p>
          </div>
          {policyControl ? (
            <div className="flex min-h-11 shrink-0 items-center gap-2 text-body-sm">
              <span aria-hidden className="text-ink-muted">
                {enabled ? "On" : "Off"}
              </span>
              <Switch
                checked={enabled}
                disabled={!canEdit || saving}
                label={`${level === "defaults" ? "Enable by default" : "Enable"}: ${policy.label}`}
                describedBy={`${id}-description`}
                onChange={(next) => {
                  setEnabled(next);
                  setNotice("");
                }}
              />
            </div>
          ) : null}
        </div>
        <p id={`${id}-description`} className="m-0 max-w-[70ch] text-body-sm text-ink-muted">
          {policy.description}
        </p>
        {policy.thresholds.length > 0 && (
          <fieldset disabled={!canEdit || saving} className="m-0 min-w-0 border-0 p-0">
            <legend className="sr-only">{policy.label} thresholds</legend>
            <div className="flex flex-wrap gap-x-6 gap-y-3">
              {policy.thresholds.map((t) => {
                const inputId = `${id}-${t.key}`;
                const bad = invalid.includes(t);
                const from = policy.valuesFrom[t.key];
                return (
                  <div key={t.key} className="flex min-w-0 flex-col gap-1">
                    <label htmlFor={inputId} className="text-field-label">
                      {t.label}
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        id={inputId}
                        type="number"
                        inputMode="numeric"
                        min={t.min}
                        max={t.max}
                        step={1}
                        required
                        value={values[t.key] ?? ""}
                        aria-invalid={bad || undefined}
                        aria-describedby={`${inputId}-hint`}
                        onChange={(event) => {
                          setValues({ ...values, [t.key]: event.target.value });
                          setNotice("");
                        }}
                        className="mk-input w-28 tabular-nums"
                      />
                      <span className="text-body-sm text-ink-muted">{UNITS[t.unit][1]}</span>
                    </div>
                    <span id={`${inputId}-hint`} className="text-body-sm text-ink-faint">
                      {bad
                        ? `A whole number from ${t.min} to ${t.max}.`
                        : `Default ${quantity(t, t.default)}${from === "site" && level === "account" ? " · site default in use" : ""}`}
                    </span>
                  </div>
                );
              })}
            </div>
          </fieldset>
        )}
        <div className="text-body-sm">
          <p className="m-0 text-ink-muted">Never deletes:</p>
          <ul className="m-0 list-disc pl-5 text-ink-muted">
            {policy.never.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
        {overlapLabels.length > 0 && (
          <p className="m-0 text-body-sm text-ink-muted">
            Can select the same records as {overlapLabels.join(", ")}: a preview of both counts them
            under each, a cleanup removes each once.
          </p>
        )}
        <p className="m-0 text-body-sm text-ink-muted" data-last-run>
          {level !== "defaults" && <LastRun policy={policy} />}
          {!policy.runnable && policyControl && (
            <span>Its setting is kept; nothing is deleted until it has a cleanup.</span>
          )}
          {!policyControl && <span>Runs on its own, with these values.</span>}
        </p>
        <FormError message={error} />
        <p role="status" aria-live="polite" className="m-0 text-body-sm empty:hidden">
          {saving ? `Saving ${policy.label}…` : notice || (dirty ? "Unsaved changes." : "")}
        </p>
        {(canEdit || onCleanUp) && (
          <div className="flex flex-wrap gap-2">
            {canEdit && dirty && (
              <>
                <button
                  type="submit"
                  className="mk-btn mk-btn--primary min-h-11"
                  disabled={saving || invalid.length > 0}
                >
                  {saving ? <Spinner /> : null}
                  {saving ? "Saving…" : `Save ${policy.label}`}
                </button>
                <button
                  type="button"
                  className="mk-btn mk-btn--ghost min-h-11"
                  disabled={saving}
                  onClick={() => {
                    setEnabled(policy.enabled);
                    setValues(strings(policy.values));
                    setError("");
                  }}
                >
                  Discard
                </button>
              </>
            )}
            {canEdit && !dirty && stored && (
              <button
                type="button"
                className="mk-btn mk-btn--ghost min-h-11"
                disabled={saving}
                onClick={() =>
                  void save({
                    ...(policyControl ? { enabled: null } : {}),
                    thresholds: Object.fromEntries(policy.thresholds.map((t) => [t.key, null])),
                  })
                }
              >
                Reset to {level === "account" ? "defaults" : "built-in defaults"}
              </button>
            )}
            {onCleanUp && policy.runnable && (
              <button
                type="button"
                className="mk-btn mk-btn--secondary min-h-11"
                aria-label={`Clean up now: ${policy.label}`}
                onClick={() => onCleanUp(policy.id)}
              >
                Clean up now
              </button>
            )}
          </div>
        )}
      </form>
    </li>
  );
}

const strings = (values: Record<string, number>) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)]));

// ---- runs ---------------------------------------------------------------------------

/** The level's categories, to word a run's thresholds with their labels and units. */
const Definitions = createContext<RetentionPolicy[]>([]);

function thresholdsText(
  definitions: RetentionPolicy[],
  id: string,
  values: Record<string, number>,
) {
  const thresholds = definitions.find((d) => d.id === id)?.thresholds ?? [];
  return Object.entries(values)
    .map(([key, value]) => {
      const t = thresholds.find((t) => t.key === key);
      return t ? `${t.label.toLowerCase()}: ${quantity(t, value)}` : `${key}: ${value}`;
    })
    .join("; ");
}

/** "up to" when overlapping categories may have counted records twice. */
const upTo = (run: RetentionRun) => (run.notes.length && run.items > 0 ? "up to " : "");

function RunFigures({ run }: { run: RetentionRun }) {
  const definitions = useContext(Definitions);
  const cost = runCost(run);
  const overlapping = run.notes.length > 0;
  return (
    <div className="flex flex-col gap-2">
      <ul className="m-0 flex list-none flex-col p-0" data-run-categories>
        {run.categories.map((c) => (
          <li
            key={c.category}
            data-run-category={c.category}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-t border-line-soft py-2 first:border-t-0"
          >
            <span className="min-w-0 font-semibold break-words">{c.label}</span>
            <span className="text-right tabular-nums" data-items={c.items}>
              {records(c.items)}
            </span>
            <span className="min-w-0 text-body-sm text-ink-muted">
              {c.status === "running" && "Working… "}
              {c.status === "pending" && "Waiting… "}
              {c.status === "failed" && `Failed: ${c.error ?? "error"}. `}
              {thresholdsText(definitions, c.category, c.thresholds)}
            </span>
            <span className="text-right text-body-sm text-ink-muted tabular-nums">
              {size(c.bytes)}
              {c.cost && (
                <>
                  {" · "}
                  {usd(c.cost.monthlyUsd)}/mo
                  {c.cost.startsOn ? ` from ${c.cost.startsOn}` : ""}
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
      <p className="m-0 border-t border-line pt-2 font-semibold tabular-nums" data-run-total>
        {overlapping && run.dryRun && run.items > 0 ? "Up to " : ""}
        {records(run.items)} · {size(run.bytes)}
        {cost.priced && <> · about {usd(cost.usd)} a month in storage</>}
      </p>
      {run.notes.map((note) => (
        <p key={note} className="m-0 text-body-sm" data-run-note>
          {note}
        </p>
      ))}
      {cost.priced && (
        <p className="m-0 text-body-sm text-ink-muted">
          Costs are estimates: each category's bytes at its store's storage list price (D1, Durable
          Objects or R2) from the price catalog, in effect on the run's day.
          {cost.unpriced.length > 0 && ` No price for: ${cost.unpriced.join(", ")}.`}
        </p>
      )}
    </div>
  );
}

function RunHeadline({ run }: { run: RetentionRun }) {
  const what = run.dryRun ? "Preview" : "Cleanup";
  const by = run.trigger === "schedule" ? "scheduled" : run.actor ? `by @${run.actor}` : "manual";
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-semibold">
        {what} #{run.id}
      </span>
      <span className="mk-chip mk-chip--tag">{run.status}</span>
      <span className="text-body-sm text-ink-muted">
        {by} ·{" "}
        <time dateTime={run.createdAt} title={fullDate(run.createdAt)}>
          {timeAgo(run.createdAt)}
        </time>
      </span>
    </span>
  );
}

function History({
  runs,
  next,
  loadOlder,
  loading,
}: {
  runs: RetentionRun[];
  next: number | null;
  loadOlder: () => void;
  loading: boolean;
}) {
  return (
    <section aria-labelledby="retention-history" className="flex flex-col gap-3">
      <h2 id="retention-history" className="m-0 text-title">
        Run history
      </h2>
      {runs.length === 0 ? (
        <div className="mk-empty">No cleanup has run here yet.</div>
      ) : (
        <ul className="m-0 list-none overflow-hidden rounded-pane bg-pane p-0" data-run-history>
          {runs.map((run) => (
            <li
              key={run.id}
              data-run={run.id}
              className="border-t border-line-soft first:border-t-0"
            >
              <details>
                <summary className="grid min-h-11 cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5 hover:bg-raised [&::-webkit-details-marker]:hidden">
                  <RunHeadline run={run} />
                  <span className="text-right tabular-nums">
                    {records(run.items)}
                    <span className="block text-body-sm text-ink-muted">{size(run.bytes)}</span>
                  </span>
                </summary>
                <div className="px-4 pb-4">
                  <RunFigures run={run} />
                  {run.error && <p className="m-0 mt-2 text-body-sm">Error: {run.error}</p>}
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
      {next !== null && (
        <div>
          <button
            type="button"
            className="mk-btn mk-btn--secondary min-h-11"
            disabled={loading}
            onClick={loadOlder}
          >
            {loading ? "Loading…" : "Load older runs"}
          </button>
        </div>
      )}
    </section>
  );
}

// ---- clean up now -------------------------------------------------------------------

function CleanUp({
  policies,
  paths,
  selected,
  setSelected,
  onRun,
  sectionRef,
}: {
  policies: RetentionPolicy[];
  paths: RetentionPaths;
  selected: string[];
  setSelected: (ids: string[]) => void;
  onRun: (run: RetentionRun) => void;
  sectionRef: React.RefObject<HTMLElement | null>;
}) {
  const [preview, setPreview] = useState<RetentionRun | null>(null);
  const [run, setRun] = useState<RetentionRun | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const update = (setter: (r: RetentionRun) => void) => (r: RetentionRun) => {
    setter(r);
    onRun(r);
  };
  usePolledRun(preview, paths, update(setPreview));
  usePolledRun(run, paths, update(setRun));
  const busy =
    starting || (preview !== null && !terminal(preview)) || (run !== null && !terminal(run));

  async function start(dryRun: boolean) {
    setStarting(true);
    setError("");
    try {
      // The run uses exactly the categories and thresholds the preview used.
      const body = dryRun
        ? { dryRun, categories: selected }
        : {
            dryRun,
            categories: preview!.categories.map((c) => c.category),
            thresholds: Object.fromEntries(
              preview!.categories.map((c) => [c.category, c.thresholds]),
            ),
          };
      const started = await api<RetentionRun>(paths.runs, { method: "POST", json: body });
      if (dryRun) {
        setPreview(started);
        setRun(null);
      } else setRun(started);
      onRun(started);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't start. Try again.");
    } finally {
      setStarting(false);
    }
  }

  const previewDone = preview?.status === "succeeded";
  const status = starting
    ? "Starting…"
    : run && !terminal(run)
      ? `Deleting… ${records(run.items)} removed so far.`
      : run?.status === "succeeded"
        ? `Cleanup #${run.id} finished: removed ${records(run.items)} (${size(run.bytes)}).`
        : run?.status === "failed"
          ? `Cleanup #${run.id} failed: ${run.error ?? "see the history"}.`
          : preview && !terminal(preview)
            ? `Previewing… ${records(preview.items)} found so far.`
            : previewDone
              ? preview.items === 0
                ? `Preview #${preview.id} finished: nothing to delete.`
                : `Preview #${preview.id} finished: ${upTo(preview)}${records(preview.items)} would be deleted.`
              : preview?.status === "failed"
                ? `Preview #${preview.id} failed: ${preview.error ?? "see the history"}.`
                : "";

  return (
    <section
      ref={sectionRef}
      id="clean-up-now"
      aria-labelledby="clean-up-title"
      tabIndex={-1}
      className="flex scroll-mt-24 flex-col gap-4 rounded-pane bg-pane p-4 outline-none"
    >
      <div>
        <h2 id="clean-up-title" className="m-0 text-title">
          Clean up now
        </h2>
        <p className="mt-1 mb-0 max-w-[70ch] text-body-sm text-ink-muted">
          Choose categories, preview what they would delete (nothing is deleted), then confirm. A
          cleanup can include categories that are off; it uses their values below.
        </p>
      </div>
      <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0">
        <legend className="mb-2 text-field-label">Categories</legend>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="mk-btn mk-btn--ghost mk-btn--sm min-h-11"
            onClick={() => {
              setSelected(policies.map((p) => p.id));
              setPreview(null);
              setRun(null);
            }}
          >
            Select all
          </button>
          <button
            type="button"
            className="mk-btn mk-btn--ghost mk-btn--sm min-h-11"
            onClick={() => {
              setSelected([]);
              setPreview(null);
              setRun(null);
            }}
          >
            Clear
          </button>
        </div>
        <ul className="m-0 mt-2 grid list-none gap-x-6 p-0 sm:grid-cols-2">
          {policies.map((p) => (
            <li key={p.id}>
              <label className="flex min-h-11 cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  className="m-0 size-4 shrink-0 cursor-pointer accent-signal"
                  checked={selected.includes(p.id)}
                  data-cleanup-category={p.id}
                  onChange={(event) => {
                    setSelected(
                      event.target.checked
                        ? policies
                            .filter((x) => x.id === p.id || selected.includes(x.id))
                            .map((x) => x.id)
                        : selected.filter((id) => id !== p.id),
                    );
                    setPreview(null);
                    setRun(null);
                  }}
                />
                <span className="min-w-0">
                  {p.label}
                  <span className="block text-body-sm text-ink-muted">
                    {p.enabled ? "On" : "Off"} ·{" "}
                    {p.thresholds
                      .map((t) => `${t.label.toLowerCase()}: ${quantity(t, p.values[t.key]!)}`)
                      .join("; ")}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="mk-btn mk-btn--primary min-h-11"
          disabled={busy || selected.length === 0}
          onClick={() => void start(true)}
        >
          {preview && !terminal(preview) ? <Spinner /> : null}
          Preview cleanup
        </button>
        {previewDone && !run && preview.items > 0 && (
          <ConfirmDialog
            busy={busy}
            trigger={
              <button type="button" className="mk-btn mk-btn--danger min-h-11" disabled={busy}>
                Delete {upTo(preview)}
                {records(preview.items)}
              </button>
            }
            title={`Delete ${upTo(preview)}${records(preview.items)}?`}
            description={
              <>
                {preview.categories.map((c) => c.label).join(", ")}: {size(preview.bytes)} as of the
                preview. This can't be undone. The cleanup selects with the same values now, so it
                removes what the preview listed unless data changed since.
                {preview.notes.length > 0 &&
                  " Overlapping categories are counted under each in the preview; each record is removed once."}
              </>
            }
            confirmLabel="Delete"
            onConfirm={() => void start(false)}
          />
        )}
      </div>
      <FormError message={error} />
      <p
        role="status"
        aria-live="polite"
        className="m-0 text-body-sm empty:hidden"
        data-cleanup-status
      >
        {status}
      </p>
      {preview && (
        <div data-cleanup-preview={preview.id} className="flex flex-col gap-2">
          <h3 className="m-0 text-field-label">
            {terminal(preview) ? "Preview" : "Previewing"} #{preview.id}
          </h3>
          <RunFigures run={preview} />
        </div>
      )}
      {run && (
        <div data-cleanup-run={run.id} className="flex flex-col gap-2">
          <h3 className="m-0 text-field-label">
            {terminal(run) ? "Cleanup" : "Cleaning up"} #{run.id}
          </h3>
          <RunFigures run={run} />
          {terminal(run) &&
            preview &&
            run.items !== preview.items &&
            preview.notes.length === 0 && (
              <p className="m-0 text-body-sm">
                The preview listed {records(preview.items)}; data changed between the preview and
                the cleanup.
              </p>
            )}
        </div>
      )}
    </section>
  );
}

// ---- the page -----------------------------------------------------------------------

export function RetentionView({
  initial,
  initialRuns,
  paths,
  preselect,
}: {
  initial: RetentionSettings;
  initialRuns: RetentionRunPage;
  paths: RetentionPaths;
  /** A category to select in "Clean up now" (from the usage report's link). */
  preselect: string | null;
}) {
  const [settings, setSettings] = useState(initial);
  const [runs, setRuns] = useState(initialRuns.runs);
  const [next, setNext] = useState(initialRuns.next);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const cleanupRef = useRef<HTMLElement>(null);
  const site = settings.level === "site";
  const own = settings.categories.filter((p) => p.scope === settings.level);
  const defaults = site ? settings.categories.filter((p) => p.scope === "account") : [];
  const runnable = own.filter((p) => p.runnable);
  const [selected, setSelected] = useState<string[]>(() =>
    preselect && runnable.some((p) => p.id === preselect) ? [preselect] : [],
  );

  async function refresh() {
    try {
      setSettings(await api<RetentionSettings>(paths.settings));
    } catch {
      // The page keeps what it has; the next save or reload refreshes it.
    }
  }

  function track(run: RetentionRun) {
    setRuns((list) =>
      list.some((r) => r.id === run.id)
        ? list.map((r) => (r.id === run.id ? run : r))
        : [run, ...list],
    );
    if (terminal(run)) void refresh();
  }

  const cleanUp = (id: string) => {
    setSelected([id]);
    cleanupRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    cleanupRef.current?.focus({ preventScroll: true });
  };

  const canRun = settings.canEdit && runnable.length > 0;
  const rows = (list: RetentionPolicy[], level: "account" | "site" | "defaults") => (
    <ul className="m-0 list-none overflow-hidden rounded-pane bg-pane p-0">
      {list.map((p) => (
        <CategoryRow
          key={p.id}
          policy={p}
          level={level}
          canEdit={settings.canEdit}
          paths={paths}
          onSaved={setSettings}
          onCleanUp={canRun && level !== "defaults" ? cleanUp : null}
          overlapLabels={(p.overlaps ?? []).map(
            (id) => settings.categories.find((c) => c.id === id)?.label ?? id,
          )}
        />
      ))}
    </ul>
  );

  return (
    <Definitions.Provider value={settings.categories}>
      <div className="mt-6 flex flex-col gap-8" data-retention-level={settings.level}>
        {!settings.canEdit && (
          <p className="m-0 font-semibold">
            Read-only: only a signed-in person who administers {site ? "the site" : "this account"}{" "}
            can change retention or run a cleanup.
          </p>
        )}
        {canRun && (
          <CleanUp
            policies={runnable}
            paths={paths}
            selected={selected}
            setSelected={setSelected}
            onRun={track}
            sectionRef={cleanupRef}
          />
        )}
        <section aria-labelledby="retention-categories" className="flex flex-col gap-3">
          <div>
            <h2 id="retention-categories" className="m-0 text-title">
              {site ? "Site data" : "Categories"}
            </h2>
            <p className="mt-1 mb-0 max-w-[70ch] text-body-sm text-ink-muted">
              {site
                ? "Data no account owns: shared caches, the registry, sign-in state and records. Enabled categories run once a day."
                : "Every category is off until you turn it on; then it runs once a day with the values shown. Values left at their default follow the site-wide default when a site administrator sets one."}
            </p>
          </div>
          {rows(own, settings.level)}
        </section>
        {site && (
          <section aria-labelledby="retention-defaults" className="flex flex-col gap-3">
            <div>
              <h2 id="retention-defaults" className="m-0 text-title">
                Defaults for every account
              </h2>
              <p className="mt-1 mb-0 max-w-[70ch] text-body-sm text-ink-muted">
                What an account gets when its administrators haven&apos;t chosen. Turning a category
                on here turns it on for every such account.
              </p>
            </div>
            {rows(defaults, "defaults")}
          </section>
        )}
        <History
          runs={runs}
          next={next}
          loading={loadingOlder}
          loadOlder={async () => {
            if (next === null) return;
            setLoadingOlder(true);
            try {
              const page = await api<RetentionRunPage>(`${paths.runs}?before=${next}`);
              setRuns((list) => [
                ...list,
                ...page.runs.filter((r) => !list.some((x) => x.id === r.id)),
              ]);
              setNext(page.next);
            } finally {
              setLoadingOlder(false);
            }
          }}
        />
        {settings.changes.length > 0 && (
          <section aria-labelledby="retention-changes" className="flex flex-col gap-3">
            <h2 id="retention-changes" className="m-0 text-title">
              Recent changes
            </h2>
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-body-sm">
              {settings.changes.map((c) => (
                <li key={`${c.category}-${c.at}`}>
                  <span className="font-semibold">
                    {settings.categories.find((p) => p.id === c.category)?.label ?? c.category}
                  </span>{" "}
                  <span className="text-ink-muted">
                    {describeChange(c.before, c.after)} · {c.actor ? `@${c.actor}` : "someone"} ·{" "}
                    <time dateTime={c.at} title={fullDate(c.at)}>
                      {timeAgo(c.at)}
                    </time>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <p className="m-0 text-body-sm text-ink-muted">
          The usage report shows what each category&apos;s data costs:{" "}
          <a
            href={
              site
                ? "/settings/site-usage"
                : `/settings/usage?owner=${encodeURIComponent(settings.account ?? "")}`
            }
            className={link}
          >
            {site ? "Site usage & costs" : "Usage & costs"}
          </a>
          .
        </p>
      </div>
    </Definitions.Provider>
  );
}

function describeChange(
  before: { enabled?: boolean; thresholds?: Record<string, number> },
  after: { enabled?: boolean; thresholds?: Record<string, number> },
): string {
  const parts: string[] = [];
  if (before.enabled !== after.enabled)
    parts.push(
      after.enabled === undefined ? "switch reset" : after.enabled ? "turned on" : "turned off",
    );
  const keys = new Set([
    ...Object.keys(before.thresholds ?? {}),
    ...Object.keys(after.thresholds ?? {}),
  ]);
  for (const key of keys) {
    const a = before.thresholds?.[key];
    const b = after.thresholds?.[key];
    if (a !== b) parts.push(`${key} ${a ?? "default"} → ${b ?? "default"}`);
  }
  return parts.join(", ") || "saved";
}
