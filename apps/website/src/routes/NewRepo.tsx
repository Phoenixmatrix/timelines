import { GlobeSimpleIcon, LockSimpleIcon } from "@phosphor-icons/react";
import { Form, redirect, useActionData, useNavigation, useSearchParams } from "react-router";
import type { CreateRepoRequest, RepoSummary, Visibility } from "../../shared/api.ts";
import { Page } from "../components/AppShell.tsx";
import { RadioCards } from "../components/Choice.tsx";
import { Card, FormError, SelectField, TextField } from "../components/ui.tsx";
import { api, attempt, field } from "../lib/api.ts";
import { requireViewer, useViewer } from "../lib/session.ts";

export async function newRepoLoader({ request }: { request: Request }) {
  await requireViewer(request);
  return null;
}

export async function newRepoAction({ request }: { request: Request }) {
  const form = await request.formData();
  const body: CreateRepoRequest = {
    owner: field(form, "owner"),
    name: field(form, "name"),
    description: field(form, "description"),
    visibility: (form.get("visibility") as Visibility | null) ?? "private",
    importUrl: field(form, "importUrl"),
  };
  const result = await attempt(() => api<RepoSummary>("/repos", { method: "POST", json: body }));
  if ("error" in result) return result;
  return redirect(`/${result.owner.slug}/${result.name}`);
}

export function NewRepo() {
  const viewer = useViewer();
  const actionData = useActionData<{ error: string } | undefined>();
  const navigation = useNavigation();
  const [params] = useSearchParams();
  const busy = navigation.state === "submitting";
  const importing = busy && Boolean(navigation.formData?.get("importUrl"));
  if (!viewer) return null;

  const owners = viewer.canCreateIn.map((owner) => ({ value: owner.slug, label: owner.slug }));

  return (
    <Page>
      <h1 className="m-0 text-headline">New repository</h1>
      <p className="mt-1.5 mb-0 text-ink-muted">
        Start empty and push to it, or import a public repository with its history.
      </p>

      <Form method="post" className="mt-8 flex flex-col gap-6">
        <Card title="Name and owner">
          <div className="mk-card-body">
            <div className="grid grid-cols-[minmax(0,12rem)_auto_minmax(0,1fr)] items-end gap-2">
              <label className="mk-field">
                <span className="mk-label">Owner</span>
                <SelectField
                  name="owner"
                  defaultValue={params.get("owner") ?? viewer.slug}
                  options={owners}
                  ariaLabel="Owner"
                />
              </label>
              <span className="pb-2.5 text-title text-ink-faint" aria-hidden>
                /
              </span>
              <TextField
                label="Repository name"
                name="name"
                required
                maxLength={100}
                pattern="[A-Za-z0-9._\-]+"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={actionData?.error ? true : undefined}
              />
            </div>
            <TextField
              label="Description"
              name="description"
              maxLength={200}
              dir="auto"
              hint="Optional. Shown under the name in lists."
            />
          </div>
        </Card>

        <Card title="Who can see it">
          <div className="mk-card-body">
            <RadioCards
              name="visibility"
              label="Visibility"
              defaultValue="private"
              options={[
                {
                  value: "private",
                  title: "Private",
                  icon: <LockSimpleIcon weight="bold" aria-hidden />,
                  description:
                    "Only you, the owning organization and people you add can see or clone it.",
                },
                {
                  value: "public",
                  title: "Public",
                  icon: <GlobeSimpleIcon weight="bold" aria-hidden />,
                  description: "Anyone can see and clone it. Only people you add can push.",
                },
              ]}
            />
          </div>
        </Card>

        <Card title="Import" description="Copy an existing public repository, history included.">
          <div className="mk-card-body">
            <TextField
              label="Git URL"
              name="importUrl"
              type="url"
              className="[&_input]:font-mono"
              placeholder="https://github.com/owner/repo"
              spellCheck={false}
              hint="Leave empty to start with an empty repository."
            />
          </div>
        </Card>

        <div className="flex items-center justify-end gap-3">
          <FormError message={actionData?.error} />
          <button className="mk-btn mk-btn--primary" disabled={busy}>
            {importing ? "Importing…" : busy ? "Creating…" : "Create repository"}
          </button>
        </div>
      </Form>
    </Page>
  );
}
