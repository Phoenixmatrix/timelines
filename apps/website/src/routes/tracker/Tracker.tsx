/*
 * DIRECTION (impeccable, locked: throughput-console, seed 49700b21)
 *
 * THESIS       Work as a stream. One query over every issue, opened/closed
 *              activity over time, facet counts, and a one-line log that
 *              reads at 30,000 rows like an event log. Board and Graph are
 *              lenses on the same query. Refuses the card-per-issue column
 *              that wasted the screen.
 * OWN-WORLD    MatrixKit Neo: warm charcoal panes, one amber signal for the
 *              selection and the primary action, Geist Mono for keys and
 *              counts, data hues (teal opened, berry closed) only in the strip.
 * STORY        See what can move now (Ready), narrow by clicking counts,
 *              open an issue beside the log to read and hand off, switch to
 *              the graph to trace what blocks what.
 * FIRST VIEW   One header row (owner, capture, sync), the query bar with view
 *              switch, saved views, the activity strip, then the log filling
 *              the height; facets in a 17rem column that becomes the
 *              inspector when an issue opens.
 * FORM         throughput-console, rank 4 of 7, seed key 49700b21. Signature:
 *              brushing the strip scopes the query; the canvas graph lights a
 *              selection's whole blocking chain.
 * FINISH       unreviewed and undocumented is unfinished; this build ends with
 *              the finish review, the verdict, DESIGN.md, and every shipping
 *              raster carrying its provenance
 */

import { Menu } from "@base-ui/react/menu";
import {
  ArrowClockwiseIcon,
  DotsThreeIcon,
  FunnelSimpleIcon,
  MagnifyingGlassIcon,
  XIcon,
} from "@phosphor-icons/react";
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
import type { Mutation, MutationRequest, Snapshot, TrackerOwner } from "../../../shared/tracker.ts";
import { ActivityStrip } from "../../components/ActivityStrip.tsx";
import { FormError, popMotion, SelectField, Tip } from "../../components/ui.tsx";
import { api, ApiError, load } from "../../lib/api.ts";
import { requireViewer, useViewer } from "../../lib/session.ts";
import { TrackerAdmin } from "./Admin.tsx";
import { TrackerDefaultsForm } from "./Defaults.tsx";
import { readTrackerDefaults, VIEW_LABEL, withTrackerDefaults, type View } from "./preferences.ts";
import { RelationLens } from "./Lens.tsx";
import { IssueDetail, type Mutate, type MutationOutcome } from "./IssueDetail.tsx";
import { IssueLog } from "./Log.tsx";
import { FacetColumn, IssueBoard } from "./Panels.tsx";
import {
  activityOf,
  buildIndex,
  compile,
  DEFAULT_QUERY,
  facetsOf,
  filterToken,
  parseWhen,
  sortIssues,
  toggleToken,
  tokenize,
  VIEWS,
  withoutKeys,
  type SortKey,
} from "./query.ts";

interface TrackerData {
  snapshot: Snapshot;
  trackers: TrackerOwner[];
  repos: RepoSummary[];
}
export async function trackerIndexLoader({ request }: LoaderFunctionArgs) {
  const viewer = await requireViewer(request);
  const { trackers } = await load<{ trackers: TrackerOwner[] }>("/tracker", request);
  const defaults = readTrackerDefaults(viewer.id);
  const tracker = trackers.find((entry) => entry.id === defaults?.ownerId) ?? trackers[0];
  if (tracker) throw redirect(`/tracker/${tracker.slug}${new URL(request.url).search}`);
  return { trackers };
}
export function TrackerIndex() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-7 sm:px-8">
      <h1 className="m-0 text-headline">Issue tracker</h1>
      <p className="mk-empty mt-4">
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
      className="text-micro whitespace-nowrap text-ink-faint"
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

/** Filters from older links (?team=…&workspace=…&status=…) become query tokens. */
function legacyQuery(params: URLSearchParams, snapshot: Snapshot): string | null {
  const keys = ["team", "workspace", "status", "ready", "closed"];
  if (!keys.some((k) => params.has(k))) return null;
  const tokens: string[] = tokenize(params.get("q") ?? DEFAULT_QUERY);
  const team = snapshot.teams.find((t) => t.id === params.get("team"));
  if (team) tokens.push(filterToken("team", team.key.toLowerCase()));
  const ws = snapshot.workspaces.find((w) => w.id === params.get("workspace"));
  if (ws) tokens.push(filterToken("ws", ws.slug));
  if (params.get("status")) tokens.push(filterToken("status", params.get("status")!));
  if (params.get("ready") === "true") tokens.push("is:ready");
  if (params.get("closed") === "true") return tokens.filter((t) => t !== "is:open").join(" ");
  return tokens.join(" ");
}

function scopeLabel(query: string, now: number): string | null {
  const tokens = tokenize(query);
  const since = tokens.find((t) => t.toLowerCase().startsWith("since:"))?.slice(6);
  const until = tokens.find((t) => t.toLowerCase().startsWith("until:"))?.slice(6);
  if (!since && !until) return null;
  const fmt = (v: string | undefined) => {
    if (!v) return "now";
    const t = parseWhen(v, now);
    return t === null
      ? v
      : new Date(t).toLocaleDateString("en", { month: "short", day: "numeric" });
  };
  return `${fmt(since)} → ${fmt(until)}`;
}

export function Tracker() {
  const data = useLoaderData<typeof trackerLoader>();
  const viewer = useViewer();
  return <Workbench key={`${data.snapshot.owner.id}:${viewer?.id}`} data={data} />;
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
  const [urlParams, setParams] = useSearchParams();
  const route = useParams();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const viewer = useViewer();
  const [defaults, setDefaults] = useState(() => readTrackerDefaults(viewer?.id ?? ""));
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const params = useMemo(
    () => withTrackerDefaults(urlParams, defaults, snapshot),
    [urlParams, defaults, snapshot],
  );
  const [title, setTitle] = useState("");
  const defaultTeam = snapshot.teams.find((team) => !team.archived)?.id ?? "";
  const requestedTeam = params.get("captureTeam") ?? defaultTeam;
  const createTeam = snapshot.teams.some((team) => team.id === requestedTeam && !team.archived)
    ? requestedTeam
    : "";
  const [createError, setCreateError] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  const queryRef = useRef<HTMLInputElement>(null);
  const owner = data.snapshot.owner.slug;
  const base = `/tracker/${encodeURIComponent(owner)}`;
  const selected =
    snapshot.issues.find((issue) => issue.id === route.issue || issue.key === route.issue) ?? null;
  const view = (
    Object.hasOwn(VIEW_LABEL, params.get("view") ?? "list")
      ? (params.get("view") ?? "list")
      : "list"
  ) as View;
  const admin = params.get("manage") === "true";
  const sort = (params.get("sort") ?? "rank") as SortKey;
  const query = params.has("q") ? (params.get("q") ?? "") : DEFAULT_QUERY;
  const [draft, setDraft] = useState(query);
  const [queryFocused, setQueryFocused] = useState(false);
  useEffect(() => setDraft(query), [query]);
  const effective = useMemo(() => ({ ...snapshot, serverTime: time }), [snapshot, time]);
  const href = (id?: string) =>
    `${base}${id ? `/issues/${encodeURIComponent(id)}` : ""}${params.size ? `?${params}` : ""}`;
  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true, preventScrollReset: true });
  };
  const setQuery = (q: string) => setParam("q", q);

  // Materialize defaults in links; explicit and legacy URL filters always win.
  useEffect(() => {
    const next = new URLSearchParams(params);
    const migrated = legacyQuery(urlParams, data.snapshot);
    if (migrated !== null) {
      for (const k of ["team", "workspace", "status", "ready", "closed", "filters"]) next.delete(k);
      next.set("q", migrated);
    }
    if (next.toString() !== urlParams.toString()) setParams(next, { replace: true });
  }, [urlParams, params, data.snapshot, setParams]);

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

  // The working set: an index per sync, then the query over it.
  const now = Date.parse(time);
  const index = useMemo(() => buildIndex(snapshot, time), [snapshot, time]);
  const compiled = useMemo(
    () => compile(query, index, viewer?.id ?? "", now),
    [query, index, viewer?.id, now],
  );
  const matched = useMemo(
    () => snapshot.issues.filter((issue) => compiled.matches(issue)),
    [snapshot.issues, compiled],
  );
  const issues = useMemo(() => sortIssues(matched, index, sort), [matched, index, sort]);
  const facets = useMemo(
    () => facetsOf(snapshot.issues, compiled, index, snapshot),
    [snapshot, compiled, index],
  );
  const activity = useMemo(() => {
    const inScope = snapshot.issues.filter((issue) =>
      compiled.matches(issue, ["since", "until", "is", "status"]),
    );
    return activityOf(inScope, now);
  }, [snapshot.issues, compiled, now]);
  const scoped = scopeLabel(query, now);
  // The graph view is about relationships: an issue there is the lens's
  // centre, and its details open beside it only when asked for.
  const showInspector = !!(selected || route.issue) && (view !== "graph" || params.has("details"));
  const closeHref = (() => {
    if (view !== "graph" || !selected) return href();
    const next = new URLSearchParams(params);
    next.delete("details");
    return `${base}/issues/${encodeURIComponent(selected.id)}?${next}`;
  })();
  // A query that already names one state makes the state column repeat itself.
  const pinsState =
    compiled.parsed.filters.filter(
      (f) =>
        !f.negated &&
        (f.key === "status" || (f.key === "is" && f.value !== "open" && f.value !== "closed")),
    ).length === 1;
  const count = (
    <>
      {issues.length.toLocaleString()}
      <span className="text-ink-faint"> of {snapshot.issues.length.toLocaleString()}</span>
      {compiled.parsed.unknown.length > 0 && (
        <span className="text-danger-text"> · ignoring {compiled.parsed.unknown.join(" ")}</span>
      )}
    </>
  );

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
        titleRef.current?.focus();
      } else if (event.key === "/") {
        event.preventDefault();
        queryRef.current?.focus();
      } else if ((event.key === "j" || event.key === "k") && issues.length) {
        event.preventDefault();
        const current = issues.findIndex((issue) => issue.id === selected?.id);
        const at =
          current < 0
            ? 0
            : Math.max(0, Math.min(issues.length - 1, current + (event.key === "j" ? 1 : -1)));
        void navigate(href(issues[at]!.id), { preventScrollReset: true });
      } else if (event.key === "Escape" && selected) {
        void navigate(showInspector ? closeHref : href(), { preventScrollReset: true });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const managementParams = new URLSearchParams(params);
  if (admin) managementParams.delete("manage");
  else managementParams.set("manage", "true");
  const managementHref = `${base}?${managementParams}`;
  const hasTeam = snapshot.teams.some((team) => !team.archived);
  const parsedUnknown = compiled.parsed.unknown;

  const capture = (
    <fieldset disabled={busy || uncertain} className="m-0 flex min-w-0 flex-1 border-0 p-0">
      <form
        className="flex min-w-0 flex-1 gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          const id = crypto.randomUUID();
          const ws = tokenize(query)
            .find((t) => t.toLowerCase().startsWith("ws:"))
            ?.slice(3);
          const workspace = snapshot.workspaces.find(
            (w) => w.slug.toLowerCase() === ws?.toLowerCase(),
          );
          setCreateError("");
          const result = await mutate([
            {
              kind: "issue.create",
              id,
              data: {
                teamId: createTeam,
                title: title.trim(),
                ...(workspace ? { workspaceIds: [workspace.id] } : {}),
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
          ariaLabel="Team for the new issue"
          value={createTeam}
          className="w-28 shrink-0"
          options={[
            { value: "", label: "Team" },
            ...snapshot.teams
              .filter((team) => !team.archived)
              .map((team) => ({ value: team.id, label: team.key })),
          ]}
          onChange={(value) => setParam("captureTeam", value || null)}
        />
        <input
          ref={titleRef}
          aria-label="New issue title"
          aria-keyshortcuts={shortcuts ? "c n" : undefined}
          className="mk-input min-w-0 flex-1"
          placeholder="Capture an issue"
          required
          maxLength={500}
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            setCreateError("");
          }}
        />
        <button className="mk-btn mk-btn--primary" disabled={busy || !createTeam || !title.trim()}>
          Create
        </button>
      </form>
    </fieldset>
  );

  const strip = (height: string) => (
    <ActivityStrip
      start={activity.start}
      bucketMs={activity.bucketMs}
      series={[
        { label: "Opened", values: activity.opened, className: "bg-data-teal" },
        { label: "Closed", values: activity.closed, className: "bg-data-berry" },
      ]}
      caption={`${activity.opened.reduce((a, b) => a + b, 0).toLocaleString()} opened, ${activity.closed.reduce((a, b) => a + b, 0).toLocaleString()} closed in this scope · drag across the bars to filter by last activity`}
      scoped={scoped}
      onRange={(from, until) =>
        setQuery(
          `${withoutKeys(query, ["since", "until"])} since:${from.toISOString().slice(0, 16)}Z until:${until.toISOString().slice(0, 16)}Z`.trim(),
        )
      }
      onClear={() => setQuery(withoutKeys(query, ["since", "until"]))}
      height={height}
    />
  );

  const facetColumn = (
    <FacetColumn
      facets={facets}
      query={query}
      onToggle={(v) => setQuery(toggleToken(query, v.token.key, v.token.value))}
    />
  );

  const inspector = selected ? (
    <fieldset className="m-0 min-w-0 border-0 p-0" disabled={busy || uncertain}>
      <IssueDetail
        key={selected.id}
        issue={selected}
        snapshot={effective}
        index={index}
        mutate={mutate}
        busy={busy || uncertain}
        href={href}
      />
    </fieldset>
  ) : route.issue ? (
    <div className="p-4">
      <h2 className="m-0 text-title">Issue not found</h2>
      <p className="mk-card-desc">This issue is unavailable in this tracker.</p>
      <Link className="gm-link" to={href()}>
        Back to issues
      </Link>
    </div>
  ) : null;

  return (
    <div
      className="flex min-h-dvh flex-col gap-3 px-4 py-3 lg:h-dvh lg:min-h-0 lg:overflow-hidden"
      aria-busy={navigation.state !== "idle"}
      data-shortcuts={shortcuts}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="m-0 text-title-lg">{admin ? "Teams and workspaces" : "Issues"}</h1>
        <SelectField
          ariaLabel="Tracker owner"
          value={owner}
          className="w-44"
          options={data.trackers.map((tracker) => ({
            value: tracker.slug,
            label: tracker.displayName,
          }))}
          onChange={(value) => navigate(`/tracker/${value}`)}
        />
        {!admin && hasTeam && (
          <div className="order-last flex min-w-0 basis-full md:order-none md:basis-0 md:flex-1">
            {capture}
          </div>
        )}
        {admin && <span className="flex-1" />}
        <div className="ml-auto flex items-center gap-1">
          <span className="max-sm:hidden">
            <Freshness receivedAt={clock.current.received} />
          </span>
          <Tip label={refreshing ? "Refreshing" : "Refresh now"}>
            <button
              type="button"
              className="mk-btn mk-btn--ghost mk-btn--icon mk-btn--sm"
              aria-label="Refresh now"
              disabled={busy || refreshing}
              onClick={() => {
                setError("");
                void refresh();
              }}
            >
              <ArrowClockwiseIcon weight="bold" className={refreshing ? "animate-spin" : ""} />
            </button>
          </Tip>
          <Menu.Root>
            <Tip label="Tracker settings">
              <Menu.Trigger
                className="mk-btn mk-btn--ghost mk-btn--icon mk-btn--sm"
                aria-label="Tracker settings"
              >
                <DotsThreeIcon weight="bold" />
              </Menu.Trigger>
            </Tip>
            <Menu.Portal>
              <Menu.Positioner align="end" sideOffset={6} className="z-50">
                <Menu.Popup className={`mk-popup ${popMotion}`}>
                  <Menu.LinkItem className="mk-menu-item" render={<Link to={managementHref} />}>
                    {admin ? "Back to issues" : "Teams and workspaces"}
                  </Menu.LinkItem>
                  <Menu.Item className="mk-menu-item" onClick={() => setDefaultsOpen(true)}>
                    Default view and team
                  </Menu.Item>
                  <Menu.CheckboxItem
                    className="mk-menu-item"
                    checked={shortcuts}
                    onCheckedChange={(on) => {
                      setShortcuts(on);
                      try {
                        localStorage.setItem("gitmatrix:tracker-shortcuts", String(on));
                      } catch {
                        // Still applies for this page when storage is unavailable.
                      }
                    }}
                  >
                    <span className="flex-1">Keyboard shortcuts</span>
                    <span className="text-micro text-ink-faint">{shortcuts ? "On" : "Off"}</span>
                  </Menu.CheckboxItem>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </div>
      </header>
      {defaultsOpen && viewer && (
        <TrackerDefaultsForm
          viewerId={viewer.id}
          snapshot={snapshot}
          defaults={defaults}
          onCancel={() => setDefaultsOpen(false)}
          onSaved={(next) => {
            setDefaults(next);
            setDefaultsOpen(false);
            void navigate(base, { replace: true });
          }}
        />
      )}
      {shortcuts && (
        <p className="m-0 -mt-1 text-micro text-ink-faint">
          Shortcuts: c captures, / filters, j and k move, Escape closes the issue.
        </p>
      )}
      <div aria-live="polite">
        {(error || createError) && <FormError message={error || createError} />}
        {uncertain && (
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <p className="m-0 text-body-sm text-ink-muted">
              The server may have saved your change. Retry sends the same operation ID, so it can't
              apply twice.
            </p>
            <button
              className="mk-btn mk-btn--sm"
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
      </div>

      {admin ? (
        <fieldset className="m-0 border-0 p-0" disabled={busy || uncertain}>
          <TrackerAdmin
            snapshot={effective}
            repos={data.repos}
            mutate={mutate}
            busy={busy || uncertain}
          />
        </fieldset>
      ) : !hasTeam ? (
        <section className="mk-card max-w-xl">
          <h2 className="mk-card-title">Start with a team</h2>
          <p className="mk-card-desc max-w-[48ch]">
            A team gives each issue an owner and a readable key. Workspaces bring several teams
            together later.
          </p>
          <div className="mt-4">
            {snapshot.canAdmin ? (
              <Link className="mk-btn mk-btn--primary no-underline" to={managementHref}>
                Create your first team
              </Link>
            ) : (
              <p className="m-0 text-body-sm text-ink-muted">
                Ask a tracker administrator to create a team.
              </p>
            )}
          </div>
        </section>
      ) : (
        <div className="flex min-h-0 flex-1 gap-4">
          <div
            className={`flex min-w-0 flex-1 flex-col gap-2 ${showInspector ? "max-lg:hidden" : ""}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <form
                role="search"
                className="relative flex min-w-0 flex-1 basis-72 items-center"
                onSubmit={(event) => {
                  event.preventDefault();
                  setQuery(draft.trim());
                }}
              >
                <MagnifyingGlassIcon
                  className="pointer-events-none absolute left-3 size-4 text-ink-faint"
                  aria-hidden
                />
                <input
                  ref={queryRef}
                  className="mk-input mk-input--code h-10 min-w-0 flex-1 pl-9 sm:text-body-sm"
                  aria-label="Filter issues"
                  aria-keyshortcuts={shortcuts ? "/" : undefined}
                  aria-invalid={parsedUnknown.length ? "true" : undefined}
                  aria-describedby="tracker-query-help"
                  value={draft}
                  placeholder="is:ready team:core assignee:me retention"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoComplete="off"
                  onChange={(event) => setDraft(event.target.value)}
                  onFocus={() => setQueryFocused(true)}
                  onBlur={() => setQueryFocused(false)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setDraft(query);
                  }}
                />
                {draft !== query && (
                  <button
                    type="submit"
                    className="mk-btn mk-btn--sm mk-btn--primary absolute right-1"
                  >
                    Run
                  </button>
                )}
              </form>
              <div className="mk-segmented" role="radiogroup" aria-label="View">
                {(Object.keys(VIEW_LABEL) as View[]).map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={view === v}
                    className="mk-segment"
                    onClick={() => setParam("view", v)}
                  >
                    {VIEW_LABEL[v]}
                  </button>
                ))}
              </div>
            </div>
            <p
              id="tracker-query-help"
              className={`m-0 text-micro ${parsedUnknown.length ? "text-danger-text" : queryFocused ? "text-ink-faint" : "sr-only"}`}
            >
              {parsedUnknown.length
                ? `${parsedUnknown[0]} isn't a filter. Use is:, status:, team:, ws:, assignee:, label:, type:, p:, since:, until:, parent:.`
                : "is:ready is:blocked · status: · team: · ws: · assignee:me · label: · type: · p:1 · since:7d · parent:KEY · words match key and title; - excludes"}
            </p>
            <div className="flex items-center gap-2">
              <div
                className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto [mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)] pr-6 [scrollbar-width:none]"
                role="group"
                aria-label="Saved views"
              >
                {VIEWS.map((v) => (
                  <button
                    key={v.label}
                    type="button"
                    className="mk-chip shrink-0"
                    aria-pressed={query.trim() === v.query}
                    onClick={() => setQuery(v.query)}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
              <span className="shrink-0 text-body-sm text-ink-muted tabular-nums max-lg:hidden">
                {count}
              </span>
            </div>
            <details className="rounded-pane bg-pane px-3 py-1 open:pb-3 lg:hidden">
              <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 font-semibold [&::-webkit-details-marker]:hidden">
                <FunnelSimpleIcon weight="bold" aria-hidden />
                Narrow it down
                <span className="ml-auto text-body-sm font-normal text-ink-muted tabular-nums">
                  {count}
                </span>
              </summary>
              <div className="flex flex-col gap-4 pt-2">
                {view !== "graph" && strip("h-10")}
                {facetColumn}
              </div>
            </details>
            {view !== "graph" && <div className="max-lg:hidden">{strip("h-8")}</div>}
            {issues.length === 0 ? (
              <div className="mk-empty">
                {snapshot.issues.length ? (
                  <>
                    No issues match <code className="mk-mono">{query || "everything"}</code>.{" "}
                    <button
                      type="button"
                      className="mk-btn mk-btn--ghost mk-btn--sm"
                      onClick={() => setQuery("")}
                    >
                      Show everything
                    </button>
                  </>
                ) : (
                  "Capture an issue above. Open it to add a PRD, acceptance criteria or blockers."
                )}
              </div>
            ) : view === "graph" ? (
              <RelationLens
                focus={selected}
                snapshot={snapshot}
                index={index}
                matched={issues}
                href={href}
                listHref={(q) => `${base}?${new URLSearchParams({ q, view: "list" })}`}
                detailsOpen={showInspector}
                onDetails={() => setParam("details", "1")}
              />
            ) : view === "board" ? (
              <IssueBoard
                issues={issues}
                index={index}
                selected={selected?.id ?? null}
                href={href}
                query={query}
                listHref={(q) => `${base}?${new URLSearchParams({ q, view: "list" })}`}
                now={now}
              />
            ) : (
              <IssueLog
                issues={issues}
                index={index}
                selected={selected?.id ?? null}
                href={href}
                sort={sort}
                onSort={(next) => setParam("sort", next === "rank" ? null : next)}
                stateWords={!selected && !pinsState}
              />
            )}
          </div>
          <aside
            aria-label={selected ? `Issue ${selected.key}` : "Narrow it down"}
            className={
              showInspector
                ? "relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-pane bg-pane lg:max-w-[40rem] lg:flex-none lg:basis-[44%]"
                : selected
                  ? "hidden"
                  : "hidden w-64 shrink-0 overflow-y-auto pr-1 lg:block"
            }
          >
            {showInspector ? (
              <>
                <Tip label="Close (Escape)">
                  <Link
                    to={closeHref}
                    className="mk-btn mk-btn--ghost mk-btn--icon mk-btn--sm absolute top-2 right-2 z-[1] no-underline"
                    aria-label="Close the issue"
                  >
                    <XIcon weight="bold" />
                  </Link>
                </Tip>
                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{inspector}</div>
              </>
            ) : (
              facetColumn
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
