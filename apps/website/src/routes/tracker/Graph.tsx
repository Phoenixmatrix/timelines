import { Link, useNavigate } from "react-router";
import type { Issue, Snapshot } from "../../../shared/tracker.ts";
import { IssuePicker, IssueState } from "./ui.tsx";

export function DependencyGraph({
  issues,
  snapshot,
  selected,
  href,
}: {
  issues: Issue[];
  snapshot: Snapshot;
  selected?: string;
  href: (id?: string) => string;
}) {
  const navigate = useNavigate();
  const focus = selected ? snapshot.issues.find((issue) => issue.id === selected) : undefined;
  const included = new Set((focus ? [focus] : issues).map((issue) => issue.id));
  // Expand only blocker ancestry: every displayed chain explains why visible work cannot start.
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const link of snapshot.links)
      if (link.kind === "blocks" && included.has(link.toId) && !included.has(link.fromId)) {
        included.add(link.fromId);
        expanded = true;
      }
  }
  if (focus)
    for (const link of snapshot.links)
      if (link.kind === "blocks" && link.fromId === focus.id) included.add(link.toId);
  const nodes = snapshot.issues.filter((issue) => included.has(issue.id));
  const edges = snapshot.links.filter(
    (link) => link.kind === "blocks" && included.has(link.fromId) && included.has(link.toId),
  );
  const connectedIds = new Set(edges.flatMap((edge) => [edge.fromId, edge.toId]));
  const isolatedNodes = focus ? [] : nodes.filter((node) => !connectedIds.has(node.id));
  const chainNodes = focus ? nodes : nodes.filter((node) => connectedIds.has(node.id));
  const levels = new Map<string, number>();
  for (let pass = 0; pass < chainNodes.length; pass++) {
    let changed = false;
    for (const node of chainNodes) {
      const incoming = edges.filter((edge) => edge.toId === node.id);
      if (incoming.every((edge) => levels.has(edge.fromId)) && !levels.has(node.id)) {
        levels.set(
          node.id,
          incoming.length ? Math.max(...incoming.map((edge) => levels.get(edge.fromId)!)) + 1 : 0,
        );
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Match keyboard traversal to the left-to-right dependency order.
  chainNodes.sort(
    (a, b) =>
      (levels.get(a.id) ?? 0) - (levels.get(b.id) ?? 0) ||
      a.key.localeCompare(b.key, undefined, { numeric: true }),
  );
  isolatedNodes.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  const rows = new Map<number, number>();
  const positions = new Map(
    chainNodes.map((node) => {
      const level = levels.get(node.id) ?? 0;
      const row = rows.get(level) ?? 0;
      rows.set(level, row + 1);
      return [node.id, { x: level * 280 + 20, y: row * 156 + 20 }];
    }),
  );
  const width = (Math.max(0, ...levels.values()) + 1) * 280;
  const height = Math.max(1, ...rows.values()) * 156;
  return (
    <section aria-label="Dependency graph">
      <div className="tracker-graph-intro">
        <h2 className="text-title m-0">
          {focus ? `${focus.key} dependency chain` : "Dependency graph"}
        </h2>
        <p className="mk-hint">
          Arrows run from blocker to blocked issue. Prerequisites outside your filters stay visible.{" "}
          {focus
            ? "Choose another issue to inspect its chain."
            : "Select an issue to focus its chain."}
        </p>
        <div className="tracker-graph-controls">
          <IssuePicker
            label="Find an issue"
            value={focus?.id ?? ""}
            onChange={(id) => navigate(href(id || undefined))}
            issues={snapshot.issues}
            placeholder="Search key or title…"
          />
          {focus && (
            <Link className="mk-btn no-underline" to={href()}>
              Show all dependencies
            </Link>
          )}
        </div>
        {focus && (
          <p className="tracker-graph-selection">
            <span className="mk-mono">{focus.key}</span> · {focus.title}
          </p>
        )}
      </div>
      {nodes.length ? (
        <>
          {chainNodes.length > 0 && (
            <div
              className="tracker-graph-scroll"
              tabIndex={0}
              aria-label="Scrollable dependency graph"
            >
              <div className="tracker-graph-canvas" style={{ width, height }}>
                <svg width={width} height={height} aria-hidden="true">
                  <defs>
                    <marker
                      id="tracker-arrow"
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="6"
                      markerHeight="6"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                    </marker>
                  </defs>
                  {edges.map((edge) => {
                    const from = positions.get(edge.fromId)!;
                    const to = positions.get(edge.toId)!;
                    return (
                      <path
                        key={edge.id}
                        d={`M ${from.x + 232} ${from.y + 62} C ${from.x + 257} ${from.y + 62}, ${to.x - 25} ${to.y + 62}, ${to.x - 5} ${to.y + 62}`}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        markerEnd="url(#tracker-arrow)"
                      />
                    );
                  })}
                </svg>
                {chainNodes.map((node) => (
                  <Link
                    key={node.id}
                    className="tracker-graph-node"
                    aria-current={selected === node.id ? "true" : undefined}
                    title={`${node.key} · ${node.title}`}
                    to={href(node.id)}
                    style={{ left: positions.get(node.id)!.x, top: positions.get(node.id)!.y }}
                  >
                    <span className="mk-mono text-body-sm">{node.key}</span>
                    <strong>{node.title}</strong>
                    <IssueState issue={node} snapshot={snapshot} />
                  </Link>
                ))}
              </div>
            </div>
          )}
          {isolatedNodes.length > 0 && (
            <section className="tracker-graph-isolated" aria-label="Issues without dependencies">
              <h3 className="text-title m-0">No dependencies in this view</h3>
              <div className="tracker-graph-isolated-grid">
                {isolatedNodes.map((node) => (
                  <Link
                    key={node.id}
                    className="tracker-graph-node"
                    title={`${node.key} · ${node.title}`}
                    to={href(node.id)}
                  >
                    <span className="mk-mono text-body-sm">{node.key}</span>
                    <strong>{node.title}</strong>
                    <IssueState issue={node} snapshot={snapshot} />
                  </Link>
                ))}
              </div>
            </section>
          )}
          <details className="tracker-graph-intro">
            <summary>Read dependency connections ({edges.length})</summary>
            {edges.length ? (
              <ul>
                {edges.map((edge) => (
                  <li key={edge.id}>
                    <Link className="gm-link" to={href(edge.fromId)}>
                      {snapshot.issues.find((issue) => issue.id === edge.fromId)?.key}
                    </Link>{" "}
                    blocks{" "}
                    <Link className="gm-link" to={href(edge.toId)}>
                      {snapshot.issues.find((issue) => issue.id === edge.toId)?.key}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No blockers in this view.</p>
            )}
          </details>
        </>
      ) : (
        <p className="mk-empty">No issues match these filters.</p>
      )}
    </section>
  );
}
