import { describe, expect, it } from "vite-plus/test";
import type { D1CheckpointSchema } from "../../registry/core/space-migration.ts";
import { buildCanonicalD1Schema } from "./canonical-schema.ts";

function fixture(
  definitions: Record<string, { sql: string; columns: string[]; parents?: string[] }>,
  application = true,
): D1CheckpointSchema {
  const all = {
    ...(application
      ? {
          avatar_generations: {
            sql: "CREATE TABLE avatar_generations (user_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK (status IN ('generating','ready','failed')), options TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), finished_at TEXT)",
            columns: ["user_id", "status", "options", "created_at", "finished_at"],
            parents: ["accounts"],
          },
          account_ai_log_bodies: {
            sql: "CREATE TABLE account_ai_log_bodies (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, component TEXT NOT NULL, keep INTEGER NOT NULL, updated_by TEXT REFERENCES accounts(id), updated_at TEXT NOT NULL, space_id TEXT REFERENCES spaces(id), PRIMARY KEY(account_id,component))",
            columns: ["account_id", "component", "keep", "updated_by", "updated_at", "space_id"],
            parents: ["accounts", "spaces"],
          },
        }
      : {}),
    ...definitions,
  };
  return {
    kind: "schema",
    storeId: application ? "application" : "registry",
    schema: Object.entries(all).map(([name, table]) => ({
      type: "table",
      name,
      tbl_name: name,
      sql: table.sql,
    })),
    tables: Object.entries(all).map(([name, table]) => ({
      name,
      columns: table.columns,
      parents: table.parents ?? [],
      keys: ["_rowid_"],
      rowid: true,
    })),
  };
}

describe("canonical D1 definitions", () => {
  it("removes the real Account FK and legacy ownership, preserving opaque defaults and uniqueness", () => {
    const source = fixture({
      repos: {
        sql: "CREATE TABLE repos (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES accounts(id), name TEXT NOT NULL COLLATE NOCASE, description TEXT DEFAULT 'owner_id, accounts(x)', space_id TEXT REFERENCES spaces(id), UNIQUE(owner_id,name))",
        columns: ["id", "owner_id", "name", "description", "space_id"],
        parents: ["accounts", "spaces"],
      },
    });
    const target = buildCanonicalD1Schema(source, "application");
    const sql = target.schema.find((entry) => entry.name === "repos")!.sql;
    expect(sql).toContain("space_id TEXT");
    expect(sql).toContain("NOT NULL REFERENCES spaces(id)");
    expect(sql).toContain("UNIQUE(space_id,name)");
    expect(sql).toContain("'owner_id, accounts(x)'");
    expect(target.tables.find((table) => table.name === "repos")).toEqual({
      name: "repos",
      columns: ["id", "space_id", "name", "description"],
      parents: ["spaces"],
      keys: ["_rowid_"],
      rowid: true,
    });
    expect(source.tables.find((table) => table.name === "repos")!.columns).toContain("owner_id");
  });

  it("splits personal logs and Organization avatar history without changing the personal table", () => {
    const target = buildCanonicalD1Schema(fixture({}), "application");
    expect(target.schema.find((entry) => entry.name === "account_ai_log_bodies")!.sql).toContain(
      "'assistant', 'assistant-titles', 'avatars'",
    );
    const logs = target.schema.find((entry) => entry.name === "space_ai_log_bodies")!.sql;
    expect(logs).toContain("'knowledge', 'release-notes', 'merge-queue'");
    expect(logs).not.toContain("'assistant'");
    expect(
      target.tables.find((table) => table.name === "organization_avatar_generations")!.parents,
    ).toEqual(["organizations"]);
    expect(target.tables.find((table) => table.name === "avatar_generations")!.columns[0]).toBe(
      "user_id",
    );
  });

  it("keeps CORE-222 attribution columns in the scoped ai_usage key", () => {
    // The live table as 20261011145706 rebuilt it, plus the additive Space column.
    const target = buildCanonicalD1Schema(
      fixture({
        ai_usage: {
          sql: "CREATE TABLE ai_usage (day TEXT NOT NULL, account_id TEXT NOT NULL, feature TEXT NOT NULL, model TEXT NOT NULL, actor_id TEXT NOT NULL DEFAULT '', agent_id TEXT NOT NULL DEFAULT '', timeline TEXT NOT NULL DEFAULT '', calls INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0, failed_calls INTEGER NOT NULL DEFAULT 0, space_id TEXT REFERENCES spaces(id), PRIMARY KEY (day, account_id, feature, model, actor_id, agent_id, timeline))",
          columns: [
            "day",
            "account_id",
            "feature",
            "model",
            "actor_id",
            "agent_id",
            "timeline",
            "calls",
            "input_tokens",
            "output_tokens",
            "total_tokens",
            "failed_calls",
            "space_id",
          ],
          parents: ["spaces"],
        },
      }),
      "application",
    );
    const sql = target.schema.find((entry) => entry.name === "ai_usage")!.sql;
    expect(sql).toContain(
      "PRIMARY KEY (day, scope_kind, scope_id, feature, model, actor_id, agent_id, timeline)",
    );
    expect(sql).toContain("actor_id TEXT NOT NULL DEFAULT ''");
    const columns = target.tables.find((table) => table.name === "ai_usage")!.columns;
    expect(columns).toEqual(expect.arrayContaining(["scope_kind", "scope_id", "timeline"]));
    expect(columns).not.toContain("account_id");
    expect(columns).not.toContain("space_id");
  });

  it("makes mixed ownership explicit in primary keys and removes additive Space authority", () => {
    const source = fixture({
      usage_snapshots: {
        sql: "CREATE TABLE usage_snapshots (day TEXT NOT NULL, account_id TEXT NOT NULL, metric TEXT NOT NULL, space_id TEXT REFERENCES spaces(id), PRIMARY KEY(day,account_id,metric))",
        columns: ["day", "account_id", "metric", "space_id"],
        parents: ["spaces"],
      },
    });
    source.schema.push({
      type: "index",
      name: "usage_account",
      tbl_name: "usage_snapshots",
      sql: "CREATE INDEX usage_account ON usage_snapshots(account_id,day)",
    });
    const target = buildCanonicalD1Schema(source, "application");
    const sql = target.schema.find((entry) => entry.name === "usage_snapshots")!.sql;
    expect(sql).toContain("PRIMARY KEY(day,scope_kind, scope_id,metric)");
    expect(sql).toContain("scope_kind = 'instance' AND scope_id = ''");
    expect(sql.indexOf("scope_kind TEXT")).toBeLessThan(sql.indexOf("PRIMARY KEY"));
    expect(target.tables.find((table) => table.name === "usage_snapshots")!.columns).not.toContain(
      "space_id",
    );
    expect(target.schema.find((entry) => entry.name === "usage_account")!.sql).toContain(
      "(scope_kind, scope_id,day)",
    );
  });

  it("keeps unknown orphan deletion scope nullable and adds nullable deployment authority", () => {
    const target = buildCanonicalD1Schema(
      fixture({
        repo_deletions: {
          sql: "CREATE TABLE repo_deletions (repo_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, space_id TEXT REFERENCES spaces(id))",
          columns: ["repo_id", "owner_id", "space_id"],
        },
        deployments: {
          sql: "CREATE TABLE deployments (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id TEXT NOT NULL)",
          columns: ["id", "repo_id"],
        },
      }),
      "application",
    );
    expect(target.schema.find((entry) => entry.name === "repo_deletions")!.sql).not.toContain(
      "NOT NULL",
    );
    expect(target.schema.find((entry) => entry.name === "deployments")!.sql).toContain(
      '"authority" TEXT',
    );
  });

  it("makes registry feed ownership nonnull without an impossible cross-D1 FK", () => {
    const target = buildCanonicalD1Schema(
      fixture(
        {
          repositories: {
            sql: "CREATE TABLE repositories (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, space_id TEXT, key TEXT NOT NULL UNIQUE)",
            columns: ["id", "owner_id", "space_id", "key"],
          },
        },
        false,
      ),
      "registry",
    );
    expect(target.tables[0]!.columns).toEqual(["id", "space_id", "key"]);
    expect(target.schema[0]!.sql).not.toContain("owner_id");
    expect(target.schema[0]!.sql).not.toContain("REFERENCES");
    expect(target.schema[0]!.sql).toContain("NOT NULL");
  });

  it("removes organization-account structures and reproduces discovery ordering", () => {
    const source = fixture({
      accounts: {
        sql: "CREATE TABLE accounts (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('user','org')), member_repo_role TEXT)",
        columns: ["id", "kind", "member_repo_role"],
      },
      org_members: {
        sql: "CREATE TABLE org_members (org_id TEXT, user_id TEXT)",
        columns: ["org_id", "user_id"],
      },
      account_settings: {
        sql: "CREATE TABLE account_settings (account_id TEXT PRIMARY KEY REFERENCES accounts(id), updated_by TEXT REFERENCES accounts(id), space_id TEXT REFERENCES spaces(id))",
        columns: ["account_id", "updated_by", "space_id"],
        parents: ["spaces", "accounts"],
      },
    });
    source.tables.push({
      name: "sqlite_sequence",
      columns: ["name", "seq"],
      keys: ["_rowid_"],
      rowid: true,
      parents: [],
    });
    const target = buildCanonicalD1Schema(source, "application");
    expect(target.schema.find((entry) => entry.name === "accounts")!.sql).toContain(
      "CHECK (kind = 'user')",
    );
    expect(target.tables.find((table) => table.name === "accounts")!.columns).not.toContain(
      "member_repo_role",
    );
    expect(
      target.tables.some(
        (table) => table.name === "org_members" || table.name === "account_settings",
      ),
    ).toBe(false);
    expect(target.tables.find((table) => table.name === "space_settings")!.parents).toEqual([
      "accounts",
      "spaces",
    ]);
    expect(target.tables.at(-1)!.name).toBe("sqlite_sequence");
    const names = target.tables.slice(0, -1).map((table) => table.name);
    expect(names).toEqual([...names].sort());
  });
});
