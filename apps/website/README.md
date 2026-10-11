# Timelines

A git host on Cloudflare: one Worker serves the React app, a JSON API, and git's
smart HTTP protocol. Repository contents live in
[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/); accounts,
permissions and tokens live in D1. Account-owned issue trackers live in SQLite
Durable Objects, independent of repository history.

The public product name is **Timelines**. The app lockup reuses the approved
Pounce cat with an outlined Figtree Timelines wordmark at the approved weight and spacing; the
four-colour timeline-scope icon remains a separate navigation symbol.
Internal `GitmatrixLogo`, `gm`, `.gitmatrix`, protocol identifiers, resource
names and sender addresses remain unchanged. The production application uses
`timelinesapp.fward.dev` and its canonical repository is `matrixorg/timelines`.
Sign-in email display names and copy use Timelines.

```
git client ──Basic user:token──▶ Worker /:owner/:repo.git/*  ──Bearer art_…──▶ Artifacts git remote
browser    ──cookie──▶ Worker /api/*  ──env.ARTIFACTS──▶ log / readTree / readFile
                          └── D1: accounts, org_members, repos, repo_collaborators, access_tokens
```

## Run it

For agent development, start at the repository root and follow the
[isolated agent workflow](../../README.md#agent-first-development):

```bash
vp install
vp run agent setup
vp run agent up
```

Use the origin printed by `up`. Setup builds the worktree's CLI, installs and
checks Chromium, provisions a dedicated Artifacts namespace, migrates both local
D1 databases, and seeds deterministic Git/tracker fixtures. It provisions **no
paid AI** (Workers AI, AI Gateway, Vectorize, AI Search) and starts no Knowledge
builds; the app shows its AI-off states. `vp run agent setup --ai` adds them, for
changes to knowledge, wiki, embeddings, AI Search, the assistant, release-note
generation, avatars or Atlas descriptions only. Use `vp run agent inspect` for
data, `vp run agent test` for non-AI real-service E2E, and `vp run agent test-ai`
(targeted at the stages your change maps to) when verifying AI capabilities.
Use `vp run agent destroy` when finished.
Hourly cleanup and 24-hour expiry bound resource accumulation; see the root README
for costs and failure recovery.

The website Vite configuration prebundles the Lezer dependencies used by the
late-loaded source highlighter and `diff` used by audit history. Keep
`optimizeDeps.include` aligned with imports in `shared/semantic/` and late-loaded
UI modules: discovering dependencies during navigation can reload dev pages or
running test frames, invalidating React state.

There is no local Artifacts, Workers AI, Vectorize or AI Search emulator.
These bindings (the AI ones only when opted in) use real services; D1, Durable Objects and Workflows run locally
under the environment's `.gitmatrix-agent` state directory. The pinned Vite
plugin v2 reads `cloudflare.config.ts` directly. A pinned Miniflare lifecycle
patch makes local `cf d1` commands exit normally; do not terminate them early
after merely seeing output.

The canonical source host remains a separate, owner-managed environment:
from this directory, `vp run db:migrate`, `vp run db:seed` and `vp dev` use port 5180 and
`.wrangler/state`. Its AI is opt-in: plain `vp dev` binds no Workers AI, AI
Gateway, Vectorize or AI Search and prints `AI is off` when it starts;
`GITMATRIX_DEV_AI=enabled vp dev` binds the shared development resources
(`gitmatrix-dev`, `gitmatrix-knowledge`, `gitmatrix`), and every repository
pushed to it then gets paid Knowledge builds. Feature agents must not reuse that state or test mutations
against it. **Load samples** creates four small empty named repositories;
the agent harness fills them through real `gm` commits, without GitHub imports.

## Testing

Three kinds of test, each where it's cheapest to say what it checks. `vp test`
here runs the first two (projects `unit` and `browser` in `vite.config.ts`);
CI's test job runs them on every push. E2E runs only in `vp run ready` and
`vp run agent test`.

| Kind                       | Files                               | What belongs there                                                                                                                                                                                           |
| -------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node unit tests            | `**/*.test.ts`                      | Pure logic: parsers, reducers, URL and state helpers, and Worker routes over `worker/testing/` fakes (D1 over node:sqlite, Durable Object storage, git remotes).                                             |
| Browser-mode tests         | `src/**/*.browser.test.tsx`         | What a person sees and does: rendering, interaction, keyboard and focus, touch, reduced motion, themes and responsive layout, the address and Back/Forward, against mocked or in-memory APIs.                |
| End-to-end (`tools/agent`) | `e2e.ts`, `atlas-e2e.ts`, providers | Only what needs the real stack: sign-in and sessions, the Worker under `vp dev`, D1, git over HTTP and `gm`, CI runners, mirrors, deployments. A few journeys, asserting integration rather than UI details. |

When a UI behaviour can be checked against a canned or in-memory API, it's a
browser-mode test, not an E2E step.

The browser test server can choose the next available port, so separate agent
worktrees do not compete for Vitest's default port. The application dev server
still requires its configured isolated port.

### Browser-mode tests

Vitest's browser mode runs these in headless Chromium (Playwright's headless
shell, which `vp run agent setup` installs; elsewhere run
`vp exec playwright install --only-shell chromium` in this package). In CI the
image already has it (see "CI image" under [CI/CD](#cicd)). Run one file with
`vp test --project browser src/palette/Palette.browser.test.tsx`; add
`--project unit` for the Node tests alone. The helpers are in `src/testing/`:

- `renderApp(path)` (`render.tsx`) mounts the whole app, as `main.tsx` does,
  at an address: the real routes, loaders, shell and styles, with a browser
  router (the timeline scope's middleware reads `window.location`). It returns
  the router, `url()`, `waitForUrl()`, `navigate()`, `back()` and `forward()`;
  `unmount()` and a fresh `renderApp(url)` is a cold load of a copied link.
- `TestServer.start()` (`server.ts`) replaces `fetch` for the test. Each /api
  request goes to the newest matching canned handler (`server.on(method,
pattern, handler)`, a URLPattern pathname), then, with `{ world: true }`, to
  the **in-memory API**: the Worker's own routes (accounts, repositories,
  tracker and timelines, Knowledge, Atlas, search, `/api/dev/atlas`) over the
  migrated schema and development seed, in Vitest's Node process
  (`worker/testing/browser-api.ts`, reached through the commands in
  `vite/browser-commands.ts`). Requests act as the world's persona (marco by
  default; `server.as()` switches, and `server.call(..., as)` acts as someone
  else once). An explicit `null` persona means signed out; omitting the per-request
  persona uses the world's current one. `server.requests` records completed,
  unaborted requests for "it read only this" assertions; count handler entries
  separately when checking in-flight or cancelled requests.
- A world's repositories (`server.repo()`) have refs (`server.push()`) and
  accept ref-only pushes, but no git objects: file listings and history are
  canned (`cannedFiles()` in `git.ts`). No model, index or CI runner exists
  there; the Knowledge coordinator is idle. `atlasFixtureRepo()` (`atlas.ts`)
  publishes the Atlas fixture the way the non-AI E2E does.
- `server.sql()` writes the rows only machinery the world lacks would write
  (CI runs and jobs, deployments, wiki page sets, the push log), as it would;
  `server.registrySql()` does the same in the registry's database (feeds,
  packages, publishes).
  `timelines.ts` builds on it: a timeline across repositories with work on
  its bookmarks, checkpoints, approval requests, those rows, and a merge
  run's end that moves a real landing on (`mergeRunEnded`).
- `press()`, `pressUntil()` and `tap()` (`focus.ts`) drive the keyboard and
  touch; `browserCommands.emulateMedia()` sets reduced motion or a colour
  scheme; `page.viewport(w, h)` resizes.

Write assertions with `expect.element(locator)`. `toHaveTextContent` and
`toHaveAttribute` compare exactly; use `toMatchTextContent` for "contains"
and `expect.poll(() => el.getAttribute(...)).toMatch(...)` for patterns.
Pass a timeout to `expect.element(locator, { timeout })`, not the matcher.
Locator text with an apostrophe is safer as a RegExp. Restore what a test
changes in the page (viewport, theme, emulated media) in a `finally`.

Polling tests should fake only their interval clocks, leaving runner timeouts
and browser actions on real time. Hold a response behind a promise to exercise
the busy state and its elapsed-time bound; release it in `onTestFinished` too.
Assert pause, no overlapping checks and manual recovery—not one request per
timer tick, since busy revalidation deliberately skips ticks.

## Recent agent presence

CI run details, commit panels, selected timelines, and deployment disclosures
show **Agents seen recently** (CORE-41). This is separate from who authored,
pushed, started, or historically participated in the resource: an agent
inspecting someone else's work can appear too.

Successful authenticated agent interactions refresh a ten-minute observation.
Presence reads do not refresh it. The UI checks every 30 seconds while visible,
removes expired observations even when refresh fails, and says explicitly that
this is approximate—not proof that an agent remains online or is editing.
Deployment presence loads only when expanded.

The read-only endpoints are `/repos/:owner/:name/ci/runs/:number/presence`,
`/repos/:owner/:name/deployments/:id/presence`,
`/repos/:owner/:name/commits/:oid/presence`, and
`/tracker/:owner/timelines/:slug/presence`, all under `/api`. Existing resource
permissions apply; repository observations are isolated by code source.
Revoked agents are omitted. D1 retains only the latest observation per
agent/resource/source, returns at most 30 recent agents, and incrementally
reclaims expired rows. No request contents, tokens, or append-only access log are kept.

Local/offline operations such as ordinary `gm show` cannot be observed.
Successful remote single-commit context reads count for an existing commit even
when no context was recorded; enumerating a list does not mark every item as visited.

## Commit panel

There is no commit page (CORE-22): any repository page with `?commit=<sha>`
opens the commit as a side panel over it (`src/routes/repo/CommitPanel.tsx`,
mounted in the repository layout), and `/<owner>/<repo>?commit=<sha>` opens
it over the Code page from anywhere else. A short hash is resolved first.
Closing it (Escape, ×) returns to the page: Back, when a link on the page
opened it (parents opened from the panel are Back steps too); otherwise it
drops the parameter. The page under it never reloads for the parameter
(`keepPageUnderPanel` in `src/lib/commitPanel.ts`). Use `CommitLink` (or
`commitPanelUrl` off repository pages) for SHA links.

It reads, each independently, so one failing source doesn't hide the others:
the commit and its changed files with stats (`/commits/:oid/diff`; the log
for one too large to diff), CI runs (`/ci?commit=`), packages published
(`/api/packages/-/published?commit=`), deployments (`/deployments?commit=`),
who made it (the step's author, `/steps?commits=`), and the why chain
(`/why?commit=`: change id, refs reached and who pushed, timelines, landing).
Issue keys in the message link only when the resolver confirms an issue the
viewer can open; others stay text. People link to their profiles; agents are
named as text. "Browse files at this commit" opens the tree.

## File history

The repository file list shows each entry's most recent change, author,
co-authors and date. File views include the last change and a link to scoped
history. History and commit counts follow the selected revision's first-parent
chain; a path's history includes additions, deletions and mode changes but does
not follow renames. Co-authors (including agents) come from `Co-authored-by`
commit trailers, not verified account identities.

`GET /api/repos/:owner/:name/history` accepts `at=<ref>/<path>` or `ref` and
`path`, plus `entries=true` for immediate-child metadata. Each request scans at
most 100 commits. `next` is the next commit to scan; pass it as `cursor` and pin
`ref` to the returned `head` for subsequent pages. The file list loads this
separately from files and automatically follows pages until every displayed file
and folder has its latest change, then stops. One sequential scan serves the
whole directory, not a request per row; immutable history pages and commit/tree
objects are reused. Older pages never replace a newer last-change message.
Pending rows say **Finding last change…**; a failed page preserves resolved rows
and offers **Retry history**. Leaving the directory stops further pagination.
Counts remain partial (labelled with `+`) until **Load older history** reaches the
end. No file contents are read to calculate history.

## Sign-in

People sign in with an emailed one-time code ([Better Auth](https://www.better-auth.com),
`worker/better-auth.ts`, under `/api/identity`). Sign-up is **invite only**: a
code is only sent to an existing user, the instance owner (`OWNER_EMAIL`,
hello@fward.me) or an address a site admin invited at `/settings/invites`;
anyone else gets the same "check your email" answer. Failed codes and device
approvals count against the email and the IP through the `AUTH_FAILURES`
rate-limit binding; past the limit the key is locked out for 15 minutes.

- **Locally**, codes print in the dev server's log (the Email Service binding
  only simulates delivery), and hello@fward.me is the seeded superuser `fward`,
  reachable by email code or as a persona.
- **Deployed**, the owner's first sign-in makes them a site admin and the owner
  of the `matrixorg` organization (`OWNER_ORG`); the database starts with no
  other data. Codes are sent from gitmatrix@mail.fward.dev. Mirror pushes are
  attributed to the owner account, whoever configured the mirror.
- **gm** signs in through the browser: `gm auth login` shows a code and a link
  to `/device`, you approve it while signed in, and gm trades that one-time
  session for a personal access token (`POST /api/tokens/device`).

Deploying needs the `BETTER_AUTH_SECRET` and `REGISTRY_KEK` secrets. The Worker
serves https://timelinesapp.fward.dev (override with `GITMATRIX_PUBLIC_URL` at deploy
time), with production-only D1, Artifacts, Vectorize and AI Search resources so it
never shares data with `vp dev`. mail.fward.dev is enabled for Email Sending.

**CI deploys main.** Once check, test and build pass on main, the `deploy` job
(`tools/agent/deploy.ts`) ships only what changed since the deployed version:

- Every deploy tags its Worker version with its commit (`cf deploy --tag`), and
  the next run diffs from that commit. `node tools/agent/deploy.ts --plan` prints
  the plan from any checkout without changing anything.
- Changed `migrations/` or `registry/migrations/` apply to their database first;
  Worker code, assets or dependencies then deploy with `--containers-rollout none`.
  Docs, tests, `seed/` and `gm` changes deploy nothing.
- `gm` publishes to the owner's generic registry only when its source changed
  (`tools/agent/publish-cli.ts` asks the registry before compiling).
- A Sandbox has no Docker, so CI reuses the deployed CI image
  (`GITMATRIX_CI_IMAGE`). A change under `ci/` fails the job after the rest has
  shipped: run `vp run deploy` here, which builds the image and tags the commit.
  Jobs that start after cf's container rollout run in the new image.

The job's `CLOUDFLARE_API_TOKEN` is a repository CI secret (`gm secret set`).

**Adding a migration.** Name it by the current UTC time,
`YYYYMMDDHHMMSS_snake_case_description.sql` (for example
`20261003021500_ref_updates.sql`, from `date -u +%Y%m%d%H%M%S`), in
`migrations/`, `registry/migrations/` or `seed/`; don't use
`cf d1 migrations create`, which numbers the next file. D1 records applied
migrations by file name, and parallel work picking the same next number
collided once (the two `0016_` files). `cf d1 migrations apply` orders by the
integer before the first `_`, so timestamps apply after the frozen
`0001`–`0020` files; the test harnesses' sorted `readdir` agrees.
`worker/migrations.test.ts` (in `vp test`, so CI and `vp run ready`) fails on
a shared prefix, a new four-digit name or an invalid timestamp. A migration
merged after a newer one still applies, since D1 diffs by name, so write each
one to stand on its own. Update `worker/schema.ts` or `registry/core/db.ts` in
the same change.

**Parallel pushes.** The deploy job has `concurrency: production`: one deploy per
repository at a time, and a deploy still waiting when a newer push's run reaches
(or passes) its own deploy is skipped as superseded, so a burst of pushes deploys
once, from the newest commit (`worker/ci/concurrency.ts`). A deploy restarts the
CI Durable Objects and Workflows of runs in flight: their jobs start over in a
fresh sandbox (an attempt in progress is joined, a leftover container replaced,
a start that doesn't take is retried), with three retries per job.

**CI startup and deletion (CORE-345).** A repeated Workflow start joins the exact
existing instance only after its status can be read; a duplicate landing start
must not turn its running producer into a failed CI run. A real startup failure
keeps its original configuration error and settles only jobs that never started.
Cancellation and repository purge use the same boundary: pending/queued jobs
without a runner claim, start time or outstanding source acknowledgment can be
cancelled, while live consumers must still report completion. Purge also drains
such unstarted children of historical terminal runs, without rewriting the
parent's failure or treating Workflow termination as consumer acknowledgment.
A Sandbox infrastructure retry clears its active-attempt start and claim only
after container destruction is acknowledged and its job tokens are revoked.
The stopped queued retry can therefore be cancelled during Workflow backoff;
its prior logs, step state and failure evidence remain until a new attempt starts.
An unresolved or failed destruction retains the live-consumer boundary and keeps
source purge blocked.

**Fewer runs (CORE-23, `worker/ci/coalesce.ts`).** Starting a commit that already
has a run in flight on its branch returns that run. A job can declare `paths:`
(files or directories): on a push, it's skipped as unchanged when those paths
have the same git object ids as the last commit it passed on (with the same
spec), and the skip counts as a pass for jobs that need it; gm's Rust work is a
`cli` job with `paths: [apps/cli]`. With `on.push.coalesce_after: N` runs in
flight on a branch, a push's run is held; when one finishes, the newest held run
starts and covers the older ones (`covered_by`), and `gm runs wait` follows the
covering run.

**Documentation-only builds (CORE-134).** The required production `build` job
executes `tools/agent/ci-build.ts`, which uses the readiness planner against a
server-supplied successful-job baseline. Ordinary allowlisted README/changelog
changes and test-only changes need no compilation; site content Markdown,
runtime inputs and unknown/global paths still build. Check/test gates remain
mandatory, and the build job logs its decision and baseline rather than pretending
that a compiler ran.

The baseline must be an executed successful job from a successful run, in the
same canonical repository, with identical job specification and immutable
Worker/image execution identity. Reused/skipped jobs are not producers. The
consumer verifies that this commit is an ancestor present in its checkout and
compares the entire range, including earlier commits in a multi-commit push.
Missing evidence/history, changed runtime or configuration, and uncertain inputs
fall back to the full build. A Worker rollout therefore needs a fresh successful
build before documentation-only compilation can be omitted. Deployment continues
using each deployed Worker's own commit tag; it never uses this build baseline.

Inspect `gm runs logs N --job build` for `ci.build.plan`: `build: false`
means compilation was omitted, and `baseline.runNumber` / `baseline.jobId`
identify the successful producer. The required job still runs its selection
guard and must succeed; this is distinct from main's **Verified** candidate
reuse. Do not set `GITMATRIX_VERIFIED_BASE` by hand to request a fast path.
After a Worker rollout, a normal successful build (or an explicit
`gm runs start --ref main`) establishes evidence for the new runtime.

**Explicit merge queue (CORE-136).** `gm push --queue --issue CORE-123` submits
independent default-branch work without immediately advancing main. It uploads a
source staging ref, then admits a durable per-repository entry whose ID is the
full source commit. Admission is not landing or deployment. Save that ID in a
tracker checkpoint; use `gm queue show ID` or `gm queue wait ID --deploy` at work
boundaries, and continue unrelated work only under its own valid claim.

The queue pins the base and source, prepares an exact two-parent candidate, runs
the configured required merge gates on that candidate, then advances main with
compare-and-swap. Missing/invalid configuration, no runnable gates or skipped
required jobs fail closed. Persisted job specifications retain their `on` trigger
restrictions, so step-only and preview-only jobs stay excluded when landing gates
are verified; a skipped job that does apply still blocks landing. If main moves,
the candidate must be merged and tested again. Failed/cancelled entries release
scheduling capacity; retry fences off old
attempts. Post-landing main CI/deployment is tracked separately: failure creates
remediation without changing the landed status or rewinding main.
Notification retries do not block deployment startup or failure remediation.
If deployment recovery finds main has already advanced and the original pipeline
is missing, it never starts a new production deployment of the old candidate.
It follows the current main's real push pipeline only with Git ancestry proof;
missing newer-main CI stays pending for bounded recovery before an honest
infrastructure failure, and unrelated main history fails without inventing coverage.

Canonical push observers start only after the provider's receive-pack response
finishes, not on its initial headers. Responses remain streamed with backpressure;
source staging holds the final client EOF until its bounded provenance read ends.

Source staging refs do not start ordinary CI, knowledge or preview work. They do
record push provenance before returning, so subsequently uploaded step context is
verified against the staged commit without waiting for landing. Queue
gates run in full; no new path-based gate reuse is introduced. Ordinary exact-run
dedupe, push coalescing/coverage, declared complete `paths` input reuse and deploy
concurrency remain in place. AI never authorizes skipped checks: combining queued
descendants requires deterministic Git ancestry proof. Queue CI summaries have
`trigger: landing` and a nullable `queueId`, not a fabricated timeline link.
Candidate refs include the attempt: `gitmatrix/landing/queue-ID-ATTEMPT`.

Explicit submission opts into bounded queue inference through the repository's
captured AI settings. Scheduling remains a separate advisory `choice` decision;
both its reported confidence and combination probability must reach 0.95.
Repair requires all three Clef `noul` semantic checks—ordinary documentation,
compatible additions, and explicit approval of exact concatenation—to have
yes-probability at least 0.95. Repair `decision.confidence` records the minimum
of those three yes-probabilities, not the scheduling choice-confidence metric.
The classifier receives the unchanged base and each exact addition as separate
fields. Repair permits one classification call and at most one content-only generation, with 65-second and
125-second deadlines respectively. At most three ordinary documentation files
are eligible, bounded to 4,096 UTF-8 bytes per version and 16,384 aggregate bytes.
Unicode prose is supported. The exact base and both appended suffixes must be
preserved; invented edits are rejected. Executable, CI, auth/security, dependency, migration,
configuration, generated and agent-instruction files, deletion, binary content,
symlinks, traversal and ambiguous/model-invalid output are excluded. The model
proposes content, never commands. Runner checks and the full required gates still
apply; model outages or missing approval cannot authorize repair.

Failures create top-level, unassigned P0 `remediation` issues without taking over
the original work. Both remediation and linked originals expose read-only
`queueFailure`: `queueId`, `repo`, `commit`, `stage` (`merge`, `gates`, `deployment`),
`kind`, `reason`, `runNumber`, `failedJobs`, `conflictPaths`,
`classificationModel`, `repairModel`, and `occurredAt` (with attempt attribution
when available). Kinds distinguish build failures, conflicts, unsafe conflicts,
repair failures, infrastructure and configuration. These are trusted system
fields, not editable `IssueFields`; model identifiers are evidence, not approval.
The tracker's **Remediation** view selects open remediation, and issue detail
links to the actual CI run. Inspect logs/paths, claim with the normal online
fenced protocol, keep/renew any original lease as needed, and record genuine
recovery evidence before completing. No result or lost token grants ownership.

Use `gm queue list`, `show`, `cancel`, and `retry` to inspect and recover; retry
is only for failed/cancelled entries. Cancellation is refused while advancing or
after landing. Cancelling a combined member cancels only that member and
atomically invalidates/requeues the leader's original work rather than silently
cancelling the whole group. Queue-owned CI runs reject ordinary CI reruns: use
queue retry to create a new fenced attempt. An uncertain admission is
investigated by the deterministic queue ID, never silently retried as a direct
push. Ordinary
`gm push` and native Git pushes intentionally remain available for recovery:
they are **not universally protected by this queue**. A broken queue must not
prevent fixing Timelines itself. Timeline-bound work instead uses its existing
checkpoint/land queue: `--queue` is rejected there, and pinned human approvals
are never automatically weakened or replaced.

Repository deletion also fences queue admission, candidate publication and recovery
effects at the tombstone boundary. Purging cancels queue CI alongside other runs
and removes queue entries and their attempt history in the bounded row sweep;
deleted repositories cannot restart queue remediation or post-land work.

## Steps: work context per commit

Agents working in a timeline commit at each meaningful step and attach the
context that produced it (CORE-226). A step's context is stored per change and
commit in `step_contexts` (`worker/steps/api.ts`, contract `shared/steps.ts`):
instructions and human steering (each entry marked `hook`, `agent` or
`person`), why, challenges, test results (`local` from `gm test`, or
`reported`), coverage (how each part was captured) and harness/model. It's
keyed by gm's change ID, so amend and rebase add versions instead of
overwriting, and capped at 256 KiB per step.

| Route                                                                 | Does                                                                                      |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `POST /api/repos/:o/:n/steps`                                         | Upload one step (write access); retries replace the author's own record, others get 409   |
| `GET /api/repos/:o/:n/steps?timeline=&issue=&commits=&cursor=&limit=` | Newest first, paged (1–100, default 50); `commits` takes up to 100 comma-separated hashes |
| `GET /api/repos/:o/:n/steps/:changeId`                                | Every version of a change, newest first                                                   |
| `DELETE /api/repos/:o/:n/steps/:changeId/:commitOid`                  | Delete or redact (admins): the text goes, a tombstone stays                               |

Anyone who can read the repository reads its steps. A step is **verified** once
a push has shown Timelines its commit, at upload (from `change_refs`) or on a
later push (`worker/ref-log/record.ts`); until then it's "local, unverified".
Context is the agent's account, shown as such next to what Timelines verifies.

### The live feed

Each repository's steps in a timeline also go out live (CORE-239): a
`StepFeed` Durable Object per repository and timeline (`<repoId>:<slug>`,
`worker/steps/feed.ts`, the PRD's fallback ahead of K2) gets a small record
when a new step is uploaded (`StepFeedRecord`: repository, timeline, change,
commit, summary, issue, author, test counts, the first line of its why, never
the context itself). It keeps the newest 100 records for a week.

`GET /api/repos/:o/:n/steps/live?timeline=<slug>` streams them as Server-Sent
Events (`id: <seq>`, `event: step`, `data: <record>`): what the feed has after
`Last-Event-ID` (or `?after=`), then each new step as it arrives, with a
keepalive comment every 25 s. The route checks the reader can read the
repository, as for every step read; a stream ends after ten minutes and the
reconnect (with `Last-Event-ID`) is checked again, so lost access closes the
feed within that time. Records come at least once: readers dedupe by
(repository, commit).

The timeline page's **Live now** (`src/routes/tracker/LiveNow.tsx`) reads each
repository's feed with `fetch` (not `EventSource`), and shows each agent's
latest step, its test result, how many steps since when and its why, linked
into the story. `gm steps --follow` streams the same feed.

### Keeping work context

A step's why, challenges, tests and coverage are kept as long as the
repository. Three data-retention categories (CORE-244; see "Retention
categories" below) cover the rest, on the account's Data retention page:
`step-steering` trims instructions and steering text to a placeholder a year
after the step's commit (sources and times stay), `step-artifacts` removes
step-run summaries after 90 days, and `step-feed` keeps live feed records up
to 7 days (an account can keep fewer). Like every policy category, the first
two run once an administrator turns them on.

### Why on a line

`GET /api/repos/:o/:n/why` adds each chain's `step` (CORE-243,
`stepsFor` in `worker/steps/api.ts`): the step context of the chain's commit,
else the newest step of its change, so a line keeps its step after a rebase
and after landing. The file view's **Why?** panel shows it under **Step
context** (who recorded it, why, challenges, steering coverage, tests) and
links to the step in the timeline's story; `gm why` prints the same.

### The story view

A timeline's **Story** (`/tracker/:owner/timelines/:slug/story`, linked from
the timeline page; `src/routes/tracker/Story.tsx`) lists its commits newest
first along the first-parent line of the timeline's owned source ref, retained
after landing; abandoned timelines pin the source's last commit. Historical
canonical timelines use the contributing merge parent. The line stops at the
fork point, with merges marked. Legacy records without a source retain their
stored bookmark.
Each row shows the step's summary, agent, time, test result and how complete
its context is. Opening one shows the commit's diff beside its why,
instructions, steering, challenges and tests, with the missing-hook note when
a harness hook didn't record them. With character navigation enabled, `j` is
Next (the next visible row) and `k` is Previous (the previous visible row),
matching the visible buttons. Right/Down is Next and Left/Up is Previous even
without the opt-in; Escape closes. Clicks, keys and closing share the pending
destination, so a key immediately after a click or close does not use the old
render's selection. Filters by agent and issue and the step itself live in the
URL; an amended change offers its earlier versions. On a phone the list and the
step take the screen in turn.

It reads `history` for the line, `steps?commits=` for the context in batches
of 100, and the diff from `GET /api/repos/:o/:n/commits/:oid/diff`. History
pages, selected and amended diffs, and commit-panel links carry the timeline's
source identity; a physical `work` ref is never read in the canonical namespace.
The diff shows the commit against its first parent as hunks, bounded by `DIFF_LIMITS`
(`shared/diff.ts`: 300 files listed, 60 patched, 256 KiB per side, 400 tree
reads; binary and oversized files are counted without hunks). Diffs are
addressed by commit, so they're cached as immutable.

## Profile pictures and organization icons

People can set a picture (CORE-116) on **Settings → Profile**: upload one or
drop it on the card, then crop it to a square (drag or arrow keys to move, the
slider or +/− to zoom). The browser renders every picture to 256×256 WebP
before it leaves, so the Worker (`worker/avatars/api.ts`) only checks and
stores bytes: `PUT /api/account/avatar` takes a PNG, JPEG or WebP body up to
256 KiB (by its signature, not its content type), stores it in the `AVATARS`
R2 bucket (`gitmatrix-avatars`) under a content-hashed key, and replaces the
previous one; `DELETE` goes back to initials. Pictures are as public as
profiles and served from `/api/avatars/<user>/<hash>.<ext>` with immutable
caching. Only the person can change theirs: agents acting for them get 403.
`avatarUrl` rides on `AccountSummary` (and live tracker members, never tracker
history), and `Monogram` shows it with the initials as a fallback.

**Generated pictures** cost inference, so they're bounded: on request (and a
confirmation), the Worker makes **four** images with FLUX.1 schnell from fixed
abstract style presets, colored by a seed from the account id. Nobody can
prompt it and there are no rerolls: `avatar_generations` is claimed before any
model call, so a double click or second tab pays once, and once any image is
made the set is final. A generation that produced nothing can be tried again.
Options are private to their owner (`/api/account/avatar/options/:n`); picking
one opens the same cropper. Where AI is off, generation answers 503.

FLUX's input safety filter refuses harmless presets now and then, mostly at
random (about one in six on a first try; "plum" was dropped from the palette
for tripping it). Each slot retries its preset once, then a fixed fallback
prompt; one generation makes at most `MAX_GENERATION_CALLS` (10) model calls,
so a refused prompt can't leave someone short without spending more than that.

**Organization icons** (CORE-128) work the same way, under
`/api/accounts/:slug/avatar` (and `/options`): an org's owners and site admins
(people, not agents) set, crop, generate (once per organization, from
logo-style presets) and remove it, from **Change icon** on the organization's
page (`viewerCanManage` on `AccountPage` shows the control). Icons show as
squircles wherever the organization appears: its page, the rail, repository
lists and package pages.

## Personas (dev sign-in)

Development data (the personas below, Orbit Labs, the owner account) lives in
`seed/`, applied by `vp run db:seed` and the agent harness as local-only
migrations; deploys apply `migrations/` alone.

Picking a persona in development sets a cookie holding the account id. Production
rejects persona cookies and dev sign-in/token/seed endpoints; this mechanism is
not production authentication. Isolated environments require a private capability
for headless bootstrap. Always use a separate browser context for each environment.

| Persona    | Access                                                         |
| ---------- | -------------------------------------------------------------- |
| Priya      | Site admin: admin everywhere                                   |
| Marco      | Owner of the Orbit Labs org: admin on its repos                |
| Jun        | Orbit member (read), plus write collaborator on `orbit/engine` |
| Sam        | Read collaborator on `orbit/engine`; owns private `sam/notes`  |
| Francois   | hello@fward.me: superuser, also signs in by email code         |
| Signed out | Public repos, read only                                        |

Roles add up: public → read, org member → the org's base role, collaborator →
their role, owner/org owner/site admin → admin (`worker/permissions.ts`).
Repos you can't read return 404, never 403.

## Git over HTTPS

From the source worktree, use its scoped client:

```bash
vp run agent gm -- auth status
vp run agent gm -- clone orbit/engine
```

The clone belongs to the environment's external disposable workspace. Pass its
printed path with `vp run agent gm -- -C <clone> ...` for subsequent commands.
The harness keeps personal tokens and Git configuration out of the user's global
credential store. Browser-created **Access tokens** remain usable as an HTTPS
password by ordinary Git clients.

Tokens are `read` (clone/fetch) or `write` (also push), and are stored as SHA-256
hashes. The proxy checks the person's role and the token's scope, then streams
the request to Artifacts with a short-lived repo token cached per isolate.

## SSH keys over HTTPS

Workers speak HTTP, not SSH, so `gm` signs in with SSH keys without an SSH
connection: it proves it holds a registered key by signing a one-time
challenge, then uses a short-lived token like any other.

```
gm ─ POST /api/auth/ssh/challenge {fingerprints} ─▶ first registered key offered + nonce
gm ─ sign "gitmatrix-ssh-auth\n<origin>\n<nonce>\n<fingerprint>\n" (SSHSIG, namespace gitmatrix-auth)
gm ─ POST /api/auth/ssh/token {nonce, signature} ─▶ 1-hour session token (git + API)
```

- **Keys** are registered under **SSH keys** in the web app or with
  `gm auth ssh-key add` (Ed25519, ECDSA P-256/P-384, RSA ≥ 2048 with SHA-2), each
  read or write. Removing a key ends its sessions.
- **Signatures** are SSHSIG, the format of `ssh-keygen -Y sign` and git's SSH
  commit signing, verified with WebCrypto (`worker/ssh.ts`, tested against
  OpenSSH-made signatures). Nonces are single-use, expire in 2 minutes, and are
  bound to the server's origin; gm refuses to sign anything else.
- **gm finds keys like ssh**: the agent named by `IdentityAgent` in
  `~/.ssh/config` (how 1Password's agent is set up), then `SSH_AUTH_SOCK`, then
  `IdentityFile`s and `~/.ssh/id_*`. It signs through the agent, so 1Password's
  approval prompt works as usual; key files with a passphrase prompt at a
  terminal.
- **…or like git, when git uses another ssh.** If `core.sshCommand` (or
  `GIT_SSH_COMMAND`) names something other than plain `ssh`, e.g. `ssh.exe` in
  WSL so Windows OpenSSH reaches 1Password, gm uses that ssh's `ssh-add -L` to
  list keys (plus `user.signingKey`) and signs the way git signs commits: with
  `gpg.ssh.program` when set (e.g. `op-ssh-sign-wsl`), else that ssh's
  `ssh-keygen -Y sign`, given Windows paths. `gitmatrix.sshCommand` in git
  config sets the ssh for gm alone. Sessions are cached in `~/.cache/gitmatrix/ssh-session.json` and
  renewed with the key when they end.
- **Plain git** can use the same sign-in through gm as a credential helper:
  `git config --global credential.<server>.helper '!gm auth git-credential'`.

```bash
gm auth login                   # in the browser (or --persona priya in dev), to register a key
gm auth ssh-key add             # first key in your agent or ~/.ssh; --key to pick
gm auth login --ssh             # from now on gm signs in with the key
```

## Headless API

Every `/api` route accepts `Authorization: Bearer gmx_…` in place of the browser's
persona cookie; read-scoped tokens can only `GET`.

```bash
# From the source worktree, with agent up running:
vp run agent gm -- repo list
```

For direct HTTP clients, use the environment's printed origin and a scoped token;
never substitute the canonical server. `/api/dev/tokens`, `/api/dev/seed` and
`/api/dev/environment` require the harness capability in isolated environments.

| Route                                                                                     | Does                                                                           |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `POST /api/dev/tokens` `{persona, scope?, name?}`                                         | Mint a dev token; capability required in isolated environments                 |
| `POST /api/dev/seed`                                                                      | Reconcile empty sample repositories (dev only)                                 |
| `GET /api/session`                                                                        | Who the token or cookie belongs to                                             |
| `GET /api/personas`, `GET /api/users`, `GET /api/accounts/:slug`                          | People and orgs                                                                |
| `GET /api/search?q=&categories=&limit=&cursor=`                                           | Global search: see [Global search](#global-search)                             |
| `GET /api/repos`, `POST /api/repos` `{owner, name, visibility, description?, importUrl?}` | List, create or import                                                         |
| `GET\|PATCH\|DELETE /api/repos/:owner/:name`                                              | Detail with branches and tags, update, delete                                  |
| `GET /api/repos/:owner/:name/tree?ref=&path=`                                             | Folder listing, latest commit, README                                          |
| `GET /api/repos/:owner/:name/blob?ref=&path=`                                             | File contents                                                                  |
| `GET /api/repos/:owner/:name/commits?ref=&page=`                                          | History, 30 per page                                                           |
| `GET /api/repos/:owner/:name/semantic?ref=&cursor=&limit=&path=&kind=&language=`          | Individual syntax changes with source links and analysis coverage              |
| `GET /api/repos/:owner/:name/sources/:sourceId/pushes`                                    | Pending owned-source push operations, including incomplete recovery projection |
| `GET /api/repos/:owner/:name/sources/:sourceId/pushes/:operationId`                       | Exact retained operation, including terminal outcome and recovery audit        |
| `POST /api/repos/:owner/:name/sources/:sourceId/pushes/:operationId/recover` `{}`         | Prove acceptance or durably CAS-fence an interrupted owned-source push         |
| `GET\|PUT\|DELETE /api/repos/:owner/:name/collaborators[/:user]` `{role}`                 | Manage access (admin)                                                          |
| `GET\|POST /api/tokens`, `DELETE /api/tokens/:id`                                         | Your tokens                                                                    |
| `POST\|DELETE /api/session` `{accountId}`                                                 | Browser persona cookie; DELETE also ends an email sign-in                      |
| `/api/identity/*`                                                                         | Better Auth: email codes, device login (`/device/*`)                           |
| `POST /api/tokens/device` (Bearer: device session)                                        | Trade a one-time device session for a gm token                                 |
| `GET\|POST /api/invites`, `DELETE /api/invites/:email`                                    | Invitations (site admins)                                                      |

### Renaming a repository in place

Repository administrators can `PATCH /api/repos/:owner/:name` with
`{name?, description?, visibility?}`. For example:

```sh
gm api PATCH /repos/matrixorg/gitmatrix --data '{"name":"timelines"}'
```

The response is the updated repository summary. `name` uses the creation rules:
trimmed, 1–100 letters/numbers/dots/dashes/underscores, no leading dot and no
`.git` ending (case-insensitive). Invalid names return 400; a name already held
by another repository, including one awaiting deletion, returns 409. The entire
patch is rejected on collision, including description/visibility changes.
Deleted repositories return 404; readers/writers cannot rename (403, or 404
when they cannot read the repository). Omit `name` to retain the current name.

This changes the URL, not the repository ID or physical Artifacts name/remote.
Refs, Git history, owned timeline sources, permissions, registry provenance and
grants, CI records/secrets, mirrors and tracker/workspace ID references remain
attached to the same repository. No redirect or alias is created: old URLs stop
resolving, and the old name is available for a different repository. Ref/object
caches retain their physical storage keys. Historical tracker/checkpoint labels,
generated prose and recorded external links are not rewritten; inherited
timeline forks resolve the parent repositories by ID, not those old labels.
Live timeline, checkpoint, landing and approval-inbox responses resolve current
repository names by stable ID. Subscription links and Atlas workspace choices
also join current repository metadata by ID; stored subscriptions, checkpoints,
events and replica cursors are unchanged.

Before a production rename, exercise this on a disposable repository containing
a commit and an owned timeline source: record its ID and refs, rename it, read
the same commit/source through the new URL, and check the old URL is 404.
Also attempt an occupied name and a nonadmin rename, verifying both repositories
remain unchanged. Quiesce jobs/clients that already captured the old URL, then
update local remotes, CI configuration and external links. The PATCH does not
rename a GitHub repository, change a mirror destination URL, change package
names, or migrate authentication between application hosts.

## Global search

**The palette** (CORE-94): press **⌘K** (Mac) or **Ctrl+K**, or the magnifying
glass in the rail (the top bar on phones), from any page but sign-in. Type to
filter; **↑/↓** choose, **Enter** opens, **Esc** closes and returns focus to where
you were. It lists, in labelled groups:

- **In owner/name**: the current repository's sections (the same list as its tabs);
- **Go to**: the app's places (tracker, Needs you, packages, settings…);
- **Actions**: things to do, such as opening the assistant, and **Create issue
  in …** for each tracker you can use (the current one first);
- **Repositories**, **Issues**, **Packages**, **People and organizations**,
  **Conversations**: from `/api/search` as you type (debounced; signed-in
  only). Issues show their key, status and tracker; packages their format and
  owner; choosing a conversation reopens it in the assistant.
- **Find**: **Find a repository…**, **an issue…**, **a person or
  organization…**, **a package…**, **a conversation…** narrow search to that one
  category, with up to 20 results instead of 5.

Before anything is typed (CORE-152), the places don't fill the list: it opens
on **Go to…** (selected, so Enter opens it), then this repository's code
search, the likeliest **Create issue**, the assistant and the Find entries.
**Go to…** is a second step, like Raycast's: it lists every place, this
repository's sections first, and filters them as you type. Typing at the top
still reaches every place directly. Signed out, the few places are listed as
they are. Each second step (Go to, Find, code and wiki) shows above the input;
× or Backspace on an empty query goes back.

- **Jump to** (CORE-22): a reference goes straight to its place, first and
  selected: an issue key (`CORE-22`), a commit hash (7–40 hex: the commit
  panel, over the page in its repository; outside one, in the repositories
  visited recently), `#12` or `run 12` (a bare number in a repository) for
  that CI run, `pkg@1.2.0` for that version in its package's console, and a
  timeline's slug (or `timeline/<slug>`). `src/lib/resolveRefs.ts` is the one
  place references resolve: issue keys, hashes (in this repository, or each
  recently visited one) and packages (the page owner's) through
  `POST /api/refs/resolve`, runs through the CI API, timelines from the
  tracker's list;
- **Recent**: with nothing typed, right under **Go to…** (which stays
  selected), the last eight distinct places you opened (repositories, issues,
  CI runs, packages, timelines, commits), newest first, kept per viewer in this browser's `localStorage`
  (`src/lib/recentPlaces.ts`; nothing when storage is unavailable);
- **Timelines**: the tracker in view's timelines, matched by name and slug;
- **Or**: fallbacks that act on what you typed, such as **Create issue “…”**,
  which proposes the text as a title in the current tracker (else the one
  `/tracker` opens, else your own; the hint names it), but never a reference
  (a hash, an issue key, `#12`, `pkg@1.0`). Fallbacks come last and
  are never selected by default, so Enter on a search opens a result. **Ask
  Timelines “…”** (CORE-96) submits the text to the assistant in a new
  conversation and opens it; it's the only palette action that reaches a model,
  and only when chosen: typing, highlighting or closing sends nothing.

Create issue never creates anything itself: it opens the tracker's own
creator (CORE-95), which keeps its validation, drafts and same-operation
retries. The handoff is a one-shot intent in router state
(`src/palette/intents.ts`), so the title never appears in a URL, and the
tracker clears it as soon as it opens the creator, so back and refresh don't
reopen it. A title proposed this way leaves the capture box's draft alone.

Ask goes through the assistant's own provider (`ask()` in
`src/assistant/state.tsx`): one step mints the new chat and queues the prompt
addressed to it (`src/assistant/queue.ts`), and only that chat takes it, once,
after its own connection is up, so it can't land in the conversation that was on
screen, double-send on a re-render, or vanish into a socket a remount closed. The
earlier conversation keeps its history, pending approvals and unsent draft
(drafts are kept per conversation for the tab). Choosing a **Conversations**
search result reopens that chat without sending anything. While the palette
animates closed it ignores keys, so a quick second Enter can't run an option twice.

**Code and wiki search** (CORE-97) is a mode, not part of instant search: it
is semantic, paid (an embedding plus a Vectorize query and an AI Search
retrieval per submission) and per repository. **Search code and wiki** scopes
the palette to the current repository; elsewhere, **Search code and wiki in a
repository…** first offers repositories only. The scope shows above the input
(× or Backspace on an empty query leaves it). Typing and choosing a repository
send nothing; **Enter** submits to `GET /api/repos/:o/:n/knowledge/search` with
the viewer's read access, and a new query or scope drops the previous answer
until it's submitted. Results come in **Entities** (open the Knowledge Atlas
with that entity selected), **Code** (the file at the default branch) and
**Wiki** (the page), six of each. Only indexed
files and generated pages are searchable (not every file is indexed, binary and
oversized ones aren't), and searching never starts a build. The response says
which lookups answered (`providers`) and which index it read (`index.state`:
`none`, `building`, `ready`), so the palette says "isn't
indexed yet", "indexing is running" or "couldn't search …" rather than
"nothing matches"; where AI is off the endpoint answers 503 and the palette says
code search is off there. Instant entity search keeps working either way.

Local groups answer at once and keep working while remote ones load or fail;
a category that can't be searched says so instead of looking empty. Selection
follows the option you picked, so results arriving never move it, and only the
newest query's answer is ever shown. Signed out, the palette only navigates.
While it's open, page shortcuts (⌘J, tracker keys) don't fire. Code lives in
`src/palette/`: `commands.ts` is the typed catalog of pages and actions (a new
action adds a `CommandSource`), `selection.ts` and `remote.ts` hold the
selection and race rules, with tests in `palette.test.ts`.

`GET /api/search` (CORE-91) is the lookup behind the global palette: plain,
permission-aware matching over names and titles, never inference, embeddings or
AI Search. The contract is `shared/search.ts`; each category is a provider in
`worker/search/providers.ts` (packages in `worker/search/packages.ts`).

| Category        | Matches                                                                     | Leads to                        |
| --------------- | --------------------------------------------------------------------------- | ------------------------------- |
| `repositories`  | `owner/name` and description, readable repos only                           | `/owner/name`                   |
| `issues`        | Key, title and description, open and closed, in every tracker you belong to | `/tracker/owner/issues/id`      |
| `packages`      | `owner/name`, name and format, in feeds the registry lets you read          | `/owner/-/packages/format/name` |
| `accounts`      | Slug and display name; every profile is public                              | `/slug`                         |
| `conversations` | Titles of the viewer's own assistant chats, all of them                     | the chat (`{kind: "chat"}`)     |

- **Signed in only.** `q` is trimmed and whitespace collapsed: 1–100
  characters, at most 6 words, each of which must match. Empty, oversized or
  malformed requests get 400; nothing enumerates a directory.
- **Ranking.** `exact` (an identifier equals the query: `owner/name`, a repo
  name, a slug, a title), then `prefix`, `word` (a word in a name starts with
  it; `-`, `_`, `.` and `/` separate words) and `contains`; ties go to the most
  recently pushed or updated, then name, then ID. Every result says its `match`.
- **Authorization first.** Repositories are filtered in SQL by `readableRepo`
  (`worker/db.ts`, held to `permissions.ts` by the tests) before ranking,
  limits or cursors, so private repositories and other people's chats never
  reach a row, an order or a page. Responses are `private, no-store`; there is
  no server cache, so revoked access applies at once.
- **Bounds and continuation.** `categories` is a comma list (default: all, in
  the order above); `limit` is 1–20 per category (default 5). A group's
  `cursor` continues that category: pass it back with the same `q` and that
  category alone. Continuation stops at 100 results per category; past that a
  group reports `truncated: true` and no cursor, so narrow the query. There are
  no totals.
- **Issues across trackers.** Each tracker's Durable Object ranks its own
  issues in SQL (`TrackerStore.searchIssues`: exact key, then title prefix and
  words, then description; ties by priority, most recently updated, ID) and the
  provider merges them. Only trackers from `accessible()` are asked, so losing
  membership removes their issues at once; keys repeat across trackers, so
  each result carries its tracker. At most 25 trackers (yours first) are read,
  6 at a time; when some fail or are past that bound the group stays `ok` but
  sets `incomplete` to what was missed, and only when every tracker fails is it
  `unavailable`.
- **Packages from the registry's rules.** The provider builds the registry's
  own `Services` from the request, so it authenticates exactly as
  `/api/packages` does (cookies, tokens, CI job tokens), keeps only feeds
  `AccessControl.can(feed, "read")` allows (visibility, owner roles, repository
  collaborators, source-derived job grants), and matches packages in SQL only
  inside those feeds. Owner, format and name together identify a result, so
  equal names in other owners or formats stay distinct; ties go to name,
  format, owner, ID. Publication history and artifact contents aren't searched.
- **Failures stay local.** A category that throws or takes over 5 seconds
  comes back `{status: "unavailable", error}`, which is not "no matches", and
  the other groups are unaffected.

## References in text

Issue keys (`CORE-12`), this deployment's tracker issue URLs, commit hashes,
`owner/repo` and `pkg@version` become links wherever people read text
(CORE-22): commit titles (history, the file list), CI run titles and logs
(hashes only), release-note titles and summaries, issue and comment
Markdown, READMEs, wiki pages and assistant answers. Code (inline and
fenced) is never touched, and nothing inside another address is a ref.

**Only the server decides.** `shared/refs.ts` finds candidates;
`POST /api/refs/resolve` (`worker/refs/`) answers for the viewer:

```jsonc
// request: at most 100 refs of at most 300 characters
{ "refs": ["CORE-12", "3f2a9c1", "orbit/engine"], "context": { "owner": "orbit", "repo": "engine", "tracker": "orbit" } }
// response: one result per ref, in order
{ "results": [
  { "ref": "CORE-12", "status": "resolved", "target": { "kind": "issue", "path": "/tracker/orbit/issues/…", "label": "CORE-12 · Title", "tracker": "orbit", "id": "…", "key": "CORE-12", "title": "…", "status": "todo" } },
  { "ref": "3f2a9c1", "status": "resolved", "target": { "kind": "commit", "path": "/orbit/engine?commit=<40 hex>", "label": "…", "owner": "orbit", "repo": "engine", "sha": "<40 hex>" } },
  { "ref": "orbit/engine", "status": "unresolved" } // or "ambiguous", with "candidates"
] }
```

- **Issue keys** link only to an issue in a Timelines tracker the viewer
  belongs to. The page's tracker (`context.tracker`) is asked first, then the
  trackers subscribed to the page's repository (and its owner's), then the
  viewer's others (at most 25). The first tier with a match decides; two
  matches there are `ambiguous` and render as a small chooser. A key nobody's
  tracker has (`JIRA-9`, `UTF-8`) stays exactly as written: no dead links and
  no guessing at external trackers.
- **Tracker URLs** count only on this deployment's origins (`PUBLIC_URL` and
  the request's), and only in the tracker they name. One of ours the viewer
  can't open is `unresolved` with `ours: true` and reads as plain text; other
  domains stay the links they were.
- **Hashes** need a repository in context the viewer can read. A full hash
  must name a commit; a short one (7 to 39 lowercase hex digits) must prefix
  exactly one commit among the branch and tag tips, the repository's CI runs
  and its latest 200 default-branch commits (Artifacts can't expand an
  abbreviation). Prose scanning requires both a letter and a digit in short
  hashes to avoid linking words and numbers; explicit lookups also accept
  letters-only and numeric abbreviations. A hash opens the commit panel:
  inside the repository, the current page with `?commit=<full hash>` (other
  parameters kept), elsewhere `/<owner>/<repo>?commit=<full hash>`.
- **`owner/repo`** must be readable; **`pkg@version`** looks in
  `context.owner`'s feeds the registry lets the viewer read (the same name in
  two formats is `ambiguous`).

Responses are `private, no-store`; each request reads every tracker,
repository and feed once. The client (`src/refs/`) takes the context from the
address, batches every ref a render asks about into one request per context,
and keeps answers for a minute (failures for ten seconds). Text renders at
once and only gains link styling when the answer arrives; a failure leaves it
as text. `LinkedText` is the plain-text linkifier, `useRefMarkdown` the remark
plugin plus its `gm-ref` component.

`/-/go/<ref>` (with optional `?owner=&repo=&tracker=`) opens whatever a ref
names, for plain-text contexts and the palette: one match redirects, several
get a chooser, none says so. `GET /api/refs/go/<ref>` is the same for scripts:
a 302 to the target (or to `/-/go/` when it's ambiguous or unresolved), or the
result as JSON with `Accept: application/json` or `?format=json` (404 when
unresolved). `/go/` itself belongs to the Go module proxy.

## Semantic changes

The repository **Changes** tab (`/:owner/:repo/changes`) is a functional
work-in-progress feed of individual changes, not commit rows. Each entry links
to its originating commit and before/after source lines, with syntax-highlighted
excerpts. Ref, exact-path, change-kind and language filters are independent of
the existing Code and Commits views; ordinary Git diffs remain unchanged.
Final UI design and polish are intentionally separate work.

The shared engine in `shared/semantic/` supports TypeScript/TSX, Rust, Python,
Go, Markdown, XML, JSON, HTML and CSS:

- Programming adapters extract declarations, signatures, parameters, calls,
  arguments and imports. Unique same-scope declaration shapes permit conservative
  rename pairing; ambiguous matches remain additions/removals.
- Document adapters extract Markdown sections/links, JSON properties and array
  positions, XML/HTML elements/attributes/text, and CSS rules/declarations.
- Changes carry `evidence: "syntax"`: these are parser-backed facts, not resolved
  types, cross-file symbol identity, macro expansion, runtime effects or inferred
  author intent. Parent and child changes can both appear.

The repository file view uses those same grammars, plus YAML (`.yaml`/`.yml`) via
`@lezer/yaml`, and the Changes tab's shared token renderer in both themes.
Source appears immediately as selectable plain
text; a dedicated Web Worker applies syntax colors without parsing on the UI
thread. Source text selection and the knowledge rail remain available.
Highlighting is limited to 256 KiB of UTF-8 source. Unknown extensions, malformed
YAML, truncated/oversized files and unavailable or failed workers retain plain text;
binary files retain the existing not-shown notice. Navigation cancels the worker,
stale results cannot color another file, and a five-second watchdog terminates
unfinished worker loading/parsing. The worker uses only the syntax tree, not
semantic fact extraction.
YAML streams are validated before coloring, including every document in a
multi-document file: Lezer's recovery grammar alone accepts some invalid syntax.
YAML support is syntax-only; it does not add semantic change extraction or filters.

Click a line number to select it; Shift-click another to extend the range in
either direction. On touch screens, choose **Extend range**, then tap the other
endpoint. Line-number links remain keyboard-focusable (Enter selects a line;
Shift+Enter extends). Selection replaces the current history entry and uses
`#L12` or `#L12-L20`; opening either form highlights and scrolls to the selection
after client-side rendering. Invalid anchors are ignored; ranges extending past
the visible source are bounded to its last line.

The file header stays visible while scrolling, flush with the top of the
viewport (below the bar on phones). **Copy link** and **Copy permalink** are
always there: without a selection they link to the file, with one to its lines.
**Copy link** shares the current branch/tag/ref; **Copy permalink** pins the same
file and lines to the exact commit used to load the displayed source, not a newer
branch tip. The blob API returns that SHA as `BlobResponse.commitOid`. A
**Permalink** button also sits on the selection's first line, `Y` copies the
permalink from anywhere on the page, and `Esc` (or **Clear**) drops the
selection. Successful copies show a toast naming what was linked; denied
clipboard access shows an error rather than claiming the copy succeeded.

### API and pagination

`GET /api/repos/:owner/:name/semantic` returns the versioned
`SemanticFeedResponse` from `shared/semantic/types.ts`: `entries`, immutable
`head`, `nextCursor`, and separate file-analysis `coverage`. Kinds use
`<entity>.added|removed|changed|renamed`, plus `symbol.signature_changed`.
Source positions are one-based line/column coordinates with UTF-16 columns;
highlight token offsets are relative to the excerpt.

History follows the first parent; merge changes are compared with that parent.
The default limit is 30 entries (maximum 100), not commits. An opaque cursor
pins the head, repository, ref, filters and analysis version. Keep ref/filters
unchanged when continuing. Empty pages can have a `nextCursor` because scanning
is bounded: continue until the cursor is null, not until `entries` is empty.
Changing filters starts a new scan. File moves are not inferred across paths.

Per-page scan budgets are 12 commits, 24 tree reads, 8 changed files and 512
traversal steps. Unchanged trees are skipped. Sources are limited to 256 KiB,
10,000 extracted facts and 8,000 characters per excerpt. Large directories,
excessive nesting, binary content, unsupported files and parser failures have
explicit coverage diagnostics, never invented semantic results. Coverage is
independent of kind/language filters. Ordinary blob/diff access remains available.

Analysis is derived on demand and cached by repository, analysis version,
commit, path and blob pair; no schema migration or background index is required.
Repository authorization precedes analysis-cache access. Feed responses are
private/no-store.
Git object, ref and upstream-token caches share only completed data across
requests. Pending object loads stay reader-local so a closed request cannot
cancel another request's cached read.

### Extending the adapters

1. Implement `LanguageAdapter` in `shared/semantic/types.ts`: declare the language
   and extensions, expose its `parser: Parser` for syntax-only highlighting, and
   implement `parse()` to produce a Lezer tree, `SyntaxFact[]` and diagnostics.
   Register the adapter in `shared/semantic/index.ts`; the file viewer discovers
   its extensions automatically.
2. Give each fact a stable scope-local key and actual UTF-16 source offsets.
   Normalize insignificant syntax without changing strings or meaningful text.
   Use `signature` for declaration headers; supply `shape` only when conservative
   name-independent rename matching is justified. Report parser errors rather
   than guessing through invalid syntax.
3. Extend the language union and web filter list for a new language. Add exact
   before/after fixtures under `shared/semantic/fixtures/`, including ambiguity,
   formatting, meaningful whitespace and malformed source. Existing adapter tests
   and the real server/CLI smoke consume these fixtures.
4. Bump `ANALYSIS_VERSION` when extraction/comparison semantics change so cached
   analyses and continuation cursors cannot mix versions.

Lezer's pure-JavaScript parsers run inside Workers without native processes.
Language servers are appropriate for workspace-aware type/reference resolution,
but require project files, dependencies and a separate process host; this Worker
does not pretend to run them or label syntax evidence as LSP results. Lezer
grammars are not full compiler frontends: the current JavaScript grammar rejects
shorthand destructuring defaults such as `const {x = fallback} = source`, the Go
grammar has method-expression/type-argument limitations, and Rust macros remain
token trees. Rejected grammar forms are reported as `parse_error`.

### Isolated end-to-end smoke

Use the root [agent-first workflow](../../README.md#agent-first-development):
run `vp run agent setup`, keep `vp run agent up` running in another terminal,
then run `vp run semantic-smoke` from the repository root.

The smoke validates the scoped server identity and uses the harness's `agent gm`
wrapper, compiled binary, credentials and external disposable workspace. It creates
one uniquely named private repository in the environment's own Artifacts namespace,
pushes before/after fixtures for every supported language, and verifies actual
API/CLI entries, filters, pagination, source links, private access and ordinary
diff/blob/history behavior. Cleanup deletes only that repository and clone; it
never resets the environment, changes global credentials or uses canonical dev
resources. Missing setup or a stopped environment is an error, not a fallback.

For browser inspection, run
`SEMANTIC_SMOKE_KEEP=1 node apps/website/scripts/semantic-smoke.ts` directly
from the root so the environment flag reaches the script. Use a fresh browser
context, sign in as Priya, and open the printed URL. Send SIGINT or SIGTERM to the
printed smoke PID when finished; it removes the disposable repository and clone
without stopping the agent server. Use `vp run agent destroy` when the worktree's
environment is no longer needed. Run `vp run ready` for the complete uncached
quality and real-service E2E gate in addition to this semantic-specific smoke.

## Distributed issue tracker

Open `/tracker` from the global navigation. Select an account, create a team,
and capture an issue with the default **Create** action. The compact type selector
supports Bug, Research / investigation, and the other existing issue types.
Prefix a title with `(tag)`, or several `(tag) (another tag)` groups, to apply
catalog tags without retaining the prefixes in the title. Matching ignores case
and reuses the catalog spelling. Unknown tags offer **Define tag**; creation
waits until those definitions are accepted. Definitions remain drafts until the
issue saves successfully. Parentheses elsewhere remain ordinary title text.
The adjacent arrow opens **Add details**: the dialog carries the parsed title,
tags, type, selected team and workspace scope, and adds a Markdown description,
status, priority and assignee. **Create and edit** saves the issue and immediately
opens the existing editor for acceptance criteria, tags and relationships,
including from the blocker graph. Rejected submissions keep the draft; an
unconfirmed submission stays open with an idempotent retry rather than creating
another issue.

The **Tags** picker searches the tracker's **tag catalog** and offers **Create tag**
for a new name. Selecting or removing a tag in the issue editor saves immediately;
in the creation dialog it remains part of the unsaved draft. Names are 1–100
characters without NUL. Definitions persist after their last issue assignment is
removed, and include tags used in timelines.

**One vocabulary, three roles (CORE-271).** The catalog is the tracker's
work-area vocabulary (`ux`, `data`, `frontend`…). An _issue's tags_ say what the
work is about; an _agent's tags_ (`gm agent setup --tag ux`) say what work it
suits and are chosen from the same catalog; a _requirement_ `tag:ux` means only
agents tagged ux may claim the issue. In search, `tag:ux` means issues tagged ux,
so `tag:ux` always reads "has tag ux" for whatever is filtered or claimed.
Tagging an issue never restricts it by itself. Unknown names in agent tags or
`tag:` requirements warn (gm, the inspector) and are kept, never refused. Git
tags keep their own word on release pages ("Tagged releases"), and package
dist-tags keep "tag" inside package screens.

Old spellings keep working: the stored field and the snapshot catalog are still
`labels` (the `tracker_labels` table is unchanged, so replicas sync as before);
writes accept `tags` as well as `labels` (both at once must agree); the query
term `label:` is an alias of `tag:` (also `labels:`/`tags:`), in the tracker and
the release feed; `gm issue create|update --label` is an alias of `--tag`; the
assistant's `labels`/`label` parameters are aliases of `tags`/`tag`; the release
feed's `facets.labels` repeats `facets.tags`. Before CORE-271 the release feed
read `tag:` as `release:`; `tag:day:…`, and a `tag:` naming a release the feed
has, still do. `GET /api/tracker/:owner/tags` lists the catalog with counts
(`{tags: [{name, issues, open}]}`) and `gm issue tags` prints it from the replica.

The workbench keeps the list, board or blocker graph beside the selected issue;
phones navigate from the list into detail. Expand a ticket into a Markdown PRD,
acceptance criteria, parent/child plan, dependencies and durable comments, agent
checkpoints or evidence.

**Agent attribution (CORE-215).** Issue comments, checkpoints, evidence and Story
steps lead with the agent's own name; the shared identity label exposes its
accountable human in the tooltip and screen-reader text. Human authors retain
their own identity and profile link; an agent's name never links to its owner's
profile. New comments capture the authenticated author's identity on the server,
so later renames, deletion or timeline landing do not replace the original author.
Legacy comments without that snapshot resolve only by their exact actor ID in
the current directory; unresolved identities remain unknown, and an accountable
human's ID alone never implies an agent.

The search bar's **Clear search** (×) button clears both typed text and applied
query filters immediately, shows all issues, and returns focus to the input.
It preserves the selected layout and sort, and the empty query survives reload.
The button disappears when both the input and applied query are empty.

Bare ticket numbers match the exact issue number across teams (`223` does not
match `2230` or a title mentioning 223); full keys such as `CORE-223` match only
that key, case-insensitively. Other words and quoted phrases such as
`"release notes"` search keys, titles and tags. Quoting a number or full key
does not turn off exact ticket matching. Existing filters still apply, and a
leading `-` excludes a match.

Same-origin absolute links in tracker Markdown navigate within the app without
a full reload. External links and modified clicks keep normal browser behavior;
relative links and fragment links remain native anchors.

Assignee facets select exactly that actor's issues: people use their account
slug, while agents use their stable ID (`assignee:agt_…`). Agents with the same
name but different accountable people remain distinct. `assignee:me` selects
the signed-in identity and `assignee:none` selects unassigned issues; other
active filters still apply.

Use **Close issue** when work will not be completed. Choose Duplicate, Not planned,
No longer needed, Cannot reproduce, or Other, then **Confirm close**. This saves
the issue as `canceled`, not `done`; the selected reason stays visible after reload.
Creating or editing an issue into Canceled also requires a reason. **Reopen**
returns it to To do and clears its current reason; the event history retains the
earlier closure. Historical cancellations without a reason remain editable.
The API uses `issue.update` with `status: "canceled"` and `closeReason` set to
`duplicate`, `not_planned`, `obsolete`, `cannot_reproduce`, or `other`.
Existing version and lease checks still apply. Closing does not complete
subtasks or satisfy dependent issues' blockers.

**Timeline** (in the create form and the editor) tells agents whether to work an
issue in a timeline: Agent decides (the default), Required or Never. Required can
name the policy the timeline must use, Auto or Approval. The API stores it as
`timelineUse` (`agent_decides`, `required`, `never`) and `timelinePolicy` (`auto`,
`approval` or null, allowed only with `required`); issues from before the field
read as `agent_decides`.

- **Ownership:** a personal account or organization owns each tracker. An issue
  has one team and zero or more cross-team workspaces. Team prefixes and workspace
  slugs are permanent; archival preserves history.
- **Repository subscriptions:** any number of repositories can subscribe to any
  number of workspaces. The repository's **Issues** tab previews ready issues
  only from trackers the viewer already belongs to. A subscription grants neither
  tracker membership nor repository access. Managing one requires both tracker
  ownership and repository administration. After a repository is deleted, its
  tracker owner can remove the orphan association.
- **Permissions:** account members can read the tracker. Owners administer teams,
  workspaces and subscriptions. A nonempty team membership list restricts issue
  writes and assignees; an empty list permits all current account members. A site
  administrator is not automatically a member of every tracker.
  Team membership edits check an assigned agent's accountable person, not the
  agent ID: retaining that person permits renaming the team, while removing them
  from a restricted team requires reassigning their agents' issues first.
- **Graph:** `FROM blocks TO`; only `done` satisfies a blocker. Canceling a
  prerequisite does not silently unblock its dependents. Parent hierarchy is
  separate and does not imply blocking. Both blocker and parent cycles are rejected.
  The relationship view starts at the leftmost occupied dependency column rather
  than reserving space for missing steps. Blockers remain left of the selected
  issue and dependents right; phones stack the selected issue first.
  Live dependency and issue-state edits refresh connector positions and styling
  without requiring a focus change or a resize.
- **Coordination:** ready work is unblocked, unclaimed `todo` (or an expired
  claimed `in_progress` issue) with no open sub-issues, no other active lease
  above it, nothing waiting on a person, and pickup permitted for the acting identity
  (`readiness` in `shared/tracker.ts`, mirrored by gm). Exclusive claims require an online transaction. Renew,
  release and complete require the unexpired fencing token; completion also
  records supplied evidence when present, rechecks blockers and refuses parents with open sub-issues.
  Tokens never appear in public snapshots or event feeds.
  Granting a lease also assigns an unassigned issue to its holder's identity in
  the same transaction and audit event. Delegated claims use the receiving
  agent, not the delegator or session name. Existing assignees are preserved,
  including on renewal, handoff and takeover; ending a lease does not clear assignment.
  Lease grants use the same assignee validation as issue edits: the assignee
  (or an agent's accountable person) must be an account member and belong to any
  restricted owning team. Admin write access does not waive this requirement.
  Invalid assignments reject the claim atomically without changing the issue or lease.
- **Pickup (CORE-49):** each issue has a global `pickup` policy, independent of
  status and timeline: `anyone` (also the legacy default), `not_ready` (nobody
  may start), or `human_only` (authenticated people, never agents). Choose
  **Pickup** in **Add details** before creation or in **Edit issue** afterward;
  edits autosave. Quick title-only capture uses Anyone. CLI create/update take
  `--pickup anyone|not_ready|human_only`.
  Ready lists exclude restricted issues for agents; `is:not_ready` and
  `is:human_only` expose them explicitly. Human-only work remains available to a
  person's `issue.next`. Explicit assignment, capabilities, session labels and
  delegated claims do not bypass this policy. The server enforces it on claims,
  renewal, resume, handoff, completion and direct work-status transitions.
  Agents may restrict open pickup but cannot change an existing restricted
  policy; a person must re-enable it. Incompatible active claims must be released
  before restricting pickup; retained timeline claims must land or be abandoned.
  Offline edits are advisory until server synchronization; rejected batches
  remain explicit conflicts rather than silently granting access.
- **Graph engineering (CORE-4):** agents work through issue graphs on their own.
  - _Agents_ are identities a person creates (Settings > Agents, `gm agent`); they
    act with their person's access but everything is attributed to the agent, and
    every mention names the accountable person ("builder for Ann Lee").
  - _Capability profiles (CORE-33)_ extend those identities with self-reported
    harness/model, OS/architecture, runtime, CPU/memory, tags and installed skill
    metadata. `gm agent detect` observes locally; `configure [NAME]` publishes;
    `show [NAME]` and `list --owner OWNER` expose profiles for human/agent choice.
    Tracker snapshots include member-accountable agents' capabilities, report
    timestamps and revocation state, but never their tokens. Capabilities do not
    alter membership or permissions; they only decide eligibility for issues
    with requirements (below).
    `GET /api/agents/:id` (`self` for an agent token) reads an owned profile;
    `PUT /api/agents/:id/capabilities` replaces its version-1 report. An agent's
    write token may update only itself; read tokens cannot update profiles.
    People can create an identity with capabilities through `POST /api/agents`.
    Strict bounded reports reject unknown fields; old identities retain null
    capabilities. Apply migration `0016_agent_capabilities.sql` before deploying.
    See the [CLI profile workflow](../cli/README.md#agent-capability-profiles)
    for detection limits, declaration replacement and privacy.
  - `issue.next` (`gm issue next`) picks and claims in one step: priority, then
    the most open work transitively unblocked, then age; it skips PRDs, other
    people's assignments, pickup restrictions and requirements the agent doesn't meet.
  - _Requirements (CORE-32)_ say which agents may claim an issue: `requires`
    on `issue.create`/`issue.update` (null clears; recorded in history like any
    field) holds `tags` and `skills` (every one), `models`, `harnesses`, `os`,
    `arch` and `runtime` (any one; `*` wildcards; all case-insensitive),
    `minMemory` (bytes) and `minCpus`. `shared/requirements.ts` parses the text
    form (`tag:ux model:claude-opus-* memory>=16GiB cpus>=8`, used by gm, the
    inspector and the assistant) and matches it against the agent's reported
    capabilities; issues without the field behave as before, and old replicas
    ignore it. An agent that doesn't meet them can't `issue.claim` the issue,
    isn't offered it (`issue.offer` to it, `issue.accept` by it) and `issue.next`
    passes it over, reporting `skipped: {requirements, keys, message}`. Refusals
    are 409 `requirements_unmet` with one `unmet` entry per requirement; an
    agent with no reported capabilities is told to run `gm agent setup`.
    People bypass capability requirements, not pickup or readiness rules. Assigning
    an agent that doesn't meet them takes a person, the tracker owner or the agent's
    accountable person; assignment overrides capabilities only. The inspector shows the mismatch. This is
    eligibility, not authorization: capabilities are self-reported, and
    permissions apply as before. The inspector edits requirements as chips and
    lists each agent's eligibility; list and board rows mark them; the query
    terms are `requires:ux` (`requires:tag:ux`, `requires:none`) and
    `eligible:<agent>` (`eligible:me` for the acting agent). Settings > Agents
    shows each agent's eligible open work per tracker (`GET /api/agent-eligibility`).
  - _Requirements usability (CORE-272)._ The create dialog edits requirements with
    the inspector's editor, and both offer **Require agents tagged with this
    issue's tags** (`gm issue update --require-issue-tags`). **Tightening a claimed
    issue is never silent:** when new `requires` no longer allow the agent holding
    it (`tighteningEffect` in `shared/tracker-query.ts`, the same on both sides),
    the inspector asks first, naming the holder, its session and what it misses,
    and offers **Release the claim** or **Keep it**. `issue.update` then reports
    `results[].claimEffect {actorId, agent, session, unmet, released}` and adds a
    comment recording either choice. `releaseClaim: true` releases it (the issue
    goes back to `todo`, unassigned from that agent so `next` does not hand it back); only a tracker owner or the agent's accountable person,
    acting as themselves, may (403 otherwise). Without it the claim is kept. A
    claim's own assignment doesn't exempt its holder here; people's claims are
    never affected. gm prints the effect and takes `--release-claim`, and the
    assistant's `update_issue` reports it and takes `releaseClaim`. List rows show
    up to two issue tags (a `+N` for the rest) and board cards one; the
    `requires` mark's tooltip and accessible name read plainly ("Only agents
    tagged ux and with model claude-opus-*", `requirementsSentence`). The
    inspector's eligible-agents list adds the profile change that would meet
    each mismatch (`profileFix`), Settings > Agents lists a few issues each agent
    can take now (`AgentWork.takeable`), and `issue.next` adds
    `skipped.blocking` (the terms that kept the most issues) with the
    `gm agent setup` flag that would meet them in its message.
  - _A lease covers its subtree._ Claiming a parent (allowed even with open
    sub-issues, which are never offered as work themselves) excludes everyone else
    below it; status and parent changes there need the covering token. The holder
    delegates child leases with that token (`underToken`, optionally `forActorId`
    for one of its agents) and any lease above a claim can revoke it.
  - _Waiting on a person_ sits beside status: `request.open` asks a question,
    approval, decision or credential, routed to the asker's accountable person.
    Asking with the lease token parks it (no expiry); the last answer unparks it
    for an hour for its holder to `issue.resume` with a fresh token. Only people
    answer, on Needs you (`/needs-you`, `GET /api/requests`), on the issue, or
    with `gm request`. Credentials go to the named repository secret; the tracker
    records only where.
  - _Handoff:_ `issue.offer` returns a single-use code bound to the current
    lease token; `issue.accept` moves the lease (and its accountability) with a
    fresh token and fences the giver's at that moment.
  - _Owner override:_ when a claim's holder won't finish (a lost session, a
    deleted token, a stuck agent), a tracker owner acting as themselves (not
    through an agent token) can take it over with `issue.claim {force: true}`
    (`gm issue claim KEY --force`), getting a fresh token, or end it with
    `issue.release {force: true}` (`gm issue release KEY --force`, or End claim
    on the issue page), returning it to todo. The holder's token stops working,
    the issue gets a comment naming the claim that was overridden, and it
    doesn't count as the holder's failed attempt.
  - _Escalation:_ releases without completion count as attempts; at the team's
    `attemptLimit` (default 3, 0 off) the issue asks its accountable person what
    to do differently, with the latest checkpoints, and waits until answered.
- **Distribution:** each account has one `TRACKER` SQLite Durable Object authority.
  Atomic batches, actor/payload-bound operation receipts, version checks and an
  ordered event cursor synchronize private CLI replicas. Lost acknowledgements
  replay the same operation; conflicts preserve local intent for explicit
  resolution. This is not Git-based issue storage. See the
  [offline CLI and agent workflow](../cli/README.md#distributed-issue-tracker).
- **Human workbench:** closed work is hidden by default; readiness, team and
  workspace filters stay in the URL. Desktop collection/detail panes scroll
  independently; mobile filters and account actions are disclosed on demand.
  Closed board lanes retain their counts and expand to show closed issues.
  Add subtasks from the parent without leaving it; only active workspaces are
  inherited. Checkpoints, claims, blockers and completion evidence remain distinct.
- **Completion evidence** (CORE-126): issue detail has a dedicated section and
  summary link at `#completion-evidence`, with a stable fragment target for every
  original note at `#evidence-<comment-id>`. **Add completion evidence** records a durable
  tracker comment with `kind: "evidence"`, not a second completion record.
  Evidence is recommended but optional when completing; omitting it creates no
  synthetic note and does not relax leases, blockers or approval requirements.
  Original note IDs, authors, timestamps and bodies remain available after
  reopening and independently of the bounded recent activity feed. A note
  records what its author verified; neither its presence nor `done` is proof of
  checks the author did not perform.
- **Creator and audit:** issue details show **Created by** and the creation time
  without opening history. Expand **Audit history** for newest-first events,
  including comments, requests, relations and parent changes. Entries default to
  compact actor/time rows with changed-field deltas: short before/after values,
  added/removed tags and workspace associations, and changed words for descriptions
  and other long text. Previews show at most three fields and four text changes,
  with bounded excerpts; large rewrites use a truncated preview instead of an
  expensive diff. Creation events do not repeat every default field, and missing
  earlier values are labeled rather than presented as inferred changes.
  Expand an event (click, Enter or Space) for complete before/after values, the
  actor's identity and accountability, client-reported source and operation ID;
  **Full event details** exposes the complete sanitized event. Current names make
  reference-field previews readable; full values retain the original IDs.
  **Load older events** pages through the history. History loads only while
  expanded, refreshes when the snapshot cursor advances, and resets on
  issue/account changes. Activity & handoff remains the comments workspace.
  Legacy attribution/source gaps are labeled unknown; current-directory identity
  resolution is labeled separately from mutation-time snapshots.
- **Startup defaults:** in **Account menu → Preferences → Default view and team**, choose
  List/Board/Graph, an issue-view preset, and an active team or all teams.
  Defaults are saved on the server per person and per tracker, so they follow
  you across browsers and devices, and each tracker keeps its own. Saving also
  makes this tracker the destination of the global **Issues** link. A default
  saved by an older version in this browser is carried over once, on the next
  visit. The chosen team filters the initial view and supplies the new-issue
  team. Explicit URL filters, layouts and capture teams override defaults,
  including an empty query. Unavailable trackers fall back to the first
  accessible tracker; archived or unavailable default teams fall back to all
  teams. **Reset defaults** restores the built-in startup behavior.
- **Clear search:** the button and an empty or whitespace-only search submission
  restore your saved issue-view preset and active default team (`is:open` when
  no defaults are saved). **Everything** remains a valid saved default.
  Choosing **Everything**, **Show everything**, or an explicit empty `q=` URL
  still requests all issues; clearing search does not change saved preferences.
- **Keyboard shortcuts:** press `?` or use **Keyboard shortcuts** in the rail for
  accessible help. Character navigation is off by default; enable it in
  **Account menu → Preferences** for this browser. `g i` opens the current
  tracker (or the default tracker without context), `g p` opens Packages, and
  `g h` opens Home. Press both keys within one second; another key, a route or
  focus change, pointer interaction or leaving the window cancels the chord.
  In the tracker, `c`/`n` captures an issue, `/` filters, `j`/`k` selects the
  next/previous issue, and Escape closes it. In Story, `j`/`k` invokes
  Next/Previous. Story's buttons, row clicks, arrow/letter keys and close actions
  share the requested selection and acknowledge it against the live URL, so rapid
  mixed input does not navigate from the previous render. Help and navigation
  avoid text entry, composition and other dialogs; help traps focus and Escape
  restores it. Cmd/Ctrl-K search and Cmd/Ctrl-J assistant shortcuts are unchanged
  outside help.
- **Settings:** the gear at the bottom of the navigation rail opens a shared
  settings area, starting with **Teams and workspaces** for the current tracker,
  or your default tracker when outside a tracker. A left-hand section navigation
  brings together **AI settings**, **AI providers**, profile, preferences, access tokens, SSH keys,
  agents, and invitations for site admins. On smaller screens it becomes a
  collapsible section menu. Account context follows section links; personal
  settings still belong to the signed-in person. Existing permissions apply.
  Tracker administration includes teams, workspaces, and repository subscriptions;
  changing its account stays in Settings. **Back to issues** retains the current
  filters and layout.
  Profile, personal, account and site forms share a left-aligned 48rem content
  column (`SettingsPage`), the kit's 20px section padding, and wrapping,
  left-aligned primary actions (`mk-form-actions`, 44px minimum targets).
  Validation feedback sits above the action row rather than squeezing its
  buttons. Repository creation and settings use the same form width; repository
  settings stay in one column so visual and keyboard reading order agree.
  Usage, retention and tracker administration deliberately retain their wider
  data layouts (`SettingsPage wide` or `tracker`). Desktop settings reserve a
  stable scrollbar gutter so short and long pages stay on the same horizontal
  axis; phone dialogs and the assistant retain the full viewport width.
- **Default team in one click:** the star next to each team in the facet
  column makes it your default; the filled star marks the current one, and
  clicking it clears the default. Under the query bar a note names the default
  team, says that gm and your agents use it too, and offers **Show all teams**
  and **Change**; quick capture marks it with ★. Without a default, quick
  capture picks your only team, else the team you or your agents last filed
  into, else the first open team.
- **gm uses your default team** when nothing more specific names one. Most
  specific first: `--team` (or `--all-teams`), this checkout's
  `.gitmatrix/agent.local.yml`, the project's `.gitmatrix/agents.yml`, your
  default team, then all teams. `gm issue next`, `create`, `list` and `ready`
  report the team they used and why in `team`; `gm tracker status` shows
  `defaultTeam`. Agents read their person's default but can't change it, and a
  `next` scoped to a workspace or parent doesn't add it.
- **Inline editing:** click an issue title or its description/acceptance text to
  edit just that field in place. Each text section also has a keyboard-accessible
  **Edit** button, and empty sections offer an **Add** action. Markdown preview
  remains available; links in rendered Markdown still navigate normally.
  Leaving a valid inline title, description, or acceptance editor returns it to
  read-only display immediately, showing the submitted text optimistically with
  **Updating** until the server acknowledges every queued edit. A nearby **Updated**
  check then appears for four seconds. Unchanged fields do not claim an update.
  Failed saves keep a recoverable draft with retry, review, and discard controls,
  even after the editor closes. Preview controls remain usable, and typing during
  a pending save keeps newer text until its own versioned save completes.
  The complete **Edit issue** form stays open while moving between fields.
  Text fields save on blur; tag selection/removal, selects, the parent picker, and
  workspace checkboxes save immediately. Saves are serialized, preserving edits
  made while an earlier request is running, including when **Done** closes the
  form before either request finishes. The editor shows Updating, Updated, or
  an error with retry/discard controls; closing an issue waits for a close reason.
  **Discard unsaved changes** closes the draft without autosaving the focused
  field; previously saved values remain unchanged.
  **Done**, **Ctrl/Cmd+Enter**, or **Esc** queues remaining changes and finishes
  editing without canceling persistence; Enter does the same in a title.
  Navigation still waits for pending edits, and unsaved or uncertain drafts
  survive a reload in the same tab. **Edit issue** (or
  `e`) and **Create and edit** open the complete autosaving form. Issue creation,
  comments, and new relationships retain explicit submit actions.
  A confirmed save applies the server's committed entities immediately; the
  whole-tracker refresh runs in the background and cannot replace a newer
  acknowledgement with an older snapshot. Rendered descriptions and acceptance
  criteria stay mounted while editing, avoiding a full Markdown rebuild when
  finishing unchanged text or saving other fields on a large issue.
  Text-only mutations do not rebuild the tracker dependency graph; changed
  status and parent relationships still resolve and enforce covering leases.
- **Browser conflicts:** drafts persist for the tab session. Review named fields,
  choose individual remote values, then explicitly rebase; untouched remote
  fields are retained. Tags and workspace membership compare as sets, so
  reordering does not overwrite another person's changes. Errors remain beside
  the failed action. A known conflict is reported immediately, without waiting
  for the background refresh that supplies newer comparison fields.
  An uncertain write blocks new server mutations and retries
  its original operation ID; local editing and form dismissal remain available,
  and confirmation acknowledges the original save before sending queued edits.
- **Keyboard:** character navigation is off by default; enable or disable it
  through **Account menu → Preferences**. The preference persists locally.
  `c` or `n` focuses capture, `/` focuses search, `j`/`k` selects adjacent issues,
  and Escape closes the selected issue. Shortcuts do not run while typing or
  interacting with form controls. The enabled legend lists the available keys;
  `?` or the rail’s **Keyboard shortcuts** button opens global help.

| Route                                                             | Contract                                                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `GET /api/tracker`                                                | Trackers accessible to the authenticated account                                                        |
| `GET /api/tracker/:owner/snapshot`                                | Complete authorized replica snapshot and cursor                                                         |
| `GET /api/tracker/:owner/changes?after=N&limit=200`               | Ordered event page; resume from the returned cursor                                                     |
| `…/snapshot?timelines=1`, `…/changes?…&timelines=1`               | Also timelines and their events (entity types `timeline`, `timelineEvent`), for replicas that know them |
| `GET /api/tracker/:owner/issues/:issue/history?before=N&limit=50` | Authorized issue audit; ID or key, newest first, exclusive cursor, default 50 / maximum 100 events      |
| `POST /api/tracker/:owner/mutate`                                 | `{operationId, mutations:[{kind,id,expectedVersion?,data?}]}`; 1–100 ordered operations, all or nothing |
| `GET /api/repos/:owner/:name/tracker`                             | Accessible subscribed workspaces for repository navigation                                              |

Updates require the version last read; stale writes return `409 version_conflict`
with current state. Issue IDs are stable client-generated identifiers; the authority
assigns readable keys such as `ENG-42`. Mutation bodies are limited to 1 MiB.
Tracker mutation clients declare `X-Gitmatrix-Source: web|cli|api|assistant`;
the browser sends `web`. This is a provenance hint, never authentication.
History retains immutable actor snapshots and before/after state, excludes
lease and credential secrets, and requires the same tracker membership as snapshots.
`shared/tracker.ts` defines the wire types; `gm schema issue batch` exposes the
CLI contract. No new D1 migration is needed: the Durable Object initializes its
own schema. Generate the new binding with `cf workers types`.

These primitives support durable agent handoffs. An autonomous hours/days-long
execution loop is not included.

### History: issues over time and linked work

History (CORE-42, named in CORE-278) is the tracker on a time axis. Two read-only routes
serve it; the shapes and the pure readers (`stateAt`, `summarize`) are in
`shared/chronicle.ts`, the replay in `worker/tracker/chronicle.ts` and the
linked work in `worker/tracker/work.ts`.

The view switcher and account's default-layout picker both call this **History**:
it shows what happened, not a new kind of work or a planning schedule. The stable
`chronicle` view ID, saved preferences, URLs, API routes and implementation names
are unchanged, so existing links still open the same view. **Timelines** remains
the name of separate lines of work; the inner layout toggle is tracked separately
in CORE-280.

| Route                                                                          | Contract                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/tracker/:owner/chronicle?from&to[&q][&cursor][&limit=100][&quiet=1]` | Issues matching tracker query `q`, each as of `from` with every state change, work span and marker until `to`; paged by issue key (`next`), at most 200 issues and ~20,000 events read per page; the first page adds the event density over the whole history |
| `GET /api/tracker/:owner/issues/:issue/work`                                   | The issue's commits, agent work contexts (steps), CI runs, deployments, published packages, timelines with checkpoints and landings, and release-note entries, each with the `href` the web app opens                                                         |

- **As of.** An issue's state at a time is the state after its last event at
  or before it. A change made in a timeline reads as the timeline saw it,
  except that main's `done_in_timeline` stands until the timeline lands.
  `q` uses the tracker's query language (`shared/tracker-query.ts`) against
  the issues as they are now; issues closed before the range and untouched in
  it are left out (counted in `quiet`) unless `quiet=1`.
- **Work spans** run from a claim through renewals (and parking, while the
  issue waits on a person) to a release, completion, revoke, takeover,
  handoff, or the landing or abandoning of the timeline that retained the
  lease. Expiry records no event, so a lapsed span ends at its lease's expiry.
  Each span names its holder (person or agent, with the accountable human).
- **Markers**: creation, comments, checkpoints and evidence, requests asked,
  answered or withdrawn, links added and removed, landings, and the
  checkpoints and landings of the timelines the issue was worked in.
- **Retention.** When `tracker-activity` pruned the log, `history.pruned`
  says before when events may be missing, and an affected row's
  `historyFrom` says where its own history begins; `history.removedIssues`
  counts issues `closed-issues` removed.
- **Linked work** searches the repositories the tracker covers (the owner's,
  those subscribed to it, and those its timelines touch) and returns only
  what the viewer can read: unreadable repositories' items are omitted
  without a count. Steps are found by issue key (index
  `step_contexts_issue`), release-note entries by tracker and key
  (`release_note_entries_issue`); runs, deployments and packages by the
  commits found. Each list holds at most 50 items (`truncated`).
- **Mentions** (CORE-22, `mentions` in the response) are commits whose
  message names the issue's key, kept apart from that evidence: the issue
  page and the inspector label them "Mentioned in". After each push the push
  log's commit read (`worker/ref-log/record.ts`) feeds `worker/mentions`,
  which resolves each key (`issueKeys()`) to a Timelines tracker issue: first
  trackers whose workspaces subscribe to the repository, then the owner's,
  then (for a person's repository) their organizations'. Within a tier the
  owner's tracker breaks a tie; otherwise the key is recorded `ambiguous` and
  links nothing, and keys no tracker knows aren't recorded. Rows
  (`commit_issue_mentions`) are one per repository, commit and key, keep
  their first ref and time, and are listed by issue id in any repository the
  viewer can read, with their own CI runs and packages; each SHA opens the
  commit panel (`/<owner>/<repo>?commit=<sha>`). History pushed before the
  index is read by the hourly cron: 20 repositories a run, the latest 200
  first-parent commits of each default branch, once per repository
  (`commit_mention_backfills`). Release notes resolve keys no subscribed
  workspace covers through the same tiers (`repoIssues()`).

**The view** (`/tracker/:owner?view=chronicle`, CORE-251; `src/routes/tracker/Chronicle*.tsx`,
pure model in `chronicleModel.ts`): presets, zoom, group by and layout over the
query bar; a brushable density overview; a canvas ruler and lanes (status,
work spans, markers) with the playhead and a selectable range; the range
summary or, for a selected issue or span, the inspector with linked work. The
address holds `from`, `to`, `at` (the playhead), `rs`/`re` (a selected range),
`span`, `group=team` and `layout=list`. It reads pages of `/chronicle` for a
range half a window wider on each side, at most 10 pages, and never the
change feed. The layout toggle is **Chart / List**: Chart names the visual
time-axis layout without conflicting with the separate Timelines feature.
Phones get the List layout, the accessible equivalent of the canvas.
Design: root `DESIGN.md`, "History (time axis)".
The List scrubber preserves newer keyboard positions when an earlier address
write finishes. Each committed gesture carries an instance/revision receipt in
router history state: only the latest receipt can acknowledge its matching
position, even when a gesture returns to the same address. Snapshot refreshes
alone do not reset the scrubber. Acknowledgement runs before paint; external
navigation and Back/Forward restore the position from that history entry.

**Development history:** `POST /api/dev/chronicle {account, team, issues?, days?, seed?, link?}`
(agent secret) makes `issues` issues of a new team worked by the account's
people and a "builder" agent over `days`, through real tracker mutations
under a controlled clock (`worker/tracker/chronicle-fixture.ts`). With
`link: {repo: "owner/name", commit}` the showcase issue (its first) gets a
step context at that commit and a release-note entry naming it, as the
generator would store them, so its linked work reaches a real commit and its
CI runs. E2E `browser-chronicle-scrub-range-span-and-links`
(`tools/agent/chronicle-e2e.ts`) checks the page against the API's own answer.

### Timelines

A timeline is an account-wide line of work. Each `(timeline, canonical repository)`
owns one Artifacts work repository, shared by its agents, with an opaque
`work_<id>` source and physical `refs/heads/work` (`bookmark: "work"`).
`timeline/<slug>` remains a logical overlay/environment label, not its Git ref.
Records and events live in the account Tracker Durable Object beside the issues
and leases that landing and abandoning change. Every change is also
logged in the tracker's event log, which the snapshot and change feed include
only with `timelines=1`, because older gm binaries fail on entity types they
don't know (gm now skips them). gm asks for timelines and keeps them in its
replica; `gm tracker status` lists them offline. `shared/timelines.ts` defines the
wire types.

| Route                                                   | Contract                                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/tracker/:owner/timelines?status=&stalled=`    | Every timeline, newest first; `stalled=true`: open, no push for the idle period, not experimental                              |
| `POST /api/tracker/:owner/timelines`                    | `{slug, name?, policy?, experimental?, parent?, repos?}`: reserve and initialize pinned owned sources, then publish the record |
| `GET /api/tracker/:owner/timelines/:slug?after=&limit=` | The timeline and its events, oldest first; page on with `next`                                                                 |
| `PATCH /api/tracker/:owner/timelines/:slug`             | `{name?, experimental?, expectedVersion?}`                                                                                     |
| `POST /api/tracker/:owner/timelines/:slug/abandon`      | End the timeline and archive owned sources read-only; preserve completed integration receipts                                  |
| `GET /api/tracker/:owner/timeline-graph`                | Every timeline, the newest 5,000 events across them, names and workspaces: the graph's data                                    |
| `POST /api/tracker/:owner/timelines/:slug/land`         | Queue the head checkpoint to land (`LandResult`), or 409 with why not                                                          |
| `GET /api/tracker/:owner/timelines/:slug/landing`       | `{landing}`: its newest landing, or null                                                                                       |

- **Forking** needs tracker membership and canonical-repository write access;
  repositories must belong to that account (at most 20 per timeline). The
  parent source, commit and tree are pinned before allocation: the parent's
  owned work head, otherwise canonical main, or the requested `{repo, commit}`.
  The Tracker reserves a provider name and durable allocation intent before
  native fork; retries recover that reservation, never silently fork a newer
  tip. Readiness requires the exact pinned commit/tree, a verified CAS of
  `refs/heads/work`, and revocation of initial provider credentials.
- **Source routing** preserves canonical authorization and deletion tombstones.
  Git uses `/<owner>/<repo>@<slug>.git`; object/history APIs use
  `?source=work_<id>` (`canonical` is qualified by repository). The slug routes
  to a durable owned-source identity even after Tracker detail expires. Canonical
  `timeline/*` pushes are refused with the actual timeline URL; the old
  `/sources/<id>.git` transport does not remain as an alias. No provider URL
  or token is exposed to clients. Missing/migrating source metadata fails closed,
  never falls back to a canonical `timeline/<slug>` branch. Full acknowledged
  progress and pre-rewrite predecessors are rooted, not just checkpoints;
  durable mutation intents fence pushes against admitted landings and keep
  ambiguous provider outcomes fenced until reconciliation.
  A complete negotiated Git `report-status`/`report-status-v2`, consistent with
  the observed work ref, settles a normal push. A current request can also prove
  rejection when failure precedes any provider forwarding (including token
  acquisition and predecessor retention). After forwarding starts, HTTP failures,
  incomplete or contradictory reports, and mismatched refs remain ambiguous even
  when the old tip is still visible.
  CI retains the immutable `sourceId` and exact commit, with `timelineSlug`
  identifying its public Git address. Local and Sandbox runners validate the
  trusted origin, canonical repository, slug and source-ID pin before checkout.
- **Interrupted push recovery** (CORE-321) is explicit: inspect with
  `gm timeline pushes [OPERATION]`, then use `gm timeline recover-push OPERATION`.
  Both support `--timeline SLUG --repo OWNER/NAME` without changing local bindings.
  The API list returns `{sourceId, operations}`; exact inspection returns the
  retained operation's ID, state, original commands/attribution and, when present,
  its recovery intent/outcome. Reads require repository access and tracker membership;
  recovery also requires write access and a write-scoped credential. Jobs, wrong-source
  requests and canonical targets cannot recover. Expired/ended sources are not reactivated.
  A successful recovery returns
  `{sourceId, operationId, state: "accepted" | "rejected", head, recoveryId,
fenceCommit, syncRequired}`. `head` is the proven outcome head, not a promise
  that later work cannot advance it. Unproven states return non-2xx (normally
  `409 source_busy`); retry the same operation rather than creating another one.
  Observing the requested new head proves acceptance. Observing only the old
  head never proves rejection: recovery first persists one unique same-tree
  commit (parented by that old head) and its actor/accountable attribution, then
  uploads only that commit and CASes the work ref from old to marker. Concurrent
  attempts use that same persisted intent. If the original wins the race, its
  new head proves acceptance; if the marker wins, the old-to-new original CAS
  is fenced and the operation is rejected. Unexpected heads fail closed.
  Marker history is retained with source progress; canonical refs are untouched.
  A service-created marker counts as acknowledged same-source ancestry only
  when retained provenance and the terminal rejection projection match its
  exact operation, source, commit and proven head (CORE-323). This permits a
  normal merge of the recovery fence before checkpointing. An intent alone
  grants nothing; foreign-source dependency and approval checks are unchanged.
  Neither recovery nor later source writes may restore a persisted recovery
  base OID on that source: doing so could revive a delayed CAS (the ABA problem).
  This exact-OID restriction does not otherwise prohibit normal work rewrites.
  Terminal outcomes are immutable; replay repairs a failed projection without
  another provider write, including deletion's reconciler after a repository
  tombstone hides the public endpoint. Unresolved recovery intents still block
  deletion. The timeline remains mutation-fenced until proof,
  progress retention and projection complete. Original operation commands and
  attribution are retained alongside the recovery's prior state and audit.
  Recovery persists an exact-head CI delivery obligation with stable push and
  step run IDs before observing refs or starting runs.
  Existing matching CI runs are adopted, including their completed outcomes;
  recovery is not an implicit rerun of failed or successful gates. A failed admission or
  Workflow startup returns an error; retrying the same operation resumes those
  IDs across restarts, independently of `ci_refs`. Completed runs and explicit
  no-pipeline/disabled-step outcomes are acknowledged durably and never recreated
  by historical replay. Recovery runs do not wait out quiet/coalescing periods
  or cover newer source work. Ref-log and Knowledge observations use current
  provider refs, not the obligation's historical head.
  Replaying an old terminal operation after later work preserves its historical
  response without rewinding the live source head or observing stale refs.
  When `syncRequired` is true, run normal `gm sync` before retrying publication,
  preserving the marker in the synchronized history or making a new commit.
  Recovery never edits the local checkout and never force-pushes.
- **The graph** (`/tracker/:owner/timelines`, linked from Issues and Release
  notes; CORE-81) draws main down the middle and a lane per timeline, newest
  first: forks, merges between timelines, landings on main, abandoned lanes
  ending with a mark and experimental lanes dashed. It centres on `?tl=<slug>`
  (the selection, its parents and what depends on it) or, with main selected,
  the ten most recently active timelines; landed timelines fold into one node
  on main, and the rest are listed by status, workspace, agent or person. The
  layout is in `src/routes/tracker/timelineGraph.ts`.
  Main and timeline summary rows are full-width native selection links with
  aligned labels, visible Select/Selected cues and keyboard focus (CORE-229).
  Their 48px rows share the drawing's geometry for touch targets. Event links,
  commit navigation and Show lane/Fold remain independent controls; selection
  keeps other URL parameters and browser Back/Forward restores the scope.
- **Experimental** (CORE-86) marks a timeline that isn't expected to land. It
  restricts nothing: any writer sets or clears it (the graph's inspector,
  `PATCH`, `gm timeline flag <slug> --experimental|--no-experimental`), its
  work merges like any other's, and it can still land. Views of stalled or
  idle work leave flagged timelines out, since stalling is expected of them
  (`isStalled` in `shared/timelines.ts`: active or idle, no push for the
  account's idle period, 7 days by default): the graph's Stalled filter, its
  status groups (quiet experiments are grouped apart), `?stalled=true` and
  `gm timeline list --stalled`.
- **Merges and progress** retain the work source's full Git history and
  source-qualified ref-update/membership evidence. Push events record agents
  and timeline dependencies; a logical timeline label alone is not source identity.
  Ordinary local branch merges are allowed, including a merge first published
  in one push. An immutable repository-qualified revision-origin ledger records
  first source attribution; accepted pushes or completed allocation prove local
  membership. Later child copies and source expiry cannot change attribution.
  Known foreign work still needs exact reviewed integration. This is
  service-recorded provenance, not proof of where otherwise unknown external
  Git objects were authored.
  Exact canonical ancestry is separate from source attribution (CORE-335).
  Checkpoint measurement and landing read the current canonical closure: exact
  members create no inferred foreign dependency and are covered during native
  merge validation, regardless of which source first observed them. Equal trees
  are not ancestry proof. Declared dependencies and foreign logical bases still
  require their completed exact integration receipts on current canonical history.
  Previously recorded dependencies are not silently removed: renew the checkpoint
  after correcting inference, and renew approval where the timeline requires it.
  Checkpoint measurement and each landing progress invocation reuse successful
  immutable commit metadata by physical repository and OID. Overlapping base,
  dependency and merge-parent closures still traverse every ancestor, but do
  not repeatedly fetch already-read metadata. The landing receipt reuses the
  same source metadata; canonical ancestry reads are also shared within that
  invocation. No cache crosses requests, caches absence or provider errors, or
  substitutes for fresh source state, origin, acknowledgement and receipt checks.
  Missing ancestry blocks proof; provider errors remain errors rather than
  evidence of absence. Repository capabilities retain their existing `using`
  ownership. `worker/timelines/landing.test.ts` covers 448 revisions with 58
  overlapping merges, exact receipt membership, old foreign/unacknowledged
  branches and unavailable ancestry.
- **Abandoning** is for the accountable person or the agent that started the
  timeline. It ends writes and archives work sources rather than deleting their
  history. Settled partial landings retain successful receipts; abandoning never
  rewinds a canonical repository already advanced.
- **Landing** (`worker/timelines/landing.ts`) is compact, not a WIP merge into
  canonical. `auto` admission requires a green current checkpoint; `approval`
  requires a person's approval of that exact head. New work supersedes approval,
  and admitted landing fences source writes. Manual `gm timeline land`, the
  inspector and `POST …/land` use the same checks.
  1. Pin **B** (explicit logical-base tree), **O** (current canonical main tree)
     and **T** (approved work tree). Trusted materialization applies B→T onto O,
     preserving independent canonical edits and reporting ordinary conflicts.
     It creates one commit whose sole parent is pinned main, or a no-op receipt
     if the resulting tree is unchanged. No WIP commit objects or refs are
     uploaded to canonical, including staging.
  2. Run repository landing gates on the exact compact candidate. CI reports
     `trigger == "landing"` and `branch == "gitmatrix/landing/<slug>"`, not
     main; its job credential is restricted to the admitted repository/source
     and landing ref. No ci.yml or matching job means nothing gates that repo.
  3. Prepare and gate **every repository before the first main CAS**. Advance
     mains individually from their pinned heads; a moving main requires
     re-preparation and re-gating (at most five attempts). There is no distributed
     transaction: after any successful advance, remaining failures are
     `partly_landed`. Durable CAS intents and integration receipts reconcile
     uncertain results, and retry never replays a successful repository.
     Same-checkpoint recovery retains tested sibling candidates and gate identities;
     only an unadvanced main that actually moved requires new preparation.
     Transport failures during dependency revalidation defer progress without
     invalidating this prepared state; confirmed missing or invalid dependency
     evidence still stops landing as `blocked_dependency`.
  4. When every repository has its receipt, fold the tracker view into main,
     mark the timeline landed, complete its issues and release retained leases.
     Archive work sources read-only; canonical push effects drive main CI,
     mirrors, knowledge and release notes. No-op receipts still preserve lineage.

  Conflicts or failed gates stop landing. Explicitly sync/rebase the work, push
  and renew checkpoint/approval when it changes; a stopped landing is retried by
  hand, not by a green checkpoint alone. Cancellation cannot roll back successful
  CAS receipts or discard an unresolved provider outcome. Landing reservations
  honor cancellation before a provider operation starts. Once CAS has begun, an
  uncertain result stays fenced until its exact outcome is reconciled; a concurrent
  main advance cannot manufacture a successful receipt.

  For canonical-rooted work with no dependencies, a native merge alone does not
  renew **B**. After merging current main, resolving conflicts and pushing, use
  `gm timeline checkpoint --sync-main -m '…'` (`syncMain: true` on the checkpoint
  POST). Every repository must contain the exact current main commit in its
  published work history, and its allocation-time canonical base must remain
  in main's ancestry. Otherwise renewal is blocked; equal trees are not proof.
  The new immutable checkpoint pins that canonical commit and tree as B.
  Changing B requires a fresh checkpoint and approval even at the same work OID.
  Allocation metadata, old checkpoints and integration receipts are unchanged.
  Request the flag on each checkpoint that should use synchronized main;
  omitted/false keeps ordinary measurement, without inheriting the renewed B.
  Foreign/nested bases and dependencies keep their existing admission flow and
  cannot use this option.

  **Nested eligibility** uses exact ancestry, not matching change IDs. A child
  forked at parent P0 waits for a completed parent integration covering P0
  (including exact membership in a later approved P1). Its initial B remains
  P0's tree, not compact canonical C or P1. Later foreign merges require one
  unique maximal integrated baseline covering the dependency closure; otherwise
  `blocked_dependency` asks for reviewed sync/rebase. Main movement cannot pick
  a new base automatically or replay reverted foreign content.

  **Provenance** links canonical receipts to the approved source snapshot,
  logical base, dependencies and exact progress members. Steps, `why`, release
  notes and issue attribution follow this mapping instead of expecting a
  landing merge's second parent. Context identity remains canonical repository,
  change ID and commit OID, with existing author/redaction rules.

**Finite legacy cutover.** `gm timeline migrate <slug>` (or
`POST …/timelines/:slug/migrate`) freezes legacy admission, forks active and
experimental work at pinned snapshots, and switches only when all owned sources
are ready. Then `gm timeline use <slug>`, checkpoint and renew approval.
Completed/abandoned records receive `canonical-historical` provenance; old
canonical history is never rewritten and tombstones are never resurrected.
In-flight legacy landings must settle first. Inspect `gm timeline show <slug>`;
resolve a stopped unadvanced landing with
`gm timeline migrate <slug> --resolve cancel-unadvanced --expected-version <version> --note "<reason>"`.
For a stopped partial landing use `--resolve accept-partial-and-abandon` with the
same required version/note: successful receipts stay, the whole timeline is
abandoned, and a subsequent plain `migrate` records historical provenance.
This is a finite conversion, not two permanent active write modes.

**Views.** Issues have a view per timeline, projected from the one event log
(`worker/tracker/views.ts`). A mutation request with `timeline: <slug>` is
made in that timeline: its events carry `timelineId` and `view` (the entity
as the timeline saw it, before and after), and issues it creates record
`timelineId`. Main's view is the store's tables, as before: an event's
`before`/`entity` stay main's, so in a timeline main's copy changes only
shared fields (version, claim, assignee, waiting), and something only a
timeline has is absent (`entity: null`). A timeline's view
(`GET …/snapshot?timeline=<slug>`, `?tl=<slug>` in the web app, `--timeline`
or `GM_TIMELINE` in gm) is main's with the scoped fields (title, description,
acceptance, type, status, close reason, priority, parent, workspaces, tags)
and the links and comments of the timeline, its ancestors and the timelines
merged into them replayed on top in event order. `issue.next` in a timeline
picks from its view. Landing folds a timeline into main's tables as
`timeline.land` events (`TrackerStore.landTimeline`, for CORE-77 to call when it
marks the timeline landed); views then leave landed timelines out. Ended
timelines take no changes.

**Done in a timeline** (CORE-74). An issue whose status becomes `done` in a
timeline's view is done there, and in the views that include that timeline
(its descendants, and timelines it merges into). Elsewhere, main included, its
status is `done_in_timeline` with `doneIn: {id, slug}` (a shared field, like the
lease): it keeps blocking, isn't ready, and stays in `is:open`. The status is
locked wherever it shows: updates that change it, claims, completion and
release fail with `done_in_timeline` ("… is done in timeline `<slug>`; it lands
with the timeline, or reopen it there with --timeline `<slug>`"), while other
fields stay editable. Only the tracker moves it: a reopen inside the timeline,
a merge between timelines (`doneIn` moves to the timeline merged into, as
`timeline.merge` events), landing (done), and abandoning (`todo` again, leases
released, a note linking the abandoned timeline on each, unless a live
timeline that merged into it still has the work done). The web marks it with
its own icon (a branch ending in a done check, in landing green), disables the
status picker with a link to the issue in the timeline (`?tl=<slug>`), and
lists a timeline's issues in the graph's inspector (`issues` in
`GET …/timelines/:slug` and the graph's data); `gm issue show` and
`gm timeline show` say the same, and gm refuses the same changes before
queueing them. Older gm binaries treat the status as data: not ready, still
blocking.

**Retained leases** (CORE-75). Leases stay unique per issue across every
timeline (`claim` is a shared field). Finishing an issue inside a timeline
(`issue.complete`, or an `issue.update` to `done` under the holder's own
lease) doesn't end its lease: the claim keeps its holder and token and gains
`retainedIn: {id, slug}`, the "retained" state of Unity's Smart Locks. A
retained lease counts as active whatever its `expiresAt`, so it needs no
renewal and nobody else can claim the issue in any view while the timeline is
live. Renewing it (accepted, harmless) and handing it off keep it retained and
leave the locked status as it is; releasing or completing it again fails with
`lease_retained`. It ends with the work: landing releases it as done
(`landTimeline` clears the claim and deletes the token), abandoning releases
it back to ready (unless a live timeline that merged the work keeps it), a
merge between timelines moves `retainedIn` with `doneIn`, and a reopen inside
the timeline (by anyone with write access, no token needed) ends it, leaving
the issue open to claim. The web shows a retained issue as done in its
timeline rather than claimed; older gm binaries see an expired claim on a
`done_in_timeline` issue, which still isn't ready.

**Ended timelines stay readable.** A landed or abandoned timeline's view
(`?tl=<slug>`, `--timeline <slug>`) still loads, read-only, with a banner that
says how it ended; changes made in it fail with `timeline_ended`. Its own
issues are left alone when it is abandoned, and its issue list keeps the
status each had in it, even after main's copies went back to do.

**The app-wide scope** (CORE-82, `src/lib/timelineScope.ts`). `?tl=<slug>`
scopes every page to main plus that timeline; no `tl` is main, and `tl=main`
names main explicitly, which is how a link leaves a timeline. The switcher in
the rail lists the account's timelines (the page's account, else the default
tracker's) and a banner above every page names the selected one and says what
the scope means there; from 640px it stays in view (`--scope-banner` offsets
page-level sticky elements and the tracker's height), and on phones the rail's
switcher carries a dot. Links carry the scope (`router.createHref` adds the
current `tl` to every href that names none), and so does every navigation, form
and redirect (a root middleware); going back, forward or reloading keeps what
the URL says. What each surface does with it:

- **Tracker**: the timeline's view (above); the timeline graph centres on it.
- **Code browser**: code, history, diffs, semantic changes and permalinks carry
  the owned `source` and physical work ref. Navigation preserves that source;
  explicit main selection returns to canonical. Missing sources show an error,
  not main's content under a timeline label.
- **CI**: lists and runs use the source as well as ref; identical ref names or
  commit IDs in different sources do not select canonical runs.
- **Packages**: the console's default query adds `branch:timeline/<slug>`.
- **Knowledge**: the timeline's overlay and its wiki pages; the tab's old
  `?timeline=` is rewritten to `?tl=`.
- **Wiki**: the timeline's own version of a page where it wrote one (`&set=`
  picks a checkpoint's), noted as such, with a link to main's.
- **Release notes** cover canonical landed work. The shared timeline picker is
  also available inline on repository and tracker release views (CORE-283).
  A selected timeline filters to what it landed; main shows all canonical notes.

A landed or abandoned timeline stays selectable: the shell banner says how it
ended and that its work view is read-only. Release notes instead describe the
landed-note filter, which remains readable after work-source retention expires.

The switcher's **Timeline graph** link sits beside its title, above the changing
list and loading/error messages, so resolving the list does not move a footer
link during a click. It remains a native link and follows the page's account,
including an explicitly selected account in Settings.

## Release notes

Release notes are code-update history, not deployment records. The default view
groups the default branch's first-parent commits into **daily UTC digests**, using
Git committer timestamps. Neither authored dates nor tracker completion dates
decide which day a change belongs to. Tags remain optional named checkpoints;
successful CI alone is not treated as proof of deployment.

`GET /api/repos/:owner/:name/release-notes/range` still provides explicit Git
ranges and the tracker issues their commits mention (`shared/release-notes.ts`).
Without parameters it walks the default branch back to the nearest tagged commit;
`?to=<tag>` includes that tag's own commit, and `?from=<ref>` sets the base explicitly.
Ranges follow first-parent history and stop at 1,000 commits with `truncated: true`.

Issue keys (`TEAM-N`, e.g. `(CORE-13)` or `CORE-15:`) are parsed from commit
messages and resolved only through trackers that subscribe a workspace to the
repository and that the caller can read. Anonymous callers, non-members and
unsubscribed trackers get the commits without issues. Key-shaped words such as
`UTF-8` match no team and drop out. Each issue carries its team, completion time
(when it last became done) and evidence. The tracker also answers which issues
were completed in a time window, for team and organization views.

**Generated entries** (`worker/release-notes/generate.ts`) belong to a daily digest
(`@day:YYYY-MM-DD`) or a named tag snapshot. Colons cannot occur in Git tag names,
so the identifiers cannot collide. Daily digests cover the newest 1,000
default-branch first-parent commits, including tagged commits; empty days are not
stored. Commit dates need not follow ancestry order, so a day is a set of commits,
not a contiguous Git range. Digests outside the bounded walk drop out; truncation
is reported. Named snapshots retain the normal ten-tag regeneration window, and
previously generated older tags remain readable while those tags still exist.

An entry groups an issue's cited commits within that day or tag, or describes a
commit citing no resolved issue. The `fast` model writes its category (feature,
fix, improvement or internal), title and summary from the issue, evidence, commits
and semantic code changes; the `reason` model writes an introduction from the
non-internal entries. Prompts describe code changes without claiming deployment.
Entries retain their sources, model and inputs hash. Identical inputs reuse
existing output across days and tags; new or changed groups require generation.
Stale-entry cleanup compares persisted subjects with all current drafts, including
unfinished ones, then deletes stale IDs in batches of at most 90. Large daily
digests stay within D1's 100-parameter limit without losing pending entries.
Both summary and entry APIs expose `lastCommitAt`, the latest Git committer
timestamp in that group. Summary `kind` and entry `releaseKind` distinguish
`daily` from `tag`; tracker completion remains source evidence only.

Work runs on the `gitmatrix-jobs` queue: pushes, tracker changes to cited issues
and subscription changes mark the repository dirty and enqueue it after 20
seconds; a D1 lease allows one run per repository, and runs are capped at 40
model calls, continuing in a follow-up run. Server-side resolution uses the
repository owner's tracker plus subscriptions mirrored into
`tracker_repo_subscriptions` as they change. An introduction lists the trackers
whose issues shaped it, so readers without access to them can be shown entries
without it. Without AI bindings (automatic non-AI test environments) nothing is
scheduled.

**Stored-data upgrade** (migration 0020): repository and per-release format
versions keep legacy materialization hidden until it has been regenerated.
Reading a repository's index/detail or a related, accessible tracker feed
coalesces a lazy rebuild, including repositories with no new push after upgrade.
Previously stored older tags upgrade in batches of at most ten tag groups per
pass, within the same model-call budget; untouched historical tags are not
backfilled. Continuations finish the upgrade before publishing the new format.
Afterward, ordinary incremental updates preserve readable current-format
history while generation continues. Failed generation remains visible as a
failure and uses the existing queue retry path.

**Reading** (`worker/release-notes/read.ts`): the repository's **Releases** tab
separates daily updates from tags and defaults to the newest day with visible
entries (or the newest day if none has entries; tags are the fallback when no days
exist). It shows the selected group's introduction and entries as New, Fixed,
Improved and collapsed Internal, linking to issues and commits with model
provenance. Daily groups explicitly identify UTC commit dates, not Git ranges.
The page refreshes while generating. `gm release list` and `gm release notes`
are the CLI equivalents; `gm release notes day:2026-10-02` selects a UTC day.
Entries about issues from trackers the viewer can't read are omitted, and an introduction is
shown only to viewers who can read every tracker that shaped it.

The responsive reading layout (CORE-273) centers a bounded 84rem composition
inside the unchanged repository header and tabs. Desktop navigation and the
About rail frame a capped reading column; phones use a native release selector
with daily/tag groups instead of a long navigation list. Long identifiers wrap,
and selecting a release preserves the timeline filter and browser history.

Both release views expose the same searchable timeline picker as the tracker.
Its selection lives in `?tl=<slug>` and survives links, query submissions,
Back/Forward and reload; selecting main explicitly clears the timeline scope.
Repository layouts and note requests stay canonical even when a stale URL names
an expired work source. A scoped index counts only matching entries the viewer
may read and omits empty releases. An explicitly selected day/tag can still show
an empty result with the picker available. Scoped views omit the whole-release
introduction and its model attribution, since that prose may describe other work.

The index, detail and tracker feed APIs accept an independent `timeline=<slug>`
constraint. Empty or `main` means all canonical notes; an unknown or nonmatching
slug returns no matching entries, never an unfiltered fallback. In a tracker
feed this constraint intersects with every `q` filter, including positive or
negated `timeline:` terms, before result limits and facet counts. It does not
generate notes for unlanded work or grant additional access.

**Highlights** are separate, person-specific summaries of an organization's
authorized daily entries from today and the previous seven UTC days:
`GET /api/tracker/:owner/release-notes/highlights`. The response is
private/no-store and requires a person sign-in. There are no repository or site
levels: those endpoints answer 404 and stale queued jobs for them are skipped.
Exact daily-note backlinks are server-generated, never model-generated.
Detailed notes are not modified. The signed-in `/highlights` page is an
app-owned, reserved route, not an account slug: it redirects to the person's
default organization's highlights, as the rail does when no organization is open.
A repository's release page links to its organization's highlights.

Opening the page creates the viewer projection. The existing hourly cron checks
at most 25 due projections; the account's cadence defaults to 24 hours and can be
set to 1–168 hours (the organization's setting).
New entries alone wait for that cadence. Every read and model invocation checks
authorization and the summarized entries' digests; changed, deleted, or revoked
sources suppress old prose immediately. The window only chooses sources for a new
summary: entries ageing out of it never blank an existing summary or reset its due
time, and wait for the next scheduled refresh, which regenerates from the current window. A bounded source manifest tracks source
repositories/accounts for deletion cleanup. D1 leases coalesce concurrent requests;
failed attempts persist an error and wait for the next cadence, without a tight
paid retry loop. The release-notes feature switch and missing AI bindings prevent
new highlights calls. Calls meter as their own feature, `release_highlights`
(AI Gateway label `release-highlights`, following the release-notes body-logging
setting), billed to the organization and attributed to the reader who asked,
with the configured task model and stored model/time provenance.
Persisted highlights are included in release-notes storage usage, charged to
`owner_account_id`: the organization. A different viewer does not take on the
organization's storage charge.

The `release-highlights` real-provider stage proves the seven-day window with a
recent and a stale copy of the fixture's daily note, and that a non-member is
refused without prose. Its three-call ceiling covers the first summary, a
scheduled refresh and repair after cited-source removal, all billed to the
organization. It checks the retired repository and site endpoints, configurable
cadence, unchanged detailed notes, exact backlinks, generated desktop/mobile
surfaces, the `/highlights` and rail navigation to the default organization, and
the repository page's link.

**Custom release notes** (CORE-151) are written on demand, in the words a person
asks for (a customer announcement, a changelog, an email), from release notes
the viewer may already read. Nothing is stored.

| Route                                                | Body                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `POST /api/repos/:owner/:name/release-notes/compose` | `{ prompt, release?, timeline? }`: one release (the newest daily update when omitted) |
| `POST /api/tracker/:owner/release-notes/compose`     | `{ prompt, q?, timeline? }`: the feed `q` selects, as the page shows it               |

Both answer `{ markdown, model, entries, truncated }` with
`cache-control: private, no-store`. They need a signed-in person or an agent
acting for one (401 otherwise); the prompt is 1 to 2,000 characters and `q` at
most 500 (400); an unknown release is 404. Only members of the billed account
may write: the repository route answers 403 ("Only members of <account> can
write custom release notes.") to anyone else who can read the repository (a
private one still 404s), and site admins count as members; the organization
route keeps the feed's membership check (403). Each person writes at most 50 a
day per account (`ai_usage` calls plus failed attempts for the feature, UTC
day): the 51st is 429. Entries come from the same readers as the read APIs, so
tracker-private entries a viewer cannot read are absent. Paid work needs
`env.AI` (503) and the billed account's AI release notes switched on (409, "AI
release-note writing is off for <account>"); the billed account is the
repository's owner or the organization. With no entries the answer is 422 and
no model is called. A model that fails or rate-limits is a 502 ("The model
didn't answer. Try again in a minute."), never retried. Entries are serialized
compactly (at most 200 and 60,000 characters; one entry larger than that has its
summary cut to fit; `truncated` says anything was left out) and sent apart from
the request, which sets audience, tone and format; the shared writing rules
(`worker/release-notes/writing.ts`) keep the output client-ready, forbid
inventing facts or availability dates, and allow no images and links only when
asked.

One request is one model call on the account's Task model (rate-limit retries
off), at most 2,000 output tokens. It meters as `release_notes_compose` for the person (and the
agent) who asked (AI Gateway label `release-notes-compose`, following the
release-notes body-logging setting). The assistant's built-in `release-notes-writer`
skill teaches the same rules and how to fetch the notes, so the sidebar can do it too.

On both release-notes pages, for members of the account, **Write custom release
notes** (`ReleaseNotesComposer.tsx`) opens, collapsed by default, a request box with
starting prompts and a line naming what it writes from (the selected release, or
the current filter). The result renders as plain Markdown (no images, no autolinked issue keys or
commit refs) and exports as: **Copy**
(Markdown, plus `text/html` where the browser allows), **Download Markdown**,
**Print / Save as PDF** (the print dialog on a clean, notes-only page) and
**Download Word**, a real `.docx` built in the browser by `docx`, imported only
on click (`lib/releaseExport.ts`). The `release-notes` real-provider stage makes
one compose call and checks its content, its single metered call and its
`release-notes-compose` Gateway log.

| Route                                                       | Contract                                   |
| ----------------------------------------------------------- | ------------------------------------------ |
| `GET /api/repos/:owner/:name/release-notes`                 | `ReleaseNotesIndex`: status and releases   |
| `GET /api/repos/:owner/:name/release-notes/release?name=`   | `ReleaseNotesRelease`: intro and entries   |
| `GET /api/repos/:owner/:name/release-notes/range?to=&from=` | `ReleaseRangeResponse`: commits and issues |
| `GET /api/tracker/:owner/release-notes?q=`                  | `ReleaseFeed`: a tracker account's entries |

**Team and organization views** (`worker/release-notes/feed.ts`): a tracker
account's **Release notes** page (`/tracker/:owner/releases`, a place in the
navigation rail; `/release-notes` opens your default tracker's) defaults to daily changes in its repositories and changes citing
its teams' issues, ordered by `lastCommitAt` and grouped into UTC weeks. Tagged
releases do not duplicate entries in the default feed. An explicit `kind:tag` or
positive `release:` filter selects tagged releases (the "Tagged releases" chip) when requested; `kind:daily`
selects daily history. An issue may have distinct updates on several days.
A team's notes use `team:KEY`. Other filters are `repo:` (name or owner/name),
`ws:`, `type:` (feature, fix, improvement, internal), `tag:` (issue tags;
`label:` is the old spelling),
`release:` (a literal tag or `day:YYYY-MM-DD`), `timeline:` (what landed with
`timeline/<slug>`), `since:`/`until:` (a date or `30d`,
`2w`, `12h`), search words, and `-` to exclude; unknown tokens are reported back.
Facets count the matching entries. It requires membership in the tracker
account, and also applies repository visibility and per-entry tracker access.
`gm release feed [QUERY] [--team KEY] [--owner OWNER]` is the CLI equivalent.

The tracker feed uses a centered 72rem composition with bounded note text.
From 1024px, facets occupy a separate right-hand rail; below that, the same
controls sit in a keyboard-accessible **Narrow it down** disclosure before the
feed. Search stays visible, and empty results use the same reading column.

The issue tracker's header exposes **Release notes** as a full-size, bordered
button with the same scroll icon as the navigation rail and a 44px minimum touch
target. It carries the current single-team scope, including a saved default team;
explicit URL filters take precedence. It drops
issue-only filters so completed work is included. With no single team selected,
the shortcut opens all account notes. The navigation rail always opens the
account-wide feed.

Real-provider coverage in `vp run agent test-ai` checks daily generation without
tags, a second commit on a different UTC committer date despite unchanged
authorship, retained earlier-day provenance, a named tag containing both changes,
and daily/tag tracker feeds without duplicate default entries. The timeline-pages
stage additionally checks filtered repository counts/detail and tracker feeds
against real compact-landing notes, conflicting query constraints, main reset,
and retained filtering after work-source expiry and note regeneration. These are
gate requirements, not claims of an observed run; inspect retained outcomes.
This is separate from the non-AI readiness gate.

For the generator's local regressions, run
`vp test worker/release-notes/generate.test.ts` from `apps/website`, followed by
`vp check`. The suite covers large daily-group convergence, retention when the
model budget is exhausted, and stale-subject pruning within D1 binding limits.

## Automatic AI settings

`/settings/ai?owner=<account>` controls automatic work across repositories owned
by that personal or organization account. Open **Settings → AI settings** in the
shared section navigation. Account members can read; only the human account owner,
organization owners, and site admins can save. Agent credentials cannot change spending policy.
Agent chat and interactive search, including query embeddings and reranking, are
unchanged.

Four independent preferences default to enabled:

- **Knowledge:** new main builds, timeline overlays, embeddings and indexing.
  Disabling it also blocks new Wiki and Atlas AI work, without erasing their
  individual preferences.
- **Wiki:** repository wiki and timeline checkpoint page generation.
- **Atlas descriptions:** paid capability descriptions, not deterministic Atlas
  projection or browsing.
- **Release notes:** automatic generation, including read-triggered repair.

The curated catalog is `shared/ai.ts`. Prices below are published USD per million
input/output tokens, not a total bill estimate:

| Role                     | Option ID            | Provider model                  | Released   | Input / output |
| ------------------------ | -------------------- | ------------------------------- | ---------- | -------------- |
| Classification (default) | `clef`               | `@cf/cloudflare/clef`           | 2026-10-01 | $0.24 / $0     |
| Classification           | `clef-flash`         | `@cf/cloudflare/clef-flash`     | 2026-10-01 | $0.038 / $0    |
| Classification           | `clef-omni`          | `@cf/cloudflare/clef-omni`      | 2026-10-09 | $0.15 / $0     |
| Fast / Task (default)    | `glm-5.3-flash`      | `@cf/zai-org/glm-5.3-flash`     | 2026-08-26 | $0.15 / $0.50  |
| Fast / Task              | `gemma-4-26b-a4b-it` | `@cf/google/gemma-4-26b-a4b-it` | 2026-04-04 | $0.10 / $0.30  |

Classification handles structured decisions; Fast handles file analysis and
release entries; Task handles synthesis, wiki prose, Atlas descriptions and
release introductions. Embedding models and dimensions remain fixed.

Clef remains the default. [Clef Flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/)
and [Clef Omni](https://developers.cloudflare.com/workers-ai/models/clef-omni/)
are classification-only alternatives; their published prices were checked on
2026-10-11. The request's model selector follows the selected provider model.

`GET/PATCH /api/accounts/:slug/settings/ai` returns features, selected option IDs,
the catalog, save provenance and `canManage`. PATCH accepts partial nested
`features`, `models` and `knowledgeUpdates` (`quietMinutes`, `maxWaitMinutes`,
whole minutes 0–1440) objects; unknown keys, out-of-role model IDs and other
waits are rejected.
PATCH also accepts `logBodies` (`{<component>: true|false|null}`, null removes the
account's override): whether AI Gateway logs keep request and response bodies for
the account's calls (CORE-290). The view's `logBodies` lists each component's site
value, the account's override and the effective value, with the retention note.
The site default is `GET/PATCH /api/admin/ai` (`{logBodies}`; site administrators,
people only to change; null returns a component to the environment's default) and
the **Site AI settings** page (`/settings/site-ai`). Tables: `site_ai_log_bodies`,
`account_ai_log_bodies`; `worker/ai-gateway.ts` resolves them per call from a
once-a-minute isolate cache.
The [CLI equivalent](../cli/README.md#automatic-ai-settings) is `gm settings ai`.

**Body logging privacy and provider limits** (CORE-293). The shared notice in
`shared/ai.ts` applies to both settings pages: enabling bodies may retain
repository code, prompts, replies and assistant conversations, readable by
people with access to the gateway's logs. Turning it off prevents body storage
for subsequent calls using that policy; it does **not** erase bodies already
stored. Metadata logging is separate from payload logging; see Cloudflare's
[logging controls](https://developers.cloudflare.com/ai-gateway/observability/logging/).

The applicable backend depends on the account's **first** gateway, not the
creation date of the gateway handling this call. Under the
[official AI Gateway limits](https://developers.cloudflare.com/ai-gateway/reference/limits/):

- Accounts with a gateway created **before September 24, 2026** use
  [Legacy Logs](https://developers.cloudflare.com/ai-gateway/observability/logging/legacy-logs/):
  **10 MB per log**; oversized logs are not stored. Stored logs remain until
  deleted. At the configured storage cap, collection either stops or deletes
  the oldest logs, according to the gateway's policy.
- Customers whose first gateway was created **on or after September 24, 2026**
  use [Workers Logs limits and retention](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#limits):
  **256 KB per log**; oversized logs are truncated, with **3 days on Free**
  and **7 days on Paid** retention.

These are stored-log limits, not model input limits or a promise that every
body will be available. The October 9, 2026 production audit established Legacy
Logs eligibility and found seven samples with both request and response bodies
available. Its byte measurements were serialized `cf` output, **not original
provider payload sizes**. It did not establish an observed failure threshold
or reproduce a size-related logging failure.

### AI providers (CORE-294)

An account can add models from its own providers, with its own API keys, on
**Settings → AI providers** (`/settings/ai-providers?owner=<account>`). The same
people who save AI settings manage it; members see what is connected and which
models are offered, never a key.

- **TypeSafe:** Jev (`typesafe:jev-latest`, $0.042 per million input tokens,
  output free) answers typed `choice`/`score`/`noul` questions like Clef, so it
  can be the **Classification** model.
- **OpenRouter:** the page searches OpenRouter's public model list (text output
  only, read at most every 15 minutes per isolate) by name, vendor or id, sorted
  by match, recency or input price. Added models (`openrouter:<model>`) can be
  the **Fast** or **Task** model. Models without a JSON response mode are marked;
  structured jobs still parse their replies, with one repair attempt.

Every model shows its published input, output, cached-input, cache-write and
reasoning prices per million tokens where the provider has them. Routers with no
fixed price say so, and Atlas paid synthesis can't use them; it spends at a
provider model's published price otherwise. "Refresh prices" re-reads them.

A key is checked with the provider (TypeSafe `GET /v1/models`, OpenRouter
`GET /api/v1/key`) before it is sealed with `REGISTRY_KEK` into `ai_providers`
(one per account and kind); views carry its last four characters only. Replacing
a key keeps the row, so running work uses the new key. Added models are
`ai_provider_models`, with the name and prices the provider published (never
taken from the request). A model chosen for a role can't be removed, nor its
provider disconnected, until another model is chosen: one guarded `DELETE`
each. Should a chosen model go missing anyway, new work falls back to the role's
default rather than failing.

API: `GET /api/accounts/:slug/ai-providers` (`AiProvidersView`),
`GET …/:kind/catalog`, `PUT …/:kind {apiKey}`, `DELETE …/:kind`,
`POST …/:kind/models {model}`, `DELETE …/:kind/models?model=`,
`POST …/:kind/models/refresh` (`worker/ai-providers/api.ts`). The AI settings
`catalog` lists the built-in models, then the account's provider models for the
roles their capability allows, and PATCH validates against it.

Snapshots name a provider model as `<kind>:<provider row id>:<model>` and carry
its prices (`AiSnapshot.prices`). `worker/knowledge/models.ts` sends those calls
to the provider with the account's key (`worker/ai-providers/providers.ts`)
instead of Workers AI: they are billed to that key and **don't pass through AI
Gateway**, so gateway logging doesn't apply to them. They keep the same
deadlines, rate-limit backoff (429, and 503/529 overload) and usage metering, recorded as
`<kind>:<model>`. Tests fake both providers (`worker/testing/ai-providers.ts`).

Policy is frozen when a Workflow is admitted or a release generation captures its
refs. Retries, watchdog restarts and budget continuations keep that policy,
including Atlas prices and limits; queued successors read the latest settings.
Existing in-progress legacy work keeps its former Task model, Qwen 3.8 27B.
Saving neither cancels running work nor enqueues a rebuild. Re-enabled features
resume on normal triggers or explicit generation requests. Existing content remains
readable, and changing models does not invalidate cached output or rewrite its
original model provenance. Development-only `ATLAS_CONFIG` overrides remain
available for provider and budget verification.

## Knowledge graph and wiki

Every repository has a knowledge graph that stays current as it changes; the
wiki is one consumer of it (the Knowledge tab and `/api/repos/:o/:n/knowledge/*`
are others). Inspired by OpenDeepWiki, rebuilt around the graph and around
real-time incremental updates on Cloudflare.

AI behavior is verified on demand, not by automatic CI. Follow the repository's
[AI verification skill](../../.agents/skills/gitmatrix-ai-verification/SKILL.md)
and run `vp run agent test-ai` for real build/graph/wiki/Vectorize/AI Search evidence.
The isolated non-AI test mode omits provider bindings, suppresses background builds,
and rejects explicit rebuild/search with 503; production behavior is unchanged.
Use `vp run agent test-ai --all` for a fresh check of the entire provider
surface rather than only the stages selected by changed paths. Atlas evidence
retains build statistics and the structural graph before membership assertions;
description citations must belong to the capability's actual primary members
and retain their exact commit and blob provenance.

The retained Gateway assertions inspect up to three successful logs per
body-policy check. Every sampled enabled log must have **both** request and
response bodies; the check waits for their availability rather than accepting
one available sample in place of the others. Disabled samples must have neither
body. Evidence stores availability/serialized-output sizes, not prompt or reply
content; missing bodies are not assumed to prove a size limit.

The `release-notes` stage also exercises the real completion-evidence consumer:
it compares Knowledge's result with the original tracker comment, checks that a
repository-only reader cannot retrieve tracker evidence, then asks the real
assistant without putting the evidence body, receipt or URL in its prompt.
Assertions require a completed answer quoting the original evidence and source
anchor, and a successful persisted Knowledge tool receipt preserving the exact
original evidence fields, issue status, tracker owner and source URL. Either
`search_code` for this repository or `api_get` to its completion-evidence
endpoint can supply that receipt; the model's tool choice is not the contract.
These are gate requirements, not a claim of a successful run or a five-minute
full-gate guarantee; use the run's retained outcomes and timings.

### Live completion evidence (CORE-126)

`GET /api/repos/:owner/:name/knowledge/completion-evidence?q=KEY` reads original
tracker evidence directly, independently of graph/wiki indexing. It requires
sign-in and repository read authorization, then restricts results to readable
trackers and issues currently in an **unarchived workspace subscribed to this
repository**. Repository access alone grants no tracker access. Removing the
subscription or archiving the workspace removes that live source from results.

A query shaped like an issue key (for example `CORE-126`) matches that key
exactly, case-insensitively, rather than notes that happen to mention it.
Other queries search issue keys, titles and evidence bodies. The response is
`{query, evidence, truncated}`: at most 30 notes, newest first, with `truncated`
indicating more matches. Each result retains the original comment fields
(`id`, `issueId`, `kind`, `body`, `actorId`, `createdAt`), current issue context
(`id`, `key`, `title`, `status`, `doneIn`), `trackerOwner`, `trackerOwnerId` and a
`url` pointing to `/tracker/<owner>/issues/<key>#evidence-<comment-id>`.
Evidence remains searchable after reopening; current status is context, not a
rewrite of the original verification claim.

The assistant's `search_code` combines normal code/wiki search with this live
source in `completionEvidence`, preserving source anchors and attribution.
There is no separately indexed, paid copy of tracker evidence and no need to
wait for a Knowledge rebuild to retrieve a new note.

### Build pipeline

```
push ─▶ git proxy ─▶ KnowledgeCoordinator (Durable Object, one per repo)
                       main's pushes pending until they settle (10 min quiet, 30 min at most),
                       one update in flight, at the latest head
                     ─▶ KnowledgeBuild (Workflow, durable retried steps)
   snapshot ─▶ analyze ─▶ graph ─▶ align ─▶ concepts ─▶ synthesize ─▶ review ─▶ graph-final ─▶ index ─▶ wiki ─▶ finish
                 │           │        │          │            │                         │        │
   kg_blob_analysis  kg_nodes/edges kg_concept_pairs kg_concepts  kg_synthesis   Vectorize + AI Search  wiki_pages
   (by blob id)      kg_changes feed (clef, by pair) (groups,     (by inputs hash) (entities / passages) (inputs hash +
                                                      links, trim)                                         clef gate)
```

- **Batched, asynchronous updates** (CORE-286). A push to main marks the
  repository's Knowledge pending: the coordinator records main's new head, how
  many pushes are waiting and when the first and last came. One update then
  runs at the latest head once pushes have paused for the account's quiet
  period, and never later than its longest wait after the first pending push
  (10 and 30 minutes by default; `knowledgeUpdates` in the account's AI
  settings, 0–1440 minutes each; development environments shorten both with
  `GITMATRIX_KNOWLEDGE_QUIET_SECONDS` / `GITMATRIX_KNOWLEDGE_MAX_WAIT_SECONDS`).
  Pushes during an update wait for their own window. A repository's first
  build, an explicit rebuild and a watchdog retry start at once, and a
  repository admin can start the pending update now (`POST …/knowledge/update`,
  the Knowledge tab's **Update now**). Timeline overlays and page sets keep
  their own short debounce. The status says what Knowledge reflects:
  `pending: {pushes, since, dueAt}` beside `indexedCommit` ("Reflects abc1234 ·
  3 pushes pending · update at ~14:05").
- **Updates, not rebuilds** (CORE-286). An update is driven by the diff from
  the indexed commit: it reads only the trees that changed (an unchanged
  subtree's files are the indexed ones), analyzes only new blobs, and every
  model decision after that is reused unless its inputs changed: concept pairs
  (by pair), salience (by the group's names and files), definitions (by the
  concept's name, aliases and the files it is defined from, in its
  repository; not by their summaries, which change wording on every edit),
  reviews (by both entries), component and overview syntheses and wiki pages
  (by their inputs hash). Pairs are decided over the whole repository's
  candidates, so a newcomer that becomes one of an established concept's
  closest is asked about too; names are embedded only when the set of concepts
  changed. Review rounds run until nothing is left to ask, so one update
  settles what its own push changed. Vectors follow the graph's change feed,
  search items their blob or page versions, the Atlas its feed (CORE-166), and
  only changed concept rows are written. A **full rebuild** (`POST
…/knowledge/rebuild`, a repository's first build, or a new pipeline version
  `kg_state.pipeline`) runs every phase over the whole repository, still
  reusing decisions whose inputs are unchanged, and re-embeds every node.
  `worker/knowledge/incremental.test.ts` builds one history twice through the
  real Workflow with deterministic models, updates on one side and full
  rebuilds on the other, and requires identical Knowledge after every push.
- **Per-build AI cost** (CORE-286). Each step meters its model calls into its
  build (`kg_builds.ai_usage`, by model, retried calls included); the build's
  stats get `aiUsage` (calls, tokens, list-price cost by model) and `mode`
  (`update` or `full`, with `fullBecause`), `pushes` and `treesRead`. The usage
  report adds a **Knowledge updates** section: updates and full rebuilds over
  30 days, their calls, cost each and the costliest repositories.
- **Retry-safe answered reviews** (CORE-288). A successful concept-review
  answer is cached together with increments to `conceptReviewsAsked` (the
  build's cumulative total) and `conceptReviewRoundsAsked` (per-round totals)
  in one atomic commit. Replaying a cached answer does not increment either
  counter. Final stats preserve the authoritative durable total rather than
  overwriting it with a stale step snapshot, including when an earlier attempt
  finishes late. These count recorded successful answers, not raw provider
  attempts: actual calls, retries and failures remain separately metered in
  `aiUsage`, including `failedCalls`. Historical counters are not backfilled.
- **Analysis per content, not per commit.** Each file version (blob) is
  analyzed once: exact structure from regex extractors (imports, symbols,
  resolved file/package edges), its role from the Classification model, and a
  semantic card from Fast. An edit classified as cosmetic reuses the previous card.
- **The graph** (repo, directories, files, symbols, packages, concepts,
  components) is rebuilt from cached analyses on every build and diffed, so
  ids are stable and each build leaves a change feed (`kg_changes`).
  Components are size-bounded directory clusters; their summaries, the
  repository overview and concept definitions come from Task, cached by a hash
  of their inputs.
- **Retrieval:** Vectorize holds one embedding per entity
  (`qwen3-embedding-0.6b`); AI Search holds source files and wiki pages for
  hybrid keyword + semantic passage search with reranking. The reranker scores
  raw code far below prose about the same thing, so its cutoff alone hid source
  passages whenever the wiki or a README covered them; search keeps passages the
  reranker scores at 0.4 or more, then ones with vector similarity of 0.5 or more
  (`selectPassages` in `worker/knowledge/indexes.ts`).
- **Concepts are aligned and trimmed with Classification** (`worker/knowledge/concepts.ts`),
  after the entity-alignment recipe: candidate pairs come from shared uncommon
  words and mutual nearest neighbours by name embedding; the classifier scores each
  pair 0 different / 1 related but separate / 2 the same ("should a glossary
  list these as one entry?"), plus which is part of the other. Level-2 pairs
  merge under a stable canonical key (never chaining into a group with a
  concept judged different); clear level-1 directions become `part_of` edges.
  Then each group is asked whether a newcomer would look it up in the glossary
  (3+ files always stay); the rest become `topics` on their files. Once kept
  concepts have definitions, their related pairs are asked again with the
  definitions (`review`), which settles many that names alone left in between.
  Decisions are stored, so an update only asks about pairs it has never
  decided: the concepts its push introduced and the neighbours whose closest
  candidates they changed.
  The wording was picked on hand-labelled samples from this repo: the glossary
  framing with file paths ranked pairs best (AUC 0.94 vs 0.85 for the recipe's
  wording; file summaries made it worse) with all level-2 merges correct; the
  glossary question separated keep/trim at AUC 0.88; with definitions, the
  review recovered half the duplicates names missed. On this repo: 410 concept
  names → 118 concepts (34 names merged into others, 258 groups trimmed to topics), all defined,
  15 part-of links; the glossary went from 60 to 118 entries. First alignment
  ~1,300 `clef` calls (~6 min); a rebuild with nothing new asks none.
- **The wiki** catalog comes from the graph. A page is rewritten only when its
  inputs change _and_ Classification judges the page out of date; diagrams
  are drawn from the graph on every build, never by a model.
- **Historical Clef/Qwen latency** on this repo: a 2-file push updated the graph
  in ~14s, summaries in ~40s, search in ~60s and the affected wiki page in ~90s.
  A first build of ~100 files took ~13 minutes (mostly writing every page once).
- **Robustness:** model calls have deadlines by job (writing 180 s, fast
  90 s, classification 60 s; a call past its deadline is aborted, though the
  provider may still bill it) and back off on Workers AI rate limits (at most
  six retries); a failed file is retried next build; the coordinator's
  watchdog stops a hung build and retries it once.
- **Paid work stops (CORE-285, `paid-work.ts`, `paid-steps.ts`):** each
  Workflow step re-enters the build's metering context (AsyncLocalStorage
  doesn't cross `step.do`), so its calls record in `ai_usage` for the
  repository owner, not as `unattributed`. No call starts after a step
  attempt's timeout (in-flight calls are aborted: the runtime has retried the
  step), or once main's build is no longer `running` (the watchdog stopped it,
  it failed, or the repository is being deleted), which fails the step without
  retries. The watchdog terminates any instance it gives up on unless it
  already ended, even when only its status was unreadable. A failed batch of
  model calls starts nothing more and waits for those in flight.
- **Metering matches the Gateway:** every call's AI Gateway log carries the
  `account` and `feature` it is recorded under; failed attempts (rate limits,
  timeouts, stops) count in `ai_usage.failed_calls`. `test-ai` reconciles the
  fixture owner's `ai_usage` with the owned gateway's logs per feature and
  model (`tools/agent/usage-reconciliation.ts`). Pagination follows the raw
  provider page size, not the filtered count: sparse or empty filtered pages
  must not truncate the audit. When comparing with the
  account meter (`events.aiInference`), use plain `count()` and
  `sum(neurons)`: that dataset is adaptively sampled and its aggregates are
  already weighted by `sampleInterval`. Multiplying by it again squares the
  weight, which overstated spend about 7× in CORE-284.
- **Failed-attempt evidence** (CORE-347): the model invocation boundary emits
  a single `ai.model.failed` JSON warning before retries can discard the failure.
  It records a unique attempt ID (also attached to Workers AI Gateway metadata),
  account/feature/model attribution, whether dispatch occurred, and finite
  failure categories and numeric codes. Local deadlines and stopped/expired
  work are distinguished from provider rejection; unknown failures stay unknown.
  Raw error messages, stacks, causes, prompts and responses are not included.
  Accounting, retries and the original exception are unchanged. `test-ai`
  retains the allowlisted records as `ai-e2e.json.modelFailures` on success
  and failure before owned-resource cleanup. Collection is bounded to the
  final 8 MiB of the server log, 4 KiB per line and 256 events; missing reads,
  invalid records and omissions are explicit, not evidence of zero failures.
  A missing Gateway record still fails strict reconciliation and does not,
  by itself, establish a provider outage.
- **Timeline overlays** (`worker/knowledge/overlay.ts`, CORE-83): a push to an
  owned work source recomputes that timeline's graph diff against main's indexed
  graph using its explicit logical-base/source snapshot. `timeline/<slug>` is
  still the overlay's logical ref (`…/knowledge/overlay?ref=timeline/<slug>`),
  not a branch to read in canonical. Object reads and caches retain source
  identity; only previously unanalyzed blobs need model calls. Main's graph,
  wiki and builds are untouched by work pushes. One overlay per timeline
  (three per repository) runs at a time; main's next build recomputes active
  overlays against it. Ending a timeline keeps its last overlay read-only with
  `state: "ended"` and `ended: {reason, at}`. Archived reads remain source-bound;
  expiry is explicit rather than a fallback to canonical.
  File topics use stable ordering, so introducing a work-only file cannot reorder
  an unchanged canonical file's topics and falsely report it as changed.
- **Timeline wiki pages** (`worker/knowledge/pages.ts`, CORE-84): written at
  checkpoints and on demand, never on every push. Making a checkpoint queues a
  page set per repository (`kg_page_sets`, keyed by the checkpoint, so asking
  again is the same set) after the response; the coordinator starts the
  oldest queued sets, one per timeline and two per repository. The Workflow
  reads the page set's pinned source commit and logical base, then
  writes the component pages it adds or changes (at most 12, most changed
  first), Architecture when components come or go, and a glossary of its
  concepts (no model), with main's wiki code, into `kg_page_set_pages`, never
  `wiki_pages`. A page is copied from the timeline's earlier set when its
  material is unchanged, `kept` (no body) when Classification finds main's page still
  holds, and skipped once the set has spent 80k tokens. No indexing runs.
  `GET|POST …/knowledge/overlay/pages?ref=timeline/<slug>` lists sets or asks
  for one at the bookmark's tip (write access; `&checkpoint=` retries a failed
  checkpoint set), `GET …/knowledge/overlay/page?ref=&slug=&set=` serves one;
  checkpoint views (and so approval requests) carry `knowledge`, and
  `gm timeline pages` lists, writes (`--write`) and prints (`--page`) them.
  Once a timeline's overlay has ended its sets are read-only: none is queued,
  and one being written stops as `ended`, keeping what it wrote.

**Atlas projections** (`worker/atlas/projection.ts`, CORE-158). After
`graph-final`, each Knowledge build materializes the graph as an immutable,
numbered snapshot: entity and edge rows are valid for a range of snapshots, so
a snapshot writes only what changed, and `atlas_current` moves to it in one
statement once it's complete. Interrupted snapshots never become current and
are rolled back before the next.

**Incremental Atlas projection** (`worker/atlas/feed.ts`, CORE-166).
`applyGraph` appends every node and edge it changes to `atlas_feed`, ahead of
the graph writes; a published snapshot records the feed position it reflects
(`feed_mark`) and consumes the rows up to it, while a failed one leaves them for
the next build. So after the first projection a build reads only the changed
nodes, both ends of changed edges and the files whose placement moved, not the
whole graph, and regroups only when grouping's inputs changed (imports between
files, mentions, which files are analyzed, concept names), recording only the
placements that differ from the published ones. Past `FEED_LIMIT` listed
changes, after a projection or grouping version change, or after a snapshot from
before the feed, it reads everything. Either way the published content equals a
full pass over the same graph and history (`incremental.test.ts`). Build stats
carry `atlasTimings`: `projectMs` from `graph-final` (upstream graph inputs
ready) to publication, with the model's share (`describeMs`, `modelCalls`) and
the prose it couldn't keep current (`staleSummaries`, `unavailableSummaries`)
beside it, and index lag separately as `indexLagMs`. To measure on a synthetic
repository: `ATLAS_BENCH=20000 vp test --disableConsoleIntercept
worker/atlas/incremental.bench.test.ts`.

**Capability grouping** (`worker/atlas/grouping.ts`, CORE-163, v3 from
CORE-183, `GROUPING_VERSION`). Before the entity batches, the build groups
analyzed files into capabilities from non-path evidence only: direct imports
(either direction) and shared canonical concepts weighted by rarity, so a
concept nearly every file mentions counts for nothing (and never names a
capability). Each file keeps at most 32 candidate neighbors, found through
import edges and concept postings (common concepts link through a bounded
ring), never by comparing all pairs. Capabilities are top-down communities of
those files: multi-level Louvain at modularity resolution 1 (each level keeps a
community's internal weight, so cohesion counts), so lightly linked groups stay
apart and their link shows as a capability relation. Areas split a capability
at resolution 1.5, kept only when it falls into at least two parts of two or
more files. Groups below three files (`MIN_CAPABILITY_FILES`) that link to each
other combine; what's still small joins the capability it links to most, and
only files linked to nothing (or not analyzed yet) go to the **Unclassified**
group. Identical inputs, in any order, give identical groups. Every file has
one primary placement with the links that justify it (`membership.rationale`)
and cross-cutting references that never count twice. Directory components
remain, under their folders, as inputs. On this repository v3 gives 12
capabilities and 80 areas with 90 related capability pairs, where v2 merged any
linked areas (9 capabilities, 31 related pairs).

**Capability names and summaries** (`worker/atlas/describe.ts`, CORE-164,
`DESCRIBE_VERSION`). The `atlas-describe` step, after grouping and before the
entity batches, names each capability and writes a 2-3 sentence summary and a
membership rationale, from source-backed inputs only: member files' cards, the
directory components' syntheses and the shared concepts, never other
capabilities' prose. It never moves a member or changes an id, so a change in
wording can't change membership. Results are cached in `kg_synthesis` under a
hash of exactly those inputs (and the repository), independent of the selected
Task model. Historical model-keyed entries are reused with their original
provenance, so identical inputs are never inferred twice. A miss is one paid call through the Atlas budget
(`atlasInfer`), in a step that doesn't retry. Capabilities' `data` keeps three
kinds apart (types in `shared/atlas.ts`): `description` (`status` current,
stale or unavailable, with `reason`), `provenance.structural` (grouping),
`provenance.inferred` (model, versions, inputs hash, the source version it was
written from, what it was derived from, and the cited files at their commit
and blob, with ranges or `unavailable`) and `provenance.curated` (none yet).
With a cap reached, an unpriced model, a provider error or a failed step,
capabilities keep their interim names and empty `summary`; `description`
carries the previous snapshot's prose labelled `stale` with its original basis,
or nothing (`unavailable`). List responses show it as `summaryState`.

**Capability identity and layout** (`worker/atlas/identity.ts`, CORE-165).
Grouping recomputes capabilities every build, so public ids come from
reconciling with the previous snapshot by primary membership: a group keeps a
prior id only on a unique reciprocal match with more than half of both sides in
common. Any other group gets a new opaque id (from scope, snapshot and anchor,
so a retried step reuses it, never from its title or member set) and records
the split or merge it came from in `data.lineage`. A retired id is written to
`atlas_lineage` with its successors, so `entity_unknown` for an old link
carries `lineage` (where its members went, or `removed`) instead of resolving
to something unrelated; links pinned to an older snapshot still read it as it
was. Layout is local: each capability (and each area within its capability)
has a slot in a fixed-width grid (`data.layout {slot, col, row, bucket,
fill}`), kept while the id continues, with new regions taking the lowest free
slot and size shown as a power-of-two bucket inside the cell, so regions
appearing, growing or leaving never move another.

**Atlas paid-synthesis budgets** (`worker/knowledge/budget.ts`, CORE-162).
Model calls the Semantic Code Atlas adds go through this module; upstream
Knowledge inference, release notes and the assistant don't, so their spend
stays where it was (build stats' `tokens`, `kg_synthesis`), and each build's
stats carry Atlas spend separately as `atlasSpend`. Caps (`ATLAS_LIMITS`): per
repository build 20 calls, 100,000 input and 10,000 output tokens; per account
grouping pass 10 calls, 50,000 input and 5,000 output tokens; and **$10 per
UTC day per owning account** (the repository owner), shared by every
repository, scope and principal. Prices are `ATLAS_PRICES` (USD per million
input/output tokens per model id, from `cf ai models list`); a model without one
returns `disabled`. Each call is reserved before it runs at its maximum cost
(input estimate + `max_tokens`) by one guarded `INSERT … SELECT` into
`atlas_spend`, so concurrent callers can't overshoot, then reconciled to
reported usage. The first cap reached is recorded in
`atlas_budget_exhaustions` and stops that run (the ceiling: the account until
UTC midnight); a failed call stays charged and nothing retries automatically.
Integrate with `runAtlasCall(env.DB, {scope, purpose, model, maxInputTokens,
maxOutputTokens}, call)` (or `reserveAtlasCall` then `settleAtlasCall`,
`failAtlasCall` or `releaseAtlasCall`), passing `attempts: 1` to `chatJson`;
on `exhausted` or `disabled`, publish structure and label summaries
unavailable. Only build-time code may import it: browsing never authorizes
inference.

**Atlas projection retention** (`worker/atlas/retention.ts`, CORE-159). Atlas
snapshots (`worker/atlas/projection.ts`) are bounded by `ATLAS_RETENTION`:

- **Count:** per scope, the current snapshot plus at most **20 prior** published
  ones; the oldest beyond that expire (`expired_reason = count`).
- **Age:** a prior expires **7 days** after it was superseded (`expires_at`,
  stamped by the retention pass after the next publication; `age`).
- **Storage:** **2 GiB per repository** scope. A scope's storage is the sum of
  its snapshots' `bytes`, the estimated size of the rows each opened that still
  exist (UTF-8 length of every column plus 160 bytes per entity row and 96 per
  edge row for keys and indexes). Over the cap, the oldest prior is evicted
  first (`storage`), one at a time, its rows reclaimed before measuring again.
  Account-level composition (workspace scopes, not built yet) gets **2 GiB per
  account** across all its scopes and principals, lineage and provenance
  included: `enforceRetention` takes a pool of scopes with
  `ACCOUNT_COMPOSITION_RETENTION`, so changing scope can't multiply the allowance.
- **Never current:** a new snapshot that doesn't fit with every prior gone
  fails before publication (`status = failed`, `failure = capacity`, a
  readable `error`); the previous snapshot stays current, stale, and
  `capacityFailure(scope)` reports it.
- **Reclaiming:** expiring a snapshot deletes the entity and edge rows no
  retained (published or building) snapshot sees; rows a retained snapshot
  still sees stay. Each pass is bounded (5,000 rows per table per round, 10
  rounds) and idempotent. The Knowledge build runs passes before admission and
  after publication; the hourly cron (`17 * * * *`) resumes leftover work and
  expires priors that came due. Expired records answer as expired while rows
  they opened survive and for 30 days after, then as unknown.
- **Reads and cursors:** `pinnedSnapshot(scope, id)` answers
  `{state: "ok", snapshot}`, `{state: "expired", snapshotId, seq, expiredAt,
reason, current}` or `{state: "unknown"}`; an expired snapshot is never
  served from current silently. Cursors expire **30 minutes** after issue or at
  their snapshot's expiry, whichever is first (`CURSOR_TTL_MS`,
  `cursorExpiresAt`), and never hold off eviction. The Atlas read API
  (`worker/atlas/api.ts`, `/api/repos/:owner/:name/atlas`) resolves every pinned
  request and every cursor page this way before reading a row (410
  `snapshot_expired` naming `current`), its cursors carry their issue time, and
  its overview reports `capacityFailure` so the UI can show a stale snapshot.

**Atlas workspace scope** (`worker/atlas/workspace.ts`, CORE-161). The same
read API over several repositories of one account lives at
`/api/accounts/:owner/atlas/{overview,regions,children,detail,ancestors,relations,evidence,catalogue}?repos=a,b`
(at most 50; `src/lib/atlas.ts` `atlasWorkspaceApi`). The selection is
explicit and re-authorized on every request, cursor pages included: one SQL
query keeps the selected repositories the caller can read now (`readableRepo`),
so an unreadable repository looks exactly like a missing one, is never counted,
and changes nothing in the response. The scope id, `ws:<ownerId>:<hash>`, names
that authorized set; cursors are bound to it, so revoking access (or a
visibility change) turns open cursors and pinned composites into
`cursor_invalid` / `snapshot_unknown` before any row is read. Selecting a
repository stores nothing, subscribes to nothing and never starts a Knowledge
build (a tracker workspace's repositories can seed the selection client-side).

Composition is virtual: responses read each repository's own published
snapshot, ranked together (capabilities across repositories by primary files,
groups after), with entity ids namespaced `<repoId>/<id>`. Each response lists
the repositories it read with their own state (`ready`, `building`,
`unavailable`, `not-enabled`) and snapshot vector, never a common HEAD; the
composite id `ws1.<tag>.<seq per repository>` pins them all and each is
resolved through retention on every page. Nothing composed mixes repositories:
every name, summary and count comes from one repository's projection, so
narrowing the scope can't leave a hidden repository's labels behind.
Virtual composition stores nothing.

**The Knowledge tab is the Atlas** (`src/routes/repo/Atlas.tsx`, CORE-174).
`/:owner/:repo/knowledge` reads only bounded `/atlas/*` pages (overview,
children, detail, relations, evidence, ancestors, catalogue) plus the build
status, the wiki catalog and timelines' overlays; nothing in normal navigation
reads the whole graph. The old eager `GET …/knowledge/graph/map`, its
module-level cache and the client-side whole-map search are gone. The whole
graph is still available as JSON from `GET …/knowledge/graph/export`, which the
page calls only from its **Export graph** button. Old links keep working: the
pre-cutover `/atlas` address redirects to `/knowledge` with its query, and the
old map's `?node=<id>` becomes `?select=<id>` (entities keep graph node ids;
`node=repo` opens the overview). The timeline picker and the selected
timeline's overlay (CORE-83) sit beside the inspector, a change of `?tl`
reads the overview again, and an entity with a wiki page links to it. The
palette's entity results, the file view's knowledge rail and wiki pages open
the Atlas with `?select=`. When any Atlas read finds the repository itself
unreadable (access revoked, made private or deleted: a 404 or 401 without an
Atlas `code`; `atlasAccessLost`, `onAtlasAccessLost` in `src/lib/atlas.ts`),
the tab reads its route again, so the not-found page replaces the whole view
rather than leaving what was read before on screen.
Restored selections move focus to the inspector when it arrives, unless a
newer focus, pointer or keyboard interaction already took ownership while the
selection was loading (CORE-332). In particular, a late selection must not take
the resize handle's focus or swallow its Home-to-reset action.

**Atlas authorization suite** (`worker/atlas/authorization.test.ts`,
CORE-178). One D1-backed suite drives the real application (`worker/app.ts`:
token authentication, route mounting) through every Atlas surface, repository
and workspace, fresh, pinned and mid-cursor, plus the Knowledge page's other
reads (status, wiki catalog, overlays) and the graph export, as separate
people, an agent, an organization member and anonymous readers. It holds that
an unreadable private repository is a 404 byte-identical to a missing one
(never a 403); that revocation (collaborator removed, made private,
organization membership or default access ended, agent revoked) takes effect on
the next request, warm or cold, with cursors and pinned snapshots disclosing
nothing; that cursors are bound to principal, repository, route and filters;
that a workspace never shows a lost repository through composition, related
links, lineage, lookup or totals; that a deleted repository leaves no Atlas
rows and nothing for a namesake; that building and failed projections are never
readable while pinned pages keep their snapshot; and that no browse path
touches a model, Vectorize or AI Search (those bindings throw). The
browser-mode test `src/routes/repo/Atlas.browser.test.tsx` removes a
collaborator while their Knowledge tab is open and checks the view clears; the
E2E `atlas-revocation-reads-like-a-missing-repository` checks the same through
real tokens against the dev server.

**Atlas scale gates and benchmark** (CORE-177, PRD gate 18). Two layers.
`worker/atlas/scale.test.ts` runs in every `vp test` and holds what is
deterministic: on repositories built by the real graph builder and projection,
every repository read route makes the same number of D1 round trips at 8x the
repository; a workspace's grow only with the repositories selected; every
statement a read route sends finds Atlas rows through an index (`EXPLAIN QUERY
PLAN`, no full scan); pages stay within 100 records and the overview within 12
regions and 256 KiB compressed. Timings are measured on demand, never in CI:
`vp run website#atlas-bench` (projection and API) and
`vp run website#atlas-bench-browser` (adds Chromium; run
`vp run website#build` first), from `worker/atlas/scale.bench.test.ts`
(knobs `ATLAS_SCALE_FILES`, `_IMPORTS`, `_REPOS`, `_SAMPLES`, `_CPU`, `_OUT`).
The last run's raw results are `worker/atlas/scale.results.json`.

Recorded 2026-10-03, i7-13700K (24 threads, 14.6 GiB), Node 24, 30 samples per
scenario after a first request. Workloads: one repository of 20,000 synthetic
files (103,051 Atlas entities, 1,122,440 edges), and the same scale across 50
repositories (112,268 entities, 949,566 edges). **Boundaries:** server times
are the real app (token auth, routing, handlers) in-process over local
node:sqlite D1, request to body, with no network and no D1 latency, so
production adds round trips x D1 latency (round trips are recorded; most run
in parallel). Client times are the production build served by the benchmark
(gzipped), headless Chromium 153 with CDP throttling: 50 ms latency, 20 Mbps
each way, CPU slowed 4x. That approximates, and does not reproduce, the PRD's
4-core / 8 GiB client.

| Single repository, server             | p50 ms | p95 ms | D1 trips | records | gzip bytes |
| ------------------------------------- | ------ | ------ | -------- | ------- | ---------- |
| overview (12 regions)                 | 24.4   | 27.7   | 9        | 12      | 1,953      |
| catalogue page                        | 24.3   | 25.7   | 7        | 44      | 1,559      |
| children, highest fan-out (773)       | 8.3    | 9.8    | 7        | 100     | 1,334      |
| detail, symbol                        | 61.5   | 69.0   | 9        |         | 666        |
| ancestors, symbol (deep link)         | 53.8   | 58.4   | 6        |         | 604        |
| relations in, most imported file      | 50.1   | 56.1   | 7        | 63      | 1,946      |
| evidence, capability                  | 149.7  | 156.4  | 7        | 100     | 1,753      |
| contributing imports, capability pair | 442.3  | 460.2  | 7        | 70      | 1,173      |
| catalogue lookup                      | 26.5   | 29.9   | 6        | 50      | 1,416      |
| compare, two pushes apart             | 15.4   | 17.0   | 12       | 100     | 3,637      |

| 50 repositories, server       | p50 ms          | p95 ms          | D1 trips | records | gzip bytes |
| ----------------------------- | --------------- | --------------- | -------- | ------- | ---------- |
| overview                      | 39.8            | 51.4            | 157      | 12      | 4,641      |
| catalogue page                | 63.5            | 77.9            | 156      | 100     | 5,240      |
| children / detail / ancestors | 1.4 / 2.8 / 3.0 | 4.3 / 4.3 / 5.0 | 8 to 11  |         | under 800  |
| catalogue lookup              | 59.8            | 87.5            | 106      | 50      | 3,975      |

| Client (Chromium, throttled)                          | p50 ms                        | p95 ms |
| ----------------------------------------------------- | ----------------------------- | ------ |
| repository overview, cold navigation (shell included) | 863.5                         | 949.0  |
| repository overview, reload (shell cached)            | 332.7                         | 374.7  |
| child page (expand a region, request verified)        | 56.9                          | 142.2  |
| detail (select an entity)                             | 416.1                         | 475.4  |
| workspace overview of 50 repositories (shell cached)  | 429.7                         | 472.6  |
| pan/zoom                                              | 60 fps, longest frame 16.8 ms |        |

Projection: the full pass took 22.0 s locally (438 round trips); incremental
pushes of 1 and 10 files 1.0 s and 4.7 s (164 and 177 trips; 10 files
regroup), after the graph write; 50 repositories 293 ms each (p50). No browse
request read the whole graph. **Against gate 18** at these workloads: ≤12
overview regions, ≤100 records per page, an overview of 2 to 5 KiB
compressed, no full-map fetch, p95 overview under 1 s and child/detail under
0.5 s on the client, and frames at the headless 60 Hz cap during pan and zoom.
**Gaps:** server numbers exclude D1 latency, so a 50-repository workspace
overview (157 trips, parallel) and the 1,122,440-edge repository's
`contributing` (442 ms, it reads every import of the source capability) and
`evidence` (150 ms) are the routes to watch in production; the client profile
is a throttled fast host, not a 4-core / 8 GiB machine; and headless frame
timing can't show rates above 60 fps.

**Main snapshot comparisons** (`worker/atlas/compare.ts`, CORE-175).
`GET …/atlas/snapshots` lists a repository's published snapshots newest first
(current, retained, or expired with its reason); `GET
…/atlas/compare?from=<older>&to=<newer>[&class=&within=]` pages change records
for capabilities, areas and files, each classed **source** (files added,
removed or with another blob; a region's files added or removed),
**regrouping** (a file's capability or area moved; a region appeared, was
retired with its lineage, or had files move in or out), **summary** (only
names or descriptions changed, with the same blob or the same members) or
**other** (`fields` names what differs). It reads only rows opened or closed
between the two sequences (indexed by `atlas_entities_opened` and
`atlas_entities_open`), classes them in SQL so a class filter pages and counts
exactly, runs no model, and carries caveats (different projection/grouping
versions, partial sides, builds in between, same commit; relations aren't
compared). `to` pins the pages; cursors are bound to `from`, the class and
`within`. Either side past retention is 410 `snapshot_expired` (404
`snapshot_unknown`) with `side`: the comparison is unavailable, never empty.
The Knowledge tab's **Compare with an earlier snapshot** panel
(`AtlasCompare.tsx`) keeps `compare=<older id>`, `changes=<class>` and
`within=<capability>` in the address beside the pinned `snapshot`, filters by
the selected capability, and hands off to source at either commit, history and
syntax changes; Back returns to the same comparison.

**Workspace Atlas page** (`src/routes/atlas/`, CORE-172), at
`/:owner/-/atlas?repos=a,b`, linked as **Knowledge** from the account page. Pick the
account, then repositories you can read (or fill the selection from a tracker
workspace's subscribed repositories, read once on request); the URL keeps the
selection in pick order. Coverage lists every selected name with its own
commit, build and state (ready, partial, lagging, building, unavailable, not
enabled, unavailable to you) and whether its published packages are recorded
for cross-repository resolution; never a common HEAD, and selecting a
repository without Knowledge starts nothing. The map draws each ready
repository's own territory in its own fixed-width column, in pick order, from
its own layout slots (`workspace.ts` `buildWorkspaceTerritory`), so shared slot
numbers never collide and a repository growing never moves another. Changing
the selection or account remounts the view (`WorkspaceSession`): in-flight
requests are aborted and late answers dropped. When a pinned request reports
the authorized set changed (revocation mid-view), the page re-reads the scope,
discards everything from repositories no longer readable and offers the
current view.

**Cross-repository composition** (`worker/atlas/compose.ts`, CORE-167,
`COMPOSITION_VERSION`). Over a workspace scope,
`/api/accounts/:owner/atlas/composition?repos=…` pages capabilities spanning
repositories, and `/links?repos=…&id=<repoId>/<capability>&state=resolved|unresolved|related`
(`direction=in` with `id=<repoId>/repo` for dependents of a repository) pages
one capability's cross-repository links (`atlasWorkspaceApi.composition` and
`.links`). A dependency is **resolved** only with concrete evidence: files of
the capability import a package (the graph's static `pkg:<ecosystem>:<name>`
imports) that the registry's CI publish provenance (`package_sources`, latest
`publishes` row) says exactly one other selected repository publishes, in a
feed the caller can read, matched by a fixed per-format rule (npm name, cargo
crate, PyPI module, Go module path). Each carries its package, publisher (feed,
version, commit, run), importing files at the indexed commit and the nearest
manifest above them (located by path, not read). Otherwise an import is
**unresolved** (`no-publisher`, or `ambiguous` with the candidates), and
capabilities sharing canonical concepts without a dependency are only
**related**. A capability depending on another repository is linked to that
repository's capability sharing the most concepts; linked capabilities form a
composite (`xcap:<hash of its anchor>`), named from shared concepts, with each
member keeping its own prose (never merged across repositories). No model runs.

What a repository publishes is frozen into each repository snapshot at build
(`atlas-packages` step, `atlas_snapshots.packages`, `worker/atlas/publishers.ts`),
so pinned pages resolve against the same facts; snapshots from before it say
`unrecorded` (an up-to-date build re-projects them). The composition is computed
when read, not materialized: inputs are each readable repository's pinned
snapshot (at most 200 capabilities and 5,000 package-import rows each, with
coverage reported), and a per-isolate cache is keyed by the scope id, composite
snapshot id and readable feeds, i.e. exactly the authorized inputs, and by
principal: a reader with the same access gets the same content, but never
another's warm answer, whose timing would tell them someone else just looked. A denied
repository is never read, so every response is byte-identical to a selection
without it. Materializing would multiply snapshots per selection and principal
policy inside the one 2 GiB account composition pool and need invalidation on
every visibility change; computing needs neither, so the pool stays unused and
no account grouping budget is drawn.

The model catalog lives in `shared/ai.ts`; provider adapters live in
`worker/knowledge/models.ts`. `POST /api/dev/clef` with
`{state, questions}` is a playground for tuning `clef` questions. Adding `repo`
(a personal repository ID) requires its owner's writable personal token and
uses the repository's admitted classification policy, with metering and no
automatic retry. The independent `test-ai` stage `classification` uses this
path for one real decision each on Clef Flash and Clef Omni: distinguishing an
ongoing outage from a healthy status and a hypothetical question. It checks
persisted selector acceptance and uncached, account-attributed Gateway records.
Classifier Gateway records can omit token counts, so application metering must
also show exactly one added successful call and positive input tokens.
The proof restores the original selection in `finally`; Clef remains the default.
It requires no Knowledge build. Resources (dev): Vectorize index
`gitmatrix-knowledge`, AI Search namespace `gitmatrix` / instance `knowledge`.

## CI/CD

Repositories declare a pipeline in `.gitmatrix/ci.yml`; every push that moves
a matching branch starts a run (also: the Run button, `gm runs start`, re-runs,
and, for projects that opt in, [preview runs](#the-preview-contract) and
[step runs](#step-runs)).

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
      - run: vp test
  deploy:
    needs: [test] # runs only if test succeeded
    if: branch == "main" # ==, !=, &&, ||, () over branch, trigger (push, manual, preview, landing, step), commit, runner, action
    secrets: [CLOUDFLARE_API_TOKEN] # `gm secret set`, masked in logs
    timeout_minutes: 15 # default 20
    instance: standard-2 # sandbox size (default standard-1)
    steps:
      - run: cf deploy
```

```
push ─▶ git proxy ─▶ onPush: ci_refs diff (one run per moved branch) ─▶ ci_runs/jobs/steps (D1)
                                                                     ─▶ CiRun (Workflow, one per run)
CiRun: jobs in dependency stages, in parallel within a stage, dependents of failures skipped
   CI_RUNNER=sandbox  step.do ─▶ CiSandbox (Durable Object + container, one per job):
                      start, clone from Artifacts, bash each step, stream logs, destroy
   CI_RUNNER=local    job queued ─▶ POST CI_DISPATCH_URL ─▶ vp dev starts `gm runner --once`
                      ─▶ it claims the job over the API, runs the steps on your machine,
                      streams logs, reports the end, exits ─▶ step.waitForEvent resumes
```

### Candidate verification reuse

A job may explicitly declare `verification: context-invariant-v1`. This is the
pipeline author's assertion that its result is independent of branch, trigger and
other run context, not automatic reuse merely because two runs have the same Git
OID. Leave it off context-sensitive jobs, especially deployment.

Reuse requires successful **actual sandbox execution** for the exact current
canonical repository, candidate commit, queue attempt and job specification. The
producer must also match the current known resolved container image digest and
Worker `CI_VERSION` metadata. A tag or configuration fingerprint is not an image
identity. Local runners, custom images, jobs with secrets and jobs with concurrency
controls are ineligible. Missing or unknown identity, failed verification or a
changed candidate, attempt, specification, image or Worker version falls back to
normal execution.

The persisted queue owns main CI for its exact canonical candidate from the
advancing fence through pending deployment. Ordinary moved-ref observers still
update `ci_refs`, but defer that delivery to queue recovery rather than creating
an unverified pipeline first. Other repositories, sources, branches and commits,
and queues whose deployment is already terminal, retain ordinary push behavior.

A proposed proof at run creation is not yet public verification. The workflow
revalidates it when consuming the gate, including after recovery, against the
current runtime identity and only after the main run's prerequisites succeed.
Rejected proposals cannot leave a positive `verifiedBy`; a failed prerequisite
still blocks its dependent. Completed accepted gates retain their consumption-time
provenance. Reuse neither removes independent main jobs nor bypasses the DAG:
all main jobs remain, and deploy still executes.

An accepted reused job has public status `skipped` plus `verifiedBy`, displayed as
**Verified (not executed)** rather than ordinary **Skipped**. Its provenance links
to the producer run/job with the candidate commit and queue attempt. It has no
fabricated execution output or duration; inspect the producer for actual logs.
`gm runs show`, `gm runs wait` and JSON output preserve this distinction rather
than claiming the consumer executed or finished before the remaining main jobs.

After changing admission or runtime identity, verify reuse with a subsequent
normal queue submission once the Worker deployment has succeeded. The pipeline
shipping that change is created by the previously deployed implementation and
may execute every gate normally. Check the producer's actual sandbox success,
the consumer's `verifiedBy` links and absence of execution claims, and the real
main deployment result; queue admission or a green pipeline alone proves none
of those reuse properties.

### Runners and pipeline operation

- **Runners.** Deployed, jobs run in Cloudflare Sandbox containers (image
  `ci/Dockerfile`: Node 24, pnpm, Vite+, Rust, git, and Chromium's headless
  shell; see "CI image" below). Under `vp dev` they run on
  this machine instead, so development doesn't start paid containers, and
  they come and go the same way: when the CI Workflow queues a job it pings
  the dev server (`CI_DISPATCH_URL`), whose `vite/ci-runners.ts` plugin starts
  `gm runner --once` processes until the queue is empty (one at a time by default,
  or two in isolated agent environments; `GITMATRIX_CI_RUNNERS` overrides the
  limit at server startup). Nothing has to be left running; jobs
  queued while the dev server was down start when it comes back. Outside
  `vp dev`, `gm runner` still works by hand. `GITMATRIX_CI_RUNNER=sandbox vp dev`
  runs the container path locally with Docker. The choice is made in
  `cloudflare.config.ts`, which attaches the container only when sandboxed.
- **Local compiler reuse and evidence.** The local runner keeps Cargo outputs
  outside disposable checkouts, partitioned by server/repository/job and leased
  per concurrent job. Cargo checks freshness; every test command still executes.
  Explicit `CARGO_TARGET_DIR` keeps normal Cargo semantics and bypasses managed
  caching. `GITMATRIX_CI_ARTIFACTS_DIR` points to a private retained job directory;
  write only sanitized reports there. The harness retains allowlisted JSON, not
  credentials, raw logs or browser storage. Setup logs print cache/evidence paths.
  Checkout credentials are deleted before terminal reporting, on success or failure.
  Failed checkouts retain the last unsuccessful Git operation's stderr, including
  an exact-commit fetch after a successful shallow clone. Source-landing E2E
  boundary failures capture failed jobs' CI logs through the redacted recorder,
  alongside run metadata, before deleting their fixtures.
- **This repository's pipeline.** Check, test and build start independently on
  `standard-4` Sandboxes; all must pass. The four gates `check`, `test`, `build`
  and `cli` explicitly opt into `verification: context-invariant-v1`; deploy does
  not, and remains real execution. Non-AI E2E runs only where `runner == "local"`
  (it is too expensive per push), so `vp run ready` is its gate. No job consumes
  another's artifacts, and keeping them in one stage avoids a scheduler barrier.
  Real AI verification is an explicit agent command.
  Checkpoints of a timeline get a preview of the app
  ([Timelines' own previews](#timelines-own-previews)). Each push to a
  timeline also gets a [step run](#step-runs) of just `step-check` (`vp check`:
  format, lint, types) and `step-unit` (the website's unit tests related to the
  step's changes, `vp test run --project unit --changed`), about 25 s locally;
  `gm test` runs the same two jobs before `gm step` commits.
- **CI image.** Besides the toolchains, `ci/Dockerfile` bakes Chromium's
  headless shell for the browser-mode tests (CORE-248), with its system
  libraries, at its `PLAYWRIGHT_VERSION`: about 540 MB of the image (260 MB
  browser, the rest libraries and fonts). Browsers live in
  `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`, and `/root/.cache/ms-playwright`
  links there for processes that don't inherit the variable;
  `/usr/local/share/playwright-deps/<version>` marks the version whose libraries
  are installed. The test job's "Chromium for browser-mode tests" step then
  takes under a second: it skips `playwright install-deps` when the marker
  matches the lockfile's Playwright, and `playwright install --only-shell`
  finds the revision present. On an older image (a Playwright upgrade that
  hasn't been deployed yet) the same step installs the libraries and fetches
  the browser, about 20 s. A local runner isn't root, never installs
  libraries, and uses the user's cache. `tools/agent/ci-image.test.ts` fails
  when the ARG and `pnpm-lock.yaml` disagree, so a Playwright upgrade bumps
  both and then needs `vp run deploy` from a machine with Docker.
- **Both runners report the same way** (`worker/ci/jobs.ts`): batched log
  chunks, step transitions, the end. Secret values are masked server-side; a
  cancelled job is told so in the reply to its next report and kills its
  process group.
- **Agents** push, then `gm runs wait`: it blocks on the commit's run and exits
  non-zero with the failing job named; `gm runs logs --job <name>` has the output.
- **Job variables.** `CI`, `GITMATRIX`, `GITMATRIX_REPOSITORY`, `GITMATRIX_BRANCH`,
  `GITMATRIX_COMMIT`, `GITMATRIX_RUN_NUMBER`, `GITMATRIX_JOB`, `GITMATRIX_TRIGGER`
  (`push`, `manual`, `preview`, `landing` or `step`) and `GITMATRIX_TOKEN`; `GITMATRIX_TIMELINE` on a
  timeline's bookmark and in preview runs, which also get `GITMATRIX_CHECKPOINT`
  and `GITMATRIX_PREVIEW_ACTION`. A job's `env:` and secrets come after them.
  `GITMATRIX_VERIFIED_BASE` is reserved and cannot be overridden by repository
  environment or secrets: JSON `{commit, runNumber, jobId}` from an executed,
  runtime-equivalent successful job, or JSON `null`. Only opted-in
  `context-invariant-v1` sandbox jobs without secrets can receive evidence.
  It is a candidate comparison baseline, not authorization to skip a required
  job; consumers must prove ancestry and complete input independence.

API: `/api/repos/:o/:n/ci` (runs, `?ref=<branch>` for one branch's, run detail,
logs with `?after=`, cancel, re-run, commit statuses, secrets) and
`/api/ci/runner` (claim, report).

### Step runs

An agent working in a timeline pushes at every meaningful step (CORE-226). A
**step run** is the light check each of those pushes gets, the way pull-request
checks are lighter than main's (CORE-235). A repository opts in with `on: step`,
and a job joins step runs by listing `step` in its own `on:`:

```yaml
on:
  push: {}
  step: {} # opt in: each push to timeline/<slug> also starts a step run
jobs:
  lint:
    on: step # only in step runs
    local: true # `gm test` runs it on the developer's machine too
    steps: [vp check]
  unit:
    on: [push, step] # in push runs and step runs
    needs: [lint] # a step job may only need step jobs
    steps: [vp test run --changed]
  build: # no on: the default runs (push, manual, landing), never step runs
    steps: [vp build]
```

- **Only step jobs run.** A job without its own `on:` never joins a step run,
  even if its `if:` would allow it, so adding `on: step` changes nothing else.
  Jobs see `trigger == "step"` and `GITMATRIX_TRIGGER=step`.
- **Beside the push's run, never instead of it.** `onPush` starts the step run
  after the push run for a moved `timeline/<slug>` bookmark. It's stored with
  `ci_runs.step = 1` (and trigger `manual`, like previews), and it never answers
  for a commit's CI: the push run's dedupe and coalescing, the landing and
  checkpoint green checks, the tracker's commit status and auto-landing all
  leave step runs out.
- **Results attach to the step.** When a step run ends, `recordStepRun`
  (`worker/steps/runs.ts`) stores a `test-summary` artifact in `step_artifacts`
  (the run's status, each job's status, exit code and duration), keyed by
  commit, so it attaches to every step version of that commit, whenever its
  context is uploaded. The steps API returns them as `artifacts`, newest
  first (`StepArtifact`, `shared/steps.ts`). The schema allows `screenshot` and
  `document` artifacts with a stored object later.

#### Heavy work waits for a quiet period

Step runs are per step; a timeline's heavy work isn't (CORE-238). Its full CI
(the push run) and its knowledge overlay run for the timeline's latest head
once its pushes pause for the **quiet period**, ten minutes
(`worker/timelines/quiet.ts`), or at once when a checkpoint is made:

- **Full CI.** A push run on `timeline/<slug>` is stored with `quiet_until`
  and its Workflow starts right away, then waits (`waitForEvent`
  `quiet-release`, timing out at `quiet_until`). A newer push to the timeline
  covers it (`cancelled`, `covered_by` the new run) and waits in its place; a
  checkpoint (`POST …/timelines/:slug/checkpoints`) sends the event, so the
  checkpoint's commit is tested now. A checkpoint can beat its push's run (runs
  start after the push answers), so it also notes the commit on the branch's
  `ci_refs` row (`quiet_released`) and a run of exactly that commit doesn't wait. Main and other branches never wait, and
  step runs never do.
- **Knowledge overlays.** The repository's coordinator remembers when it
  first saw each timeline tip and starts the overlay once the tip has stood
  for the quiet period (`scanOverlays`); a moved main still rebuilds overlays
  at once. A checkpoint asks for its timelines' overlays now (`overlayNow`),
  within the automatic-AI settings (CORE-190) like every overlay.
- **Previews** already follow checkpoints only.

Development environments may shorten it with `GITMATRIX_TIMELINE_QUIET_SECONDS`
(agent environments use 3 s, so E2E exercises the wait); deployed Workers
always wait ten minutes.

### Deployments and previews

Timelines deploys nothing (`TIMELINES-RESEARCH.md`, "Previews: primitives, not
hosting"): a job that deploys records where it went, and the run page and the
commit list show it. An environment is a name per repository: `production`,
`timeline/<slug>` for a timeline's previews, `branch/<name>` for any other
branch a job deploys from, or any name a project uses (`staging`). Records keep the environment, timeline, checkpoint, commit, URL,
status (`active`, `sleeping`, `expired`, `failed`), the run and job that
recorded them, the person and agent accountable, and an expiry. Expiring a
preview changes its status; the record stays. `shared/deployments.ts` defines
the wire types (`worker/deployments/`).

| Route                                                          | Contract                                                                                                                               |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/repos/:o/:n/deployments`                             | Newest first; filters `environment`, `timeline`, `commit` (up to 80, comma-separated), `run`, `status`; pages with `before`, `limit`   |
| `POST /api/repos/:o/:n/deployments`                            | `{url, commit?, environment?, timeline?, checkpoint?, status?, expiresAt?}`                                                            |
| `GET`, `PATCH /api/repos/:o/:n/deployments/:id`                | One record; `PATCH {status?, url?, expiresAt?}`                                                                                        |
| `GET /api/repos/:o/:n/environments`                            | `production` and each recorded environment, with its newest deployment                                                                 |
| `GET`, `PATCH /api/accounts/:slug/settings/previews`           | Preview retention `{endedDays, idleDays}`: 2 and 7 by default; org owners change them                                                  |
| `POST /api/tracker/:o/timelines/:slug/checkpoints/:ref/revive` | Rebuild a checkpoint's preview: `{checkpoint, runs: [{repoId, number, runId} \| {repoId, skipped}]}`; write access to every repository |

- **Who records.** Anyone with write access, with a personal or agent token
  (systems outside Timelines too), or a CI job with its own credential
  (`GITMATRIX_TOKEN`, `gmj_…`), which the API accepts only on these routes and
  only for the job's repository while it runs. A job's record takes its run,
  job, commit and accountable person from the run, and its environment from
  the branch: `production` on the default branch, `timeline/<slug>` on a
  timeline bookmark, `branch/<name>` on any other branch (lowercased; runs of
  characters other than letters, digits, `.`, `_` and `-` become `-`, so
  `Feature/Add login` deploys to `branch/feature/add-login`). An explicit
  `environment` always wins. A `branch/<name>` given by hand must already be
  in that form.
- **`gm deploy record --url <url>`** in a job; outside CI add `--commit`.
  `gm deploy list` and `gm deploy update <id> --status expired` read and
  change records.
- **Expiry.** A timeline preview follows the account's retention (below)
  unless the recorder pins an `expiresAt` (on record or by `PATCH`); other
  records don't expire unless told.

#### The preview contract

Projects implement previews in their own CI (CORE-79; `TIMELINES-RESEARCH.md`,
"Previews: primitives, not hosting"). A repository opts in with `on: preview`
(also `on: [push, preview]` or `preview:` under `on:`; pushes start runs either
way, as before). Timelines then starts **preview runs**: `trigger` is
`"preview"`, and `action` is `"create"` or `"teardown"` (empty in every other
run). Jobs choose an action with `if:` like any other condition, and a preview
run runs only the jobs whose `if:` holds: a job without `if:` (tests, deploys)
stays out of it. A job a preview job `needs` must say so in its own `if:`.

```yaml
on:
  push: {}
  preview: {}

jobs:
  test: # no if: push and manual runs only
    steps:
      - run: pnpm install --frozen-lockfile && vp test
  preview:
    if: trigger == "preview" && action == "create"
    secrets: [CLOUDFLARE_API_TOKEN]
    steps:
      - run: pnpm install --frozen-lockfile && vp build
      # GITMATRIX_TIMELINE is the slug; GITMATRIX_CHECKPOINT and GITMATRIX_COMMIT
      # name what to build (one preview per timeline here; per checkpoint works too).
      - run: |
          url=$(./scripts/preview-deploy.sh "timeline-$GITMATRIX_TIMELINE")
          gm deploy record --url "$url"   # files it under the timeline and checkpoint
  preview-teardown:
    if: trigger == "preview" && action == "teardown"
    secrets: [CLOUDFLARE_API_TOKEN]
    steps:
      - run: ./scripts/preview-teardown.sh "timeline-$GITMATRIX_TIMELINE"
```

| Timelines starts | When                                                                                                   | Run                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `create`         | A checkpoint is made (`gm timeline checkpoint`), in each of its repositories                           | At that repository's checkpoint commit in its recorded source     |
| `teardown`       | The hourly sweep finds a timeline's previews in a repository all due (expiry below)                    | At the newest preview's commit, with its checkpoint, by Timelines |
| `create` again   | Someone revives a checkpoint's preview: the button on the checkpoint, `gm timeline revive`, or the API | At the checkpoint's commit; what it records is marked rebuilt     |

Each preview run's jobs get `GITMATRIX_TRIGGER=preview`,
`GITMATRIX_PREVIEW_ACTION`, `GITMATRIX_TIMELINE`, `GITMATRIX_CHECKPOINT` (unset
for a teardown of previews recorded without one) and `GITMATRIX_COMMIT`. A
repository whose ci.yml at that commit doesn't opt in, or has no job for the
action, gets no run; neither does one with a broken ci.yml (its push run
already failed). A run checks out the checkpoint's recorded source and commit,
including archived work sources after landing or abandonment; it never substitutes
the default branch. A purged source returns `source_expired` (410). Each queued
or actually running job retains a source claim. Canceling its parent is not proof
that the runner stopped: local runners acknowledge completion, and Sandbox jobs
stop their container before reporting a terminal result. In flight, the same
action for the same checkpoint is one run; re-running repeats it.
Preview runs don't count toward `coalesce_after`, and a push's run is never
answered by a preview run.

Preview runs are stored as `manual` runs with `preview_action`, `timeline_slug`
and `checkpoint_id` set (`ci_runs.trigger`'s CHECK can't widen without
rebuilding a table that every job, step and log cascades from), and the API
reports them as trigger `preview` with a `preview: {action, timeline,
checkpoint, revived}`.

**Expiry** (`worker/deployments/sweep.ts`, on the hourly cron). A timeline
preview is torn down `endedDays` after its timeline lands or is abandoned
(the timeline's last change) and `idleDays` after the timeline's last push,
whichever comes first: 2 and 7 by default, set per account with `PATCH
/api/accounts/:slug/settings/previews` (`shared/deployments.ts`,
`previewExpiry`). The sweep keeps each preview's `expiresAt` to these rules
unless it's pinned. A timeline's previews in one repository are torn down
together once every one is due: they're marked `expired` with `tornDownAt`
(and `teardownRun` when a run started), and the records stay. If the account's
tracker can't answer, nothing is torn down until the next hour.

**Revival.** A checkpoint's preview can be rebuilt while its recorded source
remains retained and readable, including landed or abandoned timelines. Purged
sources return explicit expiry, not canonical checkout. The run's
deployment record is `revived: true`, with `rebuiltFrom` naming the earlier
record of the checkpoint, and the UI says "Preview (rebuilt)": it is rebuilt
from the commit with migrations plus seed and can differ from the original if
the toolchain or seed changed. A revived preview's clock starts at the
revival: it lasts `endedDays` after it for an ended timeline, `idleDays`
otherwise.

#### Timelines' own previews

This repository implements the contract for itself (CORE-80;
`TIMELINES-RESEARCH.md`, "Gitmatrix's own previews: the reference
implementation"), as a worked example any project could copy. It uses only
what every project has: `on: preview`, the job variables and credential, a
repository secret, `cf`, and `gm deploy record`.

**Asking for a preview.** A Timelines timeline asks by making a checkpoint
(`gm timeline checkpoint`). Timelines then starts a `create` run, and the
`preview` job in `.gitmatrix/ci.yml` builds a preview of that checkpoint. There
is nothing else to switch on: checkpoints are what reviewers approve, so a
timeline that never makes one never pays for a preview. Revival works the same way.

```
checkpoint ─▶ preview run (create) ─▶ preview job ─▶ node tools/preview/preview.ts create
   1. tear down whatever an earlier create left (as below)
   2. fresh D1s: gitmatrix-preview-<slug> (migrations, then seed/) and
      gitmatrix-preview-registry-<slug> (registry/migrations)
   3. an R2 bucket and an Artifacts namespace: gitmatrix-preview-<slug>
   4. cf previews deploy timeline-<slug>, in preview mode, bound to 2–3
   5. the agent fixtures (tools/agent/seed.ts) through the preview's own API
   6. gm deploy record --url <URL>   → timeline/<slug>, at the checkpoint
expiry ─▶ preview run (teardown) ─▶ preview-teardown job ─▶ … preview.ts teardown
   delete the Preview (Cloudflare API: `cf previews` can only deploy),
   then the D1s, the bucket (emptied first) and the namespace (repositories first)
```

- **One preview per timeline.** The Worker Preview is named
  `timeline-<slug>`, so its URL stays the same from one checkpoint to the next
  and shows the newest. Every name derives from the slug alone (long slugs are
  shortened and given a hash to fit Cloudflare's 63-character limits), so a
  create after an expiry, a revival or a failed run finds and replaces what an
  earlier run left, and teardown deletes exactly what create made.
- **Fresh data every time.** Each create starts with a teardown. A preview is
  the checkpoint's code on migrations plus seed: the personas, Orbit Labs,
  their sample repositories and tracker fixtures, the same ones `agent seed`
  makes (`seedFixtures` in `tools/agent/seed.ts`). Nothing carries over from an
  earlier checkpoint, including the Preview's own Durable Objects. Email is
  off, so people sign in as a persona (`DEV_MODE`), as in development, once
  they are past the access gate (below).
- **Only in production CI.** Both jobs require `runner == "sandbox"`, so a
  local server's preview runs deploy nothing. Creates share the `preview`
  concurrency group: one at a time per repository, and a waiting create gives
  way to a newer one for the same timeline. The jobs use the deploy job's
  `CLOUDFLARE_API_TOKEN` (D1, R2, Artifacts and Workers edit), plus
  `GITMATRIX_ACCESS_TOKEN` for the preview's HTTP and Git requests. `gm` comes
  from the job owner's generic registry (the newest gm main published, checked
  against its SHA-256) unless `GITMATRIX_PREVIEW_GM` names one.
- **A failed create** records the checkpoint's preview as `failed`, and the
  job fails. Re-run it, or revive the checkpoint.

**Cloudflare Access, independent of preview lifetime.** The account's
`Gitmatrix previews` self-hosted Access application protects
`*-gitmatrix.fward.workers.dev`. This includes named timeline previews,
deployment URLs, and production-version preview URLs, but not
`timelinesapp.fward.dev`. The application and its policies are permanent:
**preview teardown must never delete them.** A Preview can disappear from
Cloudflare's management API while its old route still serves (CORE-216);
the hostname policy continues to require authentication even then.

The owner signs in using the existing **Cloudflare** identity provider,
with an Allow policy restricted to the owner's email. Agents use a separate
**Service Auth** policy restricted to the `gitmatrix-preview-agents` service
token, not a Bypass policy. The hostname application also supports WebSockets;
Cloudflare's Worker-level Access destinations currently do not.

**Agent credentials.** `GITMATRIX_ACCESS_TOKEN` is a JSON object containing
`cf-access-client-id` and `cf-access-client-secret`, kept in the ignored root
`.env` (mode `0600`) for local agents and the repository secret of the same
name for CI. `tools/preview/preview.ts` loads the local `.env` without
overriding the process environment. Do not copy it into source, images,
deployment URLs, browser bundles, or logs. Worktrees do not copy secrets.
The service token expires; rotate it in Access and update both stores before
expiry. Never remove the Access application to work around an expired token.

Send the two values as `CF-Access-Client-Id` and `CF-Access-Client-Secret`
headers. They authenticate to Access; `Authorization` remains available for
Timelines' own token. Example for an agent running Node from this checkout:

```sh
node --env-file=.env --input-type=module -e '
const token = JSON.parse(process.env.GITMATRIX_ACCESS_TOKEN);
const response = await fetch(process.argv[1], {
  headers: {
    "CF-Access-Client-Id": token["cf-access-client-id"],
    "CF-Access-Client-Secret": token["cf-access-client-secret"],
  },
  redirect: "error",
});
console.log(response.status);
' "$PREVIEW_URL"
```

For `gm`, export the token from `.env` and set `GITMATRIX_ACCESS_ORIGIN` to
the exact preview origin (no path) as well as `GM_SERVER`. The compiled CLI
uses the headers for API, streaming, package and Git requests only to that
origin, does not persist them, and refuses authenticated redirects. Preview
seeding supplies this scope automatically; calls that record deployments
on the production server receive neither Access credential variable.

**Origin verification.** New timeline previews require a correctly signed
`Cf-Access-Jwt-Assertion` for `PREVIEW_ACCESS_ISSUER` and
`PREVIEW_ACCESS_AUD` before serving any API, Git, WebSocket or static request.
`worker/preview-gate.ts` validates RS256 signatures against the team's public
keys, issuer, audience and expiry, failing closed on missing configuration,
invalid assertions or unavailable keys. Plain Timelines tokens, the former
preview-key header/cookie/query parameter, and forged identity headers do
not bypass it. Access-authenticated humans and service tokens can then use
the preview's seeded persona sign-in. Recorded URLs are ordinary links,
not bearer capabilities.

**Production prerequisites.** Before the first preview:

- The repository secret `CLOUDFLARE_API_TOKEN` can edit Workers (Worker
  Previews), D1, R2 (buckets and objects) and Artifacts (namespaces and their
  repositories), on the account the jobs name.
- The persistent Access application above is configured before previews
  are deployed. Its service-token policy accepts the repository's
  `GITMATRIX_ACCESS_TOKEN`; the preview CI job supplies the public
  `GITMATRIX_PREVIEW_ACCESS_ISSUER` and `GITMATRIX_PREVIEW_ACCESS_AUD`.
  Missing or invalid Access settings fail a create before existing preview
  resources are replaced.
- Worker Previews are served on the `gitmatrix` Worker's workers.dev subdomain
  (`<preview>-gitmatrix.<subdomain>.workers.dev`), so previews must be enabled
  there. `cloudflare.config.ts` does it: deployed, the Worker sets
  `previewUrls: true` and `workersDev: false`, and each production deploy
  sets the subdomain to `enabled: false`, `previews_enabled: true` (before
  previews: both false). Production itself still answers only on
  timelinesapp.fward.dev. Each production version is also reachable at its own
  version preview URL, `<version>-gitmatrix.<subdomain>.workers.dev`, with
  production's bindings, **behind the same persistent Access application**.
  Sign-in there does not share production cookies, since Better Auth trusts
  only `PUBLIC_URL`.
- The Worker's `previews_base_config` stays empty (it was null on
  2026-10-03): bindings set there would be inherited by every preview,
  production's included. Check with `cf workers get gitmatrix`.

**Preview mode.** Worker Previews isolate Durable Objects and nothing else:
Workflows, queues and their consumers, cron and every named resource are the
account's, shared with production. So when cf builds a Preview
(`isPreview` in `cloudflare.config.ts`), the config reads the resources
tools/preview made from `GITMATRIX_PREVIEW_*` (`vite/preview.ts`; a missing
one fails the build rather than falling back to production's) and:

| Production                                          | In a preview                                               |
| --------------------------------------------------- | ---------------------------------------------------------- |
| `DB`, `REGISTRY_DB`                                 | The timeline's own D1s                                     |
| `REGISTRY_BLOBS` (`gitmatrix-registry-blobs`)       | The timeline's own bucket                                  |
| `ARTIFACTS` (`gitmatrix`)                           | The timeline's own namespace                               |
| `CI_RUN`, `KNOWLEDGE_BUILD` and their Workflows     | Left out: Workflow names are the account's                 |
| `JOBS`, `REGISTRY_JOBS`, queue consumers, cron      | Left out: no mirror syncs, release notes or package sweeps |
| `EMAIL`                                             | Left out: persona sign-in instead                          |
| `AI`, `VECTORS`, `SEARCH`                           | Left out: no knowledge builds, wiki or assistant           |
| Secrets Store (auth secret, registry key)           | Text bindings from a secret generated for each create      |
| `timelinesapp.fward.dev`, `PUBLIC_URL`, `OWNER_ORG` | Left out: a preview answers at its own URL                 |
| CI Sandbox container                                | Left out: previews run no CI                               |
| `AUTH_FAILURES` namespace 4401                      | 4402                                                       |

Behind that, the build binds `PREVIEW_MODE=true`, and `worker/preview.ts`
guards each effect that would leave the preview, in case a binding ever
slipped back in: sign-in codes (`sendCode` refuses with "Previews send no
email"), mirroring (`queueMirror` skips and `syncMirror` refuses), enqueuing
(release notes, blob compaction, package sweeps), starting Workflows
(`startRun` records no run and answers "Previews don't run CI", a landing's
merge run refuses, so nothing lands in a preview; knowledge
builds and wiki pages are never requested), and the queue and cron handlers.
So in a preview, pushes and the UI work against the fixtures, but CI,
knowledge, release notes and mirrors don't run. `AGENT_ID` and `AGENT_SECRET`
(the Preview's name and the generated secret) guard the `/api/dev` routes
tools/preview seeds through, behind the access gate, as they do for agent
environments. A preview also binds its Access issuer/audience and `ASSETS`, and runs the
Worker first for every path (`runWorkerFirst: true`): the gate hands the app
its routes (`shared/worker-first.ts`, the same list production uses) and
`ASSETS` the rest.

## Packages

Every owner gets a package registry in each format the first time something is
published to it: npm, Docker/OCI, PyPI, Maven, Cargo, Go, Helm, APT, RPM,
Homebrew, generic files and releases. The engine (`registry/`,
`packages/formats`) comes from artifatrix and runs in this same Worker on its
own D1 database (`REGISTRY_DB`), R2 bucket (`REGISTRY_BLOBS`), Durable Objects
and queue. Accounts and permissions stay in gitmatrix's `DB`.

```
npm / docker / pip / cargo … ──▶ /npm/<owner>/… /v2/<owner>/<image>/… /pypi/<owner>/…  (registry/app.ts)
web app, gm                  ──▶ /api/packages/…   (registry/manage: console queries, housekeeping, feeds)
every publish                ──▶ publishes: version, repository, branch, commit, CI run, actor
```

- **CI publishes natively.** A job gets a credential (`gmj_…`) bound to the job
  and through it to its repository, commit and run. It ends with the job. Package
  tools come set up with it: `npm publish`, `docker push
$GITMATRIX_IMAGE_PREFIX/app:tag`, `twine upload`, `cargo publish --registry
gitmatrix`, `mvn deploy` (server id `gitmatrix`), `helm push`, Go modules
  through `GOPROXY`, and `gm pkg upload` for files (`worker/ci/registry.ts`).
- **Packages remember their sources.** The first CI publish of a package claims
  it for the job's repository. After that, only its sources' jobs and people
  who can write to a source may publish it. Owner admins grant more
  repositories, cross-owner ones included (`package_sources`). People without
  write access to a source get a 403 naming the sources.
- **Only the default branch moves `latest`.** A CI job building any other
  branch still publishes its versions, with the branch in their history, but
  they never become `latest`: not npm's dist-tag, an OCI `:latest` push (the
  image is stored, the tag stays), a release, Go's `@latest`, Helm's latest
  chart, Maven's `<latest>`/`<release>`, or the newest-publish fallback the
  console and `gm pkg download …/latest` use (`publishes.off_default_branch`).
  People publishing by hand move it as before.
- **Access follows the owner.**
  - The owner and org owners are admins. Org members get read, or write when
    the org gives members write. Collaborators who can write one of the
    owner's repositories get write.
  - Deleting versions takes admin, and CI jobs never delete.
  - Feeds are private by default.
  - Tokens: `gmx_` access tokens and SSH sessions, `gmj_` job tokens, Docker's
    token flow, and the web session.
- **The console.** `/:owner/-/packages/:format/:name` queries a package's
  publish history:
  - a query language (`source:web branch:main status:active since:7d
commit:4f2a run:42 by:jun tag:latest`, with `-` to exclude);
  - facet counts, and a publish-rate strip you brush to zoom in;
  - a virtualized table, built for tens of thousands of versions;
  - bulk delete, yank, deprecate and tag, for a selection or everything a
    query matches.
  - version links open paginated contents without losing the history query:
    a file browser with each entry's size and download, and per-file details
    (type, digest, checksums, metadata) on demand; generic files and npm
    archives browse by directory, and npm shows its actual `package.json`; OCI shows
    manifests, platform choices, config and layers. Other formats expose their
    recorded distribution files and package/version metadata.

  Repositories have a Packages tab, and CI runs list what they published.

- **Feeds and proxies.** `/:owner/-/feeds` sets visibility and retention (keep
  the newest N versions, or remove them after N days; tagged versions stay),
  and adds proxies (`<owner>.<name>`, credentials sealed with `REGISTRY_KEK`)
  and virtual feeds over several of them. An hourly cron sweeps retention, and
  a GC deletes unreferenced blobs.
- **npm login** works both ways: an access token as the password, or
  `--auth-type=web`, which approves the login at `/cli-auth/npm/:id`.

Deployed, package indexes embed https://timelinesapp.fward.dev (or
`GITMATRIX_PUBLIC_URL`), and the `REGISTRY_KEK` secret seals keys. Development uses a fixed public key. `pnpm run
db:migrate` applies both databases' migrations. Account slugs must not take
the registry's path prefixes (`v2`, `npm`, `pypi`, `maven`, `cargo`, `go`,
`helm`, `apt`, `rpm`, `brew`, `generic`, `releases`) or `-`.

### Version contents

`GET /api/packages/:owner/:format/:name/contents?version=…` returns a
`PackageContents` page. Encode the package name as one API path segment.
`offset` and `limit` paginate entries; `path` selects an npm archive directory
or a directory of distribution files, and `manifest` selects a manifest
reachable from the selected OCI version. Distribution file paths are browsed
relative to the directory every file in the version shares (a generic
version's own directory); directory entries come first, carry the total
`size` and `fileCount` of the files below them, and their `path` is the value
to pass back as `path`.
The web console keeps that selection in `version`, `path`, `contentOffset` and
`manifest` URL parameters.

Each downloadable entry has a version-scoped `downloadUrl`. Downloads use the
same feed/package authorization as listings and accept the web session, so
private packages never require a public or unscoped blob URL. Responses stream
as attachments; npm archive members support HEAD and byte ranges. Homebrew
versions resolve their recorded digest rather than the current formula file.

npm's first view streams and indexes the tarball once, serialized by its
repository Durable Object. A persistent D1 index and cached uncompressed tar in
R2 serve subsequent directory pages and member ranges without decompressing
again. Index writes are batched and directory entries deduplicated. Inspection
is bounded to a 1 GiB uncompressed archive, 100,000 archive entries and 16 MiB
of indexed names. Manifest and config JSON inspection is bounded to 4 MiB.
PyPI, Cargo, Maven, Helm, Go,
APT, RPM and Homebrew use existing catalog metadata instead of unpacking
distribution archives.

Apply registry migration `0005_package_contents.sql` before running the updated
Worker. Cache rows are tied to their source blobs for registry garbage collection.

### Historical artifact storage

Generic `<artifact>/<version>/<relative-file>` uploads and release assets are
compacted automatically in R2. A lineage is one repository plus artifact/file
path, or release project/asset name; platforms and filenames never share a
version sequence.

- The newest two distinct published versions stay raw for the normal streaming
  fast path. Identical upload retries do not advance the sequence. Hotness follows
  publication history, so deleting a recent version does not make old history hot.
- Older versions use independently compressed **4 MiB frames**. Each delta
  references one immutable full snapshot directly, never another delta. A new
  full snapshot occurs by the 32nd update after its anchor, or earlier when delta
  payloads exceed 50% of an independently compressed full version. Incompressible
  frames use raw bytes instead of growing compressed payloads.
- Downloads preserve original bytes, checksums, ETags, HEAD and Range semantics.
  Historical ranges reconstruct only intersecting frames; full downloads stream
  frame by frame. Original and full-base frames use opportunistic one-hour
  Cache API entries on reads. Staging verification does not prewarm new frames.
- Queue work checkpoints after at most two frames per delivery, verifies SHA-256,
  and publishes with a fenced locator compare-and-swap. Hourly sweeps recover
  interrupted jobs. Existing data is backfilled with persistent 200-row cursors;
  recent-version tracking holds only two rows per lineage. Hot-digest lookups start
  from that bounded table and resolve publication primary keys, even when millions
  of historical versions share the same digest.
- Logical version deletion and physical generation GC are separate. Dependent
  deltas and in-flight work pin full snapshots even after their original version
  is deleted. Superseded raw objects and unused staging candidates have a 24-hour
  grace; expired abandoned builds release their pins after seven days.

Apply registry migration `0004_artifact_storage.sql` before running the updated
Worker. Existing raw locators remain readable during backfill. Compaction changes
storage only: clients and artifact URLs do not change.

The [Git LFS and Xet investigation](../../ARTIFACT-STORAGE-RESEARCH.md) records
measured comparisons, shared-chunk storage tradeoffs, and the evidence needed
before revisiting this design.

## Assistant

Ask Timelines (CORE-25/26) is an assistant that reads and changes everything a
person can: code and its knowledge graph, issues, CI, packages, repository
settings. It chats in a column docked beside the page (rail button or ⌘J /
Ctrl+J), opens pages there for you, and answers `gm ask` in a terminal.

On non-phone screens, **Expand the assistant** opens a wide overlay over the
page, capped at 72rem. It keeps the normal desktop dock's reserved width, so the
page does not narrow further; collapse (or Escape while expanded) restores the
narrow panel without resetting the conversation or draft. Phones already use
the full screen. Short prompts use a compact one-row field; longer drafts grow
to a height cap and scroll inside the field. The composer can also scroll in a
short viewport, independently of the conversation.

- **Where it runs.** `worker/assistant/agent.ts`: an `AIChatAgent` (Cloudflare
  Agents SDK) Durable Object per conversation, named `<userId>:<chatId>` by
  `worker/api/assistant.ts` from the signed-in actor, so nobody reaches someone
  else's chat by naming it. Transcripts persist in the object's SQLite; the
  directory is `assistant_chats` in D1 (`GET /api/assistant/chats`).
- **Who it is.** It acts as an `assistant` agent identity accountable to the
  person (created on first use, `identity.ts`), with a short-lived token, and
  calls the real JSON API in-process (`internal.ts`, `worker/app.ts`), so every
  permission check and CORE-52 attribution applies ("assistant for Ann Lee").
  It can't touch tokens, agents, SSH keys, dev endpoints or the CI runner.
- **Every turn starts with clef.** One `@cf/cloudflare/clef-flash` call
  (`plan.ts`, ~0.3–0.5 s, 2.5 s deadline) answers a dozen typed questions about
  the message: intent, which tool groups it needs, difficulty, whether it
  aggregates many items, whether it's about the page on screen, and a status
  line. The answers pick the model (`@cf/zai-org/glm-5.3-flash`, or
  `@cf/zai-org/glm-5.3` for planning and hard turns) and reasoning effort, the
  tools the model sees, the skills preloaded into its instructions, and whether
  Code Mode is offered. Chat titles come from `@cf/ibm-granite/granite-4.0-h-micro`.
- **Between steps** (`progress.ts`, CORE-87): once tools return, the model reads
  their results with nothing streaming. On the web each new step (and a
  continuation after a page opens) sends a "Thinking" status at once, then the
  same granite model's few words about what's happening, written from the
  request and the last step's calls and results (Gateway component
  `assistant-status`, 4 s deadline). A line that arrives after the step's first
  output is dropped. The chat shows the status line whenever a turn is under way
  and no running tool or streaming text already shows it (`waiting.ts`).
- **Tools** (`tools.ts`): reads (`list_repos`, `list_files`, `read_file`,
  `list_commits`, `semantic_changes`, `search_code`, `read_wiki`, `find_issues`,
  `show_issue`, `ci_runs`, `ci_run`, `ci_logs`, `find_packages`, `api_get`) and
  writes (`create_issue`, `update_issue`, `comment_on_issue`, `link_issues`,
  `rerun_ci`, `cancel_ci`, `api_write`). On the web every write waits for an
  approval card whose wording comes from the request itself
  (`shared/assistant.ts` `describeWrite`), never the model's summary.
  Approval or refusal belongs to the specific tool call. The assistant is
  instructed to use its recorded result, not interpret item names as approval
  state. A new explicit request needs its own card; a declined call is not
  retried without another explicit request.
  `navigate` runs in the browser (the page beside the chat moves).
- **Code Mode.** When clef says a turn aggregates (count, compare, join across
  many issues or runs), the model gets `codemode`: it writes one script over the
  read tools that runs in a Dynamic Worker (`LOADER`, no network) instead of a
  dozen round trips. Writes never run there.
- **Skills** (`skills.ts`): SKILL.md-style built-ins (the API catalog, tracker,
  code, CI, packages, knowledge, navigation, repository, gm), a catalog line
  each, bodies preloaded for the turn's groups and otherwise one
  `activate_skill` away. Every tool-using turn preloads both the API catalog and
  browser navigation routes, including ordinary answers that cite pages without
  navigating. Release-note browser links use `/:owner/:repo/releases` (or
  `/tracker/:owner/releases` for the tracker feed); `/release-notes` is a JSON API
  suffix, not a page. Enabled personal skills and a repository's own
  `.agents/skills/*/SKILL.md` join the catalog when the chat includes that repository.
  Personal skills are available without repository context. Duplicate names resolve
  built-in first, then personal, then repository; built-in names are reserved.
  A skill may omit its description.
- **Personal skills** (CORE-103): **Profile → Manage assistant skills**, or
  **Settings → Personal → Assistant skills**, opens `/settings/skills`. Add or
  edit a name, optional description and Markdown instructions; disable a skill
  without deleting it, or confirm its removal. Skills belong to the signed-in
  person, not the selected settings owner or an agent capability profile.
  `GET/POST /api/account/skills` and `PUT/DELETE /api/account/skills/:id` manage
  `assistant_personal_skills` in D1. Names use lowercase letters, digits and
  hyphens (1–64 characters); descriptions allow 500 characters and instructions
  20,000. Human-only CRUD checks ownership on every request.
- **Slash commands.** Start a message with `/` to list authorized skills from
  `GET /api/assistant/skills?repo=owner/name`; filtering matches names and
  descriptions. Arrow keys move selection, Enter or Tab inserts the command
  without sending, and Escape dismisses the list. Send `/name` with optional
  arguments to preload its instructions for that turn, including approval and
  navigation continuations. A persisted **Used /name** receipt identifies the
  source; continuations retain that skill's identity and repository scope.
  Unknown or unavailable commands remain ordinary text. A later user message
  does not inherit the explicit invocation. The same leading-command syntax
  works in `gm ask`; skills never grant permissions or bypass write approvals.
- **The web** (`src/assistant/`): page context (repository, file and lines,
  issue, run) is included by default. **In context:** names the page that will
  accompany the next message; its remove button switches to **Not in context:**
  and excludes that page context until re-enabled with the plus button. Removing
  it does not erase context already sent with earlier messages. Receipts fold
  finished reads into one line; typing while an approval waits declines it and
  redirects; approved writes revalidate the page.
  Approvals and browser-tool results continue through the AI SDK's automatic
  submission predicates, with the existing assistant message and page context.
  The server stream receives `originalMessages` to retain that message's identity.
  Agents SDK server-driven continuation is disabled: AI SDK 7's reconnect path
  starts an empty response for settled tool inputs and cannot attach their results.
  The version-pinned `@cloudflare/ai-chat` patch treats those submitted assistant
  tails as continuations during tool repair, streaming, persistence and recovery;
  otherwise a later step overwrites the saved tool receipts with only new prose.
- **The CLI.** `POST /api/assistant/ask` streams newline-delimited events
  (`chat`, `plan`, `status`, `tool`, `text`, `done`, `error`); `gm ask` prints
  them, or returns one JSON object to agents. It lands in the same transcript,
  so a terminal conversation continues on the web.

`vp run agent test-ai` creates a personal skill through settings, reloads its
configuration, selects it with the keyboard, and proves that its private
instructions affect the real model response. It covers a real browser approval,
exactly-once issue creation and skill receipt, conversation-aware follow-up
without inherited invocation, retry after an injected stream failure, redirecting
a pending approval without executing it or generating a second reply, and reload.
It retains `assistant-approval.png` and `assistant-approval.zip` with the provider
evidence. Provider stream errors also pass through the assistant's error handler
so Worker logs include their message rather than only a provider stack trace.

Before a stream opens, `worker/assistant/capacity.ts` retries only the Workers AI
binding's `3021` inference-per-minute refusal: at most three retries after
5, 15 and 45 seconds, within a 90-second acquisition deadline. Stop cancels
the request or backoff. Once a stream opens, neither partial text nor tool
steps are replayed; the acquisition deadline no longer applies. Exhaustion
surfaces the original provider error. The SDK's existing transient-error
retries remain enabled.

## Mirrors

A repository can mirror its default branch and tags on to another git host
after every push: Settings → Mirror, `gm repo mirror set <url> --token-stdin`,
or `PUT /api/repos/:o/:n/mirror`. Timelines' own repository mirrors `main` to
GitHub this way, as a backup.

```
push ─▶ git proxy ─▶ queueMirror ─▶ JOBS queue (gitmatrix-jobs) ─▶ syncMirror
syncMirror: target refs (receive-pack advertisement) vs Artifacts' (ls-refs)
            ─▶ fetch exactly the missing objects from Artifacts (v2 fetch, haves = target tips)
            ─▶ stream that pack into the target's receive-pack ─▶ report-status
```

- **Default branch and tags only.** The default branch (the one HEAD names,
  falling back to `repos.default_branch`) and every tag are pushed. Other
  branches, timelines and experiments among them, stay on Timelines; pushing
  one doesn't reach the target. Branches already on the target are left as
  they are.
- **One way, and safe by default.** Mirrored refs are force-pushed, so rewinds
  follow; anything pushed to them on the target directly is overwritten. A
  mirrored ref that disappears here stays on the target unless pruning is on,
  so a backup never loses data on its own. Pruning only ever deletes the
  default branch or tags, never another branch.
- **Off the push path.** A push enqueues its repository; the consumer syncs
  it and retries failures with exponential backoff. A lease in `repo_mirrors`
  keeps one sync per repository at a time, and every sync converges on the
  current refs, so duplicate or late messages are harmless. Status, the last
  error and the last synced commit show in Settings and `gm repo mirror show`.
- **No git binary.** Workers can't run git, so `worker/mirror/` speaks the
  protocol: the pack streams from Artifacts to the target without buffering.
- The token (push access on the target) is sealed with `REGISTRY_KEK`.

Repository administrators can rename an existing GitHub backup with
`POST /api/repos/:o/:n/mirror/rename`, supplying `{name, expectedRepositoryId}`.
The numeric GitHub repository ID is required to prevent a stale/reused name
from targeting another repository. Only `https://github.com` targets are
accepted, and the existing mirror lease excludes simultaneous syncs.
Provider requests use Workers-supported manual redirect handling: every non-2xx
response is rejected, so credentials never follow a redirected destination.
An optional `token` grants administration access for that operation only;
it is neither persisted nor substituted for the sealed push credential.
The response retains the remote ID and updates the mirror's clone URL without
changing Git refs, sync history or source identity. Previews and non-admins
cannot invoke it. After an uncertain response, inspect the remote before
retrying; if GitHub renamed it but local configuration changed concurrently,
confirm its ID and use the existing mirror update endpoint to repair the URL.

## Data retention

Everything Timelines keeps costs storage, so data past its useful life can be
cleaned up by **retention categories** (PRD CORE-195). Every new category is
**disabled until an administrator enables it**: a fresh or upgraded deployment
deletes nothing it didn't delete before. There are two exceptions. Auth hygiene
always runs (CORE-249): expired sign-in state is worth nothing to keep.
**Timeline work Git repositories** (CORE-255) is enabled by default at 30 days
after landing and 90 days after abandonment; administrators can change both
durations or disable that policy. Preview teardown and Atlas snapshots retain
their always-active controls.

- **Categories** are defined once in `worker/retention/categories.ts`: id
  (kebab-case, stored, never renamed), scope (`account` or `site`), label,
  description, `never` (what it never deletes, in plain words) and thresholds
  (whole numbers with `min`, `max` and the PRD `default`). `control` is
  `policy` (configurable; `defaultEnabled` otherwise defaults false), `active`
  (always runs: preview teardown, whose
  numbers are the `account_settings` preview columns, the same ones
  `/settings/previews` changes, and Atlas snapshot retention, which an account
  can tighten within `ATLAS_RETENTION_BOUNDS` but never loosen) or `fixed`
  (always runs with its defaults, shown read-only; stored values are ignored:
  auth hygiene). Shapes for clients are in
  `shared/retention.ts`.
- **Policies** (`worker/retention/policies.ts`) store only what was changed:
  `retention_policies` per account, `retention_site_policies` for site
  categories and site-wide defaults of account categories. Each value
  resolves account, then site-wide default, then category default; `enabled`
  ends at `defaultEnabled ?? false`. Enabling a category without values
  applies its defaults. A stored value outside today's bounds is ignored.
  `enabledTargets(d1)` lists what scheduled runs cover: explicit account/site
  choices, inherited default-enabled policies and the site's fixed categories.
- **Audit:** every change records who changed which category from what to
  what in `retention_policy_changes`; the settings responses include the
  latest 20.

| Route                                          | Contract                                                                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/accounts/:slug/settings/retention`   | The account's categories with effective `enabled`, `values` and where each comes from (administrators; members 403, others 404)   |
| `PATCH /api/accounts/:slug/settings/retention` | `{categories: {<id>: {enabled?, thresholds?}}}`; `null` resets to inherit (org owners, the user, site admins; people, not agents) |
| `GET`, `PATCH /api/admin/retention`            | Site categories and site-wide defaults for account `policy` categories (site administrators; others 403)                          |

Unknown categories or thresholds, fractional or out-of-bounds values, site
categories at account level and read-only categories are rejected with 400,
and a rejected request stores nothing.

**Owned timeline work archives.** Landing/abandonment archives full WIP history
read-only. `timeline-work-sources` is enabled by default and independently selects
landed sources after `landedDays=30` and abandoned sources after
`abandonedDays=90`. The durable allocation inventory preserves the authoritative
end disposition and time; missing disposition never guesses the shorter window.
Tracker detail (`tracker-activity.endedTimelineDays`, default 180 when enabled),
published knowledge (`ended-timeline-data`) and previews have separate policies.
Expiring any of those does not authorize early Git deletion. Expiring Git leaves
retained published overlays/page sets readable under canonical permissions and
their exact source identity; their source-code links report expiry.
The repository metadata shell labels expired work and omits its clone action;
metadata reads do not substitute canonical refs or require the deleted Git store.

Before deletion, an admission fence rejects new consumers. Existing dependencies,
operations and actual consumers drain: CI cancellation is acknowledged by the
runner, managed preview teardown hands its exact source claim to the job before
its preview claim is released, and Workflow completion/termination is confirmed.
A `tornDownAt` scheduling marker alone does not acknowledge teardown completion;
unmanaged previews have no invented teardown job. Unknown Workflow state or a
failed stop keeps its claim. Completed output metadata does not pin Git forever.
Revision origins and integration receipts survive source Git expiry; canonical
repository deletion removes them with the rest of its provenance.
Usage meters this retained evidence to its canonical repository's owner.
Retained child dependencies protect required bases and exact ancestry evidence.
Once eligible sources enter purge, reads return `source_expired` (410), never
canonical fallback. Canonical deletion tombstones immediately block all work
routes, fence/drain operations and enumerate every reserved, ready, archived or
purging provider name for cleanup. The 24-hour orphan inventory recognizes owned
reservations before allocation begins.

### Categories, defaults and what they never delete

Generated from `worker/retention/categories.ts` (`docs.test.ts` fails when it
drifts; regenerate with `node apps/website/worker/retention/docs.ts`). Account
categories are set by the account's administrators (site administrators can
set a site-wide default for every account that hasn't chosen); site
categories cover data no account owns. Thresholds are whole numbers within the
bounds shown.

<!-- retention-categories:start (generated by worker/retention/docs.ts) -->

**Account scope**

- **CI logs** (`ci-logs`, account scope; off until enabled). Log text of CI jobs
  that finished more than the given days ago. Defaults when enabled: Days after
  the job finished: 30 (`days`, 1–3650). Never deletes: logs of pending, queued
  or running jobs; the run, job and step records themselves. Can select the same
  records as `ci-runs`: a dry run of both counts them under each, a run removes
  each once.
- **CI run history** (`ci-runs`, account scope; off until enabled). CI runs
  older than the given days, with their jobs, steps and logs. Defaults when
  enabled: Days after the run: 180 (`days`, 1–3650); Runs kept per ref: 20
  (`keepLatest`, 1–1000). Never deletes: the latest runs of each ref (the count
  below); running or queued runs, and runs with a job still running; runs a
  deployment, a landing or a package publish refers to. Can select the same
  records as `ci-logs`, `step-artifacts`: a dry run of both counts them under
  each, a run removes each once.
- **Expired preview deployment records** (`preview-records`, account scope; off
  until enabled). Records of preview deployments that expired more than the
  given days ago. Defaults when enabled: Days after expiry: 30 (`days`, 1–3650).
  Never deletes: live or sleeping deployments; production deployments; failed
  deployments.
- **Knowledge build history** (`knowledge-builds`, account scope; off until
  enabled). Knowledge graph build records and their change lists older than the
  given days. Defaults when enabled: Days after the build: 90 (`days`, 1–3650);
  Builds kept per repository: 20 (`keepLatest`, 1–1000). Never deletes: the
  current graph, wiki and Atlas snapshot; the latest builds (the count below).
- **Ended timeline overlays and page sets** (`ended-timeline-data`, account
  scope; off until enabled). Knowledge overlays, regroupings and page sets of
  timelines that ended more than the given days ago. Defaults when enabled: Days
  after the timeline ended: 90 (`days`, 1–3650). Never deletes: data of open
  timelines; anything on the main line.
- **Step instructions and steering** (`step-steering`, account scope; off until
  enabled). The text of steps' instructions and steering (what people told their
  agents), the given days after the step's commit, trimmed to a placeholder.
  Defaults when enabled: Days after the step's commit: 365 (`days`, 1–3650).
  Never deletes: a step's why, challenges, tests or coverage; the step itself
  and its commit.
- **Step run artifacts** (`step-artifacts`, account scope; off until enabled).
  What step runs produced (test summaries), the given days after the run.
  Defaults when enabled: Days after the step run: 90 (`days`, 1–3650). Never
  deletes: the step and its context; the CI run that produced them. Can select
  the same records as `ci-runs`: a dry run of both counts them under each, a run
  removes each once.
- **Live step feed** (`step-feed`, account scope; always on (it ran before
  retention policies existed)). Each timeline's live feed keeps a step's small
  record for the given days, enough for readers to catch up; the step itself
  stays. An account can keep less, never more. Defaults: Days a feed record is
  kept: 7 (`days`, 1–7). Never deletes: steps and their context.
- **Timeline work Git repositories** (`timeline-work-sources`, account scope; on
  by default). Read-only work Git repositories expire independently of Tracker
  details and published outputs, after landing or abandonment. Defaults: Days
  after landing: 30 (`landedDays`, 1–3650); Days after abandonment: 90
  (`abandonedDays`, 1–3650). Never deletes: canonical Git repositories and
  historical canonical sources; open timeline sources; sources required by live
  dependencies or unacknowledged consumers.
- **Push log** (`push-log`, account scope; off until enabled). Push log entries
  older than the given days, and records of changes on branches or bookmarks
  that no longer exist, last seen before then. Defaults when enabled: Days after
  the push: 365 (`days`, 1–3650). Never deletes: commits, refs or any git
  history; the latest push log entry of each branch or tag that exists; a
  change's record on a branch or tag that exists, or the push log entry it
  points to.
- **Unreachable git data** (`unreachable-git`, account scope; off until enabled;
  no cleanup, so it never deletes anything). Git objects no ref reaches any more
  (deleted branches, landed or abandoned timeline bookmarks). Artifacts can't
  prune them yet: they are measured in the usage report, never deleted. Defaults
  when enabled: Days after becoming unreachable: 30 (`days`, 1–3650). Never
  deletes: reachable history of any branch, tag or bookmark; anything, until
  Artifacts can prune.
- **Closed and canceled issues** (`closed-issues`, account scope; off until
  enabled). Issues closed or canceled more than the given days ago, with their
  comments, links and events. Defaults when enabled: Days after closing: 365
  (`days`, 1–3650). Never deletes: open issues; issue keys (never reused). Can
  select the same records as `tracker-activity`: a dry run of both counts them
  under each, a run removes each once.
- **Tracker activity logs and ended timelines** (`tracker-activity`, account
  scope; off until enabled). Tracker activity log entries older than the given
  days, and ended timelines. Defaults when enabled: Days to keep activity: 365
  (`eventDays`, 1–3650); Days after a timeline ended: 180 (`endedTimelineDays`,
  1–3650). Never deletes: activity that open issues and timelines still show;
  open timelines. Can select the same records as `closed-issues`: a dry run of
  both counts them under each, a run removes each once.
- **Assistant chats** (`assistant-chats`, account scope; off until enabled).
  Assistant chats nobody has used for the given days. Defaults when enabled:
  Days without activity: 90 (`days`, 1–3650); Chats kept per person (0 for no
  limit): 0 (`maxPerUser`, 0–10000). Never deletes: chats used within the period
  (unless over the per-person limit); a chat with a turn in progress; the newest
  chats up to the per-person limit.
- **Release notes** (`release-notes`, account scope; off until enabled). Release
  notes older than the given days, with their entries and mentions. Defaults
  when enabled: Days after publishing: 730 (`days`, 1–3650). Never deletes: each
  repository's latest daily and latest tagged release notes.
- **Timeline previews** (`previews`, account scope; always on (it ran before
  retention policies existed)). Live timeline previews are torn down after their
  timeline lands or is abandoned, or after a period without pushes. Their
  records stay (see expired preview deployment records). Defaults: Days after
  the timeline ended: 2 (`endedDays`, 0–365); Days without pushes: 7
  (`idleDays`, 1–365). Never deletes: previews with an expiry their recorder
  pinned; production deployments.
- **Atlas snapshots** (`atlas-snapshots`, account scope; always on (it ran
  before retention policies existed)). Each repository keeps its current Atlas
  snapshot and recent prior ones; older priors expire and their rows are
  reclaimed. An account can keep fewer, never more. Defaults: Prior snapshots
  kept: 20 (`maxPrior`, 0–20); Days a prior snapshot is kept: 7 (`priorDays`,
  1–7); Storage per repository: 2 GiB (`capGib`, 1–2 GiB). Never deletes: the
  current snapshot.

**Site scope**

- **Analysis caches** (`analysis-caches`, site scope; off until enabled). Cached
  file analyses and syntheses no repository's current build has used for the
  given days. Defaults when enabled: Days unused: 30 (`days`, 1–3650). Never
  deletes: entries any current build uses.
- **Registry proxy cache and derived objects** (`registry-proxy-cache`, site
  scope; off until enabled). Cached upstream package entries and derived files
  unused for the given days, so garbage collection can reclaim their blobs.
  Defaults when enabled: Days unused: 30 (`days`, 1–3650). Never deletes: blobs
  any version, tag or kept cache entry refers to; published packages; derived
  files in use, or written within the last day.
- **Registry audit log and publish records** (`registry-audit`, site scope; off
  until enabled). Registry audit entries and publish records older than the
  given days. Defaults when enabled: Days to keep: 365 (`days`, 1–3650). Never
  deletes: package versions and their contents; the newest publish record of
  each version still published; records of versions published from another
  branch (they keep them from becoming latest).
- **Auth hygiene** (`auth-hygiene`, site scope; always on, read-only). Expired
  sign-in sessions, sign-in and device codes, lockouts, SSH challenges and
  expired tokens, the given days after they ended. Defaults: Days after expiry:
  7 (`days`, 1–3650). Never deletes: live sessions, valid tokens and active
  lockouts.
- **AI spend records** (`ai-spend`, site scope; off until enabled). Per-call AI
  spend records older than the given days, rolled up to daily totals. Defaults
  when enabled: Days of per-call detail: 90 (`days`, 7–3650). Never deletes:
  totals budgets are enforced against; reservations still in flight.
- **Usage history** (`usage-history`, site scope; off until enabled). Daily
  usage figures older than the given days, rolled up to monthly figures; monthly
  figures older than the given months. Defaults when enabled: Days of daily
  figures: 90 (`days`, 32–3650); Months of monthly figures: 24 (`months`,
  1–120). Never deletes: the latest figures of each account and construct (the
  report's current usage); totals: a month's roll-up keeps the sum of its days.
- **AI usage records** (`ai-usage`, site scope; off until enabled). Daily AI
  call and token records older than the given days, rolled up to monthly totals
  per account, feature and model. Defaults when enabled: Days of daily records:
  90 (`days`, 7–3650). Never deletes: totals: a month's roll-up keeps the sum of
  its days; records of the current period.
- **Durable Object registry rows** (`durable-registry`, site scope; off until
  enabled). Rows of Durable Object instances purged more than the given days
  ago. Defaults when enabled: Days after the purge: 30 (`days`, 1–3650). Never
  deletes: rows of live instances, or of instances used again since their purge.

<!-- retention-categories:end -->

### Cleanup runs

The engine (CORE-198) runs categories' cleanups for one target (an account,
or the site), as a **dry run** (select only) or a **run** (select, then
remove), and records each run in `cleanup_runs` and `cleanup_run_categories`:
trigger (`schedule` or `manual` with its actor), target, categories with the
thresholds used, counts, estimated bytes, batches, errors and timings.

- **The contract** (`worker/retention/engine.ts`): a category implements
  `CategoryCleanup` with `select(ctx, cursor)` (at most `ctx.limit` items after
  a keyset cursor, with `next`, `count` and `bytes`) and `remove(ctx, items)`
  (deletes them, re-checking the policy in the same statement, and returns what
  it actually removed). `ctx` holds `env`, the `target`, the run's
  `thresholds` and `now`, fixed when the run is created, so a dry run and a run
  at the same moment select the same items. Register it in
  `worker/retention/cleanups/index.ts`; `preview-records.ts` is the reference
  to copy. A category without a cleanup can be configured but never runs.
- **Bounded, resumable, idempotent** (`worker/retention/runs.ts`): a worker
  claims a run with a lease token, does at most 50 batches or 20 seconds, saves
  each category's cursor and counts after every batch, and queues the rest on
  `gitmatrix-jobs` (`{type: "retention", runId}`). A batch interrupted before
  its progress was saved is selected again on resume; what it already removed
  is gone, so nothing is removed twice or missed (its removals may go
  uncounted). A failing category fails the run with its error; the others
  still run.
- **Scheduled runs:** the hourly cron (`retentionCron`) starts one run a day
  per target for its _enabled_ and fixed categories that have a cleanup, and
  restarts runs whose lease lapsed. With nothing enabled, its only run is the
  site's daily auth hygiene, which touches nothing else (gate 1,
  `worker/retention/engine.test.ts`).

| Route                                          | Contract                                                                                                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/accounts/:slug/retention/runs`      | `{dryRun, categories: [<id>], thresholds?: {<id>: {key: n}}}`: any account categories with a cleanup, enabled or not; 202 with the run (owners, site admins; people) |
| `GET /api/accounts/:slug/retention/runs[/:id]` | Runs newest first (`?before=<next>&limit=`), or one run with each category's thresholds, counts, bytes, estimated cost and errors (administrators)                   |
| `POST`, `GET /api/admin/retention/runs[/:id]`  | The same for site categories (site administrators)                                                                                                                   |

The settings responses show each category's `runnable` and `lastRun`.

Each run category carries `cost`: its bytes priced at the storage list price
of where that category's data lives (`CATEGORY_STORAGE` in
`worker/retention/costs.ts`: D1, Durable Object SQLite or R2), from the price
catalog in effect on the run's day. An estimate of the monthly storage a
cleanup frees, never a bill. Categories whose selections can hold the same
records declare `overlaps` (CI logs with CI run history, closed issues with
tracker activity): a dry run of both counts those records under each, so the
run's `notes` say so plainly and the UI shows its total as "up to"; a run
removes each record once. Preview them one at a time for exact figures.

### Data retention pages and `gm retention`

CORE-210. **Settings → Data retention** (`/settings/retention?owner=`, the
account's administrators) and **Settings → Site data retention**
(`/settings/site-retention`, site administrators; site categories and the
site-wide defaults for every account), in `src/routes/DataRetention.tsx` and
`src/components/RetentionView.tsx`:

- Every category with its scope, an on/off switch (off by default; `active`
  ones say "Always on"), its thresholds with their defaults and units (days,
  months, counts, GiB), what it never deletes and its last run. Timeline
  previews is the existing preview settings (`/settings/previews`), the same
  columns. Each category saves on its own; "Reset" removes the stored values.
- **Clean up now:** choose any categories that have a cleanup (on or off),
  **Preview cleanup** (a dry run: records, bytes and estimated monthly cost
  per category, plus the overlap note), then **Delete**, confirmed in a dialog;
  the cleanup uses exactly the preview's categories and thresholds. Both show
  live progress (the run is polled every second) and land in the **run
  history** (paged, newest first).
- The usage report's category links (`src/lib/retention-links.ts`) open a
  category's row with it chosen in "Clean up now"
  (`?cleanup=<id>#category-<id>`).

`gm retention show|set|run|runs` (apps/cli) is the same from the command line:
`gm retention set assistant-chats --enable --threshold days=60`, `gm
--dry-run retention run ci-logs ci-runs` (a preview), `gm retention run
ci-logs --yes` (deleting needs `--yes`), `--owner <slug>` or `--site`.
E2E `browser-data-retention-account-and-site`; dev `POST
/api/dev/retention-cron` runs the hourly cron and lists the scheduled runs'
categories.

### CI retention

`ci-logs` and `ci-runs` (CORE-200, `worker/retention/cleanups/ci-*.ts`):

- **`ci-logs`** deletes the `ci_logs` chunks of jobs that finished more than
  `days` ago (any end state; never pending, queued or running jobs) and stamps
  `ci_jobs.logs_removed_at`. Items are jobs; counts are chunks; bytes are the
  log text. The run API returns `logsRemovedAt` per job and the logs API
  `removedAt`; the run page and `gm runs show`/`gm runs logs` say "Logs
  removed by retention on <date>" instead of an empty log.
- **`ci-runs`** deletes runs older than `days` (finished, else created) with
  their jobs, steps and logs, always keeping the latest `keepLatest` runs of
  each ref, runs that are queued or running or have a job still running,
  landing runs, runs a deployment records or tore down, and runs a registry
  publish names as provenance. A removed run's number answers 404 "Run #n was
  removed by retention." when a later run exists.

### Knowledge retention

CORE-201, `worker/retention/cleanups/`:

- **`knowledge-builds`** deletes `kg_builds` older than `days` (finished, else
  started) with their `kg_changes`, keeping the latest `keepLatest` builds of
  each repository, running builds, the build behind the current graph and
  wiki (`kg_state.last_build_id`) and any build a kept Atlas snapshot's vector
  names. Graph, wiki and Atlas rows are never touched.
- **`ended-timeline-data`** empties overlays whose timeline ended more than
  `days` ago: their `kg_overlay_changes`, `atlas_timeline_regroupings`,
  `kg_page_sets` and `kg_page_set_pages`. The `kg_overlays` row stays with
  `removed_at`, which the overlay APIs return as `ended.removedAt`; the
  Knowledge tab's timeline panel says the overlay and wiki pages were removed
  by retention. A bookmark that comes back reopens the overlay and computes it
  afresh.
- **`analysis-caches`** (site) deletes `kg_blob_analysis` and `kg_synthesis`
  entries no build has used for `days`. Builds record use cheaply in
  `used_at` (`worker/knowledge/cache-use.ts`: at most once a day per entry;
  null counts as 2026-10-04, when the column came). Never: an analysis of a
  file in any current or running build (`kg_files`, current analyzer), or a
  synthesis used since the oldest current or running build started (less a
  day); with a graph whose build record is gone, no synthesis goes. A later
  build re-analyzes only what was removed.
- **`ai-spend`** (site; at least 7 days) rolls `atlas_spend` rows of whole
  UTC days older than `days` (not in-flight reservations) into
  `atlas_spend_daily` per account and day, deleting them in the same
  transaction. Daily budget checks add that table, so they answer exactly as
  before; a rolled-up run no longer shows its per-call detail.
- **`atlas-snapshots`** is `active`: `PATCH …/settings/retention` stores an
  account's `maxPrior` (0–20), `priorDays` (1–7) and `capGib` (1–2) in
  `retention_policies`, every Atlas retention pass reads them
  (`scopePolicy`), a shorter period brings stamped priors' expiry forward, and
  a change flags the account's scopes so the hourly sweep applies it.

### Auth hygiene and release notes

CORE-206, `worker/retention/cleanups/`:

- **`auth-hygiene`** (site, `fixed` since CORE-249: it always runs, daily, and
  its 7 days can't be changed) deletes sign-in state that ended more than
  `days` ago, by each table's own expiry: expired `auth_sessions`,
  `auth_verifications` (sign-in codes), `auth_device_codes`, `auth_lockouts`
  past their `until`, `ssh_challenges`, expired `access_tokens` (revoking a
  token already deletes it; a token without an expiry never expires) and
  `ci_job_tokens`. The cutoff is at least a day in the past, so live
  sessions, valid tokens and active lockouts never match.
- **`release-notes`** deletes release notes released more than `days` ago
  with their entries, and mentions of issues only they cited, never each
  repository's latest daily or latest tagged release. It records the cutoff
  in `release_note_state.retained_from`; the generator then never writes
  notes for an older release again (it would pay a model to rebuild them),
  while releases still stored stay current.

### Push log and unreachable git data

- **Push log** (`push-log`, CORE-202, `worker/retention/cleanups/push-log.ts`):
  `ref_updates` entries older than the policy's days (365 by default), and
  `change_refs` rows on refs that no longer exist (deleted branches, landed or
  abandoned timeline bookmarks) last seen before then. It never removes the
  latest entry of a branch or tag that exists, a change's record on one, or
  the entry such a record points to (`first_update_id`, which would cascade).
  Git itself is never touched.
- **Unreachable git data** (`unreachable-git`): a deleted branch, a force
  push or an ended timeline's bookmark leaves commits no ref reaches.
  Artifacts keeps them (it still serves an unreachable commit by id) and has
  no gc, prune, repack or size API, so this category has no cleanup: it can
  be configured but never deletes anything. The usage collection measures it
  instead (`worker/git/unreachable.ts`): per repository whose push log saw a
  ref leave a commit, one protocol v2 fetch wanting those commits (at most 256,
  newest first) with every ref tip as a `have` returns exactly the objects only
  they reach; the pack is counted as it streams (at most 512 MiB or 15 s, else
  a lower bound) into `artifacts/repositories` `unreachable_bytes` and
  `unreachable_objects`, both estimated. Commits that left a ref before the
  push log began (2026-10-03), or whose entries the push log cleanup removed,
  aren't seen.

### Retention safety

CORE-211 proves the PRD's gates for every category, in three places:

- **`worker/retention/safety.test.ts`** (runs in `vp test`, so in
  `vp run ready`), on one rich deployment (`worker/retention/testing/rich.ts`:
  both D1 databases, the registry's R2 bucket, an account's real Tracker
  Durable Object and assistant chats), with a fixture for every category that
  has a cleanup (a cleanup registered without one fails the suite):
  - **Gate 1:** policies stored but none enabled; every hourly retention job
    (`retentionCron`, `sweepDurableInstances`, `resumeDeletions`,
    `collectUsage`) over 26 simulated hours deletes or changes no D1 row (only
    bookkeeping rows in `do_instances` and `job_cursors` may change), no
    Durable Object storage, R2 object or chat, and starts no run.
  - **Gate 2,** per category, one per run at its defaults: the dry run
    changes nothing and lists exactly what the run removes (items, counts,
    bytes); the run works in batches of at most the limit across resumed
    calls, touches only its own stores, keeps every "never" case and
    everything inside its thresholds, records an exact audit row, and a
    second run removes nothing. One known difference: a chat with a turn in
    progress is listed by a dry run but kept by the run (only its object
    knows a turn is running); the next run lists it again.
  - **Gate 3:** a Tracker holding data purges to nothing through the
    registry; `worker/durable/purge.test.ts` (every class in
    `DURABLE_CLASSES` has a purge case; the Assistant's is the E2E below) and
    `conformance.test.ts` cover the rest.
  - **Authorization:** every retention, usage and price route for anonymous
    callers, outsiders, members, an administrator's agent, administrators and
    site administrators; refused writes store nothing.
- **E2E in `vp run ready`** (`tools/agent/e2e.ts`): the categories in the real
  runtime (`ci-retention-removes-logs-and-runs`,
  `tracker-retention-removes-closed-issues-and-replicas-converge`,
  `assistant-chats-expire`, `auth-hygiene-keeps-sign-in-and-tokens-working`,
  `push-log-retention-and-unreachable-git`), gate 3 for every class in
  workerd (`durable-objects-register-and-purge`), gate 4 with local stores
  (`repository-deletion-purges-everything-and-resumes`), the pages and
  authorization (`browser-data-retention-account-and-site`), and
  **concurrency** (`retention-concurrent-with-pushes-builds-and-chats`: real
  cleanups dated a year ahead run back to back while pushes land on two
  branches, a CI build runs and chats are made; every push, the build and
  every new chat survive, each ref keeps its latest push log entry, and a
  final dry run finds nothing left).
- **Real providers** (`vp run agent test-ai`, never automatic): repository
  deletion against owned Vectorize, AI Search and Artifacts resources (gate 4
  end to end). Run it for changes to repository deletion, knowledge storage
  or the purge of provider resources, and record its evidence.

### Usage and costs

**Settings → Usage & costs** (`/settings/usage?owner=<slug>`, an account's
administrators: org owners, the user themselves, site administrators) and
**Settings → Site usage & costs** (`/settings/site-usage`, site
administrators) price the daily `usage_snapshots` (CORE-207, `worker/usage/`)
with the price catalog (CORE-208, `cloudflare_prices`). The report
(`worker/usage/report.ts`, shapes in `shared/usage.ts`):

- **Storage** is the latest day whose collection finished for the account (or
  the whole site; the `usage:collect` cursor says which), priced as if it
  stayed that size for a month. **Activity** (Workers AI tokens) is the 30 days
  before that day; with fewer days measured it's extrapolated to 30 and marked
  estimated.
- **Cost = quantity in the price's unit × unit price ÷ unit quantity**, with
  the catalog version in effect that day: bytes ÷ 10^9 → GB-months (D1,
  Durable Objects SQLite, R2 Standard, Artifacts, AI Search), stored vector
  dimensions, model input/output tokens (a model that reports only totals is
  priced as input and marked estimated; a chat model's total, which counts
  its input and output too, isn't priced again). Included allowances are account-wide
  on the Cloudflare account, so nothing is subtracted (gross list price). A
  price whose billing hasn't started (Artifacts before 2026-10-14, AI Search
  before 2026-11-01) is shown with its start date and left out of totals.
- **Classifier price versions (CORE-329):** migration
  `20261011052218_classifier_prices.sql` adds Clef Flash at **$0.038/M input
  tokens** and Clef Omni at **$0.150/M input tokens**, effective **2026-10-11
  UTC**, the observation day (not an inferred provider change date). Both
  have free output. The [Workers AI pricing page](https://developers.cloudflare.com/workers-ai/platform/pricing/)
  was last updated 2026-10-09; its fetched snapshot is
  `worker/usage/fixtures/workers_ai_2026-10-11.txt`. Flash's original
  **$0.090/M** version and the original `workers_ai.txt` remain intact for
  historical billing. Other products retain their original provenance.
  `seedPrice` selects the latest seeded version for budgets; reports select
  the version on the usage day. The default classifier remains Clef.
- **CI sandboxes** are priced at Cloudflare's Containers rates (catalog
  product `containers`: `vcpu` per vCPU-second, `memory` per GiB-second,
  `disk` per GB-second, from
  `https://developers.cloudflare.com/containers/platform/pricing/`, page dated
  2026-08-28, seeded 2026-10-04 by migration
  `20261004071417_containers_prices.sql` and refreshed like every other page).
  The collection turns each sandbox job's wall time (start to finish) into
  `vcpu_seconds`, `memory_gib_seconds` and `disk_gb_seconds` by its instance
  type (`worker/usage/containers.ts`, the sizes Cloudflare publishes; a job
  without one is `standard-1`), alongside `jobs` and `minutes`. All three are
  estimated: the container runs slightly longer than the job's steps, and
  Cloudflare bills memory and disk on the provisioned size but vCPU only on
  active use, so the vCPU cost is an upper bound. Days collected before this
  (only `minutes`) stay unpriced.
- Every line carries its figures with `estimated` and `method`, its costs
  with the price and source page, and the retention categories that clean it
  up (account pages list account categories only). `RETENTION_PAGES` in
  `src/lib/retention-links.ts` turns those into links once the Data retention
  pages exist (CORE-210).
- The site report sums every account and the site's own figures (account
  `''`), counting registry blobs once (`registry_blobs_all`), and totals each
  account (at most 200, highest first).
- The trend is each of the last 30 days: that day's storage at a thirtieth of
  its monthly cost plus that day's activity.
- **By person, agent and timeline** (CORE-222, `worker/usage/attribution.ts`):
  the window's CI and Workers AI, priced like the rest of the report from
  what was recorded (not extrapolated; the page says so when the report is).
  CI goes by each sandbox job's run (`ci_runs.actor_id`, `agent_id`; its
  timeline from a preview's `timeline_slug`, its work source, or the landing
  it runs for, keyed by owner and slug). Workers AI goes by
  `ai_usage.actor_id` and `agent_id`, which `aiWork` records when the work
  knows who asked (the assistant, avatars, knowledge search; `gm ask` from an
  agent is the agent's). `ai_usage.timeline` exists for work that knows its
  timeline, but nothing records one yet, so timelines show CI only. An agent's
  work is listed under the agent with its accountable person, not added to
  the person's; timelines are a second view of the same costs. In an
  account's report, people and agents from outside the account (someone
  searching a public repository, a site administrator) are one "outside this
  account" row; the site's report names everyone. What no one caused is
  listed with its reason: storage, CI Gitmatrix started itself, Knowledge and
  wiki builds (they batch several people's pushes), release notes and
  merge-queue classification, and AI recorded before attribution or outside
  anyone's request. Attribution is daily: monthly rollups keep account,
  feature and model only, so older months show no breakdown.

| Route                           | Contract                                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/accounts/:slug/usage` | `UsageReport`; `?format=csv` for one row per figure with its price and monthly cost (administrators; members 403, others 404) |
| `GET /api/admin/usage`          | The site's `UsageReport` with `accounts`; `?format=csv` (site administrators)                                                 |

### Repository deletion

Deleting a repository (CORE-199, `worker/retention/repo-deletion.ts`) removes
everything it owned, everywhere, in two steps:

- **Tombstone.** `DELETE /api/repos/:owner/:name` sets `repos.deleted_at` and
  records the deletion in `repo_deletions`, in one transaction. From then on
  the repository is missing to every reader (`selectRepos`/`findRepo` and the
  other repository lookups skip it; pass `{deleting: true}` only where a
  deletion's own preview teardown needs it: the local runner claiming,
  checking out and reporting its job). The name stays taken (409 "being
  deleted") until the purge ends.
- **Purge.** The `RepoPurge` Workflow (`repo-purge.ts`) runs the phases in
  order, each step bounded and idempotent, recording the phase and its counts
  in `repo_deletions.progress`: `stop` (purge the KnowledgeCoordinator,
  terminate its builds, cancel CI runs), `previews` (expire live timeline
  previews and start the project's own teardown run per timeline, as the
  preview sweep does, then wait for them up to 2 hours), `vectors` (Vectorize
  ids from `kg_nodes`, then the `repo` metadata filter until nothing is
  found), `search` (AI Search items from `kg_search_items`, then by metadata and
  key prefix), `durable` (every registered instance it owns), `links`
  (earlier days' `atlas_spend` go, today's stay detached for the account's
  ceiling; registry `package_sources` go, `publishes` keep the package history
  without the repository), `artifacts`, and `rows` (large children in batches,
  then the repository row and its cascade). The hourly cron
  (`resumeDeletions`) starts a new instance for a deletion whose Workflow
  died; it resumes from the recorded phase. A timeline preview has no
  Workflow: the purge runs on the request's `waitUntil`.
- **Orphans** (`repo-orphans.ts`): what deletions before this left behind is
  swept once by production's cron: AI Search items and `atlas_spend`,
  `do_instances` and registry links naming unknown repository ids become
  `repo_deletions` rows (`source = 'orphan-sweep'`) purged through the phases
  that need no row; Artifacts repositories no row names and older than a day
  are deleted. Vectorize can't be listed from a Worker, so vectors only a
  deleted repository's id names are found through the metadata filter of ids
  found elsewhere; the sweep records the index's vector count beside the
  count live graphs account for.

`GET /api/dev/repo-inventory?repo=<id|owner/name>` lists what a repository
holds in every store (D1 tables, registry, Durable Objects, Artifacts,
Vectorize, AI Search, previews) and its deletion's progress;
`POST /api/dev/repo-purge {repo, action: "terminate"|"resume"}` kills or
resumes only the named repository's purge; resume leaves live Workflow instances
alone. The hourly cron still considers all unfinished deletions.
`POST /api/dev/repo-orphans {action: "plant"|"sweep"}` plants and sweeps orphans
(isolated agent environments only). E2E:
`repository-deletion-purges-everything-and-resumes` (ready: Artifacts, a live
preview's teardown, a killed purge resumed, the name reused) and the
`repository-deletion` stage of `agent test-ai` (Vectorize, AI Search).

## Layout

- `worker/git/http.ts`: smart HTTP proxy (info/refs, upload-pack, receive-pack);
  a landing merge job's credential pushes only to its landing branch
  (`worker/git/receive-pack.ts` reads the commands)
- `worker/ssh.ts`, `worker/api/ssh.ts`: SSH public keys, SSHSIG verification, key sign-in
- `worker/git/pktline.ts`: pkt-line codec and the `ls-refs` client used to list branches
- `worker/api/*`: JSON API (`dev.ts` mints persona tokens and seeds sample data)
- `worker/knowledge/*`: knowledge graph pipeline, coordinator, workflow, API
- `worker/ci/*`: CI config parser, push trigger, run Workflow, sandbox Durable Object, API
  (`registry.ts`: job credentials and package-tool setup)
- `registry/`: package registries (formats, catalog, ACL, provenance, Durable Objects,
  jobs); `registry/manage/`: the packages API behind the console, feeds and gm
- `packages/formats` (repo root): IO-free protocol libraries for every package format
- `worker/retention/*`, `shared/retention.ts`: retention categories, policies and cleanup
- `worker/tracker/*`: account-level authority, transactional graph store and sync API
- `worker/search/*`, `shared/search.ts`: global search providers, ranking and `/api/search`
- `shared/tracker.ts`: shared tracker entities, mutations and readiness semantics
- `src/routes/tracker/*`: issue workbench, graph and tracker administration
- `scripts/git-login.ts`: points the git CLI at Gitmatrix as a persona
- `src/`: React Router (data mode), Base UI and Tailwind, styled with MatrixKit Neo
  (`src/styles/tokens.css` is generated from the design system's tokens;
  `matrixkit.css` is its component stylesheet, vendored as is)
  `AppShell.tsx` anchors desktop navigation to both viewport edges and reserves
  its width using `--size-rail`; phones retain a sticky top bar without that
  gutter. Keeping the desktop rail out of sticky page flow prevents bottom gaps
  when document heights land on fractional CSS pixels.

## Known gaps

- No branch protection, events, or webhooks yet. For canonical pushes, `pushed_at`
  is set when receive-pack returns 200, even if Git rejected a ref inside the response.
- READMEs render Markdown without raw HTML, so `<details>` and `<br>` show as text.
- In testing, imports brought over the default branch only, without tags.
- Owner slugs `signin`, `new`, `settings`, `tracker`, `api`, `cli-auth`, `-` and the registry prefixes
  collide with routes and should be reserved once accounts can be created.
- Packages: the tag facet lives in the header's tag plates rather than the side
  column; retention can't yet keep a branch's builds longer than another's.
