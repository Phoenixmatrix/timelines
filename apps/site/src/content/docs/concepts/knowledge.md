---
title: Knowledge
description: The knowledge graph Timelines keeps for every repository, the wiki generated from it, the Atlas, and asking the assistant with gm ask.
section: Concepts
order: 6
---

Understanding is part of the product. Timelines keeps an always-current picture of every repository, and agents and people read the same one. Its core is the knowledge graph; the wiki, the Atlas, search and the assistant are built on it.

## The knowledge graph

Each repository has a knowledge graph of its directories, files, symbols, packages, components and concepts, with the relationships between them. It is updated incrementally as main changes:

- **Batched updates.** A push to main marks the repository's knowledge as pending. One update then runs at the latest head once pushes pause for a quiet period, and never later than a maximum wait after the first pending push: 10 and 30 minutes by default, adjustable per Space. A repository administrator can start a pending update at once with **Update now** on the Knowledge tab.
- **Updates, not rebuilds.** An update reads only the parts of the tree that changed and analyzes each file version once. Earlier model decisions are reused unless their inputs changed.
- **Concepts.** Concept names found across files are aligned (merging names for the same thing) and trimmed to the ones a newcomer would look up, each with a definition.

The status on the Knowledge tab says which commit the knowledge reflects and how many pushes are pending.

## The wiki

Each repository has a wiki generated from its knowledge graph. It is one consumer of the graph, not a separate index. A page is rewritten only when its inputs change and it is judged out of date; diagrams are drawn from the graph on every update, never by a model. Read it on the repository's Wiki tab.

## The Atlas

The Knowledge tab shows the repository as capability territory: groups of files that work together, found from imports and shared concepts rather than folders. Open a region to see its areas and files, and select anything to read why it is grouped, what it uses and what uses it, and to jump to its source. Labels appear as you zoom in. The Space home page's Knowledge link opens the same view across the repositories you choose within that Space, subject to your access to each source.

## Search

The knowledge graph also powers semantic search over a repository's code and wiki. In the web app's search palette (⌘K or Ctrl+K), choose **Search code and wiki** and press Enter: results come back as entities (which open the Atlas with that entity selected), code and wiki pages. Only indexed files and generated pages are searchable, and searching never starts a build. If the repository is not indexed yet, the palette says so rather than showing no results.

## Timelines

Work in a [timeline](/docs/concepts/timelines/) gets its own view of the knowledge: an overlay of how the timeline changes main's graph, updated once its pushes pause or when you make a checkpoint, and timeline versions of the wiki pages it affects, written at checkpoints. Main's graph and wiki are untouched until the timeline lands.

```sh
gm timeline pages search-v2   # the wiki pages a timeline affects
```

## Asking the assistant: gm ask

`gm ask` puts a question to the Timelines assistant. It reads code and the knowledge graph, issues, CI runs and packages with your permissions, and answers with links.

```sh
gm ask "Why did run 44 fail?"                         # inside a checkout: about its repository
gm ask -R orbit/engine "Where is readiness computed?"
gm ask --chat CHAT_ID "And who changed it last?"      # follow up
gm ask --write "File a P1 bug in ENG for the flaky clone test"
```

- Inside a checkout it knows the repository; use `-R space/name` anywhere else, where `space` is the globally unique Space handle.
- It is read-only unless you pass `--write`, because a terminal cannot approve each change.
- People see the answer stream in. Agents and pipes get one JSON object: `{chatId, url, repo, answer, tools, plan, next}`.
- Conversations are shared with the web app, where the assistant also runs in a panel beside any page (⌘J or Ctrl+J). `gm assistant list`, `show` and `delete` manage them.

Agents can use `gm ask` to find out where code lives, why CI failed, or what an issue depends on, before reading files one by one.

Chats remain personal; selecting a Space does not transfer the conversation to its Organization. Retained tool output is not an access grant: the assistant checks current source access before reusing content from a conversation. If that access cannot be verified, the stored transcript is retained but the conversation is blocked; start a new chat with currently accessible sources. A submitted write may already have committed, so inspect its result before retrying.

## Related history tools

Two commands read the history behind the code rather than the graph:

```sh
gm why src/search.ts:42                     # blame, then the change's timelines, issue, checkpoints and landing
gm semantic list --ref main --limit 30      # individual syntax-level changes, with source links
```

`gm semantic list` reports parser-backed facts (for example a function or call added) for TypeScript, Rust, Python, Go, Markdown, XML, JSON, HTML and CSS. These are syntax facts, not inferred intent.

## AI settings

The knowledge graph, wiki, Atlas descriptions and release notes use AI models, and their cost belongs to the Space that owns the repository. Each Space controls this automatic work in **Settings → AI settings** or with `gm settings ai`:

```sh
gm settings ai show --space orbit
gm settings ai set --space orbit --knowledge off --dry-run
```

There are four independent switches, each on by default: `--knowledge`, `--wiki`, `--atlas` (paid capability descriptions; the Atlas itself stays browsable) and `--release-notes`. Turning knowledge off also stops new wiki and Atlas AI work. Changes affect future work only; they do not rebuild or erase what exists. Explicit Space members can read these settings. Human Space admins can change them; the Instance's existing AI administrator powers separately permit reading and changing them. Agent credentials cannot change spending policy. Organization ownership alone grants neither settings visibility nor content access, and repository collaboration does not grant Space settings access. Interactive features such as the assistant and search are not affected by these switches.

See [`gm ask`](/docs/gm/#gm-ask) and [`gm settings ai set`](/docs/gm/#gm-settings-ai-set) in the reference.
