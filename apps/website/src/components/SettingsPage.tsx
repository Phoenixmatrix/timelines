import {
  CaretDownIcon,
  ChartBarIcon,
  ClockCounterClockwiseIcon,
  EnvelopeSimpleIcon,
  FingerprintIcon,
  GearSixIcon,
  KeyIcon,
  PlugsConnectedIcon,
  RobotIcon,
  SlidersHorizontalIcon,
  UserCircleIcon,
  UserPlusIcon,
  UsersThreeIcon,
  type Icon,
} from "@phosphor-icons/react";
import { useId } from "react";
import { Link, useLocation } from "react-router";
import { useViewer } from "../lib/session.ts";
import { Page } from "./AppShell.tsx";

/** One settings area: a readable form column, with wide reports kept explicit. */
export function SettingsPage({
  children,
  space,
  tracker = false,
  wide = false,
}: {
  children: React.ReactNode;
  space?: string;
  tracker?: boolean;
  wide?: boolean;
}) {
  const viewer = useViewer();
  const location = useLocation();
  const id = useId();
  const params = new URLSearchParams(location.search);
  const selectedSpace =
    space ??
    params.get("space") ??
    params.get("tracker") ??
    viewer?.spaces.find((entry) => entry.id === viewer.defaultSpaceId)?.slug;
  const spaceQuery = selectedSpace ? `?space=${encodeURIComponent(selectedSpace)}` : "";
  const personQuery = viewer ? `?person=${encodeURIComponent(viewer.slug)}` : "";
  const trackerQuery = selectedSpace ? `?tracker=${encodeURIComponent(selectedSpace)}` : "";
  const trackerPath = selectedSpace ? `/tracker/${encodeURIComponent(selectedSpace)}` : "/tracker";
  const groups: {
    label: string;
    context: string | null;
    links: { label: string; to: string; icon: Icon; active?: boolean }[];
  }[] = [
    ...(selectedSpace && viewer?.spaces.some((entry) => entry.slug === selectedSpace)
      ? [
          {
            label: "Space",
            context: `@${selectedSpace}`,
            links: [
              {
                label: "Teams and Projects",
                to: `${trackerPath}?manage=true`,
                icon: UsersThreeIcon,
                active: tracker,
              },
              { label: "AI settings", to: `/settings/ai${spaceQuery}`, icon: GearSixIcon },
              {
                label: "AI providers",
                to: `/settings/ai-providers${spaceQuery}`,
                icon: PlugsConnectedIcon,
              },
              {
                label: "Space usage & costs",
                to: `/settings/usage${spaceQuery}`,
                icon: ChartBarIcon,
              },
              {
                label: "Space data retention",
                to: `/settings/retention${spaceQuery}`,
                icon: ClockCounterClockwiseIcon,
              },
            ],
          },
        ]
      : []),
    {
      label: "Personal",
      context: viewer ? `@${viewer.slug}` : null,
      links: [
        { label: "Profile", to: "/settings/profile", icon: UserCircleIcon },
        { label: "Assistant skills", to: "/settings/skills", icon: RobotIcon },
        { label: "Personal AI logging", to: `/settings/ai${personQuery}`, icon: GearSixIcon },
        {
          label: "Preferences",
          to: `/settings/preferences${trackerQuery}`,
          icon: SlidersHorizontalIcon,
        },
        { label: "Access tokens", to: "/settings/tokens", icon: KeyIcon },
        { label: "SSH keys", to: "/settings/ssh-keys", icon: FingerprintIcon },
        { label: "Agents", to: "/settings/agents", icon: RobotIcon },
        {
          label: "Personal usage & costs",
          to: `/settings/usage${personQuery}`,
          icon: ChartBarIcon,
        },
        {
          label: "Personal data retention",
          to: `/settings/retention${personQuery}`,
          icon: ClockCounterClockwiseIcon,
        },
      ],
    },
    ...(viewer?.isSiteAdmin
      ? [
          {
            label: "Instance",
            context: null,
            links: [
              {
                label: "Invitations",
                to: "/settings/invites",
                icon: EnvelopeSimpleIcon,
              },
              {
                label: "Accounts",
                to: "/settings/accounts",
                icon: UserPlusIcon,
              },
              {
                label: "Instance AI settings",
                to: "/settings/site-ai",
                icon: GearSixIcon,
              },
              {
                label: "Instance usage & costs",
                to: "/settings/site-usage",
                icon: ChartBarIcon,
              },
              {
                label: "Instance data retention",
                to: "/settings/site-retention",
                icon: ClockCounterClockwiseIcon,
              },
            ],
          },
        ]
      : []),
  ];
  const sections = groups.map((group) => ({
    ...group,
    links: group.links.map((item) => ({
      ...item,
      active:
        item.active ??
        (location.pathname === item.to.split("?")[0] &&
          (!["/settings/ai", "/settings/usage", "/settings/retention"].includes(
            location.pathname,
          ) ||
            (new URLSearchParams(item.to.split("?")[1]).get("person")
              ? params.has("person")
              : params.has("space")))),
    })),
  }));
  const current = sections.flatMap((group) => group.links).find((item) => item.active)?.label;
  // Group labels sit on the page surface; links sit inside a pane with an icon each, so the two
  // differ by container, tone and shape rather than by capitalization alone.
  const navigation = (prefix: string) => (
    <nav aria-label="Settings sections" className="flex flex-col gap-5">
      {sections.map((group, index) => {
        const labelId = `${id}-${prefix}-${index}`;
        return (
          <div key={group.label} className="flex flex-col gap-2">
            <p
              id={labelId}
              className="m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-2 text-label text-ink-faint"
            >
              {group.label}
              {group.context && (
                <span className="mk-chip mk-chip--tag mk-mono max-w-full min-w-0 truncate">
                  {group.context}
                </span>
              )}
            </p>
            <ul
              aria-labelledby={labelId}
              className="m-0 flex list-none flex-col gap-0.5 rounded-pane bg-pane p-1"
            >
              {group.links.map((item) => {
                const ItemIcon = item.icon;
                return (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      aria-current={item.active ? "page" : undefined}
                      className={`flex min-h-11 items-center gap-2.5 rounded-control px-3 py-2 text-body-sm no-underline transition-colors ${item.active ? "bg-signal-wash font-semibold text-ink" : "text-ink-muted hover:bg-raised hover:text-ink"}`}
                    >
                      <ItemIcon
                        className={`size-4.5 shrink-0 ${item.active ? "text-ink" : "text-ink-faint"}`}
                        weight={item.active ? "fill" : "regular"}
                        aria-hidden
                      />
                      <span className="min-w-0">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );

  return (
    <Page wide>
      <div className="settings-layout flex min-w-0 flex-col gap-6 md:flex-row md:gap-8">
        <aside className="hidden w-52 shrink-0 self-start md:sticky md:top-7 md:block">
          <p className="mt-0 mb-5 px-2 text-title">Settings</p>
          {navigation("side")}
        </aside>
        <details
          key={`${location.pathname}${location.search}`}
          className="group border-b border-line-soft pb-3 md:hidden"
        >
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-body-sm [&::-webkit-details-marker]:hidden">
            <span>
              <span className="text-ink-muted">Settings / </span>
              {current}
            </span>
            <CaretDownIcon
              className="size-4 shrink-0 transition-transform group-open:rotate-180"
              aria-hidden
            />
          </summary>
          <div className="pt-4 pb-2">{navigation("menu")}</div>
        </details>
        <div className={`min-w-0 flex-1 ${wide || tracker ? "" : "max-w-3xl"}`}>{children}</div>
      </div>
    </Page>
  );
}
