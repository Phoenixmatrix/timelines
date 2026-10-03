import { CircleNotchIcon, GlobeSimpleIcon, LockSimpleIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import {
  Form,
  redirect,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import type {
  AccountSummary,
  Collaborator,
  CollaboratorRole,
  RepoMirror,
} from "../../../shared/api.ts";
import { RadioCards } from "../../components/Choice.tsx";
import { Monogram } from "../../components/Monogram.tsx";
import {
  Card,
  ConfirmDialog,
  FormError,
  SelectField,
  TextField,
  Tip,
  useToast,
} from "../../components/ui.tsx";
import { api, ApiError, attempt, field, load } from "../../lib/api.ts";
import { fullDate, shortOid, timeAgo } from "../../lib/format.ts";
import { forgetRepoData } from "../../lib/repoData.ts";
import { useRepo } from "./RepoLayout.tsx";

export async function settingsLoader({ request, params }: LoaderFunctionArgs) {
  const base = `/repos/${params.owner}/${params.repo}`;
  const [{ collaborators }, { users }, { mirror }] = await Promise.all([
    load<{ collaborators: Collaborator[] }>(`${base}/collaborators`, request),
    load<{ users: AccountSummary[] }>("/users", request),
    load<{ mirror: RepoMirror | null }>(`${base}/mirror`, request),
  ]);
  return { collaborators, users, mirror };
}

export async function settingsAction({ request, params }: ActionFunctionArgs) {
  const owner = params.owner ?? "";
  const name = params.repo ?? "";
  const base = `/repos/${owner}/${name}`;
  const form = await request.formData();
  forgetRepoData(owner, name);

  switch (form.get("intent")) {
    case "update":
      return attempt(async () => {
        await api(base, {
          method: "PATCH",
          json: { description: form.get("description"), visibility: form.get("visibility") },
        });
        return { saved: true };
      });
    case "add-collaborator":
    case "set-role":
      return attempt(() =>
        api(`${base}/collaborators/${field(form, "username")}`, {
          method: "PUT",
          json: { role: form.get("role") },
        }),
      );
    case "remove-collaborator":
      return attempt(() =>
        api(`${base}/collaborators/${field(form, "username")}`, { method: "DELETE" }),
      );
    case "delete": {
      const result = await attempt(() => api(base, { method: "DELETE" }));
      return result && typeof result === "object" && "error" in result ? result : redirect("/");
    }
    default:
      return { error: "Unknown action." };
  }
}

const ROLE_OPTIONS = [
  { value: "read", label: "Read" },
  { value: "write", label: "Write" },
  { value: "admin", label: "Admin" },
];

function CollaboratorRow({ collaborator }: { collaborator: Collaborator }) {
  const fetcher = useFetcher();
  const removing = fetcher.formData?.get("intent") === "remove-collaborator";
  if (removing) return null;
  return (
    <li className="flex items-center gap-3 py-2.5">
      <Monogram name={collaborator.displayName} size="sm" src={collaborator.avatarUrl} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold">
          <bdi>{collaborator.displayName}</bdi>
        </div>
        <div className="text-body-sm text-ink-faint">@{collaborator.slug}</div>
      </div>
      <SelectField
        value={collaborator.role}
        options={ROLE_OPTIONS}
        ariaLabel={`Role for ${collaborator.displayName}`}
        className="h-10 w-28"
        onChange={(role) =>
          fetcher.submit(
            { intent: "set-role", username: collaborator.slug, role },
            { method: "post" },
          )
        }
      />
      <Tip label={`Remove ${collaborator.displayName}`}>
        <button
          type="button"
          className="mk-btn mk-btn--ghost mk-btn--icon mk-btn--sm"
          aria-label={`Remove ${collaborator.displayName}`}
          onClick={() =>
            fetcher.submit(
              { intent: "remove-collaborator", username: collaborator.slug },
              { method: "post" },
            )
          }
        >
          <XIcon weight="bold" />
        </button>
      </Tip>
    </li>
  );
}

function AddCollaborator({ users }: { users: AccountSummary[] }) {
  const fetcher = useFetcher<{ error?: string }>();
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<CollaboratorRole>("write");
  if (users.length === 0) {
    return <p className="m-0 text-body-sm text-ink-faint">Everyone already has access.</p>;
  }
  const selected = username || users[0]?.slug || "";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="mk-field min-w-48 flex-1">
          <span className="mk-label">Person</span>
          <SelectField
            value={selected}
            options={users.map((user) => ({
              value: user.slug,
              label: `${user.displayName} (@${user.slug})`,
            }))}
            onChange={setUsername}
            ariaLabel="Person"
          />
        </label>
        <label className="mk-field w-32">
          <span className="mk-label">Role</span>
          <SelectField
            value={role}
            options={ROLE_OPTIONS}
            onChange={(value) => setRole(value as CollaboratorRole)}
            ariaLabel="Role"
          />
        </label>
        <button
          type="button"
          className="mk-btn h-11"
          disabled={fetcher.state !== "idle"}
          onClick={() => {
            void fetcher.submit(
              { intent: "add-collaborator", username: selected, role },
              { method: "post" },
            );
            setUsername("");
          }}
        >
          Add
        </button>
      </div>
      <FormError message={fetcher.data?.error} />
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="mk-switch"
      onClick={() => onChange(!checked)}
    />
  );
}

/** A button label that shows a spinner and a present-tense label while its request runs. */
function BusyLabel({ busy, idle, working }: { busy: boolean; idle: string; working: string }) {
  return busy ? (
    <>
      <CircleNotchIcon weight="bold" className="size-4 animate-spin" aria-hidden />
      {working}
    </>
  ) : (
    idle
  );
}

/** Every push here is pushed on to another git host: a one-way backup. */
function MirrorCard({ initial, base }: { initial: RepoMirror | null; base: string }) {
  const [mirror, setMirror] = useState(initial);
  const [url, setUrl] = useState(initial?.url ?? "");
  const [username, setUsername] = useState(initial?.username ?? "x-access-token");
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [prune, setPrune] = useState(initial?.prune ?? false);
  const [busy, setBusy] = useState<"save" | "sync" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const run = async (kind: "save" | "sync" | "remove", work: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "That didn't work.");
    } finally {
      setBusy(null);
    }
  };
  const save = () =>
    run("save", async () => {
      const result = await api<{ mirror: RepoMirror }>(`${base}/mirror`, {
        method: "PUT",
        json: { url, username, enabled, prune, ...(token ? { token } : {}) },
      });
      setMirror(result.mirror);
      setUrl(result.mirror.url);
      setToken("");
      toast.add({ title: "Mirror saved", description: "The next push syncs it; or sync now." });
    });
  const sync = () =>
    run("sync", async () => {
      try {
        const result = await api<{ message: string; mirror: RepoMirror }>(`${base}/mirror/sync`, {
          method: "POST",
        });
        setMirror(result.mirror);
        toast.add({ title: result.message });
      } finally {
        const latest = await api<{ mirror: RepoMirror | null }>(`${base}/mirror`).catch(() => null);
        if (latest) setMirror(latest.mirror);
      }
    });
  const remove = () =>
    run("remove", async () => {
      await api(`${base}/mirror`, { method: "DELETE" });
      setMirror(null);
      setUrl("");
      setToken("");
      toast.add({ title: "Mirror removed", description: "The target keeps what it has." });
    });

  const status = !mirror
    ? null
    : mirror.status === "failed"
      ? null
      : mirror.lastSyncedAt
        ? `Synced ${timeAgo(mirror.lastSyncedAt)}${
            mirror.lastSyncedCommit ? ` at ${shortOid(mirror.lastSyncedCommit)}` : ""
          }${mirror.status === "pending" || mirror.status === "syncing" ? "; a newer push is syncing" : ""}.`
        : "Not synced yet. The next push syncs it.";
  // Mirror pushes come from one system identity, whoever set the mirror up.
  const pusher = mirror?.pushedAs ? ` Pushes as ${mirror.pushedAs.displayName}.` : "";

  return (
    <Card
      title="Mirror"
      description="The default branch and tags are pushed on to another git host after every push here, so it always holds a backup. Other branches stay here. One way only: anything pushed to those refs there directly is overwritten."
    >
      <div className="mk-card-body">
        <TextField
          label="Push to"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.currentTarget.value)}
          placeholder="https://github.com/owner/name.git"
          autoComplete="off"
        />
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            label="Username"
            value={username}
            onChange={(e) => setUsername(e.currentTarget.value)}
            hint="GitHub accepts any name with a token."
            autoComplete="off"
          />
          <TextField
            label="Token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.currentTarget.value)}
            placeholder={mirror?.hasToken ? "Stored; leave empty to keep it" : ""}
            hint="Needs push access. Stored sealed, never shown again."
            autoComplete="new-password"
          />
        </div>
        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-3">
            <Switch checked={enabled} onChange={setEnabled} label="Mirror every push" />
            <span>Mirror every push</span>
          </label>
          <label className="flex items-start gap-3">
            <Switch checked={prune} onChange={setPrune} label="Delete what's gone here" />
            <span>
              Delete what's gone here
              <span className="block text-body-sm text-ink-faint">
                Off: the default branch and tags deleted here stay on the target, so a backup never
                loses anything. Other branches on the target are never deleted.
              </span>
            </span>
          </label>
        </div>
        {mirror?.status === "failed" && mirror.lastError ? (
          <p className="mk-error m-0" role="alert">
            Last sync failed{mirror.lastAttemptAt ? ` ${timeAgo(mirror.lastAttemptAt)}` : ""}:{" "}
            {mirror.lastError}
          </p>
        ) : (
          status && (
            <p
              className="m-0 text-body-sm text-ink-muted"
              title={mirror?.lastSyncedAt ? fullDate(mirror.lastSyncedAt) : undefined}
            >
              {status}
              {pusher}
            </p>
          )
        )}
        <FormError message={error} />
        <div className="flex flex-wrap items-center justify-end gap-3">
          {mirror && (
            <ConfirmDialog
              trigger={
                <button type="button" className="mk-btn mk-btn--danger-ghost" disabled={!!busy}>
                  Remove mirror…
                </button>
              }
              title="Remove this mirror?"
              description="Pushes stop going to the target. It keeps everything it already has."
              confirmLabel="Remove mirror"
              busy={busy === "remove"}
              onConfirm={() => void remove()}
            />
          )}
          <span className="flex-1" />
          {mirror && (
            <button
              type="button"
              className="mk-btn"
              disabled={!!busy || !mirror.enabled}
              aria-busy={busy === "sync"}
              onClick={() => void sync()}
            >
              <BusyLabel busy={busy === "sync"} idle="Sync now" working="Syncing…" />
            </button>
          )}
          <button
            type="button"
            className="mk-btn mk-btn--primary"
            disabled={!!busy || !url.trim() || (!token && !mirror?.hasToken)}
            aria-busy={busy === "save"}
            onClick={() => void save()}
          >
            <BusyLabel
              busy={busy === "save"}
              idle={mirror ? "Save mirror" : "Add mirror"}
              working={mirror ? "Saving…" : "Adding…"}
            />
          </button>
        </div>
      </div>
    </Card>
  );
}

export function Settings() {
  const { collaborators, users, mirror } = useLoaderData<typeof settingsLoader>();
  const repo = useRepo();
  const actionData = useActionData<{ error?: string; saved?: boolean } | undefined>();
  const navigation = useNavigation();
  const deleter = useFetcher<{ error?: string }>();
  const toast = useToast();
  const saving = navigation.formData?.get("intent") === "update";

  useEffect(() => {
    if (actionData?.saved) toast.add({ title: "Settings saved" });
  }, [actionData, toast]);

  const taken = new Set([...collaborators.map((c) => c.id), repo.owner.id]);
  const candidates = users.filter((user) => !taken.has(user.id));
  const fullName = `${repo.owner.slug}/${repo.name}`;

  return (
    // Settings read as forms: one readable column, two side by side on wide screens.
    <div className="max-w-3xl gap-6 xl:max-w-none xl:columns-2 [&>*]:mb-6 [&>*]:break-inside-avoid">
      <Card title="General">
        <Form method="post" className="mk-card-body">
          <input type="hidden" name="intent" value="update" />
          <label className="mk-field">
            <span className="mk-label">Description</span>
            <input
              className="mk-input"
              name="description"
              defaultValue={repo.description}
              maxLength={200}
              dir="auto"
            />
          </label>
          <div className="mk-field">
            <span className="mk-label">Visibility</span>
            <RadioCards
              name="visibility"
              label="Visibility"
              defaultValue={repo.visibility}
              options={[
                {
                  value: "private",
                  title: "Private",
                  icon: <LockSimpleIcon weight="bold" aria-hidden />,
                  description:
                    repo.owner.kind === "org"
                      ? `Only ${repo.owner.displayName} members and collaborators can see or clone it.`
                      : "Only you and collaborators can see or clone it.",
                },
                {
                  value: "public",
                  title: "Public",
                  icon: <GlobeSimpleIcon weight="bold" aria-hidden />,
                  description: "Anyone can see and clone it, even signed out.",
                },
              ]}
            />
          </div>
          <div className="flex items-center justify-end gap-3">
            <FormError message={actionData?.error} />
            <button className="mk-btn mk-btn--primary" disabled={saving} aria-busy={saving}>
              <BusyLabel busy={saving} idle="Save changes" working="Saving…" />
            </button>
          </div>
        </Form>
      </Card>

      <Card
        title="Collaborators"
        description={
          repo.owner.kind === "org"
            ? `People added here get this role on top of what ${repo.owner.displayName} membership gives them.`
            : "People you add here can read, push or manage this repository."
        }
      >
        <div className="mk-card-body">
          {collaborators.length > 0 ? (
            <ul className="m-0 list-none divide-y divide-line-soft p-0">
              {collaborators.map((collaborator) => (
                <CollaboratorRow key={collaborator.id} collaborator={collaborator} />
              ))}
            </ul>
          ) : (
            <div className="mk-well text-body-sm text-ink-muted">No collaborators yet.</div>
          )}
          <AddCollaborator users={candidates} />
        </div>
      </Card>

      <MirrorCard initial={mirror} base={`/repos/${repo.owner.slug}/${repo.name}`} />

      <Card
        title="Delete this repository"
        description="Its history, branches and tokens go for good."
      >
        <div className="mt-4 flex items-center justify-between gap-3">
          <FormError message={deleter.data?.error} />
          <span className="flex-1" />
          <ConfirmDialog
            trigger={<button className="mk-btn mk-btn--danger-ghost">Delete repository…</button>}
            title={`Delete ${fullName}?`}
            description="Its commits, branches and tags are deleted for good. Clones people already have keep working."
            confirmLabel="Delete repository"
            busy={deleter.state !== "idle"}
            onConfirm={() => deleter.submit({ intent: "delete" }, { method: "post" })}
          />
        </div>
      </Card>
    </div>
  );
}
