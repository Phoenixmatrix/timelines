# Changelog

## Unreleased

### AI cancellation before dispatch

- Cancellation during account attribution or Gateway-policy preparation prevents
  model dispatch and does not create a phantom failed-attempt entry. Requests already
  dispatched retain their existing success, failure and timeout accounting.
  Gateway reconciliation remains strict.

### CORE-324: Timelines presentation without an identity cutover

- Public application, site, documentation, CLI and assistant presentation use
  Timelines while retaining the pounce logo. Technical keys, API headers,
  installation identifiers, repository slugs and hostnames remain unchanged.
- New system-authored commits use the Timelines display name; existing Git
  history is not rewritten. The assistant-profile migration updates only the
  original built-in description, preserving customized profiles, agent identities,
  revocation and credentials.

### CORE-150: bounded release-highlights proof cleanup and scheduling

- The owned provider fixture uses the normal highlights sweep with an exact
  scope, repository and viewer selector; unrelated due projections are excluded
  from admission. Scheduled cron sweeps remain unfiltered.
- Provider proof cleanup attempts appended-entry removal and all three policy
  restores independently, preserving the original proof error alongside any
  cleanup failures.
- Generated highlights prioritize concrete end-user capabilities and fixes over
  routine documentation and housekeeping, with detailed daily notes preserved
  as the authoritative sources.

### CORE-255: owned timeline work and compact canonical landing

- Each timeline owns a separate work Git repository per canonical repository.
  Full progress and rewrite predecessors remain there; canonical permissions and
  deletion tombstones govern every source-qualified read and write.
- Native timeline Git uses `/<owner>/<repo>@<slug>.git`. Canonical `timeline/*`
  pushes are refused with the timeline URL. The CLI pins immutable source IDs,
  keeps bound pushes out of the generic queue, and requires explicit unbinding.
- Same-source WIP branch merges compact normally, including a first merged push.
  Immutable first-observation provenance prevents later copies or source expiry
  from disguising known foreign work. Legacy conversion attributes historical
  timeline WIP to its owned source. Revision-origin storage is metered to the
  canonical repository's owner.
- Work push fences settle only on complete negotiated Git status consistent with
  the observed ref. HTTP failures and malformed or contradictory reports stay
  ambiguous; seeing the old tip alone cannot release the fence.
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
- Real-Git HTTP checks close bodyless request streams without an empty pipe write,
  avoiding an `EPIPE` race when the backend exits before the parent sends input.

See the [server contract](apps/website/README.md#timelines),
[CLI cutover](apps/cli/README.md#timelines), and
[retention controls](apps/website/README.md#data-retention) for operational details.
