// The usage and cost report (CORE-209), shared by an account's "Usage & costs"
// page and the site's: the monthly estimate, a 30-day trend, every construct
// with its lines, and a drill-down per line (figures and how they were
// measured, the catalog price used, the retention category that cleans it up).

import type {
  UsageCategoryLink,
  UsageCost,
  UsageFigure,
  UsageLine,
  UsageReport,
} from "../../shared/usage.ts";
import { link } from "./ui.tsx";
import { retentionLink } from "../lib/retention-links.ts";

const usd = (value: number) => {
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
  owner,
}: {
  categories: UsageCategoryLink[];
  owner: string | null;
}) {
  if (!categories.length) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="m-0 text-ink-muted">Retention categories that clean this up:</p>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {categories.map((c) => {
          const to = retentionLink(c, owner);
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
              {c.scope === "site" && <span className="text-ink-muted"> (site-wide)</span>}
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

function Line({ line, owner }: { line: UsageLine; owner: string | null }) {
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
          <CategoryLinks categories={line.categories} owner={owner} />
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

export function UsageReportView({
  report,
  csvHref,
  owner,
}: {
  report: UsageReport;
  csvHref: string;
  /** The account the page is for; null on the site page. */
  owner: string | null;
}) {
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
        <a href={csvHref} download className="mk-btn mk-btn--secondary min-h-11 no-underline">
          Download CSV
        </a>
      </section>

      <Trend report={report} />

      {report.accounts && (
        <section aria-labelledby="usage-accounts">
          <h2 id="usage-accounts" className="m-0 mb-3 text-title">
            By account
          </h2>
          {report.accounts.length === 0 ? (
            <div className="mk-empty">No account usage collected yet.</div>
          ) : (
            <ul className="m-0 list-none overflow-hidden rounded-pane bg-pane p-0">
              {report.accounts.map((a) => (
                <li
                  key={a.slug}
                  className="flex min-h-11 flex-wrap items-center gap-x-3 border-t border-line-soft px-4 py-2 first:border-t-0"
                >
                  <a
                    href={`/settings/usage?owner=${encodeURIComponent(a.slug)}`}
                    className={`${link} min-w-0 flex-1 break-words`}
                  >
                    {a.displayName} <span className="text-ink-muted">@{a.slug}</span>
                  </a>
                  <span className="font-semibold tabular-nums">{usd(a.monthlyUsd)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

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
              <Line key={`${l.item}-${l.kind}`} line={l} owner={owner} />
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
