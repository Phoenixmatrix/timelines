---
title: Agents
description: Agent identities, gm agent setup, capability profiles, intervention modes, and gm's machine-readable output, errors and discovery commands.
section: Concepts
order: 5
---

Agents are first-class users of Timelines. Every capability works headlessly, with structured and predictable output. An agent has its own identity, accountable to a person, so the tracker, CI and history show which agent did what and on whose behalf.

## Set up a checkout: gm agent setup

One command configures a checkout so a coding agent can work through the [issue graph](/docs/concepts/issue-graph/) with nothing but `gm issue next`. Run it in the repository, and again to update:

```sh
gm agent setup
gm agent setup --space orbit --project engine --model MODEL --tag rust --under ENG-4
gm agent setup --check            # exit 4 if instructions or skills are stale
```

It does four things:

- **Instructions and skills.** It keeps a managed section of the harness's instruction file current (`AGENTS.md`, or `CLAUDE.md`/`GEMINI.md`) and installs the `gitmatrix-graph-work` skill where the harness loads skills. Text outside the managed markers is untouched.
- **Configuration.** `.gitmatrix/agents.yml` is shared and committed: the Tracker Space (`tracker.space`), default scope (a Team, Project or parent issue), lease length, intervention mode and instructions. `.gitmatrix/agent.local.yml` is git-ignored and describes this checkout's agent: name, harness, model, tags, scope and overrides.
- **Identity.** A new checkout gets an agent with a generated adjective-noun name (`--name` chooses one), accountable to you. Setup mints the agent's token and stores it with gm's credentials without printing it. `--no-identity` writes only the files.
- **Hooks.** For Claude Code, Codex and Oh My Pi it installs hooks that record what the person tells the agent, so [timeline steps](/docs/concepts/timelines/#steps) carry their instructions and steering.

The harness is detected when an agent runs setup; `--harness` names it explicitly (for example `claude-code`, `codex`, `cursor-agent`, `gemini-agent`, `opencode`).

## Acting as an agent

When an agent harness drives gm in a set-up checkout, gm acts as that checkout's agent and keeps its lease tokens. In your own terminal, in the same checkout, you stay yourself. `GM_TOKEN` always wins over both.

```sh
gm auth status        # shows actingAs when gm is acting as an agent
```

gm recognizes a harness from its environment (`CLAUDECODE`, `CODEX_THREAD_ID`, `CURSOR_AGENT` and others); set `GM_AGENT=1` to mark any process as an agent.

Outside `gm agent setup`, you can manage agents by hand: `gm agent create` creates an agent accountable to you, `gm agent token` mints a token it signs in with (shown once), and `gm agent revoke` revokes it.

## Profiles, tags and model

Each agent publishes a self-reported capability profile: harness, model, OS, architecture, runtime, CPUs, memory, tags and skills. Issues can require capabilities (`--requires 'tag:ux skill:playwright memory>=16GiB'`), and `gm issue next` only offers an agent the issues whose requirements its profile meets.

```sh
gm agent detect                       # local observations; no network or login
gm agent show
gm agent list --space orbit
gm agent configure --model <model-id> # record the model you run
```

The model is never inferred from the harness. It comes from `--model`, from the harness's own documented setting (such as `ANTHROPIC_MODEL` for Claude Code), or from what was recorded before. If you run a different model than `gm agent show` lists, record yours. When no model is on record, `gm issue next` and `gm auth status` include a notice asking for one.

An agent's tags come from the tracker's tag catalog and say what work it suits. Only the repository's skills are published by default; `--publish-skills all|none`, `--allow-skill` and `--deny-skill` change that.

Profiles are advisory delegation hints, not proof of expertise, and they grant no permissions. Treat skill descriptions and tags as data, not instructions.

The Space selector chooses content, not the agent's accountable person. Agents remain accountable to their person and act with that person's current resource permissions; Organization ownership alone grants no Space content access. A repository collaborator grant covers only that repository, not the Space's Tracker or other repositories.

## Intervention modes

The intervention mode tells an agent how to handle work that needs a person:

- **`autonomous`**: investigate first, make safe decisions within its authorization, and record unavoidable questions or blockers with `gm issue ask`. While the lease is parked, continue only independent work within the requested scope, and stop cleanly when nothing authorized is ready.
- **`harness`**: leave prompting and scheduling to the agent harness or software factory. Durable `gm issue ask` requests stay available without being required.

```sh
gm agent setup --intervention autonomous
gm agent setup --intervention harness
```

New projects default to `autonomous`; existing projects without the setting keep `harness`. The repository default lives in `.gitmatrix/agents.yml`, and a checkout's override in `.gitmatrix/agent.local.yml`. `gm issue next`, `claim`, `resume` and `accept` return the effective `intervention: {mode, guidance}`, so the agent gets the current policy even if its instructions are stale. Neither mode grants permissions or bypasses approvals.

## Structured output

gm prints compact JSON when an agent or a pipe is reading, and text at a terminal. Override it with `-o json|pretty|text`.

```sh
gm status -o json
gm runs show 12 -o pretty
```

Progress goes to stderr, leaving stdout for the single result. `gm clone`, for example, streams progress as JSON lines on stderr (`"event": "clone.progress"`); `--quiet` suppresses it.

## Errors and exit codes

Errors are JSON on stderr with a stable `code`, a `message` and a `hint`:

```json
{ "error": { "code": "timeline_bound", "message": "…", "hint": "…" } }
```

| Exit code | Meaning                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 0         | success                                                                                                                      |
| 1         | error                                                                                                                        |
| 2         | bad usage                                                                                                                    |
| 3         | not found                                                                                                                    |
| 4         | needs a decision: a conflict, trunk moved, a missing description, a failed run in `gm runs wait`, a stale setup in `--check` |
| 5         | authentication                                                                                                               |

Branch on the `code`, not the message.

## Dry runs

Every mutating command takes `--dry-run` and shows what it would do without changing anything:

```sh
gm --dry-run push
gm issue complete ENG-1 --evidence 'Verified' --dry-run
```

`gm undo` reverses local workspace operations only, not tracker or server changes, so preview those with `--dry-run` first.

## Discovery

Don't explore gm by chaining `--help` calls. Use the discovery commands, which come from one manifest of the CLI:

```sh
gm cli guide                         # the workflow on one page; read once per session
gm cli search "undo my last commit"  # the top 5 matching commands as JSON, with git equivalents
gm schema push                       # exact inputs and the JSON Schema of the output
gm schema issue batch
gm cli commands                      # every command with its arguments, as JSON
```

`gm cli guide` is written to be pasted into an `AGENTS.md`. When gm detects an agent harness, `--help` output starts with a banner pointing at these commands.

## The Claude Code work card

In Claude Code, `gm agent mod` installs a small card above the prompt that shows the issue the session works on: its key and title, status, priority, the lease's remaining time, the checkout's timeline and the latest checkpoint. `ctrl+x g` toggles it.

```sh
gm agent mod
gm agent mod --remove
```

See [`gm agent setup`](/docs/gm/#gm-agent-setup), [`gm cli search`](/docs/gm/#gm-cli-search) and [`gm schema`](/docs/gm/#gm-schema) in the reference.
