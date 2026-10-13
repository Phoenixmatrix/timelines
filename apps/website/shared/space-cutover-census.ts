// The operator's export of the provider's own Workflow instance lists for the
// Space cutover's census (tools/space-cutover.ts, worker/space-cutover/quiescence.ts).
// The API's numbered pages are deprecated and not stable (consecutive pages
// overlap), and `cf` prints only the result array, never its cursor. So the
// census lists creation windows instead: the provider takes `start` inclusive
// and `end` exclusive, at whole seconds; a window under one page is whole by
// construction, and a full one is split in two and each half listed.

export interface ListedInstance {
  id: string;
  status: string;
  createdOn: string | null;
}

export const CENSUS_PER_PAGE = 100;
const MAX_LISTINGS = 20_000;
const TERMINAL = ["complete", "errored", "terminated"];
const SECOND = 1000;

/** A creation window, in whole seconds, as the provider's list takes it. */
export interface CensusWindow {
  start: string;
  end: string;
  perPage: number;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Every instance of one Workflow, of every status, created in [from, to).
 * `list` runs one cf listing of one window.
 */
export function listWorkflowInstances(
  workflow: string,
  list: (window: CensusWindow) => string,
  range: { from: number; to: number },
): ListedInstance[] {
  const rows = new Map<string, ListedInstance>();
  let listings = 0;
  const windows = [
    [Math.floor(range.from / SECOND) * SECOND, Math.ceil(range.to / SECOND) * SECOND] as const,
  ];
  while (windows.length) {
    const [from, to] = windows.pop()!;
    if (++listings > MAX_LISTINGS)
      throw new Error(`Too many ${workflow} listings; refusing a partial census`);
    const parsed = JSON.parse(
      list({ start: iso(from), end: iso(to), perPage: CENSUS_PER_PAGE }),
    ) as Record<string, unknown>[] | { result?: Record<string, unknown>[] };
    const items = Array.isArray(parsed) ? parsed : parsed?.result;
    if (!Array.isArray(items))
      throw new Error(`Unrecognized ${workflow} instance list; refusing a partial census`);
    if (items.length > CENSUS_PER_PAGE)
      throw new Error(`A ${workflow} page exceeded its size; refusing a partial census`);
    if (items.length === CENSUS_PER_PAGE) {
      // A full window may hold more: list each half instead.
      if (to - from <= SECOND)
        throw new Error(`A one-second ${workflow} window is full; refusing a partial census`);
      const mid = from + Math.floor((to - from) / 2 / SECOND) * SECOND;
      windows.push([from, mid], [mid, to]);
      continue;
    }
    for (const row of items) {
      if (typeof row.id !== "string" || typeof row.status !== "string")
        throw new Error(`Malformed ${workflow} instance; refusing a partial census`);
      const created = typeof row.created_on === "string" ? row.created_on : null;
      // Windows partition creation time: an instance outside its window, or in two, means the
      // provider filtered differently than assumed.
      const at = created === null ? Number.NaN : Date.parse(created);
      if (Number.isNaN(at) || at < from || at >= to || rows.has(row.id))
        throw new Error(`The ${workflow} windows overlap or leak; refusing a partial census`);
      rows.set(row.id, { id: row.id, status: row.status, createdOn: created });
    }
  }
  return [...rows.values()];
}

/**
 * Two listings of one Workflow, taken one after the other, agree: nothing new
 * appeared (no instance can start under the fence), and nothing still running
 * in the first vanished (only retention drops instances, and only finished ones).
 */
export function confirmListing(
  workflow: string,
  first: ListedInstance[],
  second: ListedInstance[],
): void {
  const before = new Set(first.map((row) => row.id));
  const after = new Set(second.map((row) => row.id));
  if (
    second.some((row) => !before.has(row.id)) ||
    first.some((row) => !TERMINAL.includes(row.status) && !after.has(row.id))
  )
    throw new Error(`The ${workflow} list changed between listings; run the census again`);
}
