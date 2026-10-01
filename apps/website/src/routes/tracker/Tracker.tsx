import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  redirect,
  useLoaderData,
  useNavigate,
  useNavigation,
  useParams,
  useSearchParams,
  type LoaderFunctionArgs,
} from "react-router";
import type { RepoSummary } from "../../../shared/api.ts";
import {
  isIssueReady,
  type Issue,
  type Mutation,
  type MutationRequest,
  type Snapshot,
  type TrackerOwner,
} from "../../../shared/tracker.ts";
import { FormError, SelectField } from "../../components/ui.tsx";
import { api, ApiError, load } from "../../lib/api.ts";
import { requireViewer } from "../../lib/session.ts";
import { TrackerAdmin } from "./Admin.tsx";
import { DependencyGraph } from "./Graph.tsx";
import { IssueDetail, type Mutate, type MutationOutcome } from "./IssueDetail.tsx";
import { IssueState, statuses } from "./ui.tsx";
import "./tracker.css";

interface TrackerData {
  snapshot: Snapshot;
  trackers: TrackerOwner[];
  repos: RepoSummary[];
}
export async function trackerIndexLoader({ request }: LoaderFunctionArgs) {
  await requireViewer(request);
  const { trackers } = await load<{ trackers: TrackerOwner[] }>("/tracker", request);
  if (trackers[0]) throw redirect(`/tracker/${trackers[0].slug}`);
  return { trackers };
}
export function TrackerIndex() {
  return (
    <div className="p-8">
      <h1 className="text-headline">Issue tracker</h1>
      <p className="mk-empty">
        No trackers are available to this account. Ask an organization administrator for membership.
      </p>
    </div>
  );
}
export async function trackerLoader({ request, params }: LoaderFunctionArgs) {
  await requireViewer(request);
  const [snapshot, { trackers }, { repos }] = await Promise.all([
    load<Snapshot>(`/tracker/${encodeURIComponent(params.owner!)}/snapshot`, request),
    load<{ trackers: TrackerOwner[] }>("/tracker", request),
    load<{ repos: RepoSummary[] }>("/repos", request),
  ]);
  return { snapshot, trackers, repos };
}

function Freshness({ receivedAt }: { receivedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - receivedAt) / 1000));
  return (
    <time
      className="tracker-freshness"
      dateTime={new Date(receivedAt).toISOString()}
      title={`Last synced ${new Date(receivedAt).toLocaleString()}`}
    >
      Synced{" "}
      {seconds < 10
        ? "just now"
        : seconds < 60
          ? `${seconds}s ago`
          : `${Math.floor(seconds / 60)}m ago`}
    </time>
  );
}

export function Tracker() {
  const data = useLoaderData<typeof trackerLoader>();
  return <Workbench key={data.snapshot.owner.id} data={data} />;
}
function Workbench({ data }: { data: TrackerData }) {
  const [snapshot, setSnapshot] = useState(data.snapshot);
  const latestSnapshot = useRef(data.snapshot);
  const clock = useRef({ server: Date.parse(data.snapshot.serverTime), received: Date.now() });
  const [time, setTime] = useState(data.snapshot.serverTime);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshSequence = useRef(0);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const pending = useRef<MutationRequest | null>(null);
  const pendingCompletions = useRef<((outcome: MutationOutcome) => void)[]>([]);
  const [shortcuts, setShortcuts] = useState(() => {
    try {
      return localStorage.getItem("gitmatrix:tracker-shortcuts") === "true";
    } catch {
      return false;
    }
  });
  const [params, setParams] = useSearchParams();
  const searchQuery = params.get("q") ?? "";
  const [searchText, setSearchText] = useState(searchQuery);
  useEffect(() => setSearchText(searchQuery), [searchQuery]);
  const route = useParams();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const [title, setTitle] = useState("");
  const defaultTeam = snapshot.teams.find((team) => !team.archived)?.id ?? "";
  const requestedTeam = params.get("captureTeam") ?? params.get("team") ?? defaultTeam;
  const createTeam = snapshot.teams.some((team) => team.id === requestedTeam && !team.archived)
    ? requestedTeam
    : "";
  const [createError, setCreateError] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const inspectorRef = useRef<HTMLDivElement>(null);
  const collectionRef = useRef<HTMLElement>(null);
  const [ownerMenuOpen, setOwnerMenuOpen] = useState(
    () => window.matchMedia("(min-width: 761px)").matches,
  );
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 761px)");
    const update = () => setOwnerMenuOpen(desktop.matches);
    desktop.addEventListener("change", update);
    return () => desktop.removeEventListener("change", update);
  }, []);
  const titleRef = useRef<HTMLInputElement>(null);
  const pendingFocus = useRef<"capture" | "search" | null>(null);
  useEffect(() => {
    if (!pendingFocus.current) return;
    const field = pendingFocus.current === "capture" ? titleRef.current : searchRef.current;
    if (field?.getClientRects().length) {
      field.focus();
      pendingFocus.current = null;
    }
  }, [route.issue, params]);
  const owner = data.snapshot.owner.slug;
  const base = `/tracker/${encodeURIComponent(owner)}`;
  const selected = snapshot.issues.find(
    (issue) => issue.id === route.issue || issue.key === route.issue,
  );
  const view = params.get("view") ?? "list";
  const admin = params.get("manage") === "true";
  const effective = useMemo(() => ({ ...snapshot, serverTime: time }), [snapshot, time]);
  const href = (id?: string) =>
    `${base}${id ? `/issues/${encodeURIComponent(id)}` : ""}${params.size ? `?${params}` : ""}`;
  const filter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key === "team") next.delete("captureTeam");
    setParams(next, { replace: true });
  };
  const accept = useCallback((next: Snapshot) => {
    const previous = latestSnapshot.current;
    if (
      next.cursor < previous.cursor ||
      (next.cursor === previous.cursor &&
        Date.parse(next.serverTime) < Date.parse(previous.serverTime))
    )
      return;
    latestSnapshot.current = next;
    clock.current = { server: Date.parse(next.serverTime), received: Date.now() };
    setTime(next.serverTime);
    setSnapshot(next);
  }, []);
  useEffect(() => accept(data.snapshot), [data.snapshot, accept]);
  useEffect(() => {
    const now = clock.current.server + Date.now() - clock.current.received;
    const expires = snapshot.issues
      .flatMap((issue) => (issue.claim ? [Date.parse(issue.claim.expiresAt)] : []))
      .filter((expiry) => expiry > Date.parse(time));
    if (!expires.length) return;
    const timer = setTimeout(
      () => {
        setTime(new Date(clock.current.server + Date.now() - clock.current.received).toISOString());
      },
      Math.max(0, Math.min(...expires) - now + 1),
    );
    return () => clearTimeout(timer);
  }, [snapshot, time]);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    setRefreshing(true);
    try {
      const next = await api<Snapshot>(`/tracker/${encodeURIComponent(owner)}/snapshot`);
      if (sequence === refreshSequence.current) accept(next);
      return true;
    } catch (cause) {
      if (sequence === refreshSequence.current)
        setError(
          cause instanceof Error ? cause.message : "Could not refresh the tracker. Try again.",
        );
      return false;
    } finally {
      if (sequence === refreshSequence.current) setRefreshing(false);
    }
  }, [owner, accept]);
  useEffect(() => {
    const onFocus = () => {
      if (!busyRef.current) void refresh();
    };
    window.addEventListener("focus", onFocus);
    const interval = setInterval(() => {
      if (!document.hidden && !busyRef.current) void refresh();
    }, 30000);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(interval);
    };
  }, [refresh]);
  const mutate: Mutate = async (mutations: Mutation[]) => {
    if (busyRef.current)
      return { ok: false, error: "Another change is saving. Try again when it finishes." };
    if (
      pending.current &&
      JSON.stringify(pending.current.mutations) !== JSON.stringify(mutations)
    ) {
      setError(
        "The previous request has an unknown outcome. Retry it below before making another change.",
      );
      return { ok: false, error: "Retry the pending change above before making another change." };
    }
    busyRef.current = true;
    setBusy(true);
    setError("");
    pending.current ??= { operationId: crypto.randomUUID(), mutations };
    try {
      await api(`/tracker/${encodeURIComponent(owner)}/mutate`, {
        method: "POST",
        json: pending.current,
      });
      pending.current = null;
      setUncertain(false);
      await refresh();
      for (const complete of pendingCompletions.current) complete({ ok: true });
      pendingCompletions.current.length = 0;
      return { ok: true };
    } catch (cause) {
      if (cause instanceof ApiError) {
        pending.current = null;
        setUncertain(false);
        if (cause.status === 409) await refresh();
      } else {
        setUncertain(true);
        setError("The change could not be confirmed. Retry the pending change below.");
        return new Promise<MutationOutcome>((resolve) => {
          pendingCompletions.current.push(resolve);
        });
      }
      const code = cause instanceof ApiError ? cause.code : undefined;
      const recovery: Record<string, string> = {
        version_conflict:
          "Someone else changed this item. Your draft is kept; review the newer version before saving.",
        graph_cycle: "That dependency would create a loop. Choose an issue outside this chain.",
        parent_cycle: "That parent would create a loop. Choose an issue outside this family.",
        blocked: "Complete or remove the blocking issues before starting or completing this work.",
        claim_busy:
          "An agent is working on this issue. Wait for its claim to end before changing its status.",
        lease_lost: "The agent claim changed or expired. Refresh this issue before trying again.",
        archived:
          "This team or workspace is archived. Choose an active one or ask an administrator to restore it.",
        forbidden:
          "You no longer have permission to make this change. Ask a tracker administrator for access.",
      };
      const message =
        (code && recovery[code]) ||
        (cause instanceof Error ? cause.message : "The request failed. Your draft has been kept.");
      const outcome: MutationOutcome = { ok: false, error: message, ...(code ? { code } : {}) };
      for (const complete of pendingCompletions.current) complete(outcome);
      pendingCompletions.current.length = 0;
      return outcome;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const query = (params.get("q") ?? "").trim().toLowerCase();
  const teamFilter = params.get("team");
  const workspaceFilter = params.get("workspace");
  const statusFilter = params.get("status");
  const readyOnly = params.get("ready") === "true";
  const showClosed = params.get("closed") === "true";
  const scopedIssues = useMemo(
    () =>
      snapshot.issues.filter(
        (issue) =>
          (!teamFilter || issue.teamId === teamFilter) &&
          (!workspaceFilter || issue.workspaceIds.includes(workspaceFilter)) &&
          (!statusFilter || issue.status === statusFilter) &&
          (!query ||
            `${issue.key} ${issue.title} ${issue.description} ${issue.labels.join(" ")}`
              .toLowerCase()
              .includes(query)),
      ),
    [snapshot.issues, teamFilter, workspaceFilter, statusFilter, query],
  );
  const readyIds = useMemo(
    () =>
      new Set(
        snapshot.issues
          .filter((issue) => isIssueReady(issue, snapshot.issues, snapshot.links, time))
          .map((issue) => issue.id),
      ),
    [snapshot.issues, snapshot.links, time],
  );
  const closedCount = scopedIssues.filter(
    (issue) => issue.status === "done" || issue.status === "canceled",
  ).length;
  const readyCount = scopedIssues.filter((issue) => readyIds.has(issue.id)).length;
  const issues = useMemo(() => {
    const rank = (issue: Issue) =>
      issue.status === "done" || issue.status === "canceled"
        ? 4
        : readyIds.has(issue.id)
          ? 0
          : issue.status === "in_progress"
            ? 1
            : issue.status === "backlog"
              ? 3
              : 2;
    return scopedIssues
      .filter(
        (issue) =>
          (!readyOnly || readyIds.has(issue.id)) &&
          (statusFilter || showClosed || (issue.status !== "done" && issue.status !== "canceled")),
      )
      .sort(
        (a, b) =>
          rank(a) - rank(b) || a.priority - b.priority || b.updatedAt.localeCompare(a.updatedAt),
      );
  }, [scopedIssues, readyIds, readyOnly, statusFilter, showClosed]);
  const filterLabels: Record<string, string> = {
    q: `Search: ${params.get("q") ?? ""}`,
    team: `Team: ${snapshot.teams.find((team) => team.id === teamFilter)?.name ?? teamFilter}`,
    workspace: `Workspace: ${snapshot.workspaces.find((workspace) => workspace.id === workspaceFilter)?.name ?? workspaceFilter}`,
    status: `Status: ${statuses.find((status) => status.value === statusFilter)?.label ?? statusFilter}`,
    ready: "Ready work",
    closed: "Including closed",
  };
  const activeFilters = Object.keys(filterLabels).filter((key) => params.has(key));
  const clearFilters = () => {
    const next = new URLSearchParams(params);
    for (const key of Object.keys(filterLabels)) next.delete(key);
    next.delete("captureTeam");
    setParams(next, { replace: true });
  };
  const showClosedWork = () => {
    const next = new URLSearchParams(params);
    next.set("closed", "true");
    next.delete("ready");
    setParams(next, { replace: true });
  };
  const onlyClosed =
    closedCount > 0 && closedCount === scopedIssues.length && !showClosed && !statusFilter;
  const managementParams = new URLSearchParams(params);
  if (admin) managementParams.delete("manage");
  else managementParams.set("manage", "true");
  const managementHref = `${base}${route.issue ? `/issues/${encodeURIComponent(route.issue)}` : ""}?${managementParams}`;
  useEffect(() => {
    inspectorRef.current?.scrollTo({ top: 0 });
    const card = collectionRef.current?.querySelector<HTMLElement>('[aria-current="true"]');
    if (card && window.matchMedia("(min-width: 761px)").matches)
      card.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected?.id, view]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        !shortcuts ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        (event.shiftKey && event.key !== "/") ||
        event.isComposing ||
        admin ||
        !(event.target instanceof HTMLElement) ||
        event.target.closest(
          "input, textarea, select, button, [contenteditable], [role=combobox], [role=dialog], [role=menu]",
        )
      )
        return;
      if (event.key === "c" || event.key === "n") {
        event.preventDefault();
        if (window.matchMedia("(max-width: 760px)").matches && route.issue) {
          pendingFocus.current = "capture";
          void navigate(href());
        } else titleRef.current?.focus();
      } else if (event.key === "/") {
        event.preventDefault();
        const next = new URLSearchParams(params);
        next.set("filters", "true");
        const searchPath = window.matchMedia("(max-width: 760px)").matches
          ? base
          : `${base}${route.issue ? `/issues/${encodeURIComponent(route.issue)}` : ""}`;
        pendingFocus.current = "search";
        if (searchRef.current?.getClientRects().length) {
          searchRef.current.focus();
          pendingFocus.current = null;
        }
        void navigate(`${searchPath}?${next}`);
      } else if ((event.key === "j" || event.key === "k") && issues.length) {
        event.preventDefault();
        const current = issues.findIndex((issue) => issue.id === selected?.id);
        const index =
          current < 0
            ? 0
            : Math.max(0, Math.min(issues.length - 1, current + (event.key === "j" ? 1 : -1)));
        void navigate(href(issues[index]!.id));
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  const row = (issue: Issue) => (
    <Link
      key={issue.id}
      className="tracker-row"
      aria-current={selected?.id === issue.id ? "true" : undefined}
      to={href(issue.id)}
    >
      <div className="tracker-row-meta">
        <span className="mk-mono">{issue.key}</span>
        <span>P{issue.priority}</span>
        <IssueState issue={issue} snapshot={effective} />
      </div>
      <strong>{issue.title}</strong>
      <div className="tracker-row-footer">
        <span>
          {snapshot.members.find((member) => member.id === issue.assigneeId)?.displayName ??
            "Unassigned"}
        </span>
        {issue.type === "prd" && <span>PRD</span>}
        {issue.workspaceIds.map((id) => {
          const workspace = snapshot.workspaces.find((item) => item.id === id);
          return workspace ? <span key={id}>{workspace.name}</span> : null;
        })}
      </div>
    </Link>
  );
  return (
    <div
      className={`tracker-shell${route.issue && !admin ? " tracker-detail-open" : ""}`}
      aria-busy={navigation.state !== "idle"}
      data-shortcuts={shortcuts}
      data-management={admin}
    >
      {navigation.state !== "idle" && (
        <p role="status" className="tracker-loading mk-hint">
          Loading tracker view…
        </p>
      )}
      <header className="tracker-header">
        <div>
          {admin && (
            <Link className="gm-link tracker-breadcrumb" to={managementHref}>
              Issue tracker
            </Link>
          )}
          <h1 className="text-headline m-0">{admin ? "Teams & workspaces" : "Issue tracker"}</h1>
          {!admin && (
            <p className="mt-1 mb-0 text-ink-muted">Plan together. Hand off work with context.</p>
          )}
        </div>
        <div className="tracker-header-actions">
          <SelectField
            ariaLabel="Tracker owner"
            value={owner}
            options={data.trackers.map((tracker) => ({
              value: tracker.slug,
              label: tracker.displayName,
            }))}
            onChange={(value) => navigate(`/tracker/${value}`)}
          />
          <details
            className="tracker-owner-menu"
            open={ownerMenuOpen}
            onToggle={(event) => setOwnerMenuOpen(event.currentTarget.open)}
          >
            <summary className="mk-btn">Actions</summary>
            <div className="tracker-owner-menu-content">
              <button
                className="mk-btn"
                onClick={() => {
                  setError("");
                  void refresh();
                }}
                disabled={busy || refreshing}
              >
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
              <Freshness receivedAt={clock.current.received} />
              <Link className="mk-btn" to={managementHref}>
                {admin ? "Back to work" : "Teams & workspaces"}
              </Link>
              <button
                className="mk-btn"
                aria-pressed={shortcuts}
                aria-describedby="tracker-shortcut-help"
                onClick={() => {
                  setShortcuts(!shortcuts);
                  try {
                    localStorage.setItem("gitmatrix:tracker-shortcuts", String(!shortcuts));
                  } catch {
                    // The preference still applies for this page when storage is unavailable.
                  }
                }}
              >
                Shortcuts {shortcuts ? "on" : "off"}
              </button>
            </div>
          </details>
        </div>
      </header>
      <p id="tracker-shortcut-help" className={shortcuts ? "mk-hint" : "sr-only"}>
        Optional shortcuts: c or n captures an issue; / searches; j and k select issues; e edits.
        They do not run while typing or using form controls. Turn them off in Actions.
      </p>
      <div className="tracker-feedback" aria-live="polite">
        {error && (
          <>
            <FormError message={error} />
            {uncertain && (
              <div className="mt-2">
                <p className="mk-hint">
                  The server may have saved your change. Retry sends the same operation ID, so it
                  cannot apply twice.
                </p>
                <button
                  className="mk-btn"
                  disabled={busy}
                  onClick={() => {
                    if (pending.current)
                      void mutate(pending.current.mutations).then((result) => {
                        if (!result.ok) setError(result.error);
                      });
                  }}
                >
                  Retry pending change
                </button>
              </div>
            )}
          </>
        )}
      </div>
      {admin ? (
        <fieldset className="tracker-action-fields" disabled={busy || uncertain}>
          <TrackerAdmin
            snapshot={effective}
            repos={data.repos}
            mutate={mutate}
            busy={busy || uncertain}
          />
        </fieldset>
      ) : (
        <>
          <fieldset className="tracker-action-fields" disabled={busy || uncertain}>
            <form
              className="tracker-quick-create"
              onSubmit={async (event) => {
                event.preventDefault();
                const id = crypto.randomUUID();
                const workspace = params.get("workspace");
                setCreateError("");
                const result = await mutate([
                  {
                    kind: "issue.create",
                    id,
                    data: {
                      teamId: createTeam,
                      title: title.trim(),
                      ...(workspace ? { workspaceIds: [workspace] } : {}),
                    },
                  },
                ]);
                if (result.ok) {
                  setTitle("");
                  await navigate(href(id));
                } else setCreateError(result.error);
              }}
            >
              <SelectField
                ariaLabel="New issue team"
                value={createTeam}
                options={[
                  { value: "", label: "Choose team" },
                  ...snapshot.teams
                    .filter((team) => !team.archived)
                    .map((team) => ({
                      value: team.id,
                      label: `Team · ${team.name} (${team.key})`,
                    })),
                ]}
                onChange={(value) => filter("captureTeam", value)}
              />
              <input
                ref={titleRef}
                aria-label="New issue title"
                aria-keyshortcuts={shortcuts ? "c n" : undefined}
                className="mk-input"
                placeholder="Capture an issue…"
                required
                maxLength={500}
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setCreateError("");
                }}
              />
              <button
                className="mk-btn mk-btn--primary"
                disabled={busy || !createTeam || !title.trim()}
              >
                Create
              </button>
            </form>
          </fieldset>
          {createError && <FormError message={createError} />}
          {!snapshot.teams.some((team) => !team.archived) && (
            <div className="tracker-onboarding">
              <h2 className="text-title">Start with a team</h2>
              <p>
                A team gives each issue an owner and a readable key. Workspaces can bring several
                teams together later.
              </p>
              {snapshot.canAdmin ? (
                <Link className="mk-btn mk-btn--primary" to={managementHref}>
                  Create your first team
                </Link>
              ) : (
                <p>Ask a tracker administrator to create a team.</p>
              )}
            </div>
          )}
          <button
            className="mk-btn tracker-filter-toggle"
            aria-expanded={params.get("filters") === "true"}
            aria-controls="tracker-filters"
            onClick={() => filter("filters", params.get("filters") === "true" ? "" : "true")}
          >
            Filters{activeFilters.length ? ` (${activeFilters.length})` : ""}
          </button>
          <div
            id="tracker-filters"
            className={`tracker-filters${params.get("filters") === "true" ? " tracker-filters-open" : ""}`}
          >
            <input
              ref={searchRef}
              className="mk-input"
              aria-label="Search issues"
              aria-keyshortcuts={shortcuts ? "/" : undefined}
              placeholder="Search title, key, labels…"
              value={searchText}
              onChange={(event) => {
                setSearchText(event.target.value);
                filter("q", event.target.value);
              }}
            />
            <SelectField
              ariaLabel="Filter by team"
              value={params.get("team") ?? ""}
              options={[
                { value: "", label: "All teams" },
                ...snapshot.teams.map((team) => ({
                  value: team.id,
                  label: `${team.name}${team.archived ? " (archived)" : ""}`,
                })),
              ]}
              onChange={(value) => filter("team", value)}
            />
            <SelectField
              ariaLabel="Filter by workspace"
              value={params.get("workspace") ?? ""}
              options={[
                { value: "", label: "All workspaces" },
                ...snapshot.workspaces.map((workspace) => ({
                  value: workspace.id,
                  label: `${workspace.name}${workspace.archived ? " (archived)" : ""}`,
                })),
              ]}
              onChange={(value) => filter("workspace", value)}
            />
            <SelectField
              ariaLabel="Filter by status"
              value={params.get("status") ?? ""}
              options={[{ value: "", label: "All statuses" }, ...statuses]}
              onChange={(value) => filter("status", value)}
            />
          </div>
          {activeFilters.length > 0 && (
            <div className="tracker-active-filters" aria-label="Active filters">
              {activeFilters.map((key) => (
                <button
                  key={key}
                  className="mk-btn mk-btn--sm"
                  aria-label={`Remove ${filterLabels[key]}`}
                  onClick={() => filter(key, "")}
                >
                  {filterLabels[key]} <span className="text-ink-muted">Remove</span>
                </button>
              ))}
              <button className="mk-btn mk-btn--sm" onClick={clearFilters}>
                Clear all
              </button>
            </div>
          )}
          <div className="tracker-viewbar">
            <div className="flex flex-wrap gap-2">
              <button
                className="mk-btn mk-btn--sm"
                aria-pressed={readyOnly}
                onClick={() => filter("ready", readyOnly ? "" : "true")}
              >
                Ready · {readyCount}
              </button>
              <span className="self-center text-body-sm text-ink-muted">
                Showing {issues.length} of {scopedIssues.length}
              </span>
              {!statusFilter && closedCount > 0 && (
                <button
                  className="mk-btn mk-btn--sm tracker-closed-toggle"
                  aria-pressed={showClosed}
                  onClick={() => (showClosed ? filter("closed", "") : showClosedWork())}
                >
                  {showClosed ? "Hide" : "Show"} closed ({closedCount})
                </button>
              )}
            </div>
            <div className="flex gap-1" role="group" aria-label="Issue view">
              {["list", "board", "graph"].map((item) => (
                <button
                  className="mk-btn mk-btn--sm"
                  key={item}
                  aria-pressed={view === item}
                  onClick={() => filter("view", item)}
                >
                  {item[0]!.toUpperCase() + item.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className={`tracker-workbench${route.issue ? " tracker-has-detail" : ""}`}>
            <section ref={collectionRef} className="tracker-collection" aria-label="Issues">
              {view === "graph" ? (
                <DependencyGraph
                  issues={issues}
                  snapshot={effective}
                  selected={selected?.id}
                  href={href}
                />
              ) : issues.length || (view === "board" && closedCount > 0 && !readyOnly) ? (
                view === "board" ? (
                  <>
                    <p className="tracker-board-cue">Scroll sideways to explore status lanes.</p>
                    <div
                      className="tracker-board"
                      tabIndex={0}
                      role="region"
                      aria-label="Issue board, scroll horizontally for more statuses"
                    >
                      {statuses.map((status) => {
                        const closedLane = status.value === "done" || status.value === "canceled";
                        const lane = (closedLane && !readyOnly ? scopedIssues : issues).filter(
                          (issue) => issue.status === status.value,
                        );
                        const collapsed =
                          !lane.length || status.value === "done" || status.value === "canceled";
                        const expanded =
                          params.get(`lane-${status.value}`) === "true" ||
                          lane.some((issue) => issue.id === selected?.id);
                        return (
                          <section
                            className={`tracker-board-column${collapsed && !expanded ? " tracker-board-column-collapsed" : ""}`}
                            key={status.value}
                          >
                            <h2>
                              {collapsed ? (
                                <button
                                  className="mk-btn mk-btn--sm"
                                  aria-expanded={expanded}
                                  onClick={() =>
                                    filter(`lane-${status.value}`, expanded ? "" : "true")
                                  }
                                >
                                  <span>{status.label}</span>{" "}
                                  <span>
                                    {lane.length}
                                    {closedLane && !showClosed && !expanded ? " hidden" : ""}
                                  </span>
                                </button>
                              ) : (
                                <>
                                  {status.label}{" "}
                                  <span className="text-ink-muted">{lane.length}</span>
                                </>
                              )}
                            </h2>
                            {(!collapsed || expanded) && lane.map(row)}
                            {expanded && !lane.length && (
                              <p className="mk-hint px-3">No issues in this lane.</p>
                            )}
                          </section>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  <div>{issues.map(row)}</div>
                )
              ) : (
                <div className="tracker-empty">
                  <h2 className="text-title">
                    {onlyClosed
                      ? `All ${closedCount} ${closedCount === 1 ? "issue here is" : "issues here are"} closed`
                      : snapshot.issues.length
                        ? "No issues match"
                        : "Your team's work starts here"}
                  </h2>
                  <p className="text-ink-muted">
                    {onlyClosed
                      ? "Show completed and canceled work to review it or reopen an issue."
                      : snapshot.issues.length
                        ? "Try another search or clear the filters to see more work."
                        : "Capture a tiny task above, then open it to add a PRD, acceptance criteria, or blockers."}
                  </p>
                  {onlyClosed ? (
                    <button className="mk-btn" onClick={showClosedWork}>
                      Show closed work
                    </button>
                  ) : snapshot.issues.length ? (
                    <button className="mk-btn" onClick={clearFilters}>
                      Clear filters
                    </button>
                  ) : (
                    <button className="mk-btn" onClick={() => titleRef.current?.focus()}>
                      Write an issue title
                    </button>
                  )}
                </div>
              )}
            </section>
            <div ref={inspectorRef} className="tracker-inspector">
              {selected ? (
                <fieldset className="tracker-action-fields" disabled={busy || uncertain}>
                  <IssueDetail
                    key={selected.id}
                    issue={selected}
                    snapshot={effective}
                    mutate={mutate}
                    busy={busy || uncertain}
                    href={href}
                  />
                </fieldset>
              ) : (
                <div className="tracker-empty">
                  <h2 className="text-title">
                    {route.issue ? "Issue not found" : "Keep the work in view"}
                  </h2>
                  <p className="text-ink-muted">
                    {route.issue
                      ? "This issue is unavailable in this tracker."
                      : "Select an issue to read its context, trace blockers, and leave a durable handoff without losing your place."}
                  </p>
                  {route.issue && (
                    <Link className="gm-link" to={href()}>
                      Back to issues
                    </Link>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
