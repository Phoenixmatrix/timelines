import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { WORK_STATE_MAX_CHARACTERS } from "../../shared/space-cutover.ts";

export type WorkStateStorage = Pick<DurableObjectStorage, "sql" | "transactionSync">;

// Code units, not UTF-8 bytes: UTF-16LE preserves even split/lone surrogates and NUL.
export const WORK_STATE_FRAGMENT_CHARACTERS = 64 * 1024;

/** Independent progress only. Original archive pages are never stored or changed here. */
export function initializeWorkState(storage: WorkStateStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS work (
      run_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(run_id,key)
    );
    CREATE TABLE IF NOT EXISTS work_state_heads (
      run_id TEXT NOT NULL, key TEXT NOT NULL, generation TEXT NOT NULL,
      characters INTEGER NOT NULL, fragments INTEGER NOT NULL, digest TEXT NOT NULL,
      PRIMARY KEY(run_id,key)
    );
    CREATE TABLE IF NOT EXISTS work_state_fragments (
      run_id TEXT NOT NULL, key TEXT NOT NULL, generation TEXT NOT NULL,
      ordinal INTEGER NOT NULL, value BLOB NOT NULL,
      PRIMARY KEY(run_id,key,generation,ordinal)
    );
  `);
}

/** Publish a complete immutable generation and retire its predecessor in one transaction.
 * commit can atomically update compact control metadata with the progress pointer.
 * The caller remains responsible for run/phase/authority validation.
 */
export function writeWorkState(
  storage: WorkStateStorage,
  runId: string,
  key: string,
  value: string,
  commit?: () => void,
): void {
  if (value.length > WORK_STATE_MAX_CHARACTERS)
    throw new Error(
      "space_cutover_export_required: serialized work state exceeds 32,000,000 UTF-16 code units; retain the original archives and export for offline recovery before continuing",
    );
  const generation = crypto.randomUUID();
  const fragments = Math.ceil(value.length / WORK_STATE_FRAGMENT_CHARACTERS);
  storage.transactionSync(() => {
    const hash = createHash("sha256");
    for (let ordinal = 0; ordinal < fragments; ordinal++) {
      const start = ordinal * WORK_STATE_FRAGMENT_CHARACTERS;
      const end = Math.min(start + WORK_STATE_FRAGMENT_CHARACTERS, value.length);
      const bytes = new ArrayBuffer((end - start) * 2);
      const buffer = Buffer.from(bytes);
      buffer.write(value.slice(start, end), "utf16le");
      hash.update(buffer);
      storage.sql.exec(
        "INSERT INTO work_state_fragments(run_id,key,generation,ordinal,value) VALUES(?,?,?,?,?)",
        runId,
        key,
        generation,
        ordinal,
        bytes,
      );
    }
    storage.sql.exec(
      "INSERT INTO work_state_heads(run_id,key,generation,characters,fragments,digest) VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,key) DO UPDATE SET generation=excluded.generation,characters=excluded.characters,fragments=excluded.fragments,digest=excluded.digest",
      runId,
      key,
      generation,
      value.length,
      fragments,
      hash.digest("hex"),
    );
    storage.sql.exec(
      "DELETE FROM work_state_fragments WHERE run_id=? AND key=? AND generation<>?",
      runId,
      key,
      generation,
    );
    // Upgrade genuine pre-fragment internal journal entries, never a public alias.
    storage.sql.exec("DELETE FROM work WHERE run_id=? AND key=?", runId, key);
    commit?.();
  });
}

export function readWorkState(
  storage: WorkStateStorage,
  runId: string,
  key: string,
): string | null {
  const head = storage.sql
    .exec<{
      generation: string;
      characters: number;
      fragments: number;
      digest: string;
    }>(
      "SELECT generation,characters,fragments,digest FROM work_state_heads WHERE run_id=? AND key=?",
      runId,
      key,
    )
    .toArray()[0];
  if (!head) {
    return (
      storage.sql
        .exec<{ value: string }>("SELECT value FROM work WHERE run_id=? AND key=?", runId, key)
        .toArray()[0]?.value ?? null
    );
  }
  const corrupt = () => new Error("Independent work state is incomplete or corrupt");
  if (
    !Number.isSafeInteger(head.characters) ||
    head.characters < 0 ||
    head.characters > WORK_STATE_MAX_CHARACTERS ||
    head.fragments !== Math.ceil(head.characters / WORK_STATE_FRAGMENT_CHARACTERS) ||
    typeof head.generation !== "string" ||
    !head.generation ||
    typeof head.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(head.digest)
  )
    throw corrupt();
  const hash = createHash("sha256");
  const chunks: string[] = [];
  // Consume synchronously and in ordinal order; never materialize all BLOBs at once.
  for (const row of storage.sql.exec<{ ordinal: number; value: ArrayBuffer }>(
    "SELECT ordinal,value FROM work_state_fragments WHERE run_id=? AND key=? AND generation=? ORDER BY ordinal",
    runId,
    key,
    head.generation,
  )) {
    const expectedCharacters = Math.min(
      WORK_STATE_FRAGMENT_CHARACTERS,
      head.characters - chunks.length * WORK_STATE_FRAGMENT_CHARACTERS,
    );
    if (
      row.ordinal !== chunks.length ||
      chunks.length >= head.fragments ||
      !(row.value instanceof ArrayBuffer) ||
      row.value.byteLength !== expectedCharacters * 2
    )
      throw corrupt();
    const bytes = Buffer.from(row.value);
    hash.update(bytes);
    chunks.push(bytes.toString("utf16le"));
  }
  if (chunks.length !== head.fragments || hash.digest("hex") !== head.digest) throw corrupt();
  return chunks.join("");
}
