import {
  data,
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import type { AccountSummary, RepoSummary } from "../../shared/api.ts";
import type { OrganizationPage, SpaceGrant, SpacePage } from "../../shared/spaces.ts";
import { Page } from "../components/AppShell.tsx";
import { RepoList } from "../components/RepoList.tsx";
import { Card, FormError, SelectField, TextField, link } from "../components/ui.tsx";
import { api, ApiError, attempt, field, load } from "../lib/api.ts";
import { likelyGrantedSpace, useViewer } from "../lib/session.ts";

type Team = { id: string; key: string; name: string };

/** A Space's Tracker teams, or why they couldn't be read (settled, never rejected). */
function teamsOf(slug: string, request: Request) {
  return api<{ teams: Team[] }>(`/tracker/${slug}/teams`, { signal: request.signal }).then(
    (result) => ({ teams: result.teams, error: null }),
    (error: unknown) => ({ teams: null, error }),
  );
}

export async function spaceLoader({ request, params }: LoaderFunctionArgs) {
  const slug = encodeURIComponent(params.space!);
  // Content readers' Tracker teams are read alongside the page rather than
  // after it when the session already listed a grant here; the page's
  // capabilities still decide whether they're used. Without one, nothing
  // under the Tracker is read before the page says it may be.
  const early = likelyGrantedSpace(params.space!) ? teamsOf(slug, request) : null;
  // The repositories and the Space page are independent: read them together.
  const [{ repos }, read] = await Promise.all([
    load<{ repos: RepoSummary[] }>(`/repos?space=${slug}`, request),
    api<SpacePage>(`/spaces/${slug}`, { signal: request.signal }).then(
      (page) => ({ page, error: null }),
      (error: unknown) => ({ page: null, error }),
    ),
  ]);
  let page: SpacePage | null = read.page;
  if (read.error) {
    const { error } = read;
    if (!(error instanceof ApiError)) throw error;
    if (![401, 403, 404].includes(error.status))
      throw data({ message: error.message }, { status: error.status });
    if (!repos.length) throw data({ message: "No such Space." }, { status: 404 });
    // A readable public repository or explicit collaborator grant exposes only
    // its own Space locator, never directory, Tracker or policy authority.
    page = null;
  }
  const space = page?.space ?? repos[0]!.space;
  const base = `/organizations/${encodeURIComponent(space.organization.slug)}`;
  // Directory administration follows from the page alone.
  const [administration, teams] = await Promise.all([
    page?.capabilities.canManageGrants
      ? Promise.all([
          load<{ members: AccountSummary[] }>(`${base}/members`, request),
          load<{ grants: SpaceGrant[] }>(`/spaces/${slug}/grants`, request),
          load<OrganizationPage>(base, request),
        ])
      : null,
    page?.capabilities.canReadContent
      ? (early ?? teamsOf(slug, request)).then(({ teams, error }) => {
          if (teams) return teams;
          if (error instanceof ApiError)
            throw data({ message: error.message }, { status: error.status });
          throw error;
        })
      : [],
  ]);
  const members: AccountSummary[] = administration?.[0].members ?? [];
  const grants: SpaceGrant[] = administration?.[1].grants ?? [];
  const organization: OrganizationPage | null = administration?.[2] ?? null;
  return { page, space, repos, members, grants, organization, teams };
}
export async function spaceAction({ request, params }: ActionFunctionArgs) {
  const base = `/spaces/${encodeURIComponent(params.space!)}`;
  const form = await request.formData();
  return attempt(async () => {
    const intent = field(form, "intent");
    if (intent === "grant")
      await api(`${base}/grants/${encodeURIComponent(field(form, "accountId"))}`, {
        method: "PUT",
        json: {
          role: field(form, "role"),
          repositoryRole: field(form, "repositoryRole"),
          packageRole: field(form, "packageRole"),
        },
      });
    else if (intent === "revoke")
      await api(`${base}/grants/${encodeURIComponent(field(form, "accountId"))}`, {
        method: "DELETE",
      });
    else if (intent === "rename")
      await api(base, { method: "PATCH", json: { displayName: field(form, "displayName") } });
    else if (intent === "archive")
      await api(`${base}/archive`, {
        method: "POST",
        json: { replacementDefaultSpaceId: field(form, "replacementDefaultSpaceId") || undefined },
      });
    else if (intent === "restore") await api(`${base}/restore`, { method: "POST" });
    else throw data({ message: "Unknown Space action." }, { status: 400 });
    return { saved: true };
  });
}
const resourceRoles = [
  { value: "none", label: "No baseline access" },
  { value: "read", label: "Read" },
  { value: "write", label: "Read and write" },
];
export function Space() {
  const { page, space, repos, members, grants, organization, teams } =
    useLoaderData<typeof spaceLoader>();
  const viewer = useViewer();
  const result = useActionData<typeof spaceAction>();
  const busy = useNavigation().state !== "idle";
  const capabilities = page?.capabilities;
  const base = `/${encodeURIComponent(space.slug)}`;
  const tracker = `/tracker/${encodeURIComponent(space.slug)}`;
  const organizationVisible = viewer?.organizations.some(
    (item) => item.id === space.organizationId,
  );
  const replacements =
    organization?.spaces.filter((item) => item.space.id !== space.id && !item.space.archivedAt) ??
    [];
  return (
    <Page key={space.id}>
      <header>
        <h1 className="m-0 text-headline">
          <bdi>{space.displayName}</bdi>
        </h1>
        <p className="text-ink-muted">
          {organizationVisible ? (
            <Link
              className={link}
              to={`/organizations/${encodeURIComponent(space.organization.slug)}`}
            >
              {space.organization.displayName}
            </Link>
          ) : (
            space.organization.displayName
          )}{" "}
          / {space.slug} · Space{space.archivedAt ? " · Archived" : ""}
          {space.organization.defaultSpaceId === space.id ? " · Default" : ""}
        </p>
      </header>
      <FormError message={result && "error" in result ? result.error : undefined} />
      {result && "saved" in result && <p role="status">Space updated.</p>}
      {!capabilities?.canReadContent && (
        <p className="text-ink-muted">
          You do not have a Space content grant. Only independently accessible repositories are
          shown; Organization administration does not reveal private work.
        </p>
      )}
      {capabilities?.canReadContent && (
        <section aria-label="Tracker">
          <nav aria-label="Space work" className="mt-6 flex flex-wrap gap-x-6 gap-y-2">
            <Link className={`${link} inline-flex min-h-11 items-center`} to={tracker}>
              Issues
            </Link>
            <Link
              className={`${link} inline-flex min-h-11 items-center`}
              to={`${tracker}/projects`}
            >
              Projects
            </Link>
            <Link className={`${link} inline-flex min-h-11 items-center`} to={`${tracker}/teams`}>
              Teams
            </Link>
            <Link className={`${link} inline-flex min-h-11 items-center`} to={`${base}/-/packages`}>
              Packages
            </Link>
            <Link className={`${link} inline-flex min-h-11 items-center`} to={`${base}/-/atlas`}>
              Knowledge
            </Link>
          </nav>
          <ul aria-label="Teams" className="m-0 mt-3 flex list-none flex-wrap gap-x-4 gap-y-2 p-0">
            {teams.map((team) => (
              <li key={team.id}>
                <Link
                  className={`${link} inline-flex min-h-11 items-center gap-2`}
                  to={`${tracker}?${new URLSearchParams({ q: `is:open team:${team.key.toLowerCase()}` })}`}
                >
                  <span className="font-mono text-mono">{team.key}</span>
                  <bdi>{team.name}</bdi>
                </Link>
              </li>
            ))}
          </ul>
          {!teams.length && <p className="text-body-sm text-ink-muted">No active teams yet.</p>}
        </section>
      )}
      <section className="mt-8" aria-labelledby="repositories-heading">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 id="repositories-heading" className="m-0 text-title">
            Repositories
          </h2>
          {capabilities?.canCreateRepository && !space.archivedAt && (
            <Link className="mk-btn mk-btn--primary" to={`${base}/-/repositories/new`}>
              New repository
            </Link>
          )}
        </div>
        <RepoList
          repos={repos}
          showSpace={false}
          empty="No repositories you can access in this Space."
        />
      </section>
      {capabilities?.canAdministerContent && (
        <section id="settings" className="mt-8" aria-labelledby="content-settings-heading">
          <h2 id="content-settings-heading" className="text-title">
            Space settings
          </h2>
          <nav aria-label="Space content settings" className="flex flex-wrap gap-4">
            <Link
              className={`${link} inline-flex min-h-11 items-center`}
              to={`/settings/ai?space=${encodeURIComponent(space.slug)}`}
            >
              AI settings
            </Link>
            <Link
              className={`${link} inline-flex min-h-11 items-center`}
              to={`/settings/ai-providers?space=${encodeURIComponent(space.slug)}`}
            >
              Providers
            </Link>
            <Link
              className={`${link} inline-flex min-h-11 items-center`}
              to={`/settings/usage?space=${encodeURIComponent(space.slug)}`}
            >
              Usage
            </Link>
            <Link
              className={`${link} inline-flex min-h-11 items-center`}
              to={`/settings/retention?space=${encodeURIComponent(space.slug)}`}
            >
              Data retention
            </Link>
          </nav>
        </section>
      )}
      {capabilities?.canManageGrants && (
        <>
          <section className="mt-8" aria-labelledby="space-people">
            <h2 id="space-people" className="text-title">
              People and explicit grants
            </h2>
            <p className="text-body-sm text-ink-muted">
              Space role, repository baseline and package baseline are independent. Granting
              yourself access is an explicit audited action.
            </p>
            <ul className="m-0 list-none divide-y divide-line p-0">
              {grants.map((grant) => {
                const person = members.find((member) => member.id === grant.accountId);
                return (
                  <li
                    key={grant.accountId}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <div>
                      {person ? (
                        <Link className={link} to={`/accounts/${encodeURIComponent(person.slug)}`}>
                          {person.displayName}
                        </Link>
                      ) : (
                        grant.accountId
                      )}
                      <p className="m-0 text-body-sm text-ink-muted">
                        {grant.role} · repositories: {grant.repositoryRole} · packages:{" "}
                        {grant.packageRole}
                      </p>
                    </div>
                    <Form method="post">
                      <input type="hidden" name="intent" value="revoke" />
                      <input type="hidden" name="accountId" value={grant.accountId} />
                      <button
                        disabled={busy}
                        className="mk-btn mk-btn--ghost min-h-11"
                        aria-label={`Revoke Space access for ${person?.displayName ?? grant.accountId}`}
                      >
                        Revoke grant
                      </button>
                    </Form>
                  </li>
                );
              })}
            </ul>
            <Form method="post" className="mt-4 flex max-w-xl flex-col gap-4">
              <input type="hidden" name="intent" value="grant" />
              <label className="mk-field">
                <span className="mk-label">Organization member</span>
                <SelectField
                  name="accountId"
                  ariaLabel="Person receiving Space grant"
                  defaultValue={
                    viewer && members.some((member) => member.id === viewer.id)
                      ? viewer.id
                      : members[0]?.id
                  }
                  options={members.map((member) => ({
                    value: member.id,
                    label: `${member.displayName} (@${member.slug})${member.id === viewer?.id ? " — you" : ""}`,
                  }))}
                />
              </label>
              <label className="mk-field">
                <span className="mk-label">Space role</span>
                <SelectField
                  name="role"
                  ariaLabel="Space role"
                  defaultValue="member"
                  options={[
                    { value: "member", label: "Member" },
                    { value: "admin", label: "Administrator" },
                  ]}
                />
              </label>
              <label className="mk-field">
                <span className="mk-label">Repository baseline</span>
                <SelectField
                  name="repositoryRole"
                  ariaLabel="Repository baseline"
                  defaultValue="none"
                  options={resourceRoles}
                />
              </label>
              <label className="mk-field">
                <span className="mk-label">Package baseline</span>
                <SelectField
                  name="packageRole"
                  ariaLabel="Package baseline"
                  defaultValue="none"
                  options={resourceRoles}
                />
              </label>
              <button
                className="mk-btn mk-btn--primary self-start"
                disabled={busy || !members.length}
              >
                Save explicit Space grant
              </button>
            </Form>
          </section>
          <section className="mt-8 flex flex-col gap-6" aria-label="Space directory settings">
            <Card title="Space name" description="The handle and Organization are permanent.">
              <Form method="post" className="mk-card-body">
                <input type="hidden" name="intent" value="rename" />
                <TextField
                  name="displayName"
                  label="Display name"
                  defaultValue={space.displayName}
                  required
                />
                <button className="mk-btn mk-btn--secondary self-start" disabled={busy}>
                  Save Space name
                </button>
              </Form>
            </Card>
            <Card
              title={space.archivedAt ? "Restore Space" : "Archive Space"}
              description="Archiving stops content access. The Organization must retain an active default Space."
            >
              <Form method="post" className="mk-card-body">
                <input
                  type="hidden"
                  name="intent"
                  value={space.archivedAt ? "restore" : "archive"}
                />
                {!space.archivedAt && space.organization.defaultSpaceId === space.id && (
                  <label className="mk-field">
                    <span className="mk-label">Replacement default Space</span>
                    <SelectField
                      name="replacementDefaultSpaceId"
                      ariaLabel="Replacement default Space"
                      defaultValue={replacements[0]?.space.id}
                      options={replacements.map(({ space: item }) => ({
                        value: item.id,
                        label: item.displayName,
                      }))}
                    />
                    {!replacements.length && (
                      <span className="text-body-sm text-ink-muted">
                        Create another Space before archiving the default.
                      </span>
                    )}
                  </label>
                )}
                <button
                  className="mk-btn mk-btn--secondary self-start"
                  disabled={
                    busy ||
                    (!space.archivedAt &&
                      space.organization.defaultSpaceId === space.id &&
                      !replacements.length)
                  }
                >
                  {space.archivedAt ? "Restore Space" : "Archive Space"}
                </button>
              </Form>
            </Card>
          </section>
        </>
      )}
    </Page>
  );
}
