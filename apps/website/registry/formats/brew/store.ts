import {
  deflate,
  ObjectGraph,
  type EncodedObject,
  type StoredObject,
} from "@gitmatrix/formats/git";
import { fromBase64, toBase64 } from "@gitmatrix/formats/hash";

import type { DB } from "../../core/db.ts";

type GitObjectType = "commit" | "tree" | "blob";

declare module "../../core/db.ts" {
  interface Database {
    brew_git_objects: {
      repo_id: string;
      oid: string;
      type: GitObjectType;
      size: number;
      seq: number;
      data: string;
    };
  }
}

export interface Head {
  oid: string;
  seq: number;
}

/** The tip of refs/heads/main, or null before the first commit. */
export async function getHead(db: DB, repoId: string): Promise<Head | null> {
  const row = await db
    .selectFrom("brew_git_objects")
    .select(["oid", "seq"])
    .where("repo_id", "=", repoId)
    .where("type", "=", "commit")
    .orderBy("seq", "desc")
    .limit(1)
    .executeTakeFirst();
  return row ?? null;
}

export async function getObject(db: DB, repoId: string, oid: string): Promise<StoredObject | null> {
  const row = await db
    .selectFrom("brew_git_objects")
    .select(["oid", "type", "size", "data"])
    .where("repo_id", "=", repoId)
    .where("oid", "=", oid)
    .executeTakeFirst();
  return row ? { oid: row.oid, type: row.type, size: row.size, zdata: fromBase64(row.data) } : null;
}

const PAGE = 500;

/** Every object up to commit `maxSeq`, as a graph (taps are small). */
export async function loadGraph(db: DB, repoId: string, maxSeq: number): Promise<ObjectGraph> {
  const graph = new ObjectGraph();
  let after: { seq: number; oid: string } | null = null;
  for (;;) {
    let query = db
      .selectFrom("brew_git_objects")
      .select(["oid", "type", "size", "seq", "data"])
      .where("repo_id", "=", repoId)
      .where("seq", "<=", maxSeq)
      .orderBy("seq")
      .orderBy("oid")
      .limit(PAGE);
    if (after) {
      const { seq, oid } = after;
      query = query.where((eb) =>
        eb.or([eb("seq", ">", seq), eb.and([eb("seq", "=", seq), eb("oid", ">", oid)])]),
      );
    }
    const rows = await query.execute();
    for (const row of rows) {
      graph.add({ oid: row.oid, type: row.type, size: row.size, zdata: fromBase64(row.data) });
    }
    if (rows.length < PAGE) return graph;
    const last = rows.at(-1)!;
    after = { seq: last.seq, oid: last.oid };
  }
}

/** Which of `oids` are already stored. */
export async function existingOids(db: DB, repoId: string, oids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const unique = [...new Set(oids)];
  for (let i = 0; i < unique.length; i += 90) {
    const rows = await db
      .selectFrom("brew_git_objects")
      .select("oid")
      .where("repo_id", "=", repoId)
      .where("oid", "in", unique.slice(i, i + 90))
      .execute();
    for (const row of rows) found.add(row.oid);
  }
  return found;
}

/** Stores the objects that are not there yet, in order (commits last by the caller). */
export async function putObjects(
  db: DB,
  repoId: string,
  seq: number,
  objects: EncodedObject[],
): Promise<void> {
  const present = await existingOids(
    db,
    repoId,
    objects.map((o) => o.oid),
  );
  const fresh = new Map<string, EncodedObject>();
  for (const object of objects) if (!present.has(object.oid)) fresh.set(object.oid, object);
  const rows = [...fresh.values()].map((o) => ({
    repo_id: repoId,
    oid: o.oid,
    type: o.type as GitObjectType,
    size: o.size,
    seq,
    data: toBase64(deflate(o.data)),
  }));
  // D1 allows 100 bound parameters per statement; each row binds 6.
  for (let i = 0; i < rows.length; i += 16) {
    await db
      .insertInto("brew_git_objects")
      .values(rows.slice(i, i + 16))
      .onConflict((oc) => oc.columns(["repo_id", "oid"]).doNothing())
      .execute();
  }
}
