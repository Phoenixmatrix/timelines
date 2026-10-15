// The serialized databases the unit project builds once per run
// (worker/testing/global-setup.ts) and hands each test file
// (worker/testing/unit-setup.ts): the migrated schemas and a freshly
// initialized installation. Elsewhere (the browser project's commands, a run
// without the setup) nothing is provided and each module builds its own.

import { readFileSync } from "node:fs";

/** The key the global setup provides them under. */
export const PROVIDED_DATABASES = "gitmatrixDatabases";

export type DatabaseName =
  | "migrated"
  | "migratedRegistry"
  | "installed"
  | "installedRegistry"
  | "installedControl";

/**
 * Each database's file. Megabytes of bytes in the provided context itself
 * would travel with every test file, including those that never open one.
 */
export type ProvidedDatabases = Record<DatabaseName, string>;

let provided: Partial<ProvidedDatabases> = {};

export function provideDatabases(databases: Partial<ProvidedDatabases> | undefined): void {
  provided = databases ?? {};
}

/** The bytes of a provided database, or undefined when this run provided none. */
export function providedDatabase(name: DatabaseName): Uint8Array | undefined {
  const path = provided[name];
  return path === undefined ? undefined : readFileSync(path);
}
