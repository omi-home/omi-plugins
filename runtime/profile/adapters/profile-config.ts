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
  ProfileEffort,
  parseContract,
} from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { registerSecret } from "../../shared/redact.ts";
import { openState } from "../../shared/sqlite/db.ts";
import { decryptSecret, loadMasterKey } from "../domain/secrets.ts";
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

/** The env variable a profile's secret is read from. */
export const secretEnv = (p: Profile) =>
  p.auth.type === "subscription" ? p.auth.tokenEnv : p.auth.keyEnv;

export interface ProfileListing {
  name: string;
  harness: Profile["harness"];
  auth: Profile["auth"]["type"];
  /** Variable name only; its value is never read out, just whether it is set. */
  secretEnv: string;
  secretSet: boolean;
  models: string[];
  efforts: Profile["efforts"];
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

/** The execution choice the Coordinator made for the agent steps of one `task run`/`task analyze`. */
export interface Selection {
  profile: Profile;
  model: string;
  effort: ProfileEffort;
  reason: string;
  /**
   * The decrypted token, only on call (ADR-0004 D4). A function, so JSON.stringify of a selection
   * (packet, state, log) can never carry it; each call registers the value with `redact`.
   */
  secret: () => string;
}

/** Decrypts a profile's token (throws an OmiError when it cannot). */
export type SecretResolver = (profile: Profile) => string;

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

/**
 * Validates `--profile/--model/--effort/--reason` against the machine's profiles (#217). No
 * `--profile` means no selection: steps keep the `agents.routing` defaults. Model and effort
 * default to the first the profile lists; the reason is required and recorded; the profile's
 * token must decrypt now, so nothing starts that cannot authenticate.
 */
export function selectProfile(
  profiles: Profile[],
  o: { profile?: string; model?: string; effort?: string; reason?: string },
  resolveSecret?: SecretResolver,
): Selection | undefined {
  if (o.profile === undefined) {
    if (o.model !== undefined || o.effort !== undefined) {
      throw new OmiError("USAGE_INVALID", "--model and --effort need --profile");
    }
    return undefined;
  }
  const profile = profiles.find((p) => p.name === o.profile);
  if (!profile) {
    throw new OmiError(
      "USAGE_INVALID",
      `no profile ${o.profile} in ${PROFILES_FILE}: see \`omi profile list\``,
    );
  }
  if (profile.disabled) throw new OmiError("USAGE_INVALID", `profile ${profile.name} is disabled`);
  if (!resolveSecret) throw new OmiError("INTERNAL", "no secret resolver for a profile selection");
  resolveSecret(profile); // fails early: missing key, no token, wrong key
  const model = o.model ?? profile.models[0];
  if (!model || !profile.models.includes(model)) {
    throw new OmiError(
      "USAGE_INVALID",
      `profile ${profile.name} offers models ${profile.models.join(", ")}`,
    );
  }
  const effort = o.effort ?? profile.efforts[0];
  const parsed = ProfileEffort.safeParse(effort);
  if (!parsed.success || !profile.efforts.includes(parsed.data)) {
    throw new OmiError(
      "USAGE_INVALID",
      `profile ${profile.name} offers efforts ${profile.efforts.join(", ")}`,
    );
  }
  const reason = o.reason?.trim();
  if (!reason) throw new OmiError("USAGE_INVALID", "--reason is required with --profile");
  return { profile, model, effort: parsed.data, reason, secret: () => resolveSecret(profile) };
}
