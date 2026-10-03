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
   depends on)? `gm ask "<question>"` asks the Gitmatrix assistant. Blocked on
   a person? `gm issue ask <issue> --kind question|approval|decision|credential --prompt '…'`.
5. Ship ({{SHIP}}), then `gm issue complete <issue> --evidence '…'`. Can't
   finish: `gm issue release <issue>`.

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
