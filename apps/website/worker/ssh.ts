// SSH public keys and SSHSIG signatures, verified with WebCrypto.
//
// Clients prove they hold a key the way `ssh-keygen -Y sign` and git's SSH
// commit signing do: an SSHSIG over a message, under a namespace. References:
//   https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.sshsig
//   RFC 4253 §6.6 (ssh-rsa key format), RFC 8709 (ed25519), RFC 5656 (ecdsa),
//   RFC 8332 (rsa-sha2-256/512 signatures)

export const SSH_NAMESPACE = "gitmatrix-auth";

export type SshKeyType = "ssh-ed25519" | "ecdsa-sha2-nistp256" | "ecdsa-sha2-nistp384" | "ssh-rsa";

const CURVES: Record<string, { curve: string; hash: string; size: number }> = {
  "ecdsa-sha2-nistp256": { curve: "P-256", hash: "SHA-256", size: 32 },
  "ecdsa-sha2-nistp384": { curve: "P-384", hash: "SHA-384", size: 48 },
};
const MIN_RSA_BITS = 2048;

export class SshError extends Error {}

class Reader {
  #view: DataView;
  #at = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u32(): number {
    if (this.#at + 4 > this.bytes.length) throw new SshError("Truncated SSH data.");
    const value = this.#view.getUint32(this.#at);
    this.#at += 4;
    return value;
  }
  raw(length: number): Uint8Array {
    if (this.#at + length > this.bytes.length) throw new SshError("Truncated SSH data.");
    const out = this.bytes.subarray(this.#at, this.#at + length);
    this.#at += length;
    return out;
  }
  string(): Uint8Array {
    return this.raw(this.u32());
  }
  text(): string {
    return new TextDecoder().decode(this.string());
  }
  get done(): boolean {
    return this.#at === this.bytes.length;
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function sshString(value: Uint8Array | string): Uint8Array {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, bytes.length);
  return concat(length, bytes);
}

const unhex = (bytes: Uint8Array) => (bytes[0] === 0 ? bytes.subarray(1) : bytes);

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text.replace(/\s+/g, ""));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array, url = false): string {
  const text = btoa(String.fromCharCode(...bytes));
  return url ? text.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : text;
}

export interface SshPublicKey {
  type: SshKeyType;
  /** The key blob: what fingerprints hash and SSHSIG embeds. */
  blob: Uint8Array;
  /** "<type> <base64>", the canonical stored form. */
  text: string;
  comment: string;
  /** For RSA, the modulus size; otherwise the curve size. */
  bits: number;
}

/** Parse an OpenSSH public key line ("ssh-ed25519 AAAA… comment"). */
export function parsePublicKey(line: string): SshPublicKey {
  const [type, data, ...rest] = line.trim().split(/\s+/);
  if (!type || !data) throw new SshError("That doesn't look like an SSH public key.");
  if (type.startsWith("sk-")) {
    throw new SshError("Security-key (sk-) SSH keys aren't supported yet.");
  }
  if (type === "ecdsa-sha2-nistp521") {
    throw new SshError("P-521 ECDSA keys aren't supported; use Ed25519, P-256/P-384 or RSA.");
  }
  if (type !== "ssh-ed25519" && type !== "ssh-rsa" && !(type in CURVES)) {
    throw new SshError(`Unsupported SSH key type ${type}.`);
  }
  let blob: Uint8Array;
  try {
    blob = base64ToBytes(data);
  } catch {
    throw new SshError("The key data isn't valid base64.");
  }
  const reader = new Reader(blob);
  if (reader.text() !== type) throw new SshError("The key data doesn't match its type.");
  let bits: number;
  if (type === "ssh-ed25519") {
    if (reader.string().length !== 32) throw new SshError("Malformed Ed25519 key.");
    bits = 256;
  } else if (type === "ssh-rsa") {
    reader.string(); // e
    bits = unhex(reader.string()).length * 8;
    if (bits < MIN_RSA_BITS) throw new SshError(`RSA keys need at least ${MIN_RSA_BITS} bits.`);
  } else {
    reader.text(); // curve name
    reader.string(); // point
    bits = (CURVES[type]?.size ?? 0) * 8;
  }
  if (!reader.done) throw new SshError("Malformed SSH key.");
  return {
    type: type as SshKeyType,
    blob,
    text: `${type} ${bytesToBase64(blob)}`,
    comment: rest.join(" "),
    bits,
  };
}

/** OpenSSH's SHA256 fingerprint: "SHA256:" + unpadded base64. */
export async function fingerprint(blob: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", blob));
  return `SHA256:${bytesToBase64(digest).replace(/=+$/, "")}`;
}

interface SshSig {
  publicKey: Uint8Array;
  namespace: string;
  hashAlgorithm: string;
  signature: Uint8Array;
}

function parseSshSig(armored: string): SshSig {
  const body = armored
    .replace(/-----BEGIN SSH SIGNATURE-----/, "")
    .replace(/-----END SSH SIGNATURE-----/, "");
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(body);
  } catch {
    throw new SshError("The signature isn't valid base64.");
  }
  const reader = new Reader(bytes);
  if (new TextDecoder().decode(reader.raw(6)) !== "SSHSIG") {
    throw new SshError("Not an SSH signature.");
  }
  if (reader.u32() !== 1) throw new SshError("Unsupported SSH signature version.");
  const publicKey = reader.string();
  const namespace = reader.text();
  reader.string(); // reserved
  const hashAlgorithm = reader.text();
  const signature = reader.string();
  return { publicKey, namespace, hashAlgorithm, signature };
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** ECDSA signatures arrive as two mpints; WebCrypto wants r || s, each padded. */
function ecdsaRaw(blob: Uint8Array, size: number): Uint8Array {
  const reader = new Reader(blob);
  const out = new Uint8Array(size * 2);
  for (const [i, part] of [reader.string(), reader.string()].entries()) {
    const value = unhex(part);
    if (value.length > size) throw new SshError("Malformed ECDSA signature.");
    out.set(value, size * (i + 1) - value.length);
  }
  return out;
}

async function verifyRaw(key: SshPublicKey, sigBlob: Uint8Array, data: Uint8Array) {
  const sig = new Reader(sigBlob);
  const algorithm = sig.text();
  const bytes = sig.string();
  const blob = new Reader(key.blob);
  blob.text();
  if (key.type === "ssh-ed25519") {
    if (algorithm !== "ssh-ed25519") return false;
    const cryptoKey = await crypto.subtle.importKey("raw", blob.string(), "Ed25519", false, [
      "verify",
    ]);
    return crypto.subtle.verify("Ed25519", cryptoKey, bytes, data);
  }
  if (key.type === "ssh-rsa") {
    const hash = { "rsa-sha2-256": "SHA-256", "rsa-sha2-512": "SHA-512" }[algorithm];
    if (!hash) return false; // SHA-1 "ssh-rsa" signatures are refused.
    const e = unhex(blob.string());
    const n = unhex(blob.string());
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", e: bytesToBase64(e, true), n: bytesToBase64(n, true), ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash },
      false,
      ["verify"],
    );
    return crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, bytes, data);
  }
  const curve = CURVES[key.type];
  if (!curve || algorithm !== key.type) return false;
  blob.text(); // curve name
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    blob.string(),
    { name: "ECDSA", namedCurve: curve.curve },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: curve.hash },
    cryptoKey,
    ecdsaRaw(bytes, curve.size),
    data,
  );
}

/**
 * Check an armored SSHSIG over `message`, made by `key`, in `namespace`.
 * False for a well-formed signature that doesn't verify; throws SshError for
 * malformed input.
 */
export async function verifySshSig(
  armored: string,
  message: Uint8Array | string,
  key: SshPublicKey,
  namespace = SSH_NAMESPACE,
): Promise<boolean> {
  const sig = parseSshSig(armored);
  if (!equal(sig.publicKey, key.blob)) return false;
  if (sig.namespace !== namespace) return false;
  const hash = { sha256: "SHA-256", sha512: "SHA-512" }[sig.hashAlgorithm];
  if (!hash) throw new SshError(`Unsupported SSH signature hash ${sig.hashAlgorithm}.`);
  const bytes = typeof message === "string" ? new TextEncoder().encode(message) : message;
  const digest = new Uint8Array(await crypto.subtle.digest(hash, bytes));
  const signed = concat(
    new TextEncoder().encode("SSHSIG"),
    sshString(namespace),
    sshString(""),
    sshString(sig.hashAlgorithm),
    sshString(digest),
  );
  try {
    return await verifyRaw(key, sig.signature, signed);
  } catch (error) {
    if (error instanceof SshError) throw error;
    return false;
  }
}

/** The text a client signs to answer a challenge. */
export function challengeMessage(origin: string, nonce: string, fingerprintText: string): string {
  return `gitmatrix-ssh-auth\n${origin}\n${nonce}\n${fingerprintText}\n`;
}
