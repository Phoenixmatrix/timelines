import { sql } from "kysely";

import type { Services } from "../core/context.ts";
import { deleteBlobRepresentation } from "../core/blob-storage.ts";

/** Blobs nothing references for this long are deleted (covers in-flight publishes). */
export const GC_GRACE_MS = 24 * 60 * 60 * 1000;

/** Logical deletion is atomic; physical generations have independent dependency lifetimes. */
export async function collectGarbage(
  services: Services,
  now = Date.now(),
): Promise<{ blobs: number }> {
  const cutoff = new Date(now - GC_GRACE_MS).toISOString();
  // A failed delivery cannot pin staging bytes forever. A fresh retirement grace also
  // outlives any fenced-out worker which was already writing an R2 frame.
  await services.env.REGISTRY_DB.batch([
    services.env.REGISTRY_DB.prepare(`UPDATE blob_representations SET retired_at=? WHERE key IN
      (SELECT 'c/' || id || '/index.json' FROM blob_compactions WHERE phase='build' AND created_at<? AND lease_until<?)`).bind(
      new Date(now).toISOString(),
      now - 7 * GC_GRACE_MS,
      now,
    ),
    services.env.REGISTRY_DB.prepare(
      "DELETE FROM blob_compactions WHERE phase='build' AND created_at<? AND lease_until<?",
    ).bind(now - 7 * GC_GRACE_MS, now),
  ]);
  const removed = await sql<{ digest: string }>`DELETE FROM blobs WHERE digest IN (
    SELECT b.digest FROM blobs b WHERE b.created_at<${cutoff}
      AND NOT EXISTS(SELECT 1 FROM files WHERE digest=b.digest)
      AND NOT EXISTS(SELECT 1 FROM oci_manifests WHERE digest=b.digest)
      AND NOT EXISTS(SELECT 1 FROM oci_blob_links WHERE digest=b.digest)
      AND NOT EXISTS(SELECT 1 FROM release_assets WHERE digest=b.digest)
      AND NOT EXISTS(SELECT 1 FROM remote_entries WHERE digest=b.digest)
      AND NOT EXISTS(SELECT 1 FROM blob_compactions WHERE digest=b.digest)
    LIMIT 500) RETURNING digest`.execute(services.db);
  // A representation remains while any generation depends on it, including retired
  // generations still in their grace window. Once those disappear the anchor follows.
  const physical = await sql<{ key: string }>`UPDATE blob_representations SET state='deleting'
    WHERE key IN (SELECT r.key FROM blob_representations r
      WHERE (r.state='deleting' OR (r.state='retired' AND r.retired_at<${cutoff}))
        AND NOT EXISTS(SELECT 1 FROM blobs WHERE r2_key=r.key)
        AND NOT EXISTS(SELECT 1 FROM blob_representations child WHERE child.base_key=r.key)
        AND NOT EXISTS(SELECT 1 FROM blob_compactions w WHERE w.source_key=r.key OR w.base_key=r.key
          OR 'c/' || w.id || '/index.json'=r.key)
      LIMIT 100) RETURNING key`.execute(services.db);
  for (const representation of physical.rows) {
    await deleteBlobRepresentation(services.bucket, representation.key);
    await sql`DELETE FROM blob_representations WHERE key=${representation.key} AND state='deleting'`.execute(
      services.db,
    );
  }
  return { blobs: removed.rows.length };
}
