// Open findings of a run (Bug-0013 #392): pure rules for what survives from one step to the next.
// The slice persists the result after every step that changes it, so a BLOCKED run that resumes in a
// new process still hands the same findings to the next agent, and a reviewer that FAILED runs again.
import { z } from "zod";
import { Finding, type Role } from "../../shared/contracts.ts";

/** The reviewers whose verdict gates a round. */
export const REVIEWER_ROLES = ["code-reviewer", "security-reviewer"] as const satisfies Role[];
export type ReviewerRole = (typeof REVIEWER_ROLES)[number];

/** What the run still owes: findings for the next agent, and reviewers that must confirm they are closed. */
export const RunFindings = z.strictObject({
  findings: z.array(Finding).max(100),
  /** Reviewers whose last verdict was FAILED: they run again, whatever selects reviewers (label…). */
  failedReviewers: z.array(z.enum(REVIEWER_ROLES)),
});
export type RunFindings = z.infer<typeof RunFindings>;

export const NO_FINDINGS: RunFindings = { findings: [], failedReviewers: [] };

/** medium and above hold a run back; low and info are advice. */
export const isBlocking = (f: Finding) =>
  f.severity === "critical" || f.severity === "high" || f.severity === "medium";

/** Findings the runtime itself decides each time (checks, regression gate, release): regenerated, never carried. */
const RUNTIME_OWNED = /^(CHK|REG|REL)-/;

const MAX_FINDINGS = 100;

/** `primary` first, then the `carried` ones it does not mention by id (ids are unique per run). */
export function mergeFindings(primary: Finding[], carried: Finding[]): Finding[] {
  const seen = new Set(primary.map((f) => f.id));
  const extra = carried.filter((f) => !seen.has(f.id));
  return [...primary, ...extra].slice(0, MAX_FINDINGS);
}

/**
 * `fresh` findings (the Architect's plan, or the failures of the deterministic checks) plus every
 * blocking review/QA finding still open that `fresh` does not repeat: a new list never makes an
 * open finding disappear.
 */
export const carryOpen = (fresh: Finding[], open: Finding[]): Finding[] =>
  mergeFindings(
    fresh,
    open.filter((f) => isBlocking(f) && !RUNTIME_OWNED.test(f.id)),
  );

/** One reviewer's verdict of this round, as the reviewers loop collects it. */
export interface ReviewVerdict {
  role: ReviewerRole;
  status: "PASSED" | "FAILED";
  findings: Finding[];
}

/**
 * The run's findings once the round's reviewers have all spoken. A FAILED reviewer keeps every
 * finding it raised and stays in `failedReviewers`. A PASSED reviewer closes what it was shown:
 * only its low/info advice remains. A reviewer that did not run keeps its place in the list.
 */
export function afterReview(open: RunFindings, verdicts: ReviewVerdict[]): RunFindings {
  const failedReviewers = new Set(open.failedReviewers);
  for (const v of verdicts) {
    if (v.status === "FAILED") failedReviewers.add(v.role);
    else failedReviewers.delete(v.role);
  }
  const findings = verdicts.flatMap((v) =>
    v.status === "FAILED" ? v.findings : v.findings.filter((f) => !isBlocking(f)),
  );
  return {
    findings: findings.slice(0, MAX_FINDINGS),
    failedReviewers: REVIEWER_ROLES.filter((r) => failedReviewers.has(r)),
  };
}

/** What stops a run at the gate before PR_PENDING: a reviewer that never confirmed, or a blocking finding left open. */
export function unconfirmed(open: RunFindings): string[] {
  return [
    ...open.failedReviewers.map((r) => `${r} FAILED and has not passed since`),
    ...open.findings.filter(isBlocking).map((f) => `${f.id} (${f.severity}) is still open`),
  ];
}
