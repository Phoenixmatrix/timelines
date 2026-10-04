// Data retention (CORE-195): the shapes the retention API returns, shared by
// the worker, the admin UI and `gm`. The categories themselves are defined once
// in worker/retention/categories.ts; the API sends each definition along with
// its policy, so clients never keep their own copy.

/** Whose data a category covers: one account's, or the site's (global caches, auth). */
export type RetentionScope = "account" | "site";

/**
 * How a category is controlled:
 * - "policy": off until an administrator enables it (every new category).
 * - "active": cleanup that already ran before retention policies existed and
 *   always runs (preview teardown); its thresholds are editable.
 * - "fixed": always runs with thresholds that are shown, not edited (Atlas).
 */
export type RetentionControl = "policy" | "active" | "fixed";

export type ThresholdUnit = "days" | "count" | "gib";

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
  label: string;
  description: string;
  /** In plain words, what this category never deletes. */
  never: string[];
  thresholds: RetentionThreshold[];
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
