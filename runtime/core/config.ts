// OMI configuration contract with safe defaults (spec §3, §7, §9, §14, §20).
// Project config lives in <workspace>/.omi-plugins/omi.config.yaml (ADR-0002 D1); plugin config/
// holds only default policies.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { openState } from "../persistence/db.ts";
import { getProfileRecord, listProfileRecords } from "../persistence/profiles.ts";
import { registerSecret } from "../reporting/redact.ts";
import {
  GateCheck,
  LegacyProfilesFile,
  type Profile,
  ProfileEffort,
  parseContract,
  Role,
  WorkflowModel,
} from "./contracts.ts";
import { OmiError } from "./errors/errors.ts";
import { DEFAULT_KEY_ENV, decryptSecret, loadMasterKey } from "./secrets.ts";
import { resolveWorkflow } from "./workflow-config.ts";
import { CONFIG_FILE, PROFILES_FILE, STATE_FILE } from "./workspace.ts";

const ModelAlias = z.enum(["sonnet", "opus", "haiku"]);
const Effort = z.enum(["low", "medium", "high"]);

const route = (model: z.infer<typeof ModelAlias>) =>
  z.strictObject({ model: ModelAlias, effort: Effort }).default({ model, effort: "medium" });

const OPUS_ROLES = new Set<Role>(["solution-architect", "code-reviewer", "security-reviewer"]);

const ModelRouting = z.strictObject(
  Object.fromEntries(
    Role.options.map((r) => [r, route(OPUS_ROLES.has(r) ? "opus" : "sonnet")]),
  ) as {
    [K in Role]: ReturnType<typeof route>;
  },
);

/** A repo command run through the platform shell in the task worktree. */
const GateCommand = z.strictObject({
  run: z.string().trim().min(1).max(500),
  timeoutSec: z.int().min(1).max(3600).default(600),
});

const GateChecks = z.strictObject(
  Object.fromEntries(GateCheck.options.map((c) => [c, GateCommand.optional()])) as {
    [K in GateCheck]: z.ZodOptional<typeof GateCommand>;
  },
);

/** Names the env variable of the master key; the key itself never lives in the config (ADR-0004 D4). */
const SecretsConfig = z.strictObject({
  keyEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "expected an environment variable name")
    .default(DEFAULT_KEY_ENV),
});

export const OmiConfig = z.strictObject({
  secrets: SecretsConfig.prefault({}),
  github: z.strictObject({
    owner: z.string().regex(/^[\w.-]+$/),
    repo: z.string().regex(/^[\w.-]+$/),
    projectNumber: z.int().positive(),
    /** Private repo on GitHub Free has no server-side protection (ADR-0001 D5). */
    privateRepoRiskAccepted: z.boolean().default(false),
    /** Workflow model: `legacy` (type:* labels) until Project #2 migrates to `v2` (ADR-0005 D8). */
    model: WorkflowModel.default("legacy"),
    /** Override of config/github/workflow.yaml; merged and validated by workflow-config.ts. */
    workflow: z
      .record(z.string(), z.unknown())
      .optional()
      .superRefine((override, ctx) => {
        if (override === undefined) return;
        try {
          resolveWorkflow(override);
        } catch (e) {
          ctx.addIssue({ code: "custom", message: (e as Error).message });
        }
      }),
  }),
  git: z
    .strictObject({
      baseBranch: z.string().min(1).default("develop"),
      releaseBranch: z.string().min(1).default("main"),
      mergeMethod: z.enum(["squash", "merge", "rebase"]).default("squash"),
    })
    .prefault({}),
  review: z
    .strictObject({
      // Fixed by policy (spec §10): 2 rounds, Architect, 2 more rounds.
      maxRounds: z.literal(4).default(4),
      architectAfterFailedRounds: z.literal(2).default(2),
      // PO-accepted defaults (2026-11-17, spec §10).
      maxAttempts: z.int().min(1).max(10).default(3),
      maxValidationFixes: z.int().min(0).max(10).default(2),
      maxQaReworks: z.int().min(0).max(10).default(2),
    })
    .prefault({}),
  agents: z
    .strictObject({
      maxConcurrent: z.int().min(1).max(3).default(3),
      routing: ModelRouting.prefault({}),
    })
    .prefault({}),
  /** Optional dependency install run in a task clone, e.g. `npm ci`, before agent and checks. */
  setup: GateCommand.optional(),
  /** Unset checks are skipped; a repo with none configured has no deterministic gate. */
  checks: GateChecks.prefault({}),
  context: z
    .strictObject({
      /** Context items the PO keeps (`omi context plan`): plugin/skill/MCP server names, paths. */
      keep: z.array(z.string().min(1).max(500)).max(200).default([]),
    })
    .prefault({}),
  cleanup: z
    .strictObject({
      // Remote branch deletion is never assumed safe (spec §14).
      deleteRemoteBranch: z.boolean().default(false),
      logRetentionDays: z.int().min(1).default(14),
    })
    .prefault({}),
});
export type OmiConfig = z.infer<typeof OmiConfig>;

/** The single place that answers which workflow model is in use. */
export const workflowModel = (config: Pick<OmiConfig, "github">): WorkflowModel =>
  config.github.model;

export const parseConfig = (input: unknown): OmiConfig =>
  parseContract(OmiConfig, input, "config", "CONFIG_INVALID");

export const CONFIG_PATH = CONFIG_FILE;

/** Parsed YAML of the workspace config, or undefined when the file is missing. */
export function readConfigData(workspace: string): unknown {
  let text: string;
  try {
    text = readFileSync(join(workspace, CONFIG_PATH), "utf8");
  } catch {
    return undefined;
  }
  try {
    return parse(text) ?? null;
  } catch (e) {
    const line = (e as { linePos?: { line: number }[] }).linePos?.[0]?.line;
    throw new OmiError("CONFIG_INVALID", `${CONFIG_PATH}: invalid YAML`, { line });
  }
}

/** Reads and validates `<workspace>/.omi-plugins/omi.config.yaml`. Errors never echo values. */
export function loadConfig(workspace: string): OmiConfig {
  const data = readConfigData(workspace);
  if (data === undefined) throw new OmiError("CONFIG_INVALID", `${CONFIG_PATH} not found`);
  if (data === null) {
    throw new OmiError(
      "CONFIG_INVALID",
      `${CONFIG_PATH} has no settings yet: run \`omi github project init\``,
    );
  }
  return parseConfig(data);
}

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
