// `omi profile list|add|edit|remove|set-token|import` (ADR-0004 D3). Tokens arrive on stdin only,
// are sealed (AES-256-GCM) before they touch the database, and are never returned by any command.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import {
  type Profile,
  ProfileEdit,
  ProfileView,
  ProfileWrite,
  parseContract,
} from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { type Db, tx } from "../../shared/sqlite/db.ts";
import {
  assertNoLegacyProfiles,
  keyEnvName,
  readLegacyProfiles,
} from "../adapters/profile-config.ts";
import {
  existingProfileDb,
  withExistingProfileDb,
  withProfileDb,
} from "../adapters/profile-store.ts";
import {
  addProfile,
  getProfileRecord,
  insertProfileRow,
  listProfileRecords,
  type ProfileRecord,
  removeProfile,
  setSealedSecret,
  updateProfile,
  writeSealed,
} from "../adapters/profiles.ts";
import { encryptSecret, loadMasterKey, type SealedSecret } from "../domain/secrets.ts";
import { secretEnv } from "../domain/selection.ts";

export interface ProfileDeps {
  workspace: string;
  env: NodeJS.ProcessEnv;
  /** The whole of stdin: the only way a token reaches OMI. */
  stdin: () => string;
  now?: () => Date;
}

/** Flags of `profile add|edit` (all strings from argv; no secret among them). */
export interface ProfileFlags {
  harness?: string;
  auth?: string;
  tokenEnv?: string;
  keyEnv?: string;
  baseUrl?: string;
  scheme?: string;
  models?: string;
  efforts?: string;
  disabled?: boolean;
  enabled?: boolean;
}

const nowIso = (d: ProfileDeps) => (d.now?.() ?? new Date()).toISOString();

export const toView = (r: ProfileRecord): ProfileView =>
  ProfileView.parse({
    ...r.profile,
    hasToken: r.sealed !== null,
    keyFingerprint: r.sealed?.keyFingerprint ?? null,
    updatedAt: r.updatedAt,
  });

/** Writers: the machine DB, created when missing. */
const withDb = <T>(d: ProfileDeps, fn: (db: Db) => T): T => withProfileDb(d.env, fn);

/** Changes to an existing profile: no machine DB means no such profile, and nothing is created. */
const withDbOf = <T>(d: ProfileDeps, name: string, fn: (db: Db) => T): T => {
  if (!existingProfileDb(d.env)) {
    throw new OmiError("USAGE_INVALID", `no profile ${name}: see \`omi profile list\``);
  }
  return withDb(d, fn);
};

const csv = (v: string | undefined) =>
  v === undefined
    ? undefined
    : v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

/** Reads and trims the token from stdin; never echoed, never an argument. */
function readToken(d: ProfileDeps): string {
  const token = d.stdin().trim();
  if (!token) throw new OmiError("USAGE_INVALID", "the token is read from stdin: pipe it in");
  if (token.length > 4096) throw new OmiError("USAGE_INVALID", "the token on stdin is too long");
  return token;
}

const masterKey = (d: ProfileDeps) => loadMasterKey(d.env, keyEnvName(d.workspace));

/** A profile's token variable must not be the master key variable (or its `_NEXT`): SEC-001. */
function assertNotMasterKeyVar(d: ProfileDeps, p: Profile): void {
  const keyEnv = keyEnvName(d.workspace).toUpperCase();
  const name = secretEnv(p).toUpperCase();
  if (name === keyEnv || name === `${keyEnv}_NEXT`) {
    throw new OmiError(
      "CONFIG_INVALID",
      `profile ${p.name}: ${secretEnv(p)} is the master key variable, not a token variable`,
    );
  }
}

export function profileList(d: ProfileDeps): ProfileView[] {
  assertNoLegacyProfiles(d.workspace);
  return withExistingProfileDb(d.env, (db) => listProfileRecords(db).map(toView), []);
}

/** Merges auth flags over the current auth (edit) or builds it from nothing (add). */
function authFrom(f: ProfileFlags, base?: Profile["auth"]): unknown {
  const touched = [f.auth, f.tokenEnv, f.keyEnv, f.baseUrl, f.scheme].some((x) => x !== undefined);
  if (!touched) return base;
  const type = f.auth ?? base?.type;
  const same = base && base.type === type ? base : undefined;
  if (type === "subscription") {
    return { type, tokenEnv: f.tokenEnv ?? (same?.type === "subscription" ? same.tokenEnv : "") };
  }
  const g = same?.type === "gateway" ? same : undefined;
  return {
    type,
    baseUrl: f.baseUrl ?? g?.baseUrl,
    scheme: f.scheme ?? g?.scheme,
    keyEnv: f.keyEnv ?? g?.keyEnv,
  };
}

export function profileAdd(
  d: ProfileDeps,
  name: string | undefined,
  f: ProfileFlags,
  withToken: boolean,
): ProfileView {
  assertNoLegacyProfiles(d.workspace);
  if (!name) throw new OmiError("USAGE_INVALID", "expected a profile name");
  if (f.disabled && f.enabled) {
    throw new OmiError("USAGE_INVALID", "--disabled and --enabled are exclusive");
  }
  const profile = parseContract(
    ProfileWrite,
    {
      name,
      harness: f.harness ?? "claudecode",
      disabled: f.disabled ?? false,
      auth: authFrom(f),
      models: csv(f.models),
      efforts: csv(f.efforts),
    },
    "profile",
  );
  assertNotMasterKeyVar(d, profile);
  let sealed: SealedSecret | null = null;
  if (withToken) sealed = encryptSecret(masterKey(d), profile.name, readToken(d));
  const now = nowIso(d);
  withDb(d, (db) => addProfile(db, profile, sealed, now));
  return withDb(d, (db) => toView(requireProfile(db, profile.name)));
}

function requireProfile(db: Db, name: string): ProfileRecord {
  const r = getProfileRecord(db, name);
  if (!r) throw new OmiError("USAGE_INVALID", `no profile ${name}: see \`omi profile list\``);
  return r;
}

export function profileEdit(
  d: ProfileDeps,
  name: string | undefined,
  f: ProfileFlags & { name?: string },
): ProfileView {
  assertNoLegacyProfiles(d.workspace);
  if (!name) throw new OmiError("USAGE_INVALID", "expected a profile name");
  // The name is the key and the AAD of the sealed token (ARC-006).
  if (f.name !== undefined) {
    throw new OmiError(
      "USAGE_INVALID",
      "a profile name cannot be changed: add a new profile and remove the old one",
    );
  }
  if (f.harness !== undefined && f.harness !== "claudecode") {
    throw new OmiError("USAGE_INVALID", "harness must be claudecode");
  }
  if (f.disabled && f.enabled) {
    throw new OmiError("USAGE_INVALID", "--disabled and --enabled are exclusive");
  }
  return withDbOf(d, name, (db) => {
    const current = requireProfile(db, name).profile;
    const auth = authFrom(f, current.auth);
    const edit = parseContract(
      ProfileEdit,
      {
        ...(f.disabled || f.enabled ? { disabled: Boolean(f.disabled) } : {}),
        ...(auth !== current.auth ? { auth } : {}),
        ...(f.models !== undefined ? { models: csv(f.models) } : {}),
        ...(f.efforts !== undefined ? { efforts: csv(f.efforts) } : {}),
      },
      "profile edit",
    );
    if (!Object.keys(edit).length) {
      throw new OmiError("USAGE_INVALID", "nothing to change: pass at least one field");
    }
    const next = parseContract(ProfileWrite, { ...current, ...edit }, "profile");
    assertNotMasterKeyVar(d, next);
    updateProfile(db, next, nowIso(d));
    return toView(requireProfile(db, name));
  });
}

export function profileRemove(d: ProfileDeps, name: string | undefined): { removed: string } {
  assertNoLegacyProfiles(d.workspace);
  if (!name) throw new OmiError("USAGE_INVALID", "expected a profile name");
  withDbOf(d, name, (db) => removeProfile(db, name));
  return { removed: name };
}

export function profileSetToken(d: ProfileDeps, name: string | undefined): ProfileView {
  assertNoLegacyProfiles(d.workspace);
  if (!name) throw new OmiError("USAGE_INVALID", "expected a profile name");
  return withDbOf(d, name, (db) => {
    requireProfile(db, name);
    const sealed = encryptSecret(masterKey(d), name, readToken(d));
    setSealedSecret(db, name, sealed, nowIso(d));
    return toView(requireProfile(db, name));
  });
}

export interface ImportResult {
  dryRun: boolean;
  /** Profiles inserted into the database. */
  imported: string[];
  /** Profiles already in the database (kept as they are). */
  kept: string[];
  /** Kept profiles whose legacy declaration differs from the database: fix with `omi profile edit`. */
  differing: string[];
  /** Profiles whose token was sealed from the env variable they declared. */
  tokensStored: string[];
  /** Profiles left without a token: their declared env variable is not set. */
  tokensMissing: string[];
  /** Legacy files moved aside (or copied, for the YAML section). The env variables are kept (ARC-004). */
  backups: string[];
}

/** JSON with sorted keys: two equal declarations compare equal whatever their key order. */
function canonical(v: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(sort)
      : x && typeof x === "object"
        ? Object.fromEntries(
            Object.entries(x as Record<string, unknown>)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, val]) => [k, sort(val)]),
          )
        : x;
  return JSON.stringify(sort(v));
}

const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

/**
 * One-time move of `omi.config.json` / the YAML `profiles` section into the database. Safe to
 * re-run: existing profiles are kept, a missing token is filled in, nothing is left to do once the
 * legacy files are gone. Never unsets an env variable.
 */
export function profileImport(d: ProfileDeps, dryRun: boolean): ImportResult {
  const legacy = readLegacyProfiles(d.workspace);
  const declared = [...(legacy.json?.profiles ?? []), ...(legacy.yaml?.profiles ?? [])];
  const names = declared.map((p) => p.name);
  if (new Set(names).size !== names.length) {
    throw new OmiError("CONFIG_INVALID", "duplicate profile name across the legacy files");
  }
  for (const p of declared) assertNotMasterKeyVar(d, p);
  const result: ImportResult = {
    dryRun,
    imported: [],
    kept: [],
    differing: [],
    tokensStored: [],
    tokensMissing: [],
    backups: [],
  };
  if (!declared.length && !legacy.json && !legacy.yaml) return result;

  const existing = withExistingProfileDb(d.env, (db) => listProfileRecords(db), []);
  const byName = new Map(existing.map((r) => [r.profile.name, r]));

  const plan = declared.map((p) => {
    const current = byName.get(p.name);
    const value = current?.sealed ? undefined : d.env[secretEnv(p)]?.trim();
    return { profile: p, exists: current !== undefined, token: value || undefined };
  });
  for (const x of plan) {
    if (x.exists) {
      result.kept.push(x.profile.name);
      const current = byName.get(x.profile.name)?.profile;
      if (canonical(current) !== canonical(x.profile)) {
        result.differing.push(x.profile.name);
      }
    } else result.imported.push(x.profile.name);
    if (x.token) result.tokensStored.push(x.profile.name);
    else if (!byName.get(x.profile.name)?.sealed) result.tokensMissing.push(x.profile.name);
  }
  const ts = stamp(d.now?.() ?? new Date());
  const bakNames = [
    ...(legacy.json ? [`${legacy.json.path}.${ts}.bak`] : []),
    ...(legacy.yaml ? [`${legacy.yaml.path}.${ts}.bak`] : []),
  ];
  if (dryRun) return { ...result, backups: bakNames };

  // The key is needed only when a token is to be sealed; check before anything changes.
  const key = plan.some((x) => x.token) ? masterKey(d) : undefined;
  const now = nowIso(d);
  withDb(d, (db) =>
    tx(db, "import profiles", () => {
      for (const x of plan) {
        const sealed =
          key && x.token
            ? encryptSecret(key, x.profile.name, x.token)
            : (null as SealedSecret | null);
        if (!x.exists) insertProfileRow(db, x.profile, sealed, now);
        else if (sealed) writeSealed(db, x.profile.name, sealed, now);
      }
    }),
  );

  // Files move only after the transaction committed; a crash in between re-runs cleanly.
  if (legacy.json) {
    const from = join(d.workspace, legacy.json.path);
    renameSync(from, `${from}.${ts}.bak`);
  }
  if (legacy.yaml) {
    const from = join(d.workspace, legacy.yaml.path);
    const original = readFileSync(from, "utf8");
    writeFileSync(`${from}.${ts}.bak`, original);
    const doc = parseDocument(original);
    doc.delete("profiles");
    writeFileSync(from, doc.toString());
  }
  result.backups = bakNames;
  return result;
}
