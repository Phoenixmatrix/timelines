import { isRouteErrorResponse, Link, useRouteError } from "react-router";
import { useViewer } from "../lib/session.ts";

export function ErrorPage() {
  const error = useRouteError();
  const viewer = useViewer();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const message = isRouteErrorResponse(error)
    ? ((error.data as { message?: string } | undefined)?.message ?? error.statusText)
    : null;

  const title =
    status === 404
      ? "Nothing here"
      : status === 403
        ? "You don't have access"
        : status === 401
          ? "Sign in to see this"
          : "Something went wrong";
  const hint =
    status === 404 && !viewer
      ? "It may be private. Choose a persona that can see it."
      : status === 404
        ? `It doesn't exist, or ${viewer?.displayName ?? "you"} can't see it.`
        : status >= 500
          ? "Try again in a moment."
          : null;

  if (status >= 500 && !isRouteErrorResponse(error)) console.error(error);

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-16 sm:px-8">
      <p className="m-0 mk-mono text-mono text-ink-faint">{status}</p>
      <h1 className="mt-1 mb-0 text-headline">{title}</h1>
      {message && <p className="mt-2 mb-0 text-ink-muted">{message}</p>}
      {hint && <p className="mt-1 mb-0 text-ink-muted">{hint}</p>}
      <div className="mt-6 flex gap-2">
        <Link to="/" className="mk-btn no-underline">
          Go home
        </Link>
        <Link to="/signin" className="mk-btn mk-btn--ghost no-underline">
          Switch persona
        </Link>
      </div>
    </div>
  );
}
