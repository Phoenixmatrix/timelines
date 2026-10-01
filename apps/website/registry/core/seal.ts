import { fromBase64, toBase64 } from "@gitmatrix/formats/hash";

import { sealingKey } from "./secrets.ts";

/** `v1.<iv>.<ciphertext>` (base64), AES-256-GCM under a KEK-derived key. */
export async function seal(env: object, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await sealingKey(env),
    new TextEncoder().encode(plaintext),
  );
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}

export async function unseal(env: object, sealed: string): Promise<string> {
  const [version, iv, ciphertext] = sealed.split(".");
  if (version !== "v1" || !iv || !ciphertext) throw new Error("unrecognised sealed value");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv) as BufferSource },
    await sealingKey(env),
    fromBase64(ciphertext) as BufferSource,
  );
  return new TextDecoder().decode(plaintext);
}
