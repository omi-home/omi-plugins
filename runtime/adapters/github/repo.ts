// `omi github repo plan|apply|validate` (DevTask-0038 #90): diff a target repository's labels,
// classic branch protection and merge methods against config/github/repository.yaml. Apply writes
// only the plan the PO approved (governance is High risk), only adds/tightens, never deletes.
import { z } from "zod";
import type { OmiConfig } from "../../core/config.ts";
import { type Check, parseContract } from "../../core/contracts.ts";
import { OmiError } from "../../core/errors/errors.ts";
import {
  type ActualBranch,
  type Label,
  loadRepoConfig,
  planRepo,
  type RepoAction,
  type RepoConfig,
  type RepoPlan,
  type Rule,
  writable,
} from "../../core/repo-config.ts";
import { redactDeep } from "../../reporting/redact.ts";
import { classify, type GhRunner, spawnGh } from "./client.ts";

function api(run: GhRunner, args: string[], what: string, body?: unknown): unknown {
  const r = run(
    ["api", ...args, ...(body === undefined ? [] : ["--input", "-"])],
    body === undefined ? undefined : JSON.stringify(body),
  );
  if (r.status !== 0 || r.error) throw classify(r, what);
  try {
    return JSON.parse(r.stdout || "null");
  } catch {
    throw new OmiError("INTERNAL", `${what}: response is not JSON`);
  }
}

const Repo = z.looseObject({
  allow_squash_merge: z.boolean(),
  allow_merge_commit: z.boolean(),
  allow_rebase_merge: z.boolean(),
  permissions: z.looseObject({ admin: z.boolean() }).optional(),
});
const Labels = z.array(
  z.array(
    z.looseObject({ name: z.string(), color: z.string(), description: z.string().nullable() }),
  ),
);
const On = z.looseObject({ enabled: z.boolean() }).optional();
const Someone = z.array(z.unknown()).optional();
const Protection = z.looseObject({
  required_status_checks: z
    .looseObject({
      strict: z.boolean(),
      checks: z
        .array(z.looseObject({ context: z.string(), app_id: z.int().nullable().optional() }))
        .optional(),
      contexts: z.array(z.string()).optional(),
    })
    .nullable()
    .optional(),
  required_pull_request_reviews: z
    .looseObject({
      dismiss_stale_reviews: z.boolean().optional(),
      require_code_owner_reviews: z.boolean().optional(),
      required_approving_review_count: z.int().optional(),
      require_last_push_approval: z.boolean().optional(),
      dismissal_restrictions: z
        .looseObject({ users: Someone, teams: Someone, apps: Someone })
        .optional(),
      bypass_pull_request_allowances: z
        .looseObject({ users: Someone, teams: Someone, apps: Someone })
        .optional(),
    })
    .nullable()
    .optional(),
  restrictions: z.unknown().optional(),
  enforce_admins: On,
  required_linear_history: On,
  allow_force_pushes: On,
  allow_deletions: On,
  block_creations: On,
  required_conversation_resolution: On,
  lock_branch: On,
  allow_fork_syncing: On,
});
type Protection = z.infer<typeof Protection>;

const repoPath = (c: OmiConfig) => `repos/${c.github.owner}/${c.github.repo}`;
const branchPath = (c: OmiConfig, b: string) =>
  `${repoPath(c)}/branches/${encodeURIComponent(b)}/protection`;

type Read = { exists: false } | { exists: true; protection: Protection | null } | "unsupported";

/** Classic protection of `branch`; null when unprotected, "unsupported" on private Free (D5). */
function readProtection(c: OmiConfig, branch: string, run: GhRunner): Read {
  const r = run(["api", branchPath(c, branch)]);
  if (r.status === 0 && !r.error) {
    let body: unknown;
    try {
      body = JSON.parse(r.stdout);
    } catch {
      throw new OmiError("INTERNAL", `protection of ${branch}: response is not JSON`);
    }
    return { exists: true, protection: parseContract(Protection, body, `protection of ${branch}`) };
  }
  const text = `${r.stdout} ${r.stderr}`;
  if (/Branch not protected/i.test(text)) return { exists: true, protection: null };
  if (/Branch not found/i.test(text)) return { exists: false };
  if (/Upgrade to GitHub Pro|make this repository public/i.test(text)) return "unsupported";
  throw classify(r, `protection of ${branch}`);
}

function rulesOf(p: Protection | null): Rule[] {
  if (!p) return [];
  const on: [Rule, boolean][] = [
    ["pull-request", !!p.required_pull_request_reviews],
    ["enforce-admins", !!p.enforce_admins?.enabled],
    ["no-force-push", !p.allow_force_pushes?.enabled],
    ["no-deletion", !p.allow_deletions?.enabled],
    ["conversation-resolution", !!p.required_conversation_resolution?.enabled],
    ["linear-history", !!p.required_linear_history?.enabled],
  ];
  return on.filter(([, v]) => v).map(([r]) => r);
}

/** Settings a full PUT would have to re-send in another shape: left to a person. */
function blockerOf(p: Protection | null): string | undefined {
  if (!p) return undefined;
  const any = (o?: { users?: unknown[]; teams?: unknown[]; apps?: unknown[] }) =>
    !!o && [o.users, o.teams, o.apps].some((x) => x?.length);
  if (p.restrictions) return "push restrictions are set";
  const rv = p.required_pull_request_reviews;
  if (any(rv?.dismissal_restrictions)) return "review dismissal restrictions are set";
  if (any(rv?.bypass_pull_request_allowances)) return "pull request bypass allowances are set";
  return undefined;
}

const branchesOf = (c: OmiConfig) => ({ release: c.git.releaseBranch, base: c.git.baseBranch });

function readRepo(c: OmiConfig, run: GhRunner) {
  const repo = parseContract(Repo, api(run, [repoPath(c)], "repository"), "repository");
  const admin = repo.permissions?.admin ?? false;
  /** Protection as read, reused by apply's PUT (no second read). */
  const protections = new Map<string, Protection | null>();
  const labels: Label[] = parseContract(
    Labels,
    api(run, ["--paginate", "--slurp", `${repoPath(c)}/labels?per_page=100`], "labels"),
    "labels",
  )
    .flat()
    .map((l) => ({ name: l.name, color: l.color, description: l.description ?? "" }));
  const branches: ActualBranch[] = [...new Set(Object.values(branchesOf(c)))].map((name) => {
    // Branch protection is readable by admins only.
    if (!admin) {
      return { name, exists: true, rules: [], unreadable: "reading protection needs admin rights" };
    }
    const r = readProtection(c, name, run);
    if (r === "unsupported") return { name, exists: true, rules: null };
    if (!r.exists) return { name, exists: false, rules: [] };
    protections.set(name, r.protection);
    return { name, exists: true, rules: rulesOf(r.protection), blocker: blockerOf(r.protection) };
  });
  const merge = {
    squash: repo.allow_squash_merge,
    mergeCommit: repo.allow_merge_commit,
    rebase: repo.allow_rebase_merge,
  };
  return { admin, protections, actual: { labels, branches, merge } };
}

/** Read-only diff of the configured repository against the desired state. */
export function repoPlan(
  c: OmiConfig,
  run: GhRunner = spawnGh,
  desired: RepoConfig = loadRepoConfig(),
): RepoPlan {
  return planRepo(desired, readRepo(c, run).actual, branchesOf(c));
}

/** Full PUT body: the current protection carried over, plus the rules to enable. */
function protectionBody(cur: Protection | null, enable: Rule[]) {
  const have = rulesOf(cur);
  const on = (r: Rule) => enable.includes(r) || have.includes(r);
  const rv = cur?.required_pull_request_reviews;
  const sc = cur?.required_status_checks;
  return {
    required_status_checks: sc
      ? {
          strict: sc.strict,
          // Legacy shape (contexts only) is sent back as it came: no check is dropped.
          ...(sc.checks
            ? {
                checks: sc.checks.map((x) => ({
                  context: x.context,
                  ...(x.app_id == null ? {} : { app_id: x.app_id }),
                })),
              }
            : { contexts: sc.contexts ?? [] }),
        }
      : null,
    enforce_admins: on("enforce-admins"),
    required_pull_request_reviews: rv
      ? {
          dismiss_stale_reviews: rv.dismiss_stale_reviews ?? false,
          require_code_owner_reviews: rv.require_code_owner_reviews ?? false,
          required_approving_review_count: rv.required_approving_review_count ?? 0,
          require_last_push_approval: rv.require_last_push_approval ?? false,
        }
      : on("pull-request")
        ? { required_approving_review_count: 0 }
        : null,
    restrictions: null, // a set restriction is a blocker: never reached here
    required_linear_history: on("linear-history"),
    allow_force_pushes: !on("no-force-push"),
    allow_deletions: !on("no-deletion"),
    block_creations: cur?.block_creations?.enabled ?? false,
    required_conversation_resolution: on("conversation-resolution"),
    lock_branch: cur?.lock_branch?.enabled ?? false,
    allow_fork_syncing: cur?.allow_fork_syncing?.enabled ?? false,
  };
}

const PlanFile = z.strictObject({ actions: z.array(z.unknown()), foreign: z.array(z.string()) });
const ApprovedPlan = z.union([
  z.strictObject({ ok: z.boolean(), command: z.literal("github repo plan"), data: PlanFile }),
  PlanFile,
]);

/** The plan inside `omi github repo plan --output json` (the envelope or its `data`). */
export function approvedActions(json: unknown): unknown[] {
  const r = parseContract(ApprovedPlan, json, "--approved-plan");
  return "data" in r ? r.data.actions : r.actions;
}

/**
 * Applies the plan the PO approved. Recomputes the plan first and refuses unless it equals the
 * approved one (anything changed since approval needs a new approval), and refuses before any
 * write without admin rights. Returns what it wrote and the plan after; a re-run writes nothing.
 */
export function repoApply(
  c: OmiConfig,
  approved: unknown[],
  run: GhRunner = spawnGh,
  desired: RepoConfig = loadRepoConfig(),
): { applied: RepoAction[]; plan: RepoPlan } {
  const { admin, protections, actual } = readRepo(c, run);
  const plan = planRepo(desired, actual, branchesOf(c));
  const todo = plan.actions.filter(writable);
  if (!todo.length) return { applied: [], plan };
  // The approved file went through redaction on output: compare the same form.
  if (JSON.stringify(redactDeep(plan.actions)) !== JSON.stringify(approved)) {
    throw new OmiError(
      "POLICY_VIOLATION",
      "the repository plan changed since it was approved: run `omi github repo plan` and approve again",
    );
  }
  if (!admin) {
    throw new OmiError(
      "GITHUB_AUTH",
      `no admin rights on ${c.github.owner}/${c.github.repo}: governance apply needs them`,
    );
  }
  for (const a of todo) {
    if (a.kind === "create-label") {
      const { name, color, description } = a;
      api(run, [`${repoPath(c)}/labels`, "--method", "POST"], `create label ${name}`, {
        name,
        color,
        description,
      });
    } else if (a.kind === "update-label") {
      api(
        run,
        [`${repoPath(c)}/labels/${encodeURIComponent(a.current)}`, "--method", "PATCH"],
        `update label ${a.name}`,
        { new_name: a.name, color: a.color, description: a.description },
      );
    } else if (a.kind === "protect") {
      api(
        run,
        [branchPath(c, a.branch), "--method", "PUT"],
        `protect ${a.branch}`,
        protectionBody(protections.get(a.branch) ?? null, a.enable),
      );
    } else if (a.kind === "merge-methods") {
      const body: Record<string, boolean> = {};
      if (a.set.squash !== undefined) body.allow_squash_merge = a.set.squash;
      if (a.set.mergeCommit !== undefined) body.allow_merge_commit = a.set.mergeCommit;
      if (a.set.rebase !== undefined) body.allow_rebase_merge = a.set.rebase;
      api(run, [repoPath(c), "--method", "PATCH"], "merge methods", body);
    }
  }
  return { applied: todo, plan: repoPlan(c, run, desired) };
}

/** The plan as checks: fail while anything differs; private Free protection per D5. */
export function repoValidate(
  c: OmiConfig,
  run: GhRunner = spawnGh,
  desired: RepoConfig = loadRepoConfig(),
): Check[] {
  const plan = repoPlan(c, run, desired);
  const fail = (name: string, detail: string): Check => ({
    name,
    status: "fail",
    code: "POLICY_VIOLATION",
    detail,
  });
  const of = (k: RepoAction["kind"][]) => plan.actions.filter((a) => k.includes(a.kind));
  const labels = of(["create-label", "update-label"]);
  const checks: Check[] = [
    labels.length
      ? fail(
          "labels",
          `${labels.length} missing or different: ${labels.map((a) => ("name" in a ? a.name : "")).join(", ")}`,
        )
      : { name: "labels", status: "pass", detail: `${desired.labels.length} in the desired state` },
  ];
  if (plan.foreign.length) {
    checks.push({
      name: "foreign-labels",
      status: "warn",
      detail: `kept: ${plan.foreign.join(", ")}`,
    });
  }
  for (const name of new Set(Object.values(branchesOf(c)))) {
    const a = plan.actions.find(
      (x) =>
        (x.kind === "protect" && x.branch === name) ||
        ((x.kind === "manual" || x.kind === "unsupported") &&
          (x.what === `branch ${name}` || x.what === `protection of ${name}`)),
    );
    const check = `protection ${name}`;
    if (!a) checks.push({ name: check, status: "pass", detail: "required rules on" });
    else if (a.kind === "protect") checks.push(fail(check, `missing: ${a.enable.join(", ")}`));
    else if (a.kind === "unsupported") {
      checks.push(
        c.github.privateRepoRiskAccepted
          ? { name: check, status: "warn", detail: `${a.reason}; risk accepted` }
          : fail(check, `${a.reason}: set github.privateRepoRiskAccepted or upgrade`),
      );
    } else if (a.kind === "manual") checks.push(fail(check, `${a.what} ${a.reason}`));
  }
  const merge = of(["merge-methods"])[0];
  checks.push(
    merge?.kind === "merge-methods"
      ? fail(
          "merge-methods",
          `differs: ${Object.entries(merge.set)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")}`,
        )
      : { name: "merge-methods", status: "pass", detail: "as desired" },
  );
  return checks;
}
