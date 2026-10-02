import { popMotion } from "./ui.tsx";
import { Menu } from "@base-ui/react/menu";
import {
  EnvelopeSimpleIcon,
  FingerprintIcon,
  HouseIcon,
  KeyIcon,
  ListChecksIcon,
  MoonIcon,
  PackageIcon,
  PlusIcon,
  SignInIcon,
  SignOutIcon,
  SunIcon,
  UserCircleIcon,
  UserSwitchIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { Link, NavLink, Outlet, useFetcher, useLocation, useNavigation } from "react-router";
import { useViewer } from "../lib/session.ts";
import { applyTheme, storedTheme, type Theme } from "../lib/theme.ts";
import { Monogram } from "./Monogram.tsx";
import { GitmatrixLogo } from "./GitmatrixLogo.tsx";
import { Tip, Toasts } from "./ui.tsx";

function Place({
  to,
  label,
  end,
  also,
  children,
}: {
  to: string;
  label: string;
  end?: boolean;
  /** Other pages that belong to this place and light it up too. */
  also?: RegExp;
  children: (active: boolean) => React.ReactNode;
}) {
  const { pathname } = useLocation();
  const className = "mk-place max-sm:before:hidden";
  return (
    <Tip label={label} side="right">
      {also?.test(pathname) ? (
        <Link to={to} className={className} aria-current="page" aria-label={label}>
          {children(true)}
        </Link>
      ) : (
        <NavLink to={to} end={end} className={className} aria-label={label}>
          {({ isActive }) => children(isActive)}
        </NavLink>
      )}
    </Tip>
  );
}

function AccountMenu() {
  const viewer = useViewer();
  const signOut = useFetcher();
  const [theme, setTheme] = useState<Theme>(storedTheme);
  if (!viewer) return null;

  const chooseTheme = (next: string) => {
    setTheme(next as Theme);
    applyTheme(next as Theme);
  };

  return (
    <Menu.Root>
      <Tip label={`${viewer.displayName}, account`} side="right">
        <Menu.Trigger
          className="grid size-12 place-items-center rounded-full"
          aria-label={`${viewer.displayName}, account menu`}
        >
          <Monogram name={viewer.displayName} />
        </Menu.Trigger>
      </Tip>
      <Menu.Portal>
        <Menu.Positioner side="right" align="end" sideOffset={12} className="z-50">
          <Menu.Popup className={`mk-popup ${popMotion}`}>
            <div className="px-2.5 pt-2 pb-1.5">
              <div className="font-semibold">
                <bdi>{viewer.displayName}</bdi>
              </div>
              <div className="text-body-sm text-ink-faint">
                @{viewer.slug}
                {viewer.isSiteAdmin && " · Site admin"}
              </div>
            </div>
            <div className="mk-menu-sep" />
            <Menu.LinkItem className="mk-menu-item" render={<Link to={`/${viewer.slug}`} />}>
              <HouseIcon className="size-4" aria-hidden />
              Your profile
            </Menu.LinkItem>
            <Menu.LinkItem className="mk-menu-item" render={<Link to="/settings/profile" />}>
              <UserCircleIcon className="size-4" aria-hidden />
              Edit profile
            </Menu.LinkItem>
            <Menu.LinkItem className="mk-menu-item" render={<Link to="/settings/tokens" />}>
              <KeyIcon className="size-4" aria-hidden />
              Access tokens
            </Menu.LinkItem>
            <Menu.LinkItem className="mk-menu-item" render={<Link to="/settings/ssh-keys" />}>
              <FingerprintIcon className="size-4" aria-hidden />
              SSH keys
            </Menu.LinkItem>
            {viewer.isSiteAdmin && (
              <Menu.LinkItem className="mk-menu-item" render={<Link to="/settings/invites" />}>
                <EnvelopeSimpleIcon className="size-4" aria-hidden />
                Invitations
              </Menu.LinkItem>
            )}
            <Menu.LinkItem className="mk-menu-item" render={<Link to="/signin" />}>
              <UserSwitchIcon className="size-4" aria-hidden />
              Switch account
            </Menu.LinkItem>
            <div className="mk-menu-sep" />
            <Menu.RadioGroup value={theme} onValueChange={chooseTheme}>
              <Menu.GroupLabel className="mk-menu-label">Theme</Menu.GroupLabel>
              <Menu.RadioItem value="dark" className="mk-menu-item" closeOnClick={false}>
                <MoonIcon className="size-4" aria-hidden />
                <span className="flex-1">Dark</span>
                <span className="mk-radio-dot" />
              </Menu.RadioItem>
              <Menu.RadioItem value="light" className="mk-menu-item" closeOnClick={false}>
                <SunIcon className="size-4" aria-hidden />
                <span className="flex-1">Light</span>
                <span className="mk-radio-dot" />
              </Menu.RadioItem>
            </Menu.RadioGroup>
            <div className="mk-menu-sep" />
            <Menu.Item
              className="mk-menu-item"
              onClick={() =>
                signOut.submit(null, { method: "post", action: "/signin?intent=signout" })
              }
            >
              <SignOutIcon className="size-4" aria-hidden />
              Sign out
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function AppShell() {
  const viewer = useViewer();
  const navigation = useNavigation();
  const location = useLocation();
  const places = viewer?.canCreateIn.slice(1) ?? [];

  // Sign-in and device approval are their own focused pages, outside the shell.
  if (location.pathname === "/signin" || location.pathname === "/device")
    return (
      <>
        <Outlet />
        <Toasts />
      </>
    );

  return (
    <div className="flex min-h-dvh max-sm:flex-col">
      <nav
        aria-label="Places"
        className="mk-rail sticky top-0 z-20 h-dvh shrink-0 max-sm:h-auto max-sm:w-full max-sm:flex-row max-sm:px-3 max-sm:py-2"
      >
        <Place to="/" label="Home" end>
          {() => <GitmatrixLogo markOnly className="size-8" />}
        </Place>
        {viewer && (
          <Place to="/tracker" label="Issue tracker">
            {(active) => (
              <ListChecksIcon size={22} weight={active ? "fill" : "regular"} aria-hidden />
            )}
          </Place>
        )}
        {viewer && (
          <Place to="/packages" label="Packages" also={/^\/[^/]+\/-\/(packages|feeds)(\/|$)/}>
            {(active) => <PackageIcon size={22} weight={active ? "fill" : "regular"} aria-hidden />}
          </Place>
        )}
        {viewer && (
          <Place to="/settings/tokens" label="Access tokens">
            {(active) => <KeyIcon size={22} weight={active ? "fill" : "regular"} aria-hidden />}
          </Place>
        )}
        {places.length > 0 && <span className="mk-rail-rule max-sm:hidden" />}
        {places.map((org) => (
          <Tip key={org.id} label={org.displayName} side="right">
            <NavLink
              to={`/${org.slug}`}
              className="grid size-12 place-items-center rounded-[16px]"
              aria-label={org.displayName}
            >
              <Monogram name={org.displayName} shape="place" size="lg" />
            </NavLink>
          </Tip>
        ))}
        {viewer && (
          <Tip label="New repository" side="right">
            <NavLink
              to="/new"
              className="mk-place mk-place--add max-sm:before:hidden"
              aria-label="New repository"
            >
              <PlusIcon size={20} weight="bold" aria-hidden />
            </NavLink>
          </Tip>
        )}
        <div className="flex-1" />
        {viewer ? (
          <AccountMenu />
        ) : (
          <Place to={`/signin?next=${encodeURIComponent(location.pathname)}`} label="Sign in">
            {() => <SignInIcon size={22} aria-hidden />}
          </Place>
        )}
      </nav>
      <main
        className="min-w-0 flex-1 transition-opacity"
        style={{ opacity: navigation.state === "loading" ? 0.7 : 1 }}
      >
        <Outlet />
      </main>
      <Toasts />
    </div>
  );
}

/** The page column: comfortable reading width, generous section spacing. */
/**
 * The page column. Reading and settings pages stay narrow; `wide` suits
 * familiar document layouts (code, commits); `full` is for workspaces that
 * get better with room (CI, packages, issues, knowledge, wiki).
 */
export function Page({
  children,
  wide = false,
  full = false,
}: {
  children: React.ReactNode;
  wide?: boolean;
  full?: boolean;
}) {
  const width = full ? "max-w-[120rem]" : wide ? "max-w-6xl" : "max-w-4xl";
  return <div className={`mx-auto w-full px-4 py-5 sm:px-8 sm:py-7 ${width}`}>{children}</div>;
}
