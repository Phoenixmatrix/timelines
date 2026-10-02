---
name: gitmatrix-graph-work
description: Work through Gitmatrix tracker issues on your own, in dependency order, with gm: take the next ready issue under a project, keep its lease, checkpoint, ask a person when blocked on a decision or credential, and complete with evidence. Use when pointed at a CORE issue, project or workspace to implement.
---

# Working through the tracker graph

Gitmatrix's own work lives in production's tracker (`matrixorg`, team `CORE`).
Plain `gm` targets production; select the tracker once with
`gm tracker use matrixorg`.

## Identity

Work as an agent, not as your person: your person creates it once
(Settings > Agents, or `gm agent create <name>` then `gm agent token <name>`),
and you run with that token as `GM_TOKEN`. Everything you do is attributed to
the agent and names your person as accountable. `gm auth status` shows
`actingAs`.

## The loop

1. **Take work.** `gm issue next --agent <session> --under CORE-<n>` (or
   `--team CORE`) picks the best ready issue and claims it in one step. Keep the
   returned `leaseToken` secret (export it as `GM_LEASE_TOKEN`); it's shown once.
   Read the returned context: description, acceptance, ancestors, and the
   evidence finished blockers left. Nothing ready means stop or wait, not retry.
2. **Hold the lease.** It expires (15 minutes by default, `--ttl` up to a day);
   `gm issue renew` before then. Losing it (`lease_lost`) means someone else may
   own the work now: stop and re-read the issue.
3. **Checkpoint** as you go: `gm issue checkpoint <issue> '<done; next>'`. The
   next agent (or you, after a restart) resumes from these.
4. **Ask a person** when you need a decision, an approval, a credential or an
   answer you can't find: `gm issue ask <issue> --kind question|approval|decision|credential`
   with `GM_LEASE_TOKEN` set, which parks your lease so you can exit. Never put
   a secret in a prompt; ask for a credential with `--secret owner/repo:NAME` and
   read it from that secret. When `gm request list` shows it answered,
   `gm issue resume <issue>` gives you a fresh token.
5. **Finish** with evidence a reviewer can check:
   `gm issue complete <issue> --evidence 'Shipped in <commit>, CI run #N green; tests: …'`.
   Ship first (see AGENTS.md: `vp run ready`, `gm push`, `gm runs wait`): complete
   only what is deployed and verified. If you can't finish, `gm issue release`:
   after the team's limit of releases, the issue asks your person what to try next.

## Projects and other agents

- Claiming a parent leases its whole subtree. Delegate a sub-issue to one of your
  person's agents with `GM_UNDER_TOKEN=<parent token> gm issue claim <child> --agent <label> --for <agent>`,
  or let it pick with `gm issue next --under <parent> --under-token …`. Take a
  delegated claim back with `gm issue revoke`.
- Hand your lease to another agent with `gm issue handoff <issue> --to <agent>`
  (a single-use code; `gm issue accept <code>` on their side). Don't share lease
  tokens directly.
- Don't take a PRD (`type: prd`) as work: implement its sub-issues, and complete
  the PRD once they're done.

`gm cli guide` has the same loop in brief; `gm schema issue next` and friends
give exact inputs and outputs.
