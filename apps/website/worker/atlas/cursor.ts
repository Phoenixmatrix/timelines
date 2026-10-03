// Atlas continuation cursors (CORE-160): opaque, HMAC-signed, and bound to
// what they continue.
//
// A cursor is `<payload>.<mac>`, both base64url. The payload holds only what
// the next page needs: the pinned snapshot, the keyset position, how many
// records were loaded and the total counted on the first page, and when the
// cursor was issued. Its expiry isn't stored: the route works it out on every
// page with retention's `cursorExpiresAt(issuedAt, snapshot.expiresAt)`
// (worker/atlas/retention.ts) against the snapshot as it is *now*, so a
// cursor issued while its snapshot was current stops with that snapshot's
// later expiry too. The MAC covers the payload *and* a binding the server
// rebuilds from each request (route, scope, filters, principal), so a cursor
// presented under another route, scope, filter or user fails verification
// without the payload ever having to name them. Nothing in a cursor is trusted
// until its MAC checks out, and the route authorizes the repository before
// looking at it.
//
// The key is derived (HKDF, "atlas-cursor/v1") from the deployment's
// BETTER_AUTH_SECRET, the session-signing secret, so cursors need no secret of
// their own and never verify across deployments.

import { readSecret } from "../../registry/core/secrets.ts";

/** Payload format; v1 cursors (which stored their expiry) no longer verify. */
const VERSION = 2;

export interface CursorState<K> {
  /** Snapshot id the traversal is pinned to. */
  snapshot: string;
  /** Keyset position: the last record returned. */
  after: K;
  /** Records returned so far. */
  loaded: number;
  /** Total counted on the first page (the snapshot is immutable, so it holds). */
  total: number | null;
  /** When the first page issued it, ms since the epoch: see retention's cursorExpiresAt. */
  issuedAt: number;
}

/** What a cursor is bound to: rebuilt from each request, never read from the cursor. */
export interface CursorBinding {
  route: string;
  scope: string;
  /** The request's filters (entity id, direction, kind, query…). */
  filters: Record<string, string | null>;
  /** "user:<id>", "user:<id>/agent:<id>" or "anonymous". */
  principal: string;
}

export type CursorResult<K> = { ok: true; state: CursorState<K> } | { ok: false };

const encoder = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function cursorKey(secret: string): Promise<CryptoKey> {
  const cached = keys.get(secret);
  if (cached) return cached;
  const key = (async () => {
    const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
      "deriveKey",
    ]);
    return crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: encoder.encode("gitmatrix"),
        info: encoder.encode("atlas-cursor/v1"),
      },
      base,
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign", "verify"],
    );
  })();
  keys.set(secret, key);
  key.catch(() => keys.delete(secret));
  return key;
}

function toBase64Url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Canonical bytes the MAC covers: the payload, then the request's binding. */
function signed(payload: string, binding: CursorBinding): Uint8Array {
  const filters = Object.keys(binding.filters)
    .sort()
    .map((k) => [k, binding.filters[k] ?? null]);
  return encoder.encode(
    JSON.stringify([
      "atlas-cursor/v1",
      payload,
      binding.route,
      binding.scope,
      filters,
      binding.principal,
    ]),
  );
}

/** The Worker environment's cursor secret. */
export function cursorSecret(env: object): Promise<string> {
  return readSecret(env, "BETTER_AUTH_SECRET");
}

export async function signCursor<K>(
  secret: string,
  binding: CursorBinding,
  state: CursorState<K>,
): Promise<string> {
  const payload = toBase64Url(
    encoder.encode(
      JSON.stringify([
        VERSION,
        state.snapshot,
        state.after,
        state.loaded,
        state.total,
        state.issuedAt,
      ]),
    ),
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    await cursorKey(secret),
    signed(payload, binding) as BufferSource,
  );
  return `${payload}.${toBase64Url(new Uint8Array(mac))}`;
}

/**
 * Check a cursor against the request it arrived with: forged, tampered,
 * outdated or rebound cursors fail. Whether an authentic one has expired is
 * the caller's question, once it has resolved the cursor's snapshot.
 */
export async function verifyCursor<K>(
  secret: string,
  binding: CursorBinding,
  cursor: string,
): Promise<CursorResult<K>> {
  if (cursor.length > 4096) return { ok: false };
  const [payload, mac, extra] = cursor.split(".");
  if (!payload || !mac || extra !== undefined) return { ok: false };
  const macBytes = fromBase64Url(mac);
  const payloadBytes = fromBase64Url(payload);
  if (!macBytes || !payloadBytes) return { ok: false };
  const authentic = await crypto.subtle.verify(
    "HMAC",
    await cursorKey(secret),
    macBytes as BufferSource,
    signed(payload, binding) as BufferSource,
  );
  if (!authentic) return { ok: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return { ok: false };
  }
  if (!Array.isArray(parsed) || parsed[0] !== VERSION || parsed.length !== 6) return { ok: false };
  const [, snapshot, after, loaded, total, issuedAt] = parsed as [
    number,
    unknown,
    K,
    unknown,
    unknown,
    unknown,
  ];
  if (
    typeof snapshot !== "string" ||
    typeof loaded !== "number" ||
    (total !== null && typeof total !== "number") ||
    typeof issuedAt !== "number"
  )
    return { ok: false };
  return { ok: true, state: { snapshot, after, loaded, total, issuedAt } };
}
