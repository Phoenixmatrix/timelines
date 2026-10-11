---
title: Timelines
description: Separate lines of work that land on main later, with steps, checkpoints, approvals, compact landing and previews.
section: Concepts
order: 2
---

A timeline is a separate line of work that lands on main later, either automatically or after a person approves it. Use one for broad, risky or experimental work that needs review before main; small, safe changes go straight to trunk. Timelines are optional unless an issue or a person requires one.

## When to use one

Each issue in the [issue graph](/docs/concepts/issue-graph/) says whether its work goes in a timeline. `gm issue next` and `gm issue claim` return the rule as `timelineRule`:

- `required`: work in a timeline. The rule may also name the policy it must use (`auto` or `approval`).
- `never`: work on main.
- `agent_decides` (the default): read the description or PRD and comments first. Otherwise prefer a timeline for risky, broad or experimental work, and main for small, safe changes.

Record the choice in a checkpoint before you start, so the issue links to its timeline or says why the work went to main:

```sh
gm issue checkpoint ENG-5 'Timeline: search-v2 (approval)'
gm issue checkpoint ENG-5 'Timeline: main, because it is a one-line fix'
```

## Start and use

```sh
gm timeline start search-v2 --policy approval   # fork from main, then work in it here
gm timeline use search-v2                       # join an existing timeline in this checkout
gm timeline use main                            # go back to main
```

`start` forks a timeline from main, or from another timeline with `--from <slug>`. Options:

- `--policy auto|approval`: how it lands. `auto` lands when its gates pass; `approval` lands after a person approves a checkpoint.
- `--name`: a readable name (default: the slug).
- `--repo owner/name`: the repositories it touches, repeatable. A timeline can span several repositories of one account.
- `--experimental`: marks it as not expected to land. The marker restricts nothing.
- `--no-use`: create it without binding this checkout.

`use` records `timeline: <slug>` in `.gitmatrix/agent.local.yml`, which `gm worktree add` copies, so new worktrees stay in the timeline. `GM_TIMELINE=<slug>` overrides the binding for one command (`GM_TIMELINE=main` for main).

## Pushing to a timeline

While a checkout is bound to a timeline, the timeline's work is that checkout's trunk. `gm push` and `gm sync` follow it, and pushing to main is refused. Canonical main stays reachable as `origin/main`.

```sh
gm commit -m "Rank by recency"
gm push                          # to the timeline, never main
```

Each timeline keeps its own work repository per canonical repository, shared by its agents, so work-in-progress commits never enter the canonical repository, even when the timeline lands. Plain git reaches it at `/<owner>/<repo>@<slug>.git`.

To bring main into the timeline, merge it. Do this only when a person asks:

```sh
gm timeline merge main && gm push
```

`gm push --queue` is refused in a timeline: timelines land through checkpoints, not the merge queue.

## Steps

In a timeline, commit at meaningful steps and say what drove each one. A step carries its context: the instructions the agent followed, how a person steered it, why the work was done this way, what got in the way, and its test results.

```sh
gm step -m "Rank by recency" --context step.md
```

`gm step` runs `gm test` (the repository's fast local checks), commits with the context and the test results, and pushes. Failing tests do not stop it; the step records them with a warning. `--context` takes Markdown with `## Instructions`, `## Steering`, `## Why` and `## Challenges` sections, or the same fields as JSON. Missing context warns, never blocks. Outside a timeline, use `gm commit --context` and `gm push`.

Read steps back with:

```sh
gm steps --follow          # stream a timeline's new steps as they are pushed
gm context show <rev>      # one step's context
gm log --context           # each step's why beside it
gm why src/search.ts:42    # blame, then the change's timelines, issue, checkpoints, approval and landing
```

`gm agent setup` installs hooks for Claude Code, Codex and Oh My Pi that record what the person tells the agent, so instructions and steering are captured automatically. See [Agents](/docs/concepts/agents/).

## Checkpoints

A checkpoint records the timeline's pushed commits at a moment, with your summary of what it holds and why. It never changes.

```sh
gm timeline checkpoint -m 'Search v2 ranking is ready: …'
gm timeline checkpoints          # newest first, with CI runs, previews and approvals
```

A checkpoint also runs the timeline's full CI at once. Without one, the full run waits until pushes pause for a quiet period.

## Approval

For an `approval` timeline, ask a person to approve the checkpoint:

```sh
gm issue ask ENG-5 --kind approval --checkpoint cp_… --prompt 'Land search-v2?'
```

The request appears on the person's **Needs you** page; they can also answer with `gm request answer <id> --approve`. An approval pins one checkpoint, is given by a person with write access (never an agent), and counts only while that checkpoint is still the timeline's head. New commits withdraw an open request and need a new checkpoint and a new approval.

## Landing

```sh
gm timeline land      # queue the head checkpoint, or say why it can't land yet
```

`auto` timelines queue themselves when checkpoint CI is green; `approval` timelines need the approval first. Landing is compact: Timelines applies the approved tree change onto current main, runs the repository's gates on that exact candidate, and advances main to a single new commit. Work-in-progress commits stay in the timeline's own repository. For a timeline that spans several repositories, every repository is prepared and gated before any main advances.

Conflicts and failed gates stop landing. Sync, push, and make a new checkpoint (and get a new approval) when the work changes. If main moves during landing, the candidate is prepared and gated again.

After landing, `gm sync` replays only your unlanded local work onto main. Then run `gm timeline use main` or start a new timeline; the checkout keeps refusing pushes to the ended timeline until you do.

Issues completed in a timeline are done there, and shown as done in the timeline everywhere else, until it lands.

## Previews

Timelines does not host previews; your CI deploys them. A repository opts in with `on: preview` in `.gitmatrix/ci.yml`. Each checkpoint then starts a preview run (`trigger == "preview" && action == "create"`) at the checkpoint's commit, and a job records where it deployed with `gm deploy record --url "$URL"`. When previews expire, Timelines starts a `teardown` run. By default a preview expires 2 days after its timeline lands or is abandoned, or after 7 days without a push.

```sh
gm timeline revive search-v2 -c 3   # rebuild an expired checkpoint's preview
```

## Other commands

```sh
gm timeline list                          # newest first; --stalled for open timelines with no recent push
gm timeline show                          # this checkout's timeline and its events
gm timeline update search-v2 --experimental
gm timeline abandon search-v2
```

Abandoning ends writes and archives the work read-only. Only the timeline's accountable person or the agent that started it may abandon it. Ended timelines stay readable; by default their work repositories expire 30 days after landing or 90 days after abandonment, which account administrators can change under Data retention.

In the web app, a timeline switcher scopes every page (code, CI, tracker, knowledge, wiki) to main plus the selected timeline, and the timeline graph shows forks, merges and landings.

See [`gm timeline start`](/docs/gm/#gm-timeline-start), [`gm timeline checkpoint`](/docs/gm/#gm-timeline-checkpoint) and [`gm timeline land`](/docs/gm/#gm-timeline-land) in the reference.
