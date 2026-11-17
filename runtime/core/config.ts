// OMI configuration contract with safe defaults (spec §3, §7, §9, §14, §20).
// Project config lives in <repo>/.omi/config.yaml; plugin config/ holds only default policies.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { parseContract, Role } from "./contracts.ts";
import { OmiError } from "./errors/errors.ts";

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
      worktreeRoot: z.string().min(1).default("../.omi-worktrees"),
      mergeMethod: z.enum(["squash", "merge", "rebase"]).default("squash"),
    })
    .prefault({}),
  review: z
    .strictObject({
      // Fixed by policy (spec §10): 2 rounds, Architect, 2 more rounds.
      maxRounds: z.literal(4).default(4),
      architectAfterFailedRounds: z.literal(2).default(2),
    })
    .prefault({}),
  agents: z
    .strictObject({
      maxConcurrent: z.int().min(1).max(3).default(3),
      routing: ModelRouting.prefault({}),
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

export const CONFIG_PATH = ".omi/config.yaml";

/** Reads and validates `<repoRoot>/.omi/config.yaml`. Errors never echo config values. */
export function loadConfig(repoRoot: string): OmiConfig {
  let text: string;
  try {
    text = readFileSync(join(repoRoot, CONFIG_PATH), "utf8");
  } catch {
    throw new OmiError("CONFIG_INVALID", `${CONFIG_PATH} not found`);
  }
  let data: unknown;
  try {
    data = parse(text);
  } catch (e) {
    const line = (e as { linePos?: { line: number }[] }).linePos?.[0]?.line;
    throw new OmiError("CONFIG_INVALID", `${CONFIG_PATH}: invalid YAML`, { line });
  }
  return parseConfig(data);
}
