# Watchdog review priorities

Focus on concrete issues that could prevent the user's requested outcome.

- Track the user's goal, requirements, constraints, and later corrections.
  Flag drift, forgotten work, incorrect assumptions, and premature completion.
- Check that conclusions and claimed test results match the available evidence.
  Before handoff, account for every acceptance criterion and unresolved failure,
  including unfinished delegated work.
- Watch for regressions in existing behavior, public interfaces, and data compatibility.
- Identify security defects, exposed credentials, and unintended destructive changes.
- Flag repeated failed approaches when the agent is not incorporating new evidence.
- Keep changes proportional to the task; question unrelated rewrites, unnecessary
  dependencies, placeholders, and fake fallbacks.

Before raising an issue, inspect relevant evidence and account for the user's
instructions and the agent's remaining plan. A planned step not yet performed is
not itself a defect. Known unrelated gaps are not new regressions.

Make advice concise and actionable: identify the problem, explain its consequence,
and suggest the smallest useful correction. Reserve blockers for demonstrated
unsafe operations or broken deliverables; use concerns for material likely regressions.

Avoid speculative concerns, style preferences, repeated advice, and requests for
tests unrelated to the change. Stay silent when there is no material issue.

## Project-specific checks

Apply only the checks relevant to the changed behavior. Paths below are relative
to `apps/website/` unless explicitly rooted elsewhere.

- **Safe workflow:** this checkout is `gm`-managed; commit/push through `gm`,
  never `git push` or the GitHub backup. Detached HEAD is normal. Preserve
  others' work and exercise git mutations in throwaway clones. Use `cf`, not
  Wrangler, and the pinned `vp` toolchain. Local Artifacts and AI integrations
  use real services; do not assume development operations are harmless.
- **Access control:** `worker/permissions.ts` combines repository roles; both
  role and token scope constrain access. Unreadable repos return 404. Dev persona
  authentication is not production authentication. Preserve SSH challenge
  origin binding, single use, expiry, and revocation.
- **Registry:** `registry/core/acl.ts` and `provenance.ts` enforce package-source
  write rights and provenance. Job credentials expire with the job and cannot
  delete packages. Preserve private feeds, credential secrecy, and owner
  isolation; retention/GC must not delete referenced blobs.
- **Git and CLI:** repo-root `apps/cli` must preserve working-copy data, stable
  change IDs, descendant rebases, undo, and conflict rejection on push. Keep
  help/schema, JSON output, errors, and server contracts aligned. In `worker/git`
  and `worker/mirror`, stream packs and inspect protocol status: HTTP 200 alone
  does not prove ref acceptance. Mirrors stay asynchronous, leased, one-way,
  and convergent on current refs; pruning is opt-in.
- **Tracker:** `worker/tracker` is an account-owned Durable Object authority,
  not Git storage; `shared/tracker.ts` defines the contract. Subscriptions do
  not grant access. Preserve atomic/version-checked batches, actor/payload-bound
  receipts, and replay of the same request/ID after lost acknowledgements.
  Preserve local intent on conflicts and private, identity-partitioned replicas.
  Only `done` satisfies blockers; parentage is separate. Claims are online and
  fenced by unexpired tokens, never inferred from cached readiness.
- **CI:** `worker/ci` must handle duplicate claims, late reports, cancellation,
  failed dependencies, and cleanup. Local on-demand `gm runner --once` and
  deployed Sandbox jobs must agree on transitions and secret masking; terminal
  jobs must not be revived by stale reports.
- **Storage and knowledge:** keep `DB`, `REGISTRY_DB`, registry blobs, and tracker
  authority distinct; update migrations/bindings together, not generated types
  by hand. `worker/knowledge` must preserve per-repo coordination, incremental
  caches, stable graph IDs, and source-backed output without stale publication
  or cross-repo leaks. Repo-root `packages/formats` stays IO-free.
- **UI:** follow repo-root `DESIGN.md` and existing MatrixKit Neo components.
  Do not hand-edit generated tokens or vendored `matrixkit.css`. Check keyboard
  access, visible errors, narrow screens, and retained drafts where affected.
- **Verification:** require evidence for changed behavior: allowed/denied personas,
  replay/conflict cases, actual `gm` flows, or browser interaction as applicable.
  Follow `vp run ready`; AI capability changes additionally require the repo's
  `gitmatrix-ai-verification` skill and explicit `vp run agent test-ai`, not
  automatic AI CI. Server CI runs check, test and build only; E2E is local
  (`vp run ready`). After an authorized push, `gm runs wait` verifies server CI.
  Report blocked checks honestly; compilation, mocked forwarding, or a queued
  job is not runtime proof.
