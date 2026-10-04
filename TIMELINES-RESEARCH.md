# Timelines: parallel lines of agent work (CORE-50)

Date: 2026-10-02.

Historical status: built and shipped (2026-10-03). This began as research and owner
decisions for CORE-50; the owner answered the open questions in two interviews
on 2026-10-02, the second for CORE-62, and later rows under
[Decisions](#decisions) came while building. The work was filed as CORE-62 to
CORE-86 plus CORE-121, CORE-138 and CORE-139, under CORE-50, and every one of
them is done: timelines fork, merge and land through the landing queue, the
tracker follows them, previews are a contract with Gitmatrix's own as the
reference, and knowledge and `gm why` read them. What is left is listed under
[A path to build it](#a-path-to-build-it) as later work and follow-ups.
CORE-42 (timeline visualization in the tracker) and CORE-51 (discussions) were
blocked on CORE-50.

**Storage/landing superseded by CORE-255 (2026-10-04).** The dated research,
interviews and CORE-50/77 decisions below describe the original canonical-branch
implementation, not the current storage contract. Current timelines own one
Artifacts repository per `(timeline, canonical repository)` with opaque
`work_<id>` identity and physical `refs/heads/work`; `timeline/<slug>` remains a
logical overlay/environment label and a legacy migration ref.
Canonical permissions/tombstones govern source-qualified Git/API reads and writes.
The account Tracker reserves pinned fork snapshots and durable operation intents;
missing/migrating sources fail closed, not back to old canonical branches.

Current landing materializes B→T (explicit logical-base tree to approved work
tree) onto pinned canonical O. The result is a gated single-parent commit, or a
no-op receipt: no WIP commits are uploaded to canonical. Every repository is
prepared/gated before any main CAS; movement requires re-preparation/re-gating.
There is no distributed transaction, and partial retry/cancel preserves successful
receipts. Full WIP history and exact ancestry remain in owned sources, with
integration provenance for steps, why, release notes and late local sync; matching
change IDs alone never prove integration. Nested work needs exact admitted
ancestry and an unambiguous integrated dependency baseline.

Ended owned history is read-only, then expires under `timeline-work-sources`,
enabled by default: `landedDays=30`, `abandonedDays=90`, both configurable in
Data retention. The owner confirmed these defaults and the public Git URL
`/<owner>/<repo>@<slug>.git` while folding CORE-252 into CORE-255. Canonical
`timeline/*` pushes are refused with the corresponding timeline URL.
Tracker detail (`endedTimelineDays=180` when enabled), published wiki output,
and preview expiry remain separate policies. Live consumers and dependency
roots delay Git deletion, not completed output metadata. Purged Git sources
report expiry without canonical fallback. Active/experimental legacy work has
a finite migration; completed records become canonical-historical without
rewriting old main history. See the authoritative
[server contract](apps/website/README.md#timelines) and exact
[CLI migration commands](apps/cli/README.md#timelines).

## Conclusion

- **A timeline is an account-wide object that every part of Gitmatrix scopes its
  data to.**
  - It lives next to the tracker and can touch several repositories.
  - It has a parent (main or another timeline), a fork point, a status and an
    expiry for its previews.
  - It has a policy: land automatically, or land after a person approves a
    checkpoint. It can be flagged experimental, a marker for timelines not
    expected to land.
  - Any writer can start one or merge into one. Only its accountable person or
    the agent that started it can abandon it.
  - Selecting it in the web app filters code, issues, runs, previews, packages
    and knowledge to "main plus this timeline".
- **Timelines are optional.** An agent uses one when the context calls for it:
  - a field on the issue;
  - the issue's description or PRD;
  - what a person asked;
  - later, other signals.

  Plain pushes to main stay as they are.
  CORE-136 adds an explicit `gm push --queue` option for independent default-branch
  work, not an interception of ordinary/native pushes. Its per-repository merge
  queue is separate from timeline landing. Timeline-bound `--queue` submissions
  are rejected: use checkpoint/land instead. Queue scheduling or bounded AI
  conflict repair never weakens a timeline's pinned approval, approves a newer
  checkpoint, or bypasses its required gates. Queue failure remediation and its
  read-only evidence are shared tracker records across timeline views; they do
  not alter original issue leases or make timeline work complete on main.

- **Timelines are git branches joined by real merges, with more history than
  git keeps.**
  - A timeline can fork into other timelines, which merge into each other or
    into main.
  - A timeline stays separate from main until it lands. Main is merged into it
    only by a person, or by an agent asked to do it.
  - Gitmatrix records the history git doesn't keep, so the whole graph can be
    reviewed afterwards:
    - forks, merges and landings;
    - which changes (by jj `change-id`) entered which timeline;
    - every ref update.
- **Landing merges an approved checkpoint into main through a queue.** The queue
  runs the gates on the merged result.
  - An approval pins one checkpoint: its commits, preview and CI run.
  - New commits need a new checkpoint and a new approval.
  - Any person with write access may approve.
  - Across repositories, every repository's merge is prepared and tested before
    any main advances. If an advance fails after that, the timeline shows as
    partly landed and the rest retries.
- **An issue finished in a timeline has its own status, "done in a timeline".**
  - The issue and the timeline link to each other.
  - The issue becomes done on main when the timeline lands, and goes back to
    ready if the timeline is abandoned.
  - Leases stay unique per issue across timelines, and are held until then.
- **Gitmatrix does not own deployment.** It offers primitives that make it aware
  of previews:
  - environments;
  - deployment records;
  - a contract to create, tear down and regenerate a preview for a checkpoint.

  Projects implement the contract in their own CI. Gitmatrix's own previews
  (Cloudflare Worker Previews, plus a D1 per timeline built from migrations and
  seed) are one reference implementation, and use only the public primitives.

- **Previews expire, but their records don't, and any checkpoint's preview can
  be revived.** By default previews are torn down 2 days after their timeline
  lands or is abandoned, and after 7 days without pushes; each org can change
  both numbers. Reviving one, for example to investigate last week's work,
  rebuilds code from the commit and data from migrations and seed, never from a
  copy of production.
- **Prune means abandon, for now.** Removing a landed timeline's effect on main
  is out of scope; mistakes that landed are fixed forward.
- **Knowledge per timeline:** the graph diff against main updates on every push.
  Wiki pages are written at checkpoints and gates, or on demand.
- **Before timelines:**
  - Fix now: only main moves a package's `latest`, and new migrations get names
    that can't collide.
  - Unchanged: secrets stay per repository, an accepted risk.
  - Changed: only main and tags are mirrored to GitHub.

## What CORE-50 asks for

| CORE-50 asks                                                              | What it implies                                                                | Hardest part                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------- |
| Agents work in a separate thread, "likely one or more branches"           | An account-level object above branches, spanning repos                         | Landing across repos                          |
| Artifacts are deployed but kept apart; selecting a timeline shows only it | Every subsystem filters by timeline; an app-wide switcher                      | Scoping consistently across eight subsystems  |
| Two agents can't lease the same issue, even in different timelines        | Leases stay global and are held until the work lands                           | Release-on-land semantics; best-of-N attempts |
| Human intervention before main, with independent work until then          | A policy per timeline; approvals pinned to checkpoints                         | Review becomes the bottleneck                 |
| Issues may be specific to a timeline                                      | Issues and a "done in a timeline" status scoped to a timeline                  | Merges between timelines                      |
| View the app in preview at any point, especially at the gate              | Preview primitives; checkpoints; regenerating expired previews                 | State at old checkpoints                      |
| Some timelines merge automatically                                        | An automatic policy through a landing queue                                    | Semantic conflicts                            |
| A git-history-like view of forks, merges and splits                       | Real merges plus history git doesn't keep                                      | Many short-lived agent timelines              |
| Prune, even removing the impact on main afterwards                        | For now: abandon before landing only                                           | (Deferred) irreversible effects               |
| Experimental timelines never merge but persist                            | An experimental flag: a UX marker for timelines not expected to land           | Keeping it a marker, not a rule               |
| Merged timelines stay visible                                             | Timeline events and archived refs, kept forever                                | Retention                                     |
| Knowledge explains "why" to agents and humans                             | A provenance chain: change, timeline, issue, checkpoints, discussion, approval | Following changes across merges               |

## What "timeline" means

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
   precedents are Upsun (every branch is a full environment) and Figma
   branches.

The original design presented the third and implemented it as the first, one
subsystem at a time. Its account-level record and scoped subsystem data remain,
but its no-fork storage design is superseded: CORE-255 owns separate work Git
repositories while keeping canonical authorization and account coordination.

**Naming:** "Timeline". CORE-42's time axis is a variation of the same concept,
to be designed later.

### A timeline, concretely

- **Identity:** a stable `id` that is never reused, plus `slug` and `name`. The
  owner is the tracker's account, and a timeline lists the repositories it
  touches.
- **Experimental flag:** marks a timeline that isn't expected to land, so views
  of stalled work leave it out. It is a UX marker, not a restriction: its work
  can be merged freely into other timelines, including ones that land, and any
  writer can set or clear it.
- **`policy`:** `auto` lands when the gates pass. `approval` lands after a person
  with write access approves the current checkpoint. Agents never approve.
- **Lineage:** a `parent` (main or another timeline) and a fork point, which is
  a commit per repository plus a tracker cursor.
- **Per repository (original design, superseded):** a canonical bookmark
  `timeline/<slug>`; current work uses its owned source's `refs/heads/work`.
- **`status`:** `active`, `idle` (no pushes for the org's idle period, 7 days by
  default), `waiting` (a checkpoint awaits approval), `landing` (queued),
  `partly landed` (some repositories advanced, the rest retrying), `landed`,
  `abandoned`.
- **Permissions:** any writer, person or agent, can start a timeline and merge
  into one. Abandoning is limited to its accountable person and the agent that
  started it.
- **People and work:** the accountable person, the agents that worked in it, and
  its issues.
- **Checkpoints,** which are immutable. Each holds:
  - the commit per repository and the main commit it would merge onto;
  - change ids and the CI run;
  - preview deployment records and an agent-written summary;
  - the approval.
- **Events,** kept forever: fork, merge (timeline into timeline, main into
  timeline, timeline into main), checkpoint, approval, landing, abandon.

### When an agent uses a timeline

- **A field on the issue:** `timeline: required | agent decides | never`, with
  `agent decides` as the default. When it is `required`, it can name the policy
  (`auto` or `approval`) the agent's timeline must use. `gm issue next` and
  `gm issue claim` return it with the claim.
- **The agent records its choice:** the issue links to the timeline it worked
  in, or a checkpoint comment says why it worked on main.
- **The issue's description or PRD,** in plain words (for example, "do this in
  an approval timeline"). The agent guide and the graph-work skill tell agents
  to look there.
- **What a person asks,** in a comment or a request.
- **Later signals,** such as the risk of a change or defaults per workspace, are
  deliberately not part of the first version.

## What Gitmatrix has today

| Area                                                     | Today                                                                                                                                                                                                                                              | Gap for timelines                                                                                  |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| gm (`apps/cli/src/repo/mod.rs`, `commands/network.rs`)   | jj-style changes with a `change-id` header on every commit; a local op log; trunk immutable, other bookmarks rewritable; `gm push -b` pushes any bookmark; `gm merge` and rewrites that keep every parent (CORE-66); a graph in `gm log` (CORE-67) | No timelines yet                                                                                   |
| Git server (`worker/git/http.ts`, `worker/artifacts.ts`) | Every branch is stored and browsable; a ref picker on tree, blob and commits; a ref-update log and change-id membership per push (CORE-68)                                                                                                         | No per-ref metadata, compare view or branch protection                                             |
| Tracker (`worker/tracker/store.ts`, `shared/tracker.ts`) | One Durable Object per account; an event log with a cursor; one claim per issue; subtree leases, delegation and handoff; approval requests that park a lease                                                                                       | No git or timeline fields; a request references only an issue; a lease ends at complete or release |
| CI (`worker/ci`, `.gitmatrix/ci.yml`)                    | Runs on every branch; `if:` over branch, trigger, commit and runner; concurrency groups; coalescing                                                                                                                                                | No environments, deployment records or preview triggers                                            |
| Deploy (`tools/agent/deploy.ts`)                         | One production Worker, deployed only from main                                                                                                                                                                                                     | Nothing parameterizes a second deployed instance                                                   |
| Registry (`registry/`)                                   | Provenance records the ref, run and commit; branch filters; only default-branch publishes become `latest` (CORE-63)                                                                                                                                | Clients that read a full index (Go `@v/list`, pip, cargo) can still pick a branch version          |
| Knowledge (`worker/knowledge`)                           | Default branch HEAD only; analyses cached by blob; a change feed per build; a per-ref semantic feed                                                                                                                                                | One graph per repository; no overlays                                                              |
| Release notes (`worker/release-notes`)                   | Default branch and tags, walking first-parent history; each merge brings the commits it landed, and entries name the timeline they landed with (CORE-72)                                                                                           | No per-timeline drafts; timelines are named by branch until CORE-69 records them                   |
| Mirror (`worker/mirror`)                                 | The default branch and tags only (CORE-65)                                                                                                                                                                                                         | Done                                                                                               |
| Identity (CORE-52)                                       | Agents act as themselves, accountable to a person; CI runs record the agent                                                                                                                                                                        | Already in place                                                                                   |
| Isolated environments (`tools/agent/environment.ts`)     | Isolated local instances using remote Artifacts, Vectorize and AI Search; 24-hour expiry; four per user                                                                                                                                            | Local only, not previews                                                                           |

Today's parallel work already shows problems that timelines would make routine:

- **Migration numbers collided.** Two lines of work each added a `0016_`
  migration (`0016_agent_capabilities.sql` and
  `0016_knowledge_graph_version.sql`). D1 applies both because it tracks file
  names, but the order between them is an accident.
- **Deploys queue behind each other.** Newer runs superseded deploys (#43 by
  #44, #54 by #56).
- **Indexes lag.** An AI test failed because AI Search had not yet indexed one
  file (CORE-58). Per-timeline indexes will be eventually consistent too.
- **Knowledge cost is now small per push.** Since CORE-17, an incremental
  knowledge build for a small push costs about 7 concept questions and 10
  minutes. The first build took 43 minutes. Per-timeline graph overlays are
  affordable; per-timeline full rebuilds are not.

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
- **Upsun (formerly Platform.sh)** is the closest existing product to timelines
  ([upsun-envs], [upsun-clone]):
  - **Branching:** every branch is an environment in a parent/child tree.
    Branching copies code and all service data with copy-on-write in about a
    minute; clone chains are capped at 16 levels.
  - **Direction of flow:** sync pulls code and data _down_; merge pushes _code
    only_ up.
  - **Isolation:** outgoing email is blocked outside production by default, and
    production secrets can be made non-inheritable.
- **Other preview hosts:**
  - Vercel: an immutable deployment per commit plus a branch alias, with
    comments on previews ([vercel-urls], [vercel-comments]).
  - Netlify gives each deploy preview and agent run its own database branch
    ([netlify-db]).
  - Heroku review apps: no database copying, seeded instead ([heroku-review]).
  - Render ([render-previews]) and Railway ([railway-envs]) copy the service
    topology with empty datastores and an expiry.
- **GitHub and GitLab** both model what Gitmatrix needs as primitives:
  - environments, with deployment records whose statuses carry an environment
    URL ([gh-envs]);
  - review environments that stop automatically, or when the branch merges
    ([gl-envs]).
- **Databases with branches:**
  - Neon: copy-on-write branches, but nothing merges back ([neon]).
  - PlanetScale deploy requests: schema-only branches, checked against current
    production, a serial queue and a held cutover ([ps-deploy], [ps-revert]).
  - Dolt merges rows as well as schema ([dolt]).
- **D1 has no fork** ([d1-time-travel], [d1-export], [d1-limits]):
  - Time Travel restores in place, discarding every later write.
  - An export blocks other requests to the database while it runs.
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

- **The "not rocket science" rule:** test the result of the merge, then advance
  main ([nrsr]). GitHub's merge queue and GitLab's merge trains test each change
  with everything ahead of it in the queue ([gh-merge-queue],
  [gl-merge-trains]).
- **Doing less work in the queue:**
  - Mergify bisects failed batches ([mergify]).
  - Aviator queues changes separately when they affect different targets
    ([aviator]).
  - Uber's SubmitQueue speculates on likely outcomes ([submitqueue]).
- **Gerrit submit requirements** are query expressions over votes, with
  overrides ([gerrit-submit]). They are a good model for timeline policies.
- **Semantic conflicts** (textually clean merges that break behaviour) are only
  caught by testing the combined state ([fowler-semantic]).

### Undoing work after it landed (deferred)

Pruning landed work is out of scope for now. The research is kept for when it
returns:

- **Reverting a merge in git** undoes the content but not the history.
  Re-merging later silently drops the reverted changes unless you first revert
  the revert ([git-revert-merge]).
- **Plastic's "subtractive merge"** has the same trap, and its authors recommend
  fixing forward ([plastic-book]).
- **Pijul** removes a change cleanly only together with everything that depends
  on it ([pijul-unrecord]).
- **Gerrit's "Revert Submission"** reverts everything that was submitted
  together ([gerrit-revert]).
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

## A design for Gitmatrix

### What is global and what belongs to a timeline

This table records the original design. Its canonical timeline branch storage
is superseded by the current owned-source contract above.

| Thing                       | Main                                     | Timeline                                                                                      |
| --------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| Code                        | Trunk                                    | Bookmark `timeline/<slug>` in each repository it touches                                      |
| Issues                      | Global identity and keys                 | Can be created in a timeline; a "done in a timeline" status                                   |
| Leases                      | One per issue, global                    | Held while done in an unlanded timeline; released on landing or abandon                       |
| Comments, checkpoints       | Main's                                   | Tagged with the timeline                                                                      |
| CI runs                     | Per ref (as today)                       | Tagged; `timeline` available in `if:` and the job environment                                 |
| Deployments                 | Production records                       | Preview records per timeline and checkpoint                                                   |
| Secrets                     | Per repository; any job may request them | The same (an accepted risk)                                                                   |
| Packages                    | Only main moves `latest`                 | Prerelease versions and a dist-tag per timeline                                               |
| Knowledge                   | Main's graph and wiki                    | Graph diff against main on every push; wiki pages at gates or on demand                       |
| Release notes               | Per-issue entries                        | Each entry labelled with the timeline it landed with; a landing without issues gets one entry |
| GitHub mirror               | Main and tags                            | Not mirrored                                                                                  |
| People, agents, permissions | Global                                   | Global; the timeline records which agents worked in it                                        |

### Historical Git design (storage and canonical landing superseded)

- **Originally, work lived on canonical `timeline/<slug>` branches.** CORE-255
  replaces these with owned work repositories; checkout binding still lives in
  `.gitmatrix/agent.local.yml` and new worktrees inherit it.
- **Native merges remain a work-history mechanism**, including explicit sync
  with main or another timeline. They are no longer canonical landing:
  compact landing does not upload WIP ancestors or a second parent.
- **gm has real merge support** (CORE-66): `gm merge <rev>` creates a merge
  change, every rewrite keeps all parents, conflicts on merges are recorded like
  on any other change, and `gm log` draws the graph (CORE-67).
- **The original server-history proposal was:**
  - a ref-update log (old commit, new commit, actor, agent, time), which doesn't
    exist today;
  - change membership: on each push it reads the `change-id` headers and records
    the timeline each change first appeared in, and every timeline it was later
    merged into;
  - the timeline events listed above.
- **Original merge-based consumer design (superseded for compact landings):**
  First-parent consumers treated a landing merge's second parent as timeline work (CORE-72):
  - release notes: a range includes what each merge landed (the commits only
    its other parents reach), issue keys come from those commits too, and each
    entry records its landing merge and the timeline branch git or the push
    log names; a landing's commits that cite no issue share one entry;
  - `gm sync`'s detection of changes that landed: it walks every parent, drops
    rewritten copies of landed changes, and moves work built on a landed
    checkpoint onto main;
  - knowledge change feeds: the semantic feed follows first parents, so a
    merge is one step whose changes are its diff against its first parent,
    marked with what it merged; the knowledge build diffs snapshots of
    successive heads and needs no change.

### Historical landing design (superseded by compact landing above)

- **The queue merges the approved checkpoint into the current main.** It runs
  the gates on that merge and advances main to the merge commit: the
  not-rocket-science rule, with a merge instead of a rebase.
- **The merge runs where git already runs, in a CI sandbox job** with a landing
  credential. The Worker can't run `git merge`.
- **Across repositories, everything is prepared before anything advances.** The
  queue merges and tests every repository's checkpoint first. Only when all
  pass does it advance each main, one after another. If an advance fails
  because that main moved, the timeline is `partly landed` and the remaining
  repositories retry. There is no transaction across repositories, so this is
  as close to atomic as it gets.
- **How a timeline enters the queue:**
  - `auto` timelines enqueue themselves when a checkpoint is green;
  - `approval` timelines enqueue when a person approves a checkpoint, and only
    while that checkpoint is still the timeline's head;
  - the experimental flag doesn't stop a landing; it only says one isn't
    expected.
- **There is no automatic sync with main.** If main has moved since the
  checkpoint and the merge is clean, the queue lands it (the gates test the
  merged result). If it conflicts, landing stops and asks for a sync: a person
  merges main into the timeline, or asks an agent to. That creates a new
  checkpoint, which needs approval again.
- **As built (CORE-77):** the merge job pushes to
  `gitmatrix/landing/<slug>`, where the repository's own pipeline runs with
  `trigger == "landing"`; landings run in parallel and serialize at each
  main's compare-and-swap, so one that lost the race merges onto the new main
  and is tested again. The current replacement is documented in
  [the website README](apps/website/README.md#timelines).
  The job's landing credential is its own CI job credential, which
  Gitmatrix's git proxy accepts only for reads and for pushes to that one
  landing branch (CORE-157).

### Tracker

- **Events and issues gain an optional `timelineId`.**
- **A new status: "done in a timeline",** with the timeline it was done in.
  - It is distinct from in progress and from done. On main the issue shows
    "Done in `<timeline>`" with a link.
  - The timeline's page lists its issues, and an issue lists the timelines it
    is part of.
- **Readiness follows the timeline:**
  - Inside the timeline (and timelines it merges into), the issue counts as done
    for blocking.
  - On main it keeps blocking until the timeline lands.
  - `issue.next` inside a timeline uses that timeline's view.
- **Transitions:**
  - When timeline T2 merges into timeline T1, T2's finished issues become done
    in T1.
  - Landing makes them done.
  - Abandoning returns them to ready, releases their leases, and adds a note
    linking the abandoned timeline.
- **Approval requests point at a checkpoint:** its commits, previews, CI run and
  graph diff.

### Leases

Leases stay unique per issue across every timeline, and already have TTLs. The
change is that finishing an issue inside a timeline _keeps_ its lease (the
"retained" state of Unity's Smart Locks). Landing releases it as done;
abandoning releases it back to ready. A retained lease doesn't expire while its
timeline is live, so the agent that finished the work needs no renewal; a merge
into another timeline carries it along, and reopening the issue in the timeline
ends it (CORE-75). Cursor's finding still applies: keep
claiming optimistic and short-lived, and don't add locks on files or areas.

### Previews: primitives, not hosting

- **Gitmatrix doesn't deploy anything.** It knows where previews are and asks
  projects to create or remove them.
- **Environments:** named per repository. There is `production`, plus one per
  timeline (`timeline/<slug>`), each listing its deployments.
- **Deployment records hold:**
  - the environment, timeline, checkpoint and commit;
  - the URL and a status (active, sleeping, expired, failed);
  - who created it (CI run, agent) and an expiry.

  A job creates one with `gm deploy record` (or the API). A system outside
  Gitmatrix can do the same with a token.

- **A preview contract in `ci.yml`.** A project opts in with `on: preview`, and
  its jobs choose an action with `if:` like any other condition:

  ```yaml
  on:
    push: {}
    preview: {}

  jobs:
    preview:
      if: trigger == "preview" && action == "create"
      steps:
        - run: cf previews deploy "timeline-$GITMATRIX_TIMELINE"
        - run: gm deploy record --url "$PREVIEW_URL"
    preview-teardown:
      if: trigger == "preview" && action == "teardown"
      steps:
        - run: ./scripts/preview-teardown.sh "$GITMATRIX_TIMELINE"
  ```

  Jobs also get `GITMATRIX_TIMELINE`, `GITMATRIX_CHECKPOINT` and
  `GITMATRIX_COMMIT` (and `GITMATRIX_PREVIEW_ACTION`); a job without `if:`
  doesn't run in a preview run (CORE-79, `apps/website/README.md`, "The
  preview contract"). Gitmatrix runs:
  - `create` for each new checkpoint of the timeline;
  - `teardown` when a preview expires;
  - `create` again when someone revives an expired checkpoint's preview.

- **Expiry and revival:**
  - Previews are torn down 2 days after their timeline lands or is abandoned,
    and after 7 days without pushes. Each org can change both numbers. Records
    are kept.
  - Reviving a preview is one action on any checkpoint, for example to
    investigate last week's work. It rebuilds from the record: the commit's code
    with migrations plus seed.
  - A revived preview can differ from the original if the toolchain or seed
    changed since; the UI says so.

### Gitmatrix's own previews: the reference implementation

- **A `preview` job in `.gitmatrix/ci.yml`:**
  - `create` runs `cf previews deploy timeline-<slug>`, builds a D1 per
    timeline from migrations plus the `agent seed` fixtures, and reports the
    URL with `gm deploy record`;
  - `teardown` deletes the Preview and its databases. Our `cf` has no command
    to delete a Preview yet (only `cf previews deploy`), so teardown may need
    the API.
- **What Worker Previews don't isolate must be handled in the app's public
  configuration:**
  - Workflows (CI runs, knowledge builds) would run in production;
  - queue consumers and cron don't run;
  - R2, Artifacts, Vectorize and AI Search are shared unless bound per preview.

  A preview mode turns these off or runs them inline, and binds separate
  namespaces where needed. Email and mirroring are off.

- **No internal shortcuts.** If Gitmatrix's previews need something, it becomes
  a primitive any project can use.

### Packages

- **Fix now:** only publishes from main move `latest`. Other refs publish
  prereleases or a tag named after the branch or timeline.
- **Abandoning a timeline deprecates its versions.**

### Knowledge and the "why"

- **Every push to a timeline updates its graph diff against main.** Main's graph
  is untouched. Wiki pages for a timeline are written at checkpoints and gates,
  or on demand.
- **"Why" is a chain that agents and people both walk:**
  - from a line, through blame, to a commit and its change id;
  - then to the timelines it passed through (from the ref-update log and the
    merges) and its issue;
  - then to checkpoints, discussions (CORE-51), approval and landing.
  - It needs a `gm why <path:line>` command and the same in the web app.

### Visualization and switching timelines

- **The graph is drawn from git's merges plus the server's timeline events.**
  Main runs down the middle and each timeline is a lane:
  - forks, merges between timelines and landings into main are drawn;
  - abandoned lanes end with a mark, and experimental lanes are dashed.
- **Scaling to many lanes:**
  - By default, show the selected timeline, main and what depends on the
    selection.
  - Collapse each landed timeline to one node on main, and group the rest by
    workspace, team or agent.
- **CORE-42's time axis** is a later variation of the same view.
- **The app-wide switcher is persistent,** with a coloured banner and a `?tl=`
  parameter so links carry the scope:
  - the tracker, code browser, CI, packages, knowledge and release notes all
    honour it;
  - main is the default.

### Abandoning

- **Who can abandon:** the timeline's accountable person, or the agent that
  started it.
- **What abandoning does:**
  - delete the bookmark, keeping archived refs and events;
  - tear down previews, keeping the records;
  - deprecate prereleases;
  - leave the timeline's own issues alone: its view stays readable, read-only;
  - return its finished issues to ready, and release their leases.
- **Pruning landed work comes later** (see the deferred research above).

### Experimental timelines and competing attempts

- **Experimental is a flag for timelines not expected to land.** It is a UX
  marker, not a restriction: views of stalled work leave flagged timelines out,
  since stalling is expected of them, and their work can be merged freely into
  other timelines, including ones that land. It may gain other uses later.
- **Best-of-N uses existing tracker machinery.** An orchestrator holds the
  issue's lease and delegates attempts to child timelines flagged experimental,
  using the subtree delegation that already exists. Choosing a winner clears its
  flag and abandons the others.

## Where it wouldn't work

1. **Reviving old checkpoints.** A revived preview rebuilds code from
   the commit and data from migrations plus seed. It never brings back the
   original data, and an old commit may no longer build with today's toolchain
   or seed.
2. **Async machinery in previews.** For Gitmatrix's reference implementation,
   Workflows, queue consumers and cron aren't isolated per Preview. That means
   CI, knowledge, the mirror and registry jobs.
3. **Drift without automatic sync.** Timelines that stay separate for long
   conflict more when they land, and every sync needs approval again.
4. **Merge commits on main.** Tools that walk first-parent history need
   updating, and gm needs proper merge support before any of this works.
5. **Semantic conflicts.** Gates on the merged result catch most of them. What
   breaks after landing is fixed forward, since there is no pruning.
6. **Review load:** many gated timelines waiting on one person. Mitigations are
   auto policies for low-risk work, checkpoint summaries, graph diffs and
   previews.
7. **Cost and caps** in our reference implementation:
   - 500 Previews per Worker, with the oldest evicted;
   - 100 AI Search namespaces;
   - knowledge per timeline.

   Expiry and per-person caps must be defaults.

8. **Divergence:** two agents rewriting the same change produce two commits
   with one change id. The server must detect it and refuse, or ask.
9. **Long-lived drift:** timelines that stay open, experimental ones especially,
   rot like stale feature flags. Idle detection (7 days by default) tears down
   their previews; they still need "merge main or abandon" prompts.
10. **Shared singletons:**
    - the production database;
    - the package `latest` tag and semver ordering;
    - tags;
    - domains and OAuth callback URLs;
    - global queues and rate-limit namespaces.
11. **Secrets:** any job in any timeline can request any repository secret,
    production ones included. This is accepted for now; revisit with untrusted
    agents or more users.
12. **Landing across repositories:** with no transaction across repositories,
    a timeline can be partly landed for a while. Preparing every merge first
    makes it rare, not impossible (as with Gerrit topics).
13. **Mode errors:** acting in the wrong timeline, like being on the wrong git
    branch. The switcher needs constant, unmistakable cues, with main as the
    default.

## A path to build it

The work is tracked as sub-issues of CORE-50, linked by what blocks what.
CORE-62 (the open questions) comes first; the issues with no blockers can start
in parallel.

| Phase        | Scope                                                                                                                                                                                                                      | Issues                             | What it proves                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 0            | Decide the open questions; only main moves `latest`; collision-free migration names; mirror only main and tags                                                                                                             | CORE-62, CORE-63, CORE-64, CORE-65 | Decisions settled, and gaps closed that matter even without timelines                                           |
| 1            | Merges in gm (merge changes, rewrites that keep both parents, a graph in `gm log`); the server's ref-update log and change membership; timeline records and events; `gm timeline`; the issue field; first-parent consumers | CORE-66 to CORE-72                 | Timelines that fork and merge, with their history reviewable                                                    |
| 2            | Tracker: `timelineId`, "done in a timeline", navigation both ways, per-timeline views, leases held until landing; checkpoints with pinned approvals; the landing queue (merge, gates, advance main)                        | CORE-73 to CORE-77                 | Two agents in two timelines in parallel, one landing automatically, one after approval, with no duplicated work |
| 3            | Preview primitives: environments, deployment records, the preview job contract (create, teardown, regenerate), expiry; Gitmatrix's reference implementation                                                                | CORE-78, CORE-79, CORE-80          | "View the app at the gate", built by the project's own CI                                                       |
| 4            | The timeline graph view and the app-wide switcher                                                                                                                                                                          | CORE-81, CORE-82                   | Seeing forks, merges and landings                                                                               |
| 5            | Knowledge overlays on every push, wiki pages at checkpoints, `gm why`; discussions on timelines (CORE-51)                                                                                                                  | CORE-83, CORE-84, CORE-85          | The "why" for agents and people                                                                                 |
| Experimental | The experimental flag: a UX marker for timelines not expected to land, left out of stalled views                                                                                                                           | CORE-86                            | Experiments kept without looking stalled                                                                        |
| Later        | Pruning landed work; experimental best-of-N; secrets per environment; CORE-42's time axis                                                                                                                                  | Not filed                          |                                                                                                                 |
| Follow-ups   | `gm why` reads landing events; a landing credential narrowed to the landing ref; discussions on timelines                                                                                                                  | CORE-156, CORE-157, CORE-51        |                                                                                                                 |

## Decisions

From the two interviews on 2026-10-02 (CORE-62), and while building: the two
rows on "done in a timeline" and abandoned issues came with CORE-74, and the
last two with CORE-80:

| Question                                         | Decision                                                                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Per repository or account-wide?                  | Account-wide, like the tracker                                                                                                            |
| Is an issue finished in a timeline done on main? | Only when the timeline lands. Until then it has its own status, "done in a timeline", linked both ways with the timeline                  |
| Can agents still push straight to main?          | Timelines are optional and contextual: agents use them or not, depending on the issue, a person's request and later signals               |
| Who approves?                                    | Any person with write access                                                                                                              |
| How does a timeline land?                        | As a real git merge. Timelines fork into timelines and merge into each other or main, and Gitmatrix keeps the history git doesn't         |
| Prune after landing?                             | Not for now: prune means abandon                                                                                                          |
| Signals for using a timeline                     | A field on the issue, and the issue's description or PRD                                                                                  |
| Who deploys previews?                            | Not Gitmatrix. It offers primitives; Gitmatrix's own Cloudflare previews are a reference implementation using only those primitives       |
| Keeping up with main                             | A timeline stays separate until it lands; main is merged into it by a person, or by an agent asked to                                     |
| Issues done in an abandoned timeline             | Back to ready, with leases released                                                                                                       |
| Fix before timelines                             | Only main moves `latest`; collision-free migration names                                                                                  |
| Preview data                                     | Migrations plus seed                                                                                                                      |
| Retention                                        | Previews expire and records stay; previews can be revived (numbers below)                                                                 |
| GitHub mirror                                    | Main and tags only                                                                                                                        |
| Naming                                           | "Timeline"; CORE-42's time axis is a later variation of the same concept                                                                  |
| Is an approval valid after new commits?          | No. It pins the approved checkpoint                                                                                                       |
| Knowledge per timeline                           | The graph on every push; wiki pages at gates                                                                                              |
| Keep preview jobs away from production secrets?  | Not needed                                                                                                                                |
| Landing across repositories                      | Prepare and test every repository's merge first, then advance each main; a failed advance shows the timeline as partly landed and retries |
| The issue field                                  | `required`, `agent decides` (default) or `never`; when required, an optional policy; the agent records the choice it made                 |
| The preview contract                             | `on: preview` in `ci.yml`; jobs pick `create` or `teardown` with `if:`                                                                    |
| Who may create, merge and abandon                | Any writer creates and merges; abandoning is for the accountable person and the agent that started the timeline                           |
| Experimental timelines                           | A UX flag for timelines not expected to land, left out of stalled views; their work merges freely, including into timelines that land     |
| Release notes                                    | Per-issue entries, each labelled with the timeline it landed with                                                                         |
| Retention numbers                                | Previews torn down 2 days after landing (and abandoning) and after 7 idle days, configurable per org; reviving a preview must be easy     |
| Retiring mirrored branches                       | Nothing to retire: the only mirror in production holds just `main` (checked 2026-10-03)                                                   |
| Changing "done in a timeline" on main?           | Not allowed: locked wherever it shows, for people and agents, linking to the timeline; merge, landing, abandon or a reopen there move it  |
| Issues of an abandoned timeline                  | Left alone, not archived or moved: its view stays readable, read-only. Finished ones still go back to ready on main                       |
| Who can open a Gitmatrix preview?                | Anyone with its access link, recorded on the deployment; only people who can read the private repository see it                           |
| Preview URLs on the production Worker            | On (`previewUrls`), with workers.dev itself off; production versions get preview URLs too, an accepted trade-off                          |

### Still open

None: CORE-62 settled the last questions on 2026-10-02. Deferred on purpose:
pruning landed work, best-of-N, secrets per environment, and CORE-42's time
axis.

## Sources

Sources were consulted on 2026-10-02. Cloudflare's Worker Previews launched ten
days earlier, and `cf` support for them is in beta; recheck their limits and
pricing (not found) before building on them. Claims about agent platforms come
from vendor documentation and blogs, and change often.

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
[gh-envs]: https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
[gl-envs]: https://docs.gitlab.com/ci/environments/
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
