---
title: Introduction
description: What Timelines is, who it is for, the loop it is built around, and where to find each part of these docs.
section: Start
order: 1
---

Timelines is a git host built for agent-driven development. It runs entirely on Cloudflare: git storage, the git proxy, the database, CI and the AI that keeps track of each repository are all built from Cloudflare's platform, so there are no servers for you to operate.

It hosts git repositories, runs CI, keeps a package registry and an issue tracker, and maintains a knowledge graph and generated wiki for every repository. You reach all of it through the web app at [timelinesapp.fward.dev](https://timelinesapp.fward.dev) and through `gm`, the command-line client.

## Who it is for

**Agents first.** Coding agents are the primary users. They work through `gm` and the JSON API: clone, commit change after change, land work on trunk, wait on CI and read the knowledge graph. Every capability works headlessly, with structured and predictable output, before or alongside its web UI. `gm` prints compact JSON when an agent or a pipe is reading, reports errors as JSON with stable codes and exit codes, accepts `--dry-run` on every mutating command, and describes itself through `gm cli search` and `gm schema`.

**And the people behind them.** Developers, working alone or in organizations with members and roles, use the web app to see what landed, browse code and history, follow CI runs and their logs, read the wiki and knowledge graph, answer the questions their agents ask, and manage access: repositories, collaborators, access tokens and SSH keys.

The aim is that an agent can do the whole loop without a person, and that a person can quickly see and trust what happened.

## The loop

1. **Clone.** `gm clone owner/name` gives you a normal git repository set up for gm.
2. **Change.** gm is change-based, like jujutsu. Your edits always live in a change, every operation can be undone, and rewriting a change rebases everything built on it. Commit early and often; there is no staging area.
3. **Push to trunk.** There are no pull requests. `gm push` lands your changes on trunk. Larger or riskier work can go to a [timeline](/docs/concepts/timelines/) first and land on main later, automatically or after a person approves it.
4. **CI checks it.** Each push runs the pipeline in the repository's `.gitmatrix/ci.yml`. `gm runs wait` blocks until the run finishes and exits non-zero if it failed.
5. **Knowledge stays current.** Timelines keeps an incrementally updated knowledge graph of each repository (files, symbols, components, concepts) and a wiki generated from it. Agents and people read the same understanding of the code.

```sh
gm clone orbit/engine && cd engine
# edit files
gm commit -m "Add retry to fetch"
gm push && gm runs wait
```

## How these docs are organized

**Start**

- [Getting started](/docs/getting-started/): install `gm`, sign in, create or clone a repository, push a change and watch CI.

**Concepts**

- [Changes and trunk](/docs/concepts/changes/): the change-based model, undo, automatic rebasing, and how `gm push` lands work on main.
- [Timelines](/docs/concepts/timelines/): separate lines of work with checkpoints, approvals, landing and previews.
- [CI and steps](/docs/concepts/ci/): `.gitmatrix/ci.yml`, what runs on a push, and following runs from the terminal.
- [The issue graph](/docs/concepts/issue-graph/): the tracker, readiness, claims and leases, asking a person, and the merge queue.
- [Agents](/docs/concepts/agents/): agent identities, `gm agent setup`, profiles, intervention modes, and gm's machine-readable interface.
- [Knowledge](/docs/concepts/knowledge/): the knowledge graph, the generated wiki, the Atlas, and `gm ask`.

**Reference**

- [The gm command reference](/docs/gm/) lists every command with its arguments and options.

If you are an agent, run `gm cli guide` once per session. It prints the whole gm workflow on one page and is written to be pasted into an `AGENTS.md`.
