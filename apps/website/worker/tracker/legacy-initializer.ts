import { TIMELINE_TABLES, type SqlDatabase } from "./sql.ts";
import { RETENTION_TABLES } from "./retention.ts";
import { initializeAudit } from "./audit.ts";
import { initializeTrackerMigrationProof } from "./space-migration.ts";

/** Only called after independent migration/recovery approval, never from the live Store. */
export function initializeLegacyTrackerForMigration(
  sql: SqlDatabase,
  transaction: <T>(fn: () => T) => T,
): void {
  if (
    sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*' AND name NOT GLOB '__miniflare_*' AND name <> 'sqlite_sequence'",
      )
      .toArray().length
  )
    throw new Error(
      "space_migration_fenced: legacy initialization requires an untouched participant",
    );
  transaction(() => {
    sql.exec(TIMELINE_TABLES);
    sql.exec(`CREATE TABLE teams (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE issues (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE tracker_labels (name TEXT PRIMARY KEY);
      CREATE TABLE links (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE comments (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE requests (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE subscriptions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE team_numbers (id TEXT PRIMARY KEY, number INTEGER NOT NULL);
      CREATE TABLE leases (issue_id TEXT PRIMARY KEY, token TEXT NOT NULL);
      CREATE TABLE offers (issue_id TEXT PRIMARY KEY, code TEXT NOT NULL, lease_token TEXT NOT NULL, to_actor TEXT, expires_at TEXT NOT NULL);
      CREATE TABLE receipts (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE approval_automation (person_id TEXT PRIMARY KEY, enabled_at TEXT NOT NULL);
      CREATE TABLE events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
      CREATE UNIQUE INDEX team_keys ON teams(json_extract(data, '$.key'));
      CREATE UNIQUE INDEX workspace_slugs ON workspaces(json_extract(data, '$.slug'));
      CREATE INDEX blockers ON links(json_extract(data, '$.toId'), json_extract(data, '$.kind'));
      CREATE INDEX subscriptions_repo ON subscriptions(json_extract(data, '$.repoId'));
      CREATE INDEX parents ON issues(json_extract(data, '$.parentId'));
      CREATE INDEX request_issues ON requests(json_extract(data, '$.issueId'));
      CREATE INDEX issue_keys ON issues(json_extract(data, '$.key'));
      CREATE INDEX issue_completions ON issues(json_extract(data, '$.completion.at'));
      CREATE INDEX comment_issues ON comments(json_extract(data, '$.issueId'));
      CREATE INDEX event_entities ON events(json_extract(data, '$.entityId'));
      CREATE INDEX event_times ON events(json_extract(data, '$.createdAt'));
      CREATE INDEX event_timelines ON events(json_extract(data, '$.timelineId'));`);
    sql.exec(RETENTION_TABLES);
    initializeTrackerMigrationProof(sql);
    initializeAudit(sql, transaction);
    // A legacy store's own starts record these; an empty one has nothing to backfill (CORE-220).
    sql.exec(
      "INSERT OR IGNORE INTO tracker_migrations(name) VALUES('labels-v1'),('completion-v1')",
    );
  });
}
