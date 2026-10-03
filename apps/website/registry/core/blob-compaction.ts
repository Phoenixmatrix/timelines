import { sql } from "kysely";
import { FRAME_SIZE, compressFrame, makeDelta } from "@gitmatrix/formats/artifact-storage";
import { createHasher, resumeHasher, toHex, type HasherState } from "@gitmatrix/formats/hash";
import {
  loadBlobManifest,
  readBlobFrame,
  readBlobRange,
  type BlobFrame,
  type BlobManifest,
} from "./blob-storage.ts";
import { productionOnly } from "../../worker/preview.ts";
import type { Services } from "./context.ts";

const LEASE_MS = 5 * 60_000;
const FRAMES_PER_DELIVERY = 2;
const CLEANUP_GRACE_MS = 24 * 60 * 60_000;
interface Work {
  id: string;
  publication_id: number;
  digest: string;
  source_key: string;
  base_key: string | null;
  phase: "build" | "cleanup";
  cleanup_cursor: string | null;
  result_key: string | null;
  size: number;
  frame: number;
  hash_state: string;
  full_bytes: number;
  delta_bytes: number;
}

/** Strictly more than half is an early keyframe; equality remains a delta. */
export function chooseFullSnapshot(
  fullBytes: number,
  deltaBytes: number,
  hasBase: boolean,
): boolean {
  return !hasBase || deltaBytes > fullBytes / 2;
}

export async function requestCompaction(services: Services): Promise<void> {
  // gitmatrix-registry-jobs is production's queue; a preview leaves blobs uncompacted.
  if (!productionOnly(services.env, "queue", "blob compaction")) return;
  // Publication state is already committed by attachment triggers. Cron recovers failed sends.
  try {
    await services.env.REGISTRY_JOBS.send({ type: "compact-sweep" });
  } catch (error) {
    console.warn("Compaction enqueue failed; cron will recover committed publications", error);
  }
}

/** Each cursor advances with its inserts in the same D1 transaction. */
async function backfill(services: Services): Promise<boolean> {
  const d1 = services.env.REGISTRY_DB;
  for (const name of ["blobs", "files", "release_assets"] as const) {
    const cursor = await d1
      .prepare("SELECT cursor,done FROM artifact_backfill WHERE name=?")
      .bind(name)
      .first<{ cursor: number; done: number }>();
    if (!cursor || cursor.done) continue;
    const rows = await d1
      .prepare(`SELECT rowid AS n FROM ${name} WHERE rowid>? ORDER BY rowid LIMIT 200`)
      .bind(cursor.cursor)
      .all<{ n: number }>();
    const last = rows.results.at(-1)?.n ?? cursor.cursor;
    let statement: D1PreparedStatement;
    if (name === "blobs") {
      statement = d1
        .prepare(
          "INSERT OR IGNORE INTO blob_representations(key,digest) SELECT r2_key,digest FROM blobs WHERE rowid>? AND rowid<=?",
        )
        .bind(cursor.cursor, last);
    } else if (name === "files") {
      statement = d1
        .prepare(`INSERT OR IGNORE INTO artifact_publications(repo_id,lineage,version,source,digest,created_at)
        SELECT repo_id,'generic:' || substr(path,1,instr(path,'/')-1) || '/' || substr(rest,instr(rest,'/')+1),
          substr(rest,1,instr(rest,'/')-1),path,digest,created_at FROM
          (SELECT f.*,substr(path,instr(path,'/')+1) AS rest FROM files f JOIN repositories r ON r.id=f.repo_id
           WHERE f.rowid>? AND f.rowid<=? AND r.format='generic' AND instr(path,'/')>0
             AND NOT EXISTS(SELECT 1 FROM artifact_publications p WHERE p.repo_id=f.repo_id AND p.source=f.path AND p.digest=f.digest))
        WHERE instr(rest,'/')>0 ORDER BY created_at,path`)
        .bind(cursor.cursor, last);
    } else {
      statement = d1
        .prepare(`INSERT OR IGNORE INTO artifact_publications(repo_id,lineage,version,source,digest,created_at)
        SELECT r.repo_id,'release:' || r.project || '/' || a.name,r.tag,r.id || '/' || a.name,a.digest,a.created_at
        FROM release_assets a JOIN releases r ON r.id=a.release_id WHERE a.rowid>? AND a.rowid<=?
          AND NOT EXISTS(SELECT 1 FROM artifact_publications p WHERE p.repo_id=r.repo_id AND p.source=r.id || '/' || a.name AND p.digest=a.digest)
        ORDER BY a.created_at,a.name`)
        .bind(cursor.cursor, last);
    }
    await d1.batch([
      statement,
      d1
        .prepare("UPDATE artifact_backfill SET cursor=max(cursor,?),done=? WHERE name=?")
        .bind(last, rows.results.length < 200 ? 1 : 0, name),
    ]);
    return true;
  }
  return false;
}

export async function sweepCompactions(services: Services): Promise<void> {
  if (await backfill(services)) {
    await requestCompaction(services);
    return;
  }
  // Enumerate the small artifact set, not every pending version of a busy lineage.
  const candidates = await sql<{
    id: number;
    digest: string;
    r2_key: string;
    size: number;
    repo_id: string;
    lineage: string;
    created_at: string;
  }>`
    SELECT p.id,p.digest,b.r2_key,b.size,p.repo_id,p.lineage,p.created_at FROM artifact_publications p JOIN blobs b ON b.digest=p.digest
    WHERE p.id IN (
      SELECT (SELECT q.id FROM artifact_live_publications q
        WHERE q.repo_id=l.repo_id AND q.lineage=l.lineage AND q.status='pending'
          AND NOT EXISTS(SELECT 1 FROM blob_compactions w WHERE w.digest=q.digest)
          AND NOT EXISTS(SELECT 1 FROM artifact_hot_digests h WHERE h.digest=q.digest)
        ORDER BY q.created_at,q.id LIMIT 1)
      FROM (SELECT DISTINCT repo_id,lineage FROM artifact_hot_versions) l
      WHERE NOT EXISTS(SELECT 1 FROM blob_compactions w JOIN artifact_publications q ON q.id=w.publication_id
        WHERE q.repo_id=l.repo_id AND q.lineage=l.lineage AND w.phase='build'))
    ORDER BY p.created_at,p.id LIMIT 16`.execute(services.db);
  for (const p of candidates.rows) {
    if (Math.ceil(p.size / FRAME_SIZE) > 20_000) {
      await sql`UPDATE artifact_publications SET status='done' WHERE id=${p.id}`.execute(
        services.db,
      );
      continue;
    }
    const existing = await sql<{
      base_key: string | null;
    }>`SELECT base_key FROM blob_representations
      WHERE key=${p.r2_key} AND key LIKE 'c/%' AND state='live'`.execute(services.db);
    if (existing.rows[0]?.base_key === null) {
      // Identical versions already share a real full snapshot; do not encode it again.
      await sql`UPDATE artifact_publications SET status='done',snapshot_key=${p.r2_key}
        WHERE id IN (SELECT id FROM artifact_publications WHERE digest=${p.digest}
          AND status='pending' ORDER BY id LIMIT 200)
        AND EXISTS(SELECT 1 FROM blobs WHERE digest=${p.digest} AND r2_key=${p.r2_key})`.execute(
        services.db,
      );
      await requestCompaction(services);
      continue;
    }
    const base = await sql<{ snapshot_key: string }>`SELECT q.snapshot_key FROM (
      SELECT p.snapshot_key,p.created_at,p.id FROM artifact_publications p
      JOIN blob_representations r ON r.key=p.snapshot_key
      WHERE p.repo_id=${p.repo_id} AND p.lineage=${p.lineage}
        AND (p.created_at,p.id)<(${p.created_at},${p.id})
        AND p.snapshot_key IS NOT NULL AND r.state!='deleting' AND r.base_key IS NULL
      ORDER BY p.created_at DESC,p.id DESC LIMIT 1) q
      WHERE (SELECT count(*) FROM (SELECT 1 FROM artifact_publications n
        WHERE n.repo_id=${p.repo_id} AND n.lineage=${p.lineage}
          AND (n.created_at,n.id)>(q.created_at,q.id)
          AND (n.created_at,n.id)<=(${p.created_at},${p.id}) LIMIT 32))<32`.execute(services.db);
    const baseKey = base.rows[0]?.snapshot_key ?? null;
    const id = crypto.randomUUID();
    const now = Date.now();
    const hash = JSON.stringify(createHasher("sha256").exportState());
    await sql`INSERT OR IGNORE INTO blob_compactions(id,publication_id,digest,source_key,base_key,size,hash_state,updated_at,created_at)
      SELECT ${id},${p.id},${p.digest},${p.r2_key},${baseKey},${p.size},${hash},${now},${now}
      WHERE EXISTS(SELECT 1 FROM blobs WHERE digest=${p.digest} AND r2_key=${p.r2_key})
        AND (${baseKey} IS NULL OR EXISTS(SELECT 1 FROM blob_representations WHERE key=${baseKey} AND state!='deleting'))
        AND NOT EXISTS(SELECT 1 FROM blob_compactions w JOIN artifact_publications q ON q.id=w.publication_id
          WHERE q.repo_id=${p.repo_id} AND q.lineage=${p.lineage} AND w.phase='build')`.execute(
      services.db,
    );
  }
  const pending = await sql<{
    id: string;
  }>`SELECT id FROM blob_compactions WHERE lease_until<${Date.now()} ORDER BY updated_at LIMIT 32`.execute(
    services.db,
  );
  for (const work of pending.rows)
    await services.env.REGISTRY_JOBS.send({ type: "compact", id: work.id });
}

async function putFrame(
  services: Services,
  key: string,
  bytes: Uint8Array,
  size: number,
  sha256: string,
  delta: boolean,
): Promise<BlobFrame> {
  const compressed = compressFrame(bytes);
  await services.bucket.put(key, compressed.data);
  return {
    key,
    size,
    sha256,
    codec: compressed.codec,
    payloadSize: bytes.length,
    storedSize: compressed.data.length,
    delta,
  };
}

export async function compactBlob(services: Services, id: string): Promise<void> {
  const fence = crypto.randomUUID();
  const now = Date.now();
  const claimed =
    await sql<Work>`UPDATE blob_compactions SET fence=${fence},lease_until=${now + LEASE_MS},updated_at=${now}
    WHERE id=${id} AND lease_until<${now} RETURNING *`.execute(services.db);
  const work = claimed.rows[0];
  if (!work) return;
  if (work.phase === "cleanup") {
    const manifest = work.result_key
      ? await loadBlobManifest(services.bucket, work.result_key)
      : null;
    const keep = new Set(manifest?.frames.map((frame) => frame.key) ?? []);
    if (work.result_key) keep.add(work.result_key);
    const page = await services.bucket.list({
      prefix: `c/${id}/`,
      limit: 1000,
      ...(work.cleanup_cursor ? { cursor: work.cleanup_cursor } : {}),
    });
    const garbage = page.objects
      .filter((object) => !keep.has(object.key))
      .map((object) => object.key);
    if (garbage.length) await services.bucket.delete(garbage);
    if (page.truncated) {
      await sql`UPDATE blob_compactions SET cleanup_cursor=${page.cursor},lease_until=0 WHERE id=${id} AND fence=${fence}`.execute(
        services.db,
      );
      await services.env.REGISTRY_JOBS.send({ type: "compact", id });
    } else {
      await sql`DELETE FROM blob_compactions WHERE id=${id} AND fence=${fence}`.execute(
        services.db,
      );
      await requestCompaction(services);
    }
    return;
  }
  const base = work.base_key ? await loadBlobManifest(services.bucket, work.base_key) : null;
  if (base?.base) throw new Error("Compaction anchor must be a full snapshot");
  const hasher = resumeHasher(JSON.parse(work.hash_state) as HasherState);
  const count = Math.ceil(work.size / FRAME_SIZE);
  for (let processed = 0; work.frame < count && processed < FRAMES_PER_DELIVERY; processed++) {
    const index = work.frame;
    const size = Math.min(FRAME_SIZE, work.size - index * FRAME_SIZE);
    const bytes = await readBlobRange(services.bucket, work.source_key, index * FRAME_SIZE, size);
    hasher.update(bytes);
    const sha256 = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
    const full = await putFrame(
      services,
      `c/${id}/${index}-${fence}-full`,
      bytes,
      size,
      sha256,
      false,
    );
    let delta: BlobFrame | null = null;
    if (base) {
      // New tail frames need no base. A shorter target simply omits old tail frames.
      if (index < base.frames.length) {
        const original = await readBlobFrame(services.bucket, base, index);
        const instructions = makeDelta(original, bytes);
        delta = await putFrame(
          services,
          `c/${id}/${index}-${fence}-delta`,
          instructions,
          size,
          sha256,
          true,
        );
      } else delta = full;
    }
    const verification: BlobManifest = {
      version: 1,
      size: work.size,
      digest: work.digest,
      frameSize: FRAME_SIZE,
      base: null,
      frames: [],
    };
    verification.frames[index] = full;
    // Verify authoritative staged bytes without prewarming every historical version.
    await readBlobFrame(services.bucket, verification, index, false);
    if (delta?.delta) {
      verification.base = work.base_key;
      verification.frames[index] = delta;
      await readBlobFrame(services.bucket, verification, index, false);
    }
    const result = await services.env.REGISTRY_DB.batch([
      services.env.REGISTRY_DB.prepare(`INSERT OR REPLACE INTO blob_compaction_frames(work_id,frame,full_frame,delta_frame)
        SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM blob_compactions WHERE id=? AND fence=?)`).bind(
        id,
        index,
        JSON.stringify(full),
        delta ? JSON.stringify(delta) : null,
        id,
        fence,
      ),
      services.env.REGISTRY_DB.prepare(`UPDATE blob_compactions SET frame=frame+1,hash_state=?,full_bytes=full_bytes+?,
        delta_bytes=delta_bytes+?,updated_at=?,lease_until=? WHERE id=? AND fence=?`).bind(
        JSON.stringify(hasher.exportState()),
        full.storedSize,
        delta?.storedSize ?? 0,
        Date.now(),
        Date.now() + LEASE_MS,
        id,
        fence,
      ),
    ]);
    if (!result[1]?.meta.changes) return;
    work.frame++;
    work.full_bytes += full.storedSize;
    work.delta_bytes += delta?.storedSize ?? 0;
  }
  if (work.frame < count) {
    await sql`UPDATE blob_compactions SET lease_until=0 WHERE id=${id} AND fence=${fence}`.execute(
      services.db,
    );
    await services.env.REGISTRY_JOBS.send({ type: "compact", id });
    return;
  }
  if (`sha256:${toHex(hasher.digest())}` !== work.digest)
    throw new Error("Compaction source checksum mismatch");
  const full = chooseFullSnapshot(work.full_bytes, work.delta_bytes, Boolean(base));
  const rows = await sql<{
    full_frame: string;
    delta_frame: string | null;
  }>`SELECT full_frame,delta_frame FROM blob_compaction_frames WHERE work_id=${id} ORDER BY frame`.execute(
    services.db,
  );
  const manifest: BlobManifest = {
    version: 1,
    size: work.size,
    digest: work.digest,
    frameSize: FRAME_SIZE,
    base: full ? null : work.base_key,
    frames: rows.rows.map(
      (row) => JSON.parse((full ? row.full_frame : row.delta_frame)!) as BlobFrame,
    ),
  };
  const text = JSON.stringify(manifest);
  // Raw-codec keyframes are still useful anchors for future deltas. They replace
  // the raw locator rather than pinning a duplicate independent copy forever.
  const profitable = full || work.delta_bytes + new TextEncoder().encode(text).length < work.size;
  const key = `c/${id}/index.json`;
  let published = manifest;
  if (profitable) {
    const written = await services.bucket.put(key, text, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" },
    });
    // A previous fenced invocation may already have published this immutable manifest.
    if (!written) published = await loadBlobManifest(services.bucket, key);
    if (
      published.digest !== work.digest ||
      published.size !== work.size ||
      (published.base !== null && published.base !== work.base_key)
    ) {
      throw new Error("Compaction generation does not match its reserved source");
    }
  }
  // Atomic publication with a fence and source CAS; a newly hot digest wins over compaction.
  await services.env.REGISTRY_DB.batch([
    services.env.REGISTRY_DB.prepare(`UPDATE blob_representations SET base_key=?,retired_at=?
      WHERE key=? AND EXISTS(SELECT 1 FROM blob_compactions WHERE id=? AND fence=?)`).bind(
      profitable ? published.base : null,
      new Date().toISOString(),
      key,
      id,
      fence,
    ),
    services.env.REGISTRY_DB.prepare(`UPDATE blobs SET r2_key=? WHERE digest=? AND r2_key=? AND ?=1
      AND EXISTS(SELECT 1 FROM blob_compactions WHERE id=? AND fence=?)
      AND NOT EXISTS(SELECT 1 FROM artifact_hot_digests WHERE digest=?)`).bind(
      key,
      work.digest,
      work.source_key,
      profitable ? 1 : 0,
      id,
      fence,
      work.digest,
    ),
    services.env.REGISTRY_DB.prepare(`UPDATE artifact_publications SET status=CASE WHEN EXISTS(
      SELECT 1 FROM blobs WHERE digest=? AND (r2_key=? OR (?=0 AND r2_key=?))) THEN 'done' ELSE 'pending' END,
      snapshot_key=(SELECT CASE WHEN ?=1 AND ?=1 AND r2_key=? THEN r2_key ELSE NULL END FROM blobs WHERE digest=?)
      WHERE id=? AND status!='gone' AND EXISTS(SELECT 1 FROM blob_compactions WHERE id=? AND fence=?)`).bind(
      work.digest,
      key,
      profitable ? 1 : 0,
      work.source_key,
      profitable ? 1 : 0,
      published.base === null ? 1 : 0,
      key,
      work.digest,
      work.publication_id,
      id,
      fence,
    ),
    services.env.REGISTRY_DB.prepare(
      "UPDATE blob_compactions SET phase='cleanup',result_key=?,lease_until=? WHERE id=? AND fence=?",
    ).bind(profitable ? key : null, Date.now() + CLEANUP_GRACE_MS, id, fence),
  ]);
  // Delay physical cleanup past every possible fenced-out queue invocation.
  // Cron resumes it durably; the lineage can already advance to its next update.
  await requestCompaction(services);
}
