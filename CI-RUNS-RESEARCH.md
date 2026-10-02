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

| Option                                           | Fewer runs or less work             | Slower for anyone?                |
| ------------------------------------------------ | ----------------------------------- | --------------------------------- |
| Dedupe runs of a commit in flight                | Removes duplicate runs              | No                                |
| Skip jobs whose inputs didn't change (`paths:`)  | Removes most Rust work today        | No                                |
| Coalesce pushes under load                       | Fewer runs when busy                | Only when busy, bounded           |
| Merge queue (test before landing, batch, bisect) | Fewer runs, and `main` never breaks | Changes `gm push`: lands after CI |
| Path filters for whole runs                      | Docs-only pushes skip CI            | No, but rare here                 |

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

## Not done: a merge queue

A merge queue would test pushes before they land on `main`, batch them, and
bisect a failing batch. It's the only option that keeps `main` green rather
than reporting after the fact, but it changes `gm push` (it would land once CI
passes) and every agent's loop. Worth it if `main` starts breaking often;
coalescing and `paths:` are the cheaper first step.
