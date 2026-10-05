import { batch } from "../schema.ts";

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Run `work` over `items` with at most `limit` in flight, keeping order. Once
 * one fails, nothing more starts; it rejects with that failure when the work
 * in flight has settled, so a failed step leaves no model calls running
 * beside its retry (CORE-285).
 */
export async function pool<T, R>(
  items: T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  let failure: { error: unknown } | null = null;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try {
        results[index] = await work(items[index] as T, index);
      } catch (error) {
        failure ??= { error };
      }
    }
  });
  await Promise.all(runners);
  if (failure) throw (failure as { error: unknown }).error;
  return results;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** A compiled-on-demand query, as `batch` takes them. */
export type Statement = Parameters<typeof batch>[1][number];

/** Run D1 statements in batches small enough for one round trip each. */
export async function runBatched(d1: D1Database, statements: Statement[]) {
  for (const group of chunk(statements, 80)) {
    if (group.length) await batch(d1, group);
  }
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}
