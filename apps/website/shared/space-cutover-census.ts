// The operator's export of the provider's own Workflow instance lists for the
// Space cutover's census (tools/space-cutover.ts, worker/space-cutover/quiescence.ts).
// `cf` prints an API call's result: an array of instances, or the result with
// its `result_info` when the CLI keeps it. Either way a census must be whole:
// any page it can't prove followed the last refuses the census instead.

export interface ListedInstance {
  id: string;
  status: string;
  createdOn: string | null;
}

export const CENSUS_PER_PAGE = 100;
const MAX_PAGES = 5_000;
const TERMINAL = ["complete", "errored", "terminated"];

/** Every instance of one Workflow, of every status. `list` runs one cf listing. */
export function listWorkflowInstances(
  workflow: string,
  list: (page: { cursor: string | null; page: number; perPage: number }) => string,
): ListedInstance[] {
  const rows: ListedInstance[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) throw new Error(`Too many ${workflow} pages; refusing a partial census`);
    const parsed = JSON.parse(list({ cursor, page, perPage: CENSUS_PER_PAGE })) as
      | Record<string, unknown>[]
      | { result?: Record<string, unknown>[]; result_info?: { cursor?: string | null } };
    const items = Array.isArray(parsed) ? parsed : parsed.result;
    if (!Array.isArray(items))
      throw new Error(`Unrecognized ${workflow} instance list; refusing a partial census`);
    if (items.length > CENSUS_PER_PAGE)
      throw new Error(`A ${workflow} page exceeded its size; refusing a partial census`);
    for (const row of items) {
      if (typeof row.id !== "string" || typeof row.status !== "string")
        throw new Error(`Malformed ${workflow} instance; refusing a partial census`);
      // A page that repeats instances means pagination did not advance.
      if (seen.has(row.id))
        throw new Error(`The ${workflow} list repeated an instance; refusing a partial census`);
      seen.add(row.id);
      rows.push({
        id: row.id,
        status: row.status,
        createdOn: typeof row.created_on === "string" ? row.created_on : null,
      });
    }
    if (items.length < CENSUS_PER_PAGE) return rows;
    // A full page always has a continuation: a cursor when the result names
    // one, else the next numbered page. A result envelope without a cursor
    // leaves the rest unknown.
    const next = Array.isArray(parsed) ? null : (parsed.result_info?.cursor ?? null);
    if (!Array.isArray(parsed) && !next)
      throw new Error(`A full ${workflow} page has no continuation; refusing a partial census`);
    cursor = next;
  }
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
