import { db } from "../schema.ts";

type RepositoryRecord = { repos: { id: string; owner: string; name: string }[] };

/** Project live links by stable ID without changing the tracker's frozen records. */
export async function currentRepositoryNames<T extends RepositoryRecord>(
  d1: D1Database,
  ownerId: string,
  records: T[],
): Promise<T[]> {
  const ids = [...new Set(records.flatMap((record) => record.repos.map((repo) => repo.id)))];
  const names = new Map<string, { owner: string; name: string }>();
  // Leave room for the owner binding under D1's SQL variable limit.
  for (let offset = 0; offset < ids.length; offset += 90) {
    const rows = await db(d1)
      .selectFrom("repos as r")
      .innerJoin("accounts as a", "a.id", "r.owner_id")
      .select(["r.id", "r.name", "a.slug as owner"])
      .where("r.id", "in", ids.slice(offset, offset + 90))
      .where("r.owner_id", "=", ownerId)
      .where("r.deleted_at", "is", null)
      .execute();
    for (const row of rows) names.set(row.id, row);
  }
  return records.map((record) => ({
    ...record,
    repos: record.repos.map((repo) => {
      const current = names.get(repo.id);
      return current ? { ...repo, owner: current.owner, name: current.name } : repo;
    }),
  }));
}
