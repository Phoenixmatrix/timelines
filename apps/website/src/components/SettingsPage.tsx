import { CaretDownIcon } from "@phosphor-icons/react";
import { Link, useLocation } from "react-router";
import { useViewer } from "../lib/session.ts";
import { Page } from "./AppShell.tsx";

/** One settings area, with account policy separate from personal preferences. */
export function SettingsPage({
  children,
  owner,
  tracker = false,
}: {
  children: React.ReactNode;
  owner?: string;
  tracker?: boolean;
}) {
  const viewer = useViewer();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const account = owner ?? params.get("owner") ?? params.get("tracker") ?? viewer?.slug;
  const accountQuery = account ? `?owner=${encodeURIComponent(account)}` : "";
  const trackerQuery = account ? `?tracker=${encodeURIComponent(account)}` : "";
  const trackerPath = account ? `/tracker/${encodeURIComponent(account)}` : "/tracker";
  const groups = [
    {
      label: "Account",
      context: account ? `@${account}` : null,
      links: [
        { label: "Teams and workspaces", to: `${trackerPath}?manage=true`, active: tracker },
        { label: "AI settings", to: `/settings/ai${accountQuery}` },
      ],
    },
    {
      label: "Personal",
      context: null,
      links: [
        { label: "Profile", to: `/settings/profile${accountQuery}` },
        { label: "Preferences", to: `/settings/preferences${trackerQuery}` },
        { label: "Access tokens", to: `/settings/tokens${accountQuery}` },
        { label: "SSH keys", to: `/settings/ssh-keys${accountQuery}` },
        { label: "Agents", to: `/settings/agents${accountQuery}` },
      ],
    },
    ...(viewer?.isSiteAdmin
      ? [
          {
            label: "Administration",
            context: null,
            links: [{ label: "Invitations", to: `/settings/invites${accountQuery}` }],
          },
        ]
      : []),
  ];
  const sections = groups.map((group) => ({
    ...group,
    links: group.links.map((item) => ({
      ...item,
      active: "active" in item ? item.active : location.pathname === item.to.split("?")[0],
    })),
  }));
  const current = sections.flatMap((group) => group.links).find((item) => item.active)?.label;
  const navigation = (
    <nav aria-label="Settings sections" className="flex flex-col gap-6">
      {sections.map((group) => (
        <div key={group.label}>
          <div className="mb-2 flex flex-wrap items-baseline gap-x-2 px-3 text-body-sm text-ink-muted">
            <span className="text-label tracking-wider uppercase">{group.label}</span>
            {group.context && <span className="min-w-0 break-all">{group.context}</span>}
          </div>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {group.links.map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
                  aria-current={item.active ? "page" : undefined}
                  className={`flex min-h-11 items-center rounded-control px-3 py-2 text-body-sm no-underline transition-colors ${item.active ? "bg-signal-wash font-semibold text-ink" : "text-ink-muted hover:bg-raised hover:text-ink"}`}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <Page wide>
      <div className="flex min-w-0 flex-col gap-6 md:flex-row md:gap-8">
        <aside className="hidden w-52 shrink-0 self-start md:sticky md:top-7 md:block">
          <p className="mt-0 mb-6 px-3 text-title">Settings</p>
          {navigation}
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
          <div className="pt-4 pb-2">{navigation}</div>
        </details>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </Page>
  );
}
