// `omi secret init-key|rotate-key` (ADR-0004 D4). The master key never goes through argv or stdout.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { keyEnvName } from "../core/config.ts";
import { OmiError } from "../core/errors/errors.ts";
import {
  decryptSecret,
  encryptSecret,
  generateMasterKey,
  keyFingerprint,
  loadMasterKey,
  parseMasterKey,
} from "../core/secrets.ts";
import { STATE_FILE } from "../core/workspace.ts";
import { openState, tx } from "../persistence/db.ts";
import { hasAnySealedSecret, listProfileRecords, writeSealed } from "../persistence/profiles.ts";

/** Persists `name=value` in the user's environment; the value must not travel through argv. */
export type WriteUserEnv = (name: string, value: string) => void;

export interface SecretDeps {
  workspace: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  writeUserEnv?: WriteUserEnv;
  now?: () => Date;
}

/** Windows: the value is read from stdin by PowerShell; `name` is a validated identifier. */
export const writeUserEnvWindows: WriteUserEnv = (name, value) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new OmiError("USAGE_INVALID", "expected an environment variable name");
  }
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[Environment]::SetEnvironmentVariable('${name}', [Console]::In.ReadToEnd().Trim(), 'User')`,
      ],
      { input: value, stdio: ["pipe", "ignore", "ignore"], timeout: 30_000 },
    );
  } catch {
    throw new OmiError("INTERNAL", `could not write ${name} to the user environment`);
  }
};

export interface InitKeyResult {
  keyEnv: string;
  fingerprint: string;
  scope: "user";
  next: string;
}

export function secretInitKey(d: SecretDeps): InitKeyResult {
  const keyEnv = keyEnvName(d.workspace);
  if (d.env[keyEnv]?.trim()) {
    throw new OmiError(
      "SECRET_KEY_EXISTS",
      `${keyEnv} is already set: a new key would make stored tokens unreadable (rotate with \`omi secret rotate-key\`)`,
    );
  }
  const file = join(d.workspace, STATE_FILE);
  if (existsSync(file)) {
    const db = openState(file);
    try {
      if (hasAnySealedSecret(db)) {
        throw new OmiError(
          "SECRET_KEY_EXISTS",
          `the database already holds sealed tokens but ${keyEnv} is not set: restore the key, or re-enter every token (\`omi profile set-token\`) after removing the profiles`,
        );
      }
    } finally {
      db.close();
    }
  }
  if ((d.platform ?? process.platform) !== "win32") {
    throw new OmiError(
      "USAGE_INVALID",
      `omi secret init-key writes the user environment on Windows only. Elsewhere create the key yourself and export ${keyEnv} (base64 of 32 random bytes, e.g. from \`openssl rand -base64 32\`) in your shell profile; the key is never printed here`,
    );
  }
  const key = generateMasterKey();
  (d.writeUserEnv ?? writeUserEnvWindows)(keyEnv, key);
  return {
    keyEnv,
    fingerprint: keyFingerprint(parseMasterKey(key, keyEnv)),
    scope: "user",
    next: "open a new terminal so the variable is visible, then `omi profile import` or `omi profile set-token`",
  };
}

export interface RotateKeyResult {
  keyEnv: string;
  rotated: number;
  fingerprint: string;
  next: string;
}

/**
 * Re-seals every token with the key in `<keyEnv>_NEXT` in ONE transaction: any failure rolls back
 * and the old key stays valid for all of them. Switching the variable is the person's step.
 */
export function secretRotateKey(d: SecretDeps): RotateKeyResult {
  const keyEnv = keyEnvName(d.workspace);
  const nextEnv = `${keyEnv}_NEXT`;
  const oldKey = loadMasterKey(d.env, keyEnv);
  if (!d.env[nextEnv]?.trim()) {
    throw new OmiError(
      "SECRET_KEY_MISSING",
      `${nextEnv} is not set: put the new key (base64 of 32 bytes) there first`,
    );
  }
  const newKey = parseMasterKey(d.env[nextEnv] as string, nextEnv);
  if (keyFingerprint(newKey) === keyFingerprint(oldKey)) {
    throw new OmiError("USAGE_INVALID", `${nextEnv} holds the same key as ${keyEnv}`);
  }
  const file = join(d.workspace, STATE_FILE);
  if (!existsSync(file)) {
    return { keyEnv, rotated: 0, fingerprint: keyFingerprint(newKey), next: nextStep(keyEnv) };
  }
  const now = (d.now?.() ?? new Date()).toISOString();
  const db = openState(file);
  try {
    const rotated = tx(db, "rotate key", () => {
      let n = 0;
      for (const r of listProfileRecords(db)) {
        if (!r.sealed) continue;
        const plain = decryptSecret(oldKey, r.profile.name, r.sealed);
        writeSealed(db, r.profile.name, encryptSecret(newKey, r.profile.name, plain), now);
        n++;
      }
      return n;
    });
    return { keyEnv, rotated, fingerprint: keyFingerprint(newKey), next: nextStep(keyEnv) };
  } finally {
    db.close();
  }
}

const nextStep = (keyEnv: string) =>
  `tokens now need the new key: set ${keyEnv} to the value of ${keyEnv}_NEXT, then remove ${keyEnv}_NEXT`;
