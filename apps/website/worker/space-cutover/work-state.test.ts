import { Buffer } from "node:buffer";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vite-plus/test";
import { fakeDurableState } from "../testing/durable-state.ts";
import { WORK_STATE_MAX_CHARACTERS } from "../../shared/space-cutover.ts";
import {
  initializeWorkState,
  readWorkState,
  writeWorkState,
  WORK_STATE_FRAGMENT_CHARACTERS,
  type WorkStateStorage,
} from "./work-state.ts";

function fixture() {
  const { ctx, db } = fakeDurableState();
  const storage: WorkStateStorage = ctx.storage;
  initializeWorkState(storage);
  // node:sqlite exposes no sqlite3_limit setter. Enforce a much smaller
  // native-style value ceiling inside SQLite itself, not a source assertion.
  db.exec(`
    CREATE TRIGGER fragment_value_ceiling BEFORE INSERT ON work_state_fragments
    WHEN length(NEW.value)>${WORK_STATE_FRAGMENT_CHARACTERS * 2}
    BEGIN SELECT RAISE(ABORT,'SQLite value ceiling'); END;
    CREATE TRIGGER inline_value_ceiling BEFORE INSERT ON work
    WHEN length(CAST(NEW.value AS BLOB))>${WORK_STATE_FRAGMENT_CHARACTERS * 2}
    BEGIN SELECT RAISE(ABORT,'SQLite value ceiling'); END;
  `);
  return { db, storage };
}

function currentFragments(f: { db: DatabaseSync }): number {
  return Number(f.db.prepare("SELECT count(*) AS n FROM work_state_fragments").get()!.n);
}

describe("independent fragmented work progress", () => {
  test("20M-character state crosses a real SQLite-enforced per-value ceiling and reconstructs cold", () => {
    const f = fixture();
    const value = "x".repeat(20_000_000) + "\0é漢字😀\ud800\udfff";
    expect(() =>
      f.db.prepare("INSERT INTO work VALUES(?,?,?)").run("run", "inline", value),
    ).toThrow("SQLite value ceiling");
    writeWorkState(f.storage, "run", "state", value);
    expect(currentFragments(f)).toBe(Math.ceil(value.length / WORK_STATE_FRAGMENT_CHARACTERS));
    // No live instance/cache participates in reconstruction. Reinitialize the
    // same persistent store as a constructor would after a lost acknowledgment.
    initializeWorkState(f.storage);
    expect(readWorkState({ ...f.storage }, "run", "state")).toBe(value);
    writeWorkState(f.storage, "run", "state", value);
    expect(readWorkState(f.storage, "run", "state")).toBe(value);
    expect(currentFragments(f)).toBe(Math.ceil(value.length / WORK_STATE_FRAGMENT_CHARACTERS));
    f.db.close();
  });

  test("preserves Unicode and NUL across fragment seams and replaces generations without leftovers", () => {
    const f = fixture();
    const value = "a".repeat(WORK_STATE_FRAGMENT_CHARACTERS - 1) + "😀\0\ud800é漢字";
    writeWorkState(f.storage, "run", "state", value);
    expect(readWorkState(f.storage, "run", "state")).toBe(value);
    const first = f.db.prepare("SELECT generation FROM work_state_heads").get()!.generation;
    writeWorkState(f.storage, "run", "state", "replacement\0");
    expect(f.db.prepare("SELECT generation FROM work_state_heads").get()!.generation).not.toBe(
      first,
    );
    expect(currentFragments(f)).toBe(1);
    expect(readWorkState(f.storage, "run", "state")).toBe("replacement\0");
    writeWorkState(f.storage, "run", "state", "");
    expect(readWorkState(f.storage, "run", "state")).toBe("");
    expect(currentFragments(f)).toBe(0);
    expect(readWorkState(f.storage, "run", "absent")).toBeNull();
    f.db.close();
  });

  test("fragment failure rolls back partial generation and keeps the old pointer intact", () => {
    const f = fixture();
    writeWorkState(f.storage, "run", "state", "previous");
    f.db.exec(`CREATE TRIGGER injected_failure BEFORE INSERT ON work_state_fragments
      WHEN NEW.ordinal=1 BEGIN SELECT RAISE(ABORT,'injected fragment failure'); END;`);
    expect(() =>
      writeWorkState(f.storage, "run", "state", "z".repeat(WORK_STATE_FRAGMENT_CHARACTERS * 3)),
    ).toThrow("injected fragment failure");
    initializeWorkState(f.storage);
    expect(readWorkState(f.storage, "run", "state")).toBe("previous");
    expect(currentFragments(f)).toBe(1);
    f.db.exec("DROP TRIGGER injected_failure");
    writeWorkState(f.storage, "run", "state", "retry");
    expect(readWorkState(f.storage, "run", "state")).toBe("retry");
    expect(currentFragments(f)).toBe(1);
    f.db.close();
  });

  test("metadata callback failure rolls back pointer, cleanup, and metadata together", () => {
    const f = fixture();
    f.db.exec("CREATE TABLE metadata(value TEXT)");
    writeWorkState(f.storage, "run", "state", "previous");
    expect(() =>
      writeWorkState(f.storage, "run", "state", "replacement", () => {
        f.db.prepare("INSERT INTO metadata VALUES(?)").run("uncommitted");
        throw new Error("metadata failure");
      }),
    ).toThrow("metadata failure");
    expect(readWorkState(f.storage, "run", "state")).toBe("previous");
    expect(currentFragments(f)).toBe(1);
    expect(f.db.prepare("SELECT * FROM metadata").all()).toEqual([]);
    writeWorkState(f.storage, "run", "state", "replacement", () => {
      f.db.prepare("INSERT INTO metadata VALUES(?)").run("committed");
    });
    expect(readWorkState(f.storage, "run", "state")).toBe("replacement");
    expect(f.db.prepare("SELECT value FROM metadata").get()!.value).toBe("committed");
    f.db.close();
  });

  test.each(["missing", "bytes", "ordinal", "head", "extra"])(
    "refuses %s corruption instead of exposing partial or mixed data",
    (kind) => {
      const f = fixture();
      writeWorkState(f.storage, "run", "state", "a".repeat(WORK_STATE_FRAGMENT_CHARACTERS) + "bb");
      if (kind === "missing") f.db.exec("DELETE FROM work_state_fragments WHERE ordinal=0");
      if (kind === "bytes")
        f.db
          .prepare("UPDATE work_state_fragments SET value=? WHERE ordinal=1")
          .run(Buffer.from("cc", "utf16le"));
      if (kind === "ordinal")
        f.db.exec("UPDATE work_state_fragments SET ordinal=3 WHERE ordinal=0");
      if (kind === "head") f.db.exec("UPDATE work_state_heads SET characters=characters+1");
      if (kind === "extra")
        f.db.exec(
          "INSERT INTO work_state_fragments SELECT run_id,key,generation,9,value FROM work_state_fragments WHERE ordinal=1",
        );
      // A stale inline row must never hide a broken selected generation.
      f.db.prepare("INSERT INTO work VALUES(?,?,?)").run("run", "state", "stale inline");
      expect(() => readWorkState(f.storage, "run", "state")).toThrow("incomplete or corrupt");
      f.db.close();
    },
  );

  test("isolates slots and ignores unpublished fragments until successful atomic cleanup", () => {
    const f = fixture();
    writeWorkState(f.storage, "run", "state", "published");
    writeWorkState(f.storage, "other", "state", "other run");
    writeWorkState(f.storage, "run", "other", "other key");
    f.db
      .prepare("INSERT INTO work_state_fragments VALUES(?,?,?,?,?)")
      .run("run", "state", "unpublished", 0, Buffer.from("incomplete", "utf16le"));
    expect(readWorkState(f.storage, "run", "state")).toBe("published");
    writeWorkState(f.storage, "run", "state", "next");
    expect(currentFragments(f)).toBe(3);
    expect(readWorkState(f.storage, "other", "state")).toBe("other run");
    expect(readWorkState(f.storage, "run", "other")).toBe("other key");
    f.db.close();
  });

  test("upgrades real inline work entries and rejects oversized progress before a transaction", () => {
    const f = fixture();
    f.db.prepare("INSERT INTO work VALUES(?,?,?)").run("run", "state", "legacy");
    expect(readWorkState(f.storage, "run", "state")).toBe("legacy");
    // A repeated string is never encoded, sliced, hashed, or JSON-serialized on
    // the rejected path. Exercise the immutable production bound itself.
    const oversized = "x".repeat(WORK_STATE_MAX_CHARACTERS + 1);
    const rejectedStorage: WorkStateStorage = {
      sql: f.storage.sql,
      transactionSync() {
        throw new Error("Rejected state must not open a transaction");
      },
    };
    expect(() => writeWorkState(rejectedStorage, "run", "state", oversized)).toThrow(
      "space_cutover_export_required",
    );
    expect(readWorkState(f.storage, "run", "state")).toBe("legacy");
    writeWorkState(f.storage, "run", "state", "fragmented");
    expect(readWorkState(f.storage, "run", "state")).toBe("fragmented");
    expect(f.db.prepare("SELECT * FROM work").all()).toEqual([]);
    expect(() => writeWorkState(rejectedStorage, "run", "state", oversized)).toThrow(
      "space_cutover_export_required",
    );
    expect(readWorkState(f.storage, "run", "state")).toBe("fragmented");
    expect(currentFragments(f)).toBe(1);
    f.db.close();
  });
});
