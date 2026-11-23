// `omi issue create|depend` and `omi [github] project plan|apply|validate`, `omi github repo
// plan|apply|validate`: argument checks and human output. The dispatcher (runtime/cli/main.ts) only
// routes the command and wraps the result in its envelope.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OmiConfig } from "../../shared/config.ts";
import { workflowModel } from "../../shared/config.ts";
import { IssueType, IssueTypeV2 } from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { addDependency } from "../adapters/dependency.ts";
import { createIssue } from "../adapters/issue.ts";
import {
  type ProjectAction,
  type ProjectPlan,
  projectApply,
  projectPlan,
  type StatusDrift,
} from "../adapters/project-fields.ts";
import { qaPlan } from "../adapters/qa-plan.ts";
import { approvedActions, repoApply, repoPlan } from "../adapters/repo.ts";
import type { RepoAction } from "../application/repo-config.ts";

export { projectValidate } from "../adapters/project-fields.ts";
export { repoValidate } from "../adapters/repo.ts";

/** A command result: `failed` makes the CLI exit 1 (a plan with pending work, like a check). */
export interface GithubCliResult {
  data: unknown;
  human: string;
  failed?: boolean;
}

const lines = (l: string[]) => l.map((s) => `${s}\n`).join("");

/** `59`, `#59` or `owner/repo#59`. */
export const parentArg = (a: string, home: { owner: string; repo: string }, flag = "--parent") => {
  const m = /^(?:([\w.-]+)\/([\w.-]+)#|#?)(\d+)$/.exec(a);
  if (!m || Number(m[3]) < 1)
    throw new OmiError("USAGE_INVALID", `${flag} expects n or owner/repo#n`);
  return { owner: m[1] ?? home.owner, repo: m[2] ?? home.repo, number: Number(m[3]) };
};

const describe = (a: ProjectAction) =>
  a.kind === "create"
    ? `create field ${a.field.name} (${a.field.type})`
    : a.kind === "update-options"
      ? `field ${a.name}: ${[...a.add.map((o) => `+${o}`), ...a.change.map((o) => `~${o}`)].join(", ")}`
      : a.kind === "create-view"
        ? `create view ${a.view.name} (${a.view.layout})`
        : a.kind === "update-view"
          ? `update view ${a.name}: ${a.changes.join(", ")}`
          : a.kind === "create-issue-type" || a.kind === "update-issue-type"
            ? a.kind === "create-issue-type"
              ? `create issue type ${a.type.name} (${a.type.color})`
              : `update issue type ${a.name}: ${a.changes.join(", ")}`
            : `${a.name}: ${a.reason}`;

const humanPlan = (p: Omit<ProjectPlan, "drift">, drift: StatusDrift[]) => {
  const actions = [...(p.issueTypes?.actions ?? []), ...p.actions, ...p.views.actions];
  return [
    ...actions.map(
      (a) =>
        `${a.kind === "manual" || a.kind === "workflow" ? "manual " : "pending"}   ${describe(a)}`,
    ),
    ...(actions.length ? [] : ["project   in the desired state"]),
    ...(p.issueTypes?.extra ?? []).map((e) => `extra     issue type ${e} (not managed: kept)`),
    ...p.extra.map((e) => `extra     ${e} (not managed: kept)`),
    ...p.views.extraViews.map((v) => `extra     view ${v} (not managed: kept)`),
    ...p.views.unsupported.map((u) => `unsupported ${u}`),
    ...drift.map((d) => `drift     ${d.issue} ${d.status ?? "unset"}: ${d.reason}`),
  ];
};

const repoPrefix = (a: RepoAction) =>
  a.kind === "manual" || a.kind === "unsupported" ? a.kind.padEnd(11) : "pending    ";

const describeRepo = (a: RepoAction) =>
  a.kind === "create-label" || a.kind === "update-label"
    ? `${a.kind === "create-label" ? "create" : "update"} label ${a.name} (#${a.color} ${a.description})`
    : a.kind === "protect"
      ? `protect ${a.branch}: ${a.enable.join(", ")}`
      : a.kind === "merge-methods"
        ? `merge methods: ${Object.entries(a.set)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")}`
        : `${a.what}: ${a.reason}`;

export function issueCreate(
  values: { type?: string; title?: string; parent?: string },
  readBody: () => string,
  loadConfig: () => OmiConfig,
): GithubCliResult {
  // Legacy takes an OMI type (dev-task), v2 a native type name (DevTask): the model is known
  // only from the workspace config, which createIssue checks the type against.
  const type = [...IssueType.options, ...IssueTypeV2.options].find((t) => t === values.type);
  if (!type) {
    throw new OmiError(
      "USAGE_INVALID",
      `--type must be one of ${IssueType.options.join(", ")} (github.model legacy) or ${IssueTypeV2.options.join(", ")} (v2)`,
    );
  }
  if (!values.title) throw new OmiError("USAGE_INVALID", "--title is required");
  const body = readBody();
  const config = loadConfig();
  // Legacy: a native type name is refused here, not as a missing `type:DevTask` label later.
  if (workflowModel(config) === "legacy" && !IssueType.safeParse(type).success) {
    throw new OmiError(
      "USAGE_INVALID",
      `--type must be one of ${IssueType.options.join(", ")} (github.model is legacy)`,
    );
  }
  const parent = values.parent === undefined ? undefined : parentArg(values.parent, config.github);
  const r = createIssue(config, { type, title: values.title, body, parent });
  const human = [
    `issue     ${r.url}${r.created ? "" : " (existing)"}`,
    `title     ${r.title}`,
    `changes   ${r.changes.join(", ") || "none"}`,
  ];
  return { data: r, human: lines(human) };
}

export function issueDepend(
  issue: number,
  on: string | undefined,
  loadConfig: () => OmiConfig,
): GithubCliResult {
  if (!on) throw new OmiError("USAGE_INVALID", "--on <m|owner/repo#m> is required");
  const { github } = loadConfig();
  const r = addDependency(
    { owner: github.owner, repo: github.repo, number: issue },
    parentArg(on, github, "--on"),
  );
  const human = `depend    ${r.issue} blocked by ${r.blockedBy}${r.added ? "" : " (existing)"}\n`;
  return { data: r, human };
}

export function qaPlanCommand(
  issue: number,
  dev: string[] | undefined,
  loadConfig: () => OmiConfig,
): GithubCliResult {
  const config = loadConfig();
  const r = qaPlan(config, issue, {
    dev: (dev ?? []).map((d) => parentArg(d, config.github, "--dev")),
  });
  const human = [
    `plan      #${r.target.number} ${r.target.kind}${r.target.storyType ? ` (${r.target.storyType})` : ""}`,
    ...r.issues.map(
      (i) =>
        `${i.kind.padEnd(11)} ${i.ref} ${i.title}${i.created ? "" : " (existing)"}${i.changes.length ? ` [${i.changes.join(", ")}]` : ""}`,
    ),
    ...r.dependencies.map(
      (d) => `depend    ${d.issue} blocked by ${d.blockedBy}${d.added ? "" : " (existing)"}`,
    ),
  ];
  return { data: r, human: lines(human) };
}

export function githubProjectPlan(config: OmiConfig): GithubCliResult {
  const r = projectPlan(config);
  // Like a check: 1 while anything is pending, manual or drifting, so scripts can gate on it.
  const clean =
    !r.actions.length &&
    !r.views.actions.length &&
    !r.issueTypes?.actions.length &&
    !r.drift.length;
  return { data: r, human: lines(humanPlan(r, r.drift)), failed: !clean };
}

export function githubProjectApply(config: OmiConfig): GithubCliResult {
  const r = projectApply(config);
  const human = [
    ...r.applied.map((a) => `applied   ${describe(a)}`),
    ...(r.applied.length ? [] : ["applied   nothing (already in the desired state)"]),
    ...humanPlan(r.plan, []),
  ];
  const left =
    r.plan.actions.length + r.plan.views.actions.length + (r.plan.issueTypes?.actions.length ?? 0);
  return { data: r, human: lines(human), failed: left > 0 };
}

export function githubRepoPlan(config: OmiConfig): GithubCliResult {
  const r = repoPlan(config);
  const human = [
    ...r.actions.map((a) => `${repoPrefix(a)} ${describeRepo(a)}`),
    ...(r.actions.length ? [] : ["repo      in the desired state"]),
    ...r.foreign.map((l) => `foreign   label ${l} (not managed: kept)`),
  ];
  return { data: r, human: lines(human), failed: r.actions.length > 0 };
}

export function githubRepoApply(
  cwd: string,
  file: string | undefined,
  loadConfig: () => OmiConfig,
): GithubCliResult {
  if (!file) throw new OmiError("USAGE_INVALID", "--approved-plan <file> is required");
  let approved: unknown;
  try {
    approved = JSON.parse(readFileSync(resolve(cwd, file), "utf8"));
  } catch {
    throw new OmiError("USAGE_INVALID", `cannot read --approved-plan ${file} as JSON`);
  }
  const r = repoApply(loadConfig(), approvedActions(approved));
  const human = [
    ...r.applied.map((a) => `applied   ${describeRepo(a)}`),
    ...(r.applied.length ? [] : ["applied   nothing (already in the desired state)"]),
    ...r.plan.actions.map((a) => `${repoPrefix(a)} ${describeRepo(a)}`),
  ];
  return { data: r, human: lines(human), failed: r.plan.actions.length > 0 };
}
