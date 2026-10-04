# Fewer CI runs without slower answers (CORE-23)

How to cut the number and cost of CI/CD runs as many agents push to `main`,
without making any agent wait longer for its verdict.

## What the runs looked like (runs #8–#27, 2026-10-02)

- 17 pushes and 20 runs in about 2.3 hours; **half started while another was
  running**. A run takes about 7.5 minutes to a verdict: check ~1.5 min, test
  ~2.3, build ~2.7, then deploy 1–3 on `main`.
- **Duplicates:** three manual reruns of one commit (#23, #24, #25) ran side by
  side.
- **Repeated work:** only 1 of the last 30 commits was docs-only, but **19 of 30
  touched no `apps/cli` file**, while every run compiled the Rust CLI three times
  (clippy in check, `cargo test` in test, a release build in build).

## Options

| Option                                                                 | Fewer runs or less work                                        | Slower for anyone?               |
| ---------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------- |
| Dedupe runs of a commit in flight                                      | Removes duplicate runs                                         | No                               |
| Skip jobs whose inputs didn't change (`paths:`)                        | Removes most Rust work today                                   | No                               |
| Coalesce pushes under load                                             | Fewer runs when busy                                           | Only when busy, bounded          |
| Explicit merge queue (test before landing, proven descendant coverage) | Can reduce duplicate work; gates queued candidates before main | `gm push --queue` lands after CI |
| Path filters for whole runs                                            | Docs-only pushes skip CI                                       | No, but rare here                |

Reducing the _number_ of runs without delaying anyone isn't possible in
general: a run that covers several pushes starts later than the earliest of
them would have. What's free is not running the same thing twice (dedupe) and
not running what didn't change (`paths:`). Coalescing trades a little latency
for a lot of runs, but only pays under load.

### Coalescing, simulated on the real push times

One held run per branch covers every push that arrives while N runs are in
flight (newest commit wins); a run takes 7.5 minutes.

| Push rate | Limit    | Runs      | Average wait | Worst wait |
| --------- | -------- | --------- | ------------ | ---------- |
| Today's   | none / 4 | 17        | 7.5 min      | 7.5 min    |
| Today's   | 1        | 15 (−12%) | 10.5 min     | 15.0 min   |
| 3×        | 4        | −6%       | 7.7 min      | 9.2 min    |
| 5×        | 4        | −23%      | 8.4 min      | 10.5 min   |
| 10×       | 4        | −56%      | 8.5 min      | 10.1 min   |
| 10×       | 2        | −78%      | 9.9 min      | 13.8 min   |

## What shipped

All three no-regret or bounded options (`worker/ci/coalesce.ts`, `.gitmatrix/ci.yml`):

- **Dedupe:** starting a commit that already has a run in flight on its branch
  returns that run.
- **Unchanged jobs:** `paths:` on a job; on a push, a job whose paths have the
  same git object ids as the last commit it passed on (with the same spec) is
  skipped and counts as passed. gm's Rust work is a `cli` job with
  `paths: [apps/cli]`, and its release build happens only when deploy publishes
  a new gm version (gm is versioned by its source tree).
- **Coalescing:** `on.push.coalesce_after: 4`. Held runs start when a slot frees;
  the newest covers the older ones, and `gm runs wait` follows it.

Together with deploy concurrency (`concurrency: production`, newest deploy wins),
a burst of pushes now runs at most four pipelines at a time per branch, deploys
once, and builds gm only when it changed.

## Explicit merge queue (CORE-136)

The additive `gm push --queue` path tests the merged candidate before advancing
the default branch. Ordinary `gm push` and native pushes remain unchanged as
self-hosting recovery paths; this is not universal main protection and passing
gates cannot prove that main will never break. Timeline landing remains separate.

Source staging refs skip ordinary CI, knowledge and preview work. Queue gates
run in full without new path-based reuse. Ordinary exact-run dedupe, push
coalescing/coverage, complete declared `paths` inputs with identical job-spec/object
proof, and deployment concurrency retain their existing roles.
Clef can recommend combining queued descendants, but only deterministic Git
ancestry proves coverage. Unrelated work is not covered merely because a model
says so; unavailable scheduling AI leaves separate/FIFO work safe. This does not
promise arbitrary batch bisection or a measured reduction for every workload.

Each candidate pins its base and source, passes configured required merge gates,
and advances via compare-and-swap. A moving main forces remerge/retest; missing
gates fail closed for queued work. Cancellation/retry fence stale attempts, and
failed entries release capacity so the next push can proceed. Post-main CI and
deployment remain separate verdicts, followed through existing coverage chains.

Bounded repair requires all three Clef `noul` semantic checks (ordinary
documentation, compatible additions, explicit concatenation approval) to return
yes-probability at least 0.95; persisted repair confidence is their minimum.
This differs from scheduling's advisory choice-confidence metric, despite the same numeric threshold.
At most three ordinary additive documentation files are eligible (4,096 UTF-8
bytes per version, 16,384 aggregate), with one classification call and at most
one content-only generation.
Unicode prose is supported; the exact base and both appended suffixes must be
preserved without invented edits. Classification and generation have 65-second
and 125-second deadlines respectively.
Unsafe paths/content, ambiguous output and model outages do not authorize
edits. The runner checks the result and runs full gates; AI cannot skip checks
or update refs. See the [website operational guide](apps/website/README.md) for
the exclusions, failure metadata and recovery protocol.

Admission means accepted, not landed or deployed. Agents checkpoint the queue
ID and monitor `gm queue show`/`wait --deploy` at work boundaries, not by busy
polling. Failures record dedicated read-only `queueFailure` evidence and create
P0 remediation issues related to original work without changing its lease.
Claim remediation through normal fenced commands, inspect actual CI/conflict
evidence, fix forward, and complete only with real recovery evidence. Inspect an
uncertain admission by ID; never silently fall back to a direct push.
