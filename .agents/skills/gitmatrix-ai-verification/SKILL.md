---
name: gitmatrix-ai-verification
description: Verify changes to real knowledge builds, graph extraction, generated wiki, embeddings/Vectorize, AI Search, the assistant, release notes, avatars or the Atlas using owned isolated resources, and decide when an agent environment needs paid AI at all. Required before claiming AI behavior works; ordinary ready and agent setup intentionally run no AI.
---

# Real AI verification

## When required

Run after changing knowledge scheduling/builds, extraction/model prompts, wiki generation, embedding/index schemas, AI Search indexing/retrieval, AI Gateway routing, the assistant, release-note generation, avatars, Atlas descriptions, or their API/UI consumers. `vp run ready` and `vp run agent test` cover non-AI journeys and real mirror transport, not AI correctness. Never infer AI correctness from their success.

## AI is opt-in everywhere else

AI costs real money (CORE-284), so nothing turns it on by default:

- `vp run agent setup` provisions no Workers AI, AI Gateway, Vectorize or AI Search, and seeds without paid Knowledge builds. The UI shows its honest AI-off states; that is the expected state for almost all work, including UI around AI features (browser-mode tests cover those against canned APIs).
- `vp run agent setup --ai` (after `vp run agent destroy` when an environment exists, or `reset --ai`) only when the change is to knowledge, wiki, embeddings, AI Search, the assistant, release-note generation, avatars or Atlas descriptions and you need to see it working with real models interactively. `vp run agent status` shows each environment's `ai`. Destroy it when done: an AI environment's pushes start paid builds.
- The canonical `vp dev` binds no AI unless started with `GITMATRIX_DEV_AI=enabled`; it prints which when it starts. Never opt it in to build large repositories (this one cost ~$44).

## Prerequisites and command

Use this worktree's Linux agent workflow with Node 24+, Vite+, Rust, Git, Chromium dependencies and authenticated `cf` access. Discover operations with `cf cli search "<anonymous action/resource description>"`, then the selected command's help; never Wrangler. Select an authorized development account with `CLOUDFLARE_ACCOUNT_ID`; optionally select `GITMATRIX_CF_PROFILE`. The harness needs real Artifacts, Workers AI, Vectorize, AI Search and AI Gateway permissions, including Gateway log reads. Missing access is a blocker, not a reason to mock, skip or weaken assertions.

```sh
vp run agent test-ai --dry-run   # which stages your change maps to, and why; spends nothing
vp run agent test-ai             # run them
```

### Targeted stages

test-ai runs only the stages that the paths you changed against `origin/main` (commits, working tree, untracked files) map to, plus the stages they build on (`requires`). Each stage is defined beside the code that runs it, with its path globs: `COPPER_FINCH_STAGES` in `tools/agent/provider-e2e.ts` (classification, knowledge, search, assistant, avatars, knowledge-edit, release-notes, release-highlights, overlays, timeline-pages, repository-deletion, queue) and `ATLAS_STAGES` in `tools/agent/atlas-provider-e2e.ts` (atlas-describe, atlas-workspace, atlas-reuse, atlas-disabled, atlas-refused, atlas-exhausted). Paths in `SHARED_PATHS` (`tools/agent/ai-stages.ts`: bindings, Worker entry points, Gateway and model layer, AI settings, the harness lifecycle, dependency versions) run every stage. A change that maps to nothing provisions nothing and exits successfully.

- `--stage <id>[,<id>]` and `--all` add stages; nothing removes a stage whose code changed. `--base <ref>` compares against another ref.
- `--resume` after a failure reruns the failed, unreached and changed stages. It reuses a stage's latest successful attempt across runs that skipped it only while the merge base and mapped changed content remain unchanged. A later failed or incomplete attempt invalidates that evidence. Prerequisites still run (the environment is new).
- Within 30 minutes of a failed run, a full run is refused, and so is any rerun when nothing those stages verify has changed, unless `--force`. Inspect the evidence and fix the cause; never run test-ai in a loop. Use `--force` only for a provider outage you've confirmed.
- When you change code a stage verifies but its globs don't cover, extend that stage's `paths` in the same change (`ai-stages.test.ts` checks every mapped path exists and runs its stage).

Every selected stage keeps all of its real assertions; a targeted run is the same verification, only of fewer stages.

This builds this worktree's gm with Cargo freshness checks (compiled outputs may be reused), provisions uniquely named owned resources, migrates local databases, starts an isolated origin, seeds fixtures, and exercises real providers. It consumes paid inference, embeddings and provider storage/indexing, including knowledge work triggered by seeded repositories; run deliberately, not in automatic CI or in a retry loop. Four live environments per user and a 24-hour expiry apply. Never point it at the canonical development server or shared namespaces. test-ai always provisions its own AI environment; it doesn't need (or use) a `setup --ai` environment.

## Exact evidence and honest failures

The final `e2e.complete` event prints the local evidence directory. Inspect:

- `completion.json`: mode, overall success, environment ID, requested resource selection, cleanup state, failed lifecycle stages, and the AI stages run (`aiStages`) with their outcomes (`aiStageOutcomes`, `failedAiStages`).
- `ai-e2e.json` `selection`: the merge base, changed paths, each run stage's reasons (`changed` with the matching paths, `requested`, `all`, `required` by which stages) and each skipped stage's reason; `stages`: each stage's outcome; `cost`: the owned Gateway's logged spend for the run (calls, USD, per model; AI Search's built-in embedding/reranking excluded) and the Atlas's own recorded usage.
- `timings.json`: elapsed milliseconds and pass/fail for prepare, provision, migrate, start, seed, scenarios, shutdown and cleanup (executed stages only).
- `ai-e2e.json`: unique fixture repository, observed build status/commit, graph file/symbol membership, generated overview body/model/commit, exact entity and passage results, API observations and per-stage timings. `knowledge-build` and `index-visibility` are separate timings. `indexVisibility` records each retrieval attempt's elapsed time and separate `entityFound` / `passageFound` outcomes.
- `ai-e2e.json` also records real avatar generation (`avatars`) and owned Gateway records (`gateway`) for knowledge, explicit embeddings and assistant streaming/titles. It checks successful uncached inference, empty request/response payloads, and `text/event-stream` assistant responses. Avatar records must stay within the existing ten-call budget, with successful records matching the decoded images returned by the API; its existing contract permits partial generation when styles are refused. Cloudflare excludes AI Search's built-in Workers AI embedding/reranking from Gateway logs/analytics; keep that documented exception separate from application embeddings.
- `ai-e2e.json.modelFailures` retains sanitized `ai.model.failed` records from the owned server log before cleanup, even when a stage fails. Each includes an attempt UUID (also in Workers AI Gateway metadata), safe attribution, dispatch state, finite failure category and numeric codes—not raw error messages, stacks, causes, prompts or responses. Local deadlines and stopped/expired work are distinct from provider rejection. Inspect read status and invalid/omission counts: collection is bounded to the final 8 MiB, 4 KiB per line and 256 events. Missing or truncated evidence cannot prove that no failure occurred. An app/Gateway count mismatch alone is not a confirmed provider outage and never justifies weakening reconciliation or an unchanged forced rerun.

`knowledgeUpdates` keeps the explicit rebuild's and the next push's build modes and metered model usage (CORE-286): the rebuild runs `full`, the push's build must be an `update` and ask the model fewer times.

The Copper Finch fixture must produce a successful build of its pushed commit;
a `checksum.ts` file linked to `copperFinchChecksum`; a generated overview
explaining checksum behavior at that commit; and both the matching Vectorize
entity and an AI Search code passage containing the fixture function and modulus.
After daily/tag release-note stages, it completes `CF-1` in a subscribed
workspace and pushes a citing commit on a new day. That day's issue entry must
record `CF-1`, team `CF`, the commit and a model, be non-internal and describe
batch parcel verification; the earlier tag stays unchanged and `team:cf` includes
it (`issueNotes`, `teamFeed` in `ai-e2e.json`).

The owned-source stages in `tools/agent/provider-e2e.ts` create `copper-limits`
through the timeline API at a pinned earlier canonical snapshot. They assert
`work_<id>` identity, `timeline-work` kind, timeline/repository identity,
`refs/heads/work`, and exact logical-base commit/tree, then push twice through
`/<owner>/<repo>@<slug>.git` to `HEAD:refs/heads/work`. The local branch
and overlay label `timeline/copper-limits` are not a canonical timeline branch.
Source-qualified overlays must track both exact heads, add `limits.ts` and its
symbols, measure against main's indexed graph from the pinned fork point, and
exclude canonical-only files. Owned transport must advertise the acknowledged
head; the source-qualified timeline Atlas must show `limits.ts`, not main's
`verify-all.ts`. Main's refs, graph, wiki and builds must remain unchanged
(`overlay`, `overlayMain`).

Next, a distinct API-created `copper-pages` source receives `receipts.ts` and a
checkpoint. Its source ID, exact commit/tree and logical base must survive the
checkpoint and generated page set. The page set must succeed at that commit
against main's indexed graph and write a component or glossary page (component
prose records a model and describes receipts), visible via API and checkpoint
view. Its overlay must contain receipts and exclude `limits.ts`: two owned
sources sharing physical ref `work` must not share graph changes. Main remains
unchanged (`timelinePages`). These are required assertions, not a claim that a
particular run passed. A provider failure, missing wiki, graph mismatch or
index-visibility deadline fails the command. Build timeout means inspect build
status/phase; search timeout after a successful build means inspect indexing and
the separate entity/passage evidence. Never turn a provider outage into a pass.

The compact-landing stage must land the approved source tree as a single-parent
canonical commit without importing WIP ancestry, then read its release provenance.
After the work Git source expires, its commit API must return 410 while the same
published timeline page remains readable with unchanged body, source ID and
`generatedIn`. Do not expire `ended-timeline-data` to release completed producers:
published output has separate retention, and live Workflow claims must drain
through confirmed completion or termination.

Beside it, the Semantic Code Atlas runs against the same real providers (`tools/agent/atlas-provider-e2e.ts`, evidence under `atlas` in `ai-e2e.json`). A ledger repository's two capabilities, each spanning two folders, must be named and summarized by the default model with provenance (model, basis repository/commit/build) and citations at the snapshot's commit, drilled through on the Knowledge tab from capability to file to its blob, with no Atlas call or build while browsing. A shop repository importing the ledger's registry package (published to the npm feed and granted as its source) must resolve to it in the workspace Atlas, citing a source in each repository at its own commit. A new commit with the exact same Git tree must reuse every capability's prose and immutable inference provenance with zero Atlas calls or spend, advance the snapshot's structural source basis to the new commit/build, and publish within 30 seconds of the graph. This isolates commit-only cache reuse; changed-input invalidation is covered by the Atlas unit contracts, not by assuming a README edit leaves a capability unaffected. Then three accounts the environment configures through `ATLAS_CONFIG` (`ATLAS_PROVIDER_CONFIG`) build the ledger again: marco with no priced model (`disabled`, no call), jun with a model Workers AI refuses (`provider_error`, failed calls charged once, never retried) and sam with a one-call build cap (one current summary, the rest `budget_exhausted` with cap `calls`). Each keeps its structure and sources and shows its Map state notice and inspector note. `providerUsage` lists every Atlas call with its tokens and cost.

Build completion does not imply immediate provider search visibility. The visibility check keeps at most six paid retrieval calls, with waits of 20, 40, 60, 80 and 100 seconds (five minutes total). Both exact-result assertions must pass in the same response; the longer wait does not accept missing entities or passages.

For retained CI evidence, set `GITMATRIX_CI_ARTIFACTS_DIR` to a private absolute job-specific directory outside the disposable checkout. Only allowlisted sanitized JSON reports are retained there, including failures. Never upload raw server/build logs, credentials, environment journals, browser storage or screenshots. Local logs remain available in the owned artifact directory for diagnosis.

## Changed-path extensions

Baseline coverage is deliberately small. Extend `tools/agent/provider-e2e.ts` with a deterministic tiny fixture and consumer-visible assertion when the changed capability is not covered:

- Scheduling/invalidation: push a second meaningful source change, wait for its exact commit, assert updated graph/wiki and stale output removal.
- Extraction/graph: add the changed language construct and assert its named node, path and relationship, not merely graph size.
- Wiki: inspect the changed page's prose, provenance/model/commit and relevant source facts; UI changes additionally require opening the real wiki surface.
- Vectorize: query for the changed named entity and verify its identity/path and repository isolation.
- AI Search: assert exact source passage kind/path and discriminating fixture content; verify metadata filtering when changed.
- Failure behavior: exercise the real capability-specific failure boundary without fake provider success, then prove cleanup.

Keep provider calls bounded and source fixtures free of secrets. Preserve independent mirror coverage in `agent test`; do not reattach AI checks to ready or CI.

## Cleanup

The command waits for its work and always attempts owned shutdown/deletion, retaining evidence before it returns or throws. `cleanup: deleted` is the success condition. If deletion fails, preserve the ownership journal and use `vp run agent status` to inspect ownership; use `vp run agent cleanup --expired` for the expiry sweep. The installed hourly user-systemd maintenance retries expired resources. `vp run agent destroy` targets the persistent setup environment, not an arbitrary ephemeral test run. Never manually edit ownership records or delete shared resources. Report pending cleanup as a blocker, with the environment ID and sanitized evidence.
