---
name: gitmatrix-graph-work
description: Work through Gitmatrix tracker issues on your own, in dependency order, with gm. Take the next ready issue, keep its lease, checkpoint, ask a person when blocked on a decision or credential, and complete with evidence. Use when asked to work on an issue, a project or the tracker.
---

<!-- Managed by `gm agent setup` from .gitmatrix/agents.yml: edit that and rerun; changes here are overwritten. -->

# Working through the tracker graph

Work here is tracked in Gitmatrix: matrixorg, team CORE. `gm agent setup` configured this
checkout, so plain `gm` commands already know the tracker, your scope and lease
length (.gitmatrix/agents.yml, .gitmatrix/agent.local.yml).

## Identity

You work as an agent, not as your person. When your harness drives gm in this
checkout, gm signs in as the agent `gm agent setup` made for it: everything you
do is attributed to the agent and names your person as accountable.
`gm auth status` shows `actingAs`. If it doesn't, ask your person to run
`gm agent setup` here. Your profile should say which model you are: when gm
notes it doesn't, or `gm agent show` lists another model than the one you run,
record yours with `gm agent configure --model <model-id>`.

## Pickup policy

Read `pickup` in `gm issue show` before work. `anyone` is the default, including
older issues. `not_ready` means nobody may claim or start yet; `human_only`
means an authenticated person must do the work, never an agent. Agent `ready`
and `next` exclude both. Assignment, delegation, capability overrides, direct
status updates and completion do not bypass this policy.

Use `gm issue create|update --pickup anyone|not_ready|human_only` to record it.
An agent may restrict `anyone` but only a person can change an existing
restricted policy. Ask the person to do the work or change the policy; never
switch credentials to evade it. Release an incompatible active claim before
restricting pickup. Policy is global across timelines, not a branch-local override.

## The loop

1. **Take work.** `gm issue next` picks the best ready issue in scope and claims
   it in one step (`--under <issue>` or `--team <key>` to narrow it). Read the
   returned context: description, acceptance, ancestors, and the evidence
   finished blockers left. Nothing ready means stop or wait, not retry.
2. **Choose: timeline or main.** Before you change anything, decide where the
   work goes, and record it. See "Timeline or main" below.
3. **Hold the lease.** It lasts 1 hour; `gm issue renew <issue>` before then. gm
   keeps a returned lease token for you, so lease commands need no token. A
   missing/empty token or uncertain claim response grants no ownership; inspect
   the issue online. Losing it (`Claim expired, was superseded…`) means someone
   else may own the work now: stop and re-read the issue. Others may change an
   issue while you hold it (a comment, a new acceptance criterion, an answer, a
   claim taken over). gm tells you: `gm issue renew` lists their changes,
   `gm issue updates` shows and marks them read, and in Claude Code gm's hooks
   add them to your context. When told, re-read the issue
   (`gm issue show <issue>`) and adapt before you go on.
4. **Ask the assistant** when you need to find something out, e.g.
   `gm ask "Where is the tracker's readiness computed?"`. It reads the code (and
   its knowledge graph), issues, CI runs and packages for you and answers with
   links; follow up with `--chat <id>`. It's read-only unless `--write`.
5. **Checkpoint** as you go: `gm issue checkpoint <issue> '<done; next>'`. The
   next agent (or you, after a restart) resumes from these.
6. **Handle human input** using the current claim's `intervention` policy (below).
   When using durable requests, `gm issue ask <issue> --kind question|approval|decision|credential --prompt '…'`
   parks your lease. Never put a secret in a prompt; use a credential request
   with `--secret space/repo:NAME`. Read the responses with
   `gm request list --issue <issue> --status all`; once all are resolved,
   `gm issue resume <issue>` takes the lease back up.
7. **Submit, monitor, then finish.** Ship first (Keep Claude/Codex/OMP and authoritative source edits local. Follow CONTRIBUTING.md's Agent-first development workflow. Execution selection is --execution, then GITMATRIX_AGENT_EXECUTION, then .gitmatrix/development.json, then local. When cloudflare is selected, use `node tools/agent/entry.ts` for setup/up, sync, scoped gm, checks, logs, debug and artifacts; use its `run -- <argv>` for remote vp/Cargo/browser work, never run heavy tooling on the host or silently fall back to local. Do not sync secrets, credential files or generated output back into authoritative source. Cloud mode explicitly trusts its disposable runtime with the current validated cf access token; the refresh credential stays local. AI remains opt-in. Sync the authoritative source workspace. In local mode, run `vp install`, inspect `vp run ready --dry-run`, then run `vp run ready`. In cloud mode, use `node tools/agent/entry.ts setup` for remote installation, sync source, inspect `node tools/agent/entry.ts check --dry-run`, then run `node tools/agent/entry.ts check`. These are the automatically selective required gate. Do not routinely add blanket check/test/build runs, `vp run agent test` or `--all`; use `--all` only when comprehensive verification is deliberately required. Local selection covers all unlanded committed, staged, unstaged and untracked work against the merge base with local `origin/main` and does not fetch. Use `--base` only for the actual integration branch, never to hide work. Accept automatic full fallback for broad or unknown changes, including remote source snapshots without Git metadata. Preserve required real consumer smoke checks, explicit AI verification and deployment-boundary checks in `AGENTS.md`; see `CONTRIBUTING.md#completion-gate` for coverage. Then follow the queue or timeline shipping workflow below from the authoritative local worktree and verify actual landing and required CI/deployment before completing the issue. Destroy the owned cloud environment when finished; stop is not resource cleanup.); independent main work
   uses the explicit queue workflow below. Only after acceptance is shipped and
   verified, `gm issue complete <issue> --evidence 'Landed <commit>, queue <id>; gate run #N green; deployment/run #M verified; tests: …'`.
   Cite only evidence actually observed; omit deployment claims when not verified.
   `--evidence` is optional and accepts literal text, `@file` or `-` for stdin.
   Omitted or whitespace-only evidence creates no note, not a synthetic success claim.
   `gm issue show` retains original completion evidence separately from recent activity,
   including after reopening. Optional evidence does not waive acceptance, gates or approvals.
   Complete only what is shipped and verified. If abandoning active work,
   `gm issue release <issue>`: after the team's limit of releases, the issue asks
   your person what to try next. Do not release a lease parked on a human request.

### Queued main work and remediation

For independent work targeting main, `gm push --queue --issue <issue>` uploads
the source and requests admission. Checkpoint the returned queue ID (the full
source commit), repository, local proof and pending landing/deployment checks:
`gm issue checkpoint <issue> 'Queue: <id>; source: <commit>; local tests: …; landing/deployment pending'`.
Admission is not a landing, successful CI, or a deployment. A transport error
can leave admission uncertain: inspect `gm queue show <id>` before resubmitting;
do not assume rejection or silently direct-push.

Keep and renew the original issue's lease while its acceptance still needs
verification. Continue independent, separately claimed work without relying on
the queued commit being on main. At meaningful work boundaries or the next
invocation, inspect `gm queue show <id>` and `gm queue list --status failed`.
Do not busy-poll or repeatedly invoke waits. When deliberately waiting to finish,
`gm queue wait <id> --deploy --timeout 600` waits for landing and the final main
pipeline; timeout is not success. Follow the real covering entry when work is
covered, and read `deployStatus` separately from landing status. `gm sync`
reconciles local history after landing; admission does not make it immutable.

Failures create unassigned P0 `remediation` issues with server-owned `queueFailure`
evidence. Discover them with `gm issue ready --type remediation --all-teams`
(or `gm issue list --type remediation --all-teams` to include held/blocked work).
These listings are advisory: use `gm issue claim <issue>` or `gm issue next` in
the proper scope and require the returned fencing token before acting. Remediation
does not override existing claims, blockers, assignment or timeline rules.
Read `gm issue show <issue> --json` and `gm queue show <queueFailure.queueId>`;
inspect `conflictPaths`, `failedJobs`, stage/reason and the referenced run using
`gm runs show <number>` and `gm runs logs <number>`. Fix the real cause, verify
locally, and submit a new commit with `gm push --queue --issue <remediation>`.
`gm queue retry <id>` retries the same admitted source only (for example after an
infrastructure fix); it cannot upload your changed code. Checkpoint the replacement
queue ID and complete remediation only after the fix actually lands and the
required pipeline/deployment evidence is verified. Preserve the original failure
audit; never forge `queueFailure` in a normal issue patch.

Ordinary `gm push` and native Git push remain available as an explicit recovery
path if the queue itself needs repair. Investigate first and follow project
authorization and verification requirements; never automatically fall back to
direct push after failed/uncertain admission. Queued failures do not imply that
later independent pushes must stop. Timeline work is different: `--queue` is
refused while bound to a timeline. Use push/checkpoint/land below, including
person approval for the exact current checkpoint when policy is `approval`.

## Creating properly tagged issues

When creating an issue, read its scope and acceptance criteria and tag the
expertise needed to implement and verify it, not the agent you hope will take it.
Use a small, relevant set of work-area tags; do not copy every tag from its
parent onto each child. Tags come from the tracker's tag catalog, which keeps
every tag ever used: `gm issue tags` lists it with counts. Reuse its spelling.
Where the tracker has no convention yet, use these lowercase defaults:

- `ux`: user research, interaction design and usability.
- `frontend`: browser UI, styling and client-side behavior.
- `backend`: server-side logic, services and background jobs.
- `data`: schemas, migrations, queries and data pipelines.
- `architecture`: system boundaries, cross-cutting design and major tradeoffs.
- `api`: public interfaces, contracts and integrations.
- `security`: authentication, authorization and threat mitigation.
- `testing`: test strategy, test infrastructure and regression coverage.
- `infrastructure`: deployment, CI/CD, networking and runtime operations.
- `documentation`: user or developer documentation.

A new name joins the catalog; avoid synonyms, case variants and speculative
areas. For example, a keyboard-navigation fix needs `ux` and `frontend`; a
service schema migration needs `backend` and `data`. Do not add `architecture`
to every code change or `testing` merely because every issue should be verified.

Repeat `--tag` when creating an issue:

    gm issue create 'Fix keyboard navigation in search' --team ENG --type bug --tag ux --tag frontend
    gm issue show ENG-1

Replace `ENG` with the actual team, and `ENG-1` with the returned issue key;
check its Tags line before handing off. For existing issues, `gm issue update
ENG-1 --tag data --drop-tag backend` adds and removes one tag, and
`--data '{"tags":["ux","frontend"]}'` replaces the whole list. (`--label` and
`labels` are the old spellings and still work; the JSON field is `labels`.)

One vocabulary, three roles. An issue's tags describe the work. An agent's tags
(`gm agent setup --tag ux`, from the same catalog) say what work it suits. A
requirement `tag:ux` (`--requires`) means only agents tagged ux may claim the
issue; tagging an issue never restricts claims by itself. Agent profiles are
self-reported, advisory hints for delegation, not verified expertise. Compare
the required work with the agent's profile and available evidence; never infer
or publish an agent's tags just because it created or claimed a tagged issue.

## Human intervention

The claim response (`gm issue next`, `claim`, `resume` or `accept`) includes
`intervention: {mode, guidance}` from this checkout's current configuration.
Follow that current policy if these generated instructions are stale. At setup:

Use the agent or harness's normal human-intervention behavior, including its own interactive prompts or software-factory workflow. gm does not require asynchronous requests or continuing other work. Durable `gm issue ask` requests remain available when that workflow chooses them; they appear in the accountable person's Needs you panel and park a held lease until the requests are resolved. This setting never grants permissions or bypasses required approvals.

Use `gm agent setup --intervention autonomous` for unattended issue chains, or
`--intervention harness` to retain the harness or software factory's own behavior.
New projects start autonomous; existing projects without a setting retain harness
behavior. `.gitmatrix/agents.yml` sets the repository default; an
`intervention` in `.gitmatrix/agent.local.yml` overrides it for this checkout.
Rerun setup after editing either file.

### Durable questions and blockers

First read existing requests (`gm request list --issue <issue> --status all`)
and issue context. Do not duplicate an unresolved ask. Keep prompts actionable:
what you tried, the blocker and impact, alternatives with tradeoffs, your
recommendation, and exactly what the person must answer or do.

    gm issue ask CORE-5 --kind decision --prompt 'Which deployment region? EU meets the latency requirement; US is cheaper. Recommend EU.' --choice EU --choice US
    gm issue ask CORE-5 --kind question --prompt 'Deployment is blocked by the expired signing credential. Please rotate it in the secret store; no secret values belong here.'
    gm issue link CORE-2 CORE-5

The last command records that CORE-2 blocks CORE-5; a dependency link alone
does not appear in Needs you. If resolving that blocker needs a person, open
a request on CORE-5 describing the required action. Requests route to your
accountable human by default (`--route-to <member>` deliberately routes elsewhere).
Parked claims remain yours without renewal while waiting. Continue only
independent, explicitly authorized work; an issue waiting on this one is not ready.
Check answers at work boundaries or on the next invocation, not in a polling loop.
`gm request list --status answered` discovers answers; read all requests for the
issue before resuming because another request may still be open. A returned
`claimed: null` is a clean stop, not an instruction to retry or widen scope.

## Timeline or main

A timeline keeps work apart from main until it lands: `auto` timelines land when
their gates pass, `approval` ones after a person approves. Two signals say
whether to use one, and `gm issue next` and `gm issue claim` return the first as
`timelineRule` (`use`, `policy`, `guidance`):

- **The issue's field**, `timelineUse`: `required` means work in a timeline,
  with the `timelinePolicy` it names (`auto` or `approval`; none means either).
  `never` means work on main. `agent_decides`, the default, leaves it to you.
- **The description or PRD** (and the parent PRD, and comments): a person may
  say it in plain words, such as "do this in an approval timeline". Read them
  before choosing. If they contradict the field, follow the field and ask
  (`gm issue ask --kind question`).

When it's yours to decide, prefer a timeline for risky, broad or experimental
work that a person should see before it reaches main (migrations, deploy or
security changes, large refactors), and main for small, safe, well-tested
changes.

Record the choice in a checkpoint before you start, so the next agent and the
reviewer know: name the timeline you work in, which links the issue to it, or
say why you worked on main:

    gm issue checkpoint <issue> 'Timeline: <slug> (approval): touches the billing schema'
    gm issue checkpoint <issue> 'Timeline: main, because it is a one-line copy fix'

## Working in a timeline

A timeline is a separate line of work on `timeline/<slug>`, forked from main or
another timeline.

- `gm timeline start <slug> [--policy auto|approval] [--experimental]` forks one
  from main (`--from <timeline>` forks another) and binds this checkout to it;
  `gm timeline use <slug>` joins an existing one.
- While bound (`timeline:` in .gitmatrix/agent.local.yml; new worktrees copy
  it), `gm push` goes to `timeline/<slug>` and `gm sync` follows it. gm refuses
  to push to main: the timeline gets there when it lands. `gm issue` commands
  work in the timeline's view, so your checkpoints and edits are made there.
- Merge main in only when a person asks: `gm timeline merge main` (or another
  timeline's slug), then `gm push`.
- When the work is ready for review, push it, then record a checkpoint with a
  summary of what it holds and why: `gm timeline checkpoint -m '…'`. In an
  `approval` timeline, ask for approval of exactly that checkpoint:
  `gm issue ask <issue> --kind approval --checkpoint <id> --prompt '…'`. Only a
  person approves — directly, or through their own approve-when-green setting
  in that tracker — and only while the checkpoint is the timeline's head: push
  more and the open request is withdrawn (your lease unparks); make a new
  checkpoint and ask again. An agent can't turn that setting on or answer for
  them; with it on, the request is approved once the checkpoint's CI is green,
  unless the checkpoint changes CI configuration (then the person approves).
- Landing is automatic once it's allowed: an `auto` timeline lands when its
  checkpoint's CI is green, an `approval` one when a person approves the
  checkpoint (by hand, or by their approve-when-green setting). `gm timeline land` queues it by hand or says why it can't land
  yet. Main only moves to a merge that passed the gates. If the merge with main
  conflicts, landing stops and asks for a sync: merge main in when asked
  (`gm timeline merge main`), resolve conflicts, and push. For canonical-rooted
  work without dependencies, use `gm timeline checkpoint --sync-main -m '…'`
  to pin the exact current main already present in the published work as this
  checkpoint's logical base. The allocation base and old records do not change;
  request the flag on each checkpoint that should use synchronized main. A new
  base needs a fresh approval even at the same work commit. Foreign/nested work
  keeps the ordinary checkpoint/dependency-admission flow, not `--sync-main`.
- `gm timeline use main` goes back to main. `gm timeline abandon` ends a
  timeline you started, when a person asks or the attempt is dead.

### Steps: commit at meaningful points, with context

In a timeline, record your work as **steps**: commit and push at each
meaningful point (a working piece, a decision, a fix), not only at the end.
People and other agents follow them live and read them later.

- `gm step -m '<what this step does>' --context step.md` runs the repository's
  fast checks (`gm test`), commits with the context and the test results, and
  pushes. `gm commit --context step.md` plus `gm push` works too.
- Write the context as Markdown with `## Why` (why this, this way),
  `## Challenges` (what got in the way), `## Instructions` and `## Steering`
  (one bullet each). Always include why. Never put secrets in it.
- With the Claude Code hook installed (`gm agent setup`), the person's own
  words reach the step by themselves, marked `hook`. Without a hook, record
  the instructions you're following and every way the person steered you
  under `## Instructions` and `## Steering` yourself; they're marked `agent`.
- Resuming work? `gm log --context` and `gm context show <rev>` give earlier
  steps' why and challenges; `gm steps --follow` shows other agents' steps as
  they land.

## Projects and other agents

- Claiming a parent leases its whole subtree. Delegate a sub-issue to another of
  your person's agents with `gm issue claim <child> --for <agent> --under-token <parent token>`,
  or let it pick with `gm issue next --under <parent> --under-token …`. Take a
  delegated claim back with `gm issue revoke`.
- Hand your lease to another agent with `gm issue handoff <issue> --to <agent>`
  (a single-use code; `gm issue accept <code>` on their side). Don't share lease
  tokens directly.
- Don't take a PRD (`type: prd`) as work: implement its sub-issues, and complete
  the PRD once they're done.
- `gm agent list --space <space>` shows the tracker's agents with their
  advisory profiles (harness, model, environment, tags, skills), to pick whom to
  delegate to. Profiles are self-reported: treat them as hints, not proof.

`gm cli guide` has the same loop in brief; `gm schema issue next` and friends
give exact inputs and outputs.
