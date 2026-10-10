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
  owner,
  tracker = false,
  wide = false,
}: {
  children: React.ReactNode;
  owner?: string;
  tracker?: boolean;
  wide?: boolean;
}) {
  const viewer = useViewer();
  const location = useLocation();
  const id = useId();
  const params = new URLSearchParams(location.search);
  const account = owner ?? params.get("owner") ?? params.get("tracker") ?? viewer?.slug;
  const accountQuery = account ? `?owner=${encodeURIComponent(account)}` : "";
  const trackerQuery = account ? `?tracker=${encodeURIComponent(account)}` : "";
  const trackerPath = account ? `/tracker/${encodeURIComponent(account)}` : "/tracker";
  const groups: {
    label: string;
    context: string | null;
    links: { label: string; to: string; icon: Icon; active?: boolean }[];
  }[] = [
    {
      label: "Account",
      context: account ? `@${account}` : null,
      links: [
        {
          label: "Teams and workspaces",
          to: `${trackerPath}?manage=true`,
          icon: UsersThreeIcon,
          active: tracker,
        },
        { label: "AI settings", to: `/settings/ai${accountQuery}`, icon: GearSixIcon },
        {
          label: "AI providers",
          to: `/settings/ai-providers${accountQuery}`,
          icon: PlugsConnectedIcon,
        },
        { label: "Usage & costs", to: `/settings/usage${accountQuery}`, icon: ChartBarIcon },
        {
          label: "Data retention",
          to: `/settings/retention${accountQuery}`,
          icon: ClockCounterClockwiseIcon,
        },
      ],
    },
    {
      label: "Personal",
      context: null,
      links: [
        { label: "Profile", to: `/settings/profile${accountQuery}`, icon: UserCircleIcon },
        { label: "Assistant skills", to: `/settings/skills${accountQuery}`, icon: RobotIcon },
        {
          label: "Preferences",
          to: `/settings/preferences${trackerQuery}`,
          icon: SlidersHorizontalIcon,
        },
        { label: "Access tokens", to: `/settings/tokens${accountQuery}`, icon: KeyIcon },
        { label: "SSH keys", to: `/settings/ssh-keys${accountQuery}`, icon: FingerprintIcon },
        { label: "Agents", to: `/settings/agents${accountQuery}`, icon: RobotIcon },
      ],
    },
    ...(viewer?.isSiteAdmin
      ? [
          {
            label: "Administration",
            context: null,
            links: [
              {
                label: "Invitations",
                to: `/settings/invites${accountQuery}`,
                icon: EnvelopeSimpleIcon,
              },
              {
                label: "Site AI settings",
                to: `/settings/site-ai${accountQuery}`,
                icon: GearSixIcon,
              },
              {
                label: "Site usage & costs",
                to: `/settings/site-usage${accountQuery}`,
                icon: ChartBarIcon,
              },
              {
                label: "Site data retention",
                to: `/settings/site-retention${accountQuery}`,
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
      active: item.active ?? location.pathname === item.to.split("?")[0],
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
