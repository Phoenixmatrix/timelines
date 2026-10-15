// The unit project's global setup: migrates the schemas and initializes a
// fresh installation once per run, instead of once per test file
// (worker/testing/provided.ts). In watch mode nothing is provided, so each
// rerun migrates afresh and sees an edited migration.

import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vite-plus/test/node";
import { migratedDatabaseBytes, migratedRegistryDatabaseBytes } from "./d1.ts";
import { PROVIDED_DATABASES, type DatabaseName, type ProvidedDatabases } from "./provided.ts";
import { initializedSnapshot } from "./spaces.ts";

const PREFIX = "gitmatrix-unit-databases-";

/** Directories a killed run left behind (its teardown never ran), older than a day. */
async function removeStale(): Promise<void> {
  const cutoff = Date.now() - 86_400_000;
  for (const name of await readdir(tmpdir()).catch(() => [] as string[])) {
    if (!name.startsWith(PREFIX)) continue;
    const path = join(tmpdir(), name);
    const modified = await stat(path).then(
      (s) => s.mtimeMs,
      () => Date.now(),
    );
    if (modified < cutoff) await rm(path, { recursive: true, force: true }).catch(() => {});
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  if (project.vitest.config.watch) return async () => {};
  await removeStale();
  const installed = await initializedSnapshot();
  const bytes: Record<DatabaseName, Uint8Array> = {
    migrated: migratedDatabaseBytes(),
    migratedRegistry: migratedRegistryDatabaseBytes(),
    installed: installed.db,
    installedRegistry: installed.registry,
    installedControl: installed.control,
  };
  const dir = await mkdtemp(join(tmpdir(), PREFIX));
  const databases = {} as ProvidedDatabases;
  for (const [name, content] of Object.entries(bytes) as [DatabaseName, Uint8Array][]) {
    databases[name] = join(dir, `${name}.sqlite`);
    await writeFile(databases[name], content);
  }
  (project.provide as (key: string, value: ProvidedDatabases) => void)(
    PROVIDED_DATABASES,
    databases,
  );
  return () => rm(dir, { recursive: true, force: true });
}
