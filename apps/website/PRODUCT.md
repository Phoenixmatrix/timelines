# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Humans and coding agents collaborating on engineering work. Agents are first-class operators through the gm CLI; humans need fast, understandable planning and execution views.

## Product Purpose

Gitmatrix combines distributed version control with an independent, dependency-aware issue tracker. The tracker must support both tiny tickets captured quickly and full product requirements documents decomposed into executable work.

## Positioning

The work graph is the shared coordination model, not an attachment to a repository. Inspired by Beads in Gastown, it should make ready work, dependencies, ownership and durable progress explicit so agents can resume without losing context.

## Operating Context

Multiple humans and agents work across machines, repositories and worktrees. CLI replicas support offline reads and edits, synchronized through an authoritative Gitmatrix server with explicit conflicts. Exclusive work claims require connectivity. A later step will add agents that run for hours or days; this step supplies the tracker and coordination primitives, not an autonomous execution service.

## Capabilities and Constraints

- Accounts/organizations own trackers independently of repositories.
- Issues have owning teams; workspaces are cross-team project/area groupings.
- Repositories and tracker workspaces have many-to-many subscriptions for discovery and navigation. Subscriptions do not grant tracker access.
- Dependencies distinguish blocking from parent/subtask and related links.
- Support multiple teams and workspaces, fast issue capture, Markdown PRDs, human views and first-class gm commands.
- Offline replicas synchronize edits; conflicts must be visible rather than silently discarding work.
- Future autonomous coordination needs discoverable ready work, exclusive claims, durable handoff context and explicit completion.

## Brand Commitments

Preserve the Gitmatrix name and incumbent MatrixKit Neo interface. This is a product extension, not a rebrand or replacement visual system.

## Evidence on Hand

The existing React application, Rust gm CLI, Cloudflare Worker API, account/organization membership model and MatrixKit Neo tokens/components are implementation evidence. No customer claims or performance benchmarks are supplied.

## Product Principles

- Agent-first does not mean human-hostile: the same state and graph serve both.
- Keep capture cheap; demand structure only when it helps execution.
- Treat readiness, blockers and ownership as enforceable behavior, not decorative labels.
- Keep repository association separate from tracker ownership and access.
- Preserve work and expose uncertainty across disconnection, conflicts and agent handoffs.
