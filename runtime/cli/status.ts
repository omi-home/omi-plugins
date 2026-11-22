// `omi status [--milestone <n>]` (DevTask-0050 #145): one read-only view of a Milestone for the
// PO: its Issue tree grouped by Project Status with open PRs, plus local runs and leftovers
// (`cleanup scan`), Status drift (`project plan`) and governance gaps (`github repo validate`).
// The tree is required; each side section reports its own error instead of failing the command.

import { type BoardIssue, readTree } from "../github/adapters/board.ts";
import { type StatusDrift, statusDrift } from "../github/adapters/project-fields.ts";
import { repoValidate } from "../github/adapters/repo.ts";
import { activeMilestone } from "../handoff/adapters/handoff.ts";
import { type AttemptUsage, latestRun, runUsage } from "../persistence/repository.ts";
import { sumUsage } from "../reporting/application/render.ts";
import { type Check, ProjectStatus, type TokenUsage } from "../shared/contracts.ts";
import { OmiError } from "../shared/errors/errors.ts";
import type { GhRunner } from "../shared/github/client.ts";
import { openState, statePath } from "../shared/sqlite/db.ts";
import { cleanupScan, type ScanResult } from "./cleanup.ts";
import { repo } from "./task.ts";

type Section<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

const section = <T>(f: () => T): Section<T> => {
  try {
    return { ok: true, value: f() };
  } catch (e) {
    const err = e instanceof OmiError ? e : new OmiError("INTERNAL", "unexpected error");
    return { ok: false, error: { code: err.code, message: err.message } };
  }
};

export interface StatusResult {
  milestone: BoardIssue;
  /** Every Issue below the Milestone, by Project Status ("not in Project" when it is not in it). */
  byStatus: Record<string, BoardIssue[]>;
  cleanup: Section<ScanResult>;
  drift: Section<StatusDrift[]>;
  /** Governance checks that did not pass. */
  governance: Section<Check[]>;
  /** Host-observed usage of the latest local run of each Issue in the tree that has some. */
  usage: Section<IssueUsage[]>;
}

export interface IssueUsage {
  issue: number;
  runId: string;
  /** Observed models of its agent attempts. */
  models: string[];
  usage: TokenUsage;
  /** Usage per execution profile (`routing` = no profile chosen), #217. */
  byProfile: { profile: string; usage: TokenUsage }[];
}

/** Attempts without a profile ran on `agents.routing`. */
export const NO_PROFILE = "routing";

/** Summed usage per execution profile, in first-use order. */
export function usageByProfile(
  rows: Pick<AttemptUsage, "profile" | "usage">[],
): IssueUsage["byProfile"] {
  const key = (r: Pick<AttemptUsage, "profile">) => r.profile ?? NO_PROFILE;
  return [...new Set(rows.map(key))].map((profile) => ({
    profile,
    usage: sumUsage(rows.filter((r) => key(r) === profile).map((r) => r.usage)) as TokenUsage,
  }));
}

/** Local state only: per Issue, the summed usage of its latest run. */
export function issueUsage(cwd: string, repository: string, issues: number[]): IssueUsage[] {
  const db = openState(statePath(cwd));
  try {
    return issues.flatMap((number) => {
      const run = latestRun(db, { repository, number });
      const rows = run ? runUsage(db, run.id) : [];
      const usage = sumUsage(rows.map((r) => r.usage));
      if (!run || !usage) return [];
      const models = [...new Set(rows.map((r) => r.actualModel ?? "unknown"))];
      return [{ issue: number, runId: run.id, models, usage, byProfile: usageByProfile(rows) }];
    });
  } finally {
    db.close();
  }
}

export const NOT_IN_PROJECT = "not in Project";
export const NO_STATUS = "no Status";

/** Group of an Issue: its ProjectStatus, or why it has none (raw text never becomes a group). */
export const statusKey = (i: BoardIssue): string =>
  !i.inProject
    ? NOT_IN_PROJECT
    : i.status === null
      ? NO_STATUS
      : ProjectStatus.safeParse(i.status).success
        ? i.status
        : `unknown Status '${i.status}'`;

export function status(deps: { cwd: string; milestone?: number; gh?: GhRunner }): StatusResult {
  const { config } = repo(deps.cwd);
  const number = deps.milestone ?? activeMilestone(config, deps.gh);
  const [milestone, ...rest] = readTree(config, number, deps.gh);
  const byStatus = Object.groupBy(rest, statusKey) as Record<string, BoardIssue[]>;
  const inTree = new Set(
    rest.map((i) => `${config.github.owner}/${config.github.repo}#${i.number}`.toLowerCase()),
  );
  return {
    milestone: milestone as BoardIssue,
    byStatus,
    cleanup: section(() => cleanupScan({ cwd: deps.cwd, gh: deps.gh })),
    drift: section(() =>
      statusDrift(config, deps.gh).filter((d) => inTree.has(d.issue.toLowerCase())),
    ),
    governance: section(() => repoValidate(config, deps.gh).filter((c) => c.status !== "pass")),
    usage: section(() =>
      issueUsage(
        deps.cwd,
        `${config.github.owner}/${config.github.repo}`,
        rest.map((i) => i.number),
      ),
    ),
  };
}
