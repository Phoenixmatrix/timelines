import { RobotIcon } from "@phosphor-icons/react";
import { useEffect, useId, useState } from "react";
import type { AgentPresence } from "../../shared/agent-presence.ts";
import { api } from "../lib/api.ts";

/** Read-only, approximate presence. Changing the resource discards its entire local snapshot. */
export function RecentAgents({ endpoint, label }: { endpoint: string; label?: string }) {
  return <ResourceAgents key={endpoint} endpoint={endpoint} label={label} />;
}

function ResourceAgents({ endpoint, label }: { endpoint: string; label?: string }) {
  const headingId = useId();
  const [snapshot, setSnapshot] = useState<{
    presence: AgentPresence;
    receivedAt: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    let controller: AbortController | null = null;
    let disposed = false;
    const refresh = async () => {
      if (document.visibilityState === "hidden" || controller) return;
      const request = new AbortController();
      controller = request;
      setLoading(true);
      try {
        const presence = await api<AgentPresence>(endpoint, { signal: request.signal });
        if (disposed || request.signal.aborted) return;
        const receivedAt = performance.now();
        setSnapshot({ presence, receivedAt });
        setNow(receivedAt);
        setFailed(false);
      } catch {
        if (!disposed && !request.signal.aborted) setFailed(true);
      } finally {
        if (!disposed && !request.signal.aborted) setLoading(false);
        if (controller === request) controller = null;
      }
    };
    const visibilityChanged = () => {
      setNow(performance.now());
      if (document.visibilityState === "hidden") {
        controller?.abort();
        controller = null;
        setLoading(false);
      } else {
        void refresh();
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [endpoint, retry]);

  // Age server time monotonically so client clock changes cannot revive expired presence.
  const serverNow = snapshot
    ? Date.parse(snapshot.presence.asOf) + Math.max(0, now - snapshot.receivedAt)
    : now;
  const agents =
    snapshot?.presence.agents.filter((agent) => Date.parse(agent.expiresAt) > serverNow) ?? [];
  const nextExpiry = agents.reduce(
    (earliest, agent) => Math.min(earliest, Date.parse(agent.expiresAt)),
    Infinity,
  );
  useEffect(() => {
    if (!Number.isFinite(nextExpiry) || !snapshot) return;
    const currentServerTime =
      Date.parse(snapshot.presence.asOf) + Math.max(0, performance.now() - snapshot.receivedAt);
    const timeout = window.setTimeout(
      () => setNow(performance.now()),
      Math.max(0, nextExpiry - currentServerTime),
    );
    return () => window.clearTimeout(timeout);
  }, [nextExpiry, snapshot, now]);

  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-2 text-body-sm">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 id={headingId} className="font-semibold text-ink">
          Agents seen recently
        </h3>
        {label && <span className="min-w-0 text-ink-muted wrap-anywhere">{label}</span>}
      </div>
      <p className="text-ink-muted">Seen in the last 10 minutes. Approximate, not real-time.</p>
      {agents.length > 0 && (
        <ul className="flex flex-wrap gap-x-6 gap-y-2">
          {agents.map((agent) => (
            <li key={agent.id} className="flex min-w-0 max-w-full items-start gap-2">
              <RobotIcon className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
              <div className="min-w-0 wrap-anywhere">
                <span className="font-medium text-ink">{agent.name}</span>
                <p className="text-ink-muted">
                  Accountable: {agent.accountable.displayName} (@{agent.accountable.slug})
                </p>
                <p className="text-ink-muted">
                  Last seen{" "}
                  <time dateTime={agent.lastSeenAt}>
                    {new Date(agent.lastSeenAt).toLocaleString()}
                  </time>
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div role="status" className="text-ink-muted">
        {loading && !snapshot && !failed && <p>Loading recent agents…</p>}
        {!failed && snapshot && agents.length === 0 && (
          <p>No agents seen in the last 10 minutes.</p>
        )}
        {failed && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p>
              {snapshot ? "Could not refresh recent agents." : "Could not load recent agents."}
              {agents.length > 0 && " Unexpired results are shown."}
            </p>
            <button
              type="button"
              className="mk-btn mk-btn--ghost mk-btn--sm max-sm:min-h-11"
              disabled={loading}
              onClick={() => setRetry((value) => value + 1)}
            >
              {loading ? "Retrying…" : "Retry"}
            </button>
          </div>
        )}
        {snapshot?.presence.truncated && agents.length > 0 && (
          <p>Showing the most recently seen agents.</p>
        )}
      </div>
    </section>
  );
}
