import { GlobeSimpleIcon, LockSimpleIcon } from "@phosphor-icons/react";
import {
  data,
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
} from "react-router";
import type { CreateRepoRequest, RepoSummary, Visibility } from "../../shared/api.ts";
import type { SpacePage } from "../../shared/spaces.ts";
import { Page } from "../components/AppShell.tsx";
import { RadioCards } from "../components/Choice.tsx";
import { Card, FormError, TextField } from "../components/ui.tsx";
import { api, attempt, field, load } from "../lib/api.ts";
import { requireViewer } from "../lib/session.ts";

export async function newRepoLoader({ request, params }: LoaderFunctionArgs) {
  await requireViewer(request);
  const page = await load<SpacePage>(`/spaces/${encodeURIComponent(params.space!)}`, request);
  if (!page.capabilities.canCreateRepository)
    throw data({ message: "You cannot create repositories in this Space." }, { status: 403 });
  return page;
}

export async function newRepoAction({ request, params }: ActionFunctionArgs) {
  const page = await load<SpacePage>(`/spaces/${encodeURIComponent(params.space!)}`, request);
  if (!page.capabilities.canCreateRepository)
    return {
      error: "Your permission to create repositories in this Space is no longer available.",
    };
  const form = await request.formData();
  const body: CreateRepoRequest = {
    spaceId: page.space.id,
    name: field(form, "name"),
    description: field(form, "description"),
    visibility: (form.get("visibility") as Visibility | null) ?? "private",
    importUrl: field(form, "importUrl"),
  };
  const result = await attempt(() => api<RepoSummary>("/repos", { method: "POST", json: body }));
  if ("error" in result) return result;
  return redirect(`/${result.space.slug}/${result.name}`);
}

export function NewRepo() {
  const { space } = useLoaderData<typeof newRepoLoader>();
  const actionData = useActionData<{ error: string } | undefined>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const importing = busy && Boolean(navigation.formData?.get("importUrl"));

  return (
    <Page key={space.id}>
      <h1 className="m-0 text-headline">New repository</h1>
      <p className="mt-1.5 mb-0 text-ink-muted">
        Start empty and push to it, or import a public repository with its history.
      </p>

      <Form method="post" className="mt-8 flex max-w-3xl flex-col gap-6">
        <Card title="Name and Space">
          <div className="mk-card-body">
            <div className="grid gap-2 sm:grid-cols-[minmax(0,12rem)_auto_minmax(0,1fr)] sm:items-end">
              <div className="mk-field">
                <span className="mk-label">Destination Space</span>
                <span className="min-h-11 break-words py-2">
                  {space.organization.displayName} / {space.displayName}
                </span>
                <span className="text-body-sm text-ink-muted">{space.slug}</span>
              </div>
              <span className="hidden pb-2.5 text-title text-ink-faint sm:block" aria-hidden>
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
                    "Only people with repository access in this Space and people you add can see or clone it.",
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

        <FormError message={actionData?.error} />
        <div className="mk-form-actions px-5">
          <button className="mk-btn mk-btn--primary" disabled={busy}>
            {importing ? "Importing…" : busy ? "Creating…" : "Create repository"}
          </button>
        </div>
      </Form>
    </Page>
  );
}
