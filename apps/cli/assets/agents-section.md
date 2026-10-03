## Working through the issue graph

Work is tracked in Gitmatrix: {{SCOPE}}. The loop, in brief (the
`gitmatrix-graph-work` skill has the details):

1. `gm issue next` picks and claims the most valuable ready issue in scope.
   Nothing ready means stop, not retry.
2. Choose where it goes before you start: the claim's `timelineRule` says
   whether the issue requires a timeline, never wants one, or leaves it to
   you (then read the description or PRD). Record it with a checkpoint:
   `'Timeline: <slug>'`, or `'Timeline: main, because …'`.
3. Work it: `gm issue checkpoint <issue> '<done; next>'` as you go, and
   `gm issue renew <issue>` before the lease ({{TTL}}) ends.
4. Need to find something out (where code lives, why CI failed, what an issue
   depends on)? `gm ask "<question>"` asks the Gitmatrix assistant. For human
   input, follow the current claim's `intervention` mode and guidance below.
5. Ship ({{SHIP}}), then `gm issue complete <issue> --evidence '…'`.
   Abandoning active work? `gm issue release <issue>`. Keep parked request leases.

## Creating issues

Classify the expertise needed by the actual scope and acceptance criteria, not
by the intended agent. Use a small relevant set of issue labels, reusing the
team's spelling. Without a team convention, use lowercase `ux` (usability and
interaction design), `frontend` (client UI), `backend` (server logic), `data`
(schemas and pipelines), `architecture` (system design), `api` (contracts and
integrations), `security` (auth and threat mitigation), `testing` (test strategy
and infrastructure), `infrastructure` (CI/CD and operations), or `documentation`
(user and developer docs). Avoid synonyms and speculative labels; ordinary
verification alone does not need `testing`.

    gm issue create 'Fix keyboard navigation in search' --team ENG --type bug --label ux --label frontend

Substitute the actual team. Repeat `--label` for each area, then read back the
returned issue key with `gm issue show <issue> --json` and check `labels`.
These are suggested defaults for free-form issue labels, not an enforced
catalog. They describe work, not agent capabilities. Agent profile tags and
skills are self-reported, advisory delegation hints, not proof of expertise or
claim restrictions; do not declare capabilities from issue labels.

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
main. `gm timeline use main` goes back.

When an agent harness drives gm here, gm acts as this checkout's agent
(`gm auth status` shows `actingAs`) and keeps lease tokens for it. If gm says
the agent's profile has no model, or you run a different model than
`gm agent show` lists, record yours: `gm agent configure --model <model-id>`. To change
any of this, edit `.gitmatrix/agents.yml` (shared) or
`.gitmatrix/agent.local.yml` (this checkout), then rerun `gm agent setup`.
