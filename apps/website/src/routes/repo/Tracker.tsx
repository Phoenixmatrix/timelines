import { Suspense } from "react";
import { Await, Link, useLoaderData, useRevalidator, type LoaderFunctionArgs } from "react-router";
import { isIssueReady, type Issue, type Snapshot } from "../../../shared/tracker.ts";
import { api, ApiError, load } from "../../lib/api.ts";
import { requireViewer } from "../../lib/session.ts";

interface RepoWorkspace {
  trackerOwner: string;
  workspaceId: string;
  slug: string;
  name: string;
}
type ReadyPreview =
  | { ok: true; workspaces: Record<string, { issues: Issue[]; total: number }> }
  | { ok: false; error: string };

async function readyPreview(owner: string, request: Request): Promise<ReadyPreview> {
  try {
    // Repository subscriptions never grant access: this endpoint checks tracker membership itself.
    const snapshot = await api<Snapshot>(`/tracker/${encodeURIComponent(owner)}/snapshot`, {
      signal: request.signal,
    });
    const ready = snapshot.issues
      .filter((issue) => isIssueReady(issue, snapshot.issues, snapshot.links, snapshot.serverTime))
      .sort(
        (a, b) =>
          a.priority - b.priority || a.key.localeCompare(b.key, undefined, { numeric: true }),
      );
    return {
      ok: true,
      workspaces: Object.fromEntries(
        snapshot.workspaces.map((workspace) => {
          const issues = ready.filter((issue) => issue.workspaceIds.includes(workspace.id));
          return [workspace.id, { issues: issues.slice(0, 5), total: issues.length }];
        }),
      ),
    };
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
  const { workspaces } = await load<{ workspaces: RepoWorkspace[] }>(
    `/repos/${encodeURIComponent(params.owner!)}/${encodeURIComponent(params.repo!)}/tracker`,
    request,
  );
  const previews = Object.fromEntries(
    [...new Set(workspaces.map((workspace) => workspace.trackerOwner))].map((owner) => [
      owner,
      readyPreview(owner, request),
    ]),
  );
  return { workspaces, previews };
}
export function RepoTracker() {
  const { workspaces, previews } = useLoaderData<typeof repoTrackerLoader>();
  const revalidator = useRevalidator();
  return (
    <section>
      <h2 className="text-title">Ready issues</h2>
      <p className="text-ink-muted max-w-[70ch]">
        This repository is connected to work through these workspaces. Issues belong to teams, not
        repositories. Only trackers you can access appear here.
      </p>
      {workspaces.length ? (
        <ul className="list-none p-0 divide-y divide-line-soft">
          {workspaces.map((workspace) => {
            const base = `/tracker/${encodeURIComponent(workspace.trackerOwner)}`;
            const query = new URLSearchParams({ workspace: workspace.workspaceId });
            return (
              <li className="py-4" key={`${workspace.trackerOwner}:${workspace.workspaceId}`}>
                <h3 className="text-title m-0">
                  <Link className="gm-link" to={`${base}?${query}`}>
                    {workspace.name}
                  </Link>
                </h3>
                <p className="mk-hint mt-1">
                  {workspace.trackerOwner} / {workspace.slug}
                </p>
                <Suspense
                  fallback={
                    <p role="status" className="mk-hint">
                      Loading ready issues…
                    </p>
                  }
                >
                  <Await resolve={previews[workspace.trackerOwner]!}>
                    {(preview: ReadyPreview) => {
                      if (!preview.ok) {
                        return (
                          <div>
                            <p role="alert">{preview.error}</p>
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
                      }
                      const ready = preview.workspaces[workspace.workspaceId];
                      if (!ready)
                        return <p className="mk-hint">This workspace is no longer available.</p>;
                      return (
                        <>
                          {ready.total ? (
                            <>
                              <p className="mk-hint">
                                Showing {ready.issues.length} of {ready.total} ready issues
                              </p>
                              <ul className="list-none p-0 space-y-2">
                                {ready.issues.map((issue) => (
                                  <li key={issue.id}>
                                    <Link
                                      className="gm-link inline-flex min-h-11 items-center gap-2"
                                      to={`${base}/issues/${encodeURIComponent(issue.id)}?${query}`}
                                    >
                                      <span className="mk-mono shrink-0">{issue.key}</span>
                                      <span>{issue.title}</span>
                                    </Link>
                                  </li>
                                ))}
                              </ul>
                            </>
                          ) : (
                            <p className="mk-hint">
                              No ready issues in this workspace. Open it to see planned, blocked, or
                              completed work.
                            </p>
                          )}
                          <Link
                            className="mk-btn mk-btn--sm no-underline mt-3"
                            to={`${base}?${query}`}
                          >
                            Open {workspace.name} issues
                          </Link>
                        </>
                      );
                    }}
                  </Await>
                </Suspense>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="mk-empty my-6">
          No subscribed workspaces are visible. A repository and tracker administrator can connect a
          workspace from tracker management.
        </div>
      )}
    </section>
  );
}
