// Profile token encryption (ADR-0004 D4): AES-256-GCM with a 32-byte master key from the environment.
// The key and the plaintext never appear in messages or details; AAD binds a token to its profile.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { OmiError } from "./errors/errors.ts";

export const DEFAULT_KEY_ENV = "OMI_SECRET_KEY";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

export const aadFor = (profileName: string) => `omi-profile:v1:${profileName}`;

/** A sealed token as stored in the `profile` table (all base64). */
export interface SealedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
  keyFingerprint: string;
}

/** Fresh random master key, base64 of 32 bytes. */
export const generateMasterKey = (): string => randomBytes(KEY_BYTES).toString("base64");

/** Decodes a base64 key; never echoes it. */
export function parseMasterKey(value: string, envName: string): Buffer {
  const text = value.trim();
  const key = B64.test(text) ? Buffer.from(text, "base64") : undefined;
  if (!key || key.length !== KEY_BYTES || key.toString("base64") !== text) {
    throw new OmiError(
      "SECRET_KEY_INVALID",
      `${envName} must be base64 of exactly ${KEY_BYTES} bytes: run \`omi secret init-key\``,
    );
  }
  return key;
}

/** The master key named by `keyEnv` in `env`. */
export function loadMasterKey(env: NodeJS.ProcessEnv, keyEnv = DEFAULT_KEY_ENV): Buffer {
  const value = env[keyEnv];
  if (!value?.trim()) {
    throw new OmiError(
      "SECRET_KEY_MISSING",
      `${keyEnv} is not set: run \`omi secret init-key\`, or re-enter every token with \`omi profile set-token\` if the key was lost`,
    );
  }
  return parseMasterKey(value, keyEnv);
}

/** Identifies a key without revealing it (domain-separated hash, truncated). */
export const keyFingerprint = (key: Buffer): string =>
  createHash("sha256").update("omi-key-fingerprint:v1\0").update(key).digest("hex").slice(0, 16);

export function encryptSecret(key: Buffer, profileName: string, plaintext: string): SealedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aadFor(profileName), "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    keyFingerprint: keyFingerprint(key),
  };
}

export function decryptSecret(key: Buffer, profileName: string, sealed: SealedSecret): string {
  if (sealed.keyFingerprint !== keyFingerprint(key)) {
    throw new OmiError(
      "SECRET_KEY_MISMATCH",
      `profile ${profileName}: the master key is not the one that sealed its token: set the right key, or re-enter the token with \`omi profile set-token\``,
    );
  }
  try {
    const iv = Buffer.from(sealed.iv, "base64");
    const tag = Buffer.from(sealed.tag, "base64");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("bad sizes");
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aadFor(profileName), "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new OmiError(
      "SECRET_DECRYPT_FAILED",
      `profile ${profileName}: the stored token cannot be decrypted (altered or copied from another profile): re-enter it with \`omi profile set-token\``,
    );
  }
}
