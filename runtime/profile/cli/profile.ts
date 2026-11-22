// `omi profile list|add|edit|remove|set-token|import` (ADR-0004 D3). Tokens arrive on stdin only,
// are sealed (AES-256-GCM) before they touch the database, and are never returned by any command.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
import { type Db, openState, tx } from "../../shared/sqlite/db.ts";
import { STATE_FILE } from "../../shared/workspace.ts";
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
  listLegacyRows,
  listProfileRecords,
  markLegacyMigrated,
  type ProfileRecord,
  removeProfile,
  setSealedSecret,
  updateProfile,
  upsertProfileRow,
  writeSealed,
} from "../adapters/profiles.ts";
import {
  type Conflict,
  canonicalJson,
  type ProfileEntry,
  planProfileImport,
  type Resolution,
  type TokensEqual,
} from "../domain/migration.ts";
import {
  decryptSecret,
  encryptSecret,
  keyFingerprint,
  loadMasterKey,
  type SealedSecret,
} from "../domain/secrets.ts";
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
  /** Workspace rows equal to the machine profile: only marked migrated. */
  identical: string[];
  /** Workspace rows whose sealed token was copied into a machine profile that had none. */
  tokenFilled: string[];
  /** Unresolved conflicts: names and field names only, never a value. */
  conflicts: Conflict[];
  /** Conflicts settled by `--resolve`. */
  resolved: { name: string; choice: Resolution }[];
  /** Rows of the workspace `profile_legacy` marked migrated (in a dry run: that would be). */
  legacyMigrated: string[];
}

/** `--resolve <name>=machine|workspace` (repeatable) into a map; bad syntax is USAGE_INVALID. */
export function parseResolutions(specs: readonly string[]): Map<string, Resolution> {
  const out = new Map<string, Resolution>();
  for (const spec of specs) {
    const i = spec.lastIndexOf("=");
    const name = i > 0 ? spec.slice(0, i) : "";
    const choice = spec.slice(i + 1);
    if (!name || (choice !== "machine" && choice !== "workspace")) {
      throw new OmiError(
        "USAGE_INVALID",
        `--resolve expects <name>=machine|workspace, got "${name || spec}"`,
      );
    }
    if (out.has(name) && out.get(name) !== choice) {
      throw new OmiError("USAGE_INVALID", `--resolve ${name} is given two different choices`);
    }
    out.set(name, choice);
  }
  return out;
}

/** In-memory comparison of two sealed tokens of one profile: the plaintext never leaves this function. */
function sealedComparer(d: ProfileDeps): TokensEqual {
  let key: Buffer | undefined;
  let loaded = false;
  return (name, a, b) => {
    if (!loaded) {
      loaded = true;
      try {
        key = masterKey(d);
      } catch {
        key = undefined;
      }
    }
    if (!key) return "unverifiable";
    const fp = keyFingerprint(key);
    if (a.keyFingerprint !== fp || b.keyFingerprint !== fp) return "unverifiable";
    try {
      return decryptSecret(key, name, a) === decryptSecret(key, name, b) ? "equal" : "differs";
    } catch {
      return "unverifiable";
    }
  };
}

/** Unmigrated rows of the workspace `profile_legacy`; no state file means none. */
function readUnmigratedRows(d: ProfileDeps): ProfileEntry[] {
  const file = join(d.workspace, STATE_FILE);
  if (!existsSync(file)) return [];
  const db = openState(file);
  try {
    return listLegacyRows(db)
      .filter((r) => r.migratedAt === null)
      .map((r) => ({ profile: r.profile, sealed: r.sealed, updatedAt: r.updatedAt }));
  } finally {
    db.close();
  }
}

const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

/**
 * Moves the profiles of this workspace onto the machine profile DB: the unmigrated rows of
 * `profile_legacy` (copied verbatim, sealed columns included, never decrypted to disk) and the legacy
 * `omi.config.json` / YAML declarations. Safe to re-run. A profile that differs from the machine one
 * is a conflict: only `--resolve <name>=machine|workspace` settles it, and until then nothing is
 * written (CONFIG_CONFLICT). Never unsets an env variable.
 */
export function profileImport(
  d: ProfileDeps,
  dryRun: boolean,
  resolve: readonly string[] = [],
): ImportResult {
  const resolutions = parseResolutions(resolve);
  const legacy = readLegacyProfiles(d.workspace);
  const declared = [...(legacy.json?.profiles ?? []), ...(legacy.yaml?.profiles ?? [])];
  const names = declared.map((p) => p.name);
  if (new Set(names).size !== names.length) {
    throw new OmiError("CONFIG_INVALID", "duplicate profile name across the legacy files");
  }
  for (const p of declared) assertNotMasterKeyVar(d, p);
  const rows = readUnmigratedRows(d);
  for (const r of rows) assertNotMasterKeyVar(d, r.profile);

  const existing = withExistingProfileDb(
    d.env,
    (db) =>
      listProfileRecords(db).map((r) => ({
        profile: r.profile,
        sealed: r.sealed,
        updatedAt: r.updatedAt,
      })),
    [] as ProfileEntry[],
  );
  const plan = planProfileImport(existing, rows, resolutions, sealedComparer(d));
  const result: ImportResult = {
    dryRun,
    imported: plan.copy.map((e) => e.profile.name),
    kept: [],
    differing: [],
    tokensStored: [],
    tokensMissing: [],
    backups: [],
    identical: plan.identical,
    tokenFilled: plan.tokenFilled.map((e) => e.profile.name),
    conflicts: plan.conflicts,
    resolved: plan.resolved,
    legacyMigrated: plan.migrate,
  };
  if (plan.conflicts.length && !dryRun) {
    throw new OmiError(
      "CONFIG_CONFLICT",
      `${plan.conflicts.length} profile(s) differ between this workspace and the machine profile database (${plan.conflicts.map((c) => c.name).join(", ")}): nothing was changed; settle each with \`omi profile import --resolve <name>=machine|workspace\``,
      { conflicts: plan.conflicts },
    );
  }
  if (!declared.length && !legacy.json && !legacy.yaml && !rows.length) return result;

  // The machine DB as it will be once the rows are applied: the files are planned against that.
  const projected = new Map(existing.map((e) => [e.profile.name, e]));
  for (const e of [...plan.copy, ...plan.overwrite]) projected.set(e.profile.name, e);
  for (const e of plan.tokenFilled) {
    const cur = projected.get(e.profile.name);
    if (cur) projected.set(e.profile.name, { ...cur, sealed: e.sealed });
  }

  const files = declared.map((p) => {
    const current = projected.get(p.name);
    const value = current?.sealed ? undefined : d.env[secretEnv(p)]?.trim();
    return { profile: p, current, token: value || undefined };
  });
  for (const x of files) {
    const name = x.profile.name;
    if (x.current) {
      result.kept.push(name);
      if (canonicalJson(x.current.profile) !== canonicalJson(x.profile)) {
        result.differing.push(name);
      }
    } else result.imported.push(name);
    if (x.token) result.tokensStored.push(name);
    else if (!x.current?.sealed) result.tokensMissing.push(name);
  }
  const ts = stamp(d.now?.() ?? new Date());
  const bakNames = [
    ...(legacy.json ? [`${legacy.json.path}.${ts}.bak`] : []),
    ...(legacy.yaml ? [`${legacy.yaml.path}.${ts}.bak`] : []),
  ];
  if (dryRun) return { ...result, backups: bakNames };

  // The key is needed only when a token is to be sealed; check before anything changes.
  const key = files.some((x) => x.token) ? masterKey(d) : undefined;
  const now = nowIso(d);
  const writes =
    plan.copy.length + plan.tokenFilled.length + plan.overwrite.length + files.length > 0;
  if (writes) {
    withDb(d, (db) =>
      tx(db, "import profiles", () => {
        // The plan was read outside this transaction (review #359 SEC-001): a `copy` name that
        // another workspace or omi-monitor added meanwhile must not be overwritten silently.
        const exists = db.prepare("SELECT 1 AS x FROM profile WHERE name = ?");
        for (const e of plan.copy) {
          if (exists.get(e.profile.name)) {
            throw new OmiError(
              "CONFIG_CONFLICT",
              `profile ${e.profile.name} was added to the machine profile database during import: run \`omi profile import\` again`,
              { conflicts: [{ name: e.profile.name, fields: [], token: "unverifiable" }] },
            );
          }
        }
        for (const e of [...plan.copy, ...plan.overwrite]) upsertProfileRow(db, e);
        for (const e of plan.tokenFilled) {
          if (e.sealed) writeSealed(db, e.profile.name, e.sealed, now);
        }
        for (const x of files) {
          const sealed =
            key && x.token
              ? encryptSecret(key, x.profile.name, x.token)
              : (null as SealedSecret | null);
          if (!projected.has(x.profile.name)) insertProfileRow(db, x.profile, sealed, now);
          else if (sealed) writeSealed(db, x.profile.name, sealed, now);
        }
      }),
    );
  }
  // Second transaction, on the workspace DB: a crash between the two re-runs as `identical`.
  if (plan.migrate.length) {
    const state = openState(join(d.workspace, STATE_FILE));
    try {
      markLegacyMigrated(state, plan.migrate, now);
    } finally {
      state.close();
    }
  }

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
