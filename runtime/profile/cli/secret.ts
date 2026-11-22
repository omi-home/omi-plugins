// `omi secret init-key|rotate-key` (ADR-0004 D4). The master key never goes through argv or stdout.
import { execFileSync } from "node:child_process";
import { OmiError } from "../../shared/errors/errors.ts";
import { tx } from "../../shared/sqlite/db.ts";
import { assertNoUnmigratedRows, keyEnvName } from "../adapters/profile-config.ts";
import { withExistingProfileDb } from "../adapters/profile-store.ts";
import { hasAnySealedSecret, listProfileRecords, writeSealed } from "../adapters/profiles.ts";
import {
  decryptSecret,
  encryptSecret,
  generateMasterKey,
  keyFingerprint,
  loadMasterKey,
  parseMasterKey,
} from "../domain/secrets.ts";

/** Persists `name=value` in the user's environment; the value must not travel through argv. */
export type WriteUserEnv = (name: string, value: string) => void;

export interface SecretDeps {
  workspace: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  writeUserEnv?: WriteUserEnv;
  readUserEnv?: ReadUserEnv;
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

/** Reads `name` from the user's persisted environment (not the process's), undefined when unset. */
export type ReadUserEnv = (name: string) => string | undefined;

/** Windows: a terminal opened before an earlier `init-key` does not see the User variable (CR-001). */
export const readUserEnvWindows: ReadUserEnv = (name) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new OmiError("USAGE_INVALID", "expected an environment variable name");
  }
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[Console]::Out.Write([Environment]::GetEnvironmentVariable('${name}', 'User'))`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 },
    );
    return out.trim() || undefined;
  } catch {
    throw new OmiError("INTERNAL", `could not read ${name} from the user environment`);
  }
};

export interface InitKeyResult {
  keyEnv: string;
  fingerprint: string;
  scope: "user";
  next: string;
}

export function secretInitKey(d: SecretDeps): InitKeyResult {
  // Only the unmigrated rows: a legacy file is moved by `omi profile import`, which needs this key first.
  assertNoUnmigratedRows(d.workspace);
  const keyEnv = keyEnvName(d.workspace);
  if (d.env[keyEnv]?.trim()) {
    throw new OmiError(
      "SECRET_KEY_EXISTS",
      `${keyEnv} is already set: a new key would make stored tokens unreadable (rotate with \`omi secret rotate-key\`)`,
    );
  }
  if (withExistingProfileDb(d.env, hasAnySealedSecret, false)) {
    throw new OmiError(
      "SECRET_KEY_EXISTS",
      `the machine profile database already holds sealed tokens but ${keyEnv} is not set: restore the key, or re-enter every token (\`omi profile set-token\`) after removing the profiles`,
    );
  }
  if ((d.platform ?? process.platform) !== "win32") {
    throw new OmiError(
      "USAGE_INVALID",
      `omi secret init-key writes the user environment on Windows only. Elsewhere create the key yourself and export ${keyEnv} (base64 of 32 random bytes, e.g. from \`openssl rand -base64 32\`) in your shell profile; the key is never printed here`,
    );
  }
  if ((d.readUserEnv ?? readUserEnvWindows)(keyEnv)) {
    throw new OmiError(
      "SECRET_KEY_EXISTS",
      `${keyEnv} is already set in the user environment (open a new terminal to see it): a new key would make stored tokens unreadable`,
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
  assertNoUnmigratedRows(d.workspace);
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
  const now = (d.now?.() ?? new Date()).toISOString();
  const rotated = withExistingProfileDb(
    d.env,
    (db) =>
      tx(db, "rotate key", () => {
        let n = 0;
        for (const r of listProfileRecords(db)) {
          if (!r.sealed) continue;
          const plain = decryptSecret(oldKey, r.profile.name, r.sealed);
          writeSealed(db, r.profile.name, encryptSecret(newKey, r.profile.name, plain), now);
          n++;
        }
        return n;
      }),
    0,
  );
  return { keyEnv, rotated, fingerprint: keyFingerprint(newKey), next: nextStep(keyEnv) };
}

const nextStep = (keyEnv: string) =>
  `tokens now need the new key, for every workspace on this machine (the profile database is shared): set ${keyEnv} to the value of ${keyEnv}_NEXT, then remove ${keyEnv}_NEXT`;
