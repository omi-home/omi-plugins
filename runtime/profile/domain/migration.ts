// Plan of `omi profile import` (Feature-0044 #337): what to do with each profile of the sources (rows
// of the workspace `profile_legacy`) against the machine profile DB. Pure: no fs, no sqlite, no
// crypto. Tokens are compared by an injected function, so a plaintext never enters this module and
// a report carries names and field names only.
import type { Profile } from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import type { SealedSecret } from "./secrets.ts";

export type Resolution = "machine" | "workspace";

/** A profile with its sealed token as stored (never plaintext). */
export interface ProfileEntry {
  profile: Profile;
  sealed: SealedSecret | null;
  updatedAt: string;
}

/** Result of comparing two sealed tokens of one name; "unverifiable" = another key or no key. */
export type TokenComparison = "equal" | "differs" | "unverifiable";
export type TokensEqual = (name: string, a: SealedSecret, b: SealedSecret) => TokenComparison;

/** "[REDACTED]" stands for equal tokens: the report never says more than that. */
export type ConflictToken = "[REDACTED]" | "differs" | "unverifiable" | "absent";

export interface Conflict {
  name: string;
  /** Names of the Profile fields that differ (never values). */
  fields: string[];
  token: ConflictToken;
}

export interface ImportPlan {
  /** Absent from the machine DB: copy the row verbatim, sealed columns included. */
  copy: ProfileEntry[];
  /** Same profile, the machine row has no token and the source does: copy the sealed columns. */
  tokenFilled: ProfileEntry[];
  /** Nothing to write, only marked migrated. */
  identical: string[];
  /** `--resolve <name>=workspace`: the source row replaces the machine row. */
  overwrite: ProfileEntry[];
  /** `--resolve <name>=machine`: the machine row stays. */
  keep: string[];
  /** Conflicts nobody resolved: while any is left nothing may be written. */
  conflicts: Conflict[];
  resolved: { name: string; choice: Resolution }[];
  /** Source names to stamp migrated; empty while there is an unresolved conflict. */
  migrate: string[];
}

const FIELDS = ["harness", "disabled", "auth", "models", "efforts"] as const;

/** JSON with sorted keys: two equal declarations compare equal whatever their key order. */
export function canonicalJson(v: unknown): string {
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

const differingFields = (a: Profile, b: Profile): string[] =>
  FIELDS.filter((f) => canonicalJson(a[f]) !== canonicalJson(b[f]));

function tokenState(
  name: string,
  machine: SealedSecret | null,
  source: SealedSecret | null,
  tokensEqual: TokensEqual,
): ConflictToken {
  if (!machine && !source) return "absent";
  if (!machine || !source) return "differs";
  const same =
    machine.ciphertext === source.ciphertext &&
    machine.iv === source.iv &&
    machine.tag === source.tag &&
    machine.keyFingerprint === source.keyFingerprint;
  if (same) return "[REDACTED]";
  const c = tokensEqual(name, machine, source);
  return c === "equal" ? "[REDACTED]" : c;
}

export function planProfileImport(
  machine: readonly ProfileEntry[],
  sources: readonly ProfileEntry[],
  resolutions: ReadonlyMap<string, Resolution>,
  tokensEqual: TokensEqual,
): ImportPlan {
  const names = new Set(sources.map((s) => s.profile.name));
  for (const n of resolutions.keys()) {
    if (!names.has(n)) {
      throw new OmiError("USAGE_INVALID", `--resolve ${n}: no profile of that name to import`);
    }
  }
  const byName = new Map(machine.map((m) => [m.profile.name, m]));
  const plan: ImportPlan = {
    copy: [],
    tokenFilled: [],
    identical: [],
    overwrite: [],
    keep: [],
    conflicts: [],
    resolved: [],
    migrate: [],
  };
  for (const s of sources) {
    const name = s.profile.name;
    const m = byName.get(name);
    if (!m) {
      plan.copy.push(s);
      continue;
    }
    const fields = differingFields(m.profile, s.profile);
    if (!fields.length) {
      // Deliberate (Coordinator, review #359 CR-001): a source row without a token adds nothing
      // to a machine row with the same fields, so it is `identical` (only marked migrated).
      if (!s.sealed) plan.identical.push(name);
      else if (!m.sealed) plan.tokenFilled.push(s);
      else {
        const token = tokenState(name, m.sealed, s.sealed, tokensEqual);
        if (token === "[REDACTED]") plan.identical.push(name);
        else plan.conflicts.push({ name, fields, token });
      }
      continue;
    }
    plan.conflicts.push({ name, fields, token: tokenState(name, m.sealed, s.sealed, tokensEqual) });
  }
  // Apply the person's choices to the conflicts found above.
  const open: Conflict[] = [];
  for (const c of plan.conflicts) {
    const choice = resolutions.get(c.name);
    if (!choice) {
      open.push(c);
      continue;
    }
    plan.resolved.push({ name: c.name, choice });
    if (choice === "machine") plan.keep.push(c.name);
    else plan.overwrite.push(sources.find((s) => s.profile.name === c.name) as ProfileEntry);
  }
  plan.conflicts = open;
  if (!open.length) plan.migrate = sources.map((s) => s.profile.name);
  return plan;
}
