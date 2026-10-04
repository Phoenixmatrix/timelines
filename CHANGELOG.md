# Changelog

## Unreleased

### CORE-255: owned timeline work and compact canonical landing

- Each timeline owns a separate work Git repository per canonical repository.
  Full progress and rewrite predecessors remain there; canonical permissions and
  deletion tombstones govern every source-qualified read and write.
- Native timeline Git uses `/<owner>/<repo>@<slug>.git`. Canonical `timeline/*`
  pushes are refused with the timeline URL. The CLI pins immutable source IDs,
  keeps bound pushes out of the generic queue, and requires explicit unbinding.
- Landing applies the approved logical-base-to-work tree delta onto pinned main,
  gates a single-parent candidate, and records exact integration provenance.
  WIP commits are not uploaded to canonical. All repositories prepare and gate
  before main advancement; moving main requires re-preparation. Partial results
  and uncertain CAS outcomes remain visible and recoverable without rollback.
  Dependency transport failures defer recovery without invalidating tested sibling
  candidates or successful receipts.
- Nested and explicitly merged work use exact admitted ancestry and a reviewed
  dependency baseline. Late local sync preserves unintegrated or rewritten work,
  leaves ordinary conflicts visible, and refuses unavailable lineage.
- CI, previews, checkpoints, steps, release provenance, wiki and code links carry
  source identity. Expired Git returns explicit unavailability, never main under
  a timeline label. Retained published wiki remains readable after Git expiry.
- Work overlay graph topics have stable ordering: adding a work-only file does
  not create false changes on an unchanged canonical file through topic order.
- **Retention change:** `timeline-work-sources` is enabled by default at **30 days
  after landing / 90 days after abandonment**. Administrators can configure both
  durations or disable it in Data retention. Tracker detail, published knowledge
  and previews retain independent policies. Live dependencies, unresolved
  operations and unacknowledged consumers delay physical deletion.
- Consumer shutdown is acknowledged before releasing its Git claim. Sandbox jobs
  stop their container before terminal reporting; Workflow watchdogs retain claims
  when completion or termination cannot be confirmed.
- Legacy active/experimental timelines require `gm timeline migrate <slug>`;
  completed records retain canonical-historical provenance. Migration never rewrites
  existing canonical history. Stopped or partial legacy landings require explicit
  versioned resolution before conversion.
- `vp run agent up --sandbox` exercises actual Docker-backed Sandbox CI in the
  isolated development environment. Default readiness remains local Linux CI.

See the [server contract](apps/website/README.md#timelines),
[CLI cutover](apps/cli/README.md#timelines), and
[retention controls](apps/website/README.md#data-retention) for operational details.
