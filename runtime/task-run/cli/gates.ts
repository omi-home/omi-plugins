// Ticket gates (spec §6–§7): Definition of Ready and "may this Issue own a worktree", shared by
// `omi ticket validate`, `omi task start` and the PR commands.
import {
  hierarchyChecks,
  type Link,
  labelType,
  loadHierarchy,
  loadHierarchyV2,
  titleCheck,
  titleCheckV2,
} from "../../github/application/hierarchy.ts";
import { sectionsCheck, sectionsCheckV2 } from "../../github/application/issue-forms.ts";
import { type OmiConfig, repo, workflowModel } from "../../shared/config.ts";
import type { Check, IssueType, IssueTypeV2 } from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { type GhRunner, spawnGh } from "../../shared/github/client.ts";
import {
  fetchTicket,
  readIssueType,
  type Ticket,
  validateTicket,
} from "../../ticket/adapters/ticket.ts";
import type { TaskDeps } from "./common.ts";

/** Types that own a branch + worktree. Containers and Release (develop → main) do not. */
const EXECUTABLE: readonly IssueType[] = [
  "dev-task",
  "test-task",
  "devops-task",
  "documentation-task",
  "spike",
];

export const typeOf = (t: Ticket) => labelType(t.labels.nodes);
/** Native type of a model v2 Issue; undefined when absent or unknown (the type gate reports it). */
const typeOfV2 = (t: Ticket): IssueTypeV2 | undefined => {
  try {
    return readIssueType(t, "v2") as IssueTypeV2;
  } catch {
    return undefined;
  }
};

/**
 * Parent chain of `t` inside the configured repository, nearest first. Stops at a repeated
 * Issue (a cycle, kept so the check reports it) or one level past the maximum depth.
 * ponytail: one GraphQL call per ancestor; one nested query if deep trees get slow.
 */
function ancestors<T extends string>(
  config: OmiConfig,
  t: Ticket,
  gh: GhRunner,
  maxDepth: number,
  typeOf: (t: Ticket) => T | undefined,
): Link<T>[] {
  const repoName = `${config.github.owner}/${config.github.repo}`.toLowerCase();
  const out: Link<T>[] = [];
  let p = t.parent;
  while (p && p.repository.nameWithOwner.toLowerCase() === repoName && out.length < maxDepth) {
    const n = p.number;
    const seen = n === t.number || out.some((l) => l.number === n);
    const parent = seen ? undefined : fetchTicket(config, n, gh);
    out.push({ number: n, type: parent && typeOf(parent) });
    p = parent?.parent ?? null;
  }
  return out;
}

/**
 * Definition of Ready (#128): Objective section, title ↔ `type:*`, required sections of the type's Issue Form (#130), hierarchy. Checked when work
 * starts (`task start`, `ticket validate`), not again at PR time: a run already under way keeps
 * the rules it started with. Also returns the type of the nearest non-task ancestor, read with
 * the chain, for the branch prefix.
 */
export function readyGates(
  t: Ticket,
  config: OmiConfig,
  gh: GhRunner,
): { checks: Check[]; parent?: IssueType } {
  if (workflowModel(config) === "v2") return { checks: readyGatesV2(t, config, gh) };
  const checks: Check[] = [
    /^#{1,6}\s+\W*(objectives?|mục tiêu)/imu.test(t.body.normalize("NFC"))
      ? { name: "objective", status: "pass", detail: "objective present" }
      : {
          name: "objective",
          status: "fail",
          code: "TICKET_INVALID",
          detail: "no Objective section",
        },
  ];
  const type = typeOf(t);
  if (!type) return { checks }; // the type gate reports it
  const h = loadHierarchy();
  checks.push(titleCheck(t.title, type), sectionsCheck(t.body, type));
  let parent: IssueType | undefined;
  try {
    const chain = ancestors(config, t, gh, h.maxDepth, typeOf);
    // A task split under a task keeps its owner's prefix: the nearest ancestor that is not a task.
    parent = chain.find((l) => !l.type || !EXECUTABLE.includes(l.type))?.type;
    checks.push(...hierarchyChecks({ number: t.number, type }, chain, h));
  } catch (e) {
    const err = e instanceof OmiError ? e : new OmiError("INTERNAL", (e as Error).message);
    checks.push({
      name: "hierarchy",
      status: "fail",
      code: err.code,
      detail: `cannot read the parent chain: ${err.message}`,
    });
  }
  return { checks, parent };
}

/** Model v2 Definition of Ready (DevTask-0100 #309): title, sections of the native type's form, tree. */
function readyGatesV2(t: Ticket, config: OmiConfig, gh: GhRunner): Check[] {
  const type = typeOfV2(t);
  if (!type) return []; // the type gate reports it
  const h = loadHierarchyV2();
  const checks = [titleCheckV2(t.title, type), sectionsCheckV2(t.body, type)];
  try {
    const chain = ancestors(config, t, gh, h.maxDepth, typeOfV2);
    checks.push(...hierarchyChecks({ number: t.number, type }, chain, h, t.parent !== null));
  } catch (e) {
    const err = e instanceof OmiError ? e : new OmiError("INTERNAL", (e as Error).message);
    checks.push({
      name: "hierarchy",
      status: "fail",
      code: err.code,
      detail: `cannot read the parent chain: ${err.message}`,
    });
  }
  return checks;
}

/**
 * Ticket gates plus "may this Issue own a worktree" (spec §6: work happens on terminal tasks).
 * `forWork` false (`ticket validate`): under model v2 no start rule applies yet; true: a v2 start
 * is refused until the v2 engine (Feature-0039 / Feature-0040) can run it.
 */
export function startGates(t: Ticket, config: OmiConfig, forWork = true): Check[] {
  const checks = validateTicket(t, config);
  if (workflowModel(config) === "v2") {
    if (forWork) {
      checks.push({
        name: "executable",
        status: "fail",
        code: "POLICY_VIOLATION",
        detail: "task start and run are not available under github.model v2 yet",
      });
    }
    return checks;
  }
  const type = typeOf(t);
  if (type) {
    checks.push(
      EXECUTABLE.includes(type)
        ? { name: "executable", status: "pass", detail: type }
        : {
            name: "executable",
            status: "fail",
            code: "POLICY_VIOLATION",
            detail:
              type === "bug"
                ? "a Bug is fixed through a child DevTask or TestTask: create one and start it"
                : `${type} issues do not get a task branch/worktree`,
          },
    );
  }
  return checks;
}

export function ticketValidate(deps: TaskDeps, issue: number): Check[] {
  // Read-only: no state database is opened or created.
  const { config } = repo(deps.cwd);
  const gh = deps.gh ?? spawnGh;
  const t = fetchTicket(config, issue, gh);
  return [...startGates(t, config, false), ...readyGates(t, config, gh).checks];
}
