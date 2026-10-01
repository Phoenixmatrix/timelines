import { generateSigningKey, SigningKey, type SigningAlgorithm } from "@gitmatrix/formats/pgp";

import type { AppContext, Services } from "../../core/context.ts";
import { nowIso, type DB } from "../../core/db.ts";
import { RegistryError } from "../../core/errors.ts";
import type { Repository } from "../../core/repos.ts";
import { seal, unseal } from "../../core/seal.ts";

/**
 * Per-repository OpenPGP keys that sign apt and rpm metadata. The private key
 * is sealed with the KEK in `signing_keys`; the decrypted key is cached per
 * isolate by fingerprint, so a rotation elsewhere is picked up on the next
 * lookup (one D1 read) without serving a stale key.
 */

export interface RepoSigner {
  fingerprint: string;
  algorithm: string;
  publicKeyArmored: string;
  publicKeyBinary(): Uint8Array;
  clearsign(text: string): Promise<string>;
  detachSign(data: Uint8Array | string): Promise<string>;
}

interface KeyRow {
  repo_id: string;
  algorithm: string;
  fingerprint: string;
  public_key: string;
  private_key_sealed: string;
  created_at: string;
}

const loaded = new Map<string, Promise<SigningKey>>();

export function resetSigningKeyCache(): void {
  loaded.clear();
}

async function keyRow(db: DB, repoId: string): Promise<KeyRow | undefined> {
  return db.selectFrom("signing_keys").selectAll().where("repo_id", "=", repoId).executeTakeFirst();
}

function signerFor(env: object, row: KeyRow): RepoSigner {
  let promise = loaded.get(row.fingerprint);
  if (!promise) {
    promise = unseal(env, row.private_key_sealed).then((armored) => SigningKey.load(armored));
    if (loaded.size > 500) loaded.clear();
    loaded.set(row.fingerprint, promise);
    promise.catch(() => loaded.delete(row.fingerprint));
  }
  const key = promise;
  return {
    fingerprint: row.fingerprint,
    algorithm: row.algorithm,
    publicKeyArmored: row.public_key,
    publicKeyBinary: () => dearmor(row.public_key),
    clearsign: async (text) => (await key).clearsign(text),
    detachSign: async (data) => (await key).detachSign(data),
  };
}

async function generateRow(services: Services, repo: Repository): Promise<KeyRow> {
  const algorithm: SigningAlgorithm = repo.config.signingAlgorithm ?? "rsa4096";
  const host = new URL(services.baseUrl).hostname;
  const generated = await generateSigningKey({
    algorithm,
    name: `${repo.key} repository signing key (gitmatrix)`,
    email: `${repo.key}@${host}`,
  });
  return {
    repo_id: repo.id,
    algorithm,
    fingerprint: generated.fingerprint,
    public_key: generated.publicKeyArmored,
    private_key_sealed: await seal(services.env, generated.privateKeyArmored),
    created_at: nowIso(),
  };
}

/** The repository's signing key, generated on first use. */
export async function ensureSigningKey(services: Services, repo: Repository): Promise<RepoSigner> {
  let row = await keyRow(services.db, repo.id);
  if (!row) {
    const fresh = await generateRow(services, repo);
    // Two isolates may race to create the first key: the first insert wins.
    await services.db
      .insertInto("signing_keys")
      .values(fresh)
      .onConflict((oc) => oc.column("repo_id").doNothing())
      .execute();
    row = await keyRow(services.db, repo.id);
    if (!row) throw new RegistryError("internal", "Signing key was not stored");
  }
  return signerFor(services.env, row);
}

/** Replaces the repository's key; metadata must be rebuilt afterwards. */
export async function rotateSigningKey(services: Services, repo: Repository): Promise<RepoSigner> {
  const fresh = await generateRow(services, repo);
  await services.db
    .insertInto("signing_keys")
    .values(fresh)
    .onConflict((oc) =>
      oc.column("repo_id").doUpdateSet({
        algorithm: fresh.algorithm,
        fingerprint: fresh.fingerprint,
        public_key: fresh.public_key,
        private_key_sealed: fresh.private_key_sealed,
        created_at: fresh.created_at,
      }),
    )
    .execute();
  return ensureSigningKey(services, repo);
}

/** Decodes an ASCII-armored block (headers, base64 body, optional CRC line). */
function dearmor(armored: string): Uint8Array {
  const lines = armored.replace(/\r/g, "").split("\n");
  const start = lines.findIndex((l) => l.startsWith("-----BEGIN PGP"));
  const end = lines.findIndex((l, i) => i > start && l.startsWith("-----END PGP"));
  if (start === -1 || end === -1) throw new RegistryError("internal", "Malformed armored key");
  let i = start + 1;
  while (i < end && lines[i]!.trim() !== "") i++;
  const body = lines
    .slice(i + 1, end)
    .filter((l) => !l.startsWith("="))
    .join("");
  const binary = atob(body);
  const out = new Uint8Array(binary.length);
  for (let k = 0; k < binary.length; k++) out[k] = binary.charCodeAt(k);
  return out;
}

/**
 * Serves the repository's public key: armored for `.asc`, binary for `.gpg`
 * (what `signed-by=` keyrings and `rpm --import` accept).
 */
export async function servePublicKey(
  c: AppContext,
  services: Services,
  repo: Repository,
  kind: "asc" | "gpg",
): Promise<Response> {
  const signer = await ensureSigningKey(services, repo);
  const headers = {
    "cache-control": "private, max-age=0, must-revalidate",
    etag: `"${signer.fingerprint}-${kind}"`,
    "x-key-fingerprint": signer.fingerprint,
  };
  if (c.req.header("if-none-match") === headers.etag) {
    return new Response(null, { status: 304, headers });
  }
  const body = kind === "asc" ? signer.publicKeyArmored : signer.publicKeyBinary();
  return new Response(c.req.method === "HEAD" ? null : body, {
    headers: {
      ...headers,
      "content-type": kind === "asc" ? "application/pgp-keys" : "application/octet-stream",
    },
  });
}
