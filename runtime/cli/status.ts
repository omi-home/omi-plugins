// `omi status [--milestone <n>]` (DevTask-0050 #145): one read-only view of a Milestone for the
// PO: its Issue tree grouped by Project Status with open PRs, plus local runs and leftovers
// (`cleanup scan`), Status drift (`project plan`) and governance gaps (`github repo validate`).
// The tree is required; each side section reports its own error instead of failing the command.
import { type BoardIssue, readTree } from "../adapters/github/board.ts";
import type { GhRunner } from "../adapters/github/client.ts";
import { activeMilestone } from "../adapters/github/handoff.ts";
import { type StatusDrift, statusDrift } from "../adapters/github/project-fields.ts";
import { repoValidate } from "../adapters/github/repo.ts";
import { type Check, ProjectStatus } from "../core/contracts.ts";
import { OmiError } from "../core/errors/errors.ts";
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
  };
}
