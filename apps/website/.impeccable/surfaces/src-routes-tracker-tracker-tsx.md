---
version: 1
slug: "src-routes-tracker-tracker-tsx"
primary_target: "src/routes/tracker/Tracker.tsx"
related_targets:
  [
    "src/routes/tracker/Lens.tsx",
    "src/routes/tracker/Log.tsx",
    "src/routes/tracker/IssueDetail.tsx",
    "src/routes/tracker/Admin.tsx",
    "src/routes/repo/Tracker.tsx",
    "src/routes/Preferences.tsx",
    "src/components/AppShell.tsx",
  ]
---

# Issue tracker: throughput console

- **Scope / mode:** `/tracker/:owner` (list, board, graph), issue inspector, tracker administration, and the repository Issues tab. Operate mode inside MatrixKit Neo.
- **Audience and job:** humans organizing work alongside agents executing it, at tens of thousands of issues: see what can move now, narrow fast, open an issue beside the stream, trace what blocks what.
- **Chosen direction:** throughput-console, seed `49700b21`, code-led (decision page, 2026-10-01). Supersedes the earlier issue workbench (`c9cce501`).
- **Composition:** one header row (owner, team + capture, sync); a mono query bar with List/Board/Graph; saved-view chips and the count; a brushable opened/closed strip; then the 32px virtualized log filling the height, with a 17rem facet column that becomes the inspector when an issue opens. Phones fold facets, count and strip into "Narrow it down"; an open issue replaces the list.
- **Settings:** personal startup defaults and browser-local keyboard shortcuts live in account menu → Preferences. The bottom-of-rail Settings gear opens shared Teams and workspaces administration, retaining the current tracker, filters and layout. On phones the rail wraps with 44px place targets rather than squeezing or clipping Settings and account controls.
- **Graph view:** the relationship lens (user direction, 2026-10-01): one issue centred, blockers left and dependents right in columns per step (1–3), parent trail above, sub-issues and related below, connectors only between neighbouring columns (red while still blocking), click to re-centre with a view transition, a trail back, and a start screen (search, Bottlenecks, Furthest from ready). Explicitly not a whole-graph canvas, force layout or flame-graph mosaic.
- **Scale:** one index per sync (`query.ts`), so readiness, blockers and facets are lookups; list and board lanes are virtualized; the lens renders only a neighbourhood. Verified against a labelled synthetic 20,005-issue tracker in a dev persona's account, never the real Gitmatrix tracker.
- **Constraints:** amber only for selection, the primary action and live state; data hues only in the strip; claimed is a hollow ink ring. Every edit survives a conflicting server version; retries reuse the operation ID.
- **Review and finish:** finish review (general-purpose agent following the degraded finish-reviewer role) returned fix; fixes applied and recaptured for the verdict pass. DESIGN.md records the event log, relationship lens and status-by-shape rule.
