import { data, Link, type LoaderFunctionArgs } from "react-router";
import { Page } from "../components/AppShell.tsx";
import { link } from "../components/ui.tsx";
import { requireViewer } from "../lib/session.ts";

export async function instanceLoader({ request }: LoaderFunctionArgs) {
  const viewer = await requireViewer(request);
  if (!viewer.isSiteAdmin)
    throw data({ message: "Instance operator access is required." }, { status: 403 });
  return null;
}
export function Instance() {
  return (
    <Page>
      <h1 className="m-0 text-headline">Instance</h1>
      <p className="max-w-[65ch] text-ink-muted">
        Deployment-wide operator settings. These powers are separate from Organization membership
        and do not grant private Tracker access.
      </p>
      <nav aria-label="Instance administration" className="mt-8 flex flex-col items-start gap-3">
        <Link className={`${link} inline-flex min-h-11 items-center`} to="/settings/invites">
          Account invitations
        </Link>
        <Link className={`${link} inline-flex min-h-11 items-center`} to="/settings/site-ai">
          Instance AI infrastructure
        </Link>
        <Link className={`${link} inline-flex min-h-11 items-center`} to="/settings/site-usage">
          Instance usage
        </Link>
        <Link className={`${link} inline-flex min-h-11 items-center`} to="/settings/site-retention">
          Instance data retention
        </Link>
      </nav>
    </Page>
  );
}
