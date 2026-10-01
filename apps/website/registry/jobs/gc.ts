import { sql } from "kysely";

import type { Services } from "../core/context.ts";

/** Blobs nothing references for this long are deleted (covers in-flight publishes). */
export const GC_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes blobs no file, manifest, OCI link, release asset or remote cache
 * entry references. Runs from the hourly cron via the queue.
 */
export async function collectGarbage(
  services: Services,
  now = Date.now(),
): Promise<{ blobs: number }> {
  const cutoff = new Date(now - GC_GRACE_MS).toISOString();
  const unreferenced = (
    table: "files" | "oci_manifests" | "oci_blob_links" | "release_assets" | "remote_entries",
  ) => sql<boolean>`not exists (select 1 from ${sql.table(table)} t where t.digest = b.digest)`;
  const orphans = await services.db
    .selectFrom("blobs as b")
    .select(["b.digest", "b.r2_key"])
    .where("b.created_at", "<", cutoff)
    .where(unreferenced("files"))
    .where(unreferenced("oci_manifests"))
    .where(unreferenced("oci_blob_links"))
    .where(unreferenced("release_assets"))
    .where(unreferenced("remote_entries"))
    .limit(500)
    .execute();
  for (const orphan of orphans) {
    await services.db.deleteFrom("blobs").where("digest", "=", orphan.digest).execute();
    await services.bucket.delete(orphan.r2_key);
  }
  return { blobs: orphans.length };
}
