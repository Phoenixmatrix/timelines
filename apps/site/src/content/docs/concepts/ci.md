---
title: CI and steps
description: Declare a pipeline in .gitmatrix/ci.yml, learn what runs on each push, and follow runs and logs with gm runs.
section: Concepts
order: 3
---

Every repository can declare a CI/CD pipeline in `.gitmatrix/ci.yml`. Each push that moves a matching branch starts a run. Runs also start from the web app's Run button, `gm runs start`, re-runs, and, for repositories that opt in, timeline step runs and preview runs.

## The pipeline file

```yaml
on:
  push:
    branches: [main, "release/*"] # globs; omit for every branch
env: { CI_MODE: strict }
jobs:
  test:
    steps:
      - name: Install
        run: pnpm install --frozen-lockfile
      - run: pnpm test
  deploy:
    needs: [test] # runs only if test succeeded
    if: branch == "main"
    secrets: [CLOUDFLARE_API_TOKEN] # set with `gm secret set`, masked in logs
    timeout_minutes: 15 # default 20
    instance: standard-2 # sandbox size (default standard-1)
    steps:
      - run: ./scripts/deploy.sh
```

- **`on`** chooses what starts runs. `push.branches` takes globs.
- **`env`** sets variables for every job; a job can add its own `env:`.
- **`jobs`** each run their `steps` in order with bash. A step is `run:` with an optional `name:`.
- **`needs`** orders jobs. Jobs run in dependency stages, in parallel within a stage, and dependents of a failed job are skipped.
- **`if`** is a condition using `==`, `!=`, `&&`, `||` and parentheses over `branch`, `trigger` (`push`, `manual`, `preview`, `landing`, `step`), `commit`, `runner` and `action`.
- **`secrets`** lists the repository secrets a job receives.
- **`paths`** lists files or directories. On a push, the job is skipped as unchanged when those paths are identical to the last commit it passed on, and the skip counts as a pass for jobs that need it.
- **`concurrency`** limits a job to one at a time per repository. For example, with `concurrency: production` on a deploy job, a deploy still waiting when a newer push's run reaches its own deploy is skipped as superseded, so a burst of pushes deploys once, from the newest commit.

## Where jobs run

On the hosted service, each job runs in its own Cloudflare Sandbox container: it starts, clones the repository, runs each step with bash, streams logs, and is destroyed. `instance` sets the container size.

`gm runner` runs queued jobs on your own machine instead, which is how CI runs against a local development server. A job can check where it runs with the `runner` variable in `if:`.

Each job gets these environment variables: `CI`, `GITMATRIX`, `GITMATRIX_REPOSITORY`, `GITMATRIX_BRANCH`, `GITMATRIX_COMMIT`, `GITMATRIX_RUN_NUMBER`, `GITMATRIX_JOB`, `GITMATRIX_TRIGGER` and `GITMATRIX_TOKEN`, plus `GITMATRIX_TIMELINE` on a timeline and in preview runs. The job's `env:` and secrets come after them. With its own credential, a job can publish packages and record deployments without further setup.

`GITMATRIX_VERIFIED_BASE` is a reserved JSON value that job environment and secrets cannot override. For eligible `context-invariant-v1` sandbox jobs, it identifies an executed successful job with the same specification and immutable runtime: `{commit, runNumber, jobId}`. Otherwise it is `null`. This is only a comparison baseline, not permission to skip a required gate. A change-aware build must verify ancestor history and all relevant inputs, and execute normally when evidence is absent or uncertain. Skipped/reused jobs cannot produce this evidence.

## What runs on a push

Pushing to main runs the pipeline for the new commit. To avoid redundant work:

- Starting a commit that already has a run in flight on its branch returns that run.
- With `on.push.coalesce_after: N`, once N runs are in flight on a branch, new pushes wait. When one finishes, the newest waiting run starts and covers the older ones.

`gm runs wait` follows a covering run, so its verdict includes your commit.

## Following runs

```sh
gm push && gm runs wait     # block on trunk's run; exit 0 only if it passed
gm runs wait --commit @-    # wait for a specific revision's run
gm runs list                # recent runs, newest first
gm runs show 12             # one run with its jobs and steps
gm runs logs 12 --job test  # a job's output
gm runs logs 12 -f          # stream until the jobs finish
gm runs start --ref feature-x
gm runs rerun 12
gm runs cancel 12
```

`gm runs wait` exits non-zero and names the failing job when a run fails. It gives up after `--timeout` seconds (default 1800). All `gm runs` commands take `-R space/name` to act on another repository. The locator uses the repository's globally unique Space handle, not an Account handle or Organization slug.

The repository's CI tab in the web app shows the same runs with live logs.

## Secrets

```sh
echo "$TOKEN" | gm secret set CLOUDFLARE_API_TOKEN
gm secret list              # names only; values are never shown
gm secret delete CLOUDFLARE_API_TOKEN
```

A job receives only the secrets it lists under `secrets:`. Values are masked in logs.

## Steps and step runs

The word "steps" means two things in Timelines. A job's `steps:` are its shell commands. A **step** of a [timeline](/docs/concepts/timelines/#steps) is a meaningful commit pushed with its context. Each push to a timeline can get a light **step run**, the way pull-request checks are lighter than main's.

A repository opts in with `on: step`, and a job joins step runs by listing `step` in its own `on:`:

```yaml
on:
  push: {}
  step: {} # each push to a timeline also starts a step run
jobs:
  lint:
    on: step # only in step runs
    local: true # gm test runs it on your machine too
    steps: [pnpm lint]
  unit:
    on: [push, step] # in push runs and step runs
    needs: [lint] # a step job may only need step jobs
    steps: [pnpm test]
  build: # no on: the default runs (push, manual, landing), never step runs
    steps: [pnpm build]
```

A job without its own `on:` never joins a step run. Step run results attach to the step, and they never count as the commit's CI.

`gm test` runs the step jobs marked `local: true` in your checkout, in `needs` order, and exits 1 when one fails. `gm step` runs it before committing.

A timeline's full CI run waits until its pushes pause for a quiet period, or starts at once when you make a checkpoint. Main and other branches never wait.

## Landing gates and the merge queue

The pipeline also gates work that lands through the merge queue or a timeline. The queue runs the required gates on the exact candidate merge before it advances main, and fails closed when gates are missing or skipped. Landing runs see `trigger == "landing"`. See [The issue graph](/docs/concepts/issue-graph/#the-merge-queue) and [Timelines](/docs/concepts/timelines/#landing).

## Deployments and previews

Timelines deploys nothing itself. A job that deploys records where it went, and the run page and commit list show it:

```sh
gm deploy record --url "$URL"
gm deploy list --run 12
```

In CI the environment comes from the branch: `production` on the default branch, `timeline/<slug>` on a timeline, `branch/<name>` otherwise. Repositories that opt in with `on: preview` get preview runs for timeline checkpoints; see [Timelines](/docs/concepts/timelines/#previews).

See [`gm runs wait`](/docs/gm/#gm-runs-wait), [`gm runs logs`](/docs/gm/#gm-runs-logs) and [`gm secret set`](/docs/gm/#gm-secret-set) in the reference.
