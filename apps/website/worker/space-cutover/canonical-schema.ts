import {
  createFencedD1TableStatements,
  d1CheckpointDependencyGroups,
  type D1CheckpointSchema,
} from "../../registry/core/space-migration.ts";

export type CanonicalStore = "application" | "registry";
type Table = D1CheckpointSchema["tables"][number];
type Entry = D1CheckpointSchema["schema"][number];
type Plan = {
  name?: string;
  rename?: Record<string, string>;
  drop?: string[];
  add?: Record<string, string>;
  scope?: boolean;
  content?: string[];
};
const scoped = {
  scope: true,
  drop: ["space_id"],
  rename: { account_id: "scope_id" },
} satisfies Plan;
const content = (column: string, target = "space_id"): Plan => ({
  rename: { [column]: target },
  drop: ["space_id"],
  content: [target],
});
const applicationPlans: Record<string, Plan> = {
  accounts: { drop: ["member_repo_role"] },
  organizations: { add: { avatar_key: "TEXT" } },
  repos: content("owner_id"),
  timeline_work_sources: { ...content("owner_id"), add: { authority: "TEXT" } },
  source_operations: content("owner_id"),
  timeline_source_migrations: content("owner_id"),
  tracker_preferences: content("owner_id"),
  tracker_repo_subscriptions: content("tracker_owner_id", "tracker_space_id"),
  repo_deletions: content("owner_id"),
  account_settings: { ...content("account_id"), name: "space_settings" },
  ai_providers: content("account_id"),
  atlas_spend: content("account_id"),
  atlas_spend_daily: content("account_id"),
  atlas_budget_exhaustions: content("account_id"),
  account_ai_log_bodies: { drop: ["space_id"] },
  usage_snapshots: scoped,
  usage_monthly: scoped,
  ai_usage: scoped,
  ai_usage_monthly: scoped,
  retention_policies: scoped,
  retention_policy_changes: scoped,
  cleanup_runs: { ...scoped, add: { authority: "TEXT" } },
  ci_runs: {
    add: { space_id: "TEXT REFERENCES spaces(id)", migration_epoch: "INTEGER", authority: "TEXT" },
  },
  deployments: { add: { authority: "TEXT" } },
  release_highlights: { drop: ["owner_account_id"], add: { authorization_binding: "TEXT" } },
  release_note_entries: {
    rename: { tracker_owner_id: "tracker_space_id", workspace_ids: "project_ids" },
  },
  commit_issue_mentions: { rename: { tracker_owner_id: "tracker_space_id" } },
  release_note_state: { add: { generation_binding: "TEXT", dirty_binding: "TEXT" } },
};

// Tokenize SQL rather than replacing words inside defaults, literals or comments.
const tokens =
  /--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|[^]/g;
const unquote = (value: string) => value.replace(/^["`[]|["`\]]$/g, "").replaceAll('""', '"');
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
function rewrite(sql: string, names: Record<string, string>): string {
  return sql.replace(tokens, (token) => {
    if (token.startsWith("--") || token.startsWith("/*")) return " ";
    if (token.startsWith("'")) return token;
    return names[unquote(token)] ?? token;
  });
}
function clauses(sql: string): { prefix: string; parts: string[]; suffix: string } {
  const start = sql.indexOf("(");
  if (start < 0) throw new Error("canonical_schema_table_sql");
  const parts: string[] = [];
  let depth = 1,
    offset = start + 1,
    end = -1;
  const rest = sql.slice(start + 1);
  for (const token of rest.matchAll(tokens)) {
    const at = start + 1 + token.index;
    if (token[0] === "(") depth++;
    if (token[0] === ")" && --depth === 0) {
      parts.push(sql.slice(offset, at).trim());
      end = at;
      break;
    }
    if (token[0] === "," && depth === 1) {
      parts.push(sql.slice(offset, at).trim());
      offset = at + 1;
    }
  }
  if (end < 0) throw new Error("canonical_schema_unclosed_table");
  return { prefix: sql.slice(0, start), parts, suffix: sql.slice(end + 1) };
}
function column(part: string): string | null {
  const first = part.match(/^(?:"(?:""|[^"])+"|`[^`]+`|\[[^\]]+\]|\w+)/)?.[0];
  if (!first || /^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)$/i.test(first)) return null;
  return unquote(first);
}
function transformTable(
  entry: Entry,
  table: Table,
  plan: Plan,
  store: CanonicalStore,
): { entry: Entry; table: Table } {
  const name = plan.name ?? table.name;
  const renames = { ...plan.rename, [table.name]: name };
  const parsed = clauses(rewrite(entry.sql, {}));
  const parts: string[] = [];
  for (const part of parsed.parts) {
    const old = column(part);
    if (old && plan.drop?.includes(old)) continue;
    let next = rewrite(part, renames);
    const current = old ? (plan.rename?.[old] ?? old) : null;
    if (plan.scope && current === "scope_id") next = "scope_id TEXT NOT NULL";
    if (current && plan.content?.includes(current)) {
      // The old owning FK must never retain an Account dependency. Other actor
      // references in this table remain untouched.
      const action = next.match(
        /\bREFERENCES\s+(?:accounts|"accounts")\s*\([^)]*\)(\s+ON\s+DELETE\s+(?:CASCADE|SET NULL|RESTRICT|NO ACTION))?/i,
      );
      next = action ? next.replace(action[0], "") : next;
      next = next.replace(/\bNOT\s+NULL\b/gi, "");
      next += table.name === "repo_deletions" ? "" : " NOT NULL";
      if (store === "application") next += ` REFERENCES spaces(id)${action?.[1] ?? ""}`;
    }
    if (plan.scope && old === null) next = rewrite(next, { scope_id: "scope_kind, scope_id" });
    if (table.name === "accounts" && current === "kind")
      next = "kind TEXT NOT NULL CHECK (kind = 'user')";
    parts.push(next);
  }
  const existing = new Set(parts.map(column));
  for (const [key, sql] of Object.entries(plan.add ?? {}))
    if (!existing.has(key)) parts.push(`${quote(key)} ${sql}`);
  if (plan.scope) {
    parts.push("scope_kind TEXT NOT NULL CHECK (scope_kind IN ('space', 'person', 'instance'))");
    parts.push(
      "CHECK ((scope_kind = 'instance' AND scope_id = '') OR (scope_kind IN ('space', 'person') AND length(scope_id) > 0))",
    );
  }
  if (table.name === "account_ai_log_bodies" && name === table.name)
    parts.push("CHECK (component IN ('assistant', 'assistant-titles', 'avatars'))");
  const ordered = [
    ...parts.filter((part) => column(part) !== null),
    ...parts.filter((part) => column(part) === null),
  ];
  const sql = `${rewrite(parsed.prefix, renames)}(${ordered.join(",\n")})${parsed.suffix}`;
  const columns = ordered.flatMap((part) => {
    const key = column(part);
    return key ? [key] : [];
  });
  const keys = table.keys.flatMap((key) => {
    if (plan.drop?.includes(key)) return [];
    if (plan.scope && key === "account_id") return ["scope_kind", "scope_id"];
    return [plan.rename?.[key] ?? key];
  });
  const structuralSql = sql.replace(tokens, (token) => (token.startsWith("'") ? "''" : token));
  const parents = [
    ...new Set(
      [...structuralSql.matchAll(/\bREFERENCES\s+("(?:""|[^"])+"|\w+)/gi)]
        .reverse()
        .map((match) => unquote(match[1]!)),
    ),
  ];
  return {
    entry: { ...entry, name, tbl_name: name, sql },
    table: { ...table, name, columns, keys, parents },
  };
}

/** Derive the exact v4 schema from the real migrated/checkpoint schema. No rows are read or changed. */
export function buildCanonicalD1Schema(
  source: D1CheckpointSchema,
  store: CanonicalStore,
): D1CheckpointSchema {
  const plans: Record<string, Plan> =
    store === "application" ? applicationPlans : { repositories: content("owner_id") };
  const schema: Entry[] = [];
  const tables: Table[] = [];
  for (const entry of source.schema) {
    if (
      store === "application" &&
      entry.type === "trigger" &&
      entry.name === "release_highlights_account_deleted"
    ) {
      schema.push({
        type: "trigger",
        name: "release_highlights_space_deleted",
        tbl_name: "spaces",
        sql: `CREATE TRIGGER release_highlights_space_deleted AFTER DELETE ON spaces BEGIN
  DELETE FROM release_highlights
  WHERE EXISTS (
    SELECT 1 FROM json_each(release_highlights.source_manifest) AS source
    WHERE json_extract(source.value, '$.spaceId') = OLD.id
       OR json_extract(source.value, '$.trackerSpaceId') = OLD.id
  );
END`,
      });
      continue;
    }
    if (store === "application" && entry.tbl_name === "org_members") continue;
    const plan = plans[entry.tbl_name];
    if (entry.type === "table") {
      const table = source.tables.find((value) => value.name === entry.name);
      if (!table) throw new Error(`canonical_schema_missing_metadata:${entry.name}`);
      if (plan) {
        const result = transformTable(entry, table, plan, store);
        schema.push(result.entry);
        tables.push(result.table);
      } else {
        schema.push({ ...entry });
        tables.push({
          ...table,
          columns: [...table.columns],
          keys: [...table.keys],
          parents: [...table.parents],
        });
      }
    } else if (plan) {
      const renamed: Record<string, string> = {
        ...plan.rename,
        [entry.tbl_name]: plan.name ?? entry.tbl_name,
      };
      if (plan.scope) renamed.account_id = "scope_kind, scope_id";
      const removed =
        plan.drop?.filter((key) => !Object.values(plan.rename ?? {}).includes(key)) ?? [];
      if (removed.some((key) => new RegExp(`\\b${key}\\b`).test(rewrite(entry.sql, {})))) continue;
      schema.push({
        ...entry,
        tbl_name: plan.name ?? entry.tbl_name,
        sql: rewrite(entry.sql, renamed),
      });
    } else schema.push({ ...entry });
  }
  if (store === "application") {
    const addClone = (from: string, plan: Plan, extra?: string) => {
      if (schema.some((entry) => entry.type === "table" && entry.name === plan.name)) return;
      const original = source.schema.find((entry) => entry.type === "table" && entry.name === from);
      const metadata = source.tables.find((table) => table.name === from);
      if (!original || !metadata) throw new Error(`canonical_schema_missing_template:${from}`);
      const result = transformTable(original, metadata, plan, store);
      if (extra) {
        const parsed = clauses(result.entry.sql);
        result.entry.sql = `${parsed.prefix}(${[...parsed.parts, extra].join(",\n")})${parsed.suffix}`;
      }
      schema.push(result.entry);
      tables.push(result.table);
    };
    addClone("avatar_generations", {
      name: "organization_avatar_generations",
      rename: { user_id: "organization_id", accounts: "organizations" },
    });
    // Clone before the personal-only CHECK is installed by the normal plan.
    addClone(
      "account_ai_log_bodies",
      { ...content("account_id"), name: "space_ai_log_bodies" },
      "CHECK (component IN ('knowledge', 'release-notes', 'merge-queue'))",
    );
  }
  schema.sort((a, b) =>
    a.type < b.type ? -1 : a.type > b.type ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  tables.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const sequence = source.tables.find((table) => table.name === "sqlite_sequence");
  if (sequence)
    tables.push({
      ...sequence,
      columns: [...sequence.columns],
      keys: [...sequence.keys],
      parents: [],
    });
  return { kind: "schema", storeId: source.storeId, schema, tables };
}

export interface CanonicalEmptyStoreState {
  phase: "check" | "drop" | "create" | "objects" | "done";
  index: number;
}

// Ordinary migrations seed these Instance-only records. Their physical tables,
// rows and indexes remain untouched; this is not an exemption for tenant data.
const freshPreservedTables: Record<string, Readonly<Record<string, true>>> = {
  application: {
    cloudflare_price_changes: true,
    cloudflare_prices: true,
    environment_limits: true,
  },
  registry: { artifact_backfill: true },
};
/** One bounded, replay-safe step. Caller durably retains source/schema and this cursor,
 * supplies an independently fenced database, and MUST complete before seeding. */
export async function initializeCanonicalEmptyStoreStep(
  db: D1Database,
  source: D1CheckpointSchema,
  target: D1CheckpointSchema,
  previous: CanonicalEmptyStoreState | null,
): Promise<{ state: CanonicalEmptyStoreState; done: boolean }> {
  const state = previous ?? { phase: "check", index: 0 };
  const preserved: Readonly<Record<string, true>> = {
    d1_migrations: true,
    sqlite_sequence: true,
    ...freshPreservedTables[source.storeId],
  };
  for (const entry of source.schema) {
    if (!preserved[entry.tbl_name]) continue;
    const matching = target.schema.find(
      (candidate) => candidate.type === entry.type && candidate.name === entry.name,
    );
    if (!matching || matching.tbl_name !== entry.tbl_name || matching.sql !== entry.sql) {
      throw new Error(`fresh_install_preserved_schema_changed:${entry.name}`);
    }
  }
  for (const entry of target.schema) {
    if (
      preserved[entry.tbl_name] &&
      !source.schema.some(
        (candidate) => candidate.type === entry.type && candidate.name === entry.name,
      )
    ) {
      throw new Error(`fresh_install_preserved_schema_changed:${entry.name}`);
    }
  }
  const businessTables = source.tables.filter((table) => !preserved[table.name]);
  const result = (phase: CanonicalEmptyStoreState["phase"], index: number) => ({
    state: { phase, index },
    done: phase === "done",
  });
  if (state.phase === "done") return result("done", 0);
  if (state.phase === "check") {
    const table = businessTables[state.index];
    if (!table) return result("drop", 0);
    if (await db.prepare(`SELECT 1 AS present FROM ${quote(table.name)} LIMIT 1`).first())
      throw new Error(`fresh_install_nonempty:${table.name}`);
    return result("check", state.index + 1);
  }
  if (state.phase === "drop") {
    const group = d1CheckpointDependencyGroups(
      businessTables.map((table) => ({
        ...table,
        parents: table.parents.filter((parent) => !preserved[parent]),
      })),
    ).reverse()[state.index];
    if (!group) return result("create", 0);
    if (group.length > 32) throw new Error("fresh_install_schema_cycle_too_large");
    await db.batch([
      db.prepare("PRAGMA defer_foreign_keys = ON"),
      ...group.map((table) => db.prepare(`DROP TABLE IF EXISTS ${quote(table.name)}`)),
    ]);
    return result("drop", state.index + 1);
  }
  if (state.phase === "create") {
    const table = target.schema.filter((entry) => entry.type === "table" && !preserved[entry.name])[
      state.index
    ];
    if (!table) return result("objects", 0);
    const existing = await db
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .bind(table.name)
      .first<{ sql: string }>();
    if (existing) {
      if (existing.sql !== table.sql)
        throw new Error(`fresh_install_schema_conflict:${table.name}`);
      const fences = await db
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ? AND name IN (?, ?, ?)",
        )
        .bind(
          table.name,
          `_space_cutover_write_${table.name}_insert`,
          `_space_cutover_write_${table.name}_update`,
          `_space_cutover_write_${table.name}_delete`,
        )
        .first<{ count: number }>();
      if (fences?.count !== 3) throw new Error(`fresh_install_missing_fence:${table.name}`);
    } else {
      await db.batch(createFencedD1TableStatements(db, table.name, table.sql));
    }
    return result("create", state.index + 1);
  }
  const entry = target.schema.filter(
    (value) => value.type !== "table" && !preserved[value.tbl_name],
  )[state.index];
  if (!entry) return result("done", 0);
  const existing = await db
    .prepare("SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?")
    .bind(entry.type, entry.name)
    .first<{ sql: string }>();
  if (!existing) await db.batch([db.prepare(entry.sql)]);
  else if (existing.sql !== entry.sql)
    throw new Error(`fresh_install_schema_conflict:${entry.name}`);
  return result("objects", state.index + 1);
}
