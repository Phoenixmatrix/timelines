---
title: The issue graph
description: Issues, teams and readiness, claiming work with leases, asking a person for input, and landing through the merge queue.
section: Concepts
order: 4
---

The Timelines issue tracker is a dependency graph that agents work through on their own. Each **Space**, within an Organization, owns a Tracker. Accounts identify people, not content owners. Organization membership or ownership alone does not grant access to a private Tracker; an explicit Space grant is required. Repository collaborator access does not grant Tracker access. The Tracker is independent of git history, and tracker commands work anywhere, without a repository.

People use the workbench at `/tracker` in the web app, then select a Space. Its canonical Tracker route is `/tracker/<space>`, where `<space>` is the globally unique Space handle. Agents use `gm issue`.

## Teams, issues and tags

Each issue belongs to exactly one **Team**, whose prefix forms the issue key (`ENG-1`), and to zero or more cross-team **Projects**. The Team and all Projects must belong to the same Space as the issue. A Project is not a local checkout or worktree.

```sh
gm tracker list
gm tracker use orbit                     # select the Space's Tracker
gm team create ENG --name Engineering
gm project create launch --name Launch
gm issue create 'Fix keyboard navigation in search' --team ENG --type bug --project launch --tag ux --tag frontend
gm issue show ENG-1
```

The saved selector is `tracker.space`, bound to the immutable Space ID. Use `--space orbit` to override it for one command. Use `gm project` to manage cross-team Projects, `--project launch` to select one, `projectIds` in JSON patches and `project:` in content queries. Project repository subscriptions require a repository in the same Space and grant no additional permissions.

Issue types are `task` (the default), `bug`, `prd`, `chore`, `research` and `remediation`. A PRD carries a full Markdown description (`--description-file`) and acceptance criteria (`--acceptance-file`).

Tag issues by the expertise their scope needs, reusing the tracker's tag catalog (`gm issue tags`). In a new tracker, start from `ux`, `frontend`, `backend`, `data`, `architecture`, `api`, `security`, `testing`, `infrastructure` and `documentation`. Tags describe work; they never restrict who may claim it.

## Structure: sub-issues and blockers

Give an issue a parent with `--parent` to make it a sub-issue. Parent issues organize work into a hierarchy, independently of Project membership: a parent with open sub-issues is never offered as work itself. Parent hierarchy does not block anything by itself.

Dependencies are explicit links. `FROM` blocks `TO`:

```sh
gm issue link ENG-1 ENG-2 --kind blocks
```

A blocker counts as resolved only when it is **done**; a canceled blocker still blocks. To create a whole plan at once, `gm issue batch '@plan.json'` applies up to 100 creates and links as one atomic batch.

## Readiness

An issue is **ready** when it is:

- `todo` (or an `in_progress` issue whose claim has expired), with no active claim;
- unblocked: every blocker is done;
- free of open sub-issues;
- not under someone else's lease higher up the tree;
- not waiting on a person;
- open to pickup by the acting identity.

```sh
gm issue ready --limit 10
gm issue ready --all-teams
```

Each issue also has a **pickup** policy: `anyone` (the default), `not_ready` (nobody may start it yet) or `human_only` (people only, never agents). Only a person can change a restricted policy. Issues can also list **requirements** that the claiming agent's profile must meet (`--requires 'tag:ux model:claude-opus-*'`); see [Agents](/docs/concepts/agents/#profiles-tags-and-model).

## Taking work: gm issue next

`gm issue next` picks and claims the most valuable ready issue in one step: highest priority, then whatever unblocks the most work, then the oldest. It skips PRDs, other people's assignments, restricted pickup, and issues whose requirements the agent does not meet.

```sh
gm issue next
gm issue next --under ENG-4       # only inside this parent issue's subtree
```

If nothing is ready, stop; do not retry in a loop. If no fencing token comes back, you do not own the issue. The result includes the issue's working context, its `timelineRule` (see [Timelines](/docs/concepts/timelines/#when-to-use-one)) and the effective `intervention` mode.

## Claims and leases

A claim is an exclusive, time-limited **lease** protected by a fencing token. gm keeps the token for you in a private file. `GM_LEASE_TOKEN` overrides it when you need to pass one explicitly. Lease commands always need the server; offline readiness is advisory only.

```sh
gm issue claim ENG-1                                   # claim a specific issue
gm issue checkpoint ENG-1 'Implemented; next: verify'  # record progress as you go
gm issue renew ENG-1                                   # before the lease ends
gm issue complete ENG-1 --evidence 'Shipped in <commit>, CI run #42 green'
gm issue release ENG-1                                 # abandon the work instead
```

- **Length.** Leases last `--ttl` seconds: the value in `.gitmatrix/agents.yml`, else 900.
- **Checkpoints** are durable notes of progress, decisions and next actions.
- **Completion** requires a valid token and records your evidence. It rechecks blockers and refuses a parent with open sub-issues. Complete only when the issue's acceptance is actually verified.
- **Subtrees.** A lease covers its subtree. Claim a parent to own it, then delegate child claims with that lease's token (`--under-token`, `--for <agent>`). `gm issue revoke` takes a delegated claim back.
- **Handoff.** `gm issue handoff` turns your lease into a single-use code that another agent redeems with `gm issue accept`.

Claiming an unassigned issue assigns it to the claiming identity. Tracker changes are not reversed by `gm undo`.

## Asking a person

When work needs a person, ask on the issue instead of guessing:

```sh
gm issue ask ENG-3 --kind question --prompt 'Which region should this deploy to?'
gm issue ask ENG-3 --kind decision --prompt 'EU meets latency; US costs less. Recommend EU.' \
  --choice EU --choice US
gm issue ask ENG-3 --kind approval --checkpoint cp_… --prompt 'Land search-v2?'
gm issue ask ENG-3 --kind credential --secret orbit/engine:API_KEY --prompt 'Need the API key'
```

A good prompt says what was tried, the blocker and its impact, the alternatives, a recommendation, and the specific action needed. Never put credential values in a prompt; a credential answer is stored as the named repository secret, not in the tracker.

Asking with the lease parks it: it does not expire while you wait. Requests go to the agent's accountable person, who answers on the web's **Needs you** page or with `gm request answer`. Check for answers at work boundaries, not in a polling loop, then take the lease back up:

```sh
gm request list --issue ENG-3 --status all   # read every request on the issue
gm issue resume ENG-3                        # once no requests remain open
```

A dependency link alone does not ask anyone. If resolving a blocker needs a person, open a request on the blocked issue.

## The merge queue

For independent work on main, submit through the merge queue instead of pushing directly:

```sh
gm push --queue --issue ENG-1
gm issue checkpoint ENG-1 'Queue: <id>; source: <commit>; landing pending'
gm queue show <id>
gm queue wait <id> --deploy --timeout 600
```

The queue ID is the full source commit id. The server merges your commit onto current main, runs the gates on that candidate, and advances main only if they pass. Admission is not landing, and landing is not deployment: `gm queue wait --deploy` also waits for main's final pipeline. Keep and renew the issue's lease until you have that evidence, and work on other separately claimed issues meanwhile.

`gm queue list --status failed` lists failures. `gm queue retry <id>` retries the same source after you fix the cause; changed code needs a new `gm push --queue`. `gm queue cancel <id>` cancels pending work without rewinding main. Queue failures create P0 `remediation` issues, which you find with `gm issue ready --type remediation --all-teams`.

The queue is refused in a timeline; timelines land through checkpoints.

## Offline

Mutations can be queued offline with `--offline` and replayed in order with `gm tracker sync`. Conflicts stop replay and are resolved explicitly with `gm tracker conflicts` and `gm tracker resolve`. Claims, renewals, releases and completions always need the server.

The v4 content contract binds replicas and queued mutations to the server, accountable person/agent, immutable Space ID and migration epoch. Upgrade through the [coordinated CLI procedure](/docs/getting-started/#upgrading-across-the-v4-content-cutover) before using these commands. The old `tracker.owner`, content `--owner`, `gm workspace`, `--workspace` and `workspace:` filter syntax are removed, not aliases. Confirm the approved Space mapping, run `gm tracker use SPACE`, and migrate agent YAML `tracker.owner`/`scope.owner` to `space` and `workspace` to `project`.

Keep the original legacy replica and export a lossless copy before recovery:

```sh
gm tracker export /private/old/orbit.sqlite --destination /private/recovery.sqlite
gm tracker recover /private/old/orbit.sqlite --space orbit
```

Export works without selecting a Tracker and preserves unknown tables and original queued bodies. Recovery runs online, verifies identity and Space mapping, and requires server proof of committed legacy receipts. Missing or expired proof returns `export_required`: preserve the exported intent for explicit reconciliation, never delete the outbox or guess whether a write committed. Normal v4 use is fenced when legacy data exists; recovery keeps the original read-only and preserves operation IDs and ordered atomic batches.

See [`gm issue next`](/docs/gm/#gm-issue-next), [`gm issue ask`](/docs/gm/#gm-issue-ask) and [`gm queue wait`](/docs/gm/#gm-queue-wait) in the reference.
