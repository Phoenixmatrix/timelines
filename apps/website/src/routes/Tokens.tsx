import { KeyIcon } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { Form, useActionData, useFetcher, useLoaderData, useNavigation } from "react-router";
import type { AccessToken, CreatedAccessToken } from "../../shared/api.ts";
import { Page } from "../components/AppShell.tsx";
import { Segmented } from "../components/Choice.tsx";
import { Card, ConfirmDialog, CopyField, FormError, TextField } from "../components/ui.tsx";
import { api, attempt, field, load } from "../lib/api.ts";
import { fullDate, timeAgo } from "../lib/format.ts";
import { requireViewer, useViewer } from "../lib/session.ts";

export async function tokensLoader({ request }: { request: Request }) {
  await requireViewer(request);
  return load<{ tokens: AccessToken[] }>("/tokens", request);
}

export async function tokensAction({ request }: { request: Request }) {
  const form = await request.formData();
  if (form.get("intent") === "revoke") {
    return attempt(() => api(`/tokens/${field(form, "id")}`, { method: "DELETE" }));
  }
  return attempt(() =>
    api<CreatedAccessToken>("/tokens", {
      method: "POST",
      json: { name: form.get("name"), scope: form.get("scope") },
    }),
  );
}

export function Tokens() {
  const { tokens } = useLoaderData<typeof tokensLoader>();
  const viewer = useViewer();
  const created = useActionData<CreatedAccessToken | { error: string } | undefined>();
  const navigation = useNavigation();
  const formRef = useRef<HTMLFormElement>(null);
  const fresh = created && "secret" in created ? created : null;

  useEffect(() => {
    if (fresh) formRef.current?.reset();
  }, [fresh]);

  return (
    <Page>
      <h1 className="m-0 text-headline">Access tokens</h1>
      <p className="mt-1.5 mb-0 max-w-[52ch] text-ink-muted">
        Git asks for a username and password over HTTPS. Use your username and a token as the
        password. Tokens act as you, limited to read or write.
      </p>

      <div className="mt-8 flex flex-col gap-6">
        <Card title="Create a token">
          <Form method="post" ref={formRef} className="mk-card-body">
            <TextField
              label="Name"
              name="name"
              required
              maxLength={80}
              placeholder="Laptop"
              autoComplete="off"
              hint="So you can tell your tokens apart later."
            />
            <div className="mk-field">
              <span className="mk-label">Access</span>
              <Segmented
                name="scope"
                label="Access"
                defaultValue="write"
                options={[
                  { value: "write", label: "Clone and push" },
                  { value: "read", label: "Clone only" },
                ]}
              />
            </div>
            <div className="flex items-center justify-end gap-3">
              <FormError message={created && "error" in created ? created.error : null} />
              <button
                className="mk-btn mk-btn--primary"
                disabled={navigation.state === "submitting"}
              >
                Create token
              </button>
            </div>
          </Form>
        </Card>

        {fresh && viewer && (
          <section className="mk-card mk-enter-up flex flex-col gap-4 bg-signal-wash">
            <div>
              <h2 className="mk-card-title">Copy your new token now</h2>
              <p className="mk-card-desc">You won't be able to see “{fresh.name}” again.</p>
            </div>
            <CopyField value={fresh.secret} label="Token" />
            <div className="mk-field">
              <span className="mk-label">Or skip the password prompt</span>
              <CopyField
                value={`git config --global credential.${window.location.origin}.username ${viewer.slug}`}
                label="Command"
              />
              <span className="mk-hint">Then paste the token when git asks for a password.</span>
            </div>
          </section>
        )}

        <Card title="Your tokens">
          {tokens.length === 0 ? (
            <div className="mk-empty mt-5">
              No tokens yet.
              <br />
              <span className="text-body-sm text-ink-faint">
                Create one above to clone over HTTPS.
              </span>
            </div>
          ) : (
            <ul className="m-0 mt-4 list-none divide-y divide-line-soft p-0">
              {tokens.map((token) => (
                <TokenRow key={token.id} token={token} />
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Page>
  );
}

function TokenRow({ token }: { token: AccessToken }) {
  const revoke = useFetcher();
  return (
    <li className="flex items-center gap-3 py-3">
      <KeyIcon className="size-5 shrink-0 text-ink-faint" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{token.name}</span>
          <span className="mk-chip mk-chip--tag">
            {token.scope === "write" ? "Clone and push" : "Clone only"}
          </span>
          <span className="mk-mono text-mono text-ink-faint">gmx_…{token.lastFour}</span>
        </div>
        <div className="text-body-sm text-ink-faint">
          <span title={fullDate(token.createdAt)}>Created {timeAgo(token.createdAt)}</span>
          {" · "}
          {token.lastUsedAt ? (
            <span title={fullDate(token.lastUsedAt)}>Last used {timeAgo(token.lastUsedAt)}</span>
          ) : (
            "Never used"
          )}
        </div>
      </div>
      <ConfirmDialog
        trigger={<button className="mk-btn mk-btn--danger-ghost mk-btn--sm">Revoke</button>}
        title={`Revoke “${token.name}”?`}
        description="Anything using it stops working at once: clones, pushes and scripts."
        confirmLabel="Revoke token"
        busy={revoke.state !== "idle"}
        onConfirm={() => revoke.submit({ intent: "revoke", id: token.id }, { method: "post" })}
      />
    </li>
  );
}
