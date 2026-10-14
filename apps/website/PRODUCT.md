# Product

## Platform

web

## Users

Humans and coding agents collaborating on engineering work. Agents are first-class operators through the gm CLI; humans need fast, understandable planning and execution views.

## Product Purpose

Timelines combines distributed version control with an independent, dependency-aware issue tracker. The tracker must support both tiny tickets captured quickly and full product requirements documents decomposed into executable work.

## Positioning

The work graph is the shared coordination model, not an attachment to a repository. Inspired by Beads in Gastown, it should make ready work, dependencies, ownership and durable progress explicit so agents can resume without losing context.

## Operating Context

Multiple humans and agents work across machines, repositories and worktrees. CLI replicas support offline reads and edits, synchronized through an authoritative Timelines server with explicit conflicts. Exclusive work claims require connectivity. A later step will add agents that run for hours or days; this step supplies the tracker and coordination primitives, not an autonomous execution service.

## Capabilities and Constraints

- Organizations are company or private personal tenants; their Spaces own repositories and independent trackers. Account is person identity, and Instance is the separate operator scope.
- Issues have exactly one responsible Team and may belong to multiple same-Space Projects. Organization membership or ownership alone grants no private Space content access.
- Repositories and same-Space Projects have many-to-many subscriptions for discovery and navigation. Subscriptions grant neither tracker nor repository access; explicit resource collaborators remain resource-only.
- Dependencies distinguish blocking from parent/subtask and related links.
- Support multiple Teams and Projects, fast issue capture, Markdown PRDs, human views and first-class gm commands. A one-Space Organization starts in its real default Space with an explicit bootstrap grant.
- Offline replicas synchronize edits; conflicts must be visible rather than silently discarding work.
- Future autonomous coordination needs discoverable ready work, exclusive claims, durable handoff context and explicit completion.

## Brand Commitments

The product name is **Timelines**. Preserve the incumbent MatrixKit Neo interface. The approved brand identity is **Pounce**: the selected flowing cat silhouette, expressing parallel agents and fast development. Preserve that artwork instead of returning to a generic G lettermark or substituting another cat. Mint/deep-forest brand colors belong to the logo; amber actions and existing status semantics remain unchanged.

## Evidence on Hand

The existing React application, Rust gm CLI, Cloudflare Worker API, Organization/Space grants, separate person identity and MatrixKit Neo tokens/components are implementation evidence. No customer claims or performance benchmarks are supplied.

## Product Principles

- Agent-first does not mean human-hostile: the same state and graph serve both.
- Keep capture cheap; demand structure only when it helps execution.
- Treat readiness, blockers and ownership as enforceable behavior, not decorative labels.
- Keep repository association separate from tracker ownership and access.
- Preserve work and expose uncertainty across disconnection, conflicts and agent handoffs.
