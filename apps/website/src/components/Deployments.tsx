// Deployment records (CORE-78) where code is shown: what a CI run deployed,
// and where each listed commit is deployed. Gitmatrix deploys nothing; jobs
// and outside systems record their deployments (`gm deploy record`).

import { ArrowSquareOutIcon, GlobeSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { Deployment, DeploymentList, DeploymentStatus } from "../../shared/deployments.ts";
import { api } from "../lib/api.ts";
import { fullDate, timeAgo } from "../lib/format.ts";
import { sourceUrl } from "../lib/refs.ts";
import { RecentAgents } from "./RecentAgents.tsx";

export const DEPLOYMENT_LABEL: Record<DeploymentStatus, string> = {
  active: "Active",
  sleeping: "Sleeping",
  expired: "Expired",
  failed: "Failed",
};

const STATUS_TONE: Record<DeploymentStatus, string> = {
  active: "text-online",
  sleeping: "text-ink-muted",
  expired: "text-ink-faint",
  failed: "text-danger-text",
};

/** A deployment's address, or a note when it has none; expired ones aren't links. */
function Address({ deployment }: { deployment: Deployment }) {
  if (!deployment.url) return <span className="text-ink-faint">No address</span>;
  const label = deployment.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (deployment.status === "expired" || deployment.status === "failed")
    return <span className="mk-mono truncate text-mono text-ink-faint">{label}</span>;
  return (
    <a
      href={deployment.url}
      target="_blank"
      rel="noreferrer"
      className="mk-mono inline-flex min-w-0 items-center gap-1 text-mono"
    >
      <span className="truncate">{label}</span>
      <ArrowSquareOutIcon weight="bold" className="shrink-0" aria-hidden />
    </a>
  );
}

/** Everything a CI run recorded as deployed, newest first. */
export function DeploymentsPanel({
  deployments,
  owner,
  name,
}: {
  deployments: Deployment[];
  owner: string;
  name: string;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);
  if (deployments.length === 0) return null;
  return (
    <section aria-labelledby="ci-deployments" className="overflow-hidden rounded-pane bg-pane">
      <h3 id="ci-deployments" className="m-0 border-b border-line-soft px-4 py-3 text-title">
        Deployments
      </h3>
      <ul className="m-0 list-none divide-y divide-line-soft p-0">
        {deployments.map((deployment) => (
          <li
            key={deployment.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-body-sm"
          >
            <GlobeSimpleIcon
              weight="bold"
              className={`shrink-0 ${STATUS_TONE[deployment.status]}`}
              aria-hidden
            />
            <span className="font-semibold">{deployment.environment}</span>
            <span className="mk-chip mk-chip--tag">{DEPLOYMENT_LABEL[deployment.status]}</span>
            {deployment.checkpoint && (
              <span className="mk-chip mk-chip--tag mk-mono" title="Checkpoint">
                {deployment.checkpoint}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <Address deployment={deployment} />
            </span>
            <span className="text-micro text-ink-faint">
              {deployment.job && `${deployment.job} · `}
              <span title={fullDate(deployment.createdAt)}>{timeAgo(deployment.createdAt)}</span>
              {deployment.expiresAt && deployment.status !== "expired" && (
                <span title={fullDate(deployment.expiresAt)}>
                  {" "}
                  · {Date.parse(deployment.expiresAt) > Date.now() ? "expires" : "expired"}{" "}
                  {timeAgo(deployment.expiresAt)}
                </span>
              )}
            </span>
            <button
              type="button"
              className="mk-btn mk-btn--sm mk-btn--ghost"
              aria-expanded={expanded === deployment.id}
              aria-controls={`deployment-presence-${deployment.id}`}
              onClick={() => setExpanded(expanded === deployment.id ? null : deployment.id)}
            >
              Agents seen recently
            </button>
            <div id={`deployment-presence-${deployment.id}`} className="w-full">
              {expanded === deployment.id && (
                <RecentAgents
                  endpoint={sourceUrl(
                    `/repos/${owner}/${name}/deployments/${deployment.id}/presence`,
                    deployment.sourceId,
                  )}
                />
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The newest deployment of each listed commit, loaded after the page shows so
 * it never waits on them.
 */
export function useCommitDeployments(
  owner: string,
  name: string,
  oids: string[],
  sourceId?: string,
): Record<string, Deployment> {
  const [latest, setLatest] = useState<Record<string, Deployment>>({});
  const key = oids.join(",");
  useEffect(() => {
    if (!key) return;
    let current = true;
    api<DeploymentList>(
      sourceUrl(`/repos/${owner}/${name}/deployments?limit=100&commit=${key}`, sourceId),
    )
      .then((page) => {
        if (!current) return;
        const found: Record<string, Deployment> = {};
        // Newest first: the first seen per commit wins.
        for (const deployment of page.deployments) found[deployment.commit] ??= deployment;
        setLatest((previous) => ({ ...previous, ...found }));
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [owner, name, key, sourceId]);
  return latest;
}

/** A commit's newest deployment as an icon: a link to it while it's up. */
export function DeploymentMark({ deployment }: { deployment: Deployment }) {
  const title = `Deployed to ${deployment.environment}: ${DEPLOYMENT_LABEL[deployment.status].toLowerCase()}`;
  const icon = (
    <GlobeSimpleIcon
      weight="bold"
      className={`size-4 shrink-0 ${STATUS_TONE[deployment.status]}`}
      aria-label={title}
    />
  );
  const up = deployment.url && (deployment.status === "active" || deployment.status === "sleeping");
  return up ? (
    <a href={deployment.url!} target="_blank" rel="noreferrer" title={title} className="flex">
      {icon}
    </a>
  ) : (
    <span title={title} className="flex">
      {icon}
    </span>
  );
}
