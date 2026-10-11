import { useEffect, useState } from "react";
import { CaretRightIcon } from "@phosphor-icons/react";
import { Link } from "react-router";
import type { RepoSummary } from "../../../shared/api.ts";
import {
  DEFAULT_ATTEMPT_LIMIT,
  type Snapshot,
  type Team,
  type Workspace,
} from "../../../shared/tracker.ts";
import { FormError, link, SelectField, TextField } from "../../components/ui.tsx";
import { api } from "../../lib/api.ts";
import type { Mutate } from "./IssueDetail.tsx";
import { Field, MultiCheck } from "./ui.tsx";

const GRID = "grid grid-cols-1 gap-4 sm:grid-cols-2";
const CONFLICT = "rounded-control bg-danger-wash p-3 text-body-sm";
const SECTION = "rounded-pane bg-pane p-4 sm:p-5";
const INTRO = "mt-1 mb-0 max-w-[48ch] text-body-sm text-ink-muted";

const ITEM = "group border-t border-line-soft first-of-type:mt-3";
const SUMMARY =
  "flex min-h-11 cursor-pointer list-none items-center gap-2 font-semibold [&::-webkit-details-marker]:hidden";
const BODY = "pt-1 pb-4 pl-6";

/** The disclosure triangle, turned when the item is open. */
function Caret() {
  return (
    <CaretRightIcon
      weight="bold"
      className="size-3.5 shrink-0 text-ink-faint transition-transform group-open:rotate-90"
      aria-hidden
    />
  );
}

function TeamForm({
  team,
  snapshot,
  mutate,
  busy,
}: {
  team?: Team;
  snapshot: Snapshot;
  mutate: Mutate;
  busy: boolean;
}) {
  const [name, setName] = useState(team?.name ?? "");
  const [key, setKey] = useState(team?.key ?? "");
  const [description, setDescription] = useState(team?.description ?? "");
  const [members, setMembers] = useState(team?.memberIds ?? []);
  const [version, setVersion] = useState(team?.version);
  const [membership, setMembership] = useState(team?.memberIds.length ? "specific" : "everyone");
  const [attemptLimit, setAttemptLimit] = useState(team?.attemptLimit ?? DEFAULT_ATTEMPT_LIMIT);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      className="space-y-4"
      onChangeCapture={() => setSaved("")}
      onSubmit={async (event) => {
        event.preventDefault();
        setSaved("");
        setError("");
        if (membership === "specific" && !members.length) {
          setError(
            "Choose at least one specific member, or explicitly select Everyone in the tracker.",
          );
          return;
        }
        const memberIds = membership === "everyone" ? [] : members;
        const result = await mutate([
          team
            ? {
                kind: "team.update",
                id: team.id,
                expectedVersion: version!,
                data: { name, description, memberIds, attemptLimit },
              }
            : {
                kind: "team.create",
                id: crypto.randomUUID(),
                data: { key, name, description, memberIds },
              },
        ]);
        if (result.ok) {
          setSaved(`${team ? "Saved" : "Created"} team ${name} (${key}).`);
          if (team) setVersion(version! + 1);
          else {
            setName("");
            setKey("");
            setDescription("");
            setMembers([]);
            setMembership("everyone");
          }
        } else setError(`Could not ${team ? "save" : "create"} team ${name}: ${result.error}`);
      }}
    >
      <div className={GRID}>
        <TextField
          label="Team name"
          required
          maxLength={200}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        {team ? (
          <Field label="Issue prefix">
            <p className="mk-mono m-0 flex min-h-11 items-center">{team.key}</p>
            <p className="mk-hint m-0">Permanent · cannot be changed.</p>
          </Field>
        ) : (
          <TextField
            label="Issue prefix"
            required
            pattern="[A-Z][A-Z0-9]{1,5}"
            maxLength={6}
            hint="2–6 uppercase letters or digits; starts with a letter."
            value={key}
            onChange={(event) => setKey(event.target.value.toUpperCase())}
          />
        )}
      </div>
      <TextField
        label="Team description"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />
      {team && (
        <TextField
          label="Ask a person after"
          type="number"
          min={0}
          max={20}
          value={attemptLimit}
          onChange={(event) => setAttemptLimit(Number(event.target.value))}
          hint="Failed attempts (agents releasing work unfinished) before the issue asks its accountable person what to do differently. 0 never asks."
        />
      )}
      <Field label="Team membership">
        <SelectField
          ariaLabel="Team membership"
          value={membership}
          onChange={(value) => {
            setMembership(value);
            setSaved("");
            setError("");
          }}
          options={[
            { value: "everyone", label: "Everyone in the tracker" },
            { value: "specific", label: "Specific members" },
          ]}
        />
      </Field>
      {membership === "specific" && (
        <div className="space-y-2">
          <MultiCheck
            label="Specific team members"
            options={snapshot.members.map((member) => ({
              id: member.id,
              name: member.displayName,
            }))}
            values={members}
            onChange={(values) => {
              setMembers(values);
              setSaved("");
              setError("");
            }}
          />
          <p className="mk-hint m-0 max-w-[48ch]">
            Select at least one member. Clearing this list never selects everyone.
          </p>
        </div>
      )}
      {team && version !== team.version && (
        <div className={CONFLICT} role="alert">
          This team changed. Your fields are preserved. Current: {team.name}; members:{" "}
          {team.memberIds
            .map((id) => snapshot.members.find((member) => member.id === id)?.displayName ?? id)
            .join(", ") || "All"}
          ; description: {team.description}.
          <button
            className="mk-btn mk-btn--sm mt-2 flex"
            type="button"
            onClick={() => {
              setVersion(team.version);
              setSaved("");
              setError("");
            }}
          >
            Use current version, keep my edits
          </button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          className="mk-btn mk-btn--primary"
          disabled={busy || (!!team && version !== team.version)}
        >
          {team ? "Save team" : "Create team"}
        </button>
        {team && (
          <button
            type="button"
            className="mk-btn"
            disabled={busy}
            onClick={async () => {
              setSaved("");
              setError("");
              const result = await mutate([
                {
                  kind: "team.update",
                  id: team.id,
                  expectedVersion: team.version,
                  data: { archived: !team.archived },
                },
              ]);
              if (result.ok) {
                if (version === team.version) setVersion(team.version + 1);
                setSaved(
                  `${team.archived ? "Restored" : "Archived"} team ${team.name} (${team.key}).`,
                );
              } else
                setError(
                  `Could not ${team.archived ? "restore" : "archive"} team ${team.name}: ${result.error}`,
                );
            }}
          >
            {team.archived ? "Restore team" : "Archive team"}
          </button>
        )}
      </div>
      <FormError message={error} />
      {saved && (
        <p role="status" className="mk-hint m-0">
          {saved}
        </p>
      )}
    </form>
  );
}
function WorkspaceForm({
  workspace,
  mutate,
  busy,
}: {
  workspace?: Workspace;
  mutate: Mutate;
  busy: boolean;
}) {
  const [name, setName] = useState(workspace?.name ?? "");
  const [slug, setSlug] = useState(workspace?.slug ?? "");
  const [description, setDescription] = useState(workspace?.description ?? "");
  const [version, setVersion] = useState(workspace?.version);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      className="space-y-4"
      onChangeCapture={() => setSaved("")}
      onSubmit={async (event) => {
        event.preventDefault();
        setSaved("");
        setError("");
        const result = await mutate([
          workspace
            ? {
                kind: "workspace.update",
                id: workspace.id,
                expectedVersion: version!,
                data: { name, description },
              }
            : {
                kind: "workspace.create",
                id: crypto.randomUUID(),
                data: { slug, name, description },
              },
        ]);
        if (result.ok) {
          setSaved(`${workspace ? "Saved" : "Created"} workspace ${name}.`);
          if (workspace) setVersion(version! + 1);
          else {
            setName("");
            setSlug("");
            setDescription("");
          }
        } else
          setError(`Could not ${workspace ? "save" : "create"} workspace ${name}: ${result.error}`);
      }}
    >
      <div className={GRID}>
        <TextField
          label="Workspace name"
          required
          maxLength={200}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        {workspace ? (
          <Field label="Workspace slug">
            <p className="mk-mono m-0 flex min-h-11 items-center">{workspace.slug}</p>
            <p className="mk-hint m-0">Permanent · cannot be changed.</p>
          </Field>
        ) : (
          <TextField
            label="Workspace slug"
            required
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            maxLength={80}
            value={slug}
            hint="Lowercase letters, digits and hyphens."
            onChange={(event) => setSlug(event.target.value)}
          />
        )}
      </div>
      <TextField
        label="Workspace description"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />
      {workspace && version !== workspace.version && (
        <div className={CONFLICT} role="alert">
          This workspace changed. Your fields are preserved. Current: {workspace.name}; description:{" "}
          {workspace.description}.
          <button
            type="button"
            className="mk-btn mk-btn--sm mt-2 flex"
            onClick={() => {
              setVersion(workspace.version);
              setSaved("");
              setError("");
            }}
          >
            Use current version, keep my edits
          </button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          className="mk-btn mk-btn--primary"
          disabled={busy || (!!workspace && version !== workspace.version)}
        >
          {workspace ? "Save workspace" : "Create workspace"}
        </button>
        {workspace && (
          <button
            type="button"
            className="mk-btn"
            disabled={busy}
            onClick={async () => {
              setSaved("");
              setError("");
              const result = await mutate([
                {
                  kind: "workspace.update",
                  id: workspace.id,
                  expectedVersion: workspace.version,
                  data: { archived: !workspace.archived },
                },
              ]);
              if (result.ok) {
                if (version === workspace.version) setVersion(workspace.version + 1);
                setSaved(
                  `${workspace.archived ? "Restored" : "Archived"} workspace ${workspace.name}.`,
                );
              } else
                setError(
                  `Could not ${workspace.archived ? "restore" : "archive"} workspace ${workspace.name}: ${result.error}`,
                );
            }}
          >
            {workspace.archived ? "Restore workspace" : "Archive workspace"}
          </button>
        )}
      </div>
      <FormError message={error} />
      {saved && (
        <p role="status" className="mk-hint m-0">
          {saved}
        </p>
      )}
    </form>
  );
}
export function TrackerAdmin({
  snapshot,
  mutate,
  busy,
}: {
  snapshot: Snapshot;
  mutate: Mutate;
  busy: boolean;
}) {
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [reposError, setReposError] = useState("");
  const [reposAttempt, setReposAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setReposError("");
    api<{ repos: RepoSummary[] }>("/repos", { signal: controller.signal }).then(
      ({ repos }) => {
        if (!controller.signal.aborted) setRepos(repos);
      },
      () => {
        if (!controller.signal.aborted) setReposError("Could not load repository choices.");
      },
    );
    return () => controller.abort();
  }, [snapshot.owner.id, reposAttempt]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [repoId, setRepoId] = useState("");
  const [createTeamOpen, setCreateTeamOpen] = useState(!snapshot.teams.length);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(!snapshot.workspaces.length);
  const [subscriptionError, setSubscriptionError] = useState("");
  const [subscriptionSaved, setSubscriptionSaved] = useState("");
  const [removalErrors, setRemovalErrors] = useState<Record<string, string>>({});
  const [removalSaved, setRemovalSaved] = useState("");
  const administeredRepos = (repos ?? []).filter((repo) => repo.viewerRole === "admin");
  const repositoriesById = new Map((repos ?? []).map((repo) => [repo.id, repo]));
  const subscriptionGroups = new Map<string, Snapshot["subscriptions"]>();
  for (const subscription of snapshot.subscriptions) {
    const group = subscriptionGroups.get(subscription.repoId);
    if (group) group.push(subscription);
    else subscriptionGroups.set(subscription.repoId, [subscription]);
  }
  return (
    <div className="w-full max-w-4xl space-y-4">
      <section className={SECTION}>
        <h2 className="m-0 text-title">Teams</h2>
        <p className={INTRO}>
          Each issue belongs to one team. Team prefixes are permanent; archive a team to stop new
          capture without losing its issues.
        </p>
        {snapshot.canAdmin && (
          <details
            className={ITEM}
            open={createTeamOpen}
            onToggle={(event) => setCreateTeamOpen(event.currentTarget.open)}
          >
            <summary className={SUMMARY}>
              <Caret />
              Create a team
            </summary>
            <div className={BODY}>
              <TeamForm snapshot={snapshot} mutate={mutate} busy={busy} />
            </div>
          </details>
        )}
        {snapshot.teams.map((team) => (
          <details className={ITEM} key={team.id}>
            <summary className={SUMMARY}>
              <Caret />
              <span className="min-w-0 break-words">{team.name}</span>{" "}
              <span className="mk-mono text-body-sm font-normal text-ink-muted">
                {team.key}
                {team.archived ? " · Archived" : ""}
              </span>
            </summary>
            <div className={BODY}>
              {snapshot.canAdmin ? (
                <TeamForm team={team} snapshot={snapshot} mutate={mutate} busy={busy} />
              ) : (
                <p className="m-0 text-body-sm">{team.description || "No description."}</p>
              )}
            </div>
          </details>
        ))}
      </section>
      <section className={SECTION}>
        <h2 className="m-0 text-title">Workspaces</h2>
        <p className={INTRO}>Group work across teams. An issue can belong to several workspaces.</p>
        {snapshot.canAdmin && (
          <details
            className={ITEM}
            open={createWorkspaceOpen}
            onToggle={(event) => setCreateWorkspaceOpen(event.currentTarget.open)}
          >
            <summary className={SUMMARY}>
              <Caret />
              Create a workspace
            </summary>
            <div className={BODY}>
              <WorkspaceForm mutate={mutate} busy={busy} />
            </div>
          </details>
        )}
        {snapshot.workspaces.map((workspace) => (
          <details className={ITEM} key={workspace.id}>
            <summary className={SUMMARY}>
              <Caret />
              <span className="min-w-0 break-words">
                {workspace.name}
                {workspace.archived ? " · Archived" : ""}
              </span>
            </summary>
            <div className={BODY}>
              <Link
                className={`${link} mb-4 inline-block text-body-sm`}
                to={`/tracker/${snapshot.owner.slug}?workspace=${workspace.id}`}
              >
                View workspace issues
              </Link>
              {snapshot.canAdmin ? (
                <WorkspaceForm workspace={workspace} mutate={mutate} busy={busy} />
              ) : (
                <p className="m-0 text-body-sm">{workspace.description || "No description."}</p>
              )}
            </div>
          </details>
        ))}
      </section>
      <section className={SECTION}>
        <h2 className="m-0 text-title">Repository subscriptions</h2>
        <p className={INTRO}>
          Repositories subscribe to workspaces for navigation only. Subscriptions never grant
          tracker access.
        </p>
        {snapshot.subscriptions.length ? (
          <div className="mt-4 space-y-4">
            {[...subscriptionGroups].map(([id, subscriptions]) => {
              const repository = repositoriesById.get(id);
              const historical = subscriptions[0]!;
              const repoName = repository
                ? `${repository.owner.slug}/${repository.name}`
                : `${historical.owner}/${historical.name}`;
              return (
                <section key={id} aria-label={`${repoName} subscriptions`}>
                  <h3 className="m-0 text-body-sm font-semibold break-words">
                    {repository ? (
                      <Link className={link} to={`/${repoName}/tracker`}>
                        {repoName}
                      </Link>
                    ) : (
                      repoName
                    )}
                  </h3>
                  <ul className="m-0 mt-1 list-none p-0">
                    {subscriptions.map((subscription) => {
                      const workspaceName =
                        snapshot.workspaces.find(
                          (workspace) => workspace.id === subscription.workspaceId,
                        )?.name ?? "Unavailable workspace";
                      return (
                        <li
                          key={subscription.id}
                          className="flex items-center justify-between gap-2 border-b border-line-soft py-1.5 text-body-sm [overflow-wrap:anywhere] last:border-b-0"
                        >
                          <div className="min-w-0">
                            <span>{workspaceName}</span>
                            <FormError message={removalErrors[subscription.id]} />
                          </div>
                          {snapshot.canAdmin && (
                            <button
                              className="mk-btn mk-btn--ghost mk-btn--sm"
                              aria-label={`Unsubscribe ${repoName} from ${workspaceName}`}
                              disabled={busy}
                              onClick={async () => {
                                setRemovalSaved("");
                                setSubscriptionSaved("");
                                setRemovalErrors((errors) => ({
                                  ...errors,
                                  [subscription.id]: "",
                                }));
                                const result = await mutate([
                                  { kind: "subscription.remove", id: subscription.id },
                                ]);
                                if (result.ok)
                                  setRemovalSaved(
                                    `Unsubscribed ${repoName} from ${workspaceName}.`,
                                  );
                                else
                                  setRemovalErrors((errors) => ({
                                    ...errors,
                                    [subscription.id]: `Could not unsubscribe ${repoName} from ${workspaceName}: ${result.error}`,
                                  }));
                              }}
                            >
                              Unsubscribe
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        ) : (
          <p className="mt-4 mb-0 text-body-sm text-ink-muted">No repository subscriptions yet.</p>
        )}
        {removalSaved && (
          <p role="status" className="mk-hint mt-3 mb-0">
            {removalSaved}
          </p>
        )}
        {reposError && (
          <div className="mt-4">
            <FormError message={reposError} />
            <button
              className="mk-btn mk-btn--sm"
              onClick={() => setReposAttempt((attempt) => attempt + 1)}
            >
              Retry repository choices
            </button>
          </div>
        )}
        {repos === null && !reposError && (
          <p role="status" className="mk-hint mt-4 mb-0">
            Loading repository choices…
          </p>
        )}
        {snapshot.canAdmin && repos !== null && !administeredRepos.length && (
          <p className="mk-hint mt-4 mb-0 max-w-[48ch]">
            You don’t administer any repositories. Ask a repository administrator to grant you admin
            access before subscribing a repository to a workspace.
          </p>
        )}
        {snapshot.canAdmin && administeredRepos.length > 0 && (
          <form
            className="mt-4 space-y-4 border-t border-line-soft pt-4"
            onSubmit={async (event) => {
              event.preventDefault();
              setSubscriptionError("");
              setSubscriptionSaved("");
              setRemovalSaved("");
              const repository = administeredRepos.find((repo) => repo.id === repoId);
              const workspace = snapshot.workspaces.find((item) => item.id === workspaceId);
              if (!repository || !workspace || workspace.archived) {
                setSubscriptionError("Choose an active workspace and a repository you administer.");
                return;
              }
              const repoName = `${repository.owner.slug}/${repository.name}`;
              const result = await mutate([
                {
                  kind: "subscription.add",
                  id: crypto.randomUUID(),
                  data: { workspaceId, repoId },
                },
              ]);
              if (result.ok) {
                setSubscriptionSaved(`Subscribed ${repoName} to ${workspace.name}.`);
                setRepoId("");
              } else
                setSubscriptionError(
                  `Could not subscribe ${repoName} to ${workspace.name}: ${result.error}`,
                );
            }}
          >
            <div className={GRID}>
              <Field label="Workspace">
                <SelectField
                  ariaLabel="Subscription workspace"
                  value={workspaceId}
                  onChange={(value) => {
                    setWorkspaceId(value);
                    setSubscriptionSaved("");
                    setRemovalSaved("");
                    setSubscriptionError("");
                  }}
                  options={[
                    { value: "", label: "Choose workspace" },
                    ...snapshot.workspaces
                      .filter((workspace) => !workspace.archived)
                      .map((workspace) => ({ value: workspace.id, label: workspace.name })),
                  ]}
                />
              </Field>
              <Field label="Repository you administer">
                <SelectField
                  ariaLabel="Subscription repository"
                  value={repoId}
                  onChange={(value) => {
                    setRepoId(value);
                    setSubscriptionSaved("");
                    setRemovalSaved("");
                    setSubscriptionError("");
                  }}
                  options={[
                    { value: "", label: "Choose repository" },
                    ...administeredRepos.map((repo) => ({
                      value: repo.id,
                      label: `${repo.owner.slug}/${repo.name}`,
                    })),
                  ]}
                />
              </Field>
            </div>
            <button className="mk-btn" disabled={busy || !workspaceId || !repoId}>
              Subscribe repository
            </button>
            <FormError message={subscriptionError} />
            {subscriptionSaved && (
              <p role="status" className="mk-hint m-0">
                {subscriptionSaved}
              </p>
            )}
          </form>
        )}
        {!snapshot.canAdmin && (
          <p className="mk-hint mt-4 mb-0 max-w-[48ch]">
            A tracker administrator manages teams, workspaces and subscriptions.
          </p>
        )}
      </section>
    </div>
  );
}
