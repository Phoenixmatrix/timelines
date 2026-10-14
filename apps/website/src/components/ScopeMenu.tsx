import { Menu } from "@base-ui/react/menu";
import { BuildingsIcon, CaretRightIcon, CheckIcon, SquaresFourIcon } from "@phosphor-icons/react";
import { Link, useLocation, useMatches } from "react-router";
import type { SpaceSummary } from "../../shared/spaces.ts";
import { useViewer } from "../lib/session.ts";
import { popMotion } from "./ui.tsx";

/** The Organization and Space the current page belongs to, as far as the viewer can see. */
function useScope() {
  const viewer = useViewer();
  const matches = useMatches();
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
  const spaces = (viewer?.spaces ?? []).filter(
    (item) => item.organizationId === organization?.id && !item.archivedAt,
  );
  return { viewer, slug, space, organization, spaces };
}

const itemClass = "mk-menu-item min-w-0 text-ink no-underline";

function Choice({ to, current, children }: { to: string; current: boolean; children: string }) {
  return (
    <Menu.LinkItem
      closeOnClick
      className={itemClass}
      aria-current={current ? "true" : undefined}
      render={<Link to={to} />}
    >
      <CheckIcon
        weight="bold"
        className={`size-4 shrink-0 text-signal-line ${current ? "" : "invisible"}`}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </Menu.LinkItem>
  );
}

function Submenu({
  icon,
  label,
  value,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger className={itemClass} aria-label={`${label}: ${value}`}>
        {icon}
        <span className="flex min-w-0 flex-1 flex-col py-1 leading-tight">
          <span className="text-body-sm text-ink-faint">{label}</span>
          <span className="truncate">{value}</span>
        </span>
        <CaretRightIcon className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
      </Menu.SubmenuTrigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={8} alignOffset={-6} className="z-50">
          <Menu.Popup className={`mk-popup max-w-[min(20rem,calc(100vw-1rem))] ${popMotion}`}>
            {children}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}

/**
 * Organization and Space switching, in the account menu (CORE-414). Context
 * navigation never creates content or infers a grant from an Organization role.
 */
export function ScopeMenu() {
  const { viewer, slug, space, organization, spaces } = useScope();
  if (!viewer) return null;
  return (
    <>
      <Submenu
        icon={<BuildingsIcon className="size-4 shrink-0" aria-hidden />}
        label="Organization"
        value={organization?.displayName ?? "Choose an Organization"}
      >
        {viewer.organizations.map((item) => (
          <Choice
            key={item.id}
            to={`/organizations/${encodeURIComponent(item.slug)}?enter=1`}
            current={item.id === organization?.id}
          >
            {item.displayName}
          </Choice>
        ))}
        {viewer.organizations.length > 0 && <div className="mk-menu-sep" />}
        <Menu.LinkItem
          closeOnClick
          className={itemClass}
          render={
            <Link
              to={
                organization
                  ? `/organizations/${encodeURIComponent(organization.slug)}`
                  : "/organizations"
              }
            />
          }
        >
          <BuildingsIcon className="size-4 shrink-0" aria-hidden />
          Organization directory
        </Menu.LinkItem>
      </Submenu>
      {/* Spaces only list within the Organization in context; without one, there is nothing to switch between. */}
      {organization && (
        <Submenu
          icon={<SquaresFourIcon className="size-4 shrink-0" aria-hidden />}
          label="Space"
          value={space ? space.displayName : slug ? `${slug} · no Space grant` : "Choose a Space"}
        >
          {spaces.length ? (
            spaces.map((item) => (
              <Choice
                key={item.id}
                to={`/${encodeURIComponent(item.slug)}`}
                current={item.id === space?.id}
              >
                {item.displayName === item.slug ? item.slug : `${item.displayName} (${item.slug})`}
              </Choice>
            ))
          ) : (
            <div className="px-2.5 py-2 text-body-sm text-ink-faint">No Spaces granted to you</div>
          )}
        </Submenu>
      )}
    </>
  );
}
