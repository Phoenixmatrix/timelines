# Timelines: parallel lines of agent work (CORE-50)

Date: 2026-10-02.

Status: research recorded for CORE-50 ("Not ready for work yet, need to think
this through"). Nothing is built or approved by this document. CORE-42 (timeline
visualization in the tracker) and CORE-51 (discussions) are blocked on it.

## Conclusion

- **A timeline is one object that every part of Gitmatrix projects. It is
  neither a branch nor a pull request.**
  - It has a name, a parent (main or another timeline), a fork point, a policy
    (land automatically, land after approval, or experimental and never land),
    a status and an expiry.
  - Under it sit a bookmark in each repository it touches, tracker events tagged
    with it, CI runs and deployments of its commits, prerelease packages, and a
    knowledge overlay.
  - Selecting it in the web app filters all of these to "main plus this
    timeline".
- **Trunk stays the truth.** A timeline is a hypothesis until it _lands_: rebase
  onto current trunk, run the gates on the result, fast-forward. This is the
  merge queue [CI-RUNS-RESEARCH.md](CI-RUNS-RESEARCH.md) deferred because it
  changes every agent's loop. Timelines are where it belongs, and plain
  `gm push` to main can stay as it is.
- **Identity is global and state belongs to a timeline.**
  - Global: issue keys, people, agents, leases and secret definitions.
  - Per timeline: issue status, comments, checkpoints, runs, deployments,
    packages and knowledge. An issue finished inside a timeline is "done in T"
    until T lands.
  - Leases stay held while their work sits on an unlanded timeline, and are
    released when it lands or is pruned (Unity's Smart Locks do the same).
- **Build on stable change ids and landing records, not git topology.**
  - gm already writes jj's `change-id` commit header, but the server never reads
    it.
  - Reading it, and recording each landing (timeline, change ids, trunk commit
    range, approval), gives the visualization, "why did this change" and
    pruning after landing a basis that survives rebases.
  - Trunk can stay linear.
- **Cloudflare can now preview code per timeline, but not state.**
  - Worker Previews (GA 2026-09-22; `cf previews deploy <name>`) give each
    branch its own URL and fresh Durable Object storage.
  - They share D1, R2, Vectorize and AI Search with production, run
    _production_ Workflows, and neither consume Queues nor fire cron.
  - So a timeline preview needs:
    - its own D1, built from migrations plus a seed;
    - a side-effect profile (no email, no mirror, no stable publishes);
    - secrets limited to preview environments.
  - "View the app at any point" is cheap for code and expensive for data. The UI
    must show which kind each preview is.
- **"Prune" means two different things.**
  - Before landing it is _abandoning_: cheap, and history is kept.
  - After landing it is a planned compensating change through the same queue:
    - revert the landing's change ids;
    - list what depends on them;
    - run recorded compensating migrations;
    - deprecate the packages it published;
    - list what cannot be undone (sent email, the GitHub mirror, downloads).
  - Main's history is never rewritten.
- **The real risks are review load, cost and semantic conflicts, not git
  mechanics.**
  - Agent platforms report review as the bottleneck.
  - Previews per timeline cost money and hit account caps (500 Workers, 100 AI
    Search namespaces).
  - Two timelines that each pass CI can still break together. Only testing the
    combined result catches that.
- **Start with a thin slice, dogfooded on this repository:** the timeline
  object, `gm timeline`, a bookmark, CI context and tracker tags per timeline,
  and a landing queue with an approval gate. Previews, the visualization,
  knowledge overlays and pruning after landing follow, each useful on its own.

## What CORE-50 asks for

| CORE-50 asks                                                              | What it implies                                                                | Hardest part                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------- |
| Agents work in a separate thread, "likely one or more branches"           | A server-side object above branches, possibly spanning repos                   | Landing atomically across repos               |
| Artifacts are deployed but kept apart; selecting a timeline shows only it | Every subsystem filters by timeline; an app-wide switcher                      | Scoping consistently across eight subsystems  |
| Two agents can't lease the same issue, even in different timelines        | Leases stay global and are held until the work lands                           | Release-on-land semantics; best-of-N attempts |
| Human intervention before main, with independent work until then          | A policy per timeline; gates as tracker requests                               | Review becomes the bottleneck                 |
| Issues may be specific to a timeline                                      | Issues and status scoped to a timeline                                         | What happens to them on landing or pruning    |
| View the app in preview at any point, especially at the gate              | Deployment and checkpoint records; data per timeline                           | State at old checkpoints                      |
| Some timelines merge automatically                                        | An automatic policy through a merge queue                                      | Semantic conflicts                            |
| A git-history-like view of forks, merges and splits                       | Landing records; lanes over time (CORE-42)                                     | Hundreds of short-lived agent timelines       |
| Prune, even removing the impact on main afterwards                        | Compensating changes, dependent changes, a ledger of side effects              | Irreversible effects                          |
| Experimental timelines never merge but persist                            | A kind of timeline without landing rights                                      | Isolation from production; rot                |
| Merged timelines stay visible                                             | Landing records and archived refs                                              | Retention                                     |
| Knowledge explains "why" to agents and humans                             | A provenance chain: change, timeline, issue, checkpoints, discussion, approval | Links that survive rebase and squash          |

## What "timeline" could mean

There are three readings, from thinnest to thickest:

1. **A branch with a lifecycle:** a named bookmark plus CI, a preview and a
   policy. This is roughly a pull request without review threads, and what
   container-use, GitButler and most agent platforms provide.
2. **An agent work thread:** the unit of parallel agent work, with checkpoints
   and a status board, that produces a branch. Examples are Claude Code
   Projects' threads, Replit tasks and Copilot sessions.
3. **An alternate world:** code, issues, deployments, packages, knowledge and
   release notes, all as of that timeline. CORE-50's "select a timeline and
   everything shows what's part of that timeline" is this reading. The nearest
   precedents are Upsun (every branch is a full environment with cloned data)
   and Figma branches.

The recommendation is to present the third and implement it as the first, one
subsystem at a time. One account-level `timelines` record holds the timeline.
Each subsystem stores a timeline id next to its own data and filters by it, and
none of them forks its storage.

**Naming.** CORE-42 uses "timeline" for a time axis (a video editor's or Chrome
DevTools' timeline). The two fit together: a video editor's timeline has
parallel _tracks_. CORE-42's view can be the timeline view in which each CORE-50
timeline is a track running next to main. CORE-50's own words (main timeline,
alternate timelines, prune) work, and fork, land and prune read well as verbs.

### A timeline, concretely

- **Identity:** a stable `id` that is never reused, plus `slug` and `name`. The
  owner is the tracker's account, where issues and leases already live.
- **`kind`:** `landing` or `experimental`. Experimental timelines can't land,
  can't receive production secrets and can't publish stable packages. A person
  can promote one to `landing`, after which it must pass the gates like any
  other.
- **`policy`:** `auto` lands when the gates pass. `approval` lands after a person
  approves a checkpoint. Gate rules say who may approve, and an agent never
  approves its own timeline.
- **Lineage:** a `parent` (main or another timeline) and a fork point, which is
  a trunk commit per repository plus a tracker cursor.
- **Per repository:** a bookmark `timeline/<slug>`.
- **`status`:**
  - landing timelines: `active`, `waiting` (at a gate), `landing` (queued),
    `landed`, `abandoned`, `pruned`;
  - experimental timelines: `active`, `paused`, `archived`.
- **People and work:** the accountable person, the agents that worked in it, and
  the issues it works on.
- **Checkpoints,** which are immutable. Each holds:
  - the commit per repository and the trunk commit it was based on;
  - change ids and the CI run;
  - deployment ids and the data snapshot, if there is one;
  - an agent-written summary and approvals.
- **Expiry:** previews and idle experiments expire. The metadata never does.

## What Gitmatrix has today

| Area                                                     | Today                                                                                                                                                        | Gap for timelines                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| gm (`apps/cli/src/repo/mod.rs`, `commands/network.rs`)   | jj-style changes with a `change-id` header on every commit; a local op log; trunk immutable, other bookmarks rewritable; `gm push -b` pushes any bookmark    | The server never reads change ids; gm has no notion of a timeline                                                      |
| Git server (`worker/git/http.ts`, `worker/artifacts.ts`) | Every branch is stored and browsable; a ref picker on tree, blob and commits                                                                                 | No per-ref metadata, push log, compare view or branch protection                                                       |
| Tracker (`worker/tracker/store.ts`, `shared/tracker.ts`) | One Durable Object per account; an event log with a cursor; one claim per issue; subtree leases, delegation and handoff; approval requests that park a lease | No git or timeline fields; a request references only an issue; a lease ends at complete or release                     |
| CI (`worker/ci`, `.gitmatrix/ci.yml`)                    | Runs on every branch; `if:` over branch, trigger, commit and runner; concurrency groups; coalescing                                                          | No environments, deployments or preview URLs; any branch's job can request any repo secret (`worker/ci/jobs.ts:42-51`) |
| Deploy (`tools/agent/deploy.ts`)                         | One production Worker, deployed only from main                                                                                                               | Nothing parameterizes a second deployed instance                                                                       |
| Registry (`registry/`)                                   | Provenance records the ref, run and commit; branch filters                                                                                                   | An npm publish with no dist-tags moves `latest`, from any branch (`registry/formats/npm/local.ts:361`)                 |
| Knowledge (`worker/knowledge`)                           | Default branch HEAD only; analyses cached by blob; a change feed per build; a per-ref semantic feed                                                          | One graph per repository; no overlays                                                                                  |
| Release notes (`worker/release-notes`)                   | Default branch and tags                                                                                                                                      | No per-timeline drafts                                                                                                 |
| Identity (CORE-52)                                       | Agents act as themselves, accountable to a person; CI runs record the agent                                                                                  | Already in place                                                                                                       |
| Isolated environments (`tools/agent/environment.ts`)     | Isolated local instances using remote Artifacts, Vectorize and AI Search; 24-hour expiry; four per user                                                      | Local only, not previews                                                                                               |

Today's parallel work already shows problems that timelines would make routine:

- **Migration numbers collided.** Two lines of work each added a `0016_`
  migration (`0016_agent_capabilities.sql` and
  `0016_knowledge_graph_version.sql`). D1 applies both because it tracks file
  names, but the order between them is an accident. Parallel timelines need
  migration names that can't collide (timestamps) or a check when landing.
- **Deploys queue behind each other.** Newer runs superseded deploys (#43 by
  #44, #54 by #56).
- **Indexes lag.** An AI test failed because AI Search had not yet indexed one
  file (CORE-58). Per-timeline indexes will be eventually consistent too.
- **Knowledge cost is now small per push.** Since CORE-17, an incremental
  knowledge build for a small push costs about 7 concept questions and 10
  minutes. The first build took 43 minutes. Per-timeline knowledge overlays
  are affordable; per-timeline full rebuilds are not.

## What others have done

### Branches with types and rules

- **Perforce Streams** is the best model for timeline kinds and policies
  ([p4-types], [p4-paths]):
  - typed streams (mainline, development, release, task, virtual);
  - flow rules: merge down from the more stable parent, and copy up only once
    that merge is clean;
  - a child is never more permissive than its parent;
  - a virtual stream is a filtered view of another stream.
- **Jujutsu** ([jj-glossary], [jj-conflicts], [jj-divergence]):
  - Change ids survive rewrites, and the op log makes every operation undoable.
  - Conflicts are stored in commits, so a rebase never stops.
  - Since jj 0.30 the `change-id` header travels with `git push`, and Gerrit
    adopted it as its Change-Id ([gerrit-jj]).
  - The pitfall: two writers amending one change produce _divergent_ changes.
    Concurrent agents will hit this.
- **GitButler and container-use** map each agent session to a branch, or to a
  container plus a branch, and merge them back ([gitbutler], [container-use]).
  This works only while the edits don't overlap.
- **Fossil** keeps a single timeline of check-ins, tickets, wiki and forum posts
  ([fossil-timeline]). It is the closest precedent for keeping the "why" next to
  the code. Closed branches stay visible.
- **Trunk-based development** keeps branches under two days old, and calls a
  branch that will never be merged directly an "experimental branch"
  ([tbd], [fowler-branching]).

### Previews and data

- **Cloudflare Worker Previews**, GA 2026-09-22 ([cf-previews],
  [cf-previews-resources], [cf-previews-config]). Our `cf` already has
  `cf previews deploy [preview-name]`, which defaults to the git branch.
  - **What you get:** one Preview per branch under the same Worker, with a URL
    that follows the latest deploy plus immutable per-deploy URLs, Access
    protection, and its own logs.
  - **Isolated:** each Preview gets a fresh Durable Object namespace that
    survives redeploys and is deleted with the Preview.
  - **Shared with production unless bound separately:** D1, KV, R2, Vectorize
    and queue producers.
  - **Not isolated at all:**
    - Workflows run in production.
    - Queues are not consumed.
    - Cron doesn't fire.
    - Service bindings call production.
  - **Limits:** 500 Previews per Worker on the paid plan; at the cap, the oldest
    is deleted, its Durable Object state included.
  - **Older "version URLs":** they use production bindings, and Workers that
    define Durable Objects (like Gitmatrix) don't get them ([cf-version-urls]).
- **Upsun (formerly Platform.sh)** is the closest model to timelines
  ([upsun-envs], [upsun-clone]):
  - **Branching:** every branch is an environment in a parent/child tree.
    Branching copies code and all service data with copy-on-write in about a
    minute; clone chains are capped at 16 levels.
  - **Direction of flow:** sync pulls code and data _down_; merge pushes _code
    only_ up.
  - **Isolation:** outgoing email is blocked outside production by default, and
    production secrets can be made non-inheritable.
- **Other preview hosts:**
  - Vercel: an immutable deployment per commit plus a branch alias, with comments
    on previews ([vercel-urls], [vercel-comments]).
  - Netlify gives each deploy preview and agent run its own database branch
    ([netlify-db]).
  - Heroku review apps: no database copying, seeded instead ([heroku-review]).
  - Render ([render-previews]) and Railway ([railway-envs]) copy the service
    topology with empty datastores and an expiry.
- **Databases with branches:**
  - Neon: copy-on-write branches, but nothing merges back ([neon]).
  - PlanetScale deploy requests: schema-only branches, checked against current
    production, a serial queue and a held cutover; a revert within 30 minutes
    keeps the writes made since ([ps-deploy], [ps-revert]).
  - Dolt merges rows as well as schema ([dolt]).
- **D1 has no fork** ([d1-time-travel], [d1-export], [d1-limits]):
  - Time Travel restores in place, discarding every later write.
  - An export blocks other requests to the database while it runs, and skips
    FTS5 tables.
  - There are no down migrations.
  - New databases are cheap: 50,000 per account, with no per-database fee.

### Agent platforms

- **The common shape** is a task or thread that becomes a branch and a pull
  request, plus a status board:
  - Claude Code Projects: columns Working, Waiting on you, Ready for review,
    Landing, Idle and Resolved ([cc-projects]).
  - Replit tasks: each runs on an isolated copy, and review shows the log, tests
    and a live preview ([replit-tasks]).
  - Copilot's agent: one draft PR per session; it can't mark the PR ready, and
    the person who asked can't approve it ([copilot-agent]).
- **Best-of-N** (several attempts at one task) multiplies review load.
- **What's measured:**
  - Review is the bottleneck: one study found +98% merged PRs and +91% review
    time with no company-level gain ([faros]).
  - Cursor found that lock-based claiming cut 20 agents to the throughput of
    2–3; optimistic concurrency with planners and workers fixed it
    ([cursor-scaling]).
  - Building a compiler with many agents produced frequent merge conflicts and
    needed a nearly perfect verifier ([anthropic-compiler]).

### Gates and merge queues

- **The "not rocket science" rule:** test the result of the merge, then
  fast-forward ([nrsr]). GitHub's merge queue and GitLab's merge trains test
  each change with everything ahead of it in the queue ([gh-merge-queue],
  [gl-merge-trains]).
- **Doing less work in the queue:**
  - Mergify bisects failed batches ([mergify]).
  - Aviator queues changes separately when they affect different targets
    ([aviator]).
  - Uber's SubmitQueue speculates on likely outcomes ([submitqueue]).
- **Gerrit submit requirements** are query expressions over votes, with
  overrides ([gerrit-submit]). They are a good model for timeline policies.
- **GitHub environments** put required reviewers, a ban on self-review and
  branch policies in front of _secrets_, not just merges ([gh-envs]).
- **Semantic conflicts** (textually clean merges that break behaviour) are only
  caught by testing the combined state ([fowler-semantic]).

### Undoing work after it landed

- **Reverting a merge in git** undoes the content but not the history.
  Re-merging later silently drops the reverted changes unless you first revert
  the revert ([git-revert-merge]).
- **Plastic's "subtractive merge"** has the same trap, and its authors recommend
  fixing forward ([plastic-book]).
- **Pijul** removes a change cleanly only together with everything that depends
  on it, and refuses otherwise ([pijul-unrecord]). It tracks textual
  dependencies, not behavioural ones.
- **Gerrit's "Revert Submission"** reverts everything that was submitted
  together ([gerrit-revert]). It is the model for reverting one timeline's
  whole landing.
- **Compensating transactions** need explicit points of no return
  ([azure-compensating]), and schema changes need expand/contract
  ([fowler-parallel-change]).

### Showing parallel history

- **Lane graphs** (git, GitKraken, Sourcetree) become unreadable as branches
  multiply; GitKraken's own advice is to hide branches ([gitkraken-perf]).
- **Filtering to what's relevant scales:**
  - Sapling's smartlog and jj's log show your work plus context ([smartlog]).
  - Plastic's Branch Explorer draws branches as containers on a time axis
    ([plastic-explorer]).
  - Perforce's Stream Graph shows topology and pending merges instead of commits
    ([p4-graph]).
  - Figma collapses a merged branch to one checkpoint in main's history
    ([figma-branching]).

### Global locks with per-branch status

- **Unity's Smart Locks:** a lock is _retained_ while its change sits on a task
  branch, and _released_ only when the change reaches main ([smart-locks]).
- **Linear:** when a person delegates an issue to an agent, the person stays
  accountable ([linear-agents]). Linear Releases mark issues complete when they
  reach production ([linear-releases]).
- **GitHub** closes issues only when a PR targets the default branch
  ([gh-closing]).
- **GitLab** stops review environments when the branch merges ([gl-envs]).

## A design for Gitmatrix

### What is global and what belongs to a timeline

| Thing                       | Main                         | Timeline                                                                            |
| --------------------------- | ---------------------------- | ----------------------------------------------------------------------------------- |
| Code                        | Trunk                        | Bookmark `timeline/<slug>` in each repository it touches                            |
| Issues                      | Global identity and keys     | Can be created in a timeline (seen only there until it lands); status per timeline  |
| Leases                      | One per issue, global        | Retained while the work is on the timeline; released when it lands or is pruned     |
| Comments, checkpoints       | Main's                       | Tagged with the timeline                                                            |
| CI runs                     | Per ref (as today)           | Tagged; `timeline` available in `if:` and the job environment                       |
| Deployments                 | Production                   | Previews per timeline and per checkpoint                                            |
| Secrets                     | Production environment       | Preview environment only; experimental timelines never receive production secrets   |
| Packages                    | Stable versions and `latest` | Prerelease versions and a dist-tag per timeline; never `latest`                     |
| Knowledge                   | Main's graph and wiki        | An overlay: the graph diff against main; wiki pages generated at gates or on demand |
| Release notes               | Released plus `@unreleased`  | A draft per timeline, folded into `@unreleased` when it lands                       |
| GitHub mirror               | Mirrored                     | Not mirrored by default, so experiments stay private                                |
| People, agents, permissions | Global                       | Global; the timeline records which agents worked in it                              |

### Code: bookmarks, change ids and landing records

- **A timeline's work lives on `timeline/<slug>`.**
  - Agents bound to the timeline push there: the checkout's
    `.gitmatrix/agent.local.yml` names the timeline, which worktrees now
    inherit.
  - `gm push` from inside a timeline goes to its bookmark, never to trunk.
- **The server starts reading `change-id` headers on push** and records which
  timeline each change belongs to.
- **Landing records** keep the history meaningful without merge commits. A
  record holds:
  - the timeline;
  - the change ids;
  - the trunk commit range each became;
  - the approval and the CI run.
- **Trunk stays linear,** which matches gm today: merges are rebased by their
  first parent only.

### Landing: one queue for all timelines

- **Landing tests the combined result.** It rebases onto current trunk, runs the
  gates on the result, and fast-forwards (the not-rocket-science rule).
- **Batching and speculation** are added once volume needs them. The
  coalescing and concurrency code from CORE-23 is the starting point.
- **Policy decides who triggers a landing:**
  - an `auto` timeline enqueues itself when its checkpoint is green;
  - an `approval` timeline enqueues when a person approves that exact
    checkpoint (its commit and deployment ids, never a moving alias).
- **Experimental timelines never enter the queue.**
- **Direct pushes to main stay allowed.** Timelines then need a "base moved"
  event and automatic rebasing, which owning the server makes possible.

### Tracker: one event log, many views

- **Events gain an optional `timelineId`;** issues gain an optional home
  timeline.
- **Views are projections of the one log:**
  - Main's view folds events from main and from landed timelines.
  - Timeline T's view folds main's events plus T's own and its ancestors'.
  - Status is therefore per view: on main, an issue T finished shows as "in
    progress in T" until T lands.
- **`issue.next` inside a timeline uses that timeline's view,** so an agent can
  continue a dependency chain before the timeline lands, as stacked work does.
- **Approval requests point at a checkpoint:** its commits, deployment and
  diff. The inbox shows the preview and evidence at the gate.
- **Landing and pruning are events.**
  - On landing, issues that exist only in the timeline become main issues.
  - On pruning, they are archived, or promoted to main's backlog if the person
    chooses. Main issues the timeline finished reopen, with "pruned" as the
    reason.

### Leases: retained until the work lands

Leases already have TTLs and are already unique per issue across the account.
The change is that completing an issue inside a timeline _retains_ its claim
instead of releasing it, so no other agent picks the work up on a stale base.
Landing releases it as done; pruning releases it back to ready. Cursor's
finding still applies: keep claiming optimistic and short-lived, and don't add
locks on files or areas.

### CI, environments and secrets

- **CI context:** `timeline` and `kind` become available in `if:`, and
  `GITMATRIX_TIMELINE` in the job environment.
- **Environments become records** (`production`, `preview`, …), each with:
  - its secrets;
  - rules for who may deploy to it: production only from trunk after a
    landing; experimental timelines never.
- **This closes a gap that exists today:** any branch's `ci.yml` can name
  `CLOUDFLARE_API_TOKEN` and receive it.
- **Deployments become records:** environment, timeline, checkpoint, commit,
  URL, status and expiry. A job reports one with `gm deploy record --url …`, or
  the server records it for previews it creates.

### Previews for projects hosted on Gitmatrix

- **Gitmatrix tracks deployments; the project's own CI performs them.**
  - Projects on Cloudflare run `cf previews deploy timeline-<slug>` in a
    `preview` job.
  - Other projects deploy wherever they like and record the URL.
- **The web app reads the records** to show the preview at each timeline's head
  and at every checkpoint.
- **Expiry:** previews expire with the timeline's expiry or when it lands. The
  records persist after teardown.

### Previews of Gitmatrix itself

- **A Worker Preview of Gitmatrix is only a partial instance.**
  - Its seven SQLite Durable Object classes would be isolated.
  - Its two D1 databases, two Workflows (CI runs, knowledge builds), two queue
    consumers, hourly cron, R2, Artifacts, Vectorize, AI Search, email and
    mirror would not be.
- **A full preview needs:**
  - **Configuration:** `cloudflare.config.ts` parameterized by instance.
  - **Data:** a D1 per timeline, built from migrations plus `agent seed`
    fixtures. Never live production data, which an export would also block.
  - **Asynchronous work:** run inline in previews, or through a Worker per
    timeline (the account allows 500).
  - **A side-effect profile:**
    - email stubbed;
    - mirror off;
    - publishing only to the timeline's tags;
    - its own Artifacts namespace;
    - an AI budget.
- **This is `vp run agent up` moved server-side.** Today it provisions remote
  Artifacts, Vectorize and AI Search, expires after 24 hours and allows four per
  user. AI Search allows only 100 namespaces per account, so AI previews must
  be rare or share one.

### Packages

- **Publishes from a timeline get a prerelease version and a `timeline-<slug>`
  dist-tag.** They never move `latest`, which today's npm path does whenever a
  publish has no tags.
- **Ending a timeline cleans up its versions:** abandoning or pruning it
  deprecates or deletes them, and retention can treat them as short-lived.

### Knowledge and the "why"

- **A timeline's overlay is its graph diff against main.** Analyses are cached
  by blob, and alignment now asks only about genuinely new concepts, so this
  costs about what an incremental build costs (CORE-17).
- **The overlay is a review aid at the gate:** "adds concept X, changes component
  Y, rewrites wiki page Z". Wiki pages for a timeline are written at gates or on
  demand, not on every push.
- **"Why" is a chain that agents and people both walk:**
  - from a line, through blame, to a commit and its change id;
  - then to the timeline and its issue;
  - then to checkpoints and discussions (CORE-51), and to approval and landing.
  - It needs a `gm why <path:line>` command and the same in the web app.

### Visualization and the timeline switcher

- **One view with time on the x-axis and lanes for timelines.** Main runs down
  the middle, and each lane forks from it:
  - checkpoints and gates appear as marks;
  - deployments appear as preview links;
  - a landing rejoins main, a prune ends the lane with a mark, and experimental
    lanes are dashed and never rejoin.
- **Scaling to many lanes:**
  - By default, show the selected timeline, main and what depends on the
    selection.
  - Collapse each landed timeline to one node on main, and group the rest by
    workspace, team or agent.
- **This view is CORE-42's video-editor timeline,** with tracks.
- **The app-wide switcher is persistent,** with a coloured banner and a `?tl=`
  parameter so links carry the scope:
  - the tracker, code browser, CI, packages, knowledge and release notes all
    honour it;
  - a person reviewing sees changes overlaid on main, and the preview to comment
    on.

### Pruning

- **Before landing (abandon):**
  - delete the bookmark but keep archived refs;
  - stop the previews;
  - deprecate the prereleases;
  - archive or promote the timeline's own issues;
  - release its leases.
- **After landing (prune plan),** shown like `terraform plan` and approved by a
  person:
  1. Revert the landing's change ids as a new timeline, through the queue.
  2. List later landings that depend on them: descendants, the same files and
     symbols, the same concepts in the knowledge graph. Offer to prune those
     too.
  3. Run recorded compensating migrations. Schema changes must follow
     expand/contract to be prunable. Without a compensation the plan says
     "partly prunable".
  4. Deprecate the packages it published, and roll production forward to the
     revert.
  5. List what cannot be undone: email sent, the GitHub mirror (it keeps the
     history), downloads, webhooks, AI spend, published release notes.
  6. Record re-landing after a prune explicitly, to avoid git's
     revert-the-revert trap.

### Experimental timelines and competing attempts

- **Experimental timelines are sandboxed:** no production environment, secrets
  or stable publishes. They pause when idle, keep their records forever, and can
  be promoted.
- **Best-of-N uses existing tracker machinery.** An orchestrator holds the
  issue's lease and delegates attempts to N experimental child timelines, using
  the subtree delegation that already exists. Choosing a winner promotes it and
  abandons the others.

## Where it wouldn't work

1. **State at old checkpoints.** All deployments in a preview share its data,
   so an old checkpoint runs on newer data. D1 can't fork, and exports block.
   Label such previews "old code, current data" unless a snapshot was taken at
   the checkpoint.
2. **Async machinery in previews.** Workflows, queue consumers, cron and service
   bindings aren't isolated per Preview. For Gitmatrix that is CI, knowledge,
   the mirror and registry jobs.
3. **Pruning what others built on.** Reverts conflict, or behaviour changes
   silently. Dependency analysis catches the textual cases, not all of them.
4. **Irreversible effects:** migrations without compensation, data written by
   users, email, published packages, the GitHub mirror, external webhooks, AI
   spend.
5. **Semantic conflicts** between timelines that each passed CI. Only landing
   through the queue catches them, and some only show up after landing.
6. **Review load:** many gated timelines waiting on one person. Mitigations are
   auto policies for low-risk work, checkpoint summaries, graph diffs, previews,
   and batching approvals.
7. **Cost and caps:**
   - 500 Workers and 500 Previews per Worker;
   - 1,000 KV namespaces and 100 AI Search namespaces;
   - the oldest Preview evicted at the cap;
   - knowledge and AI per timeline.
     Expiry, pausing when idle, per-person caps and budgets must be defaults.
8. **Divergence:** two agents rewriting the same change produce two commits
   with one change id. The server must detect it and refuse, or ask.
9. **Long-lived drift:** experimental timelines rot like stale feature flags.
   They need expiry and "rebase or archive" prompts.
10. **Shared singletons:**
    - the production database;
    - the package `latest` tag;
    - semver ordering;
    - tags;
    - domains and OAuth callback URLs;
    - global queues and rate-limit namespaces.
11. **Migration ordering:** collisions like the duplicate `0016_` today. Names
    need timestamps, or landing needs a lineage check.
12. **Landing across repositories:** a timeline touching two repos can land in
    one and fail in the other (as Gerrit topics can).
13. **Mode errors:** acting in the wrong timeline, like being on the wrong git
    branch. The switcher needs constant, unmistakable cues, and main as the
    default.

## A path to build it

| Phase | Scope                                                                                                                                                                                                                                                                      | What it proves                                                                                                                   |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Decide the open questions below; update PRODUCT.md's "trunk is the truth" principle; switch migration names to timestamps; scope secrets to environments; stop timeline publishes from moving `latest`                                                                     | The vocabulary, plus two gaps closed that matter even without timelines                                                          |
| 1     | Timeline records; `gm timeline start/list/use/land/abandon`; a bookmark per timeline; the server reads change ids; CI context; tracker events tagged with timelines and per-timeline views; leases retained until landing; a landing queue with auto and approval policies | Two agents in two timelines in parallel, one landing automatically when green, one waiting for approval, with no duplicated work |
| 2     | Environment and deployment records; preview jobs (`cf previews deploy`); checkpoints; approvals that point at checkpoints                                                                                                                                                  | "View the app at the gate" for hosted projects                                                                                   |
| 3     | Previews of Gitmatrix itself: a parameterized instance, D1 per timeline from migrations and seed, async work inline, the side-effect profile                                                                                                                               | Dogfooding with real previews                                                                                                    |
| 4     | Lanes visualization (with CORE-42) and the app-wide switcher                                                                                                                                                                                                               | Seeing forks, landings and prunes                                                                                                |
| 5     | Knowledge overlays, `gm why`, discussions on timelines (CORE-51)                                                                                                                                                                                                           | The "why" for agents and people                                                                                                  |
| 6     | Prune plans after landing; experimental best-of-N                                                                                                                                                                                                                          | Undo at the level of a timeline                                                                                                  |

## Decisions needed before work starts

1. **Repository or account scope.** Is a timeline per repository, or
   account-wide like the tracker, spanning repositories? The recommendation is
   account-wide, landing one repository at a time at first.
2. **"Done" for an issue finished in a timeline.** Does it count as done on
   main before the timeline lands? The recommendation is no: show "done in T".
3. **Direct pushes to main.** Do they remain, or does all agent work go through
   timelines (and so the queue)?
4. **Landing shape.** Squash each timeline into one commit, or keep its changes
   (with landing records)? The recommendation is to keep the changes.
5. **Approvers.** Can agents approve other agents' timelines, or only people?
   Must the approver differ from the timeline's accountable person, as GitHub
   and GitLab can require?
6. **Previews for hosted projects.** Does Gitmatrix only record them, or also
   host them (Workers for Platforms or Dynamic Workers)?
7. **Data mode for previews.** A fresh seed, shared staging, or a sanitized
   copy, and who may choose?
8. **Retention.** How long do previews, experimental timelines and archived
   refs live, and what are the per-person caps?
9. **Pruning after landing.** Is it allowed for every timeline, or only those
   whose side effects are all compensable?
10. **The GitHub mirror.** Should timelines be mirrored, given that experiments
    may be private?
11. **Naming next to CORE-42.** Is it "timeline" for the parallel lines and
    "timeline view" for the time axis?

## Sources

Sources were consulted on 2026-10-02. Cloudflare's Worker Previews launched ten
days earlier, and `cf` support for them is in beta; recheck their limits and
pricing (not found) before building on them. Claims about agent platforms
come from vendor documentation and blogs and change often.

[p4-types]: https://help.perforce.com/helix-core/server-apps/p4guide/current/Content/P4Guide/streams.types.html
[p4-paths]: https://perforce.com/manuals/p4guide/Content/P4Guide/streams.concepts.paths.inherit.html
[p4-graph]: https://www.perforce.com/manuals/v23.2/p4v/Content/P4V/streams.graph.html
[jj-glossary]: http://docs.jj-vcs.dev/latest/glossary/
[jj-conflicts]: http://docs.jj-vcs.dev/latest/conflicts/
[jj-divergence]: http://docs.jj-vcs.dev/latest/guides/divergence/
[gerrit-jj]: https://www.gerritcodereview.com/design-docs/support-jujutsu-solution.html
[gitbutler]: https://blog.gitbutler.com/parallel-claude-code
[container-use]: https://container-use.com/managing-environments
[fossil-timeline]: https://fossil-scm.org/home/help?cmd=/timeline
[tbd]: https://trunkbaseddevelopment.com/short-lived-feature-branches/
[fowler-branching]: https://martinfowler.com/articles/branching-patterns.html
[cf-previews]: https://developers.cloudflare.com/workers/previews/
[cf-previews-resources]: https://developers.cloudflare.com/workers/previews/resources/
[cf-previews-config]: https://developers.cloudflare.com/workers/previews/configuration/
[cf-version-urls]: https://developers.cloudflare.com/workers/configuration/previews/
[upsun-envs]: https://developer.upsun.com/docs/environments
[upsun-clone]: https://developer.upsun.com/posts/how-it-works/cloning-a-terabyte-in-a-minute-and-the-limit-hiding-behind-it
[vercel-urls]: https://vercel.com/docs/deployments/generated-urls
[vercel-comments]: https://vercel.com/docs/comments
[netlify-db]: https://docs.netlify.com/build/data-and-storage/netlify-database/
[heroku-review]: https://devcenter.heroku.com/articles/github-integration-review-apps
[render-previews]: https://render.com/docs/service-previews
[railway-envs]: https://docs.railway.com/guides/environments
[neon]: https://neon.com/docs/introduction/branching
[ps-deploy]: https://planetscale.com/docs/vitess/schema-changes/deploy-requests
[ps-revert]: https://planetscale.com/blog/revert-a-migration-without-losing-data
[dolt]: https://www.dolthub.com/docs/sql-reference/version-control/merges
[d1-time-travel]: https://developers.cloudflare.com/d1/reference/time-travel/
[d1-export]: https://developers.cloudflare.com/d1/best-practices/import-export-data/
[d1-limits]: https://developers.cloudflare.com/d1/platform/limits/
[cc-projects]: https://code.claude.com/docs/en/claude-projects
[replit-tasks]: https://docs.replit.com/replitai/task-system
[copilot-agent]: https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent
[faros]: https://www.faros.ai/blog/ai-software-engineering
[cursor-scaling]: https://cursor.com/blog/scaling-agents
[anthropic-compiler]: https://www.anthropic.com/engineering/building-c-compiler
[nrsr]: https://graydon2.dreamwidth.org/1597.html
[gh-merge-queue]: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
[gl-merge-trains]: https://docs.gitlab.com/ci/pipelines/merge_trains/
[mergify]: https://docs.mergify.com/merge-queue
[aviator]: https://docs.aviator.co/mergequeue/concepts/affected-targets
[submitqueue]: https://arxiv.org/abs/2501.03440
[gerrit-submit]: https://gerrit-review.googlesource.com/Documentation/config-submit-requirements.html
[gh-envs]: https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
[fowler-semantic]: https://martinfowler.com/bliki/SemanticConflict.html
[git-revert-merge]: https://github.com/git/git/blob/HEAD/Documentation/howto/revert-a-faulty-merge.adoc
[plastic-book]: https://www.plasticscm.com/downloads/plasticscm-book.pdf
[pijul-unrecord]: https://pijul.org/manual/reference/unrecord
[gerrit-revert]: https://gerrit-review.googlesource.com/Documentation/cross-repository-changes.html
[azure-compensating]: https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction
[fowler-parallel-change]: https://martinfowler.com/bliki/ParallelChange.html
[gitkraken-perf]: https://help.gitkraken.com/gitkraken-desktop/performance-issues/
[smartlog]: https://sapling-scm.com/docs/overview/smartlog
[plastic-explorer]: https://docs.unity.com/en-us/unity-version-control/config-files/branch-explorer-global
[figma-branching]: https://help.figma.com/hc/en-us/articles/360063144053
[smart-locks]: https://docs.unity.com/en-us/unity-version-control/smart-locks
[linear-agents]: https://linear.app/docs/agents-in-linear
[linear-releases]: https://linear.app/docs/releases
[gh-closing]: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue
[gl-envs]: https://docs.gitlab.com/ci/environments/
