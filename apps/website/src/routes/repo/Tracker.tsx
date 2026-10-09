import { Suspense } from "react";
import { Await, Link, useLoaderData, useRevalidator, type LoaderFunctionArgs } from "react-router";
import type { Issue, Snapshot } from "../../../shared/tracker.ts";
import { api, ApiError, load } from "../../lib/api.ts";
import { requireViewer } from "../../lib/session.ts";
import { buildIndex, sortIssues } from "../tracker/query.ts";
import { useRepo } from "./RepoLayout.tsx";
import { link } from "../../components/ui.tsx";
import { scopeOf } from "../../lib/timelineScope.ts";

interface RepoWorkspace {
  trackerOwner: string;
  workspaceId: string;
  slug: string;
  name: string;
}
interface WorkspaceWork {
  ready: Issue[];
  counts: Record<"ready" | "in_progress" | "blocked" | "open", number>;
}
type ReadyPreview =
  | { ok: true; workspaces: Record<string, WorkspaceWork> }
  | { ok: false; error: string };

async function readyPreview(
  owner: string,
  request: Request,
  repoOwner: string,
): Promise<ReadyPreview> {
  try {
    // Repository subscriptions never grant access: this endpoint checks tracker membership itself.
    const timeline = owner === repoOwner ? scopeOf(new URL(request.url).search) : null;
    const snapshot = await api<Snapshot>(
      `/tracker/${encodeURIComponent(owner)}/snapshot${timeline ? `?${new URLSearchParams({ timeline })}` : ""}`,
      { signal: request.signal },
    );
    const index = buildIndex(snapshot, snapshot.serverTime);
    const work = new Map<string, WorkspaceWork>(
      snapshot.workspaces.map((w) => [
        w.id,
        { ready: [], counts: { ready: 0, in_progress: 0, blocked: 0, open: 0 } },
      ]),
    );
    for (const issue of snapshot.issues) {
      const state = index.state.get(issue.id);
      if (state === "done" || state === "canceled") continue;
      for (const id of issue.workspaceIds) {
        const w = work.get(id);
        if (!w) continue;
        w.counts.open++;
        if (state === "ready") {
          w.counts.ready++;
          w.ready.push(issue);
        } else if (state === "in_progress" || state === "claimed") w.counts.in_progress++;
        else if (state === "blocked") w.counts.blocked++;
      }
    }
    for (const w of work.values()) w.ready = sortIssues(w.ready, index, "priority").slice(0, 8);
    return { ok: true, workspaces: Object.fromEntries(work) };
  } catch (error) {
    if (request.signal.aborted) throw error;
    return {
      ok: false,
      error:
        error instanceof ApiError && [401, 403, 404].includes(error.status)
          ? "This tracker is no longer available to your account."
          : "Ready issues could not be loaded. Retry to check this workspace.",
    };
  }
}

export async function repoTrackerLoader({ request, params }: LoaderFunctionArgs) {
  await requireViewer(request);
  const { workspaces, canManage } = await load<{ workspaces: RepoWorkspace[]; canManage: boolean }>(
    `/repos/${encodeURIComponent(params.owner!)}/${encodeURIComponent(params.repo!)}/tracker`,
    request,
  );
  const previews = Object.fromEntries(
    [...new Set(workspaces.map((workspace) => workspace.trackerOwner))].map((owner) => [
      owner,
      readyPreview(owner, request, params.owner!),
    ]),
  );
  return { workspaces, previews, canManage };
}
const COUNTS = [
  { key: "ready", label: "ready", query: "is:ready", dot: "bg-online" },
  { key: "in_progress", label: "in progress", query: "status:in_progress", dot: "bg-ink" },
  { key: "blocked", label: "blocked", query: "is:blocked", dot: "bg-danger-text" },
  { key: "open", label: "open", query: "is:open", dot: "" },
] as const;

export function RepoTracker() {
  const { workspaces, previews, canManage } = useLoaderData<typeof repoTrackerLoader>();
  const revalidator = useRevalidator();
  const repo = useRepo();
  return (
    <section className="flex flex-col gap-4">
      <header>
        <h2 className="m-0 text-title">Work for this repository</h2>
        <p className="mt-1 mb-0 max-w-[48ch] text-body-sm text-ink-muted">
          Issues belong to teams; workspaces connect them here. Only trackers you can access appear.
        </p>
      </header>
      {workspaces.length ? (
        workspaces.map((workspace) => {
          const base = `/tracker/${encodeURIComponent(workspace.trackerOwner)}`;
          const scoped = (q: string) =>
            `?${new URLSearchParams({ q: `ws:${workspace.slug} ${q}`.trim(), ...(workspace.trackerOwner !== repo.owner.slug ? { tl: "main" } : {}) })}`;
          return (
            <section
              key={`${workspace.trackerOwner}:${workspace.workspaceId}`}
              aria-label={workspace.name}
              className="rounded-pane bg-pane"
            >
              <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line-soft px-3 py-2.5">
                <h3 className="m-0 text-body font-semibold">
                  <Link className="gm-link" to={`${base}${scoped("is:open")}`}>
                    {workspace.name}
                  </Link>
                </h3>
                <span className="font-mono text-micro text-ink-faint">
                  {workspace.trackerOwner}/{workspace.slug}
                </span>
              </header>
              <Suspense
                fallback={
                  <p role="status" className="m-0 px-3 py-3 text-body-sm text-ink-muted">
                    Loading work…
                  </p>
                }
              >
                <Await resolve={previews[workspace.trackerOwner]!}>
                  {(preview: ReadyPreview) => {
                    if (!preview.ok)
                      return (
                        <div className="flex flex-wrap items-center gap-3 px-3 py-3">
                          <p role="alert" className="m-0 text-body-sm">
                            {preview.error}
                          </p>
                          <button
                            className="mk-btn mk-btn--sm"
                            disabled={revalidator.state !== "idle"}
                            onClick={() => void revalidator.revalidate()}
                            aria-label={`Retry loading issues for ${workspace.name}`}
                          >
                            {revalidator.state === "idle" ? "Retry" : "Loading…"}
                          </button>
                        </div>
                      );
                    const work = preview.workspaces[workspace.workspaceId];
                    if (!work)
                      return (
                        <p className="m-0 px-3 py-3 text-body-sm text-ink-muted">
                          This workspace is no longer available.
                        </p>
                      );
                    return (
                      <>
                        <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-1 px-3 py-2 text-body-sm">
                          {COUNTS.map((c) => (
                            <li key={c.key}>
                              <Link
                                className="inline-flex min-h-8 items-center gap-1.5 text-ink-muted no-underline hover:text-ink"
                                to={`${base}${scoped(c.query)}`}
                              >
                                {c.dot && (
                                  <span className={`size-2 rounded-full ${c.dot}`} aria-hidden />
                                )}
                                <span className="font-mono text-mono text-ink tabular-nums">
                                  {work.counts[c.key].toLocaleString()}
                                </span>
                                {c.label}
                              </Link>
                            </li>
                          ))}
                        </ul>
                        {work.ready.length ? (
                          <ul className="m-0 list-none border-t border-line-soft p-0">
                            {work.ready.map((issue) => (
                              <li key={issue.id}>
                                <Link
                                  className="grid h-8 grid-cols-[0.5rem_5.5rem_minmax(0,1fr)_2rem] items-center gap-x-3 border-b border-line-soft px-3 text-body-sm text-ink no-underline last:border-b-0 hover:bg-surface"
                                  to={`${base}/issues/${encodeURIComponent(issue.id)}${scoped("is:ready")}`}
                                >
                                  <span className="size-2 rounded-full bg-online" aria-hidden />
                                  <span className="truncate font-mono text-mono text-ink-faint">
                                    {issue.key}
                                  </span>
                                  <span className="truncate">{issue.title}</span>
                                  <span className="font-mono text-mono text-ink-faint">
                                    P{issue.priority}
                                  </span>
                                </Link>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="m-0 border-t border-line-soft px-3 py-3 text-body-sm text-ink-muted">
                            Nothing is ready to pick up here.
                          </p>
                        )}
                      </>
                    );
                  }}
                </Await>
              </Suspense>
            </section>
          );
        })
      ) : (
        <div className="mk-empty max-w-[44rem]">
          No subscribed workspaces are visible.
          {canManage && (
            <>
              {" "}
              Connect a workspace from{" "}
              <Link
                className={link}
                to={`/tracker/${encodeURIComponent(repo.owner.slug)}?manage=true`}
              >
                tracker management
              </Link>
              .
            </>
          )}
        </div>
      )}
    </section>
  );
}
