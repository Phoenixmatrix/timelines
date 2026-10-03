// The access gate of a timeline preview (CORE-80). A preview signs people in
// as the seeded personas with no password, so the preview itself is the
// secret: every request must present its access key (PREVIEW_KEY, derived
// from the secret tools/preview generates for each create), in one of three
// ways:
//
//   ?preview_key=<key>   the link Gitmatrix's deployment record carries; it
//                        sets the cookie below and redirects without the key
//   gm_preview cookie    HttpOnly, Secure, SameSite=Lax, this host only
//   x-preview-key header scripts (tools/preview's seeding)
//
// A request with a valid personal access token passes too: tokens are only
// ever minted behind the gate, and gm (which seeds the fixture repositories)
// can't send other headers. Everything else, assets included, gets a 401 page.
// Outside a preview there is no gate.

import { timingSafeEqual } from "node:crypto";
import { workerFirst } from "../shared/worker-first.ts";
import { accessTokenSecret, hashToken } from "./auth.ts";
import { isPreview } from "./preview.ts";
import { db } from "./schema.ts";

export const PREVIEW_KEY_PARAM = "preview_key";
export const PREVIEW_KEY_COOKIE = "gm_preview";
export const PREVIEW_KEY_HEADER = "x-preview-key";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

const DENIED = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Preview</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px;background:#fafafa;color:#222}@media (prefers-color-scheme:dark){body{background:#151515;color:#eee}}</style>
</head><body><p>This preview needs its access link; open it from the deployment in Gitmatrix.</p></body></html>`;

/** Constant-time equality of a presented key with the preview's. */
export function sameKey(presented: string | null | undefined, key: string): boolean {
  if (!presented || !key) return false;
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(key);
  if (a.byteLength !== b.byteLength) {
    // As long as a comparison of the right length, so timing says nothing.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

/** Whether an Authorization header carries a live personal access token. */
export type TokenCheck = (header: string) => Promise<boolean>;

export function liveToken(env: Env): TokenCheck {
  return async (header) => {
    const secret = accessTokenSecret(header);
    if (!secret) return false;
    const row = await db(env.DB)
      .selectFrom("access_tokens")
      .select("id")
      .where("token_hash", "=", await hashToken(secret))
      .where((eb) =>
        eb.or([eb("expires_at", "is", null), eb("expires_at", ">", new Date().toISOString())]),
      )
      .executeTakeFirst();
    return Boolean(row);
  };
}

/**
 * null when the request may go on; otherwise the answer: a redirect that
 * trades a key in the URL for the cookie, or the 401 page. Fails closed: a
 * preview without a PREVIEW_KEY lets nothing through.
 */
export async function previewGate(
  request: Request,
  env: object,
  tokenIsLive: TokenCheck,
): Promise<Response | null> {
  if (!isPreview(env)) return null;
  const key = String(Reflect.get(env, "PREVIEW_KEY") ?? "");
  const url = new URL(request.url);
  const inUrl = url.searchParams.get(PREVIEW_KEY_PARAM);
  if (inUrl !== null && sameKey(inUrl, key) && ["GET", "HEAD"].includes(request.method)) {
    url.searchParams.delete(PREVIEW_KEY_PARAM);
    return new Response(null, {
      status: 302,
      headers: {
        location: `${url.pathname}${url.search}${url.hash}`,
        "set-cookie": `${PREVIEW_KEY_COOKIE}=${key}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }
  if (sameKey(cookie(request, PREVIEW_KEY_COOKIE), key)) return null;
  if (sameKey(request.headers.get(PREVIEW_KEY_HEADER), key)) return null;
  const authorization = request.headers.get("authorization");
  if (key && authorization && (await tokenIsLive(authorization))) return null;
  return new Response(DENIED, {
    status: 401,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

interface Fetcher {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
}

/**
 * The Worker's fetch in a preview: the gate, then the app for the paths it
 * answers (shared/worker-first.ts) and the static assets for the rest.
 */
export async function previewFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  app: Fetcher,
  tokenIsLive: TokenCheck = liveToken(env),
): Promise<Response> {
  const denied = await previewGate(request, env, tokenIsLive);
  if (denied) return denied;
  if (workerFirst(new URL(request.url).pathname)) return app.fetch(request, env, ctx);
  const assets = Reflect.get(env, "ASSETS") as
    | { fetch(request: Request): Promise<Response> }
    | undefined;
  return assets ? assets.fetch(request) : app.fetch(request, env, ctx);
}
