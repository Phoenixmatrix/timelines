// Migration file names (CORE-64). D1 records applied migrations by file name and
// `cf d1 migrations apply` runs the rest ordered by the integer before the first
// `_`, so parallel work that picks the same next number collides. New files are
// named by UTC timestamp, `YYYYMMDDHHMMSS_snake_case.sql`, which sorts after the
// frozen four-digit files both numerically (cf) and lexically (the test
// harnesses' readdir().sort()).
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";

/** Each directory applied with `cf d1 migrations apply`, and its last four-digit file. */
const DIRECTORIES = [
  { dir: "../migrations/", lastNumbered: 20 },
  { dir: "../registry/migrations/", lastNumbered: 5 },
  { dir: "../seed/", lastNumbered: 1 },
];

/** Same-prefix files that landed before this gate; both already applied everywhere. */
const GRANDFATHERED = [["0016_agent_capabilities.sql", "0016_knowledge_graph_version.sql"]];

const NAME = /^(\d{4}|\d{14})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

/** cf's ordering: the integer before the first `_`, then the whole name. */
function cfOrder(a: string, b: string): number {
  const diff = Number.parseInt(a, 10) - Number.parseInt(b, 10);
  return diff || (a < b ? -1 : a > b ? 1 : 0);
}

function validTimestamp(prefix: string): boolean {
  const iso = prefix.replace(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)$/, "$1-$2-$3T$4:$5:$6Z");
  const date = new Date(iso);
  // The round trip rejects dates Date would roll over, such as Feb 30 or 24:00.
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().replace(/\D/g, "").slice(0, 14) === prefix
  );
}

/** Everything wrong with one directory's file names; empty when it's fine. */
function migrationProblems(files: string[], lastNumbered: number): string[] {
  const problems: string[] = [];
  const sql = files.filter((f) => f.endsWith(".sql"));
  const byPrefix = new Map<string, string[]>();
  for (const file of sql) {
    const match = NAME.exec(file);
    if (!match) {
      problems.push(`${file}: name it YYYYMMDDHHMMSS_snake_case_description.sql (UTC)`);
      continue;
    }
    const prefix = match[1]!;
    if (prefix.length === 4 && Number(prefix) > lastNumbered)
      problems.push(`${file}: numbered names are frozen; use a UTC timestamp prefix`);
    if (prefix.length === 14 && !validTimestamp(prefix))
      problems.push(`${file}: ${prefix} is not a valid UTC date and time`);
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), file]);
  }
  for (const [prefix, names] of byPrefix) {
    if (names.length === 1) continue;
    const known = GRANDFATHERED.some(
      (pair) => pair.length === names.length && pair.every((name) => names.includes(name)),
    );
    if (!known) problems.push(`${names.join(", ")}: share the prefix ${prefix}`);
  }
  const lexical = [...sql].sort();
  if (lexical.join() !== [...sql].sort(cfOrder).join())
    problems.push("cf and readdir().sort() would apply these in different orders");
  return problems;
}

describe("migration file names", () => {
  for (const { dir, lastNumbered } of DIRECTORIES)
    test(`${dir} has unique, ordered prefixes`, () => {
      const files = readdirSync(fileURLToPath(new URL(dir, import.meta.url).href));
      expect(migrationProblems(files, lastNumbered)).toEqual([]);
    });

  test("refuses two files with the same prefix", () => {
    expect(
      migrationProblems(["20261003021500_ref_updates.sql", "20261003021500_other.sql"], 20),
    ).toEqual([
      "20261003021500_ref_updates.sql, 20261003021500_other.sql: share the prefix 20261003021500",
    ]);
    expect(migrationProblems(["0016_a.sql", "0016_b.sql"], 20)).toHaveLength(1);
    expect(
      migrationProblems(["0016_agent_capabilities.sql", "0016_knowledge_graph_version.sql"], 20),
    ).toEqual([]);
  });

  test("refuses new numbered names and malformed timestamps", () => {
    expect(migrationProblems(["0021_next.sql"], 20)).toHaveLength(1);
    expect(migrationProblems(["20261303021500_month_13.sql"], 20)).toHaveLength(1);
    expect(migrationProblems(["2026100302150_short.sql"], 20)).toHaveLength(1);
    expect(migrationProblems(["20261003021500_CamelCase.sql"], 20)).toHaveLength(1);
  });

  test("timestamps apply after the numbered files, in both orders", () => {
    const files = ["20261003021500_ref_updates.sql", "0020_last.sql", "0001_init.sql"];
    expect(migrationProblems(files, 20)).toEqual([]);
    expect([...files].sort(cfOrder)).toEqual([
      "0001_init.sql",
      "0020_last.sql",
      "20261003021500_ref_updates.sql",
    ]);
  });
});
