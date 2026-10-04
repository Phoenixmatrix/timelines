# Timelines as Artifacts forks (CORE-252)

Date: 2026-10-04.

Status: research, folded into CORE-255 (2026-10-04). The owner chose
CORE-255's compact landing: a timeline lands as one new single-parent commit on
canonical, with its full history kept in the timeline's repository. So the
landing parts below (real merges built from the fork's commits, the "Landing"
design, and question 1) are superseded; CORE-255 owns the implementation. What
still applies, as research for CORE-255:

- The [Artifacts fork facts](#cloudflare-artifacts-forks-facts) (cost, limits,
  what a fork copies, moving objects between repositories, `read_only` not
  enforced).
- The [inventory](#inventory-who-uses-timeline-bookmarks) of everything that
  reads `timeline/<slug>`, and its hazards: the orphan sweep would delete live
  forks, and repository deletion and inventory don't know about them.
- Two owner decisions: a timeline's git URL is `/<owner>/<repo>@<slug>.git`
  (pushing `timeline/*` to the canonical URL is refused with a hint), and
  ended timelines' repositories are kept read-only, then deleted 30 days after
  landing and 90 after abandoning, configurable in settings.

## Summary

- **Each (repository, timeline) pair gets its own Artifacts repository: a fork
  of the canonical repository, or of the parent timeline's fork.** Gitmatrix
  records it in a new D1 table, `timeline_sources`. Inside the fork the
  timeline's work keeps its current ref name, `refs/heads/timeline/<slug>`,
  next to a copy of canonical `main` that Gitmatrix keeps current. Every ref
  string in CI, the push log, environments, knowledge and gm stays the same.
  Only the store behind the ref changes.
- **A timeline gets its own git URL, `/<owner>/<repo>@<slug>.git`.** The proxy
  authorizes it against the canonical repository and forwards it to the fork
  unchanged. Before it advertises refs, it brings the fork's `main` up to date.
  A push to `timeline/*` on the canonical URL is refused with a message giving
  the timeline URL. Fully transparent routing behind the canonical URL was
  evaluated and rejected: it needs a multi-repository upload-pack multiplexer.
- **Landing stays a real merge.** The one new step is that the Worker copies
  the checkpoint's objects from the fork into the canonical repository in the
  same receive-pack that creates `gitmatrix/landing/<slug>`. This replaces
  today's empty-pack ref write. The merge job, the gates, compare-and-swap,
  `partly landed` and the approval pinning don't change. This is the "pull
  request from a fork" step: GitHub copies the fork's objects into the base
  repository the same way.
- **Worker-side reads use a layered reader: the fork first, then canonical.**
  Commit ids are content hashes, so a layered reader is always correct. It
  fixes every place where code assumes timeline and main commits share one
  store, such as the knowledge `mergeBase` and blame.
- **What this fixes and what it doesn't.**
  - It fixes: no `timeline/*` refs in canonical repositories, and abandoned or
    rewritten timeline objects never enter canonical storage. Today they stay
    there forever, because Artifacts has no GC (`worker/git/unreachable.ts`).
    It also makes each timeline's storage deletable.
  - It doesn't fix: landed work still enters `main` through the merge's second
    parent. That is the decided landing semantics. Removing it is what
    CORE-255 proposes.

## Cloudflare Artifacts forks: facts

Sources:

- The generated binding types (`cf workers types`, then
  `apps/website/.cloudflare/types/index.d.ts`, "Artifacts").
- The Artifacts docs ([binding][a-binding], [REST][a-rest],
  [repositories][a-repos], [how it works][a-how], [limits][a-limits],
  [pricing][a-pricing], [git protocol][a-git], [metrics][a-metrics]),
  consulted on 2026-10-04.
- An experiment on 2026-10-04 in the `gitmatrix-dev` namespace with throwaway
  `core252-test-*` repositories, all deleted afterwards.
- CORE-228's probe from the same day, which used the native binding under
  `cf dev` (recorded in CORE-228 and CORE-255).

| Question                               | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Evidence                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| What does the binding offer?           | Namespace: `create`, `get`, `import`, `list`, `delete`. Repository: `createToken`/`listTokens`/`revokeToken`, `info` (`source`, `readOnly`, `defaultBranch`), `readCommit`, `readTree`, `readBlob`, `readFile`, `log` (first parent only), and `fork(name, {description, readOnly, defaultBranchOnly})`. There is no ref listing or ref write, no cross-repository object fetch, no fork at a chosen commit, and no update of `readOnly` after creation.                              | Generated types; [binding docs][a-binding]. REST adds the same `fork` (`POST …/repos/:name/fork` with body `name`, `description`, `read_only`, `default_branch_only`; the response includes `objects`). The cf CLI's `artifacts namespaces repos fork --body` drops `name` (400/10101), as CORE-228 also found. The REST call works. |
| Is a fork cheap, copy-on-write?        | **Unknown, so budget it as a full copy.** A fork is synchronous and took **7.2–8.8 s** whatever the size: 7.7 s for 5.4 MB and 6,099 objects (Gitmatrix's history), 7.2 s for 60 MB in 8 objects, 8.8 s for a fork of a fork. That suggests storage-level copying or sharing, but the docs don't say, and pricing counts storage "across all repositories".                                                                                                                           | Timed REST calls. The `objects` field equals the parent's full object count. The [blog][a-blog] and docs are silent on copy-on-write.                                                                                                                                                                                                |
| What does a fork copy?                 | **Every ref and every object, unreachable ones included.** With `default_branch_only: true` the fork still had all of the parent's branches. After every branch except `main` was deleted from the parent, a new fork still reported all 6,111 objects and could read an unreachable commit by id. CORE-228 saw the same `defaultBranchOnly` behaviour through the binding.                                                                                                           | `ls-remote` of forks made with `true` and `false`, and `GET …/commit/<oid>` on a fork made after the refs were deleted.                                                                                                                                                                                                              |
| Can you fork a fork?                   | **Yes.** `info().source` names the immediate parent (`artifacts:gitmatrix-dev/core252-test-fork`).                                                                                                                                                                                                                                                                                                                                                                                    | Fork of a fork: 6,102 objects, which is the parent's 6,099 plus 3 pushed afterwards.                                                                                                                                                                                                                                                 |
| Are a fork and its parent independent? | **Yes.** A push to the fork is invisible to the parent (`Commit not found`), and the reverse is also true. **Deleting the parent leaves the fork complete**: a mirror clone of the fork of a fork passed `git fsck --full` with 275 commits after the root was deleted. Tokens are per repository, and a parent's token gets 403 on the fork (CORE-228).                                                                                                                              | REST commit reads, plus a clone and `fsck` after the delete.                                                                                                                                                                                                                                                                         |
| Can objects move between forks?        | **Only through the git protocol.** No API copies between repositories. Because a fork shares history ids, a v2 `fetch` from the fork (want the tip, have the parent's tip) followed by a `receive-pack` into the parent moves only the new objects: **3 objects, 297 bytes** with `git push`, and **9 objects, 1,556 bytes** with a client-free script built like `worker/ref-log/record.ts` and `worker/timelines/bookmarks.ts`. That proves the Worker can do it without a sandbox. | `git push --progress` output, and `node copy.mjs` (v2 fetch, then receive-pack with `report-status atomic`), which returned `unpack ok`, `ok refs/heads/core252-worker-copy`.                                                                                                                                                        |
| Can the Worker read a fork?            | **Yes, like any repository.** `ARTIFACTS.get(forkName)` with `readCommit`/`readTree`/`readBlob`. A repository asked by git for an object it lacks answers **HTTP 500** (not a clean error), so fallbacks should use the binding, whose `readCommit` returns null.                                                                                                                                                                                                                     | REST `GET …/commit/<oid>` on fork and parent; `git fetch <oid>` against the parent.                                                                                                                                                                                                                                                  |
| Is a read-only fork enforced?          | **No, not as of 2026-10-04.** A fork created with `read_only: true` reports `read_only: true` and still accepted a push from a write token. Gitmatrix has to enforce read-only itself, which it can, since it mints every token. `last_push_at` stayed null even after pushes.                                                                                                                                                                                                        | Push to `core252-test-dbo-true` succeeded; `GET repo` confirmed the flag.                                                                                                                                                                                                                                                            |
| Limits                                 | Unlimited repositories and namespaces. 1 GB per repository, which a fork inherits from its parent's size. 32 MB per blob. 1 TB per account (can be raised). 2,000 control-plane requests per 10 s per namespace (fork, token, get). 2,000 git requests per 10 s per repository.                                                                                                                                                                                                       | [Limits][a-limits], updated 2026-10-01.                                                                                                                                                                                                                                                                                              |
| Cost                                   | Workers Paid only, billed from **2026-10-14**. Operations: 10,000 a month included, then $0.15 per 1,000 (a fork is one operation, and appears as `fork` in the metrics). Storage: 1 GB-month included, then $0.50 per GB-month. "Repos remain stored until you explicitly delete them."                                                                                                                                                                                              | [Pricing][a-pricing], [metrics][a-metrics].                                                                                                                                                                                                                                                                                          |
| Deletion                               | `ARTIFACTS.delete(name)` deletes the repository and its tokens. Children survive.                                                                                                                                                                                                                                                                                                                                                                                                     | Experiment; [binding][a-binding].                                                                                                                                                                                                                                                                                                    |

What follows from these facts:

1. A fork can't be pinned to a commit, and it carries every inherited ref.
   Gitmatrix has to initialize the timeline ref itself with a compare-and-swap,
   and delete the inherited refs.
2. Forks inherit the canonical repository's garbage. Each fork's stored size is
   the parent's total stored size, not its reachable size.
3. Merging needs a real object transfer, which is cheap because the history is
   shared.
4. Read-only is Gitmatrix's job, in the proxy.

## Inventory: who uses timeline bookmarks

About 98 files mention the bookmark. They come down to one pattern: every
reader and writer goes to the single canonical Artifacts repository
(`repos.artifacts_name`) and finds `timeline/<slug>` in its ref list. In the
table, "Swap store" means the code keeps the same ref string and just asks the
fork instead.

| Subsystem                             | Files (under `apps/website/` unless noted)                                                                                                                                                                                                                                                                                                                                                                   | What it does today                                                                                                                                                              | With forks                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git proxy                             | `worker/git/http.ts` (`proxy` :58, `forward` :281, `landingProxy` :192), `worker/git/effects.ts:31`, `worker/git/receive-pack.ts`                                                                                                                                                                                                                                                                            | Streams every request to `repo.artifacts_remote`. Parses push commands only for queue staging and job tokens.                                                                   | New route `/:owner/:repo@:slug.git` that resolves to the fork. It syncs the fork's `main`, allows writes only to `refs/heads/timeline/<slug>`, refuses `timeline/*` on the canonical URL, and runs `afterPush` with the source.                                                                                                                                                                                                                                        |
| Bookmark writes                       | `worker/timelines/bookmarks.ts` (`writeRefs` :41, empty pack); `worker/timelines/api.ts` (fork :151–228, abandon :295–328)                                                                                                                                                                                                                                                                                   | Fork writes `refs/heads/timeline/<slug>` in canonical; abandon deletes it.                                                                                                      | Fork means: allocate a fork, initialize the ref with a compare-and-swap, delete inherited refs. Abandon means archive the fork (read-only in the proxy). `writeRefs` stays as the ref primitive and gains a sibling that sends a real pack (`copyObjects`).                                                                                                                                                                                                            |
| Push log                              | `worker/ref-log/record.ts` (`recordPush` :60, `recordRefs` :80, haves :168, `fetchNewCommits` :254); `repo_refs`, `ref_updates`, `change_refs`                                                                                                                                                                                                                                                               | `ls-refs` on canonical; new-commit fetch from canonical, with other refs as haves.                                                                                              | Record fork pushes under the **canonical `repo_id`** with ref `refs/heads/timeline/<slug>`, which is unique per repository because slugs are unique per tracker. Never record the fork's copy of `main`. Haves come from the fork (its `main`, its previous tip). No schema change is needed.                                                                                                                                                                          |
| Timeline activity and merge detection | `worker/timelines/activity.ts` (:30–111); `worker/tracker/timelines.ts` (`recordPush` :434, auto-add repository :454)                                                                                                                                                                                                                                                                                        | D1 only: a merge's second parent is matched against `repo_refs`/`ref_updates` tips of `main` or `timeline/%` in the same `repo_id`.                                             | Unchanged, given the push-log rule above. A repository first pushed to through a timeline URL is added (and forked lazily).                                                                                                                                                                                                                                                                                                                                            |
| Landing queue                         | `worker/timelines/landing.ts` (`workerDeps` :88–100, `step` :260, bookmark check :487, `startMerge` :537–560, `complete` :571–610); `worker/ci/landing.ts` (`MERGE_SCRIPT` :42, `landingJob` :256)                                                                                                                                                                                                           | `startMerge` points canonical `gitmatrix/landing/<slug>` at the checkpoint with an empty pack, which needs the objects already in canonical.                                    | `startMerge` copies the checkpoint's objects fork→canonical in the receive-pack that creates the landing ref. The bookmark check reads the fork's tip. `complete` deletes the landing ref and archives the fork. The merge job, gates, compare-and-swap and the scope of job tokens are unchanged.                                                                                                                                                                     |
| Merge queue (CORE-136)                | `worker/merge-queue/*`                                                                                                                                                                                                                                                                                                                                                                                       | Canonical only; timeline-bound `--queue` is refused.                                                                                                                            | Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Checkpoints                           | `worker/timelines/checkpoints.ts` (`measure` :33–60)                                                                                                                                                                                                                                                                                                                                                         | One `lsRefs(canonical)` for both tips.                                                                                                                                          | Tip from the fork, base from canonical. `change_refs` is unchanged.                                                                                                                                                                                                                                                                                                                                                                                                    |
| CI                                    | `worker/ci/trigger.ts` (`onPush` :477, `startRun` :91, `RepoReader` :126/:167/:294), `worker/ci/jobs.ts` (:23, :65–101), `worker/ci/sandbox.ts:159–187`; local runner `apps/cli/src/commands/ci.rs` (`run_job` :982–1045)                                                                                                                                                                                    | Reads `ci.yml` and trees from canonical. The sandbox clones `artifacts_remote` at the branch. The local runner clones through the proxy, then fetches by oid.                   | Swap store: a layered reader for timeline runs, and the sandbox clones the fork's remote. The fork holds `main` and `timeline/<slug>`, so `--branch timeline/<slug>` and the fetch by oid both work. The job payload gains a clone URL (the timeline URL) for the local runner.                                                                                                                                                                                        |
| Deployments and previews              | `worker/deployments/previews.ts` (`previewBranch` :49, revive :183), `worker/deployments/sweep.ts:147`, `worker/deployments/api.ts:235`, `shared/deployments.ts:19`                                                                                                                                                                                                                                          | Environment `timeline/<slug>` is a string. Revive and teardown clone canonical and fetch the checkpoint by id, which works forever today because canonical never drops objects. | Environments are unchanged. `previewBranch` and revive resolve the source: an active or archived fork, or canonical after landing. Revival after a fork is purged returns "source expired" (see the open questions).                                                                                                                                                                                                                                                   |
| Knowledge overlays and pages          | `worker/knowledge/coordinator.ts` (:237, `#scanOverlays` :506–580, :710), `worker/knowledge/build.ts` (`#overlay` :743, `#withReader` :172), `worker/knowledge/overlay.ts` (`mergeBase` :91, `planOverlay` :300–309), `worker/knowledge/pages.ts:662`, `worker/knowledge/api.ts` (:505, :586–715)                                                                                                            | Finds bookmarks in canonical's refs and computes the merge base with one canonical reader.                                                                                      | The coordinator lists timeline sources from D1 and `repo_refs`, not canonical refs. Overlays and pages use the layered reader. Without it, `mergeBase` misses main's newer commits and falls back to a plain tree diff, which reads main's later work as the timeline reverting it.                                                                                                                                                                                    |
| Code browser and `?tl=`               | `src/lib/timelineScope.ts` (`bookmarkIn` :225), `src/routes/repo/Code.tsx`, `Commits.tsx`, `Story.tsx:53–91,552`; `worker/api/repos.ts` (`reader` :186, `resolveTarget` :205, the tree, blob, history and diff routes), `worker/objects.ts` (`RepoReader` :69, `resolve` :245)                                                                                                                               | `repo.branches` comes from canonical refs; every route reads canonical.                                                                                                         | `branches` adds active timeline tips from `repo_refs`, which keeps `bookmarkIn` and the E2E assertions working. `resolve("timeline/<slug>")` returns the layered reader. Routes addressed by oid honour `tl` and fall back to the source that owns the oid in the push log.                                                                                                                                                                                            |
| Atlas                                 | `worker/atlas/timeline.ts:77–105`                                                                                                                                                                                                                                                                                                                                                                            | Only looks up the tip; everything else comes from stored overlays.                                                                                                              | Tip from the timeline source.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Why and the semantic feed             | `worker/why/api.ts:255`, `worker/why/chain.ts` (:104, :152, :200), `worker/semantic/feed.ts:230`; `apps/cli/src/commands/why.rs`                                                                                                                                                                                                                                                                             | Blames with a canonical reader; the ref chain comes from `change_refs`.                                                                                                         | Layered reader when the commit or ref belongs to a timeline. The chain is unchanged.                                                                                                                                                                                                                                                                                                                                                                                   |
| Release notes                         | `worker/release-notes/timelines.ts` (`landedTimelines` :35–58), `shared/landings.ts`                                                                                                                                                                                                                                                                                                                         | Second parent looked up in `ref_updates` by canonical `repo_id`, with the merge message as a fallback.                                                                          | Unchanged: the landing merge brings the commits in, and the push log keys stay the same.                                                                                                                                                                                                                                                                                                                                                                               |
| Mirror                                | `worker/mirror/protocol.ts:18` (`isMirroredRef`)                                                                                                                                                                                                                                                                                                                                                             | An allowlist of default branch and tags.                                                                                                                                        | Unchanged; forks are never mirrored.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Packages                              | `registry/core/provenance.ts:222–245`, `registry/migrations/20261003013142_publish_branch.sql`                                                                                                                                                                                                                                                                                                               | Provenance records the canonical repository id and the ref `timeline/<slug>`.                                                                                                   | Unchanged, provided CI keeps recording the canonical repository id and the same ref.                                                                                                                                                                                                                                                                                                                                                                                   |
| Retention and deletion                | `worker/retention/repo-orphans.ts:189–226`, `worker/retention/repo-deletion.ts:962–976`, `worker/retention/repo-inventory.ts:116–157`, `worker/git/unreachable.ts:108`, `worker/retention/cleanups/push-log.ts`                                                                                                                                                                                              | The orphan sweep deletes every Artifacts repository not named in `repos` or `repo_deletions`. Repository deletion deletes only the canonical name.                              | **The orphan sweep would delete live forks.** `timeline_sources` must be in its `UNION` before the first allocation. Repository deletion and inventory enumerate sources. Unreachable measurement skips refs that live in forks. Purge policy for archived forks is below.                                                                                                                                                                                             |
| gm                                    | `apps/cli/src/commands/timeline.rs` (`start` :1217, `use` :1374–1441, `local_work_on_main` :1560, `merge` :1638–1686, `abandon` :1716, `pages` :875), `apps/cli/src/commands/network.rs` (`fetch_origin` :32, `sync_in` :161, `push` :530–865, bookmark delete :936), `apps/cli/src/repo/mod.rs` (`find_trunk` :268, `on_timeline` :288), `apps/cli/src/profile.rs` (:222, :379–391), `apps/cli/src/meta.rs` | Fetches all heads from `origin` in one go. The bound trunk is `refs/remotes/origin/timeline/<slug>`. Pushes go to `origin`. The server creates and deletes bookmarks.           | Bound fetch adds `git fetch <timeline-url> +refs/heads/timeline/<slug>:refs/remotes/origin/timeline/<slug>`, and bound push goes to the timeline URL. Every local ref name gm reads stays the same. `merge <other>` fetches the other timeline's URL first. The URL comes from the timeline API (`repos[].remote`). The `meta.rs` strings and docs change. `sync` and the landed-change walk are unchanged, because landing still brings timeline commits into `main`. |
| gm tests                              | `apps/cli/tests/timelines.rs`, `merges.rs`, `queue.rs`, `steps.rs`                                                                                                                                                                                                                                                                                                                                           | A stub API and one local bare remote.                                                                                                                                           | The stub gives each timeline a bare remote and returns its URL.                                                                                                                                                                                                                                                                                                                                                                                                        |
| E2E                                   | `tools/agent/e2e.ts` (:480, :532, :1612–1800, :3835–3896), `tools/agent/provider-e2e.ts` (:1380–1491)                                                                                                                                                                                                                                                                                                        | Repo-detail `branches` lists `timeline/<slug>`. A raw `git push origin HEAD:refs/heads/timeline/copper-limits` happens with no tracker record.                                  | `branches` keeps listing timeline tips. The raw untracked push becomes a push to a timeline URL created through the API, because `timeline/*` on canonical is refused. Add a scenario that checks a fork-only commit is absent from canonical until landing.                                                                                                                                                                                                           |

The places that assume timeline and main commits share one object store are
listed below. The layered reader or the landing copy covers each of them.

- The landing ref write with an empty pack.
- `mergeBase` in knowledge overlays and pages.
- Haves in the push log.
- Unreachable measurement.
- Revive and teardown fetching by id from canonical.
- A fork from a parent timeline reading the parent's tip from canonical.
- Repository diffs and history by oid.
- Blame in `why`.
- Story's reads of abandoned timelines.

## Design

### The timeline source

- **New D1 table `timeline_sources`.** D1 is the inventory of what Gitmatrix
  owns, tied to `repos.id`, which is what the orphan sweep and repository
  deletion already read. The tracker's timeline stays the authority on
  lifecycle. The columns:
  - `id`, `timeline_id`, `repo_id` (unique per `timeline_id` and `repo_id`);
  - `artifacts_name` (unique), `artifacts_remote`;
  - `parent_source_id`, null when the fork came from canonical;
  - `fork_commit`, the requested and verified commit;
  - `state`: `reserved → forking → ready → archived → purging → purged`, or
    `failed`, with `operation_id` and `error`;
  - `created_at`, `archived_at`, `purge_after`.
- **Names are opaque: `t-<20 hex>`,** like today's `r-<20 hex>`
  (`newArtifactsName`). Names are never used for authority, and timeline
  slugs and repositories can be renamed. The prefix only helps a person
  reading the namespace. The suggested form `<artifacts_name>--tl-<slug>` is
  readable but breaks on slug reuse and renames. Forks always live in the
  canonical repository's namespace. `TimelineRepo` gains `remote` (the
  Gitmatrix timeline URL, never the Artifacts remote).
- **Allocation is idempotent and resumable:**
  1. Write the `reserved` row with the intended name before calling Artifacts.
  2. `get(parent).fork(name)`: the parent is canonical, or the parent
     timeline's fork for that repository when there is one.
  3. Wait out `FORK_IN_PROGRESS`.
  4. Check that the requested commit exists in the fork (`readCommit`).
     Because forks copy every object, it does even if canonical moved meanwhile.
  5. With `writeRefs`, create `refs/heads/timeline/<slug>` at that commit
     (`old = null`), and delete every inherited ref except `refs/heads/main`,
     including the parent's `timeline/<parent>` in a child fork.
  6. Revoke the token the fork call returned, then mark the row `ready`.

  A retry resumes the same row and name. A provider result is adopted only if
  it matches the reservation.

- **Multi-repository start forks in parallel,** about 8 s in total. A
  repository that is first pushed to through a timeline URL is forked on that
  first access, from the parent timeline's source or from canonical `main`.
  This keeps today's "a timeline picks up repositories as it touches them".
- **A timeline from a timeline** forks the parent timeline's fork for each
  repository the parent has, and canonical for the rest. It records
  `parent_source_id`. The parent's later work arrives only through explicit
  merges, as today.

### Git access

**Recommended: an explicit timeline URL, `https://<host>/<owner>/<repo>@<slug>.git`.**

- **The address is unambiguous.** Repository names can't contain `@`
  (`worker/api/repos.ts:39`). `git clone` names the directory `<repo>@<slug>`.
  gm's `http.<server>/.extraHeader` credentials match by URL prefix, so they
  apply. Native git, the sandbox, the local runner and other tools can use it
  without special headers.
- **What a client sees is the fork, forwarded unchanged:** `main`, kept equal
  to canonical, and `timeline/<slug>`. The proxy does only three extra things:
  1. **It syncs `main` on each `info/refs`.** If the fork's `main` isn't
     canonical's tip, it copies the missing objects canonical→fork (want
     canonical `main`, have the fork's `main`) and moves the fork's
     `refs/heads/main` with a compare-and-swap. That costs one `ls-refs` on
     each side when nothing moved. The fork is then self-contained: a client
     computes its pack against advertised refs the fork really has, so
     `gm timeline merge main` followed by a push works.
  2. **It filters commands.** On the timeline URL only
     `refs/heads/timeline/<slug>` can be created, moved or deleted. Pushes to
     `main` or to other names are refused, using the receive-pack parsing the
     proxy already does. Writes need write access to the canonical repository
     and an active timeline. Archived sources are read-only, because Artifacts
     doesn't enforce `read_only`.
  3. **It runs the effects.** `afterPush` runs with the source: the push log
     under the canonical `repo_id`, CI, knowledge and the tracker's
     `recordPush`. Mirroring is skipped.
- **A merge between timelines** is the client's job, as today. gm fetches the
  other timeline's URL into `refs/remotes/origin/timeline/<other>`, merges, and
  pushes to its own URL. The pack carries the other timeline's objects, because
  its own fork doesn't advertise them. The server copies nothing.
- **On the canonical URL, `refs/heads/timeline/*` is reserved.** A push there is
  refused with: "Timelines live in their own repository: push to
  `<host>/<owner>/<repo>@<slug>.git` (`gm timeline use <slug>` sets this up)."
  The canonical advertisement no longer contains timeline refs.
- **Permissions are inherited.** Each request resolves the canonical
  repository (`findRepo`, `roleFor`, tombstones) first, then the timeline
  (exists, active, or archived for reads). Owning a fork name or URL grants
  nothing. Artifacts tokens never leave the server, except the fork's read
  token in a CI sandbox, as canonical's is today. The scope of landing job
  tokens is unchanged, because the merge job still only touches canonical.

**Fully transparent routing (clients keep pushing `timeline/<slug>` to the
canonical URL; the proxy redirects) was evaluated seriously and rejected.**

- It would keep gm unchanged, but only if the proxy could make one URL behave
  as the union of canonical and N forks:
  - a merged `ls-refs`, otherwise `git fetch --prune` deletes the timeline
    tracking refs;
  - a single upload-pack whose wants span several Artifacts repositories. That
    means per-repository negotiation and a spliced pack (rewritten header and
    trailing SHA-1, deduplicated objects), for protocol v1 and v2.
- **Push breaks at the protocol level.** `info/refs` for receive-pack comes
  before the command list, so the proxy can't know which store's refs to
  advertise. The client then leaves out objects reachable from advertised
  canonical refs that the fork may not have.
- **It also fails on bare-oid fetches** (`ci.rs` fetches by commit).
- The explicit URL gets the useful part of transparency (unchanged ref names
  everywhere, and an unchanged local layout in gm) without a git multiplexer.

**Rejected: a header on the canonical URL.** It works for gm, but native git,
the sandbox and external tools would all need extra configuration, and it has
the same problem of advertising before the command list.

### Merging and landing

- **Timeline into timeline,** and main into a timeline: client-side real
  merges, pushed to the target's URL, as described above. No server copy.
- **Merge detection is unchanged.** `activity.ts` matches second parents
  against `repo_refs`/`ref_updates` for the canonical `repo_id`, and every
  fork's tip is logged there under its unique `refs/heads/timeline/<slug>`.
  Release notes' `landedTimelines` is unchanged for the same reason.
- **Landing, per repository:**
  1. **Copy, then point.** `startMerge` calls a new
     `copyObjects(fork → canonical, want = checkpoint, haves = canonical tips,
ref = gitmatrix/landing/<slug>, old = tip)`. It sends a v2 fetch to the
     fork, strips the sideband, and streams the pack into canonical's
     receive-pack with an `atomic` command, so the 128 MB Worker memory limit
     doesn't apply.
  2. Everything after that is unchanged:
     - the merge job (`MERGE_SCRIPT` clones canonical's landing branch, merges
       canonical `main`, and pushes back with the scoped `gmj_` credential);
     - the checks on the merge's parents (`readCommit` on canonical, where the
       checkpoint now exists);
     - the gates, with every repository prepared before any compare-and-swap,
       then `partly landed` and retry.
  3. The check before advancing (`landing.ts:487`) reads the fork's tip, not a
     canonical bookmark.
  4. `complete` deletes the landing branch in canonical and archives the fork.
- **The objects that enter canonical are exactly what the real-merge decision
  already brings in:** the checkpoint and its ancestors not yet in `main`.
  Abandoned timelines, and checkpoints rewritten before the landed one, never
  enter canonical.
- **After landing or abandoning, the fork is archived, then deleted by
  retention.** Archived means read-only in the proxy: still readable for
  review, `gm why`, Story, revival and late `gm sync`. This matches how
  overlays end: rows read-only, then removed by policy. The fork is deleted
  when `purge_after` passes, unless something still needs it:
  - an unfinished CI run or preview teardown;
  - a child timeline whose fork depends on it. A child fork holds its own
    copy, but the child's fork point must still be readable for review, and
    deleting a parent never breaks a child.

  Proposed `purge_after` defaults, per org: **30 days after landing** (what
  landed is in canonical, and only rewritten intermediates are lost) and **90
  days after abandoning**. Both are capped by `endedTimelineDays` (180).
  Reviving a checkpoint whose source is gone, and isn't in canonical, returns
  an explicit "source expired".

### Reads inside the Worker

- `RepoReader` (`worker/objects.ts`) gains an optional fallback store. For a
  timeline ref or scope, the reader is `[fork, canonical]`: objects come from
  the fork first and from canonical when the fork lacks them. Refs come only
  from the fork's `timeline/<slug>` and canonical's `main`.
- A helper `storeFor(repo, ref | {timeline})` returns that reader when a
  `timeline_sources` row exists, and canonical for timelines from before the
  cutover.
- Object caches stay keyed per store.
- Routes addressed by oid take the `tl` scope. Without it, they try canonical
  and then the source whose ref first carried the commit in `change_refs`.

### Migration

Production timelines checked read-only on 2026-10-04 with `gm timeline list`,
plus the canonical branch list (`gm repo view`: `main`, `timeline/core-255`):

| Timeline      | Status    | Proposal                                                                                                                                                                                                                                                                                   |
| ------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| core-255      | active    | Convert if it is still active at cutover: fork, initialize at its bookmark tip with a compare-and-swap, switch routing, then delete the canonical bookmark. It has had no pushes yet. It is also the timeline of the overlapping issue, so the owner may prefer to abandon it and restart. |
| core-136      | landed    | Leave as legacy. Its bookmark is already gone and its commits are in `main`.                                                                                                                                                                                                               |
| core-219      | landed    | Leave as legacy.                                                                                                                                                                                                                                                                           |
| live-poc      | abandoned | Leave as legacy. Its objects stay in canonical, unreachable, as they do today.                                                                                                                                                                                                             |
| quiet-poc     | abandoned | Leave as legacy.                                                                                                                                                                                                                                                                           |
| step-poc      | abandoned | Leave as legacy.                                                                                                                                                                                                                                                                           |
| preview-check | abandoned | Leave as legacy.                                                                                                                                                                                                                                                                           |

- **The cutover is one bounded step,** not a dual-write period:
  1. Freeze timeline creation and landing for a few minutes.
  2. Convert the active timelines.
  3. Flip creation to forks.
  4. Reserve `timeline/*` on canonical.
- **Ended timelines keep being read through canonical.** A timeline with no
  `timeline_sources` row is read through canonical, which is today's code path
  and is needed anyway to show them truthfully. There are no legacy writes.
- **gm compatibility.** An old gm pushing `timeline/<slug>` to canonical gets
  the refusal, with an "update gm" hint, so stale clients fail loudly.

### Cost and scale

- **Count:** one fork per (timeline, repository it touches). Artifacts has no
  limit on how many repositories an account holds.
- **Storage:** budget a full copy of the canonical repository's stored size,
  garbage included, plus the timeline's growth, until Cloudflare documents
  sharing.
  - Gitmatrix today is about 5–10 MB. At 100 timelines a day on one
    repository, kept 30 to 90 days, that is 3,000–9,000 live forks, or 30–90
    GB at most: about $15–45 a month. With a 180-day retention it would be
    about $90.
  - A 1 GB repository would multiply that a hundredfold. Short retention for
    landed forks is therefore the default, and the per-repository 1 GB limit
    is inherited by every fork.
- **Operations** are cheap at $0.15 per 1,000:
  - one fork, a token, a few ref writes;
  - each push and fetch;
  - one canonical→fork sync when `main` moved;
  - one copy at landing.
- **Rate limits:** 2,000 control-plane requests per 10 s per namespace is ample
  with cached tokens. Git requests are per repository, so forks spread load
  away from canonical.
- **Cleanup:** a purge job per source, using the retention engine, and
  repository deletion enumerating sources. Run the 24-hour orphan sweep only
  after the table is part of its `UNION`.
- **Measure before rollout:** fork a 60 MB repository ten times in
  `gitmatrix-dev` after billing starts on 2026-10-14, and read the storage
  metric the next day to learn whether forks share storage.

## CORE-255 overlaps this issue

CORE-255, "Move timeline work to owned Artifacts repositories with compact,
provenance-preserving landing", came out of CORE-228. It was created on
2026-10-04 at 18:15, after CORE-252 (17:50).

- **Its state:** `in_progress`, claimed by Francois Ward through agent `omp-2`,
  on a required approval timeline `core-255` with no pushes yet.
- **What it shares with this design:**
  - one owned work repository per (timeline, repository);
  - a D1 ownership table, with the tracker as lifecycle authority;
  - a scoped git endpoint;
  - fork initialization with a compare-and-swap, and normalized refs;
  - awareness of the orphan sweep and repository deletion;
  - archive, then purge.
- **Where it differs:** it lands each checkpoint as **one new single-parent
  commit on canonical** (a three-way apply of `base → work tree` onto `main`).
  It says outright that it "supersedes the historical real Git merge
  mechanism". That contradicts the binding decision ("How does a timeline land?
  As a real git merge") and CORE-252's text ("using the mechanisms we decided
  for timeline merging. Those don't change"). Its compact landing also needs:
  - a new integration ledger;
  - rules for nested dependencies and `blocked_dependency`;
  - source-aware sync in gm;
  - new release-note grouping;
  - a migration away from detecting merges by second parent.

  Most of its acceptance criteria A3–A8 exist because of that choice.

- **Both cannot ship.** The storage half is common. The landing half is a
  product decision only the owner can make. The plan below assumes real merges,
  and marks the issues that are the same under CORE-255.

## Open questions for the owner

1. **Real merge (CORE-252, current decision) or compact single-parent landing
   (CORE-255)?** _Recommended: keep real merges._ It is the binding decision,
   CORE-252 asks for it, it keeps native git ancestry and every consumer that
   relies on second parents, and forks already remove the refs and the
   unlanded objects that pollute canonical. If compact landing is wanted, merge
   CORE-252 into CORE-255 and reuse the storage issues below. Either way,
   CORE-255 should pause until this is answered, and it should be split; as
   filed it is one task covering A1 to A13.
2. **How are timelines addressed?** _Recommended: the explicit URL
   `/<owner>/<repo>@<slug>.git`, with the fork keeping `timeline/<slug>` and an
   up-to-date `main`._ Transparent routing behind the canonical URL is
   rejected (see [Git access](#git-access)).
3. **May `timeline/*` still be pushed to canonical?** _Recommended: no._
   Reserve the namespace and refuse with the timeline URL. Untracked
   `timeline/x` pushes no longer exist; timelines start through the API.
4. **How long are archived forks kept?** _Recommended: 30 days after landing,
   90 after abandoning, per org, capped by `endedTimelineDays`._ After that,
   reviving a preview of a checkpoint that isn't in canonical returns "source
   expired". This narrows the "any checkpoint's preview can be revived"
   decision, which today relies on canonical never dropping objects.
5. **Should a repository be forked lazily the first time a timeline URL for it
   is used?** _Recommended: yes._ It costs about 8 s once, and keeps timelines
   picking up repositories as they touch them.
6. **Should the timeline URL be public and documented for native git?**
   _Recommended: yes._ It is an ordinary git remote with inherited permissions.
7. **What happens to `core-255`'s active timeline at cutover?** _Recommended:
   convert it if it is still active_ (it has no pushes). Leave the six ended
   timelines as legacy, read through canonical.

## Phased plan

Each issue is small enough for one agent. Issues that list no blocker after
phase 0 can run in parallel. "Same under CORE-255" marks work that doesn't
depend on question 1.

**Phase 0: decide and measure**

- **Owner: landing semantics (question 1)** and reconciling CORE-252 with
  CORE-255. This blocks all the issues below. Not agent work.
- **Measure whether fork storage is shared** (same under CORE-255).
  - In `gitmatrix-dev` after 2026-10-14: fork a 60 MB repository ten times and
    read storage the next day through the GraphQL metrics or billing. Delete
    the forks.
  - Evidence: storage before and after.
  - It sets the retention defaults.

**Phase 1: foundation (parallel)**

- **A. `timeline_sources` and allocation** (same under CORE-255).
  - Add the D1 migration (with a UTC timestamp name) and `TimelineRepo.remote`.
  - Write a resumable allocator: reserve, fork, wait, verify the commit,
    initialize the ref with a compare-and-swap, delete inherited refs, revoke
    the initial token, mark ready.
  - In the same change, add the table to `repo-orphans.ts`'s known names,
    `repo-deletion.ts`'s Artifacts phase and `repo-inventory.ts`.
  - Tests:
    - crash and resume at each step;
    - two concurrent requests produce one source;
    - inherited refs never become timeline heads;
    - canonical moving between pinning and forking still yields the pinned
      commit;
    - a real fork in an agent environment.
- **B. `copyObjects` primitive.** In `worker/timelines/bookmarks.ts` or
  `worker/git/copy.ts`: a v2 fetch from the source, sideband stripped,
  streaming into the target's receive-pack, with atomic ref commands and
  compare-and-swap semantics like `writeRefs`. Handle the no-pack case
  (nothing missing) and errors (an `ERR` line, an unpack failure). Tests:
  unit tests on a recorded pack, and a smoke test between two dev repositories.
  No blockers.
- **C. A layered `RepoReader` and `storeFor`.** Add a fallback store to
  `worker/objects.ts`, with refs resolved per store and caches keyed per store.
  `storeFor(repo, ref|timeline)` returns `[fork, canonical]` or canonical.
  Tests: an oid that exists only in the fork, only in canonical, or in both;
  and that `mergeBase` finds main commits newer than the fork. It needs A's
  table shape, which a stub can provide.

**Phase 2: transport (needs A and B)**

- **D. Timeline git URL in the proxy.**
  - Add the route `/:owner/:repo@:slug.git` and inherited authorization:
    lifecycle checks, archived means read-only, tombstones.
  - Sync `main` on `info/refs` with B.
  - Filter commands so only `refs/heads/timeline/<slug>` is writable, and fork
    lazily on first access by a writer.
  - Run `afterPush` with the source: `recordPush` under the canonical
    `repo_id`, haves from the fork, never the fork's `main`, no mirroring.
  - Reserve `timeline/*` on the canonical URL, behind a flag until cutover.
  - Tests: wrong role, ended timeline, a push mixing `main` with the timeline
    ref, merge main then push, merge another timeline then push, and that
    merge detection still finds the second parent.

**Phase 3: consumers (parallel, after C and D unless noted)**

- **E. Timelines API, checkpoints, landing.**
  - Fork and abandon go through A: abandon archives.
  - `measure` takes its tip from the fork.
  - `startMerge` uses B to copy the checkpoint and create
    `gitmatrix/landing/<slug>` in one receive-pack.
  - The check before advancing reads the fork, and `complete` archives the
    fork.
  - Tests: the existing landing suites, plus a fork-only commit that is absent
    from canonical until the landing copy, and a two-repository partial
    landing.
- **F. CI and previews.**
  - `onPush` for fork pushes, and a `startRun` reader through C.
  - `loadJob` resolves the fork's name and remote for the sandbox clone, and
    the job payload carries the timeline URL for `gm ci` local runs (`ci.rs`).
  - `previewBranch`, revive and teardown resolve the source; an expired source
    is reported explicitly.
  - Needs D, and E for the archive state.
- **G. gm.**
  - Fetch and push targets from `repos[].remote` when bound, keeping local ref
    names; `use` and `merge <other>` fetch other timelines' URLs.
  - Update the `meta.rs` git equivalents and the README and skill docs.
  - The test stub gets a bare remote per timeline.
  - No server dependency beyond the API field, so it can start once A's API
    shape is agreed.
- **H. Web, knowledge, why.**
  - `repos.branches` includes timeline tips from `repo_refs`.
  - `resolve` and oid routes take `tl` through C.
  - Story reads abandoned history from the archived fork.
  - The knowledge coordinator lists sources instead of canonical refs;
    overlays, pages and Atlas use C; `why` blames through C.
  - This changes knowledge behaviour, so follow
    `.agents/skills/gitmatrix-ai-verification/SKILL.md` and run
    `vp run agent test-ai`.
- **I. Retention.**
  - Purge archived sources by policy (questions 4 and 5), as a retention
    cleanup with a run history.
  - Claims from consumers (an open CI run, a preview teardown, a child fork
    point) delay the purge.
  - `unreachable.ts` skips refs that live in forks.
  - The purge revokes and forgets cached tokens.
  - Tests use the retention test clock.

**Phase 4: cutover (after E–I)**

- **J. Migration and E2E.**
  - A freeze-and-convert command for active bookmark timelines, run in an agent
    environment first, then in production.
  - Flip creation to forks and turn on the canonical reservation.
  - Update `tools/agent/e2e.ts` and `provider-e2e.ts`: the raw untracked push
    becomes an API-started timeline URL. Add a scenario for a fork-only commit
    and its landing.
  - Run `vp run ready`.
  - Amend [Decisions](TIMELINES-RESEARCH.md#decisions): code lives in a fork
    per timeline, the timeline URL, retention of forks, revival limited by
    source retention.

[a-binding]: https://developers.cloudflare.com/artifacts/api/workers-binding/
[a-rest]: https://developers.cloudflare.com/artifacts/api/rest-api/
[a-repos]: https://developers.cloudflare.com/artifacts/concepts/repositories/
[a-how]: https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/
[a-limits]: https://developers.cloudflare.com/artifacts/platform/limits/
[a-pricing]: https://developers.cloudflare.com/artifacts/platform/pricing/
[a-git]: https://developers.cloudflare.com/artifacts/api/git-protocol/
[a-metrics]: https://developers.cloudflare.com/artifacts/observability/metrics/
[a-blog]: https://blog.cloudflare.com/artifacts-git-for-agents-beta/
