// OMI configuration contract with safe defaults (spec §3, §7, §9, §14, §20).
// Project config lives in <workspace>/.omi-plugins/omi.config.yaml (ADR-0002 D1); plugin config/
// holds only default policies.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  DEFAULT_KEY_ENV,
  GateCheck,
  parseContract,
  Role,
  relPath,
  WorkflowModel,
} from "./contracts.ts";
import { OmiError } from "./errors/errors.ts";
import { resolveWorkflow } from "./workflow.ts";
import { CONFIG_FILE, locate } from "./workspace.ts";

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
export const SecretsConfig = z.strictObject({
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
    /** Override of config/github/workflow.yaml; merged and validated by workflow.ts. */
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
      /** Resumes of a session with the contract issues before a CONTRACT_INVALID result blocks (#407). */
      contractRepairs: z.int().min(0).max(5).default(2),
      /** Input tokens (incl. cache read) a role session may total before a fresh one replaces it (#407). */
      sessionMaxTokens: z.int().min(10_000).default(3_000_000),
    })
    .prefault({}),
  /** Optional dependency install run in a task clone, e.g. `npm ci`, before agent and checks. */
  setup: GateCommand.optional(),
  /** Unset checks are skipped; a repo with none configured has no deterministic gate. */
  checks: GateChecks.prefault({}),
  /** Architecture contract of the target repo (Feature-0043 #321); checked by the gate and doctor. */
  architecture: z
    .strictObject({
      // The path reaches a shell command line (checks.ts): only a plain set of characters (SEC-003).
      contract: relPath
        .regex(/^[\w./-]+$/, "expected only letters, digits, '_', '.', '/' and '-'")
        .default("omi-architecture.yaml"),
    })
    .optional(),
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

/** Role keys removed by the 5-role agent pack (ADR-0005 D4) and the key that replaces each. */
export const RENAMED_ROLES: Readonly<Record<string, Role>> = {
  "frontend-engineer": "software-engineer",
  "backend-engineer": "software-engineer",
  "database-engineer": "software-engineer",
  "devops-engineer": "software-engineer",
  "manual-qa-engineer": "qa-engineer",
  "automation-qa-engineer": "qa-engineer",
};

export function parseConfig(input: unknown): OmiConfig {
  const routing = (input as { agents?: { routing?: unknown } } | null)?.agents?.routing;
  if (routing && typeof routing === "object") {
    const old = Object.keys(routing).filter((k) => Object.hasOwn(RENAMED_ROLES, k));
    if (old.length) {
      throw new OmiError(
        "CONFIG_INVALID",
        `config: agents.routing uses removed roles: ${old.map((k) => `${k} → ${RENAMED_ROLES[k]}`).join(", ")}; rename the keys`,
        { removed: old },
      );
    }
  }
  return parseContract(OmiConfig, input, "config", "CONFIG_INVALID");
}

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

/** Main checkout, workspace and config of the repo containing `cwd` (also from a task worktree). */
export function repo(cwd: string): { root: string; workspace: string; config: OmiConfig } {
  const { root, workspace } = locate(cwd);
  return { root, workspace, config: loadConfig(workspace) };
}
