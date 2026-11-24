// `omi pr create | validate | merge <n>`: the authorized PR path of a task (spec §8 gate 5).
import { existsSync } from "node:fs";
import { type StatusChange, setStatus } from "../../github/adapters/project.ts";
import { type EngineOutcome, isV2, lifecycleSync } from "../../github/cli/lifecycle.ts";
import { type OmiConfig, repo } from "../../shared/config.ts";
import type { Check, IssueRef } from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { spawnGh } from "../../shared/github/client.ts";
import { openState, statePath } from "../../shared/sqlite/db.ts";
import { advanceRun, liveRun, ownedRefs } from "../../task-run/adapters/repository.ts";
import { git } from "../../task-run/adapters/worktree.ts";
import type { TaskDeps } from "../../task-run/cli/common.ts";
import { startGates, typeOf } from "../../task-run/cli/gates.ts";
import { PRE_MERGE } from "../../task-run/domain/fsm.ts";
import { fetchTicket, type Ticket } from "../../ticket/adapters/ticket.ts";
import {
  type MergeReceipt,
  mergeEligibility,
  mergePr,
  prFacts,
  RISK_CHECK,
  receiptOf,
} from "../adapters/merge.ts";
import {
  closingIssues,
  createPr,
  foreignCloseCheck,
  type PullRequest,
  prBody,
  repoFacts,
  sleepSync,
  validatePr,
} from "../adapters/pr.ts";

export interface PrResult {
  pr: PullRequest;
  created: boolean;
  checks: Check[];
  status: StatusChange | null;
  /** github.model v2: the `omi sync` that replaced the direct Status write. */
  engine?: EngineOutcome;
}

/**
 * `omi pr create <n>` (spec §8 gate 5): push the task branch from its owned, clean worktree,
 * create or reuse its one PR → `develop`, and verify base, head and exactly one primary Issue.
 * A Release Issue takes the separate `develop → main` path and owns no worktree. No workflow
 * transition here: `omi task run` reaches PR_PENDING through QA.
 */
export function prCreate(
  deps: TaskDeps & { title?: string; body?: string; sleep?: (ms: number) => void },
  issue: number,
): PrResult {
  const gh = deps.gh ?? spawnGh;
  const { config } = repo(deps.cwd);
  const ref = { repository: `${config.github.owner}/${config.github.repo}`, number: issue };
  const primary = `${ref.repository}#${issue}`;
  const ticket = fetchTicket(config, issue, gh);
  const release = typeOf(ticket) === "release";
  let head = config.git.baseBranch;
  let base = config.git.releaseBranch;
  let tip: string | undefined;
  if (release) {
    if (ticket.state !== "OPEN") throw new OmiError("TICKET_INVALID", `${primary} is closed`);
  } else {
    const bad = startGates(ticket, config).find((c) => c.status === "fail");
    if (bad) throw new OmiError(bad.code ?? "TICKET_INVALID", `${bad.name}: ${bad.detail}`);
    const db = openState(statePath(deps.cwd));
    let worktree: string | undefined;
    try {
      const run = liveRun(db, ref);
      if (!run) throw new OmiError("POLICY_VIOLATION", `no active run for ${primary}: task start`);
      head = ownedRefs(db, run.id, "branch")[0] ?? "";
      worktree = ownedRefs(db, run.id, "worktree")[0];
    } finally {
      db.close();
    }
    if (!head || !worktree || !existsSync(worktree)) {
      throw new OmiError("OWNERSHIP_MISMATCH", `${primary} has no owned branch and worktree`);
    }
    base = config.git.baseBranch;
    if (git(["rev-parse", "--abbrev-ref", "HEAD"], worktree) !== head) {
      throw new OmiError("OWNERSHIP_MISMATCH", `worktree is not on ${head}`, { path: worktree });
    }
    if (git(["status", "--porcelain"], worktree)) {
      throw new OmiError("WORKTREE_DIRTY", "commit or discard changes first", { path: worktree });
    }
    git(["fetch", "--quiet", "origin", base], worktree);
    if (git(["rev-list", "--count", `origin/${base}..HEAD`], worktree) === "0") {
      throw new OmiError("POLICY_VIOLATION", `${head} has no commits ahead of origin/${base}`);
    }
    tip = git(["rev-parse", "HEAD"], worktree);
    git(["push", "--quiet", "-u", "origin", head], worktree);
  }

  let facts = repoFacts(config, head, gh);
  // GitHub moves an existing PR's head to a fresh push asynchronously: re-read briefly.
  const sleep = deps.sleep ?? sleepSync;
  for (
    let delay = 1000;
    tip && facts.open[0] && facts.open[0].headRefOid !== tip && delay <= 8000;
    delay *= 2
  ) {
    sleep(delay);
    facts = repoFacts(config, head, gh);
  }
  if (facts.open.length > 1) {
    throw new OmiError("POLICY_VIOLATION", `${facts.open.length} open PRs from ${head}`);
  }
  const existing = facts.open[0];
  const wanted = {
    title: deps.title ?? ticket.title,
    body: prBody(ref.repository, issue, deps.body),
  };
  const foreign = foreignCloseCheck(existing ?? wanted, primary);
  if (foreign.status === "fail") {
    // Before any create: a PR closing another Issue must never exist (Bug-0017 #426).
    throw new OmiError("POLICY_VIOLATION", `${foreign.name}: ${foreign.detail}`, {
      checks: [foreign],
    });
  }
  const pr = existing ?? createPr({ repositoryId: facts.id, base, head, ...wanted }, gh);
  const closing =
    base === facts.defaultBranch ? closingIssues(pr.id, { run: gh, sleep: deps.sleep }) : null;
  const checks = validatePr(pr, { primary, base, head, closing });
  if (tip) {
    checks.push(
      pr.headRefOid === tip
        ? { name: "pr-tip", status: "pass", detail: tip.slice(0, 12) }
        : {
            name: "pr-tip",
            status: "fail",
            code: "POLICY_VIOLATION",
            detail: `PR head ${pr.headRefOid.slice(0, 12)} ≠ local ${tip.slice(0, 12)}`,
          },
    );
  }
  const bad = checks.find((c) => c.status === "fail");
  if (bad) {
    throw new OmiError("POLICY_VIOLATION", `${pr.url}: ${bad.name}: ${bad.detail}`, { checks });
  }
  // v2: `omi sync` (In review is an `auto` rule once the PR is open); legacy sets the Status.
  if (!release && isV2(config)) {
    const engine = lifecycleSync({ cwd: deps.cwd, gh, state: deps.state });
    return { pr, created: !existing, checks, status: null, engine };
  }
  const status = release ? null : setStatus(config, issue, "In Review", gh);
  return { pr, created: !existing, checks, status };
}

export interface TaskPr {
  config: OmiConfig;
  ref: IssueRef;
  primary: string;
  ticket: Ticket;
  head: string;
  base: string;
  /** Local tip of the task branch when its worktree still exists. */
  localTip?: string;
}

/** The task branch of a gated executable Issue, from its live run's owned resources. */
function taskPr(deps: TaskDeps, issue: number): TaskPr {
  const gh = deps.gh ?? spawnGh;
  const { config } = repo(deps.cwd);
  const ref = { repository: `${config.github.owner}/${config.github.repo}`, number: issue };
  const primary = `${ref.repository}#${issue}`;
  const ticket = fetchTicket(config, issue, gh);
  if (typeOf(ticket) === "release") {
    throw new OmiError("POLICY_VIOLATION", "release PRs (develop → main) are merged by the PO");
  }
  const bad = startGates(ticket, config).find((c) => c.status === "fail");
  if (bad) throw new OmiError(bad.code ?? "TICKET_INVALID", `${bad.name}: ${bad.detail}`);
  const db = openState(statePath(deps.cwd));
  let head: string | undefined;
  let worktree: string | undefined;
  try {
    const run = liveRun(db, ref);
    if (!run) throw new OmiError("POLICY_VIOLATION", `no active run for ${primary}: task start`);
    head = ownedRefs(db, run.id, "branch")[0];
    worktree = ownedRefs(db, run.id, "worktree")[0];
  } finally {
    db.close();
  }
  if (!head) throw new OmiError("OWNERSHIP_MISMATCH", `${primary} has no owned branch`);
  const localTip =
    worktree && existsSync(worktree) ? git(["rev-parse", head], worktree) : undefined;
  return { config, ref, primary, ticket, head, base: config.git.baseBranch, localTip };
}

export interface MergeCheckResult {
  pr: string | null;
  checks: Check[];
}

const METHOD = { squash: "SQUASH", merge: "MERGE", rebase: "REBASE" } as const;

function eligibility(deps: TaskDeps, issue: number) {
  const t = taskPr(deps, issue);
  const facts = prFacts(t.config, { head: t.head, base: t.base, states: ["OPEN"] }, deps.gh);
  const checks = mergeEligibility(facts, {
    primary: t.primary,
    base: t.base,
    method: METHOD[t.config.git.mergeMethod],
    issueLabels: t.ticket.labels.nodes.map((l) => l.name),
    localTip: t.localTip,
    privateRiskAccepted: t.config.github.privateRepoRiskAccepted,
  });
  return { t, facts, checks };
}

/** `omi pr validate <n>`: read-only merge eligibility of the task PR. */
export function prValidate(deps: TaskDeps, issue: number): MergeCheckResult {
  const { facts, checks } = eligibility(deps, issue);
  return { pr: facts.pr?.url ?? null, checks };
}

export interface MergeResult {
  checks: Check[];
  receipt: MergeReceipt;
  /** github.model v2: the `omi sync` run after the merge. */
  engine?: EngineOutcome;
}

/**
 * `omi pr merge <n>`: the authorized merge path for task PRs. Merges only when every gate
 * passes, with the configured method, pinned to the validated head SHA. A High risk PR goes to
 * the PO instead (run → WAITING_PO, Status Waiting PO) and is never merged here.
 */
export function prMerge(deps: TaskDeps, issue: number): MergeResult {
  const gh = deps.gh ?? spawnGh;
  const { t, facts, checks } = eligibility(deps, issue);
  const failed = checks.filter((c) => c.status === "fail");
  if (failed.some((c) => c.name === RISK_CHECK)) {
    const db = openState(statePath(deps.cwd));
    try {
      const run = liveRun(db, t.ref);
      if (run && PRE_MERGE.includes(run.state)) advanceRun(db, run.id, { type: "ESCALATE_TO_PO" });
    } finally {
      db.close();
    }
    // v2 has no Waiting PO status: the run is escalated and the refusal below tells the Coordinator.
    if (!isV2(t.config)) setStatus(t.config, issue, "Waiting PO", gh);
  }
  const bad = failed[0];
  if (bad || !facts.pr) {
    throw new OmiError(
      bad?.code ?? "POLICY_VIOLATION",
      `merge refused: ${bad?.name}: ${bad?.detail}`,
      {
        checks,
      },
    );
  }
  mergePr(
    {
      prId: facts.pr.id,
      method: METHOD[t.config.git.mergeMethod],
      headOid: facts.pr.headRefOid,
      headline: `${facts.pr.title ?? t.ticket.title} (#${facts.pr.number})`,
      body: `Closes #${t.ref.number}`,
    },
    gh,
  );
  const after = prFacts(t.config, { head: t.head, base: t.base, states: ["MERGED"] }, gh);
  const receipt = receiptOf(after.pr);
  if (!receipt || receipt.headSha !== facts.pr.headRefOid) {
    throw new OmiError("GITHUB_UNAVAILABLE", "merge sent but no matching merge receipt yet: retry");
  }
  // v2: `omi sync` after the merge (the PR's closing link closes the Issue; Done and roll-up are `auto`).
  if (isV2(t.config)) {
    return { checks, receipt, engine: lifecycleSync({ cwd: deps.cwd, gh, state: deps.state }) };
  }
  return { checks, receipt };
}
