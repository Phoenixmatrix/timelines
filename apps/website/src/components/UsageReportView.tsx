// Usage reports preserve independent Space, person, and Instance scope.

import { useState } from "react";
import { CONTENT_CONTRACT_HEADER, CONTENT_CONTRACT_VERSION } from "../../shared/spaces.ts";
import type {
  AttributedSpend,
  KnowledgeUpdateSpend,
  UsageAttribution,
  UsageCategoryLink,
  UsageCost,
  UsageFigure,
  UsageLine,
  UsageReport,
} from "../../shared/usage.ts";
import { FormError, link } from "./ui.tsx";
import { retentionLink } from "../lib/retention-links.ts";

export const usd = (value: number) => {
  if (value === 0) return "$0.00";
  if (Math.abs(value) < 0.01) return "<$0.01";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
};

/** A unit price as published: "$0.75 per GB-month", "$0.15 per 1M tokens". */
const unitPrice = (c: Pick<UsageCost, "unitPriceUsd" | "unitQuantity" | "unit">) => {
  const quantity = c.unitQuantity === 1 ? "" : `${compact(c.unitQuantity)} `;
  return `$${c.unitPriceUsd} per ${quantity}${c.unit}${c.unitQuantity === 1 ? "" : "s"}`;
};

const compactFormat = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const compact = (n: number) => compactFormat.format(n);

/** Storage in decimal units, as Cloudflare bills it. */
export function size(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return unit === 0
    ? `${Math.round(value)} bytes`
    : `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}

const METRIC_WORDS: Record<string, string> = {
  rows: "rows",
  instances: "instances",
  objects: "objects",
  repositories: "repositories",
  vectors: "vectors",
  dimensions: "stored dimensions",
  items: "items",
  calls: "calls",
  input_tokens: "input tokens",
  output_tokens: "output tokens",
  total_tokens: "tokens (total only)",
  jobs: "jobs",
  minutes: "minutes",
  vcpu_seconds: "vCPU-seconds",
  memory_gib_seconds: "GiB-seconds of memory",
  disk_gb_seconds: "GB-seconds of disk",
};

export function figure(f: UsageFigure): string {
  if (f.metric === "bytes") return size(f.quantity);
  const n = f.metric === "minutes" ? Math.round(f.quantity) : f.quantity;
  const words = METRIC_WORDS[f.metric] ?? f.metric.replace(/_/g, " ");
  return `${compact(n)} ${n === 1 ? words.replace(/s(?=$| \()/, "") : words}`;
}

/** A billable quantity, readable at any size: 2.5, 0.0000029, 200,000,000. */
export function amount(n: number): string {
  if (n === 0 || Math.abs(n) >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return n.toLocaleString("en-US", { maximumSignificantDigits: 3 });
}

const dayFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
export const day = (iso: string) => dayFormat.format(new Date(`${iso}T00:00:00Z`));

function Estimated() {
  return (
    <span className="mk-chip mk-chip--tag" title="Estimated, not measured exactly">
      Estimated
    </span>
  );
}

function CategoryLinks({
  categories,
  report,
}: {
  categories: UsageCategoryLink[];
  report: Pick<UsageReport, "scope" | "subject">;
}) {
  if (!categories.length) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="m-0 text-ink-muted">Retention categories that clean this up:</p>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {categories.map((c) => {
          const to = retentionLink(c, report);
          return (
            <li key={c.id} data-retention-category={c.id}>
              {to ? (
                <a href={to} className={`${link} font-semibold`}>
                  {c.label}
                  <span className="sr-only"> (data retention and clean up now)</span>
                </a>
              ) : (
                <span className="font-semibold">{c.label}</span>
              )}
              {c.scope === "instance" && <span className="text-ink-muted"> (Instance-wide)</span>}
              <span className="text-ink-muted"> · {c.description}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CostDetail({ cost }: { cost: UsageCost }) {
  const allowance =
    cost.includedQuantity === null
      ? null
      : cost.includedQuantity === 0
        ? "No included allowance."
        : `Cloudflare includes ${compact(cost.includedQuantity)} ${cost.unit}${cost.includedQuantity === 1 ? "" : "s"} per ${cost.includedPeriod ?? "month"} for the whole Cloudflare account, not subtracted here.`;
  return (
    <li className="flex flex-col gap-0.5">
      <span>
        <span className="font-semibold">{cost.label}</span>: {amount(cost.quantity)} {cost.unit}
        {cost.quantity === 1 ? "" : "s"} × {unitPrice(cost)} ={" "}
        <span className="font-semibold">{usd(cost.monthlyUsd)}</span> a month
        {cost.startsOn && (
          <span className="text-ink-muted"> (billed from {day(cost.startsOn)})</span>
        )}
        {cost.estimated && (
          <>
            {" "}
            <Estimated />
          </>
        )}
      </span>
      <span className="text-ink-muted">
        {allowance} Price in effect from {day(cost.effectiveFrom)},{" "}
        <a href={cost.sourceUrl} className={link} target="_blank" rel="noreferrer">
          Cloudflare's pricing
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        .
      </span>
    </li>
  );
}

function Line({
  line,
  report,
}: {
  line: UsageLine;
  report: Pick<UsageReport, "scope" | "subject">;
}) {
  const headline = line.figures.find((f) => f.metric === "bytes") ?? line.figures[0];
  // Every price for the line starts later (Artifacts, AI Search): show what it will cost, and when.
  const pending =
    line.costs.length > 0 && line.costs.every((c) => c.startsOn)
      ? line.costs.map((c) => c.startsOn!).toSorted()[0]!
      : null;
  const pendingUsd = line.costs.reduce((sum, c) => sum + c.monthlyUsd, 0);
  return (
    <li className="border-t border-line-soft first:border-t-0">
      <details className="group" data-usage-line={`${line.construct}/${line.item}`}>
        <summary className="grid min-h-11 cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2.5 hover:bg-raised [&::-webkit-details-marker]:hidden">
          <span className="min-w-0 font-semibold break-words">{line.label}</span>
          <span className="row-span-2 text-right tabular-nums">
            <span className="block font-semibold">
              {line.costs.length ? usd(pending ? pendingUsd : line.monthlyUsd) : "—"}
            </span>
            {pending && (
              <span className="block text-body-sm text-ink-muted">from {day(pending)}</span>
            )}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-ink-muted">
            {headline ? figure(headline) : ""}
            {line.kind === "activity" ? " in 30 days" : ""}
            {line.estimated && <Estimated />}
          </span>
        </summary>
        <div className="flex flex-col gap-3 px-4 pt-1 pb-4 text-body-sm">
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {line.figures.map((f) => (
              <li key={f.metric}>
                <span className="font-semibold">{figure(f)}</span>
                {f.estimated && (
                  <>
                    {" "}
                    <Estimated />
                  </>
                )}
                <span className="text-ink-muted"> · {f.method}</span>
              </li>
            ))}
          </ul>
          {line.costs.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {line.costs.map((c) => (
                <CostDetail key={`${c.figure}-${c.metric}`} cost={c} />
              ))}
            </ul>
          )}
          {line.note && <p className="m-0 text-ink-muted">{line.note}</p>}
          <CategoryLinks categories={line.categories} report={report} />
        </div>
      </details>
    </li>
  );
}

function Trend({ report }: { report: UsageReport }) {
  const max = Math.max(...report.trend.map((d) => d.costUsd), 0);
  const total = report.trend.reduce((sum, d) => sum + d.costUsd, 0);
  return (
    <figure className="m-0">
      <figcaption className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-title">Daily cost, last 30 days</span>
        <span className="text-body-sm text-ink-muted">{usd(total)} over the period</span>
      </figcaption>
      <div
        className="flex h-28 items-end gap-[2px] rounded-pane bg-sunken p-2"
        role="img"
        aria-label={`Daily estimated cost from ${day(report.trend[0]?.day ?? "")} to ${day(report.trend.at(-1)?.day ?? "")}: ${usd(total)} in total, at most ${usd(max)} on one day.`}
      >
        {report.trend.map((d) => (
          <div
            key={d.day}
            title={`${day(d.day)}: ${d.measured ? usd(d.costUsd) : "not measured"}`}
            className={`min-w-0 flex-1 rounded-t-[2px] ${d.measured ? "bg-data-violet" : "bg-line-soft"}`}
            style={{
              height: `${max > 0 && d.measured ? Math.max(4, (d.costUsd / max) * 100) : 4}%`,
            }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-body-sm text-ink-faint" aria-hidden>
        <span>{report.trend[0] ? day(report.trend[0].day) : ""}</span>
        <span>{report.trend.at(-1) ? day(report.trend.at(-1)!.day) : ""}</span>
      </div>
    </figure>
  );
}

/** What Knowledge builds cost per update, beside full rebuilds (CORE-286). */
function KnowledgeUpdates({ spend }: { spend: KnowledgeUpdateSpend }) {
  const total = spend.updates.count + spend.fullRebuilds.count + spend.unmetered;
  if (total === 0) return null;
  // Cents hide what one small update costs.
  const each = (value: number | null) =>
    value === null
      ? "not metered"
      : `${value > 0 && value < 0.01 ? `$${value.toFixed(4)}` : usd(value)} each`;
  return (
    <section aria-labelledby="usage-knowledge" data-usage-knowledge>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="usage-knowledge" className="m-0 text-title">
          Knowledge updates
        </h2>
        <span className="text-body-sm text-ink-muted">
          Since {day(spend.from)}, model calls at list price
        </span>
      </div>
      <ul className="m-0 list-none overflow-hidden rounded-pane bg-pane p-0">
        {(
          [
            ["Updates after pushes", spend.updates],
            ["Full rebuilds", spend.fullRebuilds],
          ] as const
        ).map(([label, s]) => (
          <li
            key={label}
            className="flex min-h-11 flex-wrap items-center gap-x-3 border-t border-line-soft px-4 py-2 first:border-t-0"
          >
            <span className="min-w-0 flex-1">
              {label}{" "}
              <span className="text-ink-muted">
                {s.count} · {s.calls.toLocaleString()} model calls · {each(s.eachUsd)}
              </span>
            </span>
            <span className="font-semibold tabular-nums">{usd(s.costUsd)}</span>
          </li>
        ))}
        {spend.repos.map((r) => (
          <li
            key={r.name}
            className="flex min-h-11 flex-wrap items-center gap-x-3 border-t border-line-soft px-4 py-2 pl-8"
          >
            <span className="min-w-0 flex-1 break-words">
              {r.name}{" "}
              <span className="text-ink-muted">
                {r.updates} updates, {r.fullRebuilds} full rebuilds
              </span>
            </span>
            <span className="tabular-nums">{usd(r.costUsd)}</span>
          </li>
        ))}
      </ul>
      {spend.unmetered > 0 && (
        <p className="mt-2 mb-0 text-body-sm text-ink-muted">
          {spend.unmetered} earlier {spend.unmetered === 1 ? "build" : "builds"} ran before builds
          metered their own calls and {spend.unmetered === 1 ? "is" : "are"} not priced here.
        </p>
      )}
    </section>
  );
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

function Spender({ spend, ciOnly }: { spend: AttributedSpend; ciOnly?: boolean }) {
  const what = [
    spend.ciJobs > 0 &&
      `${plural(spend.ciJobs, "CI job")} (${spend.ciMinutes.toLocaleString()} min)`,
    spend.aiCalls > 0 && plural(spend.aiCalls, "AI call"),
  ].filter(Boolean);
  return (
    <li className="flex min-h-11 flex-wrap items-center gap-x-3 border-t border-line-soft px-4 py-2 first:border-t-0">
      <span className="min-w-0 flex-1 break-words">
        <span>{spend.name}</span>
        {spend.accountable && (
          <>
            {" "}
            <span className="text-ink-muted">for {spend.accountable.name}</span>
          </>
        )}
        {what.length > 0 && (
          <span className="block text-body-sm text-ink-muted">{what.join(" · ")}</span>
        )}
      </span>
      <span className="text-right tabular-nums">
        <span className="block font-semibold">{usd(spend.totalUsd)}</span>
        {!(ciOnly && spend.aiUsd === 0) && (
          <span className="block text-body-sm text-ink-muted">
            CI {usd(spend.ciUsd)} · AI {usd(spend.aiUsd)}
          </span>
        )}
      </span>
    </li>
  );
}

function Spenders({
  id,
  title,
  list,
  empty,
  ciOnly,
  children,
}: {
  id: string;
  title: string;
  list: AttributedSpend[];
  empty: string;
  /** Only CI is attributed to these so far. */
  ciOnly?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div aria-labelledby={id} role="group">
      <h3 id={id} className="m-0 mb-2 text-body font-semibold">
        {title}
      </h3>
      {children}
      {list.length === 0 ? (
        <div className="mk-empty">{empty}</div>
      ) : (
        <ul className="m-0 list-none overflow-hidden rounded-pane bg-pane p-0">
          {list.map((spend) => (
            <Spender key={spend.id} spend={spend} ciOnly={ciOnly} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Attribution({
  attribution: a,
  daysMeasured,
  whole,
}: {
  attribution: UsageAttribution;
  /** Days the report's own activity figures measured (it extrapolates fewer to 30). */
  daysMeasured: number;
  /** What the report covers as a whole: the Space, the person or the Instance. */
  whole: string;
}) {
  const share = a.activityUsd > 0 ? Math.round((a.attributedUsd / a.activityUsd) * 100) : null;
  return (
    <section
      aria-labelledby="usage-attribution"
      data-usage-attribution
      className="flex flex-col gap-5"
    >
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="usage-attribution" className="m-0 text-title">
            By person, agent and timeline
          </h2>
          <span className="text-body-sm text-ink-muted">
            CI and AI, {day(a.from)} – {day(a.to)}
          </span>
        </div>
        <p className="m-0 text-body-sm" data-usage-attributed>
          {share === null
            ? "No CI or AI activity in this window."
            : `People and agents account for ${usd(a.attributedUsd)} of the ${usd(a.activityUsd)} spent on CI and AI in this window (${share}%). The rest, and storage, belong to ${whole} as a whole: see Not attributed.`}
        </p>
        {daysMeasured < 30 && (
          <p className="m-0 text-body-sm text-ink-muted" data-usage-attribution-recorded>
            The rest of this page extrapolates {daysMeasured} measured{" "}
            {daysMeasured === 1 ? "day" : "days"} to 30; these are the costs actually recorded, so
            they can be lower.
          </p>
        )}
      </div>
      <Spenders
        id="usage-people"
        title="People"
        list={a.people}
        empty="No CI or AI was started by a person in this window."
      />
      <Spenders
        id="usage-agents"
        title="Agents"
        list={a.agents}
        empty="No CI or AI was started by an agent in this window."
      >
        <p className="m-0 mb-2 text-body-sm text-ink-muted">
          What an agent does counts here, not under the person it works for.
        </p>
      </Spenders>
      <Spenders
        id="usage-timelines"
        title="Timelines"
        list={a.timelines}
        empty="No CI ran for a timeline in this window."
        ciOnly
      >
        <p className="m-0 mb-2 text-body-sm text-ink-muted">
          CI that ran for each timeline: its pushes, previews and landing. The same costs also count
          under whoever started each run. AI isn't tied to timelines yet.
        </p>
      </Spenders>
      <div aria-labelledby="usage-unattributed" role="group">
        <h3 id="usage-unattributed" className="m-0 mb-2 text-body font-semibold">
          Not attributed
        </h3>
        <ul className="m-0 list-none overflow-hidden rounded-pane bg-pane p-0">
          {a.unattributed.map((u) => (
            <li
              key={u.id}
              className="flex min-h-11 flex-wrap items-center gap-x-3 border-t border-line-soft px-4 py-2 first:border-t-0"
            >
              <span className="min-w-0 flex-1 break-words">
                <span>{u.label}</span>
                <span className="block text-body-sm text-ink-muted">{u.reason}</span>
              </span>
              <span className="font-semibold tabular-nums">
                {u.id === "storage" ? `${usd(u.costUsd)} a month` : usd(u.costUsd)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function UsageReportView({ report, csvHref }: { report: UsageReport; csvHref: string }) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  if (!report.asOf)
    return (
      <div className="mt-6 flex flex-col gap-3">
        <div className="mk-empty">No usage collected yet.</div>
        <ul className="m-0 pl-5 text-body-sm text-ink-muted">
          {report.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className="mt-6 flex flex-col gap-8" data-usage-report={report.scope}>
      <section aria-labelledby="usage-total" className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <h2 id="usage-total" className="m-0 text-field-label text-ink-muted">
            Estimated monthly cost at list price
          </h2>
          <p className="m-0 text-display tabular-nums" data-usage-total>
            {usd(report.monthlyUsd)}
          </p>
        </div>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-body-sm">
          <dt className="text-ink-muted">Storage as of</dt>
          <dd className="m-0">{day(report.asOf)}</dd>
          <dt className="text-ink-muted">Activity</dt>
          <dd className="m-0">
            {day(report.window.from)} – {day(report.window.to)} ({report.window.daysMeasured} of 30
            days measured)
          </dd>
          <dt className="text-ink-muted">Prices</dt>
          <dd className="m-0">Catalog version {report.catalog.version}</dd>
        </dl>
        <button
          type="button"
          className="mk-btn mk-btn--secondary min-h-11"
          disabled={downloading}
          onClick={async () => {
            setDownloading(true);
            setDownloadError("");
            try {
              const response = await fetch(csvHref, {
                credentials: "same-origin",
                headers: { [CONTENT_CONTRACT_HEADER]: String(CONTENT_CONTRACT_VERSION) },
              });
              if (!response.ok) throw new Error(`Couldn't download usage (${response.status}).`);
              const url = URL.createObjectURL(await response.blob());
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = `usage-${report.scope}-${report.subject?.slug ?? "instance"}.csv`;
              document.body.append(anchor);
              anchor.click();
              anchor.remove();
              setTimeout(() => URL.revokeObjectURL(url), 0);
            } catch (error) {
              setDownloadError(error instanceof Error ? error.message : "Couldn't download usage.");
            } finally {
              setDownloading(false);
            }
          }}
        >
          {downloading ? "Downloading…" : "Download CSV"}
        </button>
        <FormError message={downloadError} />
      </section>

      <Trend report={report} />

      {report.scope === "instance" && report.subjects && (
        <section aria-labelledby="usage-subjects">
          <h2 id="usage-subjects" className="m-0 mb-3 text-title">
            By Space and person
          </h2>
          {report.subjects.length === 0 ? (
            <div className="mk-empty">No Space or personal usage collected yet.</div>
          ) : (
            <ul className="m-0 list-none overflow-hidden rounded-pane bg-pane p-0">
              {report.subjects.map((subject) => (
                <li
                  key={`${subject.scope}:${subject.id}`}
                  className="flex min-h-11 flex-wrap items-center gap-x-3 border-t border-line-soft px-4 py-2 first:border-t-0"
                >
                  <a
                    href={`/settings/usage?${subject.scope}=${encodeURIComponent(subject.slug)}`}
                    className={`${link} min-w-0 flex-1 break-words`}
                  >
                    {subject.displayName}{" "}
                    <span className="text-ink-muted">
                      @{subject.slug} · {subject.scope === "space" ? "Space" : "Person"}
                    </span>
                  </a>
                  <span className="font-semibold tabular-nums">{usd(subject.monthlyUsd)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {report.attribution && (
        <Attribution
          attribution={report.attribution}
          daysMeasured={report.window.daysMeasured}
          whole={
            report.scope === "space"
              ? "the Space"
              : report.scope === "person"
                ? "the person"
                : "the Instance"
          }
        />
      )}

      {report.knowledgeUpdates && <KnowledgeUpdates spend={report.knowledgeUpdates} />}

      {report.constructs.map((c) => (
        <section key={c.construct} aria-labelledby={`usage-${c.construct}`}>
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 id={`usage-${c.construct}`} className="m-0 text-title">
              {c.label}
            </h2>
            <span className="font-semibold tabular-nums">{usd(c.monthlyUsd)} a month</span>
          </div>
          <ul className="m-0 list-none overflow-hidden rounded-pane bg-pane p-0">
            {c.lines.map((l) => (
              <Line key={`${l.item}-${l.kind}`} line={l} report={report} />
            ))}
          </ul>
        </section>
      ))}

      <section aria-labelledby="usage-notes" className="flex flex-col gap-3 text-body-sm">
        <h2 id="usage-notes" className="m-0 text-title">
          How these figures are made
        </h2>
        <ul className="m-0 flex flex-col gap-1 pl-5 text-ink-muted">
          {report.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
          <li>
            Storage is priced as if it stayed the same size for a month; activity is the last 30
            days. A GB is 10^9 bytes, as Cloudflare bills it.
          </li>
        </ul>
        <p className="m-0 text-ink-muted">
          Prices from Cloudflare's published pages:{" "}
          {report.catalog.sources.map((s, i) => (
            <span key={s.product}>
              {i > 0 && ", "}
              <a href={s.url} className={link} target="_blank" rel="noreferrer">
                {s.label}
              </a>
              {s.sourceUpdated && ` (updated ${day(s.sourceUpdated)})`}
            </span>
          ))}
          .
        </p>
      </section>
    </div>
  );
}
