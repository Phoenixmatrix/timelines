import { Kysely, type Generated } from "kysely";
import { D1Dialect } from "kysely-d1";
import type { ClassificationModel, GenerationModel } from "../shared/ai.ts";
import type { QueueStatus } from "../shared/merge-queue.ts";

/**
 * Gitmatrix's database (the DB binding) for Kysely. The SQL migrations in
 * `migrations/` are the source of truth; every migration updates this
 * interface in the same change. `Generated` marks columns with a default.
 * Timestamps are ISO strings; JSON columns are TEXT, parsed at the edges.
 * (The package registry keeps its own database: registry/core/db.ts.)
 */
export interface Database {
  merge_queue: {
    repo_id: string;
    id: string;
    status: QueueStatus;
    version: Generated<number>;
    attempts: Generated<number>;
    merge_run_id: string | null;
    gate_run_id: string | null;
    base: string | null;
    candidate: string | null;
    covered_by: string | null;
    data: string;
    created_at: string;
    updated_at: string;
    swept_at: Generated<string>;
    recovered_at: Generated<string>;
  };
  accounts: {
    id: string;
    kind: "user" | "org";
    slug: string;
    display_name: string;
    bio: Generated<string>;
    is_site_admin: Generated<number>;
    /** Orgs only: the role every member gets on every repo the org owns. */
    member_repo_role: "none" | "read" | "write" | null;
    /** Users who sign in by email; null for orgs and seed personas. */
    email: string | null;
    created_at: Generated<string>;
    /** People's profile picture in the AVATARS bucket; null shows initials. */
    avatar_key: string | null;
  };
  // Better Auth's tables (worker/better-auth.ts): only what Gitmatrix reads.
  auth_users: {
    id: string;
    name: string;
    email: string;
    emailVerified: number;
    createdAt: string;
    updatedAt: string;
  };
  auth_sessions: {
    id: string;
    token: string;
    userId: string;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
  };
  auth_invites: {
    email: string;
    invited_by: string | null;
    created_at: Generated<string>;
  };
  auth_lockouts: {
    key: string;
    until: string;
  };
  org_members: {
    org_id: string;
    user_id: string;
    role: "owner" | "member";
  };
  repos: {
    id: string;
    owner_id: string;
    name: string;
    description: Generated<string>;
    visibility: "public" | "private";
    default_branch: Generated<string>;
    artifacts_name: string;
    artifacts_remote: string;
    imported_from: string | null;
    created_at: Generated<string>;
    pushed_at: string | null;
    /** Pack bytes pushed through the proxy since CORE-207 (Artifacts' size estimate). */
    pushed_bytes: Generated<number>;
    /** Set when deletion starts (CORE-199): missing to readers until the purge removes the row. */
    deleted_at: Generated<string | null>;
  };
  /** Repository deletions and what their purge did (CORE-199, worker/retention/repo-purge.ts). */
  repo_deletions: {
    repo_id: string;
    owner_id: string;
    full_name: string;
    artifacts_name: string | null;
    source: Generated<"delete" | "orphan-sweep">;
    requested_by: string | null;
    requested_at: string;
    phase: string;
    progress: Generated<string>;
    workflow_id: string | null;
    attempts: Generated<number>;
    updated_at: string;
    finished_at: string | null;
    error: string | null;
  };
  repo_collaborators: {
    repo_id: string;
    user_id: string;
    role: "read" | "write" | "admin";
    added_at: Generated<string>;
  };
  access_tokens: {
    id: string;
    user_id: string;
    name: string;
    scope: "read" | "write";
    token_hash: string;
    last_four: string;
    created_at: Generated<string>;
    last_used_at: string | null;
    expires_at: string | null;
    ssh_key_id: string | null;
    /** Set when the token acts as one of the user's agents. */
    agent_id: Generated<string | null>;
  };
  agents: {
    id: string;
    name: string;
    accountable_id: string;
    description: Generated<string>;
    created_at: Generated<string>;
    revoked_at: string | null;
    capabilities: Generated<string | null>;
    capabilities_updated_at: Generated<string | null>;
  };
  tracker_preferences: {
    user_id: string;
    owner_id: string;
    team_id: string | null;
    view: Generated<string>;
    query: Generated<string>;
    updated_at: Generated<string>;
  };
  assistant_chats: {
    id: string;
    user_id: string;
    title: Generated<string>;
    source: Generated<"web" | "cli">;
    created_at: Generated<string>;
    updated_at: Generated<string>;
  };
  /** The Durable Object instance registry (CORE-197, worker/durable/). */
  do_instances: {
    class: string;
    name: string;
    account_id: string | null;
    repo_id: string | null;
    created_at: Generated<string>;
    last_active_at: Generated<string>;
    storage_bytes: number | null;
    sized_at: string | null;
    retiring_at: string | null;
    purged_at: string | null;
    purge_reason: string | null;
  };
  /** Daily usage per account and construct (CORE-207, worker/usage/collect.ts). */
  usage_snapshots: {
    day: string;
    account_id: string;
    construct: UsageConstruct;
    item: string;
    metric: string;
    kind: "storage" | "activity";
    quantity: number;
    estimated: number;
    method: string;
    collected_at: string;
  };
  /** Workers AI calls and tokens per day, account, feature and model (worker/usage/ai.ts). */
  ai_usage: {
    day: string;
    account_id: string;
    feature: string;
    model: string;
    calls: Generated<number>;
    input_tokens: Generated<number>;
    output_tokens: Generated<number>;
    total_tokens: Generated<number>;
  };
  /** usage_snapshots past their policy, rolled up by month (CORE-225, worker/usage/history.ts). */
  usage_monthly: {
    month: string;
    account_id: string;
    construct: UsageConstruct;
    item: string;
    metric: string;
    kind: "storage" | "activity";
    quantity: number;
    days: number;
    last_day: string;
    last_quantity: number;
    estimated: number;
    method: string;
  };
  /** ai_usage past its policy, rolled up by month (CORE-225). */
  ai_usage_monthly: {
    month: string;
    account_id: string;
    feature: string;
    model: string;
    calls: Generated<number>;
    input_tokens: Generated<number>;
    output_tokens: Generated<number>;
    total_tokens: Generated<number>;
    days: Generated<number>;
  };
  /** Where a bounded, resumable cron pass left off. */
  job_cursors: {
    name: string;
    cursor: string;
    updated_at: Generated<string>;
  };
  ssh_keys: {
    id: string;
    user_id: string;
    title: string;
    key_type: string;
    public_key: string;
    fingerprint: string;
    scope: "read" | "write";
    created_at: Generated<string>;
    last_used_at: string | null;
  };
  ssh_challenges: {
    nonce: string;
    key_id: string;
    origin: string;
    expires_at: string;
  };
  kg_blob_analysis: {
    blob_oid: string;
    analyzer: string;
    language: string;
    data: string;
    model: string | null;
    tokens: Generated<number>;
    created_at: Generated<string>;
    /** When a build last used it (at most daily; CORE-201). */
    used_at: Generated<string | null>;
  };
  kg_synthesis: {
    key: string;
    data: string;
    model: string | null;
    tokens: Generated<number>;
    created_at: Generated<string>;
    /** When a build last used it (at most daily; CORE-201). */
    used_at: Generated<string | null>;
  };
  kg_nodes: {
    repo_id: string;
    id: string;
    kind: string;
    name: string;
    path: string | null;
    summary: Generated<string>;
    data: Generated<string>;
    content_hash: string;
    changed_in: string;
    updated_at: Generated<string>;
  };
  kg_edges: {
    repo_id: string;
    src: string;
    dst: string;
    kind: string;
    weight: Generated<number>;
  };
  kg_builds: {
    id: string;
    repo_id: string;
    from_commit: string | null;
    to_commit: string;
    status: "running" | "succeeded" | "failed";
    phase: Generated<string>;
    stats: Generated<string>;
    error: string | null;
    started_at: Generated<string>;
    finished_at: string | null;
    progress_at: string | null;
    ai_snapshot: Generated<string | null>;
  };
  kg_changes: {
    repo_id: string;
    build_id: string;
    node_id: string;
    kind: string;
    change: "added" | "changed" | "removed";
  };
  kg_state: {
    repo_id: string;
    indexed_commit: string | null;
    indexed_at: string | null;
    last_build_id: string | null;
    graph_at: string | null;
  };
  kg_files: {
    repo_id: string;
    snapshot: string;
    path: string;
    blob_oid: string;
    mode: string;
  };
  kg_search_items: {
    repo_id: string;
    key: string;
    item_id: string;
    version: string;
    /** Uploaded size; null for items uploaded before CORE-207. */
    bytes: number | null;
  };
  kg_concept_pairs: {
    repo_id: string;
    a: string;
    b: string;
    version: string;
    score: number;
    a_in_b: number;
    b_in_a: number;
  };
  kg_concepts: {
    repo_id: string;
    key: string;
    canonical: string;
    recurring: number | null;
    salient: number | null;
    salience_hash: string | null;
  };
  kg_concept_links: {
    repo_id: string;
    narrower: string;
    broader: string;
  };
  kg_concept_reviews: {
    repo_id: string;
    a: string;
    b: string;
    score: number;
    inputs_hash: string;
  };
  kg_overlays: {
    repo_id: string;
    ref: string;
    overlay_id: string | null;
    head_commit: string | null;
    base_commit: string | null;
    merge_base: string | null;
    stats: Generated<string>;
    updated_at: string | null;
    status: "succeeded" | "failed";
    attempted_commit: string;
    error: string | null;
    /** Set when the bookmark disappeared (CORE-139): the overlay is kept read-only. */
    ended_at: string | null;
    ended_reason: "landed" | "abandoned" | "ended" | null;
    /** Set when retention removed an ended overlay's changes and pages (CORE-201). */
    removed_at: Generated<string | null>;
  };
  /** Atlas spend rolled up per account and day (CORE-201, "ai-spend"). */
  atlas_spend_daily: {
    account_id: string;
    day: string;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cost_micro_usd: number;
    rolled_up_at: string;
  };
  /** Atlas paid-synthesis calls, reserved then reconciled (worker/knowledge/budget.ts). */
  atlas_spend: {
    id: string;
    account_id: string;
    day: string;
    scope: "build" | "grouping";
    run_id: string;
    repo_id: string | null;
    purpose: string;
    model: string;
    status: "reserved" | "settled" | "failed" | "released";
    input_tokens: number;
    output_tokens: number;
    cost_micro_usd: number;
    reserved_input_tokens: number;
    reserved_output_tokens: number;
    reserved_micro_usd: number;
    created_at: string;
    settled_at: string | null;
  };
  atlas_budget_exhaustions: {
    key: string;
    account_id: string;
    scope: "day" | "build" | "grouping";
    run_id: string | null;
    day: string | null;
    cap: "daily_usd" | "calls" | "input_tokens" | "output_tokens";
    exhausted_at: string;
    resets_at: string | null;
  };
  /** The Cloudflare price catalog's changes and checks, the audit trail (worker/usage/prices.ts). */
  cloudflare_price_changes: {
    id: Generated<number>;
    kind: "seed" | "refresh" | "check" | "manual";
    status: "pending" | "applied" | "discarded" | "rejected" | "unchanged" | "superseded";
    created_at: Generated<string>;
    created_by: string | null;
    base_version: number | null;
    /** JSON PricePageResult[]. */
    pages: Generated<string>;
    /** JSON PriceDiffEntry[]. */
    diff: Generated<string>;
    note: string | null;
    decided_at: string | null;
    decided_by: string | null;
  };
  /** Versions of Cloudflare's published prices (worker/usage/prices.ts). */
  cloudflare_prices: {
    id: Generated<number>;
    change_id: number;
    product: string;
    metric: string;
    unit: string;
    unit_quantity: number;
    unit_price_usd: number;
    included_quantity: number | null;
    included_period: "month" | "day" | null;
    effective_from: string;
    source_url: string;
    source_updated: string | null;
    fetched_at: string | null;
    provenance: "seed" | "refresh" | "manual";
    recorded_at: Generated<string>;
    recorded_by: string | null;
    note: string | null;
    superseded_at: string | null;
    superseded_by: number | null;
  };
  kg_overlay_changes: {
    repo_id: string;
    overlay_id: string;
    node_id: string;
    kind: string;
    change: "added" | "changed" | "removed";
    name: string;
    path: string | null;
    summary: Generated<string>;
    detail: Generated<string>;
  };
  /** A timeline overlay's computed regrouping (CORE-186, atlas/timelineGrouping.ts). */
  atlas_timeline_regroupings: {
    repo_id: string;
    overlay_id: string;
    snapshot_id: string | null;
    seq: number | null;
    version: number;
    grouping_version: number;
    state: "computed" | "skipped";
    reason: string | null;
    data: string | null;
    created_at: string;
  };
  /** Wiki pages for a timeline at a checkpoint, or on demand (CORE-84). */
  kg_page_sets: {
    repo_id: string;
    ref: string;
    set_key: string;
    checkpoint_id: string | null;
    checkpoint_number: number | null;
    commit_oid: string;
    base_commit: string | null;
    status: "queued" | "writing" | "succeeded" | "failed" | "ended";
    build_id: string | null;
    stats: Generated<string>;
    error: string | null;
    requested_by: string | null;
    requested_at: Generated<string>;
    finished_at: string | null;
    ai_snapshot: Generated<string | null>;
  };
  kg_page_set_pages: {
    repo_id: string;
    ref: string;
    set_key: string;
    slug: string;
    title: string;
    section: string;
    position: number;
    node_id: string | null;
    kind: "component" | "architecture" | "glossary";
    change: "added" | "changed";
    outcome: "written" | "kept";
    body: Generated<string>;
    diagram: Generated<string>;
    sources: Generated<string>;
    inputs_hash: string;
    model: string | null;
    tokens: Generated<number>;
    updated_at: Generated<string>;
  };
  /** Atlas projections (CORE-158): see migrations/*_atlas_projections.sql. */
  atlas_scopes: {
    scope: string;
    kind: "repo";
    repo_id: string | null;
    created_at: Generated<string>;
    /** CORE-159: 1 while retention has work left for the scope. */
    retention_pending: Generated<number>;
  };
  atlas_snapshots: {
    id: string;
    scope: string;
    seq: number;
    status: Generated<"building" | "published" | "failed" | "expired">;
    partial: Generated<number>;
    projection_version: number;
    grouping_version: number | null;
    vector: string;
    entities: Generated<number>;
    edges: Generated<number>;
    bytes: Generated<number>;
    error: string | null;
    created_at: Generated<string>;
    published_at: string | null;
    expires_at: string | null;
    /** CORE-159: age | count | storage, once expired. */
    expired_reason: "age" | "count" | "storage" | null;
    /** CORE-159: `capacity` when a snapshot didn't fit its storage cap. */
    failure: "capacity" | null;
    /** CORE-167: packages the repository publishes, frozen at build (worker/atlas/publishers.ts). */
    packages: string | null;
    /** CORE-166: the atlas_feed position it reflects (null: the next projection is full). */
    feed_mark: number | null;
    /** CORE-166: the position an incremental projection started from (null: full). */
    feed_base: number | null;
  };
  /** CORE-166: graph changes not yet reflected in a published Atlas snapshot. */
  atlas_feed: {
    id: Generated<number>;
    repo_id: string;
    kind: "node" | "edge" | "full";
    src: Generated<string>;
    dst: Generated<string>;
    edge_kind: Generated<string>;
  };
  atlas_assignments: {
    scope: string;
    seq: number;
    entity_id: string;
    parent_id: string;
    data: string;
  };
  atlas_lineage: {
    scope: string;
    entity_id: string;
    retired_seq: number;
    kind: string;
    name: string;
    change: string;
    successors: string;
  };
  atlas_current: {
    scope: string;
    snapshot_id: string;
    seq: number;
    published_at: string;
  };
  atlas_entities: {
    scope: string;
    entity_id: string;
    from_seq: number;
    to_seq: number | null;
    kind: string;
    parent_id: string | null;
    sort_key: string;
    name: string;
    path: string | null;
    summary: Generated<string>;
    data: string;
    content_hash: string;
  };
  atlas_edges: {
    scope: string;
    src: string;
    dst: string;
    kind: string;
    from_seq: number;
    to_seq: number | null;
    weight: Generated<number>;
  };
  wiki_pages: {
    repo_id: string;
    slug: string;
    title: string;
    section: string;
    position: number;
    node_id: string | null;
    body: string;
    sources: Generated<string>;
    inputs_hash: string;
    generated_in: string;
    model: string | null;
    updated_at: Generated<string>;
    diagram: Generated<string>;
  };
  tracker_repo_subscriptions: {
    tracker_owner_id: string;
    repo_id: string;
  };
  release_notes: {
    repo_id: string;
    release: string;
    format_version: Generated<number>;
    to_oid: string;
    from_tag: string | null;
    from_oid: string | null;
    truncated: Generated<number>;
    intro: Generated<string>;
    intro_model: string | null;
    intro_inputs_hash: Generated<string>;
    intro_trackers: Generated<string>;
    released_at: string;
    updated_at: string;
  };
  release_note_entries: {
    id: string;
    repo_id: string;
    release: string;
    subject: string;
    kind: "issue" | "commit" | "landing";
    category: "feature" | "fix" | "improvement" | "internal";
    title: string;
    summary: string;
    tracker_owner_id: string | null;
    issue_id: string | null;
    issue_key: string | null;
    team_id: string | null;
    team_key: string | null;
    issue_type: string | null;
    labels: Generated<string>;
    workspace_ids: Generated<string>;
    commits: Generated<string>;
    changes: Generated<string>;
    shipped_at: string;
    model: string | null;
    inputs_hash: string;
    updated_at: string;
    landing_oid: string | null;
    timeline_id: string | null;
    timeline_branch: string | null;
  };
  release_note_mentions: {
    repo_id: string;
    issue_key: string;
  };
  release_note_state: {
    repo_id: string;
    format_version: Generated<number>;
    dirty: Generated<number>;
    lease_until: Generated<number>;
    status: Generated<string>;
    error: string | null;
    generated_at: string | null;
    ai_snapshot: Generated<string | null>;
    lease_id: Generated<string | null>;
    generation_refs: Generated<string | null>;
    /** Releases before it were removed by retention: never regenerated (CORE-206). */
    retained_from: Generated<string | null>;
  };
  ci_refs: {
    repo_id: string;
    ref: string;
    oid: string;
    /** The commit a checkpoint released from the quiet period, maybe before its run existed (CORE-238). */
    quiet_released: Generated<string | null>;
  };
  repo_refs: {
    repo_id: string;
    ref: string;
    oid: string;
  };
  ref_updates: {
    id: Generated<number>;
    repo_id: string;
    ref: string;
    old_oid: string | null;
    new_oid: string | null;
    /** 1 for a force push; null until (or when) the commits couldn't be read. */
    forced: number | null;
    actor_id: string | null;
    agent_id: string | null;
    created_at: Generated<string>;
  };
  change_refs: {
    repo_id: string;
    change_id: string;
    ref: string;
    first_commit_oid: string;
    first_update_id: number;
    first_seen_at: Generated<string>;
    last_commit_oid: string;
    last_seen_at: Generated<string>;
  };
  ci_runs: {
    id: string;
    repo_id: string;
    number: number;
    commit_oid: string;
    ref: string;
    trigger: "push" | "manual";
    actor_id: string | null;
    agent_id: string | null;
    title: Generated<string>;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    config_error: string | null;
    created_at: Generated<string>;
    started_at: string | null;
    finished_at: string | null;
    /** Set while the run waits for runs in flight on its branch (coalescing). */
    held_at: Generated<string | null>;
    /** The run (by number) that covered this one's commit instead of running it. */
    covered_by: Generated<number | null>;
    /**
     * A preview run (CORE-79): its action. Such a run is stored with trigger
     * 'manual' (the CHECK can't widen) and reported as trigger 'preview'.
     */
    preview_action: Generated<"create" | "teardown" | null>;
    /** The timeline (slug) and checkpoint a preview run is for. */
    timeline_slug: Generated<string | null>;
    checkpoint_id: Generated<string | null>;
    /** 1 for a `create` run started by reviving a checkpoint's preview. */
    preview_revived: Generated<number>;
    /** The deployment record a revival rebuilds, when there was one. */
    preview_rebuilt_from: Generated<number | null>;
    /**
     * A landing run (CORE-77): its merge job or the gates on its merge, stored
     * with trigger 'manual' like a preview run and reported as 'landing'.
     */
    landing_id: Generated<string | null>;
    /** Independent default-branch merge queue identity, not a timeline landing. */
    queue_id: Generated<string | null>;
    /** 1 for a step run (CORE-235): the light run for a timeline push, never full CI. */
    step: Generated<number>;
    /** A timeline push run waits until then for its quiet period (CORE-238); null starts now. */
    quiet_until: Generated<string | null>;
  };
  ci_jobs: {
    id: string;
    run_id: string;
    repo_id: string;
    name: string;
    spec: string;
    status: "pending" | "queued" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";
    runner: string;
    claimed_by: string | null;
    exit_code: number | null;
    error: string | null;
    started_at: string | null;
    finished_at: string | null;
    /** Set when a job in a concurrency group took the group's slot. */
    concurrency_claimed_at: Generated<string | null>;
    /** When retention removed its log text (CORE-200). */
    logs_removed_at: Generated<string | null>;
  };
  ci_steps: {
    job_id: string;
    position: number;
    name: string;
    status: "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";
    exit_code: number | null;
    started_at: string | null;
    finished_at: string | null;
  };
  ci_logs: {
    job_id: string;
    seq: number;
    step: number;
    text: string;
  };
  ci_secrets: {
    repo_id: string;
    name: string;
    value: string;
    updated_at: Generated<string>;
  };
  repo_mirrors: {
    repo_id: string;
    url: string;
    username: Generated<string>;
    token_sealed: string | null;
    enabled: Generated<number>;
    prune: Generated<number>;
    status: Generated<"pending" | "syncing" | "ok" | "failed">;
    last_error: string | null;
    last_attempt_at: string | null;
    last_synced_at: string | null;
    last_synced_commit: string | null;
    lease_until: string | null;
    created_at: Generated<string>;
    updated_at: Generated<string>;
  };
  ci_job_tokens: {
    token_hash: string;
    job_id: string;
    expires_at: string;
  };
  /** Where a repository's code is deployed (CORE-78); rows outlive their previews. */
  deployments: {
    id: Generated<number>;
    repo_id: string;
    environment: string;
    timeline_slug: string | null;
    timeline_id: string | null;
    checkpoint_id: string | null;
    commit_oid: string;
    url: string | null;
    status: "active" | "sleeping" | "expired" | "failed";
    run_id: string | null;
    job_id: string | null;
    actor_id: string | null;
    agent_id: string | null;
    expires_at: string | null;
    created_at: Generated<string>;
    updated_at: Generated<string>;
    /** 1 for a preview rebuilt by a revival (CORE-79), not the original. */
    revived: Generated<number>;
    /** The earlier record of the same checkpoint a revival stands in for. */
    rebuilt_from: Generated<number | null>;
    /** 1 when the recorder set expires_at; otherwise the account's retention moves it. */
    expiry_pinned: Generated<number>;
    /** When the preview sweep expired it, and the teardown run it started. */
    torn_down_at: Generated<string | null>;
    teardown_run_id: Generated<string | null>;
  };
  /** Per-account settings; a missing row means the defaults. */
  /** The context attached to a step: a commit an agent made in a timeline (CORE-231). */
  step_contexts: {
    repo_id: string;
    change_id: string;
    commit_oid: string;
    author_id: string;
    accountable_id: string;
    timeline: string | null;
    issue_key: string | null;
    summary: Generated<string>;
    /** JSON StepContextBody. */
    context: Generated<string>;
    committed_at: string;
    verified_at: string | null;
    deleted_at: string | null;
    deleted_by: string | null;
    created_at: Generated<string>;
  };
  /** What a step run produced, by commit (CORE-235). */
  step_artifacts: {
    id: string;
    repo_id: string;
    commit_oid: string;
    run_id: string;
    kind: "test-summary" | "screenshot" | "document";
    /** JSON; for test-summary, StepTestSummary. */
    data: string;
    object_key: string | null;
    created_at: string;
  };
  /** A person's one set of generated avatar options (CORE-116). */
  avatar_generations: {
    user_id: string;
    status: "generating" | "ready" | "failed";
    /** JSON array of AVATARS keys, in display order. */
    options: Generated<string>;
    created_at: Generated<string>;
    finished_at: string | null;
  };
  account_settings: {
    account_id: string;
    preview_ended_days: Generated<number>;
    preview_idle_days: Generated<number>;
    updated_by: string | null;
    updated_at: Generated<string | null>;
    ai_knowledge: Generated<number>;
    ai_wiki: Generated<number>;
    ai_atlas: Generated<number>;
    ai_release_notes: Generated<number>;
    ai_classification_model: Generated<ClassificationModel>;
    ai_fast_model: Generated<GenerationModel>;
    ai_task_model: Generated<GenerationModel>;
    ai_updated_by: Generated<string | null>;
    ai_updated_at: Generated<string | null>;
  };
  /** Retention policies (CORE-196): what an account changed; absent inherits. */
  retention_policies: {
    account_id: string;
    category: string;
    enabled: number | null;
    /** JSON {key: number} of threshold overrides. */
    thresholds: Generated<string>;
    updated_by: string | null;
    updated_at: Generated<string>;
  };
  /** Site-scope categories, and site-wide defaults for account ones. */
  retention_site_policies: {
    category: string;
    enabled: number | null;
    thresholds: Generated<string>;
    updated_by: string | null;
    updated_at: Generated<string>;
  };
  /** Who changed which retention policy; account_id null at site level. */
  retention_policy_changes: {
    id: Generated<number>;
    account_id: string | null;
    category: string;
    actor_id: string | null;
    before: string;
    after: string;
    created_at: Generated<string>;
  };
  /** Cleanup runs (CORE-198): one per retention run; account_id null for the site. */
  cleanup_runs: {
    id: Generated<number>;
    account_id: string | null;
    trigger: "schedule" | "manual";
    actor_id: string | null;
    dry_run: number;
    status: "queued" | "running" | "succeeded" | "failed";
    as_of: string;
    items: Generated<number>;
    bytes: Generated<number>;
    error: Generated<string | null>;
    lease_token: Generated<string | null>;
    lease_until: Generated<string | null>;
    created_at: Generated<string>;
    started_at: Generated<string | null>;
    finished_at: Generated<string | null>;
    updated_at: Generated<string>;
  };
  /** A run's categories, with their thresholds, cursor and counts. */
  cleanup_run_categories: {
    run_id: number;
    position: number;
    category: string;
    /** JSON {key: number}. */
    thresholds: string;
    status: "pending" | "running" | "succeeded" | "failed";
    cursor: Generated<string | null>;
    items: Generated<number>;
    bytes: Generated<number>;
    batches: Generated<number>;
    error: Generated<string | null>;
    started_at: Generated<string | null>;
    finished_at: Generated<string | null>;
  };
}

export type UsageConstruct =
  | "d1"
  | "durable_objects"
  | "r2"
  | "artifacts"
  | "vectorize"
  | "ai_search"
  | "workers_ai"
  | "ci";

export type DB = Kysely<Database>;

/**
 * Kysely over a D1 binding. Built per call: it is cheap, and the runtime ties
 * a binding's I/O to the request that made it, so an instance cached across
 * requests fails with "Cannot perform I/O on behalf of a different request".
 */
export function db(d1: D1Database): DB {
  return new Kysely<Database>({ dialect: new D1Dialect({ database: d1 }) });
}

/** SQLite's ISO timestamp, matching the columns' defaults. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * D1 runs a batch as one transaction; Kysely over D1 has no transactions, so
 * atomic multi-statement writes compile their queries and send them here.
 */
export async function batch(
  d1: D1Database,
  queries: { compile(): { sql: string; parameters: readonly unknown[] } }[],
): Promise<D1Result[]> {
  if (queries.length === 0) return [];
  return d1.batch(
    queries.map((q) => {
      const { sql, parameters } = q.compile();
      return d1.prepare(sql).bind(...parameters);
    }),
  );
}
