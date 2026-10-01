import { FingerprintIcon } from "@phosphor-icons/react";
import { useEffect, useId, useRef } from "react";
import { Form, Link, useActionData, useFetcher, useLoaderData, useNavigation } from "react-router";
import type { SshKey } from "../../shared/api.ts";
import { Page } from "../components/AppShell.tsx";
import { Segmented } from "../components/Choice.tsx";
import { Card, ConfirmDialog, CopyField, FormError, TextField, link } from "../components/ui.tsx";
import { api, attempt, field, load } from "../lib/api.ts";
import { fullDate, timeAgo } from "../lib/format.ts";
import { requireViewer } from "../lib/session.ts";

export async function sshKeysLoader({ request }: { request: Request }) {
  await requireViewer(request);
  return load<{ keys: SshKey[] }>("/ssh-keys", request);
}

export async function sshKeysAction({ request }: { request: Request }) {
  const form = await request.formData();
  if (form.get("intent") === "remove") {
    return attempt(() => api(`/ssh-keys/${field(form, "id")}`, { method: "DELETE" }));
  }
  return attempt(() =>
    api<SshKey>("/ssh-keys", {
      method: "POST",
      json: { title: form.get("title"), key: form.get("key"), scope: form.get("scope") },
    }),
  );
}

export function SshKeys() {
  const { keys } = useLoaderData<typeof sshKeysLoader>();
  const result = useActionData<SshKey | { error: string } | undefined>();
  const navigation = useNavigation();
  const formRef = useRef<HTMLFormElement>(null);
  const keyId = useId();
  const added = result && "fingerprint" in result ? result : null;
  const origin = window.location.origin;

  useEffect(() => {
    if (added) formRef.current?.reset();
  }, [added]);

  return (
    <Page>
      <h1 className="m-0 text-headline">SSH keys</h1>
      <p className="mt-1.5 mb-0 max-w-[48ch] text-ink-muted">
        Sign in to <code className="mk-mono">gm</code> with the SSH keys you already use, from your
        SSH agent, 1Password or <code className="mk-mono">~/.ssh</code>. Gitmatrix speaks HTTPS, so
        instead of an SSH connection gm signs a one-time challenge with your key and gets a session
        that lasts an hour. For plain git and scripts, there are{" "}
        <Link to="/settings/tokens" className={link}>
          access tokens
        </Link>
        .
      </p>

      <div className="mt-8 flex flex-col gap-6">
        <Card title="Use a key with gm">
          <div className="mk-card-body">
            <CopyField value="gm auth ssh-key add" label="Register a key from your agent" />
            <CopyField value="gm auth login --ssh" label="Then sign in with it" />
            <div className="mk-field">
              <CopyField
                value={`git config --global credential.${origin}.helper '!gm auth git-credential'`}
                label="Optional: let plain git use the same sign-in"
              />
            </div>
          </div>
        </Card>

        <Card
          title="Add a key"
          description="Or paste a public key here, e.g. ~/.ssh/id_ed25519.pub."
        >
          <Form method="post" ref={formRef} className="mk-card-body">
            <div className="mk-field">
              <label htmlFor={keyId} className="mk-label">
                Public key
              </label>
              <textarea
                id={keyId}
                name="key"
                required
                rows={4}
                spellCheck={false}
                className="mk-input mk-input--code text-mono break-all"
                placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… you@laptop"
                aria-describedby={`${keyId}-hint`}
              />
              <span id={`${keyId}-hint`} className="mk-hint">
                Ed25519, ECDSA (P-256, P-384) or RSA (2048 bits or more).
              </span>
            </div>
            <TextField
              label="Title"
              name="title"
              maxLength={80}
              placeholder="Laptop"
              autoComplete="off"
              hint="Defaults to the key's comment."
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
              <FormError message={result && "error" in result ? result.error : null} />
              <button
                className="mk-btn mk-btn--primary"
                disabled={navigation.state === "submitting"}
              >
                Add key
              </button>
            </div>
          </Form>
        </Card>

        {added && (
          <section className="mk-card mk-enter-up flex flex-col gap-3 bg-signal-wash">
            <div>
              <h2 className="mk-card-title">Added “{added.title}”</h2>
              <p className="mk-card-desc mk-mono break-all">{added.fingerprint}</p>
            </div>
            <CopyField value="gm auth login --ssh" label="Sign in with it" />
          </section>
        )}

        <Card title="Your keys">
          {keys.length === 0 ? (
            <div className="mk-empty mt-5">
              No SSH keys yet.
              <br />
              <span className="text-body-sm text-ink-faint">
                Add one above, or run <code className="mk-mono">gm auth ssh-key add</code>.
              </span>
            </div>
          ) : (
            <ul className="m-0 mt-4 list-none divide-y divide-line-soft p-0">
              {keys.map((key) => (
                <KeyRow key={key.id} sshKey={key} />
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Page>
  );
}

function KeyRow({ sshKey }: { sshKey: SshKey }) {
  const remove = useFetcher();
  return (
    <li className="flex items-center gap-3 py-3">
      <FingerprintIcon className="size-5 shrink-0 text-ink-faint" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{sshKey.title}</span>
          <span className="mk-chip mk-chip--tag whitespace-nowrap">
            {sshKey.scope === "write" ? "Clone and push" : "Clone only"}
          </span>
          <span className="mk-chip mk-chip--tag whitespace-nowrap">
            {sshKey.type.replace(/^ssh-/, "")}
          </span>
        </div>
        <div className="mk-mono truncate text-mono text-ink-faint">{sshKey.fingerprint}</div>
        <div className="text-body-sm text-ink-faint">
          <span title={fullDate(sshKey.createdAt)}>Added {timeAgo(sshKey.createdAt)}</span>
          {" · "}
          {sshKey.lastUsedAt ? (
            <span title={fullDate(sshKey.lastUsedAt)}>Last used {timeAgo(sshKey.lastUsedAt)}</span>
          ) : (
            "Never used"
          )}
        </div>
      </div>
      <ConfirmDialog
        trigger={<button className="mk-btn mk-btn--danger-ghost mk-btn--sm">Remove</button>}
        title={`Remove “${sshKey.title}”?`}
        description="gm sessions signed in with this key end at once."
        confirmLabel="Remove key"
        busy={remove.state !== "idle"}
        onConfirm={() => remove.submit({ intent: "remove", id: sshKey.id }, { method: "post" })}
      />
    </li>
  );
}
