// Access protects every preview request, including assets and persona sign-in.
// Verify its signed assertion at the origin too; app PATs are not preview access.
import { createRemoteJWKSet, jwtVerify, type RemoteJWKSet } from "jose";
import { workerFirst } from "../shared/worker-first.ts";
import { isPreview } from "./preview.ts";

// Only public signing keys are cached, never assertions or request identity.
const keysets = new Map<string, RemoteJWKSet>();

const DENIED = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Preview</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px;background:#fafafa;color:#222}@media (prefers-color-scheme:dark){body{background:#151515;color:#eee}}</style>
</head><body><p>This preview requires Cloudflare Access authentication.</p></body></html>`;

/** null permits the request. Missing configuration or invalid assertions fail closed. */
export async function previewGate(request: Request, env: object): Promise<Response | null> {
  if (!isPreview(env)) return null;
  const issuer: unknown = Reflect.get(env, "PREVIEW_ACCESS_ISSUER");
  const audience: unknown = Reflect.get(env, "PREVIEW_ACCESS_AUD");
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (
    typeof issuer === "string" &&
    /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) &&
    typeof audience === "string" &&
    audience.trim() !== "" &&
    audience === audience.trim() &&
    assertion
  ) {
    try {
      let keys = keysets.get(issuer);
      if (!keys) {
        keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
        keysets.set(issuer, keys);
      }
      await jwtVerify(assertion, keys, {
        algorithms: ["RS256"],
        issuer,
        audience,
        requiredClaims: ["exp"],
      });
      // Human and service-token assertions have different identity claims.
      return null;
    } catch {
      // Signature, claims, and signing-key retrieval failures all deny access.
    }
  }
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
): Promise<Response> {
  const denied = await previewGate(request, env);
  if (denied) return denied;
  if (workerFirst(new URL(request.url).pathname)) return app.fetch(request, env, ctx);
  const assets = Reflect.get(env, "ASSETS") as
    | { fetch(request: Request): Promise<Response> }
    | undefined;
  return assets ? assets.fetch(request) : app.fetch(request, env, ctx);
}
