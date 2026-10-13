import { describe, expect, test } from "vite-plus/test";
import { FakeD1 } from "@gitmatrix/testing";
import type {
  SpaceManifest,
  SpaceCheckpointPage,
  SpaceMigrationContext,
} from "../../shared/space-cutover.ts";
import {
  createD1SpaceCheckpoint,
  inspectD1SpaceCheckpointStep,
  type D1InventoryState,
  type D1InspectionState,
} from "../../registry/core/space-migration.ts";
import {
  canonicalCheckpointRow,
  canonicalPreferenceQuery,
  canonicalTimelineMigrationJson,
  checkpointText,
  checkpointTextValue,
  transformCanonicalCheckpointStep,
  type CanonicalTransformState,
} from "./canonical-transform.ts";

const manifest: SpaceManifest = {
  manifestVersion: 1,
  contentContractVersion: 4,
  source: "fixture",
  sourceCommit: "fixture",
  mapping: [
    {
      legacyOwner: { id: "legacy-org", kind: "org", slug: "company" },
      organization: {
        id: "organization",
        slug: "company",
        displayName: "Company",
        kind: "company",
        personalAccountId: null,
        defaultSpaceId: "space",
      },
      space: {
        id: "space",
        organizationId: "organization",
        slug: "company",
        displayName: "General",
        archived: false,
      },
      organizationMembers: [],
      spaceGrants: [],
      trackerDoName: "legacy-org",
      repositories: [],
      repositoryCollaborators: [],
      registryFeeds: [],
      providers: [],
      hasContentSettings: false,
    },
  ],
};
const evidence = {
  people: ["person"],
  organizationAvatars: { organization: checkpointTextValue("opaque/avatar") },
  cleanupScopes: {},
};
const text = checkpointTextValue;

describe("canonical immutable checkpoint cell conversion", () => {
  test("preserves provider bytes, rowid and integers without numeric coercion", () => {
    const columns = ["_rowid_", "id", "account_id", "space_id", "kind", "key_sealed", "counter"];
    const cells = [
      "9223372036854775806",
      text("provider"),
      text("legacy-org"),
      text("space"),
      text("openai"),
      "X'00FF804100'",
      "9007199254740993",
    ];
    expect(
      canonicalCheckpointRow(
        "ai_providers",
        "ai_providers",
        columns,
        cells,
        ["_rowid_", "id", "space_id", "kind", "key_sealed", "counter"],
        manifest,
        evidence,
      ),
    ).toEqual([cells[0], cells[1], cells[3], cells[4], cells[5], cells[6]]);
  });
  test("round trips NUL and unicode only when a changed field needs decoding", () => {
    expect(checkpointText(text("before\0after ♥"))).toBe("before\0after ♥");
    expect(checkpointText(text("\uFEFFpreserved"))).toBe("\uFEFFpreserved");
  });
  test("splits content logs without moving personal logs", () => {
    const columns = ["account_id", "space_id", "component", "enabled"];
    const personal = [text("person"), "NULL", text("assistant-titles"), "1"];
    expect(
      canonicalCheckpointRow(
        "space_ai_log_bodies",
        "account_ai_log_bodies",
        columns,
        personal,
        ["space_id", "component", "enabled"],
        manifest,
        evidence,
      ),
    ).toBeNull();
    expect(
      canonicalCheckpointRow(
        "account_ai_log_bodies",
        "account_ai_log_bodies",
        columns,
        personal,
        ["account_id", "component", "enabled"],
        manifest,
        evidence,
      ),
    ).toEqual([personal[0], personal[2], "1"]);
    const content = [text("legacy-org"), text("space"), text("knowledge"), "1"];
    expect(
      canonicalCheckpointRow(
        "space_ai_log_bodies",
        "account_ai_log_bodies",
        columns,
        content,
        ["space_id", "component", "enabled"],
        manifest,
        evidence,
      ),
    ).toEqual([content[1], content[2], "1"]);
  });
  test("preserves Organization avatar options and separates person avatars", () => {
    const columns = ["user_id", "status", "options", "created_at", "finished_at"];
    const cells = [
      text("legacy-org"),
      text("ready"),
      text('["opaque/one","opaque/two"]'),
      text("created"),
      text("finished"),
    ];
    expect(
      canonicalCheckpointRow(
        "avatar_generations",
        "avatar_generations",
        columns,
        cells,
        columns,
        manifest,
        evidence,
      ),
    ).toBeNull();
    expect(
      canonicalCheckpointRow(
        "organization_avatar_generations",
        "avatar_generations",
        columns,
        cells,
        ["organization_id", ...columns.slice(1)],
        manifest,
        evidence,
      ),
    ).toEqual([text("organization"), ...cells.slice(1)]);
  });
  test("an approved Organization's historical totals belong to its Space, never relabeled personal", () => {
    // CORE-341 production: matrixorg's usage snapshots, by the operator's decision.
    expect(
      canonicalCheckpointRow(
        "usage_monthly",
        "usage_monthly",
        ["account_id", "space_id"],
        [text("legacy-org"), "NULL"],
        ["scope_kind", "scope_id"],
        manifest,
        evidence,
      ),
    ).toEqual([text("space"), text("space")]);
    // A non-person owner the manifest doesn't map is still refused.
    expect(() =>
      canonicalCheckpointRow(
        "usage_monthly",
        "usage_monthly",
        ["account_id", "space_id"],
        [text("stranger-org"), "NULL"],
        ["scope_kind", "scope_id"],
        manifest,
        evidence,
      ),
    ).toThrow("non-person historical scope");
  });
  test("scope keys retain the accountable person or explicit Space", () => {
    expect(
      canonicalCheckpointRow(
        "ai_usage",
        "ai_usage",
        ["account_id", "space_id"],
        [text("person"), "NULL"],
        ["scope_kind", "scope_id"],
        manifest,
        evidence,
      ),
    ).toEqual([text("person"), text("person")]);
    expect(
      canonicalCheckpointRow(
        "ai_usage",
        "ai_usage",
        ["account_id", "space_id"],
        [text("legacy-org"), text("space")],
        ["scope_kind", "scope_id"],
        manifest,
        evidence,
      ),
    ).toEqual([text("space"), text("space")]);
  });
  test("rejects mixed cleanup history and preserves wide numeric run lookup", () => {
    expect(() =>
      canonicalCheckpointRow(
        "cleanup_runs",
        "cleanup_runs",
        ["id", "account_id", "space_id"],
        ["9007199254740993", text("person"), "NULL"],
        ["id", "scope_kind", "scope_id"],
        manifest,
        { ...evidence, cleanupScopes: { "9007199254740993": ["person", "space"] } },
      ),
    ).toThrow("ambiguous cleanup history");
  });
  test("converts known tokenizer filter spellings and rejects unknown grammar", () => {
    expect(canonicalPreferenceQuery('workspace:alpha -ws:"two words" "workspace:literal"')).toBe(
      'project:alpha -project:"two words" "project:literal"',
    );
    expect(() => canonicalPreferenceQuery("workspaceUnknown:alpha")).toThrow(
      "unknown saved Tracker filter",
    );
  });
  test("invalidates legacy derived Tracker highlights in their mapped Space", () => {
    const columns = [
      "scope",
      "scope_id",
      "viewer_id",
      "owner_account_id",
      "space_id",
      "body",
      "source_manifest",
      "status",
      "lease_id",
    ];
    const values = [
      text("tracker"),
      text("legacy-org"),
      text("person"),
      text("legacy-org"),
      text("space"),
      text("old projection"),
      text('[{"ownerAccountId":"legacy-org"}]'),
      text("ready"),
      text("old-lease"),
    ];
    const original = [...values];
    const targetColumns = [
      "viewer_id",
      "space_id",
      "body",
      "source_manifest",
      "status",
      "lease_id",
      "authorization_binding",
    ];
    const convert = (cells: string[]) =>
      canonicalCheckpointRow(
        "release_highlights",
        "release_highlights",
        columns,
        cells,
        targetColumns,
        manifest,
        evidence,
      );
    expect(convert(values)).toEqual([
      text("person"),
      text("space"),
      text(""),
      text("[]"),
      text("idle"),
      "NULL",
      "NULL",
    ]);
    expect(values).toEqual(original);
    // A Space that disagrees with the mapped owner is never accepted.
    expect(() => convert(values.with(4, text("wrong-space")))).toThrow(
      "unmapped release highlights",
    );
  });
  test("rejects site or repository highlights that CORE-359 deleted", () => {
    for (const scope of ["site", "repo"])
      expect(() =>
        canonicalCheckpointRow(
          "release_highlights",
          "release_highlights",
          ["scope", "owner_account_id", "space_id"],
          [text(scope), text("person"), "NULL"],
          ["space_id"],
          manifest,
          evidence,
        ),
      ).toThrow("non-Tracker release highlights");
  });
  test("preserves CORE-222 attribution cells and classifies the new content features", () => {
    const columns = [
      "day",
      "account_id",
      "space_id",
      "feature",
      "actor_id",
      "agent_id",
      "timeline",
    ];
    const target = ["day", "scope_kind", "scope_id", "feature", "actor_id", "agent_id", "timeline"];
    for (const feature of ["release_highlights", "release_notes_compose"])
      expect(
        canonicalCheckpointRow(
          "ai_usage",
          "ai_usage",
          columns,
          [
            text("2026-10-11"),
            text("legacy-org"),
            text("space"),
            text(feature),
            text("person"),
            text("agent"),
            text("search-v2"),
          ],
          target,
          manifest,
          evidence,
        ),
      ).toEqual([
        text("2026-10-11"),
        text("space"),
        text("space"),
        text(feature),
        text("person"),
        text("agent"),
        text("search-v2"),
      ]);
  });
  test("contextually converts frozen timeline DTO locators and preserves source snapshots", () => {
    const mapped: SpaceManifest = {
      ...manifest,
      mapping: [
        {
          ...manifest.mapping[0]!,
          repositories: [
            {
              id: "repo-id",
              name: "repo",
              visibility: "private",
              artifactsName: "opaque-provider",
            },
          ],
        },
      ],
    };
    const snapshot = {
      sourceId: "canonical",
      repoId: "repo-id",
      kind: "canonical-historical",
      timelineId: null,
      ref: "refs/heads/old",
      commit: "opaque-commit",
      tree: "opaque-tree",
    };
    const entry = {
      id: "repo-id",
      owner: "company",
      name: "repo",
      bookmark: "timeline/work",
      source: snapshot,
    };
    const frozen = [
      {
        entry,
        head: snapshot,
        base: snapshot,
        dependencies: [{ source: snapshot, base: snapshot }],
      },
    ];
    const converted = JSON.parse(
      canonicalTimelineMigrationJson(JSON.stringify(frozen), "input", "space", mapped),
    );
    expect(converted).toEqual([
      {
        ...frozen[0],
        entry: {
          id: "repo-id",
          name: "repo",
          bookmark: "timeline/work",
          source: snapshot,
          space: "company",
        },
      },
    ]);
    expect(
      JSON.parse(
        canonicalTimelineMigrationJson(JSON.stringify([entry]), "output", "space", mapped),
      )[0].space,
    ).toBe("company");
    expect(() =>
      canonicalTimelineMigrationJson(
        JSON.stringify([{ ...entry, owner: "other" }]),
        "output",
        "space",
        mapped,
      ),
    ).toThrow("conflicting frozen timeline locator");
    expect(() =>
      canonicalTimelineMigrationJson(
        JSON.stringify([{ ...entry, source: { ...snapshot, owner: "unknown" } }]),
        "output",
        "space",
        mapped,
      ),
    ).toThrow("unknown frozen timeline DTO");
    expect(() =>
      canonicalTimelineMigrationJson(JSON.stringify([entry]), "output", "unmapped", mapped),
    ).toThrow("unmapped frozen timeline Space");
    expect(entry.owner).toBe("company");
  });
  test("cold resumes and replays immutable target fragments", async () => {
    const database = new FakeD1();
    database.applySql(
      "CREATE TABLE repositories(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,space_id TEXT,name TEXT NOT NULL,UNIQUE(owner_id,name)); INSERT INTO repositories VALUES('r','legacy-org','space','repo')",
    );
    const context: SpaceMigrationContext = {
      runId: "run",
      migrationEpoch: 1,
      manifestDigest: "digest",
      legacyOwnerId: "legacy-org",
      spaceId: "space",
      organizationId: "organization",
      spaceSlug: "company",
      contractVersion: 4,
    };
    const checkpoint = createD1SpaceCheckpoint(
      database as unknown as D1Database,
      "registry",
      async () => {},
    );
    const pages = new Map<string | null, SpaceCheckpointPage>();
    let inventory: D1InventoryState | null = null;
    for (;;) {
      const step = await checkpoint.inventoryStep(context, inventory);
      inventory = structuredClone(step.state);
      if (step.page) pages.set(step.page.cursor, step.page);
      if (step.done) break;
    }
    const reader = async (cursor: string | null) => pages.get(cursor)!;
    let inspection: D1InspectionState | null = null;
    for (;;) {
      const step = await inspectD1SpaceCheckpointStep(context, "registry", reader, inspection);
      inspection = structuredClone(step.state);
      if (step.done) break;
    }
    const target = new Map<string | null, SpaceCheckpointPage>();
    let state: CanonicalTransformState | null = null;
    for (;;) {
      const step = await transformCanonicalCheckpointStep(
        context,
        manifest,
        inspection.result!,
        reader,
        state,
      );
      const replay = await transformCanonicalCheckpointStep(
        context,
        manifest,
        inspection.result!,
        reader,
        state,
      );
      expect(replay).toEqual(step);
      if (step.page) target.set(step.page.cursor, step.page);
      state = structuredClone(step.state);
      if (step.done) {
        expect(step.result.counts.repositories).toBe(1);
        expect(step.result.digest).not.toBe(step.result.sourceDigest);
        break;
      }
    }
    let inspectedTarget: D1InspectionState | null = null;
    for (;;) {
      const step = await inspectD1SpaceCheckpointStep(
        context,
        "registry",
        async (cursor) => target.get(cursor)!,
        inspectedTarget,
      );
      inspectedTarget = structuredClone(step.state);
      if (step.done) {
        expect(step.result.digest).toBe(state.digest);
        break;
      }
    }
    await expect(
      transformCanonicalCheckpointStep(
        { ...context, migrationEpoch: 2 },
        manifest,
        inspection.result!,
        reader,
        state,
      ),
    ).rejects.toThrow("binding mismatch");
  });
});
