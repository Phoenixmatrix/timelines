import { importPKCS8, jwtVerify, SignJWT, type CryptoKey as JoseKey } from "jose";

import { registryTokenSeed } from "../secrets.ts";
import type { AccessGrant, Actor, CredentialReference } from "./actor.ts";
import { scopeSet } from "./actor.ts";

/**
 * Short-lived tokens the registry issues itself (the Docker token service).
 * Signed with an Ed25519 key derived from the KEK, so there is no extra secret
 * and every isolate agrees on it.
 */

const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

let keys: Promise<{ privateKey: JoseKey; publicKey: CryptoKey }> | null = null;

async function signingKeys(env: object) {
  if (!keys) {
    keys = (async () => {
      const seed = await registryTokenSeed(env);
      const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + seed.length);
      pkcs8.set(PKCS8_ED25519_PREFIX);
      pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
      const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----`;
      const privateKey = await importPKCS8(pem, "EdDSA", { extractable: true });
      const jwk = (await crypto.subtle.exportKey("jwk", privateKey as CryptoKey)) as JsonWebKey;
      const publicKey = await crypto.subtle.importKey(
        "jwk",
        { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
        { name: "Ed25519" },
        true,
        ["verify"],
      );
      return { privateKey, publicKey };
    })();
    keys.catch(() => {
      keys = null;
    });
  }
  return keys;
}

export function resetRegistryTokenKeys(): void {
  keys = null;
}

export const REGISTRY_TOKEN_TTL_SECONDS = 15 * 60;

/** Registry tokens name this issuer, so they're told apart from other JWTs. */
export const REGISTRY_TOKEN_ISSUER = "gitmatrix-registry";

export async function issueRegistryToken(
  env: object,
  actor: Actor,
  access: AccessGrant[],
  audience: string,
): Promise<{ token: string; expiresIn: number; issuedAt: string }> {
  const { privateKey } = await signingKeys(env);
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    access,
    kind: actor.kind,
    name: actor.name ?? undefined,
    email: actor.email ?? undefined,
    tid: actor.tokenId ?? undefined,
    scope: [...actor.scopes].join(" "),
    person: actor.personId,
    agent: actor.agentId,
    credential: actor.credential,
  })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .setIssuer(REGISTRY_TOKEN_ISSUER)
    .setAudience(audience)
    .setSubject(actor.subject ?? "anonymous")
    .setIssuedAt(now)
    .setNotBefore(now - 30)
    .setExpirationTime(now + REGISTRY_TOKEN_TTL_SECONDS)
    .setJti(crypto.randomUUID())
    .sign(privateKey);
  return {
    token,
    expiresIn: REGISTRY_TOKEN_TTL_SECONDS,
    issuedAt: new Date(now * 1000).toISOString(),
  };
}

export async function verifyRegistryToken(env: object, token: string): Promise<Actor | null> {
  const { publicKey } = await signingKeys(env);
  try {
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: REGISTRY_TOKEN_ISSUER,
      algorithms: ["EdDSA"],
      clockTolerance: 30,
    });
    const kind = payload.kind;
    if (kind !== "anonymous" && kind !== "user" && kind !== "job") return null;
    const reference = payload.credential;
    let credential: CredentialReference | undefined;
    if (reference && typeof reference === "object" && !Array.isArray(reference)) {
      const ref = reference as Record<string, unknown>;
      if (
        (ref.kind === "token" || ref.kind === "session") &&
        typeof ref.id === "string" &&
        ref.id
      ) {
        credential = { kind: ref.kind, id: ref.id };
      } else if (
        ref.kind === "job" &&
        typeof ref.hash === "string" &&
        /^[a-f0-9]{64}$/.test(ref.hash)
      ) {
        credential = { kind: "job", hash: ref.hash };
      }
    }
    if (kind !== "anonymous" && (!payload.sub || !credential || typeof payload.person !== "string"))
      return null;
    if (
      !Array.isArray(payload.access) ||
      !payload.access.every((grant: unknown) => {
        if (!grant || typeof grant !== "object") return false;
        const value = grant as Record<string, unknown>;
        return (
          typeof value.type === "string" &&
          typeof value.name === "string" &&
          Array.isArray(value.actions) &&
          value.actions.every((action: unknown) => typeof action === "string")
        );
      })
    )
      return null;
    return {
      kind,
      subject: kind === "anonymous" ? null : (payload.sub ?? null),
      email: typeof payload.email === "string" ? payload.email : null,
      name: typeof payload.name === "string" ? payload.name : null,
      personId: typeof payload.person === "string" ? payload.person : undefined,
      agentId: typeof payload.agent === "string" ? payload.agent : null,
      credential,
      scopes: scopeSet(typeof payload.scope === "string" ? payload.scope.split(" ") : []),
      tokenId: typeof payload.tid === "string" ? payload.tid : null,
      via: "registry",
      access: payload.access as AccessGrant[],
    };
  } catch {
    return null;
  }
}
