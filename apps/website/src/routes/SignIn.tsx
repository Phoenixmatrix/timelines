import { ArrowRightIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigate,
  useNavigation,
  useSearchParams,
} from "react-router";
import { useEffect, useRef } from "react";
import type { Persona, RepoSummary, SessionResponse, Viewer } from "../../shared/api.ts";
import { AuthFrame, CodeCells, Ledger, Step } from "../components/AuthFrame.tsx";
import { Monogram } from "../components/Monogram.tsx";
import { FormError } from "../components/ui.tsx";
import { api, ApiError, attempt, field, load } from "../lib/api.ts";
import { useViewer } from "../lib/session.ts";

export async function signInLoader({ request }: { request: Request }) {
  // Personas exist only in development; deployed, /personas is a 404.
  const [personas, { repos }] = await Promise.all([
    api<{ personas: Persona[] }>("/personas", { signal: request.signal })
      .then((body) => body.personas)
      .catch(() => [] as Persona[]),
    load<{ repos: RepoSummary[] }>("/repos", request),
  ]);
  return { personas, hasRepos: repos.length > 0 };
}

function safeNext(next: string | null): string {
  return next?.startsWith("/") && !next.startsWith("//") ? next : "/";
}

type SignInResult =
  | { step: "code"; email: string; sentAt: string; error?: string }
  | { step: "password"; identifier: string; error: string }
  | { step: "signed-in"; identifier: string; signedInAt: string; name: string; next: string }
  | { step: "done"; email: string; sentAt: string; signedInAt: string; name: string; next: string }
  | { error: string; email?: string };

/** Better Auth's codes for a wrong or used-up code, in plain words. */
function codeError(error: unknown): string {
  if (!(error instanceof ApiError)) throw error;
  if (error.status === 429) return error.message;
  if (error.code === "TOO_MANY_ATTEMPTS") return "Too many wrong codes. Send a new one.";
  if (error.code === "OTP_EXPIRED") return "That code has expired. Send a new one.";
  if (error.code === "INVALID_OTP") return "That code isn't right. Check the email and try again.";
  return error.message;
}

export async function signInAction({ request }: { request: Request }) {
  const url = new URL(request.url);
  const form = await request.formData();
  const intent = url.searchParams.get("intent") ?? form.get("intent");

  if (intent === "signout") {
    await api("/session", { method: "DELETE" });
    return redirect("/signin");
  }
  if (intent === "seed") {
    return attempt(() => api("/dev/seed", { method: "POST" }));
  }
  if (intent === "send") {
    const email = field(form, "email").trim();
    const sent = await attempt(() =>
      api("/identity/email-otp/send-verification-otp", {
        method: "POST",
        json: { email, type: "sign-in" },
      }),
    );
    if (sent && typeof sent === "object" && "error" in sent)
      return { error: String(sent.error), email } satisfies SignInResult;
    return { step: "code", email, sentAt: new Date().toISOString() } satisfies SignInResult;
  }
  if (intent === "password") {
    const identifier = field(form, "identifier").trim();
    try {
      await api("/identity/sign-in/email", {
        method: "POST",
        json: { email: identifier, password: field(form, "password") },
      });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return {
        step: "password",
        identifier,
        error:
          error.status === 429
            ? error.message
            : "That username or password isn't right. Ask your admin if you've forgotten it.",
      } satisfies SignInResult;
    }
    const { viewer } = await api<SessionResponse>("/session");
    return {
      step: "signed-in",
      identifier,
      signedInAt: new Date().toISOString(),
      name: viewer?.displayName ?? identifier,
      next: safeNext(url.searchParams.get("next")),
    } satisfies SignInResult;
  }
  if (intent === "verify") {
    const email = field(form, "email");
    try {
      await api("/identity/sign-in/email-otp", {
        method: "POST",
        json: { email, otp: field(form, "otp").replace(/\s+/g, "") },
      });
    } catch (error) {
      return {
        step: "code",
        email,
        sentAt: field(form, "sentAt"),
        error: codeError(error),
      } satisfies SignInResult;
    }
    // Settle the last ledger row (who you are now) before moving on.
    const { viewer } = await api<SessionResponse>("/session");
    return {
      step: "done",
      email,
      sentAt: field(form, "sentAt"),
      signedInAt: new Date().toISOString(),
      name: viewer?.displayName ?? email,
      next: safeNext(url.searchParams.get("next")),
    } satisfies SignInResult;
  }
  const result = await attempt(() =>
    api("/session", { method: "POST", json: { accountId: form.get("accountId") } }),
  );
  if ("error" in (result as object)) return result;
  return redirect(safeNext(url.searchParams.get("next")));
}

function EmailLedger() {
  const result = useActionData<SignInResult | undefined>();
  const navigation = useNavigation();
  const [params] = useSearchParams();
  const busy = navigation.state !== "idle" ? navigation.formData?.get("intent") : null;
  const action = `/signin?${params.toString()}`;
  const sent =
    result && "step" in result && (result.step === "code" || result.step === "done")
      ? result
      : null;
  const signedIn = sent?.step === "done" ? sent : null;
  const navigate = useNavigate();
  useEffect(() => {
    if (!signedIn) return;
    const timer = setTimeout(() => void navigate(signedIn.next), 900);
    return () => clearTimeout(timer);
  }, [signedIn, navigate]);

  return (
    <Ledger label="Sign-in steps">
      <Step
        state={sent ? "done" : "active"}
        title="Email"
        value={sent?.email}
        time={sent?.sentAt}
        action={
          <Link to={action} className="text-body-sm text-ink-faint hover:text-ink">
            Change
          </Link>
        }
      >
        <Form method="post" action={action} className="flex flex-col gap-3">
          <input type="hidden" name="intent" value="send" />
          <input
            className="mk-input"
            type="email"
            name="email"
            aria-label="Email"
            placeholder="you@example.com"
            autoComplete="email"
            defaultValue={result && !("step" in result) ? result.email : undefined}
            required
            autoFocus
          />
          <FormError message={result && !("step" in result) ? result.error : undefined} />
          <div>
            <button className="mk-btn mk-btn--primary" disabled={busy === "send"}>
              {busy === "send" ? "Sending…" : "Send code"}
            </button>
          </div>
        </Form>
      </Step>
      <Step
        state={signedIn ? "done" : sent ? "active" : "waiting"}
        title="Code"
        value={signedIn ? "Verified" : undefined}
      >
        {sent && sent.step === "code" && (
          <>
            <Form method="post" action={action} className="flex flex-col gap-3">
              <p className="m-0 max-w-[48ch] text-body-sm text-ink-muted">
                If this address may sign in here, a 6-digit code is on its way. It expires in 10
                minutes.
              </p>
              <input type="hidden" name="email" value={sent.email} />
              <input type="hidden" name="sentAt" value={sent.sentAt} />
              <input type="hidden" name="intent" value="verify" />
              <CodeCells
                key={sent.sentAt + (sent.error ?? "")}
                name="otp"
                invalid={Boolean(sent.error)}
                describedBy={sent.error ? "code-error" : undefined}
              />
              {sent.error && (
                <p id="code-error" role="alert" className="mk-error m-0">
                  {sent.error}
                </p>
              )}
              <div>
                <button className="mk-btn mk-btn--primary" disabled={busy === "verify"}>
                  {busy === "verify" ? "Signing in…" : "Sign in"}
                </button>
              </div>
            </Form>
            <Form method="post" action={action} className="mt-3">
              <input type="hidden" name="intent" value="send" />
              <input type="hidden" name="email" value={sent.email} />
              <button
                className="cursor-pointer border-0 bg-transparent p-0 text-body-sm text-ink-muted hover:text-ink disabled:cursor-default"
                disabled={busy === "send"}
              >
                {busy === "send" ? "Sending…" : "Send a new code"}
              </button>
            </Form>
          </>
        )}
      </Step>
      <Step
        state={signedIn ? "done" : "waiting"}
        title="Signed in"
        value={signedIn ? `as ${signedIn.name}` : undefined}
        time={signedIn?.signedInAt}
        last
      />
    </Ledger>
  );
}

/** A password an admin set (CORE-404), by username or email. */
function PasswordLedger() {
  const result = useActionData<SignInResult | undefined>();
  const navigation = useNavigation();
  const [params] = useSearchParams();
  const busy = navigation.state !== "idle" && navigation.formData?.get("intent") === "password";
  const failed = result && "step" in result && result.step === "password" ? result : null;
  const signedIn = result && "step" in result && result.step === "signed-in" ? result : null;
  const passwordRef = useRef<HTMLInputElement>(null);
  // A wrong password is cleared for the next try; the username stays.
  useEffect(() => {
    if (!failed || !passwordRef.current) return;
    passwordRef.current.value = "";
    passwordRef.current.focus();
  }, [failed]);
  const navigate = useNavigate();
  useEffect(() => {
    if (!signedIn) return;
    const timer = setTimeout(() => void navigate(signedIn.next), 900);
    return () => clearTimeout(timer);
  }, [signedIn, navigate]);

  return (
    <Ledger label="Sign-in steps">
      <Step
        state={signedIn ? "done" : "active"}
        title="Password"
        value={signedIn?.identifier}
        time={signedIn?.signedInAt}
      >
        <Form method="post" action={`/signin?${params.toString()}`} className="flex flex-col gap-3">
          <input type="hidden" name="intent" value="password" />
          <input
            className="mk-input"
            name="identifier"
            aria-label="Username or email"
            placeholder="Username or email"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            defaultValue={failed?.identifier}
            required
            autoFocus
          />
          <input
            className="mk-input"
            type="password"
            name="password"
            ref={passwordRef}
            aria-label="Password"
            placeholder="Password"
            autoComplete="current-password"
            aria-invalid={failed ? true : undefined}
            aria-describedby={failed ? "password-error" : undefined}
            required
          />
          {failed && (
            <p id="password-error" role="alert" className="mk-error m-0">
              {failed.error}
            </p>
          )}
          <div>
            <button className="mk-btn mk-btn--primary" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </div>
        </Form>
      </Step>
      <Step
        state={signedIn ? "done" : "waiting"}
        title="Signed in"
        value={signedIn ? `as ${signedIn.name}` : undefined}
        time={signedIn?.signedInAt}
        last
      />
    </Ledger>
  );
}

/** Switch between an emailed code and a password, keeping where to go next. */
function MethodSwitch({ password }: { password: boolean }) {
  const [params] = useSearchParams();
  const next = new URLSearchParams(params);
  if (password) next.delete("with");
  else next.set("with", "password");
  return (
    <p className="mt-6 mb-0 text-body-sm">
      <Link to={`/signin?${next.toString()}`} className="text-ink-muted hover:text-ink">
        {password ? "Email me a code instead" : "Sign in with a password"}
      </Link>
    </p>
  );
}

/** Already signed in: the whole ledger settled, with where to go next. */
function SignedInLedger({ viewer }: { viewer: Viewer }) {
  const [params] = useSearchParams();
  const switchHref = `/signin?${new URLSearchParams({ ...Object.fromEntries(params), switch: "1" })}`;
  return (
    <>
      <Ledger label="Sign-in steps">
        <Step state="done" title="Email" value={viewer.email ?? "Development persona"} />
        <Step state="done" title="Code" value={viewer.email ? "Verified" : "Not needed in dev"} />
        <Step state="done" title="Signed in" value={`as ${viewer.displayName}`} last />
      </Ledger>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Link to={safeNext(params.get("next"))} className="mk-btn mk-btn--primary no-underline">
          Continue to Timelines
        </Link>
        <Form method="post" action="/signin?intent=signout">
          <button className="mk-btn mk-btn--ghost">Sign out</button>
        </Form>
        <Link to={switchHref} className="mk-btn mk-btn--ghost no-underline">
          Use another account
        </Link>
      </div>
    </>
  );
}

function Personas({ personas, hasRepos }: { personas: Persona[]; hasRepos: boolean }) {
  const viewer = useViewer();
  const navigation = useNavigation();
  const [params] = useSearchParams();
  const pendingId = navigation.formData?.get("accountId");
  const seeding = navigation.formData?.get("intent") === "seed";
  return (
    <section aria-labelledby="personas-title" className="mt-14 border-t border-line-soft pt-6">
      <h2 id="personas-title" className="m-0 text-body-sm font-semibold">
        Development personas
      </h2>
      <p className="mt-1 mb-0 max-w-[48ch] text-body-sm text-ink-faint">
        Only on the dev server: sign in as anyone to watch the permission rules at work. Email codes
        print in the dev server's log.
      </p>
      {!hasRepos && (
        <Form method="post" className="mk-strip mt-4">
          <span className="mk-strip-dot" />
          <span className="mk-strip-text">
            No repositories yet. Load four samples to try each persona.
          </span>
          <input type="hidden" name="intent" value="seed" />
          <button className="mk-btn mk-btn--primary mk-btn--sm" disabled={seeding}>
            {seeding ? "Importing…" : "Load samples"}
          </button>
        </Form>
      )}
      <ul className="m-0 mt-3 list-none divide-y divide-line-soft p-0">
        {personas.map((persona) => {
          const current = viewer?.id === persona.id;
          return (
            <li key={persona.id}>
              <Form method="post" action={`/signin?${params.toString()}`}>
                <input type="hidden" name="accountId" value={persona.id} />
                <button
                  className="group flex w-full cursor-pointer items-center gap-3 rounded-plate border-0 bg-transparent px-2 py-2.5 text-left text-ink hover:bg-pane disabled:cursor-default"
                  aria-current={current ? "true" : undefined}
                  disabled={pendingId === persona.id || current}
                  title={persona.bio}
                >
                  <Monogram name={persona.displayName} src={persona.avatarUrl} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-body-sm font-semibold">
                      <bdi>{persona.displayName}</bdi>
                      {persona.isSiteAdmin && (
                        <ShieldCheckIcon
                          className="size-4 text-ink-faint"
                          aria-label="Site admin"
                        />
                      )}
                    </span>
                    <span className="block truncate text-micro text-ink-faint">{persona.bio}</span>
                  </span>
                  <span className="shrink-0 text-body-sm text-ink-faint group-hover:text-ink">
                    {current ? (
                      "Signed in"
                    ) : (
                      <ArrowRightIcon
                        weight="bold"
                        aria-label={`Continue as ${persona.displayName}`}
                      />
                    )}
                  </span>
                </button>
              </Form>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function SignIn() {
  const { personas, hasRepos } = useLoaderData<typeof signInLoader>();
  const viewer = useViewer();
  const [params] = useSearchParams();
  const actionData = useActionData<SignInResult | undefined>();
  const password = params.get("with") === "password";

  return (
    <AuthFrame
      footer={
        viewer ? undefined : (
          <Link to="/" className="text-ink-muted hover:text-ink">
            Browse public repositories without signing in
          </Link>
        )
      }
    >
      <h1 className="m-0 text-headline">Sign in</h1>
      <p className="mt-2 mb-0 max-w-[48ch] text-ink-muted">
        {password
          ? "Timelines is invite only. Use the username or email and the password your admin gave you."
          : "Timelines is invite only. We'll email you a one-time code; there's no password to remember."}
      </p>
      {viewer && !params.has("switch") && !actionData ? (
        <SignedInLedger viewer={viewer} />
      ) : (
        <>
          {password ? <PasswordLedger /> : <EmailLedger />}
          <MethodSwitch password={password} />
        </>
      )}
      {personas.length > 0 && <Personas personas={personas} hasRepos={hasRepos} />}
    </AuthFrame>
  );
}
