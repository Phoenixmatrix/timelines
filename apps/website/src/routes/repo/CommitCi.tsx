// CI for the commit you're looking at, beside the branch picker: passing,
// failing or running, the way GitHub shows a branch's status at the top.

import { useEffect, useState } from "react";
import type { CiCommitStatuses, RepoDetail } from "../../../shared/api.ts";
import { CiStatusIcon, isActive } from "../../components/CiStatus.tsx";
import { PrefetchLink } from "../../components/PrefetchLink.tsx";
import { api } from "../../lib/api.ts";
import { repoPath, sourceUrl } from "../../lib/refs.ts";

type Run = CiCommitStatuses[string];

/** How often a queued or running result is checked again. */
const POLL_MS = 15_000;

/** The commit a ref names: a branch or tag head, or a full commit id. */
export function refCommit(repo: RepoDetail, refName: string): string | null {
  const ref = [...repo.branches, ...repo.tags].find((r) => r.shortName === refName);
  if (ref) return ref.oid;
  return /^[0-9a-f]{40}$/.test(refName) ? refName : null;
}

/** The latest run for one commit; checked again while it's still going. */
export function useCommitRun(
  owner: string,
  name: string,
  oid: string | null,
  sourceId?: string,
): Run | null {
  const [run, setRun] = useState<{ oid: string; sourceId?: string; run: Run | null } | null>(null);
  const active = run?.run ? isActive(run.run.status) : false;
  useEffect(() => {
    if (!oid) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      api<CiCommitStatuses>(sourceUrl(`/repos/${owner}/${name}/ci/status?commits=${oid}`, sourceId))
        .then((statuses) => current && setRun({ oid, sourceId, run: statuses[oid] ?? null }))
        .catch(() => {});
    };
    if (run?.oid !== oid || run?.sourceId !== sourceId) load();
    else if (active) {
      timer = setTimeout(function poll() {
        if (document.visibilityState === "visible") load();
        else timer = setTimeout(poll, POLL_MS);
      }, POLL_MS);
    }
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [owner, name, oid, sourceId, run, active]);
  return run?.oid === oid && run.sourceId === sourceId ? run.run : null;
}

const SUMMARY: Record<Run["status"], string> = {
  succeeded: "Passing",
  failed: "Failing",
  running: "Running",
  queued: "Queued",
  cancelled: "Cancelled",
};

/** Nothing when the commit has no run: CI isn't set up, or hasn't reached it. */
export function CommitCi({
  repo,
  refName,
  oid,
}: {
  repo: RepoDetail;
  refName: string;
  oid: string | null;
}) {
  const run = useCommitRun(repo.owner.slug, repo.name, oid, repo.source?.sourceId);
  if (!run) return null;
  const summary = run.coveredBy ? `Covered by #${run.coveredBy}` : SUMMARY[run.status];
  const target = run.coveredBy ?? run.number;
  const on = refName.length === 40 ? refName.slice(0, 7) : refName;
  return (
    <PrefetchLink
      to={repoPath(repo.owner.slug, repo.name, "ci", String(target))}
      className="ml-auto flex h-8 items-center gap-2 rounded-plate px-2 text-body-sm text-ink-muted no-underline transition-colors hover:bg-raised hover:text-ink max-sm:h-11"
      title={`CI on ${on}: run #${run.number}, ${summary.toLowerCase()}`}
    >
      <span className="flex" aria-hidden>
        <CiStatusIcon status={run.status} />
      </span>
      <span>CI {summary.toLowerCase()}</span>
      <span className="font-mono text-micro text-ink-faint tabular-nums">#{run.number}</span>
    </PrefetchLink>
  );
}
