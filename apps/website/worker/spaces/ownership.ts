/** Additive migration targets only, never an authorization fallback.
 * The coordinator may backfill content rows after manifest/fence verification.
 * Mixed rows require an explicit discriminator; unknown rows fail preflight.
 */
export const SPACE_PREPARATION_COLUMNS = {
  repos: { legacyColumn: "owner_id", classification: "content" },
  timeline_source_migrations: { legacyColumn: "owner_id", classification: "content" },
  tracker_repo_subscriptions: { legacyColumn: "tracker_owner_id", classification: "content" },
  release_highlights: { legacyColumn: "owner_account_id", classification: "content" },
  atlas_budget_exhaustions: { legacyColumn: "account_id", classification: "content" },
  timeline_work_sources: { legacyColumn: "owner_id", classification: "content" },
  source_operations: { legacyColumn: "owner_id", classification: "content" },
  tracker_preferences: { legacyColumn: "owner_id", classification: "content" },
  repo_deletions: { legacyColumn: "owner_id", classification: "content" },
  account_settings: { legacyColumn: "account_id", classification: "content" },
  ai_providers: { legacyColumn: "account_id", classification: "content" },
  // Assistant/status/title/avatar overrides remain personal; content components
  // are mapped individually by the fenced coordinator.
  account_ai_log_bodies: { legacyColumn: "account_id", classification: "mixed" },
  atlas_spend: { legacyColumn: "account_id", classification: "content" },
  atlas_spend_daily: { legacyColumn: "account_id", classification: "content" },
  do_instances: { legacyColumn: "account_id", classification: "mixed" },
  usage_snapshots: { legacyColumn: "account_id", classification: "mixed" },
  usage_monthly: { legacyColumn: "account_id", classification: "mixed" },
  ai_usage: { legacyColumn: "account_id", classification: "mixed" },
  ai_usage_monthly: { legacyColumn: "account_id", classification: "mixed" },
  retention_policies: { legacyColumn: "account_id", classification: "mixed" },
  retention_policy_changes: { legacyColumn: "account_id", classification: "mixed" },
  cleanup_runs: { legacyColumn: "account_id", classification: "mixed" },
} as const;
// environment_reservations.owner_id, accounts, credentials, agents, chat/assistant
// and every actor/update-by field remain person or Instance identity, unchanged.
