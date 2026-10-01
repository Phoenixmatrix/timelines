---
version: 1
slug: "src-routes-tracker-tracker-tsx"
primary_target: "src/routes/tracker/Tracker.tsx"
related_targets:
  [
    "src/routes/tracker/IssueDetail.tsx",
    "src/routes/tracker/Admin.tsx",
    "src/routes/tracker/Graph.tsx",
    "src/routes/repo/Tracker.tsx",
  ]
---

# Issue tracker workbench

- **Scope / mode:** `/tracker`, account tracker routes, issue detail, tracker administration, and repository Issues links. Operate mode within the existing Gitmatrix visual system.
- **Audience and job:** humans organizing work alongside agents executing it; capture a small task quickly, expand it into a PRD when needed, and understand readiness and handoff context without leaving the selected issue.
- **Primary task:** choose account/team/workspace, capture or select an issue, inspect or edit its plan and dependencies, then record progress or completion evidence.
- **Content and proof:** real account-authorized issue data, explicit status/readiness/claim state, Markdown description and acceptance, separate hierarchy and blockers, durable discussion, and visible version-conflict recovery. Never populate production with demonstration records.
- **Chosen direction:** Issue workbench, candidate 3, seed `c9cce501`, approved through the structured fallback after the decision-page launcher reported no local browser. Code-first explicitly selected; no generated visual comp.
- **Composition:** the established global rail and account controls; fast capture and scoped filters above a 42/58 collection/detail split. List, board and focused blocker graph share one selected issue. Mobile navigates list to detail with a clear return path and focus clear of sticky navigation.
- **Memorable interaction:** the selected task and its execution context remain together; blockers explain readiness rather than becoming a separate project dashboard.
- **Constraints:** preserve MatrixKit identity and component conventions. Repository subscriptions only improve navigation. Every edit must survive a conflicting server version; lease-dependent completion must not imply an offline guarantee. Do not imply an autonomous execution loop exists.
- **Required states:** empty tracker and filtered list, loading and failed requests, pending writes, preserved drafts and explicit version review, active/expired claims, blocked completion, archived teams/workspaces, and permission-limited management.
- **Review and finish:** dual-assessor Claude CLI / Impeccable re-review returned SHIP, with no P0/P1 findings. Remaining P2/P3 findings were corrected and verified locally through real browser/API scenarios, including repeated lost acknowledgements, semantic set conflicts, closed-work recovery, mobile focus, clock skew and light contrast. `DESIGN.md` records the shipped system. No production illustration or generated raster was introduced.
- **Unresolved decisions:** none in the approved surface direction.
