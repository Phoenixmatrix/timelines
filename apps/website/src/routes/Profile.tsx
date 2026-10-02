// Your display name and username.

import { Form, Link, useActionData, useNavigation, useRevalidator } from "react-router";
import { useEffect } from "react";
import type { SessionResponse } from "../../shared/api.ts";
import { Page } from "../components/AppShell.tsx";
import { Card, FormError, TextField, link } from "../components/ui.tsx";
import { api, attempt, field } from "../lib/api.ts";
import { requireViewer, useViewer } from "../lib/session.ts";

export async function profileLoader({ request }: { request: Request }) {
  await requireViewer(request);
  return null;
}

export async function profileAction({ request }: { request: Request }) {
  const form = await request.formData();
  const result = await attempt(() =>
    api<SessionResponse>("/account", {
      method: "PATCH",
      json: { displayName: field(form, "displayName"), slug: field(form, "slug") },
    }),
  );
  return result && typeof result === "object" && "error" in result ? result : { saved: true };
}

export function Profile() {
  const viewer = useViewer();
  const result = useActionData<{ error?: string; saved?: boolean } | undefined>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();

  // The shell (menu, monogram) reads the viewer from the root loader.
  useEffect(() => {
    if (result?.saved) void revalidator.revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per save
  }, [result]);

  if (!viewer) return null;
  return (
    <Page>
      <h1 className="m-0 text-headline">Profile</h1>
      <p className="mt-1.5 mb-0 max-w-[48ch] text-ink-muted">
        How you appear across Gitmatrix: on repositories, issues, commits you push and{" "}
        <Link to={`/${viewer.slug}`} className={link}>
          your profile page
        </Link>
        .
      </p>

      <div className="mt-8 flex flex-col gap-6">
        <Card title="Name" className="max-w-xl">
          <Form method="post" className="mk-card-body" key={viewer.slug}>
            <TextField
              label="Display name"
              name="displayName"
              defaultValue={viewer.displayName}
              maxLength={80}
              required
              autoComplete="name"
            />
            <TextField
              label="Username"
              name="slug"
              defaultValue={viewer.slug}
              maxLength={39}
              required
              autoCapitalize="none"
              spellCheck={false}
              hint={
                <span className="block max-w-[48ch]">
                  Lowercase letters, digits and hyphens. Your repositories live under it, so
                  changing it changes their URLs: update the remote in existing clones.
                </span>
              }
            />
            <FormError message={result?.error} />
            {result?.saved && navigation.state === "idle" && (
              <p role="status" className="m-0 text-body-sm text-ink-muted">
                Saved.
              </p>
            )}
            <div>
              <button className="mk-btn mk-btn--primary" disabled={navigation.state !== "idle"}>
                Save
              </button>
            </div>
          </Form>
        </Card>
      </div>
    </Page>
  );
}
