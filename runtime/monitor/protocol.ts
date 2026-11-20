// Contracts shared with omi-monitor (ADR-0004 D1): the `--output json` envelope and the data of the
// commands the web app calls. JSON Schemas of these are generated into schemas/monitor/.
import { z } from "zod";
import { OmiConfig } from "../core/config.ts";
import { ProfileAuth, ProfileEffort } from "../core/contracts.ts";
import { ERROR_CODES } from "../core/errors/errors.ts";

/**
 * Version of the wire protocol between `omi` and omi-monitor (envelope + monitor command data).
 *
 * Bump rules (omi-monitor shows "update needed" on any mismatch and never guesses):
 * - Bump on every change a client built from the previous schemas could misread: a field removed,
 *   renamed, retyped or made required; an enum value removed; a changed meaning.
 * - Also bump when an enum gains a value or a field is added to a strict input contract
 *   (ConfigSetInput, ProfileWrite, ProfileEdit): an older client cannot send or switch on it.
 * - Do not bump for an optional output field, a new command, or a new error code.
 * - A bump regenerates `schemas/monitor/*.schema.json` (`OMI_UPDATE_SCHEMAS=1 npm test`) in the same PR
 *   and pairs with the omi-monitor release pinned in `config/web.json`.
 */
export const MONITOR_PROTOCOL_VERSION = 1;

const ErrorBody = z.strictObject({
  code: z.enum(
    Object.keys(ERROR_CODES) as [keyof typeof ERROR_CODES, ...(keyof typeof ERROR_CODES)[]],
  ),
  message: z.string(),
  transient: z.boolean(),
  details: z.unknown().optional(),
});

/** Every `--output json` stdout: one line. `ok` false carries `error` (or `data` of a failed check). */
export const Envelope = z.strictObject({
  ok: z.boolean(),
  command: z.string(),
  protocolVersion: z.literal(MONITOR_PROTOCOL_VERSION),
  data: z.unknown().optional(),
  error: ErrorBody.optional(),
});
export type Envelope = z.infer<typeof Envelope>;

// ---- Profiles (`omi profile …`): the secret never appears; it travels on stdin only ----

const profileBody = {
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "expected lowercase letters, digits, -"),
  harness: z.literal("claudecode"),
  disabled: z.boolean().default(false),
  models: z
    .array(z.string().regex(/^[\w.:[\]-]{1,100}$/))
    .min(1)
    .max(20),
  efforts: z.array(ProfileEffort).min(1),
};

/** What the web shows: the secret is a mask, never the value. */
export const ProfileView = z.strictObject({
  ...profileBody,
  auth: ProfileAuth,
  hasSecret: z.boolean(),
  secret: z.literal("********").nullable(),
  updatedAt: z.string().nullable(),
});
export type ProfileView = z.infer<typeof ProfileView>;

/** `profile add`: the name is immutable once written (ADR-0004 D3). */
export const ProfileWrite = z.strictObject({ ...profileBody, auth: ProfileAuth });
export type ProfileWrite = z.infer<typeof ProfileWrite>;

/** `profile edit`: every field but the name is optional; the name selects the profile. */
export const ProfileEdit = z.strictObject({
  name: profileBody.name,
  disabled: z.boolean().optional(),
  auth: ProfileAuth.optional(),
  models: profileBody.models.optional(),
  efforts: profileBody.efforts.optional(),
});
export type ProfileEdit = z.infer<typeof ProfileEdit>;

// ---- Settings (`omi config get|set`) ----

/** Segments of a dotted config path, e.g. `checks.test.run`. */
const ConfigPath = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z0-9-]+)*$/, "expected a dotted path like checks.test.run");

/** One edit: set a value, or remove an optional key. */
export const ConfigChange = z.union([
  z.strictObject({ path: ConfigPath, value: z.unknown() }),
  z.strictObject({ path: ConfigPath, unset: z.literal(true) }),
]);

export const ConfigSetInput = z.strictObject({
  changes: z.array(ConfigChange).min(1).max(100),
});
export type ConfigSetInput = z.infer<typeof ConfigSetInput>;

export const ConfigGetData = z.strictObject({
  path: z.string().nullable(),
  value: z.unknown(),
  /** sha256 of the file; pass it back as `config set --if-match`. */
  etag: z.string(),
});

export const ConfigSetData = z.strictObject({
  changed: z.boolean(),
  etag: z.string(),
  config: OmiConfig,
});

/** Schemas exported to schemas/monitor/<name>.schema.json, with the direction they describe. */
export const MONITOR_SCHEMAS: Record<string, { schema: z.ZodType; io: "input" | "output" }> = {
  envelope: { schema: Envelope, io: "output" },
  ProfileView: { schema: ProfileView, io: "output" },
  ProfileWrite: { schema: ProfileWrite, io: "input" },
  ProfileEdit: { schema: ProfileEdit, io: "input" },
  ConfigSetInput: { schema: ConfigSetInput, io: "input" },
  ConfigGetData: { schema: ConfigGetData, io: "output" },
  ConfigSetData: { schema: ConfigSetData, io: "output" },
  OmiConfig: { schema: OmiConfig, io: "input" },
};

/** Deterministic text of one generated schema. */
export const renderSchema = (name: string): string => {
  const entry = MONITOR_SCHEMAS[name];
  if (!entry) throw new Error(`unknown monitor schema ${name}`);
  const json = z.toJSONSchema(entry.schema, { io: entry.io, unrepresentable: "any" });
  return `${JSON.stringify({ title: name, protocolVersion: MONITOR_PROTOCOL_VERSION, ...json }, null, 2)}\n`;
};
