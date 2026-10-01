import { useState } from "react";
import { Link } from "react-router";
import type { RepoSummary } from "../../../shared/api.ts";
import type { Snapshot, Team, Workspace } from "../../../shared/tracker.ts";
import { FormError, SelectField, TextField } from "../../components/ui.tsx";
import type { Mutate } from "./IssueDetail.tsx";
import { Field, MultiCheck } from "./ui.tsx";

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
                data: { name, description, memberIds },
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
      <div className="tracker-form-grid">
        <TextField
          label="Team name"
          required
          maxLength={200}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        {team ? (
          <Field label="Issue prefix">
            <p className="mk-mono m-0">{team.key}</p>
            <p className="mk-hint">Permanent · cannot be changed.</p>
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
        <>
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
          <p className="mk-hint">
            Select at least one member. Clearing this list never selects everyone.
          </p>
        </>
      )}
      {team && version !== team.version && (
        <div className="tracker-conflict" role="alert">
          This team changed. Your fields are preserved. Current: {team.name}; members:{" "}
          {team.memberIds
            .map((id) => snapshot.members.find((member) => member.id === id)?.displayName ?? id)
            .join(", ") || "All"}
          ; description: {team.description}.
          <button
            className="mk-btn mt-2"
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
        <p role="status" className="mk-hint">
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
      <div className="tracker-form-grid">
        <TextField
          label="Workspace name"
          required
          maxLength={200}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        {workspace ? (
          <Field label="Workspace slug">
            <p className="mk-mono m-0">{workspace.slug}</p>
            <p className="mk-hint">Permanent · cannot be changed.</p>
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
        <div className="tracker-conflict" role="alert">
          This workspace changed. Your fields are preserved. Current: {workspace.name}; description:{" "}
          {workspace.description}.
          <button
            type="button"
            className="mk-btn mt-2"
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
        <p role="status" className="mk-hint">
          {saved}
        </p>
      )}
    </form>
  );
}
export function TrackerAdmin({
  snapshot,
  repos,
  mutate,
  busy,
}: {
  snapshot: Snapshot;
  repos: RepoSummary[];
  mutate: Mutate;
  busy: boolean;
}) {
  const [workspaceId, setWorkspaceId] = useState("");
  const [repoId, setRepoId] = useState("");
  const [createTeamOpen, setCreateTeamOpen] = useState(!snapshot.teams.length);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(!snapshot.workspaces.length);
  const [subscriptionError, setSubscriptionError] = useState("");
  const [subscriptionSaved, setSubscriptionSaved] = useState("");
  const [removalErrors, setRemovalErrors] = useState<Record<string, string>>({});
  const [removalSaved, setRemovalSaved] = useState("");
  const administeredRepos = repos.filter((repo) => repo.viewerRole === "admin");
  const subscriptionGroups = new Map<string, Snapshot["subscriptions"]>();
  for (const subscription of snapshot.subscriptions) {
    const group = subscriptionGroups.get(subscription.repoId);
    if (group) group.push(subscription);
    else subscriptionGroups.set(subscription.repoId, [subscription]);
  }
  return (
    <div className="tracker-admin">
      <section className="tracker-section">
        <h2 className="text-title">Teams</h2>
        <p className="text-ink-muted">
          Each issue belongs to one team. Team prefixes are permanent; archive a team to stop new
          capture without losing its issues.
        </p>
        {snapshot.canAdmin && (
          <details
            className="tracker-admin-item"
            open={createTeamOpen}
            onToggle={(event) => setCreateTeamOpen(event.currentTarget.open)}
          >
            <summary>Create a team</summary>
            <TeamForm snapshot={snapshot} mutate={mutate} busy={busy} />
          </details>
        )}
        {snapshot.teams.map((team) => (
          <details className="tracker-admin-item" key={team.id}>
            <summary>
              {team.name}{" "}
              <span className="text-ink-muted">
                {team.key}
                {team.archived ? " · Archived" : ""}
              </span>
            </summary>
            {snapshot.canAdmin ? (
              <TeamForm team={team} snapshot={snapshot} mutate={mutate} busy={busy} />
            ) : (
              <p>{team.description || "No description."}</p>
            )}
          </details>
        ))}
      </section>
      <section className="tracker-section">
        <h2 className="text-title">Workspaces</h2>
        <p className="text-ink-muted">
          Group work across teams. An issue can belong to several workspaces.
        </p>
        {snapshot.canAdmin && (
          <details
            className="tracker-admin-item"
            open={createWorkspaceOpen}
            onToggle={(event) => setCreateWorkspaceOpen(event.currentTarget.open)}
          >
            <summary>Create a workspace</summary>
            <WorkspaceForm mutate={mutate} busy={busy} />
          </details>
        )}
        {snapshot.workspaces.map((workspace) => (
          <details className="tracker-admin-item" key={workspace.id}>
            <summary>
              {workspace.name}
              {workspace.archived ? " · Archived" : ""}
            </summary>
            <Link
              className="gm-link inline-block mb-4"
              to={`/tracker/${snapshot.owner.slug}?workspace=${workspace.id}`}
            >
              View workspace issues
            </Link>
            {snapshot.canAdmin ? (
              <WorkspaceForm workspace={workspace} mutate={mutate} busy={busy} />
            ) : (
              <p>{workspace.description || "No description."}</p>
            )}
          </details>
        ))}
      </section>
      <section className="tracker-section">
        <h2 className="text-title">Repository subscriptions</h2>
        <p className="text-ink-muted">
          Repositories subscribe to workspaces for navigation only. Subscriptions never grant
          tracker access.
        </p>
        {snapshot.subscriptions.length ? (
          <div className="space-y-4">
            {[...subscriptionGroups].map(([id, subscriptions]) => {
              const repository = subscriptions[0]!;
              const repoName = `${repository.owner}/${repository.name}`;
              return (
                <section key={id} aria-label={`${repoName} subscriptions`}>
                  <h3 className="font-semibold break-words">
                    <Link className="gm-link" to={`/${repoName}/tracker`}>
                      {repoName}
                    </Link>
                  </h3>
                  <ul className="tracker-relations">
                    {subscriptions.map((subscription) => {
                      const workspaceName =
                        snapshot.workspaces.find(
                          (workspace) => workspace.id === subscription.workspaceId,
                        )?.name ?? "Unavailable workspace";
                      return (
                        <li key={subscription.id}>
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
          <p className="text-ink-muted">No repository subscriptions yet.</p>
        )}
        {removalSaved && (
          <p role="status" className="mk-hint">
            {removalSaved}
          </p>
        )}
        {snapshot.canAdmin && !administeredRepos.length && (
          <p className="mk-hint">
            You don’t administer any repositories. Ask a repository administrator to grant you admin
            access before subscribing a repository to a workspace.
          </p>
        )}
        {snapshot.canAdmin && administeredRepos.length > 0 && (
          <form
            className="space-y-4"
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
            <div className="tracker-form-grid">
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
              <p role="status" className="mk-hint">
                {subscriptionSaved}
              </p>
            )}
          </form>
        )}
        {!snapshot.canAdmin && (
          <p className="mk-hint">
            A tracker administrator manages teams, workspaces and subscriptions.
          </p>
        )}
      </section>
    </div>
  );
}
