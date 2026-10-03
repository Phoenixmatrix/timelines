---
name: gitmatrix-graph-work
description: Work through Gitmatrix tracker issues on your own, in dependency order, with gm. Take the next ready issue, keep its lease, checkpoint, ask a person when blocked on a decision or credential, and complete with evidence. Use when asked to work on an issue, a project or the tracker.
---

<!-- Managed by `gm agent setup` from .gitmatrix/agents.yml: edit that and rerun; changes here are overwritten. -->

# Working through the tracker graph

Work here is tracked in Gitmatrix: {{SCOPE}}. `gm agent setup` configured this
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

## The loop

1. **Take work.** `gm issue next` picks the best ready issue in scope and claims
   it in one step (`--under <issue>` or `--team <key>` to narrow it). Read the
   returned context: description, acceptance, ancestors, and the evidence
   finished blockers left. Nothing ready means stop or wait, not retry.
2. **Choose: timeline or main.** Before you change anything, decide where the
   work goes, and record it. See "Timeline or main" below.
3. **Hold the lease.** It lasts {{TTL}}; `gm issue renew <issue>` before then. gm
   keeps the lease token for you, so lease commands need no token. Losing it
   (`Claim expired, was superseded…`) means someone else may own the work now:
   stop and re-read the issue.
4. **Ask the assistant** when you need to find something out, e.g.
   `gm ask "Where is the tracker's readiness computed?"`. It reads the code (and
   its knowledge graph), issues, CI runs and packages for you and answers with
   links; follow up with `--chat <id>`. It's read-only unless `--write`.
5. **Checkpoint** as you go: `gm issue checkpoint <issue> '<done; next>'`. The
   next agent (or you, after a restart) resumes from these.
6. **Handle human input** using the current claim's `intervention` policy (below).
   When using durable requests, `gm issue ask <issue> --kind question|approval|decision|credential --prompt '…'`
   parks your lease. Never put a secret in a prompt; use a credential request
   with `--secret owner/repo:NAME`. Read the responses with
   `gm request list --issue <issue> --status all`; once all are resolved,
   `gm issue resume <issue>` takes the lease back up.
7. **Finish** with evidence a reviewer can check: ship first ({{SHIP}}), then
   `gm issue complete <issue> --evidence 'Shipped in <commit>, CI run #N green; tests: …'`.
   Complete only what is shipped and verified. If abandoning active work,
   `gm issue release <issue>`: after the team's limit of releases, the issue asks
   your person what to try next. Do not release a lease parked on a human request.

## Creating properly tagged issues

When creating an issue, read its scope and acceptance criteria and label the
expertise needed to implement and verify it, not the agent you hope will take it.
Use a small, relevant set of work-area labels; do not copy every label from its
parent onto each child. Reuse the team's established spelling. Where the team
has no convention, use these lowercase defaults:

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

These are suggested values for the existing issue `labels` field, not a
registered catalog or an enforced list. Use an established project-specific
label when needed; avoid synonyms, case variants and speculative areas. For
example, a keyboard-navigation fix needs `ux` and `frontend`; a service schema
migration needs `backend` and `data`. Do not add `architecture` to every code
change or `testing` merely because every issue should be verified.

Repeat `--label` when creating an issue (it is not `--tag`):

    gm issue create 'Fix keyboard navigation in search' --team ENG --type bug --label ux --label frontend
    gm issue show ENG-1 --json

Replace `ENG` with the actual team, and `ENG-1` with the returned issue key;
check the returned `labels` before handing off. For existing issues,
`gm issue update ENG-1 --data '{"labels":["ux","frontend"]}'` replaces the whole
label list, so preserve unrelated labels you still need.

Issue labels describe work. Agent profile tags and skills describe self-reported
capabilities: they are separate, advisory hints for delegation, not verified
expertise or claim restrictions. Compare the required work with the agent's
profile and available evidence; never infer or publish an agent capability just
because it created or claimed a labeled issue.

## Human intervention

The claim response (`gm issue next`, `claim`, `resume` or `accept`) includes
`intervention: {mode, guidance}` from this checkout's current configuration.
Follow that current policy if these generated instructions are stale. At setup:

{{INTERVENTION}}

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
  person approves, and only while the checkpoint is the timeline's head: push
  more and the open request is withdrawn (your lease unparks); make a new
  checkpoint and ask again.
- Landing is automatic once it's allowed: an `auto` timeline lands when its
  checkpoint's CI is green, an `approval` one when a person approves the
  checkpoint. `gm timeline land` queues it by hand or says why it can't land
  yet. Main only moves to a merge that passed the gates. If the merge with main
  conflicts, landing stops and asks for a sync: merge main in when asked
  (`gm timeline merge main`), push, and make a new checkpoint.
- `gm timeline use main` goes back to main. `gm timeline abandon` ends a
  timeline you started, when a person asks or the attempt is dead.

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
- `gm agent list --owner <owner>` shows the tracker's agents with their
  advisory profiles (harness, model, environment, tags, skills), to pick whom to
  delegate to. Profiles are self-reported: treat them as hints, not proof.

`gm cli guide` has the same loop in brief; `gm schema issue next` and friends
give exact inputs and outputs.
