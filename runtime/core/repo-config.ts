// Repository governance desired state (DevTask-0038 #90): labels, branch protection minimums and
// merge methods in config/github/repository.yaml; merge tiers in config/risk-policy.yaml.
// Pure: load, validate, diff. GitHub reads and writes live in adapters/github/repo.ts.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { IssueType, parseContract } from "./contracts.ts";

export const Rule = z.enum([
  "pull-request",
  "enforce-admins",
  "no-force-push",
  "no-deletion",
  "conversation-resolution",
  "linear-history",
]);
export type Rule = z.infer<typeof Rule>;

const Label = z.strictObject({
  name: z.string().min(1).max(50),
  color: z.string().regex(/^[0-9a-f]{6}$/),
  description: z.string().max(100).default(""),
});
export type Label = z.infer<typeof Label>;

const key = (s: string) => s.toLowerCase();

export const RepoConfig = z
  .strictObject({
    labels: z.array(Label),
    protection: z.strictObject({ release: z.array(Rule), base: z.array(Rule) }),
    merge: z.strictObject({ squash: z.boolean(), mergeCommit: z.boolean(), rebase: z.boolean() }),
  })
  .refine(
    (c) => new Set(c.labels.map((l) => key(l.name))).size === c.labels.length,
    "duplicate label name",
  )
  .refine(
    (c) => IssueType.options.every((t) => c.labels.some((l) => l.name === `type:${t}`)),
    "every OMI type needs its type:* label",
  )
  .refine((c) => c.merge.squash || c.merge.mergeCommit || c.merge.rebase, "no merge method");
export type RepoConfig = z.infer<typeof RepoConfig>;

export const RiskPolicy = z
  .strictObject({
    levels: z.array(z.string().regex(/^[a-z]+$/)).min(1),
    default: z.string(),
    poMerge: z.array(z.string()),
  })
  .refine((p) => [p.default, ...p.poMerge].every((l) => p.levels.includes(l)), "unknown level");
export type RiskPolicy = z.infer<typeof RiskPolicy>;

const read = (path: string) =>
  parse(readFileSync(new URL(`../../config/${path}`, import.meta.url), "utf8"));

let repo: RepoConfig | undefined;
let risk: RiskPolicy | undefined;
export const loadRepoConfig = (): RepoConfig =>
  (repo ??= parseContract(
    RepoConfig,
    read("github/repository.yaml"),
    "repository config",
    "CONFIG_INVALID",
  ));
export const loadRiskPolicy = (): RiskPolicy =>
  (risk ??= parseContract(RiskPolicy, read("risk-policy.yaml"), "risk policy", "CONFIG_INVALID"));

/** Highest known `risk:<level>` among `labels`; unknown levels are ignored. */
export function riskLevel(labels: string[], p = loadRiskPolicy()): string | undefined {
  const found = labels
    .map((l) => /^risk:(.+)$/.exec(l)?.[1]?.toLowerCase())
    .filter((l): l is string => !!l && p.levels.includes(l));
  return found.sort((a, b) => p.levels.indexOf(b) - p.levels.indexOf(a))[0];
}

// --- diff -------------------------------------------------------------------------------------

/** One branch as GitHub reports it: `null` rules when its protection cannot be read. */
export interface ActualBranch {
  name: string;
  exists: boolean;
  /** Rules on now; null when protection is unavailable (private repo on Free, D5). */
  rules: Rule[] | null;
  /** Settings a full PUT could not carry over without loss (push restrictions…). */
  blocker?: string;
  /** Why the protection could not be read (no admin rights). */
  unreadable?: string;
}

export interface ActualRepo {
  labels: Label[];
  branches: ActualBranch[];
  merge: RepoConfig["merge"];
}

export type RepoAction =
  | ({ kind: "create-label" } & Label)
  /** `current`: the label's name on GitHub (renamed when only its case differs). */
  | ({ kind: "update-label"; current: string } & Label)
  | { kind: "protect"; branch: string; enable: Rule[] }
  | { kind: "merge-methods"; set: Partial<RepoConfig["merge"]> }
  /** Needs a person: apply never does it. */
  | { kind: "manual"; what: string; reason: string }
  /** GitHub cannot enforce it on this plan (D5): reported, nothing to apply. */
  | { kind: "unsupported"; what: string; reason: string };

export interface RepoPlan {
  actions: RepoAction[];
  /** Labels on GitHub that are not in the desired state: kept. */
  foreign: string[];
}

export const writable = (a: RepoAction) => a.kind !== "manual" && a.kind !== "unsupported";

export function planRepo(
  desired: RepoConfig,
  actual: ActualRepo,
  branches: { release: string; base: string },
): RepoPlan {
  const actions: RepoAction[] = [];
  for (const want of desired.labels) {
    const have = actual.labels.find((l) => key(l.name) === key(want.name));
    if (!have) actions.push({ kind: "create-label", ...want });
    else if (
      have.name !== want.name ||
      have.color.toLowerCase() !== want.color ||
      have.description !== want.description
    ) {
      actions.push({ kind: "update-label", ...want, current: have.name });
    }
  }
  const seen = new Set<string>();
  for (const role of ["release", "base"] as const) {
    const name = branches[role];
    if (seen.has(name)) continue;
    seen.add(name);
    const want = [
      ...new Set([
        ...desired.protection[role],
        ...(name === branches.base ? desired.protection.base : []),
      ]),
    ];
    const b = actual.branches.find((x) => x.name === name);
    if (!b?.exists)
      actions.push({ kind: "manual", what: `branch ${name}`, reason: "does not exist" });
    else if (b.unreadable) {
      actions.push({ kind: "manual", what: `protection of ${name}`, reason: b.unreadable });
    } else if (b.rules === null) {
      actions.push({
        kind: "unsupported",
        what: `protection of ${name}`,
        reason: "GitHub Free does not enforce branch protection on private repos (ADR-0001 D5)",
      });
    } else {
      const enable = want.filter((r) => !b.rules?.includes(r));
      if (enable.length && b.blocker) {
        actions.push({
          kind: "manual",
          what: `protection of ${name}`,
          reason: `${b.blocker}; enable ${enable.join(", ")} by hand`,
        });
      } else if (enable.length) actions.push({ kind: "protect", branch: name, enable });
    }
  }
  const set: Partial<RepoConfig["merge"]> = {};
  for (const k of ["squash", "mergeCommit", "rebase"] as const) {
    if (actual.merge[k] !== desired.merge[k]) set[k] = desired.merge[k];
  }
  if (Object.keys(set).length) actions.push({ kind: "merge-methods", set });
  const foreign = actual.labels
    .filter((l) => !desired.labels.some((w) => key(w.name) === key(l.name)))
    .map((l) => l.name);
  return { actions, foreign };
}
