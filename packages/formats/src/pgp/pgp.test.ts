import { describe, expect, it } from "vite-plus/test";

import {
  dearmorPublicKey,
  generateSigningKey,
  SigningKey,
  verifyClearsigned,
  verifyDetached,
} from "./index.ts";

describe("pgp signing keys", () => {
  it("generates an ed25519 v4 key and clearsigns", async () => {
    const generated = await generateSigningKey({ algorithm: "ed25519", name: "test repo" });
    expect(generated.fingerprint).toMatch(/^[0-9A-F]{40}$/);
    const key = await SigningKey.load(generated.privateKeyArmored);
    expect(key.fingerprint).toBe(generated.fingerprint);

    const text = "Origin: test\nSuite: stable\nSHA256:\n abc 12 main/binary-amd64/Packages\n";
    const signed = await key.clearsign(text);
    expect(signed).toContain("-----BEGIN PGP SIGNED MESSAGE-----");
    expect(signed).toContain("Hash: SHA512");
    const verified = await verifyClearsigned(signed, generated.publicKeyArmored);
    expect(verified?.trimEnd()).toBe(text.trimEnd());
    expect(
      await verifyClearsigned(signed.replace("stable", "stabl3"), generated.publicKeyArmored),
    ).toBeNull();
  });

  it("detach-signs exact bytes", async () => {
    const generated = await generateSigningKey({ algorithm: "ed25519", name: "t" });
    const key = await SigningKey.load(generated.privateKeyArmored);
    const data = new TextEncoder().encode("<repomd/>\n");
    const sig = await key.detachSign(data);
    expect(sig).toContain("-----BEGIN PGP SIGNATURE-----");
    expect(await verifyDetached(data, sig, generated.publicKeyArmored)).toBe(true);
    expect(await verifyDetached("<repomd/> \n", sig, generated.publicKeyArmored)).toBe(false);
  });

  it("dearmors the public key to a v4 public-key packet", async () => {
    const generated = await generateSigningKey({ algorithm: "ed25519", name: "t" });
    const binary = await dearmorPublicKey(generated.publicKeyArmored);
    // New-format packet tag 6 (public key) or old-format 0x98/0x99.
    expect([0xc6, 0x98, 0x99]).toContain(binary[0]);
    const key = await SigningKey.load(generated.privateKeyArmored);
    expect(key.publicKeyBinary()).toEqual(binary);
  });

  it("generates RSA-4096 keys", { timeout: 60_000 }, async () => {
    const generated = await generateSigningKey({ name: "rsa repo", email: "repo@example.com" });
    expect(generated.algorithm).toBe("rsa4096");
    const key = await SigningKey.load(generated.privateKeyArmored);
    const sig = await key.detachSign("hello");
    expect(await verifyDetached("hello", sig, generated.publicKeyArmored)).toBe(true);
  });
});
