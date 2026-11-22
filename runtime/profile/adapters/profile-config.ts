// Execution profiles of this machine as the runtime reads them: from `state.sqlite` (ADR-0004 D3),
// the legacy declarations still on disk, and the choice the Coordinator makes per task run.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// TODO(R7 #335): core/workspace.ts moves to the workspace module.
import { PROFILES_FILE, STATE_FILE } from "../../core/workspace.ts";
import { CONFIG_PATH, readConfigData, SecretsConfig } from "../../shared/config.ts";
import {
  DEFAULT_KEY_ENV,
  LegacyProfilesFile,
  type Profile,
  parseContract,
} from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { registerSecret } from "../../shared/redact.ts";
import { openState } from "../../shared/sqlite/db.ts";
import { decryptSecret, loadMasterKey } from "../domain/secrets.ts";
import { type ProfileListing, type SecretResolver, secretEnv } from "../domain/selection.ts";
import { getProfileRecord, listProfileRecords } from "./profiles.ts";

/** Declarations of the pre-ADR-0004 layout still present on disk (never values of secrets). */
export interface LegacyProfiles {
  /** `<workspace>/.omi-plugins/omi.config.json`, when it exists. */
  json?: { path: string; profiles: Profile[] };
  /** The `profiles` section of `omi.config.yaml`, when present. */
  yaml?: { path: string; profiles: Profile[] };
}

/** Reads the legacy `omi.config.json` and YAML `profiles` section. Errors never echo values. */
export function readLegacyProfiles(workspace: string): LegacyProfiles {
  const out: LegacyProfiles = {};
  let text: string | undefined;
  try {
    text = readFileSync(join(workspace, PROFILES_FILE), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new OmiError("CONFIG_INVALID", `${PROFILES_FILE}: unreadable`);
    }
  }
  if (text !== undefined) {
    let data: unknown;
    try {
      data = JSON.parse(text.replace(/^﻿/, "")); // editors on Windows may write a BOM
    } catch {
      throw new OmiError("CONFIG_INVALID", `${PROFILES_FILE}: invalid JSON`);
    }
    out.json = {
      path: PROFILES_FILE,
      profiles: parseContract(LegacyProfilesFile, data, PROFILES_FILE, "CONFIG_INVALID").profiles,
    };
  }
  let yaml: unknown;
  try {
    yaml = readConfigData(workspace);
  } catch {
    yaml = undefined; // a broken YAML is loadConfig's error to report
  }
  const section =
    yaml && typeof yaml === "object" ? (yaml as Record<string, unknown>).profiles : undefined;
  if (section !== undefined && section !== null) {
    out.yaml = {
      path: CONFIG_PATH,
      profiles: parseContract(
        LegacyProfilesFile,
        { profiles: section },
        `${CONFIG_PATH} profiles`,
        "CONFIG_INVALID",
      ).profiles,
    };
  }
  return out;
}

/**
 * Profiles declared in a file while profiles live in the database is ambiguous: never silently pick
 * one side (ADR-0004 D3). Points at `omi profile import`.
 */
export function assertNoLegacyProfiles(workspace: string): void {
  const legacy = readLegacyProfiles(workspace);
  const where = [legacy.json, legacy.yaml].filter((s) => s?.profiles.length).map((s) => s?.path);
  if (where.length) {
    throw new OmiError(
      "CONFIG_INVALID",
      `profiles are still declared in ${where.join(", ")}: run \`omi profile import\` (profiles now live in state.sqlite)`,
    );
  }
}

/** Name of the env variable holding the master key: `secrets.keyEnv`, default `OMI_SECRET_KEY`. */
export function keyEnvName(workspace: string): string {
  let data: unknown;
  try {
    data = readConfigData(workspace);
  } catch {
    data = undefined;
  }
  const secrets =
    data && typeof data === "object" ? (data as Record<string, unknown>).secrets : undefined;
  if (secrets === undefined || secrets === null) return DEFAULT_KEY_ENV;
  return parseContract(SecretsConfig, secrets, `${CONFIG_PATH} secrets`, "CONFIG_INVALID").keyEnv;
}

/** `<workspace>/.omi-plugins/state.sqlite` when it exists, else undefined (reading creates nothing). */
const existingState = (workspace: string) => {
  const file = join(workspace, STATE_FILE);
  return existsSync(file) ? file : undefined;
};

/**
 * Execution profiles of this machine, from the `profile` table of `state.sqlite` (ADR-0004 D3).
 * No database means no profile: steps keep the `agents.routing` defaults. A profile still declared
 * in `omi.config.json` is CONFIG_INVALID until `omi profile import` ran.
 */
export function loadProfiles(workspace: string): Profile[] {
  assertNoLegacyProfiles(workspace);
  const file = existingState(workspace);
  if (!file) return [];
  const db = openState(file);
  try {
    return listProfileRecords(db).map((r) => r.profile);
  } finally {
    db.close();
  }
}

/** Profiles the Coordinator may pick from: every profile not `disabled`. */
export const listProfiles = (
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
): ProfileListing[] =>
  loadProfiles(workspace)
    .filter((p) => !p.disabled)
    .map((p) => ({
      name: p.name,
      harness: p.harness,
      auth: p.auth.type,
      secretEnv: secretEnv(p),
      secretSet: Boolean(env[secretEnv(p)]),
      models: p.models,
      efforts: p.efforts,
    }));

/**
 * Resolver over `state.sqlite`: master key from the variable `secrets.keyEnv` names in `env`, the
 * sealed token of the profile from the database. The plaintext is registered with `redact`.
 */
export function profileSecretResolver(workspace: string, env: NodeJS.ProcessEnv): SecretResolver {
  return (profile) => {
    const file = existingState(workspace);
    const db = file ? openState(file) : undefined;
    let sealed: ReturnType<typeof getProfileRecord>;
    try {
      sealed = db ? getProfileRecord(db, profile.name) : undefined;
    } finally {
      db?.close();
    }
    if (!sealed?.sealed) {
      throw new OmiError(
        "CONFIG_INVALID",
        `profile ${profile.name} has no token: pipe it to \`omi profile set-token ${profile.name}\``,
      );
    }
    const plain = decryptSecret(
      loadMasterKey(env, keyEnvName(workspace)),
      profile.name,
      sealed.sealed,
    );
    registerSecret(plain);
    return plain;
  };
}
