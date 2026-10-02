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
`gm agent setup` here.

## The loop

1. **Take work.** `gm issue next` picks the best ready issue in scope and claims
   it in one step (`--under <issue>` or `--team <key>` to narrow it). Read the
   returned context: description, acceptance, ancestors, and the evidence
   finished blockers left. Nothing ready means stop or wait, not retry.
2. **Hold the lease.** It lasts 1 hour; `gm issue renew <issue>` before then. gm
   keeps the lease token for you, so lease commands need no token. Losing it
   (`Claim expired, was superseded…`) means someone else may own the work now:
   stop and re-read the issue.
3. **Ask the assistant** when you need to find something out, e.g.
   `gm ask "Where is the tracker's readiness computed?"`. It reads the code (and
   its knowledge graph), issues, CI runs and packages for you and answers with
   links; follow up with `--chat <id>`. It's read-only unless `--write`.
4. **Checkpoint** as you go: `gm issue checkpoint <issue> '<done; next>'`. The
   next agent (or you, after a restart) resumes from these.
5. **Ask a person** when you need a decision, an approval, a credential or an
   answer you can't find: `gm issue ask <issue> --kind question|approval|decision|credential --prompt '…'`.
   That parks your lease so you can exit. Never put a secret in a prompt; ask
   for a credential with `--secret owner/repo:NAME` and read it from that secret.
   When `gm request list` shows it answered, `gm issue resume <issue>`.
6. **Finish** with evidence a reviewer can check: ship first (`vp run ready`, then `gm push && gm runs wait`), then
   `gm issue complete <issue> --evidence 'Shipped in <commit>, CI run #N green; tests: …'`.
   Complete only what is shipped and verified. If you can't finish,
   `gm issue release <issue>`: after the team's limit of releases, the issue asks
   your person what to try next.

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
