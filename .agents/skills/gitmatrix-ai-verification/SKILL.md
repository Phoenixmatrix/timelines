---
name: gitmatrix-ai-verification
description: Verify changes to real knowledge builds, graph extraction, generated wiki, embeddings/Vectorize or AI Search using owned isolated resources. Required before claiming AI behavior works; ordinary ready intentionally does not run AI.
---

# Real AI verification

## When required

Run after changing knowledge scheduling/builds, extraction/model prompts, wiki generation, embedding/index schemas, AI Search indexing/retrieval, AI Gateway routing, or their API/UI consumers. `vp run ready` and `vp run agent test` cover non-AI journeys and real mirror transport, not AI correctness. Never infer AI correctness from their success.

## Prerequisites and command

Use this worktree's Linux agent workflow with Node 24+, Vite+, Rust, Git, Chromium dependencies and authenticated `cf` access. Discover operations with `cf cli search "<anonymous action/resource description>"`, then the selected command's help; never Wrangler. Select an authorized development account with `CLOUDFLARE_ACCOUNT_ID`; optionally select `GITMATRIX_CF_PROFILE`. The harness needs real Artifacts, Workers AI, Vectorize, AI Search and AI Gateway permissions, including Gateway log reads. Missing access is a blocker, not a reason to mock, skip or weaken assertions.

```sh
vp run agent test-ai
```

This builds this worktree's gm with Cargo freshness checks (compiled outputs may be reused), provisions uniquely named owned resources, migrates local databases, starts an isolated origin, seeds fixtures, and exercises real providers. It consumes paid inference, embeddings and provider storage/indexing, including knowledge work triggered by seeded repositories; run deliberately, not in automatic CI or in a retry loop. Four live environments per user and a 24-hour expiry apply. Never point it at the canonical development server or shared namespaces. Normal `agent setup` remains AI-enabled; only automatic non-AI test environments omit AI bindings/resources.

## Exact evidence and honest failures

The final `e2e.complete` event prints the local evidence directory. Inspect:

- `completion.json`: mode, overall success, environment ID, requested resource selection, cleanup state, failed lifecycle stages.
- `timings.json`: elapsed milliseconds and pass/fail for prepare, provision, migrate, start, seed, scenarios, shutdown and cleanup (executed stages only).
- `ai-e2e.json`: unique fixture repository, observed build status/commit, graph file/symbol membership, generated overview body/model/commit, exact entity and passage results, API observations and per-stage timings. `knowledge-build` and `index-visibility` are separate timings. `indexVisibility` records each retrieval attempt's elapsed time and separate `entityFound` / `passageFound` outcomes.
- `ai-e2e.json` also records real avatar generation (`avatars`) and owned Gateway records (`gateway`) for knowledge, explicit embeddings and assistant streaming/titles. It checks successful uncached inference, empty request/response payloads, and `text/event-stream` assistant responses. Avatar records must stay within the existing ten-call budget, with successful records matching the decoded images returned by the API; its existing contract permits partial generation when styles are refused. Cloudflare excludes AI Search's built-in Workers AI embedding/reranking from Gateway logs/analytics; keep that documented exception separate from application embeddings.

The Copper Finch fixture must produce a successful build of its pushed commit; a `checksum.ts` file linked to `copperFinchChecksum`; a generated overview explaining checksum behavior at that commit; and both the matching Vectorize entity and an AI Search code passage containing the fixture function and modulus. After the daily and tag release-note stages, it completes a `CF-1` tracker issue in a workspace subscribed to the fixture and pushes a commit citing it on a new day: that day's notes must hold an issue entry for `CF-1` (team `CF`, the citing commit, a recorded model, non-internal, describing batch parcel verification), the earlier tag's notes must not change, and the `team:cf` feed must include it (`ai-e2e.json` keeps `issueNotes` and `teamFeed`). Last, it pushes twice to a `timeline/copper-limits` bookmark forked before that commit: each push's overlay must be up to date at the pushed commit, measured against main's indexed commit from the fork point, list the added `limits.ts` file and its new symbols, and never list main's own files, while main's graph, wiki pages and builds stay exactly as before (`overlay`, `overlayMain`). Then it forks a tracked `timeline/copper-pages` from main, pushes a `receipts.ts` commit and makes a checkpoint: the checkpoint's wiki page set must succeed at that commit, measured against main's indexed commit, with at least one written component or glossary page (a component page records its model and describes the receipts), visible through the pages API and the checkpoint view, while main's graph, wiki and builds still stay as before (`timelinePages`). These are real assertions, not a non-empty-result check. A provider failure, missing wiki, graph mismatch or index-visibility deadline fails the command. Build timeout means inspect build status/phase; search timeout after a successful build means inspect indexing/visibility and the separate entity/passage evidence. Do not turn a provider outage into a pass.

Beside it, the Semantic Code Atlas runs against the same real providers (`tools/agent/atlas-provider-e2e.ts`, evidence under `atlas` in `ai-e2e.json`). A ledger repository's two capabilities, each spanning two folders, must be named and summarized by the default model with provenance (model, basis repository/commit/build) and citations at the snapshot's commit, drilled through on the Knowledge tab from capability to file to its blob, with no Atlas call or build while browsing. A shop repository importing the ledger's registry package (published to the npm feed and granted as its source) must resolve to it in the workspace Atlas, citing a source in each repository at its own commit. A README push must reuse prose whose inputs didn't change and publish within 30 seconds of the graph. Then three accounts the environment configures through `ATLAS_CONFIG` (`ATLAS_PROVIDER_CONFIG`) build the ledger again: marco with no priced model (`disabled`, no call), jun with a model Workers AI refuses (`provider_error`, failed calls charged once, never retried) and sam with a one-call build cap (one current summary, the rest `budget_exhausted` with cap `calls`). Each keeps its structure and sources and shows its Map state notice and inspector note. `providerUsage` lists every Atlas call with its tokens and cost.

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
