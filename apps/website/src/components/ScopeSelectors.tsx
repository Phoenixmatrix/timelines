import { Link, useLocation, useMatches, useNavigate } from "react-router";
import type { SpaceSummary } from "../../shared/spaces.ts";
import { SelectField, link } from "./ui.tsx";
import { useViewer } from "../lib/session.ts";

/** Context navigation never creates content or infers a grant from an Organization role. */
export function ScopeSelectors() {
  const viewer = useViewer();
  const matches = useMatches();
  const navigate = useNavigate();
  const location = useLocation();
  const params = matches.at(-1)?.params ?? {};
  const slug = params.space ?? new URLSearchParams(location.search).get("space");
  const space = viewer?.spaces.find((item) => item.slug === slug);
  const displayedSpace =
    space ??
    matches
      .map((match) => (match.loaderData as { space?: SpaceSummary } | undefined)?.space)
      .find((item) => item?.slug === slug);
  const organization = viewer?.organizations.find(
    (item) => item.slug === params.organization || item.id === displayedSpace?.organizationId,
  );
  if (!viewer) return null;
  const spaces = viewer.spaces.filter(
    (item) => item.organizationId === organization?.id && !item.archivedAt,
  );
  return (
    <nav
      aria-label="Organization and Space"
      className="flex flex-wrap items-end gap-3 border-b border-line px-4 py-3 sm:px-8"
    >
      <label className="mk-field min-w-0 flex-1 sm:max-w-64">
        <span className="mk-label">Organization</span>
        <SelectField
          ariaLabel="Switch Organization"
          value={organization?.slug ?? ""}
          options={[
            { value: "", label: "Choose an Organization" },
            ...viewer.organizations.map((item) => ({ value: item.slug, label: item.displayName })),
          ]}
          onChange={(value) => {
            if (value) void navigate(`/organizations/${encodeURIComponent(value)}?enter=1`);
          }}
        />
      </label>
      <label className="mk-field min-w-0 flex-1 sm:max-w-64">
        <span className="mk-label">Space</span>
        <SelectField
          ariaLabel="Switch Space"
          value={space?.slug ?? ""}
          options={[
            { value: "", label: slug && !space ? `${slug} · no Space grant` : "Choose a Space" },
            ...spaces.map((item) => ({
              value: item.slug,
              label:
                item.displayName === item.slug ? item.slug : `${item.displayName} (${item.slug})`,
            })),
          ]}
          onChange={(value) => {
            if (value) void navigate(`/${encodeURIComponent(value)}`);
          }}
        />
      </label>
      <Link
        className={`${link} inline-flex min-h-11 items-center text-body-sm max-sm:basis-full`}
        to={
          organization
            ? `/organizations/${encodeURIComponent(organization.slug)}`
            : "/organizations"
        }
      >
        Organization directory
      </Link>
    </nav>
  );
}
