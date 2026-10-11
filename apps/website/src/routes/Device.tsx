// Approving `gm auth login`: the CLI shows a code and this page; whoever is
// signed in here approves (or denies) signing gm in as themselves.

import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  type LoaderFunctionArgs,
} from "react-router";
import { AuthFrame, Ledger, Step } from "../components/AuthFrame.tsx";
import { FormError } from "../components/ui.tsx";
import { api, ApiError, field } from "../lib/api.ts";
import { requireViewer, useViewer } from "../lib/session.ts";

interface DeviceCode {
  user_code: string;
  status: "pending" | "approved" | "denied";
}

const clean = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

export async function deviceLoader({ request }: LoaderFunctionArgs) {
  await requireViewer(request);
  const code = clean(new URL(request.url).searchParams.get("user_code") ?? "");
  if (!code) return { code: "", device: null, error: null };
  try {
    const device = await api<DeviceCode>(`/identity/device?user_code=${encodeURIComponent(code)}`, {
      signal: request.signal,
    });
    return { code, device, error: null };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return {
      code,
      device: null,
      error:
        error.status === 429
          ? error.message
          : "That code isn't valid or has expired. Run `gm auth login` again for a new one.",
    };
  }
}

export async function deviceAction({ request }: { request: Request }) {
  const form = await request.formData();
  const userCode = field(form, "userCode");
  const approve = field(form, "intent") === "approve";
  try {
    await api(`/identity/device/${approve ? "approve" : "deny"}`, {
      method: "POST",
      json: { userCode },
    });
    return { done: approve ? "approved" : "denied" } as const;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    // Development personas have no Better Auth session to approve with.
    return {
      error:
        error.status === 401
          ? "Approving gm needs an email sign-in; development personas can't approve devices."
          : error.message,
    };
  }
}

export function Device() {
  const { code, device, error } = useLoaderData<typeof deviceLoader>();
  const result = useActionData<{ done?: "approved" | "denied"; error?: string } | undefined>();
  const viewer = useViewer();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" ? navigation.formData?.get("intent") : null;
  const done = result?.done;

  return (
    <AuthFrame
      footer={
        <Link to="/" className="text-ink-muted hover:text-ink">
          Back to Timelines
        </Link>
      }
    >
      <h1 className="m-0 text-headline">Sign in to gm</h1>
      <p className="mt-2 mb-0 max-w-[48ch] text-ink-muted">
        Approve the sign-in you started with{" "}
        <span className="font-mono text-ink">gm auth login</span>. gm gets a token that can do what
        you can; revoke it any time under Access tokens.
      </p>
      <Ledger label="Device sign-in steps">
        <Step
          state={device ? "done" : "active"}
          title="Code from your terminal"
          value={device ? <span className="font-mono">{device.user_code}</span> : undefined}
          action={
            !done && device ? (
              <Link to="/device" className="text-body-sm text-ink-faint hover:text-ink">
                Change
              </Link>
            ) : undefined
          }
        >
          <Form method="get" className="flex flex-col gap-3">
            <input
              className="mk-input mk-input--code text-title tracking-[0.2em] uppercase"
              name="user_code"
              aria-label="Code"
              placeholder="ABCD1234"
              defaultValue={code}
              // A one-time code, not an account field: browsers and password
              // managers otherwise fill the only text box with your email.
              autoComplete="one-time-code"
              data-1p-ignore=""
              data-bwignore=""
              data-lpignore="true"
              data-form-type="other"
              maxLength={12}
              autoCapitalize="characters"
              spellCheck={false}
              required
              autoFocus
              aria-invalid={error ? "true" : undefined}
            />
            <FormError message={error ?? undefined} />
            <div>
              <button className="mk-btn mk-btn--primary" disabled={navigation.state !== "idle"}>
                Continue
              </button>
            </div>
          </Form>
        </Step>
        <Step
          state={done ? "done" : device ? "active" : "waiting"}
          title={done === "denied" ? "Denied" : "Approve"}
          value={
            done
              ? done === "approved"
                ? `as ${viewer?.displayName ?? "you"}`
                : "gm was not signed in"
              : undefined
          }
        >
          {device && (
            <Form method="post" className="flex flex-col gap-3">
              <p className="m-0 max-w-[48ch] text-body-sm text-ink-muted">
                Sign gm in as <span className="text-ink">{viewer?.displayName ?? "you"}</span>? Only
                approve if your terminal shows{" "}
                <span className="font-mono text-ink">{device.user_code}</span>.
              </p>
              <input type="hidden" name="userCode" value={device.user_code} />
              <FormError message={result?.error} />
              {device.status !== "pending" ? (
                <p className="m-0 text-body-sm text-ink-muted">
                  This code was already {device.status}. Run{" "}
                  <span className="font-mono">gm auth login</span> again for a new one.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <button
                    className="mk-btn mk-btn--primary"
                    name="intent"
                    value="approve"
                    disabled={busy !== null}
                  >
                    {busy === "approve" ? "Approving…" : "Approve"}
                  </button>
                  <button
                    className="mk-btn mk-btn--ghost"
                    name="intent"
                    value="deny"
                    disabled={busy !== null}
                  >
                    Deny
                  </button>
                </div>
              )}
            </Form>
          )}
        </Step>
        <Step state={done === "approved" ? "active" : "waiting"} title="gm is signed in" last>
          {done === "approved" && (
            <p className="m-0 max-w-[48ch] text-body-sm text-ink-muted">
              Go back to your terminal; gm picks this up within a few seconds. You can close this
              page.
            </p>
          )}
        </Step>
      </Ledger>
    </AuthFrame>
  );
}
