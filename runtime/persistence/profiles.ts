// Execution profiles in `state.sqlite` (ADR-0004 D3). The typed single writer of the `profile` table;
// sealed tokens come and go as SealedSecret, never as plaintext.

import type { SealedSecret } from "../core/secrets.ts";
import { type Profile, Profile as ProfileSchema, parseContract } from "../shared/contracts.ts";
import { OmiError } from "../shared/errors/errors.ts";
import { type Db, tx } from "../shared/sqlite/db.ts";

interface Row {
  name: string;
  harness: string;
  disabled: number;
  auth: string;
  models: string;
  efforts: string;
  secret_ciphertext: string | null;
  secret_iv: string | null;
  secret_tag: string | null;
  key_fingerprint: string | null;
  updated_at: string;
}

export interface ProfileRecord {
  profile: Profile;
  sealed: SealedSecret | null;
  updatedAt: string;
}

const toRecord = (r: Row): ProfileRecord => {
  const sealed =
    r.secret_ciphertext && r.secret_iv && r.secret_tag && r.key_fingerprint
      ? {
          ciphertext: r.secret_ciphertext,
          iv: r.secret_iv,
          tag: r.secret_tag,
          keyFingerprint: r.key_fingerprint,
        }
      : null;
  let data: unknown;
  try {
    data = {
      name: r.name,
      harness: r.harness,
      disabled: r.disabled === 1,
      auth: JSON.parse(r.auth),
      models: JSON.parse(r.models),
      efforts: JSON.parse(r.efforts),
    };
  } catch {
    throw new OmiError("INTERNAL", `profile ${r.name}: stored row is unreadable`);
  }
  return {
    profile: parseContract(ProfileSchema, data, `profile ${r.name}`),
    sealed,
    updatedAt: r.updated_at,
  };
};

export const listProfileRecords = (db: Db): ProfileRecord[] =>
  (db.prepare("SELECT * FROM profile ORDER BY rowid").all() as unknown as Row[]).map(toRecord);

export const getProfileRecord = (db: Db, name: string): ProfileRecord | undefined => {
  const row = db.prepare("SELECT * FROM profile WHERE name = ?").get(name) as unknown as
    | Row
    | undefined;
  return row ? toRecord(row) : undefined;
};

/** True once any token is sealed: `init-key` must then refuse (a new key would orphan them). */
export const hasAnySealedSecret = (db: Db): boolean =>
  db.prepare("SELECT 1 AS x FROM profile WHERE secret_ciphertext IS NOT NULL LIMIT 1").get() !==
  undefined;

const fields = (p: Profile) =>
  [p.harness, p.disabled ? 1 : 0, JSON.stringify(p.auth), JSON.stringify(p.models)] as const;

const insertSql = `INSERT INTO profile
  (name, harness, disabled, auth, models, efforts, secret_ciphertext, secret_iv, secret_tag, key_fingerprint, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Inserts inside the caller's transaction. A duplicate name is CONTRACT_INVALID. */
export function insertProfileRow(
  db: Db,
  p: Profile,
  sealed: SealedSecret | null,
  now: string,
): void {
  if (db.prepare("SELECT 1 AS x FROM profile WHERE name = ?").get(p.name)) {
    throw new OmiError("CONTRACT_INVALID", `profile ${p.name} already exists`);
  }
  const [harness, disabled, auth, models] = fields(p);
  db.prepare(insertSql).run(
    p.name,
    harness,
    disabled,
    auth,
    models,
    JSON.stringify(p.efforts),
    sealed?.ciphertext ?? null,
    sealed?.iv ?? null,
    sealed?.tag ?? null,
    sealed?.keyFingerprint ?? null,
    now,
  );
}

export const addProfile = (db: Db, p: Profile, sealed: SealedSecret | null, now: string): void =>
  tx(db, "add profile", () => insertProfileRow(db, p, sealed, now));

/** Replaces the mutable fields of an existing profile (the name is the key and the AAD: immutable). */
export function updateProfile(db: Db, p: Profile, now: string): void {
  tx(db, "edit profile", () => {
    const [harness, disabled, auth, models] = fields(p);
    const r = db
      .prepare(
        "UPDATE profile SET harness = ?, disabled = ?, auth = ?, models = ?, efforts = ?, updated_at = ? WHERE name = ?",
      )
      .run(harness, disabled, auth, models, JSON.stringify(p.efforts), now, p.name);
    if (r.changes === 0) throw new OmiError("USAGE_INVALID", `no profile ${p.name}`);
  });
}

export function removeProfile(db: Db, name: string): void {
  tx(db, "remove profile", () => {
    const r = db.prepare("DELETE FROM profile WHERE name = ?").run(name);
    if (r.changes === 0) throw new OmiError("USAGE_INVALID", `no profile ${name}`);
  });
}

/** Runs inside the caller's transaction (rotate-key) or alone via `setSealedSecret`. */
export function writeSealed(db: Db, name: string, s: SealedSecret, now: string): void {
  const r = db
    .prepare(
      "UPDATE profile SET secret_ciphertext = ?, secret_iv = ?, secret_tag = ?, key_fingerprint = ?, updated_at = ? WHERE name = ?",
    )
    .run(s.ciphertext, s.iv, s.tag, s.keyFingerprint, now, name);
  if (r.changes === 0) throw new OmiError("USAGE_INVALID", `no profile ${name}`);
}

export const setSealedSecret = (db: Db, name: string, s: SealedSecret, now: string): void =>
  tx(db, "set token", () => writeSealed(db, name, s, now));
