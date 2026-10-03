// The assistant calls Gitmatrix's own JSON API, in-process, with its agent
// token: the same routes, permission checks and attribution as `gm` or the web.

export interface ApiResult {
  status: number;
  ok: boolean;
  body: unknown;
}

type Fetch = (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;

/** API paths the assistant may call: the JSON API, minus what only a person may do. */
export function allowedPath(path: string): string | null {
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.startsWith("/api/")) path = path.slice(4);
  if (/[\s#]|\.\.|\/\//.test(path)) return "Paths are plain /api routes, like /repos/owner/name.";
  // Credentials and identity are a person's to manage (the API refuses agents
  // anyway); dev endpoints and the CI runner protocol aren't for conversation.
  if (
    /^\/(tokens|agents|ssh-keys|invites|auth|dev|ci\/runner|identity|assistant)(\/|$|\?)/.test(path)
  )
    return "That part of the API is for people and machines, not the assistant.";
  return null;
}

export function apiClient(
  fetch: Fetch,
  env: Env,
  waitUntil: (work: Promise<unknown>) => void,
  token: () => Promise<string>,
) {
  const origin = (env as { PUBLIC_URL?: string }).PUBLIC_URL || "https://gitmatrix.internal";
  const ctx = {
    waitUntil,
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  return async (method: string, path: string, body?: unknown): Promise<ApiResult> => {
    const refused = allowedPath(path);
    if (refused) return { status: 403, ok: false, body: { error: refused } };
    const clean = path.replace(/^\/?(api\/)?/, "/");
    const response = await fetch(
      new Request(`${origin}/api${clean}`, {
        method,
        headers: {
          authorization: `Bearer ${await token()}`,
          "X-Gitmatrix-Source": "assistant",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      ctx,
    );
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Logs and raw files come back as text.
    }
    return { status: response.status, ok: response.ok, body: parsed };
  };
}

export type CallApi = ReturnType<typeof apiClient>;
