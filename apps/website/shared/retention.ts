// Data retention (CORE-195): the shapes the retention API returns, shared by
// the worker, the admin UI and `gm`. The categories themselves are defined once
// in worker/retention/categories.ts; the API sends each definition along with
// its policy, so clients never keep their own copy.

import type { UsageCost } from "./usage.ts";

/** Whose data a category covers: one account's, or the site's (global caches, auth). */
export type RetentionScope = "account" | "site";

/**
 * How a category is controlled:
 * - "policy": administrator-configurable; off unless defaultEnabled is set.
 * - "active": cleanup that already ran before retention policies existed and
 *   always runs (preview teardown, Atlas snapshots); its thresholds are
 *   editable within their bounds.
 * - "fixed": always runs with thresholds that are shown, not edited (auth hygiene).
 */
export type RetentionControl = "policy" | "active" | "fixed";

export type ThresholdUnit = "days" | "months" | "count" | "gib";

/** One configurable number of a category, always a whole number within bounds. */
export interface RetentionThreshold {
  key: string;
  label: string;
  unit: ThresholdUnit;
  min: number;
  max: number;
  /** The PRD default, applied when the category is enabled without a value. */
  default: number;
}

export interface RetentionCategory {
  /** Stable id, kebab-case: stored in policies and runs. */
  id: string;
  scope: RetentionScope;
  control: RetentionControl;
  /** Policy categories normally opt in; lifecycle byte retention starts enabled. */
  defaultEnabled?: boolean;
  label: string;
  description: string;
  /** In plain words, what this category never deletes. */
  never: string[];
  thresholds: RetentionThreshold[];
  /**
   * Categories whose selections can include the same records as this one
   * (closed issues take their activity log entries with them). A dry run of
   * both counts those records under each, so its total is higher than what a
   * run removes; a run removes each record once.
   */
  overlaps?: string[];
}

/** Where an effective value comes from. */
export type PolicySource = "default" | "site" | "account";

/** A category with its effective policy at one level (an account, or the site). */
export interface RetentionPolicy extends RetentionCategory {
  enabled: boolean;
  enabledFrom: PolicySource;
  /** Effective thresholds, every key filled in. */
  values: Record<string, number>;
  /** Where each value comes from. */
  valuesFrom: Record<string, PolicySource>;
  /** True when a cleanup is implemented and runs can include it (CORE-198). */
  runnable: boolean;
  /** The latest run that covered it at this level; null if none. */
  lastRun: RetentionLastRun | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** One recorded change: who changed which category, from what to what. */
export interface RetentionChange {
  category: string;
  actor: string | null;
  before: StoredPolicy;
  after: StoredPolicy;
  at: string;
}

/** What one level stores for a category; absent fields inherit. */
export interface StoredPolicy {
  enabled?: boolean;
  thresholds?: Record<string, number>;
}

/**
 * GET /api/accounts/:slug/settings/retention: the account's categories.
 * GET /api/admin/retention: site-scope categories, plus site-wide defaults for
 * the account categories that take a policy.
 */
export interface RetentionSettings {
  level: RetentionScope;
  /** The account's slug; null at site level. */
  account: string | null;
  /** True when the viewer may change these settings. */
  canEdit: boolean;
  categories: RetentionPolicy[];
  /** Latest changes first, at most 20. */
  changes: RetentionChange[];
}

/**
 * PATCH body for both levels. `enabled: null` or a threshold `null` removes
 * the stored value, so it inherits again (site default, then PRD default).
 */
export interface RetentionPatch {
  categories: Record<
    string,
    { enabled?: boolean | null; thresholds?: Record<string, number | null> }
  >;
}

/** The latest run that covered a category at this level (CORE-198). */
export interface RetentionLastRun {
  runId: number;
  dryRun: boolean;
  trigger: "schedule" | "manual";
  status: RetentionRunCategory["status"];
  items: number;
  bytes: number;
  error: string | null;
  at: string;
}

export type RetentionRunStatus = "queued" | "running" | "succeeded" | "failed";

/** One category of a cleanup run. */
export interface RetentionRunCategory {
  category: string;
  label: string;
  status: "pending" | "running" | "succeeded" | "failed";
  /** The thresholds the run used. */
  thresholds: Record<string, number>;
  /** Records selected (dry run) or removed (run), so far. */
  items: number;
  /** Their estimated bytes. */
  bytes: number;
  batches: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /**
   * What `bytes` costs a month at the storage list price in effect on the
   * run's day (CORE-208's catalog): an estimate of what removing them saves.
   * Null when the catalog has no price for where the category's data lives.
   */
  cost: UsageCost | null;
}

/** A cleanup run: scheduled or manual, dry or real, with what each category did. */
export interface RetentionRun {
  id: number;
  level: RetentionScope;
  /** The account's slug; null for a site run. */
  account: string | null;
  trigger: "schedule" | "manual";
  /** Who started a manual run. */
  actor: string | null;
  dryRun: boolean;
  status: RetentionRunStatus;
  /** The moment every selection is computed from. */
  asOf: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  items: number;
  bytes: number;
  error: string | null;
  categories: RetentionRunCategory[];
  /**
   * Plain statements about the figures, e.g. that a dry run of overlapping
   * categories counts some records twice. Empty when there is nothing to say.
   */
  notes: string[];
}

/** GET …/runs: newest first; pass `before` = next for the following page. */
export interface RetentionRunPage {
  runs: RetentionRun[];
  next: number | null;
}

/**
 * POST /api/accounts/:slug/retention/runs, POST /api/admin/retention/runs:
 * any categories of that level that have a cleanup, enabled or not, at their
 * effective thresholds unless overridden here (same bounds as policies).
 */
export interface RetentionRunRequest {
  dryRun: boolean;
  categories: string[];
  thresholds?: Record<string, Record<string, number>>;
}
