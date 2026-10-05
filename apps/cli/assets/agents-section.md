## Working through the issue graph

Work is tracked in Gitmatrix: {{SCOPE}}. The loop, in brief (the
`gitmatrix-graph-work` skill has the details):

1. `gm issue next` picks and claims the most valuable ready issue in scope.
   Nothing ready means stop, not retry. No returned fencing token means no ownership.
   `not_ready` pickup permits nobody to start; `human_only` permits people, never
   agents, even when assigned or delegated. Only a person can change an existing
   restricted policy. Ask them; do not bypass it with status changes or credentials.
2. Choose where it goes before you start: the claim's `timelineRule` says
   whether the issue requires a timeline, never wants one, or leaves it to
   you (then read the description or PRD). Record it with a checkpoint:
   `'Timeline: <slug>'`, or `'Timeline: main, because …'`.
3. Work it: `gm issue checkpoint <issue> '<done; next>'` as you go, and
   `gm issue renew <issue>` before the lease ({{TTL}}) ends.
4. Need to find something out (where code lives, why CI failed, what an issue
   depends on)? `gm ask "<question>"` asks the Gitmatrix assistant. For human
   input, follow the current claim's `intervention` mode and guidance below.
5. Ship ({{SHIP}}). For independent main work, explicitly submit
   `gm push --queue --issue <issue>` and checkpoint the returned queue ID,
   source commit and verification still pending. Accepted is not landed or deployed.
   Keep/renew the original lease while its acceptance remains unverified.
   Continue other independently authorized work; inspect `gm queue show <id>`
   at work boundaries, not in a busy polling loop. When deliberately waiting,
   use `gm queue wait <id> --deploy --timeout 600`.
6. Discover P0 failures with `gm issue ready --type remediation --all-teams`.
   Claim with `gm issue claim <issue>` (or normal `gm issue next` in scope),
   inspect `queueFailure`, queue details and run logs, fix and verify, then submit
   the new fix with `gm push --queue --issue <remediation>`. Use `gm queue retry <id>`
   only to retry the same source after fixing the cause, not to upload new code.
   Complete original/remediation work only with actual landing and required CI/deploy
   evidence: `gm issue complete <issue> --evidence '…'`. Do not report admission as success.
   Abandoning active work? `gm issue release <issue>`. Keep parked request leases.
   Queue unavailable? Ordinary `gm push` remains an explicit recovery path;
   investigate uncertain admission first, never silently bypass gates or approvals.

## Creating issues

Classify the expertise needed by the actual scope and acceptance criteria, not
by the intended agent. Tag issues from the tracker's tag catalog (`gm issue
tags` lists it), reusing its spelling. In a new tracker, use lowercase `ux`
(usability and interaction design), `frontend` (client UI), `backend` (server
logic), `data` (schemas and pipelines), `architecture` (system design), `api`
(contracts and integrations), `security` (auth and threat mitigation), `testing`
(test strategy and infrastructure), `infrastructure` (CI/CD and operations), or
`documentation` (user and developer docs). Avoid synonyms and speculative tags;
ordinary verification alone does not need `testing`.

    gm issue create 'Fix keyboard navigation in search' --team ENG --type bug --tag ux --tag frontend

Substitute the actual team. Repeat `--tag` for each area, then read back the
returned issue key with `gm issue show <issue>` and check its Tags line. A new
name joins the catalog. An issue's tags describe work; an agent's tags (from the
same catalog) say what work it suits; a `tag:ux` requirement limits claims to
agents tagged ux. Tagging an issue never restricts claims. Agent profiles are
self-reported, advisory delegation hints, not proof of expertise; do not declare
an agent's tags from the issues it touches. (`--label` is the old spelling of
`--tag` and still works.)

## Human intervention

`gm issue next` and `gm issue claim` return the effective `intervention` mode
and guidance for this checkout. Follow that current policy if configuration
has changed since these instructions were generated. At setup:

{{INTERVENTION}}

Choose with `gm agent setup --intervention autonomous|harness`. The repository's
`intervention` default lives in `.gitmatrix/agents.yml`; existing repositories
save the flag as this checkout's override in `.gitmatrix/agent.local.yml`.

When the issue or a person asks for a timeline (a separate line of work that
lands on main later), `gm timeline start <slug>` or `gm timeline use <slug>`
binds this checkout to it: `gm push` then goes to `timeline/<slug>`, never to
main. `gm timeline use main` goes back. `--queue` is refused in a timeline;
use its push/checkpoint/land flow. Approval timelines still require a person's
approval of the exact current checkpoint; generic queue submission never replaces it.

When an agent harness drives gm here, gm acts as this checkout's agent
(`gm auth status` shows `actingAs`) and keeps lease tokens for it. If gm says
the agent's profile has no model, or you run a different model than
`gm agent show` lists, record yours: `gm agent configure --model <model-id>`. To change
any of this, edit `.gitmatrix/agents.yml` (shared) or
`.gitmatrix/agent.local.yml` (this checkout), then rerun `gm agent setup`.
