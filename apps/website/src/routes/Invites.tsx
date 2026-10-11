// Site admins: who may create an account. Sign-up is invite only, so an
// emailed sign-in code only goes to members and to the addresses listed here.

import { EnvelopeSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import type { Invite } from "../../shared/api.ts";
import { SettingsPage } from "../components/SettingsPage.tsx";
import { Card, FormError, TextField } from "../components/ui.tsx";
import { api, attempt, field, load } from "../lib/api.ts";
import { fullDate, timeAgo } from "../lib/format.ts";
import { requireViewer } from "../lib/session.ts";

export async function invitesLoader({ request }: { request: Request }) {
  const viewer = await requireViewer(request);
  if (!viewer.isSiteAdmin) throw redirect("/");
  return load<{ invites: Invite[] }>("/invites", request);
}

export async function invitesAction({ request }: { request: Request }) {
  const form = await request.formData();
  if (form.get("intent") === "revoke")
    return attempt(() =>
      api(`/invites/${encodeURIComponent(field(form, "email"))}`, { method: "DELETE" }),
    );
  const result = await attempt(() =>
    api("/invites", { method: "POST", json: { email: field(form, "email") } }),
  );
  return result && typeof result === "object" && "error" in result ? result : { invited: true };
}

export function Invites() {
  const { invites } = useLoaderData<typeof invitesLoader>();
  const result = useActionData<{ error?: string; invited?: boolean } | undefined>();
  const navigation = useNavigation();
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (result?.invited) formRef.current?.reset();
  }, [result]);

  return (
    <SettingsPage>
      <h1 className="m-0 text-headline">Invitations</h1>
      <p className="mt-1.5 mb-0 max-w-[48ch] text-ink-muted">
        Timelines is invite only. Someone you invite signs in with an emailed code, and their
        account is created then. Add them to an organization or repository afterwards.
      </p>

      <div className="mt-8 flex flex-col gap-6">
        <Card title="Invite someone">
          <Form method="post" ref={formRef} className="mk-card-body">
            <TextField label="Email" name="email" type="email" autoComplete="off" required />
            <FormError message={result?.error} />
            <div className="mk-form-actions">
              <button className="mk-btn mk-btn--primary" disabled={navigation.state !== "idle"}>
                Invite
              </button>
            </div>
          </Form>
        </Card>

        <section aria-labelledby="pending-title">
          <h2 id="pending-title" className="m-0 mb-3 text-title">
            Waiting to sign in
          </h2>
          {invites.length === 0 ? (
            <div className="mk-empty">No open invitations.</div>
          ) : (
            <ul className="m-0 list-none divide-y divide-line-soft overflow-hidden rounded-pane bg-pane p-0">
              {invites.map((invite) => (
                <li
                  key={invite.email}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3"
                >
                  <EnvelopeSimpleIcon className="size-4 text-ink-faint" aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-semibold">{invite.email}</span>
                  <span className="text-body-sm text-ink-faint" title={fullDate(invite.createdAt)}>
                    {invite.invitedBy ? `by @${invite.invitedBy} · ` : ""}
                    {timeAgo(invite.createdAt)}
                  </span>
                  <Form method="post">
                    <input type="hidden" name="intent" value="revoke" />
                    <input type="hidden" name="email" value={invite.email} />
                    <button
                      className="mk-btn mk-btn--ghost mk-btn--sm"
                      aria-label={`Withdraw the invitation for ${invite.email}`}
                    >
                      Withdraw
                    </button>
                  </Form>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </SettingsPage>
  );
}
