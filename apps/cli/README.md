# gm

The Gitmatrix CLI, written in Rust. It is built for agents first: JSON output,
discoverable commands, structured errors. It uses a change-based workflow like
[jj](https://jj-vcs.github.io/jj/): commit early, commit often, no staging area,
no pull requests.

```bash
pnpm run install-bin            # cargo install: puts `gm` in ~/.cargo/bin
gm auth login --persona jun     # dev sign-in; or --token gmx_…
gm clone orbit/engine && cd engine
# edit files…
gm commit -m "Add retry to fetch"
gm push --queue                 # explicitly submit for merge/gates; not landed yet
```

`gm cli guide` prints the whole workflow in one page; it is written to be pasted
into an AGENTS.md.

## Queued pushes

`gm push --queue [--issue KEY_OR_ID ...]` stages the selected commit and admits
it to the repository's default-branch merge queue. It returns a queue ID, not a
claim that main advanced, CI passed or deployment succeeded. Queue submission
is explicit: ordinary `gm push`, `gm push --sync` and native Git pushes remain
available for authorized queue recovery, subject to the pending-rewrite safety
rule below for `gm push`.
There is no automatic direct-push fallback after an admission error. A staging
upload alone does not advance main. `--dry-run` does not upload or admit.

```sh
gm push --queue --issue ENG-1
gm issue checkpoint ENG-1 'Queue: <returned-id>; source: <commit>; local tests: …; landing/deployment pending'
gm queue show <returned-id>
gm queue list --status failed
gm queue wait <returned-id> --deploy --timeout 600
```

Queue IDs are the full 40-hex source commit IDs. After an uncertain network
outcome, inspect that deterministic ID before retrying; preserve local work and
do not assume the source landed. `gm queue` commands accept `-R owner/name`.
`wait` fails on failure, cancellation or timeout; `--deploy` additionally waits
for the final main pipeline, including coverage by a later run. A landed entry
alone is not deployment proof. `gm queue cancel <id>` cancels pending work
without rewinding main; `gm queue retry <id>` retries the same failed/cancelled
source. Changed code needs a new `gm push --queue`. Mutating commands accept
`--dry-run`.

Queued changes remain editable. If you rewrite their **content** while an older
revision is still queued, both `gm push --queue` and ordinary `gm push` refuse
to race that older admission. Either wait for the original to land and run
`gm sync`, or explicitly `gm queue cancel <old-id>` before pushing the rewrite.
Nothing is cancelled automatically. A confirmed failed/cancelled admission no
longer guards the rewrite; do not later retry that obsolete source. Metadata-only
rewrites, unchanged queued revisions and independent descendants remain pushable.
Sync preserves edits made after admission—including removals—while retaining
unrelated newer main work and reporting real conflicts. If rewritten parents
make the admitted revision ambiguous, sync stops without replacing local content;
inspect the reported local/landed revisions and explicitly reconcile the parent
changes before pushing. Admission receipts survive local undo and are scoped to
the normalized API server, repository and source commit, including when origin
switches to a fork or the same repository slug on another server.
A definitive first-request authentication/permission/not-found
rejection releases its receipt; transport and server uncertainty stay guarded.
If the server cannot confirm cancellation, the error identifies the guarded
change and queue ID; an unavailable API does not block unrelated pushes.
Native Git cannot enforce this local guard: cancel or reconcile the older
admission before using native Git to publish a rewrite too.

Checkpoint the queue ID and outstanding verification, keep/renew the issue's
lease, and work on independent, separately claimed work while it runs. Inspect
queue state at work boundaries or the next invocation; do not busy-poll. Use a
bounded wait when deliberately waiting to finish. `gm sync` later reconciles
landed history; queue admission does not mark local commits immutable.
Complete only when the issue's actual acceptance is verified. Include honest
commit, queue, CI and required deployment evidence with
`gm issue complete ENG-1 --evidence '…'`; the evidence argument is optional, not
a waiver of verification, repository gates or approval requirements.

Automatic failures create unassigned, top-level P0 `remediation` issues.
Discover them with `gm issue ready --type remediation --all-teams`; use
`gm issue list --type remediation --all-teams` to include held/blocked issues.
Claim with normal `gm issue claim <issue>` or `gm issue next` in scope; a
listing, missing token or uncertain response never grants ownership. Inspect
`queueFailure` from `gm issue show <issue> --json`, the queue entry, and
`gm runs show <number>` / `gm runs logs <number>` for the reported run. Fix,
verify, queue the new commit with `--issue <remediation>`, checkpoint its ID,
and resolve only after actual landing and required pipeline verification.
Server-owned failure metadata survives tracker snapshots, replication and JSON
output, including additional evidence fields; normal create/update/batch
patches cannot write it. Old issues without this optional metadata still work.
Failures do not block later independent submissions.

Queued push is refused in a timeline or with a bookmark/non-main target. Keep
the timeline push/checkpoint/land workflow: an `approval` timeline requires a
person's approval of its exact current checkpoint. Generic queue admission and
direct-push recovery are not permission to bypass timeline approvals.

## Semantic changes

`gm semantic list` reads the repository's individual syntax-change feed without
replacing `gm diff`, `gm show`, or ordinary Git history. It uses the current
repository, or `--repo owner/name` from anywhere:

```bash
gm semantic list --ref main --limit 30
gm semantic list -R orbit/engine --ref main --path src/client.ts \
  --kind call.added --language typescript -o json
gm semantic list -R orbit/engine --ref main --cursor OPAQUE_CURSOR -o json
gm schema semantic list
```

`--ref` is a server branch, tag or commit OID (default `HEAD`), not an unpushed
local change ID. `--path`, `--kind` and `--language` are exact filters. JSON
preserves the API's versioned `entries`, pinned `head`, `nextCursor` and separate
analysis `coverage`; each entry includes its kind, syntax evidence, commit,
before/after excerpts and source-location links. Text output also reports
coverage and the continuation cursor.

Pages contain changes, not commits. Repeat the same ref and filters with the
returned cursor until `nextCursor` is null—even when a page has no entries.
Starting without a cursor observes the latest head. History follows first
parents; unsupported, binary, oversized and unparsable source is reported rather
than fabricated into semantic events.

TypeScript/TSX, Rust, Python, Go, Markdown, XML, JSON, HTML and CSS are supported.
These are parser-backed syntax facts, not inferred intent or resolved types.
See the [API, adapter contract and limits](../website/README.md#semantic-changes)
and the repository-root `vp run semantic-smoke` for the real server/CLI fixture
verification. The web Changes tab is functional work in progress, not final UI.

## Release notes

`gm release list` shows AI-written **daily updates** on the default branch first,
then named **tag** snapshots, with visible entry counts. Days use UTC Git committer
dates, not authored, tracker completion or deployment dates. `gm release notes
[RELEASE]` prints notes as Markdown, grouped into New, Fixed and Improved. Its
default is the newest day with visible entries, then the newest day; tags are the
fallback only when there are no daily groups. Select a day with `day:YYYY-MM-DD`
or a tag by its literal name. Internal entries (chores, refactors, tooling) are
counted but shown only with `--internal`. Neither kind of notes proves deployment.

```sh
gm release list -R orbit/engine
gm release notes v1.2.0 -R orbit/engine
gm release notes day:2026-10-02 --internal -o json
```

`gm release feed` reads a tracker account's daily code updates across repositories,
latest commit first. Tagged releases (Git tags) are excluded by default to avoid
counting the same changes twice; use `kind:tag` or a positive `release:v1.2.0`
filter to select them. `release:day:2026-10-02` selects a UTC day. `--team KEY`
narrows the feed to one team; other filters include `type:fix repo:engine
since:30d`, `-tag:docs` (issue tags; `label:` is the old spelling), and search
words. The account comes from `--owner`, else `gm tracker use`.
Internal entries are left out unless you pass `--internal` or a `type:` filter.

```sh
gm release feed --owner orbit --team CORE since:2w
gm release feed type:fix -o json
gm release feed kind:tag --owner orbit
```

Entries about issues from trackers you can't read are omitted, and so is any
introduction they shaped. See [release notes](../website/README.md#release-notes)
for how entries are generated.

JSON summaries expose `kind: daily|tag`; entries expose `releaseKind`. Both use
`lastCommitAt` for the latest Git committer timestamp in the group. Stored legacy
notes regenerate lazily on read; check the index's status while generation runs.

## Why a line changed

`gm why src/app.ts:42` follows local blame through the change's timeline,
issues, checkpoints, approval and landing. JSON preserves the complete chain;
`-o text` prints its evidence. Change IDs keep the chain connected across
rebases and amendments.

Queue landings are matched to the exact repository advance and checkpoint.
Their evidence includes the landing ID, checkpoint ID and number, requester
and accountable person, plus this repository's merge and gate run IDs and
numbers. `landing.via` is `queue`, `push` or `unknown`; `landing.queue` is null
without authoritative queue evidence. A `push` means a recorded main ref
update, not proof of a queue landing. Tracker-inaccessible readers get no
tracker provenance. Failed or unfinished advances do not become landings;
in a partially landed timeline, only repositories already advanced qualify.

Each chain also carries the **step** behind its commit (CORE-243): the step
context its agent recorded (why, challenges, instructions and steering with
their coverage, tests), or, for a commit a rebase or landing replaced, the
newest step of its change (`step.commitOid` then names the commit it was
recorded on). Landing merges keep the timeline's commits, so a landed line
still leads to its step. Steps are as readable as the repository; a timeline
commit without one says "no context recorded". On the web, a selected line's
**Why?** shows the same, with a link into the timeline's story.

## Deployments

Gitmatrix deploys nothing; whatever deploys tells it where code went. Inside a CI
job, `gm deploy record` acts as the job (`GITMATRIX_TOKEN`): the server fills in
the repository, source, run, job and commit. The environment is `production`
for canonical default-branch work, `timeline/<slug>` for a timeline's owned
source, or `branch/<name>` for another branch; `--environment` overrides it.
Elsewhere it records as you and needs `--commit`. Records outlive their
previews: tearing one down marks it `expired`.

In a preview run (CORE-79), `GITMATRIX_TIMELINE` and `GITMATRIX_CHECKPOINT`
name the timeline and checkpoint, so `gm deploy record --url "$URL"` files the
preview under them; a revival's record is marked rebuilt. A timeline preview's
expiry follows the org's retention unless `--expires` pins one. `gm deploy list`
shows `(rebuilt)` on revived previews.

```sh
gm deploy record --url "$PREVIEW_URL"                      # in a CI job
gm deploy record --url https://app.example.com --commit @- -R orbit/engine
gm deploy list --run 12
gm deploy update 42 --status expired
gm timeline revive search-v2 -c 3                           # rebuild an expired preview
```

See [deployments and previews](../website/README.md#deployments-and-previews)
for the API.

## Distributed issue tracker

Tracker commands work anywhere, without `gm init` or a Git repository. Accounts and
organizations own trackers; each issue belongs to one team and any number of
cross-team workspaces. Repository subscriptions are associations, not permissions.

```bash
gm tracker list
gm tracker use orbit
gm team create ENG --name Engineering
gm workspace create launch --name Launch
gm issue create 'Search redesign' --team ENG --type prd \
  --description-file design.md --acceptance-file acceptance.md --workspace launch --tag ux --tag frontend
gm issue ready --limit 10
gm issue ready --type remediation --all-teams
gm issue show ENG-1 --limit 20
gm issue update ENG-1 --data '{"priority":1}' --tag search
gm issue tags                            # the tracker's tag catalog, with counts
gm issue link ENG-1 ENG-2 --kind blocks  # FROM blocks TO
gm issue checkpoint ENG-1 '@checkpoint.md'
gm issue evidence ENG-1 'Verified search with the integration smoke'
gm workspace subscribe launch --repo REPOSITORY_ID
gm tracker changes --after 0 --limit 100
```

Use `--owner orbit` to override the saved tracker. `gm schema issue update` and
`gm schema issue batch` describe inputs; JSON patch relationship fields use canonical
IDs, not display keys. `null` clears nullable fields. Description/acceptance file flags
accept `-` for stdin (one field at a time); patch and batch JSON accept `@file` or `-`.
`--dry-run` previews intent without sending/enqueuing mutations. Local preview is not
an authoritative permission, graph or lease validation. Changing the status or parent
of an issue whose lease gm kept (its own or an ancestor's) goes online with that lease's
token, never through the offline outbox. Tracker changes are **not** reversed by `gm undo`.

Tag issues by the expertise their scope requires, using repeated `--tag` flags
(`--label` is the old spelling and still works). Tags come from the tracker's
**tag catalog**: every tag used in the tracker, kept after its last use, listed
by `gm issue tags` and suggested on the web. Reuse its spelling; a new name joins
it. In a new tracker, start from the defaults explained by `gm cli guide` and
the installed graph-work skill: `ux`, `frontend`, `backend`, `data`,
`architecture`, `api`, `security`, `testing`, `infrastructure` and
`documentation`. Pick only relevant areas, not every area touched by routine
verification. `gm issue update --tag NAME` adds one and `--drop-tag NAME`
removes one; `tags` in `--data` replaces the whole list (`labels`, the stored
field's name, still works). `gm issue show` prints a Tags line.

The same catalog serves three roles: an **issue's tags** say what the work is
about; an **agent's tags** (`gm agent setup --tag ux`) say what work it suits;
a **requirement** `tag:ux` means only agents tagged ux may claim the issue.
Tagging an issue never restricts claims by itself. gm warns, and never refuses,
when an agent tag or a `tag:` requirement isn't in the catalog, and suggests the
nearest name. To restrict which agents may claim an issue, use requirements
(below).

### Pickup: whether work may start

Use `gm issue create|update --pickup anyone|not_ready|human_only`:

- `anyone` (default, including legacy issues without the field): ordinary
  dependency, claim and capability rules apply.
- `not_ready`: nobody, including people, may claim or start it until a person
  changes the policy. This is not a dependency or a status.
- `human_only`: authenticated people may work it; agents cannot, including
  assigned agents and delegated agents.

`gm issue ready` is agent-oriented and excludes both restrictions. Agent `next`
also skips them; a person's `next` may select human-only work. `gm issue show`
prints the policy and acting identity's eligibility with an actionable reason.
Pickup applies globally across timelines. Assignment, capability overrides,
direct status changes and completion cannot bypass it. Only a person may change
an existing restricted policy; agents can restrict `anyone`, never self-enable
restricted work. Release an incompatible active claim before restricting pickup.
Offline policy changes and readiness remain advisory until accepted by the server.

### Requirements: which agents may claim an issue

An issue can require capabilities of the agent that claims it (`requires`),
matched against the profile each agent publishes with `gm agent setup` (harness,
model, OS, architecture, runtime, CPUs, memory, tags and skills):

```bash
gm issue create 'Polish onboarding' --team ENG --requires 'tag:ux skill:playwright'
gm issue update ENG-1 --requires 'model:claude-opus-*,gpt-5* os:linux memory>=16GiB cpus>=8'
gm issue update ENG-1 --clear-requires          # remove capabilities, not pickup policy
gm issue update ENG-1 --require-issue-tags      # only agents tagged with its tags
gm issue update ENG-1 --requires 'tag:gpu' --release-claim
```

Terms are `tag:`, `skill:`, `model:`, `harness:`, `os:`, `arch:`, `runtime:`
(comma-separated or repeated values), `memory>=` (B, KiB/MiB/GiB/TiB, the same
as K/M/G/T, or KB/MB/GB/TB) and `cpus>=`. Tags and skills need every value; the
other lists any one; values match case-insensitively and `*` is a wildcard. The
issue stores them as `requires: {tags, skills, models, harnesses, os, arch,
runtime, minMemory, minCpus}` (or null), recorded in its history like any field;
`--data '{"requires":…}'` works too.

- An agent that doesn't meet them can't `claim` or `accept` the issue, can't be
  offered it, and `gm issue next` skips it, reporting how many ready issues it
  skipped (`skipped: {requirements, keys, message}`). A refusal has code
  `requirements_unmet` and names each unmet requirement.
- Tightening requirements on a claimed issue is never silent. When the new ones
  no longer allow the agent holding it, gm prints who it is, its session and
  what it misses (`claimEffect`), keeps the claim and the issue records that;
  `--release-claim` releases it instead (tracker owners and the agent's
  accountable person). `--require-issue-tags` adds a `tag:` term for each of
  the issue's tags.
- `gm issue next` also names the requirements that kept the most ready issues
  from the agent (`skipped.blocking`) and the `gm agent setup` flag that would
  meet them, when the agent really fits that work.
- An agent that never published capabilities meets no requirement: run
  `gm agent setup` (with `--tag`, `--model`) in its checkout.
- People bypass capability requirements, not pickup policy. A person who owns
  the tracker, or the agent's accountable human, can assign despite a capability
  mismatch; pickup still applies and the issue shows `assigneeMismatch`.
- `gm issue show` prints the requirements (`requiresText`) and whether the
  acting identity is eligible (`eligibility`).
- This is eligibility, not authorization: capabilities are self-reported, and
  repository and tracker permissions are enforced as before. Issues without
  requirements behave as they always did.

### Creator and audit history

`gm issue show` displays the immutable creator, including an agent's accountable
person when recorded. Its JSON keeps `createdBy` and a directory-resolved
`creatorDisplay`. Legacy attribution may be unknown; an optimistic offline create
does not invent a creator before the server confirms it.

Existing replicas refresh their confirmed snapshot once on the next online pull
to pick up server-backfilled creators, even when the event cursor has not changed.
The refresh preserves pending operations, request bodies, conflict states and
uncertain receipts; normal sync still replays the outbox first. Offline reads keep
the cached attribution until that refresh. Recovering an older credential replica
also schedules a snapshot refresh.

```bash
gm issue history ENG-1 --owner orbit --limit 50
gm issue history ENG-1 --owner orbit --before 120 --limit 100 --json
gm schema issue history
```

History is authenticated and **online only**; the offline replica is not an audit
archive. Pages are newest first. `--before` is an exclusive cursor: pass the
response's `nextBefore` to fetch the next page, until `hasMore` is false. `--limit`
accepts 1–100 (default 50). Text shows event time, action, source, actor/agent,
accountable person, operation ID, and complete before/after state (including
related comments, requests, and links). JSON preserves the entire server response.
Lease and credential secrets are excluded by the audit API. Unknown legacy
actors/sources remain unknown rather than being guessed.

gm HTTP calls declare `X-Gitmatrix-Source: cli`. This is a provenance hint, not
authentication: recorded actor identity still comes from the authenticated server
session.

Close an issue without completing it by setting `status` to `canceled` and supplying
`closeReason`; there is no separate close command:

```bash
gm issue update ENG-1 --data '{"status":"canceled","closeReason":"duplicate"}'
gm issue update ENG-1 --data '{"status":"todo"}' # Reopen; clears the saved reason
gm issue create 'Obsolete request' --team ENG --status canceled --close-reason obsolete
```

Reasons are `duplicate`, `not_planned`, `obsolete` (no longer needed),
`cannot_reproduce`, and `other`. A reason is required for every new cancellation,
including canceled creation; it is forbidden on other statuses. Reopening or moving
to `done` clears the reason automatically, online and in offline previews. Existing
canceled issues without a reason remain editable, but explicitly clearing a reason
while canceled is rejected. `issue show`, lists, and mutation output include the
saved `closeReason`. Cancellation does not satisfy dependent issues' blockers.

Each issue says whether agents work it in a timeline: `timelineUse` is
`agent_decides` (the default, also for issues from before the field), `required`
or `never`, and `required` may name the `timelinePolicy` (`auto` or `approval`)
the timeline must use. Leaving `required` clears the policy.

```bash
gm issue create 'Migrate billing' --team ENG --timeline-use required --timeline-policy approval
gm issue update ENG-1 --timeline-use never
gm issue update ENG-1 --timeline-policy none # Either policy
```

`gm issue next` and `gm issue claim` return the rule as `timelineRule`
(`use`, `policy`, `guidance`); the text output leads with it.

### Offline replicas and explicit conflicts

Initialize a replica online first. Offline mode is explicit: errors never silently
turn into queued successes. Each mutation gets a stable operation ID and each new
entity a stable random ID; issue keys are `null` until the server assigns a team
number at sync. Use the returned canonical ID to edit or link a new offline issue.

```bash
gm issue create 'Reproduce timeout' --team ENG --offline
gm issue update ISSUE_ID --data '{"description":"Reproduction steps…"}' --offline
gm tracker status --offline
gm tracker sync
gm tracker conflicts
gm tracker resolve OPERATION_ID --strategy reapply-local
gm tracker sync
```

SQLite stores the confirmed snapshot and ordered durable outbox. A process lock
serializes access, writes use full SQLite durability, and HTTP receipts are applied
atomically with dequeue. Lost acknowledgements replay the **same request and ID**;
they cannot be edited/resolved until the server definitively rejects them. Version
conflicts stop replay. `conflicts` shows preserved local intent and remote snapshot.
`reapply-local` explicitly rebases only the head batch; `accept-server` explicitly
discards only that batch. Later operations stay queued and may themselves require
resolution. No automatic last-writer-wins or dependent-edit deletion occurs.

Replicas live under `$XDG_DATA_HOME/gitmatrix/tracker` (default
`~/.local/share/gitmatrix/tracker`), partitioned by server, credential and owner,
with directory mode 0700 and database/lock mode 0600 on Unix. The verified account
ID is pinned before replay, including SSH reauthentication. No auth or lease token
is stored in the tracker database. A rotated token deliberately selects a fresh
partition: old edits remain intact. Before rotation, save `gm tracker status`'s
`replica` path. After signing in again:

```bash
gm tracker use orbit
gm tracker recover /private/old-partition/orbit.sqlite
gm tracker sync
```

Recovery verifies the same server, authenticated account and owner, requires an empty
destination outbox, and atomically moves the original requests/IDs and snapshot.
It never silently imports another identity's work. `tracker status` reports the
partition parent directory to locate retained replicas. Separate `XDG_DATA_HOME`
directories provide independent offline replicas for testing or multiple agents.

### Atomic graphs and fenced agents

`gm issue batch '@plan.json'` accepts 1–100 contract mutations as one atomic batch.
Assign canonical IDs yourself so later entries can refer to earlier creates:

```json
[
  {
    "kind": "issue.create",
    "id": "plan-spec",
    "data": { "teamId": "TEAM_ID", "title": "Specify search", "type": "prd" }
  },
  {
    "kind": "issue.create",
    "id": "plan-code",
    "data": { "teamId": "TEAM_ID", "title": "Implement search", "parentId": "plan-spec" }
  },
  {
    "kind": "link.add",
    "id": "plan-edge",
    "data": { "fromId": "plan-spec", "toId": "plan-code", "kind": "blocks" }
  }
]
```

The server rejects the entire batch for invalid references, authorization or cycles.
Updates include `expectedVersion`; claim mutations are not allowed in the outbox.
Ready means todo (or an expired claimed in-progress issue), no active claim, and
every blocker **done**. Canceled blockers still block. Parent hierarchy does not
implicitly block. `ready` and `show` provide cursor, cached timestamp, bounded
sections and advisory readiness; only an online claim grants exclusive work.

The server automatically assigns an unassigned issue to the identity holding
its claim, including `next` and delegated claims. For an authenticated agent,
that is the agent—not its accountable person or the `--agent` session name.
Existing assignees are preserved; ending a claim does not clear assignment.
Automatic assignment follows the same membership rules as explicit assignment.
Even a tracker admin cannot claim unassigned work in a restricted team unless
the holder (or its accountable person) belongs to that team. Such claims fail
without changing the issue; claiming work with a valid existing assignee preserves it.

```bash
gm issue claim ENG-1 --agent search-agent --ttl 900
gm issue renew ENG-1 --ttl 900
gm issue checkpoint ENG-1 'Implementation complete; verifying edge cases'
gm issue complete ENG-1 --evidence '@verification.md'
# Or: gm issue release ENG-1
```

`--evidence` is recommended, **not required** (CORE-126). It accepts literal text,
`@path` to read a file, or `-` to read stdin:

```bash
gm issue complete ENG-1 --evidence 'Verified the changed consumer; CI run #42 passed'
gm issue complete ENG-1 --evidence '@verification.md'
gm issue complete ENG-1 --evidence - < verification.md
gm issue complete ENG-1
```

Use only the form appropriate to your actual results. Omitting evidence, or
supplying only whitespace, completes without inventing a note. This does not
relax acceptance, lease fencing, repository gates or required human approvals.
Prefer genuine verification results and links over generic assertions.

`gm issue show ENG-1` exposes a dedicated **Completion evidence** section
(`completionEvidence` in JSON), separate from bounded recent `notes`. Evidence
keeps its original actor, timestamp and body even after newer comments push it
out of recent notes, and remains available if the issue is reopened. Historical
evidence is a record of what was verified then, not proof that reopened work is
complete.

Claim/renew/release/complete always require online access. Tokens appear only in
claim/renew responses, never normal list/context/status output or SQLite. gm keeps
the token a claim (or `next`, `renew`, `resume`, `accept`) returns in a private
file per issue beside the identity's replica, never in the replica or its outbox;
lease commands use it when no token is given, and `complete`/`release` delete it.
`--lease-token` or `GM_LEASE_TOKEN` (preferred to a command-line argument that
shell history/process listings may expose) still override it. Each kept lease
records the identity that took it (you, one of your agents, or `GM_TOKEN`).
When gm switches identity, say because a checkout now has its own agent
(`gm agent setup`), new work uses the new identity, but renewing, parking,
handing off, completing or releasing a lease taken earlier is sent as the
identity that holds it (the output says `actedAs`). `gm auth status` lists
previous identities while they still hold leases; a record goes when its lease
ends, or a day after it expires, so an identity with no work left leaves no
trace. An acknowledged `issue ask` that parks a held lease clears its kept expiry
without changing its token or identity, so `auth status` cannot prune it during a
long human wait. `issue resume` stores the fresh token and finite expiry again.
Expired or superseded tokens are rejected even for the same human account.
An ambiguous lease response is an error, not ownership: inspect the issue and do
not start work without a received token.

### Asking the assistant: `gm ask`

`gm ask` puts a question to Gitmatrix's assistant, which reads code and the
knowledge graph, issues, CI runs and packages with your permissions, the way a
DeepWiki MCP answers questions about a codebase, but across everything the
server holds:

```bash
gm ask "Why did run 44 fail?"                          # inside a checkout: about its repository
gm ask -R matrixorg/gitmatrix "Where is readiness computed?"
gm ask --chat CHAT_ID "And who changed it last?"       # follow up
gm ask --write "File a P1 bug in CORE for the flaky clone test"
gm assistant list | show CHAT_ID | delete CHAT_ID
```

People see the answer stream in (status and tool lines on stderr). Agents and
pipes get one JSON object: `{chatId, url, repo, answer, tools, plan, next}`,
where `plan` reports how clef routed the turn (intent, model, tool groups, Code
Mode). It's read-only unless `--write`, since a terminal can't approve each
change; the conversation continues on the web at the printed URL.

### Setting up an agent: `gm agent setup`

One command configures a checkout so a coding agent works through the graph
with nothing but `gm issue next`. Run it in the repository, and again to update:

```bash
gm agent setup                                   # detect the harness; do everything
gm agent setup --model MODEL --tag rust --under ENG-4
gm agent setup --intervention autonomous          # durable requests; continue authorized work
gm agent setup --intervention harness             # retain the harness/factory's own behavior
gm agent setup --check                           # exit 4 if instructions or skills are stale
```

- **Instructions and skills.** It keeps a managed section of the instruction
  file current (AGENTS.md, or the harness's CLAUDE.md/GEMINI.md) and installs the
  `gitmatrix-graph-work` skill where the harness loads skills (`.agents/skills`,
  plus `.claude/skills` for Claude Code). Text outside the markers is untouched.
- **Configuration.** `.gitmatrix/agents.yml` is shared and committed: tracker
  `owner`, default scope (`team` or `under`), lease `ttl`, human `intervention`
  mode, and `instructions` (`file`, and how work `ship`s).
  `.gitmatrix/agent.local.yml` (git-ignored) is this checkout's agent: name,
  harness, model, tags, scope and intervention overrides.
- **Identity and profile.** A new unnamed checkout gets a memorable
  adjective-noun name, kept on reruns; collisions get a random suffix rather
  than reusing an existing identity. `--name` chooses or reuses one of your
  named agents. You remain the accountable person. Setup mints a token and
  keeps it with gm's credentials without printing it, and publishes the agent's
  capability profile (below) with this checkout's harness, model and tags.
  When an agent harness drives gm in that checkout, gm acts as the agent
  (`gm auth status` shows `actingAs`); in your own terminal you stay yourself,
  and `GM_TOKEN` always wins. Run by the agent, it refreshes its own profile.
  `--no-identity` writes only the files.
- **Defaults.** `gm issue next` and `claim` take the session name, scope and
  lease length from these files, and the tracker owner when none is selected.
  `next` only picks issues whose requirements the agent's published profile
  meets (see "Requirements").
- **Your default team.** When neither a flag nor these files name a team,
  `gm issue next`, `create`, `list` and `ready` use the default team you set in
  the web tracker (the star beside a team), synced with the replica and cached
  for `--offline`. Each reports the team it used and why (`team.source`:
  `flag`, `checkout`, `project`, `default`, `scope` or `none`); `--all-teams`
  ignores every default. `gm tracker status` shows `defaultTeam`.

### The Claude Code work card: `gm agent mod`

`gm agent mod` installs a Claude Code mod that shows, in a small card above the
prompt, the gitmatrix issue the session works on: key and title, status,
priority, the lease's time left, the checkout's timeline and the latest
checkpoint. `ctrl+x g` (or `/gm-work`) toggles it; it stays within 46 columns
and 5 rows, so it fits a pane of a four-way split, and never covers the prompt.

```bash
gm agent mod                     # install or update; once per machine
gm agent mod --key 'ctrl+x w'    # another chord (rerun keeps the one bound)
gm agent mod --check             # exit 4 if the installed mod is stale
gm agent mod --remove            # uninstall it and its chord
```

- **Where.** The mod goes in Claude Code's user skills folder,
  `~/.claude/skills/gitmatrix-work` (under `CLAUDE_CONFIG_DIR` when set), which
  Claude Code loads by itself in every new session. The chord is merged into
  `keybindings.json`; other bindings are kept, and a chord already bound to
  something else is refused (`key_taken`). Mods can't declare keybinding
  actions, so the chord borrows `app:toggleDiffPreSession`, idle outside the
  diff panel, and the mod's hidden button answers it.
- **Which issue.** The session's own `gm issue next`, `claim`, `resume`,
  `checkpoint` and `renew` focus the card on that issue; `complete` and
  `release` clear it. Otherwise it shows the newest in-progress issue this
  checkout's agent holds a live claim on. It refreshes every minute while
  shown and after each gm command the session runs (`vp run agent gm` aside).
- **Source.** `assets/claude-code-mod` is the mod as a plugin folder; gm embeds
  it. Its README says how to develop it.

### Autonomous human interventions

`gm agent setup --intervention autonomous` teaches the agent to minimize
interactive interruptions: investigate first, make safe decisions within its
authorization, and record unavoidable questions or blockers on the issue.
`--intervention harness` leaves prompting and scheduling to the agent, harness
or software factory; durable requests remain available without being mandated.
These modes guide the agent; they do not grant permissions, bypass approvals,
keep a harness running, or automatically restart one after an answer.

New project setup defaults to `autonomous`. Existing projects with no
`intervention` setting retain `harness` behavior. On a new project the flag seeds
the shared `.gitmatrix/agents.yml`; on an existing project it saves an override in
`.gitmatrix/agent.local.yml`, without changing other checkouts. Edit the shared
`intervention: autonomous` or `intervention: harness` to choose a repository
default, or remove the local override to inherit it. Rerun setup after editing
either file. `--dry-run` previews the effective mode without persisting it.

Setup refreshes the managed instructions and graph-work skill. `gm issue claim`,
`next`, `resume` and `accept` also return the current
`intervention: {mode, guidance}`, so an agent receives the effective policy when
taking work even if its generated instructions are stale.

```bash
gm issue checkpoint ENG-3 'Checked requirements; need the owner to choose a region.'
gm issue ask ENG-3 --kind decision \
  --prompt 'EU meets latency requirements; US costs less. Recommend EU.' \
  --choice EU --choice US
gm issue ask ENG-3 --kind question \
  --prompt 'Blocked by external DNS ownership. Please confirm the required record is enabled.'
gm request list --issue ENG-3 --status all        # avoid duplicate asks; read answers
gm request list --status answered                # discover resolved questions
gm issue resume ENG-3                            # only once no requests remain open
```

Prompts should include what was tried, the blocker and impact, alternatives
with tradeoffs, a recommendation, and the specific human action needed.
Registered agents' requests appear in their accountable person's **Needs you**
panel by default; `--route-to MEMBER` deliberately routes elsewhere. Use
`--kind approval` for permission and `--kind credential --secret owner/repo:NAME`
for secrets; never put credential values in a prompt or answer.

The request parks a held lease without releasing it or requiring renewal.
Continue independent work only within the user's requested scope; leave
dependent issues blocked. At work boundaries or on the next invocation,
inspect all requests for the issue before resuming: one answered request does
not resolve another open one. If nothing authorized is actionable, checkpoint
and stop cleanly rather than polling or repeatedly prompting.

`gm issue link BLOCKER ISSUE` records a dependency, but a link alone does not
request human intervention. When resolving that blocker needs a person, add
an actionable request on the blocked issue. `gm request list` still defaults to
open requests; `--status answered|canceled|all` includes resolved requests, and
`--issue KEY_OR_ID` narrows any status to one issue.

### Agent capability profiles

```bash
gm agent detect                          # Local metadata; no server or login
gm agent configure search-agent --model MODEL --tag rust --tag linux \
  --skill 'review=Review Rust changes'
gm agent show search-agent
gm agent list --owner orbit              # Profiles visible to this tracker
# With the agent's own write token in GM_TOKEN:
gm agent configure                      # Refresh its own profile
gm agent show
```

`configure NAME` creates or refreshes one of your existing agent identities; it
does not mint credentials or select a lease holder. Without a name, `configure`
and `show` require an agent token and refer only to that identity. People still
mint/revoke tokens through `gm agent token`/`revoke`. `configure --dry-run` shows
the proposed request without publishing it.

Version-1 profiles report the detected harness, OS/architecture, available CPU
parallelism, memory bytes (capped by visible Linux cgroup limits), runtime kind,
tags and skill descriptors. Unknown observations remain null or `unknown`; a
model is never inferred from a harness. Use `--harness`, `--model` and `--runtime`
for explicit declarations, including environments detection cannot identify.
Runtime values are `host`, `container`, `vm`, `wsl`, `cloudflare-worker`, `unknown`.

Skill discovery reads YAML `name` and `description` from `SKILL.md` frontmatter,
not prompts. It scans the repository's `.agents`, `.claude`, `.codex`, `.gemini`,
`.opencode`, `.omp` and `.pi` skill directories (up to the checkout root) and the
same directories in your home, plus `.omp/agent/skills`, `.pi/agent/skills` and
`.config/{opencode,omp}/skills`. Traversal is bounded and cycle-safe; symlinked
skill collections work. Reports contain no skill paths, prompt bodies,
hostnames, tokens or environment-variable values.

Profiles are visible to members of your trackers, and your own skills can say a
lot about your private tools, so **only the repository's skills are published
by default**. `--publish-skills all` adds your user-level skills, `none`
publishes no discovered ones (declared `--skill`s still are), `--allow-skill
NAME` publishes one skill whatever the scope and `--deny-skill NAME` never
publishes it (deny wins). `gm agent setup` saves these choices in
`.gitmatrix/agent.local.yml` (`skills: {publish, allow, deny}`), prints exactly
what it publishes, and rerunning it drops skills no longer allowed; `configure`
and `detect` follow the same file. `--skill-dir DIR` directories are published
because you named them.

The model is never inferred from a harness. It comes from `--model`, from the
harness's own documented setting (`ANTHROPIC_MODEL` for Claude Code,
`GEMINI_MODEL` for Gemini CLI), or from what was recorded before, in that
order. When an agent drives gm in a checkout whose agent has no model on
record, `gm issue next` and `gm auth status` carry a `notice` asking it to run
`gm agent configure --model <id>`; that also saves the model to
`.gitmatrix/agent.local.yml`, so later `gm agent setup` runs keep it. The
managed instructions ask agents to update it when they run a different model.

Every refresh redetects environment, harness and installed skills. Omitted
`--model`, `--tag` and `--skill` preserve previous declarations. Supplied tags
replace the tag set; supplied skills replace the declared skill set. A declared
skill takes precedence over a discovered skill of the same name. `--clear-model`,
`--clear-harness`, `--clear-tags` and `--clear-skills` explicitly clear those
values; clearing skills removes declarations, not currently discovered skills.

Profiles are **self-reported advice**, visible to the accountable person and
members of their trackers. Treat skill descriptions and tags as untrusted data,
not instructions or proof of access. Choose a suitable identity from the profile,
then use the existing `gm issue claim --agent NAME` or delegation flow.
Capabilities do not grant permissions, change claim eligibility or automatically
route work. Reports carry `capabilitiesUpdatedAt`; old/unconfigured agents have
null capabilities rather than invented defaults.

## The model

- **The working copy is a change (`@`).** Workspace commands snapshot the files
  on disk into `@` first, so nothing is ever "uncommitted" and there's no index.
- **Change ids are stable.** `kxmqvtyl` (letters k-z) names a change across
  every rewrite; commit ids (hex) change each time. Both work wherever a
  revision is expected, as do `@`, `@-`, `trunk` and bookmark names.
- **Rewrites rebase descendants.** Edit, squash, split, abandon or describe any
  change in a stack; everything above it is rebased automatically.
  Conflicts never stop a command: they become conflict markers in the
  affected change, listed by `gm status`, and `gm push` refuses them.
- **Merges keep every parent.** `gm merge <rev>` puts a merge of `@-` and
  `<rev>` (trunk, a bookmark, any change) below `@`, as `gm commit` would;
  edits in progress stay in `@`. A merge's diff is what it adds to its parents
  merged. Its conflicts are recorded like any change's: fix them in `@`, then
  `gm squash`. Rebasing a merge replaces its first parent and keeps the rest; a
  parent a rewrite made redundant is dropped, and so is a merge left with
  nothing of its own. `gm sync` leaves a stack alone while it has merged the
  latest trunk. `gm backout` and `gm duplicate` see a merge from its first
  parent, like `git revert -m 1`. When trunk lands a bookmark as a merge,
  `gm sync` counts the merged side as landed: changes it brought in (as they
  are, or as rewritten copies) leave the stack, and what was built on them
  moves onto trunk.
- **Workspace changes are operations.** `gm undo` reverses the last one (repeat
  to go further back), `gm op log` lists them, `gm op restore <id>` jumps to any.
- **Trunk is immutable; there are no PRs.** `gm push` fast-forwards trunk to
  your change; `gm push -b <name>` pushes a bookmark (git branch) instead. In a
  checkout working in a timeline, trunk is the timeline's bookmark (below).

It stays a normal git repository. Bookmarks are branches, HEAD sits on `@`'s
parent (so `git status` and `git diff` show the change in progress), and change
ids live in a `change-id` commit header, the same one jj uses.

## Timelines

A timeline is a separate line of work that lands on main later, automatically
(`auto`) or after a person approves a checkpoint (`approval`)
([current server contract](../website/README.md#timelines)). The account-wide
tracker record owns one work repository per canonical repository, shared by its
agents: opaque `work_<id>`, physical `refs/heads/work`. `timeline/<slug>` is still
a logical overlay/environment label. Work uses canonical permissions, but its
WIP commits stay out of canonical even at landing. Timelines are optional unless
the issue or a person requires one.

```bash
gm timeline start search-v2 --policy approval   # fork from main, then work in it here
gm commit -m "Rank by recency"
gm push                                         # to this source's work ref, never main
gm timeline merge main && gm push               # bring main in, when a person asks
gm timeline use main                            # back to main
```

- **`start <slug>`** forks one through the API: from main, or from another
  timeline with `--from <slug>`. `--name`, `--policy auto|approval`,
  `--experimental` (a marker for timelines not expected to land) and
  `--repo owner/name` (repeatable; default this checkout's repository, or the
  parent timeline's) shape it. The server reserves and forks exact source
  snapshots, then binds this checkout as by `use` (`--no-use` skips binding).
- **`use <slug>`** records `timeline: <slug>` in `.gitmatrix/agent.local.yml`,
  which `gm worktree add` copies. It validates the owned source, fetches through
  `/<owner>/<repo>@<slug>.git`, and moves `@` onto its work head unless already
  based there. A successful fetch pins the immutable source ID under
  `gitmatrix.source-<slug>`; the friendly URL never replaces source identity.
  `use main` explicitly unbinds and selects canonical main; work elsewhere stays
  where it was. Pushing `timeline/*` to the canonical Git URL is refused with
  the corresponding timeline URL, including for legacy branches.
- **A bound checkout treats the owned work ref as trunk.** `gm push` updates
  only `work`; `gm sync` follows that source. Canonical remains reachable as
  `origin/main`. Alternate bookmarks/main and `gm push --queue` are rejected
  (`timeline_bound`): use checkpoint/land, not generic queue admission, to land.
  Missing or migrating source metadata fails closed (`source_migration_required`);
  a canonical legacy bookmark is never a fallback.
- **Ended sources stay guarded.** Push fails with `timeline_ended`, without
  implicitly switching to canonical. After compact landing, `gm sync` uses
  source lineage receipts and exact admitted membership to reconcile the local
  suffix onto current canonical main. Equal change IDs alone do not prove
  inclusion: edited revisions survive, ordinary conflicts remain visible, and
  ambiguous/expired lineage stops rather than discarding work. A real sync
  preserves the previous working-copy commit under
  `refs/gm/source-sync/<sourceId>/<commit>`. Then explicitly start a new timeline
  or run `gm timeline use main`; sync alone does not remove the ended guard.
- **`merge <main|slug>`** fetches canonical main or the other timeline's owned
  source and creates a merge change below `@`, pushed with `gm push`.
  Main is merged in only by a person, or an agent asked to.
- **`list`**, **`show [<slug>]`** read the records and events (fork, merge,
  checkpoint, approval, landing, abandon); `*` and `current` mark this
  checkout's timeline. `list --stalled` shows open timelines with no push for
  the account's idle period (7 days unless the account changes it), leaving
  experimental ones out: stalling is expected of them.
- **`update [<slug>]`** (or **`flag`**) renames it (`--name`) or sets and clears
  the experimental flag (`--experimental`, `--no-experimental`). The flag marks
  a timeline that isn't expected to land; it restricts nothing, so its work
  still merges into any timeline and it can still land. Any writer may change
  it.
- **`abandon [<slug>]`** ends writes and archives owned history read-only;
  its events and any successful partial integration receipts stay. The server
  allows only its accountable person or the agent that started it. Other
  checkouts still bound to it retain the ended-source guard.
- **`revive [<slug>] [--checkpoint <number|id>]`** rebuilds a checkpoint's
  preview (default: the newest checkpoint), for example to look into last
  week's work after its preview expired: Gitmatrix starts a preview `create`
  run in each repository whose ci.yml opts in (`on: preview`), at the
  checkpoint's commits, including retained landed/abandoned sources. Expired
  sources fail explicitly rather than checking out canonical. The record it
  makes is marked rebuilt (`revived`, `rebuiltFrom`), since the toolchain or
  seed may have changed. Needs write access to every repository.
- **`migrate [<slug>]`** converts legacy active/experimental canonical bookmarks
  to pinned owned sources; completed timelines instead gain historical provenance.
  After conversion run `gm timeline use <slug>`, make a new checkpoint and renew
  approval. In-flight legacy landing must settle first. Inspect `timeline show`,
  then resolve a stopped unadvanced landing with
  `gm timeline migrate <slug> --resolve cancel-unadvanced --expected-version <version> --note "<reason>"`.
  A stopped partial landing requires `--resolve accept-partial-and-abandon`
  with the same version/note; it preserves successful receipts and abandons the
  timeline. Resolution does not itself convert: run plain `migrate` afterward.
- **`pushes [OPERATION] [--timeline SLUG] [--repo OWNER/NAME]`** lists pending
  writes for the timeline's exact owned source, or inspects one retained operation,
  including its terminal outcome, original commands, attribution and recovery audit.
- **`recover-push OPERATION [--timeline SLUG] [--repo OWNER/NAME]`** recovers
  that exact interrupted write; retry the same ID after a lost response. Selection
  defaults to the current timeline binding and canonical checkout origin; explicit
  selection also works outside a checkout and never changes bindings. The server
  must prove acceptance or permanently fence the old write before rejecting it:
  an unchanged old head is not proof of rejection. Recovery may append a unique,
  same-tree fence commit to the owned source, never canonical. The result reports
  `state`, `sourceId`, `operationId`, `recoveryId`, the proven `head`, `fenceCommit`,
  and `syncRequired`. When sync is required, run normal **`gm sync` in the matching
  timeline checkout before retrying publication**; never force-push to undo the
  marker. Neither command changes local commits, files, refs or bindings.
  `--dry-run` resolves the source but performs no recovery. Unproven recovery
  remains an error, not a success; ended/expired sources are never reactivated.
  Ordinary Git failures retain recognized HTTP status and transport diagnostics,
  without printing credential-bearing URLs, traces or raw server bodies.

Landing applies the approved B→T tree delta (explicit logical base to approved
work) onto pinned canonical O. It gates one-parent compact candidates for all
repositories before advancing any main, or records no-op receipts for unchanged
trees. Main movement requires re-preparation/re-gating. There is no cross-repo
transaction; partial retry/cancellation preserves successful receipts without
replaying or rewinding them. Nested work must be covered by exact integrated
ancestry; ambiguous foreign dependencies require reviewed sync/rebase.
Ended work Git is read-only, then expires after 30 days landed or 90 days
abandoned by default (`timeline-work-sources.landedDays` / `abandonedDays`).
Both durations and enablement are configurable in Data retention, independently
of Tracker detail, published wiki and preview expiry. Live dependencies and
unacknowledged consumers delay deletion. A purged source returns explicit expiry.

`--owner` picks the tracker account; by default it's `.gitmatrix/agents.yml`'s,
else origin's owner. Every command takes `--dry-run` and prints JSON for agents.
`GM_TIMELINE=<slug>` works in a timeline for one command, over the binding
(`GM_TIMELINE=main` for main); `profile::timeline()` is what other commands
read to know the timeline they act in. Tracker commands (`gm issue …`) default
`--timeline` to it, so a bound checkout reads the timeline's view and its
changes are made in the timeline.

## Steps: context for every commit

An agent commits at meaningful steps and says what drove each one: the
instructions it followed, how a person steered it, why it did the work this
way and what got in the way (CORE-226). Everyone who can read the repository
sees it beside the commit.

```bash
gm step -m "Rank by recency" --context step.md     # in a timeline: gm test, commit, push
gm commit -m "Rank by recency" --context step.md   # or by hand; --context - reads stdin
gm push                                             # uploads it for the pushed commits
gm context sync                                     # retries uploads a push couldn't make
```

- **`gm test`** runs the repository's fast checks: the jobs in
  `.gitmatrix/ci.yml` that join step runs (`on: step`) and are marked
  `local: true` (CORE-235). They run with bash in this checkout, in `needs`
  order, with the pipeline's and job's `env:` plus `GITMATRIX_TRIGGER=step` and
  `GITMATRIX_LOCAL=1`. Output streams to stderr; the result (each job's status,
  exit code, duration and last line of output) goes to stdout, and the command
  exits 1 when a job fails. A job that needs a failed job, or one that doesn't
  run locally, is skipped. The results are kept for the working copy's tree, so
  the next `gm commit --context` of exactly that tree carries them as the
  step's tests.
- **`gm step -m <summary> [--context <file|->] [--no-test]`** records a step of
  a timeline in one command: `gm test`, then commit with the context and the
  test results, then push to `timeline/<slug>`. Failing tests don't stop it:
  the step records them, with a warning. Outside a timeline it refuses
  (`not_in_timeline`); use `gm commit` and `gm push` there.

- **`--context <file|->`** takes Markdown with `## Instructions`, `## Steering`,
  `## Why` and `## Challenges` sections (bullets become entries), or a JSON
  object with those fields (`instructions`, `steering`, `why`, `challenges`,
  `tests`, `coverage`, `harness`, `model`; others are dropped). Context that
  has none of them fails before anything is committed.
- **It's journaled locally first**, in `.git/gm/steps/<commit>.json`, after
  known token shapes, private keys, `Bearer` values and `*_TOKEN=`/`*_SECRET=`
  style assignments are redacted. Rewriting the commit (`describe`, `squash`,
  rebases) carries the context to the new commit through its change ID.
- **`gm push` uploads** the context of the commits it pushed, once each.
  `gm push --queue` also uploads the selected source commits' context after
  admission succeeds; neither admission nor a context upload means they landed.
  A failed context upload never fails the push or admission: it warns, and
  `gm context sync` sends what's still pending. Failed or uncertain admission
  leaves context pending locally for an admission retry or `gm context sync`.
- **Missing context warns, never blocks.** An agent's commit in a timeline
  without `--context` succeeds with a warning saying what to add.

- **`gm steps [--timeline <slug>] [-n N]`** lists a timeline's recent steps in
  this repository (default: the timeline this checkout works in);
  **`--follow`** streams new ones live as they're pushed (CORE-239): one JSON
  object per line for agents (`StepFeedRecord`), a line of text at a terminal.
  It reconnects from the last step it printed; `--count N` stops after N, and
  a feed the reader can't see is an error rather than a retry.

- **Harness hooks** capture what the person tells the agent (CORE-241). For
  Claude Code, `gm agent setup` adds a `UserPromptSubmit` hook to
  `.claude/settings.json` (`gm hook claude-code`, run only if gm is
  installed). In a checkout working in a timeline it appends each prompt,
  redacted, to the journal's `pending.json`: a session's first prompt as an
  instruction, later ones as steering. The next `gm commit --context` or
  `gm step` puts them first in its instructions and steering, marked `hook`,
  sets coverage to `hook:claude-code` and clears them. The hook never prints
  (Claude Code would add its output to the conversation) and never fails a
  prompt. Without a hook, the agent records them itself (`agent`), and the
  Story notes that some context may be missing.
- **Codex and Oh My Pi** use the same contract (CORE-242), each under its own
  harness id. For Codex (0.114+), `gm agent setup` adds the same
  `UserPromptSubmit` hook to `.codex/hooks.json` (`gm hook codex`); Codex runs
  a project hook only once the person trusts it (`/hooks` in Codex), and it
  too adds hook output to the conversation, so the hook stays silent. For Oh
  My Pi, setup writes `.omp/extensions/gitmatrix-steps.ts`, an extension whose
  `input` handler (each submitted message, steering typed mid-turn included)
  hands the text to `gm hook pi`. Oh My Pi raises `input` for the
  interactive prompt and RPC sessions, not for one-shot print mode (`omp -p`),
  so those prompts aren't captured. Coverage names the harness whose hook ran
  (`hook:codex`, `hook:pi`); a harness whose hook didn't run is never claimed.

Reading it back, for an agent picking up the work or a person investigating:

```bash
gm context show [<rev>]     # one step's context (default @-): JSON for agents, text at a terminal
gm log --context            # each step's why beside it (`steps`, keyed by change ID, in JSON)
gm show <rev> --context     # the change, its context, then its diff
```

Reads ask the server for the shown commits in one call and fall back to this
checkout's journal. A step's `origin` says which: `server` (with its author,
and `verified` once a push showed the commit) or `local` (not pushed, never
verified). When the server can't be reached, `note` says so and the local
context is shown. A step without context reads as `step: null`.

Timeline reads/uploads keep the owned source identity while contexts retain their
canonical repository/change-ID/commit keys and author rules. Compact canonical
landings link through integration receipts to the full WIP steps; `gm why` and
release notes use that provenance rather than a second merge parent. Missing,
ambiguous or expired source evidence is not guessed from matching change IDs.

## Environment settings

Discover the quota controls with `gm settings environments --help`. Both the
installation-wide cap and this OS user's per-machine cap default to **4**;
raising the local cap cannot override the installation cap.

```bash
gm settings environments show --local
gm settings environments set --local --max 4 --authority https://YOUR-GITMATRIX
GM_SERVER=https://YOUR-GITMATRIX gm settings environments show --site
GM_SERVER=https://YOUR-GITMATRIX gm settings environments set --site --max 4
```

Choose exactly one scope: `--local` manages this user's machine settings across
worktrees, while `--site` addresses the current `gm` server. Local `set` accepts
`--max`, `--authority`, or both; site `set` takes `--max` and requires a signed-in
**human site administrator**. Zero pauses new allocations; lowering a cap does
not evict existing environments.

Configure the same explicit authority on every participating host. Existing
environments pin that authority; missing configuration/API/authentication fails
closed, with no implicit selection from scoped credentials or offline fallback.
For canonical configuration, legacy adoption/drain, failed/expired/orphan capacity
and cleanup recovery boundaries, read
[environment limits and quota authority](../../README.md#environment-limits-and-quota-authority)
and [cleanup and cost bounds](../../README.md#cleanup-and-cost-bounds).

## Automatic AI settings

```bash
gm settings ai show --owner orbit
gm settings ai set --owner orbit --knowledge off
gm settings ai set --owner orbit --wiki on --atlas on --release-notes off
gm settings ai set --owner orbit --classification clef \
  --fast gemma-4-26b-a4b-it --task glm-5.3-flash
gm settings ai set --owner orbit --task gemma-4-26b-a4b-it --dry-run
gm settings ai set --owner orbit --knowledge-quiet-minutes 15 --knowledge-max-wait-minutes 60
gm settings ai set --owner orbit --log-bodies assistant=off --log-bodies avatars=default
gm settings ai show --site
gm settings ai set --site --log-bodies on
```

**Gateway logs** (`--log-bodies`): AI Gateway always logs each model call's model,
time and tokens; "Keep AI request and response bodies in gateway logs" also keeps
what was sent and returned. It is set per component (`knowledge`, `assistant`,
`assistant-titles`, `avatars`, `release-notes`, `merge-queue`): `--log-bodies
on|off|default` sets every component, `COMPONENT=on|off|default` one (repeatable,
later values win). An account's choice applies to that account's calls; `default`
follows the site. `--site` (site administrators, people only) sets the site default
and takes only `--log-bodies`; there `default` follows the environment (deployed:
off; development and agent environments: on). `show` lists each component's site
value, the account's override and the effective value, with this note: while on,
prompts and replies, including repository code and assistant conversations, are
kept in Cloudflare's AI Gateway logs, readable by the Cloudflare account's
dashboard users, and deleted oldest-first. Changes reach new model calls within a
minute.

These are account-wide settings, not repository settings. Omit `--owner` to use
the authenticated person's own account; the current repository's owner is never
inferred. `show` includes the curated catalog, prices, release dates, permissions
and save provenance. `set` requires at least one option and changes only supplied
fields. Feature values are `on|off`; Classification accepts `clef` or a
`typesafe:<model>` the account added in **Settings → AI providers**; Fast and
Task allow `glm-5.3-flash|gemma-4-26b-a4b-it` or an added `openrouter:<model>`
(for example `--fast openrouter:google/gemini-3-flash`). The server refuses a
provider model the account hasn't added. Defaults are all features on, Clef,
and GLM 5.3 Flash for both generation roles. `--knowledge-quiet-minutes` and
`--knowledge-max-wait-minutes` (0-1440, defaults 10 and 30) say when pushes to a
repository's default branch update its Knowledge: once they pause that long, and
never later than the longest wait after the first pending push.

Only human account owners, organization owners and site admins can save; members
can inspect and agent credentials cannot write. Knowledge off also prevents new
Wiki and Atlas AI work; Atlas's structural projection is separate from its paid
descriptions. Agent chat and interactive search are unaffected.

Changes apply to newly admitted jobs. Running jobs and their retries retain their
policy; old content and cached output remain readable. Saving does not trigger a
rebuild, and enabling a feature resumes it on normal triggers or explicit requests.
`--dry-run` with an explicit owner prints the PATCH request without network access.
Settings mutations are not part of `gm undo`. The equivalent web page is
`/settings/ai?owner=orbit`.

## Data retention

```bash
gm retention show --owner orbit                  # categories, switches, thresholds, last run
gm retention set ci-logs --enable --threshold days=14
gm retention set ci-runs --reset keepLatest      # inherit the site-wide default again
gm retention set timeline-work-sources --threshold landedDays=30 --threshold abandonedDays=90
gm retention run ci-logs ci-runs --dry-run       # preview what a cleanup would delete
gm retention run ci-logs --yes                   # clean up now and wait for the result
gm retention runs                                # history; `gm retention runs 12` for one run
gm retention show --site                         # site categories and site-wide defaults
```

The same policies, cleanup runs and history as the Data retention settings
pages. Policy categories are opt-in except `timeline-work-sources`, enabled by
default at 30 days landed / 90 days abandoned; active categories always run.
Scheduled cleanups apply the effective policy. Omit `--owner` for the signed-in
person's own account; `--site` covers site categories and site-wide defaults
(site administrators).
`--inherit` and `--reset <key>` remove this level's value so it inherits again.
`run` takes any categories with a cleanup, enabled or not, and per-run overrides
(`--threshold category.key=value`). With `--dry-run` the server previews the run
without deleting; a real run requires `--yes`. `run` waits for the result unless
`--no-wait` (exit 4 when it fails). Only account owners (people, not agents) and
site administrators change settings or start runs; nothing here is part of
`gm undo`.

## Built for agents, like `cf`

The design follows Cloudflare's agent-first `cf` CLI:

- **One manifest.** `src/meta.rs` adds git equivalents, search keywords, output
  types and examples to the clap definitions in `src/cli.rs`. That manifest
  drives `--help`, `gm cli search`, `gm cli commands` and `gm schema`, and a
  unit test keeps it in sync with the CLI.
- **Discovery.** When an agent harness is detected (`CLAUDECODE`,
  `CODEX_THREAD_ID`, `CURSOR_AGENT` and so on, or `GM_AGENT=1`), help output starts
  with a banner pointing at `gm cli search "<task>"`, which returns the top 5
  commands as JSON, each with its git equivalent.
- **Schemas.** `gm schema <command>` gives the arguments, options and a JSON
  Schema of the output, generated from the Rust output types.
- **Output.** Compact JSON for agents and pipes, text at a terminal; override
  with `-o json|pretty|text`.
- **Errors.** JSON on stderr, `{"error":{"code","message","hint"}}`, with exit
  codes 1 error, 2 usage, 3 not found, 4 needs a decision (conflict, remote
  moved, missing description), 5 auth.
- **Safety.** Worktree add/remove support `--dry-run`, but are not reversed by
  `gm undo`. Workspace edits have their own undo log in each worktree.
- **Concurrency.** Mutations are serialized across the repository; each
  worktree keeps its own working copy, index, conflicts and operation log.

### Clone progress

`gm clone` reports live progress on **stderr**, leaving stdout as the single
final clone result. Text mode shows Git's transfer counters and byte/rate
information when available, followed by workspace initialization and completion.
Use `gm clone orbit/engine --quiet` to suppress progress; results and errors remain.

In JSON and pretty modes, stderr carries compact newline-delimited events:

```json
{
  "event": "clone.progress",
  "phase": "receiving",
  "elapsed_ms": 1389,
  "message": "Receiving objects:  18% (7/38)",
  "percent": 18,
  "current": 7,
  "total": 38
}
```

Phases are `connecting`, `enumerating`, `counting`, `compressing`, `receiving`,
`resolving`, `checkout`, `initializing`, and `complete`. Git determines which
transfer phases occur; other Git/server messages use `git` or `remote`.
Counters are omitted when unavailable and describe the current phase, not an
overall completion estimate. Updates within a phase are throttled to one per
250 ms, except phase completion; phase changes report immediately.

Read agent stderr as JSON lines: progress has `event: "clone.progress"`, while
a failure ends with the existing `{"error": ...}` envelope and a nonzero exit.
No `complete` event is emitted on failure. Callers that need stderr to contain
only the final error document can pass `--quiet`.
Authentication errors are identified from explicit HTTP or credential diagnostics,
not numbers in progress counters or repository URLs. An interrupted pack transfer
(such as early EOF) remains `git_failed` with exit code 1, not a sign-in failure.

## Commands

|             |                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Inspect     | `status`, `log`, `show`, `diff`, `file show`, `file list`                                                                                 |
| Semantics   | `semantic list [--repo owner/name] [--ref ref] [--cursor cursor] [--path path] [--kind kind] [--language language] [--limit N]`           |
| Change      | `commit`, `describe`, `new`, `squash`, `split`, `edit`, `abandon`, `restore`                                                              |
| Restructure | `rebase`, `backout` (revert), `duplicate` (cherry-pick)                                                                                   |
| History     | `undo`, `op log`, `op restore`                                                                                                            |
| Bookmarks   | `bookmark list`, `bookmark set`, `bookmark delete [--remote]`                                                                             |
| Remote      | `clone`, `init`, `fetch`, `sync` (pull), `push [--sync] [-b name]`                                                                        |
| Timelines   | `timeline start/list/show/use/merge/abandon`                                                                                              |
| Worktrees   | `worktree add <path> [-r revision] [--include]`, `worktree list`, `worktree remove <path> [--force]`                                      |
| Server      | `auth login [--ssh]/status/logout`, `repo list/create/view/delete`, `repo mirror show/set/sync/remove`, `api`                             |
| SSH keys    | `auth ssh-key add/list/remove`, `auth git-credential` (git helper)                                                                        |
| CI          | `runs list/show/logs/wait/start/cancel/rerun`, `runner`, `secret`                                                                         |
| Retention   | `retention show/set/run/runs` (`run --dry-run` previews a cleanup)                                                                        |
| Packages    | `pkg list/show/versions`, `pkg delete/yank/restore/deprecate/tag`, `pkg sources/grant/revoke`, `pkg published`, `pkg upload`, `pkg setup` |
| Discovery   | `cli search`, `cli guide`, `cli commands`, `schema`                                                                                       |

## CI results and candidate verification

Use `gm runs show <number>` to inspect a run and `gm runs wait` to wait for the
commit's complete run; `gm runs logs <number> --job <name>` reads actual job output.
An explicitly opted-in `verification: context-invariant-v1` gate can be satisfied
by a successful sandbox job for the same canonical repository, candidate commit,
queue attempt, specification and current known image digest/Worker version.
This is an author assertion of context independence, not automatic matching-OID
caching. Local runners, secrets, custom images and concurrency-controlled jobs do
not qualify; failed or unknown verification falls back to execution.

`show` and `wait` distinguish **Verified (not executed)** from normal **Skipped**.
JSON preserves the public `skipped` status plus `verifiedBy` provenance, linking
the producer run/job, candidate commit and queue attempt. Proposed proofs are not
public verification until runtime consumption revalidates them and dependencies
permit the gate. No consumer logs or execution duration are invented: read the
producer's output instead. Independent main jobs and deploy remain, dependencies
still gate execution, and `wait` reports the actual whole-run result.
Path filtering can still produce ordinary **Skipped** jobs: this repository's
`cli` gate selects changes under `apps/cli`. A skipped candidate job is not
verification evidence. Check the **Verified** label or non-null `verifiedBy`,
not the `skipped` status alone.
See the [CI/CD contract](../website/README.md#candidate-verification-reuse).

## Local CI storage

`gm runner` uses `--workdir`, or `$XDG_CACHE_HOME/gitmatrix/runner` (falling back
to `~/.cache/gitmatrix/runner`), for job storage. Each attempt gets a fresh
`jobs/<attempt>/repo` checkout; cleanup removes it and its package credentials
before reporting the terminal result, including failed jobs.

Cargo compiler outputs persist under `cache/<scope>/slot-N/target`. The scope
hash includes the canonical server, repository and job name; active jobs lease
different slots so they cannot replace one another's running binaries. Later
jobs reuse released slots. Cargo still checks source/dependency freshness, and
tests always run. Explicit job or inherited `CARGO_TARGET_DIR` bypasses managed
caching unchanged; its lifetime and concurrency remain the caller's responsibility.

`GITMATRIX_CI_ARTIFACTS_DIR` is an absolute private directory under
`artifacts/<scope>/<attempt>`, retained after checkout cleanup. Its path is printed
in setup logs. Producers must write sanitized reports only; the runner does not
copy files from the checkout or provide remote artifact upload. The agent harness
exports only its allowlisted redacted JSON reports. Local cache/report directories
remain until removed by their owner; do not remove cache slots while jobs are active.

## Worktrees

Create parallel working directories without cloning objects or sharing
working-copy state:

```bash
gm worktree add ../feature --include
gm -C ../feature status
gm -C ../feature commit -m "Implement feature"
gm worktree list
gm worktree remove ../feature
```

`add` creates a detached Git worktree and initializes gm there. It defaults to
a **new change on the source checkout's current `@` snapshot**, including
pending source edits. Pass `-r trunk`, a bookmark, a change id or a commit id
to choose another base. Paths are relative to `--cwd`; creation also works
from a linked checkout or its subdirectories. The source must be initialized
with `gm init` or `gm clone`. Existing worktrees created with Git can be
adopted independently with `gm -C <path> init`.

Objects, remotes and bookmarks are shared. Working-copy changes, files,
conflicts and undo logs are independent. Undo/operation restore preserve
bookmark updates made elsewhere since this worktree last observed them.
gm refuses to move a branch checked out in a plain-Git worktree.
Repository-wide mutation locking and shared retention refs protect concurrent
gm operations and keep snapshotted history alive through Git GC.

### Include local configuration

`--include` opts into the source checkout's root `.worktreeinclude`, using
the [same gitignore pattern syntax as Claude Code](https://code.claude.com/docs/en/worktrees#copy-gitignored-files-into-worktrees):

```gitignore
# Copy ignored local settings, not tracked files.
.env
.env.local
config/secrets.json
cache/
!cache/private/
```

Blank lines, comments, negations, rooted patterns and `**` are supported.
Only matching **ignored, untracked regular files** are copied, with file
permissions preserved. Without `--include`, nothing is copied; a missing
include file is a no-op. Matching is rooted in the checkout where the command
runs, not always the main checkout.

gm rejects symlinks and metadata/traversal paths, and never overwrites an
existing destination entry or tracked path. Unlike Claude's documented
ignored-directory traversal optimization, `**` matches throughout ignored
directories. If copying or initialization fails after creation, the worktree
is kept and the error reports how to inspect/remove it.

Dependencies and setup commands are **not** run automatically. For pnpm
projects, enable `virtualStoreType: global` and install inside the new worktree;
do not copy `node_modules`. This repository's root `.worktreeinclude` selects
ignored environment files but excludes local database state and dependencies.
Only use secret copying and a writable shared package store within the same
trust boundary.

### Preview, removal and recovery

`gm worktree add ../feature --include --dry-run` lists the selected base and
files without snapshotting or creating the worktree. Its `@` is the last
stored snapshot, so unsnapshotted source edits can change the actual base.
`worktree list` includes main, bare and plain-Git worktrees and reports current,
initialized, locked and prunable state without snapshotting them.

Removal refuses the main checkout, the checkout containing the current
directory, locked worktrees, and modified/untracked/**ignored** files.
`--force` explicitly discards files, including copied secrets; it does not
override locks. `--dry-run` checks removal safety without removing anything.
Creation/removal themselves are not undoable.

Before removal, gm archives its recorded views and operation log beneath the
common Git directory's `gm/removed-worktrees/<id>/` and retains referenced
commits under `refs/gm/removed-worktrees/<id>/`. The command returns
`recovery_path` and `recovery_ref_prefix`. To recover a recorded working copy,
read `wc` from that archive's `view.json`, then run
`gm worktree add ../recovered -r <wc-commit-id>`. This starts a fresh change
on the recovered snapshot. Ignored files and edits never snapshotted by gm
are not in the archive. Retained history has no automatic expiration.

## Signing in with SSH keys

`gm auth login --ssh` signs in with an SSH key instead of a stored token, over
HTTPS: gm signs a one-time challenge from the server (SSHSIG) and gets a
one-hour session, renewed with the key when it runs out. Keys come from where
ssh finds them: the `IdentityAgent` in `~/.ssh/config` (1Password and other
agents), `SSH_AUTH_SOCK`, then key files (with a passphrase prompt at a
terminal). Register a key with `gm auth ssh-key add`; `gm auth ssh-key list`
shows what gm can see locally and what the server knows. See `src/ssh.rs`.

When git is set up to use another ssh, gm follows git instead. In WSL with
1Password on Windows that's `git config --global core.sshCommand ssh.exe`: gm
lists keys with `ssh-add.exe -L` and signs with `ssh-keygen.exe -Y sign`
(or `gpg.ssh.program`, e.g. `op-ssh-sign-wsl`, if you sign commits with it),
so 1Password's prompt appears on Windows. `user.signingKey` counts as a key
too, and `gitmatrix.sshCommand` sets the ssh for gm without touching git.

## Downloading artifacts and installing Unix CLIs

```sh
gm pkg download gm/latest/linux-x86_64/gm --owner orbit --dest ./gm
gm pkg install gm --owner orbit
gm pkg install gm --owner orbit --force
gm pkg install gm --owner orbit --version <apps/cli-tree-id> --bin-dir ./bin
```

`download` accepts `<name>/<version>/<path>` in the generic registry. Its default
destination is the artifact's basename. `install` defaults to
`$HOME/.local/bin/<name>` and selects `<os>-<arch>/<name>` within the version
(for example `linux-x86_64/gm` or `macos-aarch64/gm`). `--file` selects a different
artifact path. These are direct executable files, not archives or installer scripts.

Both commands use the normal Gitmatrix credentials, resolve `latest` once, and
verify SHA-256 while streaming to a temporary file beside the destination.
Installation sets mode `0755`. Only a verified complete download is atomically
published; `--force` is required to replace an existing regular file, including
a running `gm` binary. Symlinks and nonregular destinations are refused.
`--dry-run` checks remote metadata without creating files or directories.
Add the bin directory to `PATH` yourself; no shell configuration is edited.

The `matrixorg/gitmatrix` pipeline on gitmatrix.fward.dev publishes Linux x86-64 and ARM64 release
binaries as `gm/<apps/cli tree id>/<os>-<arch>/gm`: the git tree id of the CLI's
source (`git rev-parse HEAD:apps/cli`, `Cargo.lock` included). The same source
always has the same version, so unrelated pushes and reruns reuse the existing
artifact, and finding it needs only the checked-out commit, not history. Each
publish records the commit and CI run it came from. Publication runs in the
`deploy` job on `main`, after its required gates pass; deploy is not verification
reuse. Authoritative registry HEAD requests check each platform first, and builds
run only for missing artifacts. The x86-64 CI host publishes `linux-x86_64/gm` and
cross-compiles `linux-aarch64/gm` with `aarch64-unknown-linux-gnu` and Debian
Bookworm's ARM64 GNU toolchain. `GITMATRIX_CLI_PROVISION_ARM64=1` explicitly opts
into provisioning that toolchain, only after the HEAD results establish that ARM64
is missing. Complete releases and native-only gaps skip ARM tool setup; failed
registry checks are not treated as absence. All required builds finish before any
upload starts; reruns fill missing artifacts without replacing published ones.
The native binary uploads both architectures.

On a Raspberry Pi running 64-bit Raspberry Pi OS Bookworm or newer, use
`gm pkg install gm --owner matrixorg` (add `--force` to update). It automatically
selects the ARM64 binary. The release requires glibc 2.36 or newer; it does not
run on a 32-bit Raspberry Pi OS or musl-based Linux. To bootstrap without `gm`,
build from source with `vp run cli#build`, then use the resulting release binary.
For manual cross-builds, install `gcc-aarch64-linux-gnu` and `libc6-dev-arm64-cross`,
run `rustup target add aarch64-unknown-linux-gnu`, and set
`CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc` and
`CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc` when building with
`cargo build --locked --release --manifest-path apps/cli/Cargo.toml --target aarch64-unknown-linux-gnu`.

To bootstrap from an older `gm` without these commands, use
`./apps/cli/target/release/gm pkg install gm --owner orbit` after a local release
build. For feature validation, always pass an external disposable `--bin-dir`
instead of replacing a shared/global binary.

## Layout

- `src/repo/`: the change model on git. `mod.rs` holds the workspace:
  snapshot, rebase engine, checkout, op log. `revset.rs` resolves revisions.
  `trees.rs` merges trees and writes them to disk. `view.rs` is the stored state
  in the checkout's Git administrative directory under `gm/` (`.git/gm/` for
  the main checkout, `.git/worktrees/<name>/gm/` for linked worktrees).
- `src/commands/`: local commands, worktree lifecycle/include copying,
  network commands (clone, sync, push), timelines and server commands.
- `src/meta.rs`, `src/cli.rs`: the manifest, search, schema and guide.
- `tests/flow.rs`: end-to-end tests against a local bare remote.

libgit2 (vendored, through `git2`) implements the change model. The `git` binary
handles worktree lifecycle and ignored-file enumeration, plus fetch and push
with the token passed through `GIT_CONFIG_*` so it never appears in `ps`.
Credentials live in `~/.config/gitmatrix/gm.json`; `GM_SERVER` and `GM_TOKEN`
override them. Inside a CI job, `GITMATRIX_URL` and `GITMATRIX_TOKEN` are used
when those aren't set, so `gm pkg upload` and `gm pkg published` act as the job.

For Cloudflare Access-protected previews, supply `GITMATRIX_ACCESS_TOKEN` in
the process environment as JSON containing the nonempty strings
`cf-access-client-id` and `cf-access-client-secret`, and set
`GITMATRIX_ACCESS_ORIGIN` to the exact preview HTTPS origin (no path, query,
userinfo, or wildcard). HTTP is accepted only for localhost test servers.
Both variables are required together; malformed settings fail without printing
their values. `gm` does not load `.env` files automatically.

The CLI sends the two standard `CF-Access-Client-Id` and
`CF-Access-Client-Secret` headers only to that origin, alongside—not instead
of—the Gitmatrix `Authorization` token. This covers JSON, device/SSH sign-in,
streamed responses, uploads, downloads, and Git clone/fetch/push. Access
credentials are never saved in `gm.json`, remote URLs, or Git configuration.
Git receives them through ephemeral `GIT_CONFIG_*` environment entries; Git
tracing is disabled for these subprocesses to avoid logging headers.

Protected HTTP requests do not follow redirects, even within the same origin.
With Access configured, Git subprocesses also reject all HTTP redirects,
overriding existing URL-specific redirect settings: Git's custom headers are
scoped to the initial URL, not a redirect destination. Use canonical repository
URLs rather than redirecting aliases. Other origins receive no Access headers.
When neither Access variable is set, ordinary production behavior is unchanged.
As with any environment secret, run only trusted local executables/helpers;
process environments are not a security boundary against the same OS user.

## Develop

```bash
cargo test          # unit + end-to-end (no server needed)
cargo clippy --all-targets
pnpm run check      # fmt + clippy with warnings as errors
```

## Known gaps

- No interactive mode (`split -i`), tags, blame or submodules.
