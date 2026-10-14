# Changelog

## Unreleased

### CORE-341: Organizations, Spaces and Tracker Projects

- Separate personal Accounts, Organization directories and Space-owned content.
  Organization ownership does not imply private Space access; explicit grants,
  resource collaborators and existing Instance powers retain distinct boundaries.
- Add Organization/Space navigation and canonical Space-qualified creation and
  settings. Tracker Workspaces become Projects, including multi-Project issues,
  filters, history, CLI commands and versioned synchronization.
- Send human request answers and cancellations with the same versioned Space,
  migration-epoch and timeline envelope as other Tracker mutations.
- Bind content reads, queued work, AI provenance and retained assistant content
  to current Space/source authorization. Revoked or unverifiable conversations
  cannot be reopened, exported or reused; their stored data remains intact.
  Mixed repository/tracker release notes revalidate both authorized projections,
  including when only public or collaborator access survives; later reads cannot
  overwrite the source obligations of older retained content.
  Issue-linked work also revalidates its filtered repository content when Space
  membership survives, and receipts bind the actual returned body rather than a
  later, differently filtered response.
  Retention also supports never-opened native Spaces without relaxing scope checks.
- Preserve the assistant composer's identity and initial-history mode when delayed
  history arrives, so opening a fresh conversation does not reset slash-skill
  completion or discard its first sent message while loading conversation access.
- Keep Chronicle playhead gestures ahead of older navigation acknowledgements,
  without losing keyboard steps or overriding Back and Forward.
- Keep fast typing in the Atlas lookup: a late address update from the field's
  own earlier text no longer resets newer input as if it were Back/Forward.
- Preserve Tracker sort, filters and URL fragments through keyboard navigation,
  grouping and browser history. Stale URL updates no longer cancel release-note
  navigation or restore an inspector closed by Forward.
- Release a Sandbox purge's cutover admission before resetting its Durable Object,
  so the reset cannot abort the purge response or interrupt ticket cleanup.
- Cancel revoked CI without accepting logs or success, and settle the run only
  after launched work acknowledges shutdown. Recheck live authority when Workflow
  step errors cross serialization, and report late cancellation truthfully in gm.
- Require an explicitly approved ownership manifest and source checkpoint for
  legacy conversion. Independent fences, resumable journals and atomic cyclic
  schema reconstruction preserve coordinated recovery before new writes reopen.
  Incompatible clients and unresolved offline writes remain fenced with lossless
  export rather than silent replay or discarded operations.
  Unopened legacy Trackers ignore runtime naming metadata during approved
  initialization, while existing business tables still prevent reinitialization.
- Replace the Space cutover's unprovable provider drain with an Artifacts ref
  barrier: under the fence, before write admission and once after, every
  repository's Artifacts refs must match the push log. Divergences are
  journaled, logged with no known pusher, and their push effects replay only
  after admission under a current human session's credential.
- Acknowledge cutover consumers from evidence instead of never: the drain
  accepts a consumer once fences are closed, the preparation release serves, no
  tickets remain and Cloudflare's documented 15-minute execution bound (plus
  margin) has passed; Workflows instead require the provider's own instance
  census, whose remaining legacy instances the drain terminates.
- Make real-AI verification work from hosted source snapshots without Git metadata:
  verify the committed manifest, select full coverage and bind resumable evidence
  to the entire source revision without weakening the failure cooldown.
- Extend real-provider checks to private content in four Spaces across two
  Organizations and retained assistant/Atlas reads before and after an actual
  native app restart. Native fixtures preserve the original source-reservation
  credential and current Tracker epoch; they do not bypass live authorization.
- Preserve the structured `TimelineEnded` reason across paid Knowledge workflow
  steps, so ended-source cancellation cannot be mistaken for successful publication.
  Inspect Atlas fixture spend through the running app instead of opening a
  competing local SQLite runtime while builds are active.

### CORE-277: readable History checkpoints

- History collects issue and timeline checkpoints into one count per issue,
  rather than drawing overlapping flags on the chart. The count opens dated,
  attributed summaries in the inspector; long summaries wrap.
- Each checkpoint can move the playhead to its time without losing the visible
  window or selected range. Keyboard access, browser back/forward, and the
  phone/List layout use the same checkpoint details.
- Counts follow the visible window, not the extra history loaded for panning.
  Work spans and other event markers retain their existing chart interactions.

### AI cancellation before dispatch

- Cancellation during account attribution or Gateway-policy preparation prevents
  model dispatch and does not create a phantom failed-attempt entry. Requests already
  dispatched retain their existing success, failure and timeout accounting.
  Gateway reconciliation remains strict.

### CORE-324: Timelines branding and address migration

- Public application, site, documentation, CLI and assistant presentation use
  Timelines while retaining the pounce logo. The application moves to
  a new production address, with `matrixorg/timelines` and its corresponding
  GitHub mirror as the public repository names. Internal resource names,
  technical keys, API headers and installation identifiers remain unchanged.
- New system-authored commits use the Timelines display name; existing Git
  history is not rewritten. The assistant-profile migration updates only the
  original built-in description, preserving customized profiles, agent identities,
  revocation and credentials.
- Repository administrators can rename a canonical repository in place without
  moving its physical Git storage or changing IDs, source identities, grants or
  history. Parent-timeline forks resolve renamed repositories by stable ID.
- Live timeline, checkpoint, landing and approval views, subscription navigation
  and Atlas workspace choices resolve current repository names by stable ID.
  Frozen tracker records and replica cursors remain unchanged.
- GitHub backup renames run through the mirror administrator API, fenced by the
  expected remote repository ID and mirror lease. One-operation administration
  credentials do not replace the stored push credential. Provider redirects
  are rejected using Workers-supported manual redirect handling, without
  forwarding credentials.
- The production cutover preserves existing CLI credentials, local tracker
  replicas and issue leases while moving their server namespaces and Git
  remotes. Browser sessions require sign-in at the new hostname.
- Assistant write instructions ground approval state in the specific call's
  recorded result, not item names or inferred history. New explicit requests
  need their own approval cards; declined calls are not retried automatically.

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
