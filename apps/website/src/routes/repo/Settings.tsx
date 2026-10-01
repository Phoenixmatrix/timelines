import { GlobeSimpleIcon, LockSimpleIcon, XIcon } from "@phosphor-icons/react";
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
import type { AccountSummary, Collaborator, CollaboratorRole } from "../../../shared/api.ts";
import { RadioCards } from "../../components/Choice.tsx";
import { Monogram } from "../../components/Monogram.tsx";
import {
  Card,
  ConfirmDialog,
  FormError,
  SelectField,
  Tip,
  useToast,
} from "../../components/ui.tsx";
import { api, attempt, field, forgetRepo, load } from "../../lib/api.ts";
import { useRepo } from "./RepoLayout.tsx";

export async function settingsLoader({ request, params }: LoaderFunctionArgs) {
  const base = `/repos/${params.owner}/${params.repo}`;
  const [{ collaborators }, { users }] = await Promise.all([
    load<{ collaborators: Collaborator[] }>(`${base}/collaborators`, request),
    load<{ users: AccountSummary[] }>("/users", request),
  ]);
  return { collaborators, users };
}

export async function settingsAction({ request, params }: ActionFunctionArgs) {
  const owner = params.owner ?? "";
  const name = params.repo ?? "";
  const base = `/repos/${owner}/${name}`;
  const form = await request.formData();
  forgetRepo(owner, name);

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
      <Monogram name={collaborator.displayName} size="sm" />
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

export function Settings() {
  const { collaborators, users } = useLoaderData<typeof settingsLoader>();
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
    <div className="flex max-w-3xl flex-col gap-6">
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
            <button className="mk-btn mk-btn--primary" disabled={saving}>
              Save changes
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
