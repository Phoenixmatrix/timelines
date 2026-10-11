# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Primary: AI coding agents.** They work through `gm` (the agent-first CLI)
  and the JSON API: clone, commit change after change, land work on trunk,
  wait on CI, read the knowledge graph. They need interfaces that are
  discoverable, machine-readable and predictable (structured JSON, stable
  error codes and exit codes, `--dry-run`, schema and search commands).
- **Secondary: the people behind those agents.** Developers, alone or in
  organizations with members and roles, use the web app to see what landed,
  browse code and history, follow CI runs and their logs, read the generated
  wiki and knowledge graph, and manage access (repositories, collaborators,
  access tokens, SSH keys).

## Product Purpose

Timelines is a git host built for agent-driven development, running entirely
on Cloudflare. Agents land work continuously on trunk while CI checks it, and
the host keeps an always-current understanding of every repository (a
knowledge graph, and a wiki generated from it) that agents and people both
read. Success means an agent can do the whole loop (clone, change, push,
verify CI, understand the codebase) without a person, and a person can see and
trust what happened quickly.

## Positioning

- **Cloudflare-native end to end:** git storage on Cloudflare Artifacts, a
  smart-HTTP git proxy on Workers, D1, Durable Objects, Workflows, CI jobs in
  Cloudflare Sandbox containers, Workers AI, Vectorize and AI Search. No
  servers to run.
- **Agent-first, change-based version control:** `gm` works like jujutsu
  (every edit lives in a change, every operation can be undone, descendants
  rebase automatically) and is built for agents committing very frequently.
  There are no pull requests: changes land on trunk.
- **The knowledge graph is the core:** an incrementally updated graph of each
  repository (files, symbols, components, concepts) rebuilt on every push. It
  is the input for many features; the wiki is one consumer of it.

## Operating Context

- Agents run `gm` in terminals and sandboxes, many commits at a time, then
  `gm push` and `gm runs wait` to land work and confirm CI.
- Everything is HTTPS: git smart HTTP with tokens, and SSH keys used over
  HTTPS (gm signs a challenge through ssh-agent, 1Password or key files).
- The web app's repository views: Code, Commits, CI, Wiki, Knowledge,
  Settings. Account views: access tokens, SSH keys.
- Development: `vp dev` locally against real Cloudflare services, dev
  personas instead of sign-in, CI jobs run by `gm runner` on the developer's
  machine.

## Capabilities and Constraints

- **Confirmed capabilities:** repositories (create, import public git URLs,
  visibility, collaborators, org roles); git clone/fetch/push over HTTPS;
  `gm` with change-based workflow, discovery, JSON output and CI commands;
  personal access tokens and SSH-key sign-in; CI/CD pipelines from
  `.gitmatrix/ci.yml` with live logs; knowledge graph, semantic search and an
  auto-updated wiki, with concepts aligned and trimmed by a classifier model.
- **Constraints:** Workers speak HTTP only, so SSH features run over HTTPS.
  Navigation in the web app should feel near instant.
- **Current terminology** (in use, not binding): change, working copy, trunk,
  bookmark, run, job, step, concept, component.
- **Open decisions:** who the outside users are (a team, customers, or open
  source); real authentication (sign-in today is dev personas and tokens, and
  security is prototype-grade); deployment and public domain; pricing and
  licensing.

## Brand Commitments

- The name **Timelines**; the CLI binary is `gm`.
- The web app uses the **MatrixKit Neo** design system from Claude Design
  (tokens in `apps/website/src/styles/tokens.css`, components in
  `matrixkit.css`, vendored as is).

## Evidence on Hand

- The working product, run locally with `vp dev`.
- Technical documentation: `apps/website/README.md`, `apps/cli/README.md`.
- Measured results recorded in the website README: navigation latency,
  knowledge-build times, concept-alignment results.
- **Absent, never to be fabricated:** users, customers, testimonials, usage
  numbers, pricing, a public deployment, logos beyond the name.

## Product Principles

1. **Agents are first-class users.** Every capability works headlessly, with
   structured and predictable output, before or alongside its UI.
2. **Trunk is the truth.** Work lands continuously without pull requests;
   history, CI and the knowledge graph make what landed legible and
   trustworthy.
3. **Understanding is part of the product.** Each repository's knowledge
   stays current with every push, and it powers what people and agents read.
4. **Cloudflare-native, nothing to operate.** Features are built from
   Cloudflare's platform rather than servers.
5. **Fast enough to feel instant.**
