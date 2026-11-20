// OMI configuration contract with safe defaults (spec §3, §7, §9, §14, §20).
// Project config lives in <workspace>/.omi-plugins/omi.config.yaml (ADR-0002 D1); plugin config/
// holds only default policies.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  GateCheck,
  type Profile,
  ProfileEffort,
  ProfilesFile,
  parseContract,
  Role,
} from "./contracts.ts";
import { OmiError } from "./errors/errors.ts";
import { CONFIG_FILE, PROFILES_FILE } from "./workspace.ts";

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

export const OmiConfig = z.strictObject({
  github: z.strictObject({
    owner: z.string().regex(/^[\w.-]+$/),
    repo: z.string().regex(/^[\w.-]+$/),
    projectNumber: z.int().positive(),
    /** Private repo on GitHub Free has no server-side protection (ADR-0001 D5). */
    privateRepoRiskAccepted: z.boolean().default(false),
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

/**
 * Execution profiles of this machine (`<workspace>/.omi-plugins/omi.config.json`, never committed).
 * A missing file means no profile: steps keep the `agents.routing` defaults. Errors never echo values.
 */
export function loadProfiles(workspace: string): Profile[] {
  let text: string;
  try {
    text = readFileSync(join(workspace, PROFILES_FILE), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new OmiError("CONFIG_INVALID", `${PROFILES_FILE}: unreadable`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, "")); // editors on Windows may write a BOM
  } catch {
    throw new OmiError("CONFIG_INVALID", `${PROFILES_FILE}: invalid JSON`);
  }
  return parseContract(ProfilesFile, data, PROFILES_FILE, "CONFIG_INVALID").profiles;
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
}

/**
 * Validates `--profile/--model/--effort/--reason` against the machine's profiles (#217). No
 * `--profile` means no selection: steps keep the `agents.routing` defaults. Model and effort
 * default to the first the profile lists; the reason is required and recorded; the profile's
 * secret must be set, so nothing starts that cannot authenticate.
 */
export function selectProfile(
  profiles: Profile[],
  o: { profile?: string; model?: string; effort?: string; reason?: string },
  env: NodeJS.ProcessEnv = process.env,
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
  if (!env[secretEnv(profile)]) {
    throw new OmiError(
      "CONFIG_INVALID",
      `profile ${profile.name}: ${secretEnv(profile)} is not set`,
    );
  }
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
  return { profile, model, effort: parsed.data, reason };
}
