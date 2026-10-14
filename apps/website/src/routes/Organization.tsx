import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { Monogram } from "../components/Monogram.tsx";
import { PictureEditor } from "./AvatarEditor.tsx";
import type { AccountSummary } from "../../shared/api.ts";
import type { OrganizationPage, OrganizationSummary, SpacePage } from "../../shared/spaces.ts";
import { Page } from "../components/AppShell.tsx";
import { Card, FormError, SelectField, TextField, link } from "../components/ui.tsx";
import { api, attempt, field, load } from "../lib/api.ts";
import { requireViewer } from "../lib/session.ts";

type Member = AccountSummary & { role: "owner" | "member" };
export async function organizationsLoader({ request }: LoaderFunctionArgs) {
  await requireViewer(request);
  return load<{ organizations: OrganizationSummary[] }>("/organizations", request);
}
export async function organizationsAction({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const result = await attempt(() =>
    api<OrganizationPage>("/organizations", {
      method: "POST",
      json: {
        slug: field(form, "slug"),
        displayName: field(form, "displayName"),
        spaceSlug: field(form, "spaceSlug"),
        spaceDisplayName: field(form, "spaceDisplayName"),
      },
    }),
  );
  if ("error" in result) return result;
  return redirect(`/organizations/${encodeURIComponent(result.organization.slug)}?enter=1`);
}
export async function organizationLoader({ request, params }: LoaderFunctionArgs) {
  // Read the Organization while the session resolves; signing in still comes first.
  const pending = load<OrganizationPage>(
    `/organizations/${encodeURIComponent(params.organization!)}`,
    request,
  );
  pending.catch(() => undefined);
  await requireViewer(request);
  const page = await pending;
  const url = new URL(request.url);
  const defaultSpace = page.spaces.find(
    (item) => item.space.id === page.organization.defaultSpaceId && !item.space.archivedAt,
  );
  if (
    url.searchParams.get("enter") === "1" &&
    page.activeSpaceCount === 1 &&
    defaultSpace?.capabilities.canReadContent
  ) {
    url.searchParams.delete("enter");
    const query = url.searchParams.toString();
    throw redirect(
      `/${encodeURIComponent(defaultSpace.space.slug)}${query ? `?${query}` : ""}${url.hash}`,
    );
  }
  const members =
    page.viewerRole === "owner"
      ? (
          await load<{ members: Member[] }>(
            `/organizations/${encodeURIComponent(params.organization!)}/members`,
            request,
          )
        ).members
      : [];
  return { ...page, members };
}
export async function organizationAction({ request, params }: ActionFunctionArgs) {
  const base = `/organizations/${encodeURIComponent(params.organization!)}`;
  const form = await request.formData();
  const intent = field(form, "intent");
  const result = await attempt(async () => {
    if (intent === "rename")
      await api(base, { method: "PATCH", json: { displayName: field(form, "displayName") } });
    else if (intent === "default")
      await api(`${base}/default-space`, {
        method: "PUT",
        json: { spaceId: field(form, "spaceId") },
      });
    else if (intent === "space") {
      const organization = await api<OrganizationPage>(base);
      const result = await api<SpacePage>("/spaces", {
        method: "POST",
        json: {
          organizationId: organization.organization.id,
          slug: field(form, "slug"),
          displayName: field(form, "displayName"),
        },
      });
      return redirect(`/${encodeURIComponent(result.space.slug)}`);
    } else if (intent === "member") {
      const person = await api<AccountSummary>(
        `/accounts/${encodeURIComponent(field(form, "person"))}`,
      );
      await api(`${base}/members/${encodeURIComponent(person.id)}`, {
        method: "PUT",
        json: { role: field(form, "role") },
      });
    } else if (intent === "remove-member")
      await api(`${base}/members/${encodeURIComponent(field(form, "accountId"))}`, {
        method: "DELETE",
      });
    else throw data({ message: "Unknown Organization action." }, { status: 400 });
    return { saved: true as const };
  });
  // Each settings card shows its own outcome, next to its own action.
  return result instanceof Response ? result : { intent, ...result };
}
export function Organizations() {
  const { organizations } = useLoaderData<typeof organizationsLoader>();
  const result = useActionData<typeof organizationsAction>();
  const busy = useNavigation().state !== "idle";
  return (
    <Page>
      <h1 className="m-0 text-headline">Organizations</h1>
      <p className="text-ink-muted">
        Choose an Organization, then a Space. Your person account stays the same.
      </p>
      <ul className="m-0 list-none divide-y divide-line p-0">
        {organizations.map((organization) => (
          <li
            key={organization.id}
            className="flex flex-wrap items-center justify-between gap-3 py-4"
          >
            <Link
              className={`${link} min-h-11 content-center font-semibold`}
              to={`/organizations/${encodeURIComponent(organization.slug)}?enter=1`}
            >
              <bdi>{organization.displayName}</bdi>
            </Link>
            <span className="text-body-sm text-ink-muted">
              {organization.kind === "personal"
                ? "Private personal Organization"
                : "Company Organization"}
            </span>
          </li>
        ))}
      </ul>
      {!organizations.length && (
        <p className="text-ink-muted">
          You do not belong to an Organization yet. Ask an Organization owner to add you, or create
          one.
        </p>
      )}
      <details className="mt-8">
        <summary className="min-h-11 cursor-pointer font-semibold">Create an Organization</summary>
        <Form method="post" className="mt-4 flex max-w-xl flex-col gap-4">
          <TextField label="Organization name" name="displayName" required />
          <TextField
            label="Organization handle"
            name="slug"
            required
            hint="Permanent. Used in the Organization directory address."
          />
          <TextField
            label="Default Space name"
            name="spaceDisplayName"
            required
            defaultValue="General"
          />
          <TextField
            label="Default Space handle"
            name="spaceSlug"
            required
            hint="Permanent and unique across this Instance. Used in repository and tracker addresses."
          />
          <p className="m-0 text-body-sm text-ink-muted">
            Creation gives you an explicit administrator grant in the default Space. Organization
            ownership alone does not grant private content access.
          </p>
          <FormError message={result && "error" in result ? result.error : undefined} />
          <button className="mk-btn mk-btn--primary self-start" disabled={busy}>
            {busy ? "Creating…" : "Create Organization"}
          </button>
        </Form>
      </details>
    </Page>
  );
}
export function Organization() {
  const page = useLoaderData<typeof organizationLoader>();
  const result = useActionData<typeof organizationAction>();
  const busy = useNavigation().state !== "idle";
  const owner = page.viewerRole === "owner";
  const outcome = (intent: string) => {
    const own = result?.intent === intent ? result : undefined;
    return (
      <>
        <FormError message={own && "error" in own ? own.error : undefined} />
        {own && "saved" in own && !busy && (
          <p role="status" className="m-0 text-body-sm text-ink-muted">
            Saved.
          </p>
        )}
      </>
    );
  };
  return (
    <Page key={page.organization.id}>
      <header className="flex flex-wrap items-center gap-4">
        <Monogram
          name={page.organization.displayName}
          shape="place"
          size="lg"
          src={page.organization.avatarUrl}
        />
        <div className="min-w-0 flex-1">
          <h1 className="m-0 text-headline">
            <bdi>{page.organization.displayName}</bdi>
          </h1>
          <p className="mb-0 text-ink-muted">
            {page.organization.kind === "personal"
              ? "Private personal Organization"
              : "Organization"}{" "}
            · {page.organization.slug}
          </p>
        </div>
      </header>
      {/* Changing your own role or membership can end ownership, and with it the settings cards. */}
      {!owner && result && <div className="mt-4">{outcome(result.intent)}</div>}
      <section className="mt-8" aria-labelledby="spaces-heading">
        <h2 id="spaces-heading" className="text-title">
          Spaces
        </h2>
        <p className="text-body-sm text-ink-muted">
          Spaces keep work and permissions separate. Organization administration does not reveal
          private work.
        </p>
        <ul className="m-0 list-none divide-y divide-line p-0">
          {page.spaces.map(({ space, capabilities }) => (
            <li key={space.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div>
                <Link
                  className={`${link} inline-flex min-h-11 items-center font-semibold`}
                  to={`/${encodeURIComponent(space.slug)}`}
                >
                  <bdi>{space.displayName}</bdi>
                </Link>
                <p className="m-0 text-body-sm text-ink-muted">
                  {space.slug}
                  {space.id === page.organization.defaultSpaceId ? " · Default Space" : ""}
                  {space.archivedAt ? " · Archived" : ""}
                </p>
              </div>
              <span className="text-body-sm text-ink-muted">
                {capabilities.canReadContent
                  ? "Explicit Space access"
                  : "Directory only · no private content access"}
              </span>
            </li>
          ))}
        </ul>
        {!page.spaces.length && (
          <p className="text-ink-muted">
            No Spaces are available to you. Ask an Organization owner for an explicit Space grant.
          </p>
        )}
      </section>
      {owner && (
        // Settings forms share the settings pages' column, cards and left-aligned actions.
        <section className="mt-10 max-w-3xl" aria-labelledby="organization-settings">
          <h2 id="organization-settings" className="m-0 text-title">
            Organization settings
          </h2>
          <p className="mt-1.5 mb-0 max-w-[48ch] text-ink-muted">
            Directory and grants administration. Owning the Organization does not grant access to
            its Spaces&rsquo; content.
          </p>
          <div className="mt-6 flex flex-col gap-6">
            <Card title="Organization icon">
              <PictureEditor
                target={{
                  endpoint: `/organizations/${encodeURIComponent(page.organization.slug)}/avatar`,
                  name: page.organization.displayName,
                  avatarUrl: page.organization.avatarUrl,
                  shape: "place",
                  noun: "icon",
                  intro:
                    "Shown wherever this Organization appears. Changing its icon does not grant Space content access.",
                }}
              />
            </Card>
            <Card title="Organization name" description="The handle is permanent.">
              <Form method="post" className="mk-card-body">
                <input type="hidden" name="intent" value="rename" />
                <TextField
                  name="displayName"
                  label="Display name"
                  defaultValue={page.organization.displayName}
                  required
                />
                {outcome("rename")}
                <div className="mk-form-actions">
                  <button className="mk-btn mk-btn--primary" disabled={busy}>
                    Save name
                  </button>
                </div>
              </Form>
            </Card>
            <Card
              title="Default Space"
              description="The default is explicit. Archived Spaces cannot be defaults."
            >
              <Form method="post" className="mk-card-body">
                <input type="hidden" name="intent" value="default" />
                <label className="mk-field">
                  <span className="mk-label">Space</span>
                  <SelectField
                    name="spaceId"
                    defaultValue={page.organization.defaultSpaceId}
                    ariaLabel="Default Space"
                    options={page.spaces
                      .filter((item) => !item.space.archivedAt)
                      .map(({ space }) => ({
                        value: space.id,
                        label: `${space.displayName} (${space.slug})`,
                      }))}
                  />
                </label>
                {outcome("default")}
                <div className="mk-form-actions">
                  <button className="mk-btn mk-btn--primary" disabled={busy}>
                    Set default Space
                  </button>
                </div>
              </Form>
            </Card>
            <Card
              title="People"
              description="Membership does not grant Space content access. Removing membership also revokes that person’s Space grants."
            >
              {outcome("remove-member")}
              <ul className="m-0 mt-4 list-none divide-y divide-line-soft p-0">
                {page.members.map((member) => (
                  <li key={member.id} className="flex flex-wrap items-center gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <Link to={`/accounts/${encodeURIComponent(member.slug)}`} className={link}>
                        <bdi>{member.displayName}</bdi>
                      </Link>
                      <div className="text-body-sm text-ink-faint">
                        @{member.slug} · {member.role === "owner" ? "Owner" : "Member"}
                      </div>
                    </div>
                    <Form method="post">
                      <input type="hidden" name="intent" value="remove-member" />
                      <input type="hidden" name="accountId" value={member.id} />
                      <button
                        className="mk-btn mk-btn--danger-ghost mk-btn--sm min-h-11"
                        disabled={busy}
                        aria-label={`Remove ${member.displayName} from Organization`}
                      >
                        Remove membership
                      </button>
                    </Form>
                  </li>
                ))}
              </ul>
            </Card>
            <Card
              title="Add or change a member"
              description="Add a person, or change their Organization role."
            >
              <Form method="post" className="mk-card-body">
                <input type="hidden" name="intent" value="member" />
                <TextField
                  name="person"
                  label="Person handle"
                  required
                  autoCapitalize="none"
                  spellCheck={false}
                />
                <label className="mk-field">
                  <span className="mk-label">Organization role</span>
                  <SelectField
                    name="role"
                    defaultValue="member"
                    ariaLabel="Organization role"
                    options={[
                      { value: "member", label: "Member" },
                      { value: "owner", label: "Owner — directory and grants administration" },
                    ]}
                  />
                </label>
                {outcome("member")}
                <div className="mk-form-actions">
                  <button className="mk-btn mk-btn--primary" disabled={busy}>
                    Save membership
                  </button>
                </div>
              </Form>
            </Card>
            <Card
              title="New Space"
              description="Creates a separate content scope, not a switch to existing work."
            >
              <Form method="post" className="mk-card-body">
                <input type="hidden" name="intent" value="space" />
                <TextField name="displayName" label="Space name" required />
                <TextField
                  name="slug"
                  label="Global Space handle"
                  required
                  hint="Immutable. Choose the repository and tracker address carefully."
                />
                {outcome("space")}
                <div className="mk-form-actions">
                  <button className="mk-btn mk-btn--primary" disabled={busy}>
                    Create Space
                  </button>
                </div>
              </Form>
            </Card>
          </div>
        </section>
      )}
    </Page>
  );
}
