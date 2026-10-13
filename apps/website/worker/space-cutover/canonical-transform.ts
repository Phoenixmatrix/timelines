import {
  canonicalSpaceJson,
  spaceDigest,
  type SpaceManifest,
  type SpaceMigrationContext,
} from "../../shared/space-cutover.ts";
import {
  ROWS_PER_BLOCK,
  readBlock,
  encodeD1CheckpointPage,
  type ArchiveRows,
  type D1CheckpointInspection,
  type D1CheckpointSchema,
  type SpaceCheckpointReader,
  type SpaceMigrationStep,
} from "../../registry/core/space-migration.ts";
import { buildCanonicalD1Schema } from "./canonical-schema.ts";
import { parseQuery } from "../../shared/tracker-query.ts";
import { CATEGORIES } from "../retention/categories.ts";

function fail(detail: string): never {
  throw new Error(`space_canonical_export_required: ${detail}`);
}
export function checkpointText(value: string): string | null {
  if (value === "NULL") return null;
  const match = /^CAST\(X'([0-9A-F]*)' AS TEXT\)$/i.exec(value);
  if (!match) return fail("expected archived text");
  const hex = match[1]!;
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    Uint8Array.from({ length: hex.length / 2 }, (_, i) =>
      Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16),
    ),
  );
}
export function checkpointTextValue(value: string): string {
  return `CAST(X'${Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .toUpperCase()}' AS TEXT)`;
}
export function canonicalPreferenceQuery(query: string): string {
  const converted = query.replace(/(-?[A-Za-z]+:)?"[^"]*"|\S+/g, (token) =>
    token.replace(/^("?)(-?)(workspace|ws):/i, "$1$2project:"),
  );
  if (parseQuery(converted).unknown.length) fail("unknown saved Tracker filter");
  return converted;
}
const contentLogs: Record<string, true> = {
  knowledge: true,
  "release-notes": true,
  "merge-queue": true,
};
const personalLogs: Record<string, true> = {
  assistant: true,
  "assistant-titles": true,
  avatars: true,
};
const scoped: Record<string, true> = {
  usage_snapshots: true,
  usage_monthly: true,
  ai_usage: true,
  ai_usage_monthly: true,
  retention_policies: true,
  retention_policy_changes: true,
  cleanup_runs: true,
};
const sourceNames: Record<string, string> = {
  space_settings: "account_settings",
  space_ai_log_bodies: "account_ai_log_bodies",
  organization_avatar_generations: "avatar_generations",
};

export interface CanonicalTransformState {
  binding: string;
  phase: "evidence" | "schema" | "rows" | "done";
  evidenceIndex: number;
  sourceCursor: string | null;
  sourceDigest: string;
  people: string[];
  organizationAvatars: Record<string, string>;
  cleanupScopes: Record<string, string[]>;
  cleanupPending: ArchiveRows | null;
  cleanupCursor: string | null;
  cleanupDigest: string;
  table: number;
  offset: number;
  buffered: string[][];
  sourceDone: boolean;
  output: D1CheckpointSchema | ArchiveRows | null;
  cursor: string | null;
  digest: string;
  counts: Record<string, number>;
}
export interface CanonicalTransformResult {
  digest: string;
  counts: Record<string, number>;
  sourceDigest: string;
  invalidations: {
    table: "release_highlights";
    rows: number;
    reason: "legacy_projection_requires_current_v4_authority";
  }[];
}
type Evidence = Pick<CanonicalTransformState, "people" | "organizationAvatars" | "cleanupScopes">;

function knownObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    fail("unknown frozen timeline DTO");
  return value as Record<string, unknown>;
}
function sourceDescriptor(value: unknown, repoId: string, snapshot: boolean): void {
  const keys = ["sourceId", "repoId", "kind", "timelineId", "ref"];
  const source = knownObject(value, [...keys, "commit", "tree"]);
  if (
    (snapshot || source.commit !== undefined || source.tree !== undefined) &&
    (typeof source.commit !== "string" || typeof source.tree !== "string")
  )
    fail("invalid frozen source snapshot");
  if (
    keys.some((key) => key !== "timelineId" && typeof source[key] !== "string") ||
    source.repoId !== repoId ||
    (source.timelineId !== null && typeof source.timelineId !== "string") ||
    !["canonical", "timeline-work", "canonical-historical"].includes(String(source.kind))
  )
    fail("invalid frozen source descriptor");
}
function sourceDependencies(value: unknown, repoId: string): void {
  if (!Array.isArray(value)) fail("invalid frozen source dependencies");
  for (const entry of value) {
    const dependency = knownObject(entry, ["source", "base"]);
    sourceDescriptor(dependency.source, repoId, true);
    sourceDescriptor(dependency.base, repoId, true);
  }
}
/** Contextual DTO conversion, never a recursive owner-key replacement. */
export function canonicalTimelineMigrationJson(
  value: string,
  field: "input" | "output",
  spaceId: string,
  manifest: SpaceManifest,
): string {
  const mapping = manifest.mapping.find((entry) => entry.space.id === spaceId);
  if (!mapping) fail("unmapped frozen timeline Space");
  let rows: unknown;
  try {
    rows = JSON.parse(value);
  } catch {
    fail("invalid frozen timeline JSON");
  }
  if (!Array.isArray(rows)) fail("invalid frozen timeline list");
  for (const value of rows) {
    const frozen =
      field === "input" ? knownObject(value, ["entry", "head", "base", "dependencies"]) : null;
    const entry = knownObject(frozen ? frozen.entry : value, [
      "id",
      "owner",
      "space",
      "name",
      "bookmark",
      "source",
      "logicalBase",
      "dependencies",
    ]);
    if (
      typeof entry.id !== "string" ||
      typeof entry.name !== "string" ||
      typeof entry.bookmark !== "string" ||
      !mapping.repositories.some((repo) => repo.id === entry.id && repo.name === entry.name)
    )
      fail("unmapped frozen timeline repository");
    if (Object.hasOwn(entry, "owner")) {
      if (entry.owner !== mapping.legacyOwner.slug || Object.hasOwn(entry, "space"))
        fail("conflicting frozen timeline locator");
      entry.space = mapping.space.slug;
      delete entry.owner;
    } else if (entry.space !== mapping.space.slug) fail("unknown frozen timeline locator");
    if (entry.source !== undefined) sourceDescriptor(entry.source, entry.id, false);
    if (entry.logicalBase !== undefined) sourceDescriptor(entry.logicalBase, entry.id, true);
    if (entry.dependencies !== undefined) sourceDependencies(entry.dependencies, entry.id);
    if (frozen) {
      sourceDescriptor(frozen.head, entry.id, true);
      sourceDescriptor(frozen.base, entry.id, true);
      sourceDependencies(frozen.dependencies, entry.id);
    }
  }
  return JSON.stringify(rows);
}

/** Only explicitly changed cells are decoded. Opaque provider/history cells remain exact SQL literals. */
export function canonicalCheckpointRow(
  target: string,
  source: string,
  columns: string[],
  values: string[],
  targetColumns: string[],
  manifest: SpaceManifest,
  evidence: Evidence,
): string[] | null {
  const row = Object.fromEntries(columns.map((column, index) => [column, values[index]!]));
  const text = (column: string) => checkpointText(row[column] ?? "NULL");
  const owner = (id: string | null) =>
    manifest.mapping.find((mapping) => mapping.legacyOwner.id === id);
  if (source === "accounts" && text("kind") === "org") return null;
  if (source === "avatar_generations") {
    const mapping = owner(text("user_id"));
    if (target === "organization_avatar_generations") {
      if (mapping?.legacyOwner.kind !== "org") return null;
      row.organization_id = checkpointTextValue(mapping.organization.id);
    } else if (mapping?.legacyOwner.kind === "org") return null;
  }
  if (source === "organizations")
    row.avatar_key = evidence.organizationAvatars[text("id") ?? ""] ?? row.avatar_key ?? "NULL";
  if (source === "account_ai_log_bodies") {
    const component = text("component");
    if (!component || (contentLogs[component] !== true && personalLogs[component] !== true))
      fail("unknown AI log component");
    if (
      target === "space_ai_log_bodies"
        ? contentLogs[component] !== true
        : personalLogs[component] !== true
    )
      return null;
    if (target === "account_ai_log_bodies" && !evidence.people.includes(text("account_id") ?? ""))
      fail("organization personal AI log");
  }
  if (source === "release_highlights") {
    // Site and repository summaries were deleted by 20261011152915 (CORE-359)
    // and are never written again; one appearing is unexplained, not mappable.
    if (text("scope") !== "tracker") fail("non-Tracker release highlights");
    const mapped = owner(text("owner_account_id"));
    if (!mapped || text("space_id") !== mapped.space.id) fail("unmapped release highlights");
    // These are credential-bound derived projections, not release history.
    // Their original bytes remain in both immutable input archives.
    Object.assign(row, {
      source_hash: checkpointTextValue(""),
      source_manifest: checkpointTextValue("[]"),
      body: checkpointTextValue(""),
      model: "NULL",
      status: checkpointTextValue("idle"),
      error: "NULL",
      generated_at: "NULL",
      due_at: "0",
      lease_id: "NULL",
      lease_until: "0",
      ai_snapshot: "NULL",
      authorization_binding: "NULL",
    });
  }
  if (
    source === "tracker_repo_subscriptions" ||
    source === "release_note_entries" ||
    source === "commit_issue_mentions"
  )
    row.tracker_space_id =
      row.space_id && row.space_id !== "NULL" ? row.space_id : row.tracker_owner_id!;
  if (source === "release_note_entries") row.project_ids = row.workspace_ids!;
  if (source === "tracker_preferences")
    row.query = checkpointTextValue(canonicalPreferenceQuery(text("query") ?? ""));
  if (source === "do_instances" && row.space_id && row.space_id !== "NULL") row.account_id = "NULL";
  if (
    source === "do_instances" &&
    text("account_id") &&
    !evidence.people.includes(text("account_id")!)
  )
    fail("non-person Durable Object ownership");
  if (source === "sqlite_sequence" && text("name") === "account_settings")
    row.name = checkpointTextValue("space_settings");
  if (scoped[source] === true) {
    const account = text("account_id");
    const space = text("space_id");
    if (source === "cleanup_runs") {
      const scopes = evidence.cleanupScopes[row.id!] ?? [];
      if (scopes.length !== 1) fail("ambiguous cleanup history");
      if (account && (scopes[0] === "space") !== Boolean(space)) fail("cleanup scope mismatch");
    }
    if (space) {
      row.scope_kind = checkpointTextValue("space");
      row.scope_id = row.space_id!;
    } else if (account) {
      if (!evidence.people.includes(account)) fail(`non-person historical scope in ${source}`);
      row.scope_kind = checkpointTextValue("person");
      row.scope_id = row.account_id!;
    } else {
      row.scope_kind = checkpointTextValue("instance");
      row.scope_id = checkpointTextValue("");
    }
  }
  const legacyContentColumn = (
    {
      repos: "owner_id",
      repositories: "owner_id",
      feeds: "owner_id",
      timeline_work_sources: "owner_id",
      source_operations: "owner_id",
      timeline_source_migrations: "owner_id",
      tracker_preferences: "owner_id",
      repo_deletions: "owner_id",
      account_settings: "account_id",
      ai_providers: "account_id",
      atlas_spend: "account_id",
      atlas_spend_daily: "account_id",
      atlas_budget_exhaustions: "account_id",
    } as Record<string, string>
  )[source];
  if (
    legacyContentColumn &&
    targetColumns.includes("space_id") &&
    !(
      source === "repo_deletions" &&
      text(legacyContentColumn) === null &&
      text("space_id") === null
    )
  ) {
    const mapped = owner(text(legacyContentColumn));
    if (!mapped || text("space_id") !== mapped.space.id) fail(`unmapped ${source}`);
  }
  if (target === "space_ai_log_bodies" && !text("space_id")) fail("unmapped content AI log");
  if (source === "timeline_source_migrations") {
    const spaceId = text("space_id");
    if (!spaceId) fail("unmapped frozen timeline");
    for (const field of ["input", "output"] as const) {
      const value = text(field);
      if (value !== null)
        row[field] = checkpointTextValue(
          canonicalTimelineMigrationJson(value, field, spaceId, manifest),
        );
      else if (field === "input") fail("missing frozen timeline input");
    }
  }
  return targetColumns.map((column) => {
    if (Object.hasOwn(row, column)) return row[column]!;
    if (
      [
        "authority",
        "migration_epoch",
        "generation_binding",
        "dirty_binding",
        "authorization_binding",
        "avatar_key",
        "space_id",
      ].includes(column)
    )
      return "NULL";
    return fail(`unmapped column ${target}.${column}`);
  });
}

/** One source block or one output fragment per call. The caller journals state
 * only after persisting the emitted page immutably. Original and mapped archives are never mutated. */
export async function transformCanonicalCheckpointStep(
  context: SpaceMigrationContext,
  manifest: SpaceManifest,
  source: D1CheckpointInspection,
  readSourcePage: SpaceCheckpointReader,
  previous: CanonicalTransformState | null,
): Promise<SpaceMigrationStep<CanonicalTransformState, CanonicalTransformResult>> {
  const store = source.schema.storeId;
  if (store !== "application" && store !== "registry") fail("unknown canonical store");
  const binding = await spaceDigest(
    canonicalSpaceJson({ context, manifest, source: source.digest }),
  );
  if (previous && previous.binding !== binding) fail("archive transformation binding mismatch");
  const state: CanonicalTransformState = previous
    ? {
        ...previous,
        counts: { ...previous.counts },
        organizationAvatars: { ...previous.organizationAvatars },
        cleanupScopes: Object.fromEntries(
          Object.entries(previous.cleanupScopes).map(([id, scopes]) => [id, [...scopes]]),
        ),
        buffered: [...previous.buffered],
      }
    : {
        binding,
        phase: "evidence",
        evidenceIndex: 0,
        sourceCursor: null,
        sourceDigest: "",
        people: manifest.mapping
          .filter((mapping) => mapping.legacyOwner.kind === "user")
          .map((mapping) => mapping.legacyOwner.id),
        organizationAvatars: {},
        cleanupScopes: {},
        cleanupPending: null,
        cleanupCursor: null,
        cleanupDigest: "",
        table: 0,
        offset: 0,
        buffered: [],
        sourceDone: false,
        output: null,
        cursor: null,
        digest: "",
        counts: {},
      };
  const schema = buildCanonicalD1Schema(source.schema, store);
  if (state.phase === "done")
    return {
      state,
      done: true,
      result: {
        digest: state.digest,
        counts: state.counts,
        sourceDigest: source.digest,
        invalidations: state.counts.release_highlights
          ? [
              {
                table: "release_highlights",
                rows: state.counts.release_highlights,
                reason: "legacy_projection_requires_current_v4_authority",
              },
            ]
          : [],
      },
    };
  if (state.phase === "evidence") {
    const name = ["accounts"][state.evidenceIndex];
    const range = name ? source.tableRanges[name] : undefined;
    if (!name) {
      state.phase = "schema";
      state.output = schema;
      return { state, done: false };
    }
    if (!range) {
      state.evidenceIndex++;
      return { state, done: false };
    }
    const block = await readBlock(
      context,
      store,
      readSourcePage,
      state.sourceCursor ?? range.cursor,
      state.sourceCursor === null ? range.beforeDigest : state.sourceDigest,
      source.schema,
    );
    if (block.block.kind !== "rows" || block.block.table !== name) fail("evidence table mismatch");
    for (const cells of block.block.rows) {
      const row = Object.fromEntries(
        block.block.columns.map((column, index) => [column, cells[index]!]),
      );
      if (name === "accounts") {
        const id = checkpointText(row.id!);
        const kind = checkpointText(row.kind!);
        if (!id || (kind !== "user" && kind !== "org")) fail("unknown Account kind");
        if (kind === "user") {
          if (!state.people.includes(id)) fail("unmapped person identity");
        } else {
          const mapping = manifest.mapping.find(
            (item) => item.legacyOwner.id === id && item.legacyOwner.kind === "org",
          );
          if (!mapping) fail("unmapped Organization avatar");
          const priorAvatar = state.organizationAvatars[mapping.organization.id];
          if (priorAvatar !== undefined && priorAvatar !== (row.avatar_key ?? "NULL"))
            fail("conflicting Organization avatars");
          state.organizationAvatars[mapping.organization.id] = row.avatar_key ?? "NULL";
        }
      }
    }
    const nextTable =
      block.nextCursor === null ? null : (JSON.parse(block.nextCursor).table as number);
    if (nextTable === null || source.schema.tables[nextTable]?.name !== name) {
      if (block.digest !== range.afterDigest) fail("evidence digest mismatch");
      state.evidenceIndex++;
      state.sourceCursor = null;
      state.sourceDigest = "";
    } else {
      state.sourceCursor = block.nextCursor;
      state.sourceDigest = block.digest;
    }
    return { state, done: false };
  }
  if (state.output) {
    const { page } = await encodeD1CheckpointPage(context, state.cursor, state.output, schema);
    state.digest = await spaceDigest(`${state.digest}:${page.digest}`);
    state.cursor = page.nextCursor;
    const position =
      page.nextCursor === null
        ? null
        : (JSON.parse(page.nextCursor) as { table: number; offset: number; fragment: number });
    if (!position || position.fragment === 0) {
      if (state.output.kind === "schema") state.phase = "rows";
      else {
        state.counts[state.output.table] =
          (state.counts[state.output.table] ?? 0) + state.output.rows.length;
        if (state.output.rows.length < ROWS_PER_BLOCK) {
          state.table++;
          state.offset = 0;
          state.sourceCursor = null;
          state.sourceDigest = "";
          state.sourceDone = false;
        } else state.offset += ROWS_PER_BLOCK;
      }
      state.output = null;
    }
    if (page.nextCursor === null) {
      state.phase = "done";
      return {
        state,
        page,
        done: true,
        result: {
          digest: state.digest,
          counts: state.counts,
          sourceDigest: source.digest,
          invalidations: state.counts.release_highlights
            ? [
                {
                  table: "release_highlights",
                  rows: state.counts.release_highlights,
                  reason: "legacy_projection_requires_current_v4_authority",
                },
              ]
            : [],
        },
      };
    }
    return { state, page, done: false };
  }
  const table = schema.tables[state.table];
  if (!table) fail("target archive table overflow");
  const name = sourceNames[table.name] ?? table.name;
  const range = source.tableRanges[name];
  const columns = [...(table.rowid ? table.keys : []), ...table.columns];
  if (state.cleanupPending) {
    const categoryRange = source.tableRanges.cleanup_run_categories;
    if (!categoryRange) fail("missing cleanup categories");
    const block = await readBlock(
      context,
      store,
      readSourcePage,
      state.cleanupCursor ?? categoryRange.cursor,
      state.cleanupCursor === null ? categoryRange.beforeDigest : state.cleanupDigest,
      source.schema,
    );
    if (block.block.kind !== "rows" || block.block.table !== "cleanup_run_categories")
      fail("cleanup category table mismatch");
    const runIndex = state.cleanupPending.columns.indexOf("id");
    for (const cells of block.block.rows) {
      const row = Object.fromEntries(
        block.block.columns.map((column, index) => [column, cells[index]!]),
      );
      if (!state.cleanupPending.rows.some((run) => run[runIndex] === row.run_id)) continue;
      const category = CATEGORIES.find((entry) => entry.id === checkpointText(row.category!));
      if (!category) fail("unknown cleanup history category");
      const scopes = state.cleanupScopes[row.run_id!] ?? [];
      if (!scopes.includes(category.scope)) scopes.push(category.scope);
      state.cleanupScopes[row.run_id!] = scopes;
    }
    const nextTable =
      block.nextCursor === null ? null : (JSON.parse(block.nextCursor).table as number);
    if (nextTable === null || source.schema.tables[nextTable]?.name !== "cleanup_run_categories") {
      if (block.digest !== categoryRange.afterDigest) fail("cleanup category digest mismatch");
      for (const row of state.cleanupPending.rows) {
        const converted = canonicalCheckpointRow(
          table.name,
          name,
          state.cleanupPending.columns,
          row,
          columns,
          manifest,
          state,
        );
        if (converted) state.buffered.push(converted);
      }
      state.cleanupPending = null;
      state.cleanupCursor = null;
      state.cleanupDigest = "";
      state.cleanupScopes = {};
    } else {
      state.cleanupCursor = block.nextCursor;
      state.cleanupDigest = block.digest;
    }
    return { state, done: false };
  }
  if (!range) state.sourceDone = true;
  if (!state.sourceDone && state.buffered.length < ROWS_PER_BLOCK) {
    const block = await readBlock(
      context,
      store,
      readSourcePage,
      state.sourceCursor ?? range!.cursor,
      state.sourceCursor === null ? range!.beforeDigest : state.sourceDigest,
      source.schema,
    );
    if (block.block.kind !== "rows" || block.block.table !== name) fail("source table mismatch");
    if (name === "cleanup_runs" && block.block.rows.length) state.cleanupPending = block.block;
    else
      for (const row of block.block.rows) {
        const converted = canonicalCheckpointRow(
          table.name,
          name,
          block.block.columns,
          row,
          columns,
          manifest,
          state,
        );
        if (converted) state.buffered.push(converted);
      }
    const nextTable =
      block.nextCursor === null ? null : (JSON.parse(block.nextCursor).table as number);
    if (nextTable === null || source.schema.tables[nextTable]?.name !== name) {
      if (block.digest !== range!.afterDigest) fail("source table digest mismatch");
      state.sourceDone = true;
    } else {
      state.sourceCursor = block.nextCursor;
      state.sourceDigest = block.digest;
    }
    return { state, done: false };
  }
  state.output = {
    kind: "rows",
    table: table.name,
    columns,
    rows: state.buffered.splice(0, ROWS_PER_BLOCK),
  };
  return { state, done: false };
}
