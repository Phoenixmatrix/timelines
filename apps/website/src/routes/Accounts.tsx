// Site admins: password accounts (CORE-404). Create an account outright, with
// an email nobody verifies, for someone who can't set one up yet or for a demo;
// or give an existing account a new password, which ends its browser sessions
// and, if the admin asks, revokes its access tokens.
// The person signs in with their username or email and that password.

import { UserCircleIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import type { PasswordAccount } from "../../shared/api.ts";
import { SettingsPage } from "../components/SettingsPage.tsx";
import { Card, FormError, TextField } from "../components/ui.tsx";
import { api, attempt, field, load } from "../lib/api.ts";
import { fullDate, timeAgo } from "../lib/format.ts";
import { requireViewer } from "../lib/session.ts";

/** No 0/O or 1/l/I: it gets read out and typed by hand. */
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePassword(length = 24): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
  let out = "";
  // Rejection sampling keeps every character equally likely.
  for (const byte of bytes) {
    if (byte >= 256 - (256 % ALPHABET.length)) continue;
    out += ALPHABET[byte % ALPHABET.length];
    if (out.length === length) return out;
  }
  return out + generatePassword(length - out.length);
}

export async function accountsLoader({ request }: { request: Request }) {
  const viewer = await requireViewer(request);
  if (!viewer.isSiteAdmin) throw redirect("/");
  return load<{ accounts: PasswordAccount[] }>("/admin/accounts", request);
}

type Result = {
  error?: string;
  created?: string;
  reset?: string;
  tokensRevoked?: number;
  intent?: string;
};

export async function accountsAction({ request }: { request: Request }): Promise<Result> {
  const form = await request.formData();
  const intent = field(form, "intent");
  if (intent === "password") {
    const username = field(form, "username");
    const result = await attempt(() =>
      api<{ tokensRevoked: number }>(`/admin/accounts/${encodeURIComponent(username)}/password`, {
        method: "PUT",
        json: {
          password: field(form, "password"),
          revokeTokens: form.get("revokeTokens") === "on",
        },
      }),
    );
    return result && typeof result === "object" && "error" in result
      ? { error: String(result.error), intent: username }
      : { reset: username, tokensRevoked: (result as { tokensRevoked: number }).tokensRevoked };
  }
  const result = await attempt(() =>
    api<{ account: PasswordAccount }>("/admin/accounts", {
      method: "POST",
      json: {
        username: field(form, "username"),
        email: field(form, "email"),
        displayName: field(form, "displayName"),
        password: field(form, "password"),
      },
    }),
  );
  if (result && typeof result === "object" && "error" in result)
    return { error: String(result.error), intent: "create" };
  return { created: (result as { account: PasswordAccount }).account.username };
}

/** A new-password field with a button that fills in a strong one and shows it. */
function PasswordField({ label = "Password" }: { label?: string }) {
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <TextField
        className="min-w-0 flex-1"
        label={label}
        name="password"
        type={shown ? "text" : "password"}
        autoComplete="new-password"
        minLength={12}
        maxLength={128}
        required
        value={value}
        onChange={(event) => setValue(event.target.value)}
        hint="At least 12 characters. Give it to them over a private channel."
      />
      <button
        type="button"
        className="mk-btn mk-btn--ghost mb-[22px]"
        onClick={() => {
          setValue(generatePassword());
          setShown(true);
        }}
      >
        Generate
      </button>
    </div>
  );
}

function SetPassword({ account, result }: { account: PasswordAccount; result?: Result }) {
  const navigation = useNavigation();
  const busy = navigation.formData?.get("username") === account.username;
  const failed = result?.intent === account.username ? result.error : undefined;
  return (
    <details className="w-full" open={Boolean(failed) || undefined}>
      <summary className="cursor-pointer text-body-sm text-ink-muted hover:text-ink">
        {account.hasPassword ? "Set a new password" : "Set a password"}
      </summary>
      <Form method="post" className="mt-3 flex flex-col gap-3">
        <input type="hidden" name="intent" value="password" />
        <input type="hidden" name="username" value={account.username} />
        <PasswordField label={`New password for @${account.username}`} />
        <label className="flex items-center gap-2 text-body-sm">
          <input type="checkbox" name="revokeTokens" />
          Also revoke their access tokens (gm, agents, CI)
        </label>
        <FormError message={failed} />
        <div>
          <button className="mk-btn mk-btn--primary mk-btn--sm" disabled={busy}>
            {busy ? "Saving…" : "Save new password"}
          </button>
        </div>
      </Form>
    </details>
  );
}

export function Accounts() {
  const { accounts } = useLoaderData<typeof accountsLoader>();
  const result = useActionData<Result | undefined>();
  const navigation = useNavigation();
  const createRef = useRef<HTMLFormElement>(null);
  const [createKey, setCreateKey] = useState(0);

  useEffect(() => {
    if (!result?.created) return;
    createRef.current?.reset();
    // Remount the password field: its value is React state, not the form's.
    setCreateKey((key) => key + 1);
  }, [result]);

  const creating = navigation.formData?.get("intent") === "create";
  return (
    <SettingsPage>
      <h1 className="m-0 text-headline">Accounts</h1>
      <p className="mt-1.5 mb-0 max-w-[48ch] text-ink-muted">
        Create an account for someone who can't set one up yet, or for a demo. Nobody verifies the
        email, and no email is sent: they sign in with their username or email and the password you
        give them.
      </p>

      <div className="mt-8 flex flex-col gap-6">
        <Card title="Create an account">
          <Form method="post" ref={createRef} className="mk-card-body" key={createKey}>
            <input type="hidden" name="intent" value="create" />
            <TextField label="Username" name="username" autoComplete="off" required />
            <TextField
              label="Email"
              name="email"
              type="email"
              autoComplete="off"
              hint="Any address, even a made-up one. It's never verified or emailed."
              required
            />
            <TextField label="Name" name="displayName" autoComplete="off" hint="Optional." />
            <PasswordField />
            <FormError message={result?.intent === "create" ? result.error : undefined} />
            {result?.created && (
              <p role="status" className="m-0 text-body-sm text-ink-muted">
                Created @{result.created}. They can sign in now.
              </p>
            )}
            <div className="mk-form-actions">
              <button className="mk-btn mk-btn--primary" disabled={creating}>
                {creating ? "Creating…" : "Create account"}
              </button>
            </div>
          </Form>
        </Card>

        <section aria-labelledby="people-title">
          <h2 id="people-title" className="m-0 mb-3 text-title">
            People who can sign in
          </h2>
          {result?.reset && (
            <p role="status" className="m-0 mb-3 text-body-sm text-ink-muted">
              New password saved for @{result.reset}. Their browser sessions ended
              {result.tokensRevoked
                ? ` and ${result.tokensRevoked} access token${result.tokensRevoked === 1 ? " was" : "s were"} revoked.`
                : "; their access tokens still work."}
            </p>
          )}
          {accounts.length === 0 ? (
            <div className="mk-empty">Nobody has signed in yet.</div>
          ) : (
            <ul className="m-0 list-none divide-y divide-line-soft overflow-hidden rounded-pane bg-pane p-0">
              {accounts.map((account) => (
                <li
                  key={account.username}
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
                >
                  <UserCircleIcon className="size-4 text-ink-faint" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">
                      <bdi>{account.displayName}</bdi>{" "}
                      <span className="font-normal text-ink-faint">@{account.username}</span>
                    </span>
                    <span className="block truncate text-body-sm text-ink-muted">
                      {account.email}
                    </span>
                  </span>
                  {!account.emailVerified && (
                    <span className="mk-chip mk-chip--tag">Unverified email</span>
                  )}
                  {account.hasPassword && <span className="mk-chip mk-chip--tag">Password</span>}
                  <span className="text-body-sm text-ink-faint" title={fullDate(account.createdAt)}>
                    {timeAgo(account.createdAt)}
                  </span>
                  <SetPassword account={account} result={result} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </SettingsPage>
  );
}
