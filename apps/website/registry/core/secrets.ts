import { fromBase64 } from "@gitmatrix/formats/hash";

interface StoreSecretBinding {
  get(): Promise<string>;
}

function storeBinding(value: unknown): value is StoreSecretBinding {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "get") === "function"
  );
}

/** A plain env var (local `.env`) first, then the `<NAME>_SECRET` Secrets Store binding. */
export async function readSecret(env: object, name: string): Promise<string> {
  const direct = Reflect.get(env, name);
  if (typeof direct === "string" && direct.length > 0) return direct;
  const binding = Reflect.get(env, `${name}_SECRET`);
  if (!storeBinding(binding)) throw new Error(`${name} is not configured`);
  const value = await binding.get();
  if (value.length === 0) throw new Error(`${name} is empty`);
  return value;
}

const derived = new Map<string, Promise<CryptoKey | Uint8Array>>();

async function kekBytes(env: object): Promise<Uint8Array> {
  const raw = fromBase64((await readSecret(env, "REGISTRY_KEK")).trim());
  if (raw.length < 32) throw new Error("REGISTRY_KEK must be at least 32 bytes");
  return raw;
}

async function hkdf(env: object, info: string, length: number): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey(
    "raw",
    (await kekBytes(env)) as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("gitmatrix"),
      info: new TextEncoder().encode(info),
    },
    base,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** AES-256-GCM key for sealing values at rest. */
export function sealingKey(env: object): Promise<CryptoKey> {
  const cached = derived.get("seal");
  if (cached) return cached as Promise<CryptoKey>;
  const promise = hkdf(env, "seal/v1", 32).then((bytes) =>
    crypto.subtle.importKey("raw", bytes as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]),
  );
  derived.set("seal", promise);
  promise.catch(() => derived.delete("seal"));
  return promise;
}

/** 32-byte Ed25519 seed for the registry token signing key. */
export function registryTokenSeed(env: object): Promise<Uint8Array> {
  const cached = derived.get("token");
  if (cached) return cached as Promise<Uint8Array>;
  const promise = hkdf(env, "registry-token/v1", 32);
  derived.set("token", promise);
  promise.catch(() => derived.delete("token"));
  return promise;
}

export function resetDerivedKeys(): void {
  derived.clear();
}
