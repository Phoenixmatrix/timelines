import * as openpgp from "openpgp";

/**
 * Repository signing keys for apt and rpm metadata. Keys are OpenPGP v4 (the
 * format every gpgv, rpm and librepo in the wild understands) and signatures
 * use SHA-512. RSA-4096 is the default because RHEL 7/8 rpm and older gpgv
 * cannot verify EdDSA; `ed25519` produces a legacy (v4, algorithm 22) EdDSA key.
 * Runs on WebCrypto, so it works unchanged in Workers and Node.
 */

export type SigningAlgorithm = "rsa4096" | "ed25519";

const CONFIG = {
  v6Keys: false,
  preferredHashAlgorithm: openpgp.enums.hash.sha512,
  // Readers are old gpgv/rpm: never emit AEAD or v6 constructs.
  aeadProtect: false,
  // RSA/EdDSA signatures are already deterministic-safe; the salt notation only
  // confuses old parsers.
  nonDeterministicSignaturesViaNotation: false,
} as const;

function fullConfig(): openpgp.Config {
  return { ...openpgp.config, ...CONFIG };
}

/**
 * Clears the "critical" bit on every subpacket of a hashed-subpacket block.
 * openpgp.js marks creation time and key flags critical, which yum 3's
 * key parser (RHEL/CentOS 7) cannot read.
 */
function clearCritical(block: Uint8Array): Uint8Array {
  const out = block.slice();
  const end = 2 + ((out[0]! << 8) | out[1]!);
  let i = 2;
  while (i < end) {
    const first = out[i]!;
    let length: number;
    let header: number;
    if (first < 192) {
      length = first;
      header = 1;
    } else if (first < 255) {
      length = ((first - 192) << 8) + out[i + 1]! + 192;
      header = 2;
    } else {
      length = ((out[i + 1]! << 24) | (out[i + 2]! << 16) | (out[i + 3]! << 8) | out[i + 4]!) >>> 0;
      header = 5;
    }
    out[i + header] = out[i + header]! & 0x7f;
    i += header + length;
  }
  return out;
}

/** Re-issues the primary user's self-certification without critical subpackets. */
async function compatibleSelfCertification(key: openpgp.PrivateKey): Promise<void> {
  const user = key.users[0];
  if (!user?.userID) throw new Error("generated key has no user ID");
  const sig = new openpgp.SignaturePacket();
  const packet = sig as unknown as { writeHashedSubPackets(): Uint8Array };
  const write = packet.writeHashedSubPackets.bind(sig);
  packet.writeHashedSubPackets = () => clearCritical(write());
  sig.signatureType = openpgp.enums.signature.certPositive;
  sig.publicKeyAlgorithm = key.keyPacket.algorithm;
  sig.hashAlgorithm = openpgp.enums.hash.sha512;
  sig.keyFlags = new Uint8Array([
    openpgp.enums.keyFlags.certifyKeys | openpgp.enums.keyFlags.signData,
  ]);
  sig.preferredHashAlgorithms = [openpgp.enums.hash.sha512, openpgp.enums.hash.sha256];
  sig.preferredSymmetricAlgorithms = [
    openpgp.enums.symmetric.aes256,
    openpgp.enums.symmetric.aes128,
  ];
  sig.isPrimaryUserID = true;
  // The typings omit sign()'s trailing config argument, which v4 signing needs.
  const signable = sig as unknown as { sign(...args: unknown[]): Promise<void> };
  await signable.sign(
    key.keyPacket,
    { userID: user.userID, key: key.keyPacket },
    key.keyPacket.created,
    false,
    fullConfig(),
  );
  user.selfCertifications = [sig];
}

export interface GeneratedKey {
  algorithm: SigningAlgorithm;
  /** Upper-case hex v4 fingerprint (40 characters). */
  fingerprint: string;
  publicKeyArmored: string;
  /** Unencrypted; callers must seal it before storing. */
  privateKeyArmored: string;
}

export async function generateSigningKey(options: {
  algorithm?: SigningAlgorithm;
  name: string;
  email?: string;
  date?: Date;
}): Promise<GeneratedKey> {
  const algorithm = options.algorithm ?? "rsa4096";
  const userIDs = [{ name: options.name, ...(options.email ? { email: options.email } : {}) }];
  const common = {
    userIDs,
    format: "armored" as const,
    date: options.date,
    // A signing-only key: no encryption subkey to confuse keyring tooling.
    subkeys: [],
    config: CONFIG,
  };
  const generated =
    algorithm === "rsa4096"
      ? await openpgp.generateKey({ ...common, type: "rsa", rsaBits: 4096 })
      : await openpgp.generateKey({ ...common, type: "ecc", curve: "ed25519Legacy" });
  const key = await openpgp.readPrivateKey({ armoredKey: generated.privateKey });
  await compatibleSelfCertification(key);
  return {
    algorithm,
    fingerprint: key.getFingerprint().toUpperCase(),
    publicKeyArmored: key.toPublic().armor(fullConfig()),
    privateKeyArmored: key.armor(fullConfig()),
  };
}

/** A decrypted private key ready to sign repository metadata. */
export class SigningKey {
  private readonly key: openpgp.PrivateKey;
  readonly fingerprint: string;
  readonly publicKeyArmored: string;
  private constructor(key: openpgp.PrivateKey, fingerprint: string, publicKeyArmored: string) {
    this.key = key;
    this.fingerprint = fingerprint;
    this.publicKeyArmored = publicKeyArmored;
  }

  static async load(privateKeyArmored: string): Promise<SigningKey> {
    const key = await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });
    return new SigningKey(key, key.getFingerprint().toUpperCase(), key.toPublic().armor());
  }

  /** Binary (dearmored) public key, the format `signed-by=` keyrings expect. */
  publicKeyBinary(): Uint8Array {
    return this.key.toPublic().write();
  }

  /** A clearsigned document (apt's InRelease). */
  async clearsign(text: string): Promise<string> {
    const message = await openpgp.createCleartextMessage({ text });
    return openpgp.sign({ message, signingKeys: this.key, config: CONFIG });
  }

  /** An armored detached signature over the exact bytes (Release.gpg, repomd.xml.asc). */
  async detachSign(data: Uint8Array | string): Promise<string> {
    const binary = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const message = await openpgp.createMessage({ binary });
    return openpgp.sign({
      message,
      signingKeys: this.key,
      detached: true,
      format: "armored",
      config: CONFIG,
    });
  }
}

/** Converts an armored public key to its binary form. */
export async function dearmorPublicKey(armored: string): Promise<Uint8Array> {
  return (await openpgp.readKey({ armoredKey: armored })).write();
}

/** Verifies a clearsigned document; returns the signed text, or null if invalid. */
export async function verifyClearsigned(
  signed: string,
  publicKeyArmored: string,
): Promise<string | null> {
  try {
    const message = await openpgp.readCleartextMessage({ cleartextMessage: signed });
    const verificationKeys = await openpgp.readKey({ armoredKey: publicKeyArmored });
    const result = await openpgp.verify({ message, verificationKeys, expectSigned: true });
    return typeof result.data === "string" ? result.data : null;
  } catch {
    return null;
  }
}

/** Verifies an armored detached signature over `data`. */
export async function verifyDetached(
  data: Uint8Array | string,
  armoredSignature: string,
  publicKeyArmored: string,
): Promise<boolean> {
  try {
    const binary = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const message = await openpgp.createMessage({ binary });
    const signature = await openpgp.readSignature({ armoredSignature });
    const verificationKeys = await openpgp.readKey({ armoredKey: publicKeyArmored });
    await openpgp.verify({ message, signature, verificationKeys, expectSigned: true });
    return true;
  } catch {
    return false;
  }
}
