import { useId, useState } from "react";
import {
  Link,
  useLoaderData,
  useLocation,
  useNavigate,
  useRevalidator,
  type LoaderFunctionArgs,
} from "react-router";
import type { SessionResponse, Viewer } from "../../shared/api.ts";
import { preferredSpace, type DefaultScope } from "../../shared/spaces.ts";
import type { Snapshot, TrackerList, TrackerView } from "../../shared/tracker.ts";
import { SettingsPage } from "../components/SettingsPage.tsx";
import { Card, FormError, SelectField, useToast } from "../components/ui.tsx";
import { api, ApiError } from "../lib/api.ts";
import { requireViewer, useViewer } from "../lib/session.ts";
import { TrackerDefaultsForm } from "./tracker/Defaults.tsx";
import { trackerLoader } from "./tracker/loaders.ts";
import {
  defaultsFromServer,
  forgetLegacyDefaults,
  readLegacyDefaults,
  readTrackerShortcuts,
  saveTrackerShortcuts,
} from "./tracker/preferences.ts";

export async function preferencesLoader(args: LoaderFunctionArgs) {
  const viewer = await requireViewer(args.request);
  const { trackers, defaultSpaceId } = await api<TrackerList>("/tracker", {
    signal: args.request.signal,
  });
  const preferred = defaultSpaceId ?? readLegacyDefaults(viewer.id)?.spaceId;
  const space =
    new URL(args.request.url).searchParams.get("tracker") ??
    trackers.find((tracker) => tracker.id === preferred)?.slug;
  return {
    view: space ? await trackerLoader({ ...args, params: { ...args.params, space } }) : null,
    trackers,
  };
}

export function Preferences() {
  const { view: data, trackers } = useLoaderData<typeof preferencesLoader>();
  const location = useLocation();
  const navigate = useNavigate();
  const selectTracker = (tracker: string) => {
    const query = new URLSearchParams(location.search);
    query.set("tracker", tracker);
    void navigate(`${location.pathname}?${query}${location.hash}`);
  };
  const [shortcuts, setShortcuts] = useState(readTrackerShortcuts);
  const [shortcutsError, setShortcutsError] = useState("");
  const viewer = useViewer();

  return (
    <SettingsPage space={data?.snapshot.space.slug}>
      <h1 className="m-0 text-headline">Preferences</h1>
      <p className="mt-1.5 mb-0 max-w-[48ch] text-ink-muted">
        Choose where the app opens, how the issue tracker opens and how you move through it.
      </p>
      <div className="mt-8 flex flex-col gap-6">
        {viewer && (
          <DefaultScopeCard
            key={`${viewer.savedDefault.organizationId}/${viewer.savedDefault.spaceId}`}
            viewer={viewer}
          />
        )}
        {data ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex min-w-0 flex-col gap-1 text-field-label">
                Tracker
                <SelectField
                  ariaLabel="Tracker for preferences"
                  value={data.snapshot.space.slug}
                  options={data.trackers.map((tracker) => ({
                    value: tracker.slug,
                    label: `${tracker.organization.displayName} / ${tracker.displayName}`,
                  }))}
                  onChange={selectTracker}
                />
              </div>
              <Link
                to={`/tracker/${encodeURIComponent(data.snapshot.space.slug)}${location.search}${location.hash}`}
                className="mk-btn mk-btn--ghost no-underline"
              >
                Open issues
              </Link>
            </div>
            <TrackerPreferences key={data.snapshot.space.id} data={data} />
            <ApproveWhenGreen key={`green-${data.snapshot.space.id}`} snapshot={data.snapshot} />
          </div>
        ) : (
          <div className="space-y-3">
            <p className="m-0 text-ink-muted">
              {trackers.length
                ? "Choose a Space for tracker preferences. Your default is unavailable."
                : "No trackers are available for this account."}
            </p>
            {trackers.length > 0 && (
              <SelectField
                ariaLabel="Tracker for preferences"
                value=""
                options={[
                  { value: "", label: "Choose Space" },
                  ...trackers.map((tracker) => ({
                    value: tracker.slug,
                    label: `${tracker.organization.displayName} / ${tracker.displayName}`,
                  })),
                ]}
                onChange={selectTracker}
              />
            )}
          </div>
        )}
        <section className="mk-card" aria-labelledby="keyboard-shortcuts-title">
          <h2 id="keyboard-shortcuts-title" className="mk-card-title">
            Keyboard shortcuts
          </h2>
          <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              className="m-0 size-4 cursor-pointer accent-signal"
              checked={shortcuts}
              aria-describedby="keyboard-shortcuts-help"
              onChange={(event) => {
                const enabled = event.target.checked;
                try {
                  saveTrackerShortcuts(enabled);
                  setShortcuts(enabled);
                  setShortcutsError("");
                } catch {
                  setShortcutsError(
                    "Couldn't save this preference. Allow site storage and try again.",
                  );
                }
              }}
            />
            Enable character navigation shortcuts
          </label>
          <p
            id="keyboard-shortcuts-help"
            className="mt-1 mb-0 max-w-[65ch] text-body-sm text-ink-muted"
          >
            In the tracker, c or n captures an issue, / filters, j selects the next issue, k the
            previous issue, and Escape closes it. In Story, j is Next and k is Previous. Across the
            app, g then i opens issues, g then p packages, and g then h home. Character navigation
            is off by default and stays off while typing or using a dialog. Press ? or use the
            rail’s Keyboard shortcuts button for help at any time outside a text field or dialog.
            This preference applies only to this browser.
          </p>
          <FormError message={shortcutsError} />
        </section>
      </div>
    </SettingsPage>
  );
}

/**
 * The person's own default Organization and Space (CORE-413), on the server:
 * Home, settings, the tracker and gm open it when nothing more specific names
 * a Space. Losing access to it falls back to the personal Organization's
 * default Space without forgetting the choice.
 */
function DefaultScopeCard({ viewer }: { viewer: Viewer }) {
  const toast = useToast();
  const revalidator = useRevalidator();
  const saved = viewer.savedDefault;
  const current = viewer.spaces.find((space) => space.id === viewer.defaultSpaceId);
  const [organizationId, setOrganizationId] = useState(
    () =>
      (viewer.organizations.some((item) => item.id === saved.organizationId)
        ? saved.organizationId
        : current?.organizationId) ??
      viewer.personalOrganizationId ??
      viewer.organizations[0]?.id ??
      "",
  );
  const [spaceId, setSpaceId] = useState(saved.spaceId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const agent = !!viewer.agent;
  const id = useId();
  const organization = viewer.organizations.find((item) => item.id === organizationId);
  const spaces = viewer.spaces.filter(
    (space) => space.organizationId === organizationId && !space.archivedAt,
  );
  const organizationDefault = spaces.find((space) => space.id === organization?.defaultSpaceId);
  // "" stands for the Organization's default Space, offered only while it opens.
  const selected = spaces.some((space) => space.id === spaceId)
    ? spaceId
    : organizationDefault
      ? ""
      : (spaces[0]?.id ?? "");
  const lapsed = !!saved.organizationId && !preferredSpace(saved, viewer.spaces);
  const save = async (scope: DefaultScope, title: string) => {
    setBusy(true);
    setError("");
    try {
      await api<SessionResponse>("/account/default-scope", { method: "PUT", json: scope });
      toast.add({ title });
      await revalidator.revalidate();
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : "Couldn't save your default. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title="Default Organization and Space"
      description="Home, settings, the issue tracker and gm open this Space when nothing more specific names one. If you lose access to it, they open what they did before you chose: your personal default Space, and for the tracker the one you last set defaults for."
    >
      <form
        className="mk-card-body"
        onSubmit={(event) => {
          event.preventDefault();
          void save({ organizationId, spaceId: selected || null }, "Default saved");
        }}
      >
        <label className="mk-field">
          <span className="mk-label">Organization</span>
          <SelectField
            ariaLabel="Default Organization"
            value={organizationId}
            options={viewer.organizations.map((item) => ({
              value: item.id,
              label: item.displayName,
            }))}
            onChange={(value) => {
              setOrganizationId(value);
              setSpaceId("");
            }}
          />
        </label>
        <label className="mk-field">
          <span className="mk-label">Space</span>
          <SelectField
            ariaLabel="Default Space"
            ariaDescribedBy={spaces.length ? undefined : `${id}-no-space`}
            value={selected}
            options={[
              ...(organizationDefault
                ? [
                    {
                      value: "",
                      label: `Organization's default (${organizationDefault.displayName})`,
                    },
                  ]
                : []),
              ...spaces.map((space) => ({
                value: space.id,
                label:
                  space.displayName === space.slug
                    ? space.slug
                    : `${space.displayName} (${space.slug})`,
              })),
            ]}
            onChange={setSpaceId}
          />
          {!spaces.length && (
            <span id={`${id}-no-space`} className="text-body-sm text-ink-muted">
              You have no Space grant in this Organization.
            </span>
          )}
        </label>
        <p role="status" className="m-0 text-body-sm text-ink-muted">
          {lapsed
            ? "You can no longer open your saved default, so your earlier defaults apply. "
            : ""}
          {current ? (
            <>
              Opens{" "}
              <bdi>
                {current.organization.displayName} / {current.displayName}
              </bdi>{" "}
              now.
            </>
          ) : (
            "No default Space opens now."
          )}
        </p>
        {agent && (
          <p id={`${id}-agent`} className="m-0 text-body-sm text-ink-muted">
            Agents can&rsquo;t do that; sign in as their person.
          </p>
        )}
        <FormError message={error} />
        <div className="mk-form-actions">
          <button
            className="mk-btn mk-btn--primary"
            disabled={busy || agent || !spaces.length}
            aria-describedby={agent ? `${id}-agent` : spaces.length ? undefined : `${id}-no-space`}
          >
            Save default
          </button>
          {saved.organizationId && (
            <button
              type="button"
              className="mk-btn mk-btn--ghost"
              disabled={busy || agent}
              aria-describedby={agent ? `${id}-agent` : undefined}
              onClick={() => void save({ organizationId: null, spaceId: null }, "Default reset")}
            >
              Use personal default
            </button>
          )}
        </div>
      </form>
    </Card>
  );
}

function TrackerPreferences({ data }: { data: TrackerView }) {
  const viewer = useViewer();
  const toast = useToast();
  const [defaults, setDefaults] = useState(() => {
    const saved = defaultsFromServer(data.preferences, data.snapshot.space.id);
    if (saved) return saved;
    const legacy = viewer ? readLegacyDefaults(viewer.id) : null;
    return legacy?.spaceId === data.snapshot.space.id ? legacy : null;
  });
  return (
    <TrackerDefaultsForm
      snapshot={data.snapshot}
      defaults={defaults}
      onSaved={(next) => {
        setDefaults(next);
        if (viewer) forgetLegacyDefaults(viewer.id);
        toast.add({ title: next ? "Tracker defaults saved" : "Tracker defaults reset" });
      }}
    />
  );
}

/**
 * Approve when green (CORE-378): the viewer's own consent, in this tracker, to
 * approving the checkpoint approvals routed to them once CI is green. Only the
 * person changes it; the tracker refuses agents and anyone else.
 */
function ApproveWhenGreen({ snapshot }: { snapshot: Snapshot }) {
  const viewer = useViewer();
  const toast = useToast();
  const [on, setOn] = useState(() => !!viewer && !!snapshot.approveWhenGreen?.includes(viewer.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const agent = !!viewer?.agent;
  const save = async (enabled: boolean) => {
    if (!viewer || agent) return;
    setBusy(true);
    setError("");
    try {
      await api(`/tracker/${encodeURIComponent(snapshot.space.slug)}/mutate`, {
        method: "POST",
        json: {
          contractVersion: snapshot.contractVersion,
          spaceId: snapshot.spaceId,
          migrationEpoch: snapshot.migrationEpoch,
          operationId: crypto.randomUUID(),
          mutations: [{ kind: "automation.approveWhenGreen", id: viewer.id, data: { enabled } }],
        },
      });
      setOn(enabled);
      toast.add({ title: enabled ? "Approve when green is on" : "Approve when green is off" });
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : "Couldn't save this setting. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mk-card" aria-labelledby="approve-when-green-title">
      <h2 id="approve-when-green-title" className="mk-card-title">
        Approve when green
      </h2>
      <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          className="m-0 size-4 cursor-pointer accent-signal"
          checked={on}
          disabled={busy || agent || !viewer}
          aria-describedby="approve-when-green-help"
          onChange={(event) => void save(event.target.checked)}
        />
        Approve checkpoints routed to me in {snapshot.space.displayName} once their CI is green
      </label>
      <p
        id="approve-when-green-help"
        className="mt-1 mb-0 max-w-[65ch] text-body-sm text-ink-muted"
      >
        When you or one of your agents asks you to approve a checkpoint of an approval timeline in
        this tracker, it is approved in your name once every repository&rsquo;s CI run for that
        checkpoint has succeeded; the timeline then lands after its gates pass. Requests from anyone
        else stay yours to answer. It never approves a checkpoint that changes the pipeline
        definition (.gitmatrix/ci.yml), or one it can&rsquo;t check: those stay with you, saying
        why. It doesn&rsquo;t review the code the pipeline runs (tests, scripts): approving trusts
        that code. Failing or pending CI leaves the request with you, and new commits need a new
        checkpoint and a new approval. Only you can change this, not your agents or the
        Space&rsquo;s admins, and you can turn it off at any time: approvals that haven&rsquo;t
        happened yet then wait for you. It acts with the sign-in or token you turn it on with: if
        that is revoked or expires, or you lose access to this Space, it turns itself off and you
        turn it on again.
      </p>
      {agent && (
        <p className="mt-2 mb-0 text-body-sm text-ink-muted">
          Agents can&rsquo;t do that; sign in as their person.
        </p>
      )}
      <FormError message={error} />
    </section>
  );
}
