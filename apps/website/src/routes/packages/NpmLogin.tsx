import { CheckCircleIcon } from "@phosphor-icons/react";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import type { NpmLoginRequest } from "../../../shared/packages.ts";
import { Page } from "../../components/AppShell.tsx";
import { FormError, link } from "../../components/ui.tsx";
import { api, attempt, load } from "../../lib/api.ts";
import { useViewer } from "../../lib/session.ts";

export async function npmLoginLoader({ request, params }: LoaderFunctionArgs) {
  return load<NpmLoginRequest>(`/packages/-/npm-login/${params.id}`, request);
}

export async function npmLoginAction({ params }: ActionFunctionArgs) {
  const result = await attempt(async () => {
    await api(`/packages/-/npm-login/${params.id}/approve`, { method: "POST" });
    return { ok: true as const };
  });
  if ("error" in result) return result;
  return redirect(`/cli-auth/npm/${params.id}?done=1`);
}

/** `npm login --auth-type=web` lands here to be approved by a signed-in person. */
export function NpmLogin() {
  const login = useLoaderData<typeof npmLoginLoader>();
  const error = useActionData<typeof npmLoginAction>();
  const viewer = useViewer();
  const navigation = useNavigation();
  const where = login.hostname ? `on ${login.hostname}` : "on your machine";

  return (
    <Page>
      <section className="mk-card mx-auto mt-10 max-w-lg">
        {login.status === "done" ? (
          <>
            <h1 className="mk-card-title flex items-center gap-2 text-title-lg">
              <CheckCircleIcon weight="fill" className="text-online" aria-hidden />
              npm is signed in
            </h1>
            <p className="mk-card-desc">
              Go back to your terminal. The token npm received is listed with your{" "}
              <Link to="/settings/tokens" className={link}>
                access tokens
              </Link>
              , where you can revoke it.
            </p>
          </>
        ) : login.status === "expired" ? (
          <>
            <h1 className="mk-card-title text-title-lg">This login link expired</h1>
            <p className="mk-card-desc">Run npm login again for a fresh one.</p>
          </>
        ) : !viewer ? (
          <>
            <h1 className="mk-card-title text-title-lg">Sign in to approve npm</h1>
            <p className="mk-card-desc">
              npm {where} is waiting to sign in to {login.registry}.
            </p>
            <Link
              to={`/signin?next=${encodeURIComponent(`/cli-auth/npm/${login.publicId}`)}`}
              className="mk-btn mk-btn--primary mt-5 no-underline"
            >
              Sign in
            </Link>
          </>
        ) : (
          <>
            <h1 className="mk-card-title text-title-lg">Sign npm in as {viewer.slug}?</h1>
            <p className="mk-card-desc">
              npm {where} gets a write token for the {login.registry} registry and everything else
              you can publish to. Only approve a login you just started.
            </p>
            <Form method="post" className="mt-5 flex gap-2">
              <button
                type="submit"
                className="mk-btn mk-btn--primary"
                disabled={navigation.state !== "idle"}
              >
                Approve
              </button>
              <Link to="/" className="mk-btn mk-btn--ghost no-underline">
                Not me
              </Link>
            </Form>
            <div className="mt-3">
              <FormError message={error && "error" in error ? error.error : null} />
            </div>
          </>
        )}
      </section>
    </Page>
  );
}
