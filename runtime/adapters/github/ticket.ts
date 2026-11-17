// Ticket lookup and ticket-first gates 1–2 (spec §8): exists, open, in the configured
// Project, valid OMI type, terminal, open parent, acceptance criteria, no open blockers.
import { z } from "zod";
import type { OmiConfig } from "../../core/config.ts";
import { type Check, IssueType } from "../../core/contracts.ts";
import { OmiError } from "../../core/errors/errors.ts";
import { type GhRunner, graphql, spawnGh } from "./client.ts";

const PAGE = 50;

const QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    issue(number:$number){
      number title state body
      issueType{name}
      labels(first:${PAGE}){totalCount nodes{name}}
      parent{number state repository{nameWithOwner}}
      subIssuesSummary{total completed}
      blockedBy(first:${PAGE}){totalCount nodes{number state repository{nameWithOwner}}}
      projectItems(first:${PAGE},includeArchived:false){totalCount nodes{id isArchived
        project{number owner{... on Organization{login} ... on User{login}}}
        fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}
    }
  }
}`;

const State = z.enum(["OPEN", "CLOSED"]);
const LinkedIssue = z.strictObject({
  number: z.int().positive(),
  state: State,
  repository: z.strictObject({ nameWithOwner: z.string() }),
});
const conn = <T extends z.ZodType>(node: T) =>
  z.strictObject({ totalCount: z.int().min(0), nodes: z.array(node) });

export const Ticket = z.strictObject({
  number: z.int().positive(),
  title: z.string(),
  state: State,
  body: z.string(),
  issueType: z.strictObject({ name: z.string() }).nullable(),
  labels: conn(z.strictObject({ name: z.string() })),
  parent: LinkedIssue.nullable(),
  subIssuesSummary: z.strictObject({ total: z.int().min(0), completed: z.int().min(0) }),
  blockedBy: conn(LinkedIssue),
  projectItems: conn(
    z.strictObject({
      id: z.string(),
      isArchived: z.boolean(),
      project: z.strictObject({
        number: z.int().positive(),
        // Empty object when the owner is neither an Organization nor a User.
        owner: z.strictObject({ login: z.string().optional() }),
      }),
      // `{}` when the Status value is not single-select; null when unset.
      fieldValueByName: z.strictObject({ name: z.string().optional() }).nullable(),
    }),
  ),
});
export type Ticket = z.infer<typeof Ticket>;

const Response = z.strictObject({
  repository: z.strictObject({ issue: Ticket.nullable() }).nullable(),
});

/** Reads one Issue of the configured repository; throws TICKET_INVALID when it does not exist. */
export function fetchTicket(config: OmiConfig, number: number, run: GhRunner = spawnGh): Ticket {
  const { owner, repo } = config.github;
  const data = graphql(QUERY, { owner, repo, number }, Response, "ticket lookup", run);
  if (!data.repository) {
    throw new OmiError("TICKET_INVALID", `repository ${owner}/${repo} not found or not accessible`);
  }
  if (!data.repository.issue) {
    throw new OmiError("TICKET_INVALID", `issue ${owner}/${repo}#${number} not found`);
  }
  return data.repository.issue;
}

/** Native Issue Type expected for an OMI type (ADR-0001 D6); unlisted types have none. */
const NATIVE_TYPE: Partial<Record<IssueType, string>> = {
  bug: "Bug",
  feature: "Feature",
  "dev-task": "Task",
  "test-task": "Task",
  "devops-task": "Task",
  "documentation-task": "Task",
};

const ACCEPTANCE = /^#{1,6}\s.*(acceptance|definition of done|tiêu chí)|^\s*[-*]\s\[[ x]\]/im;

const pass = (name: string, detail: string): Check => ({ name, status: "pass", detail });
const warn = (name: string, detail: string): Check => ({ name, status: "warn", detail });
const fail = (name: string, detail: string, code: Check["code"] = "TICKET_INVALID"): Check => ({
  name,
  status: "fail",
  detail,
  code,
});

const ref = (i: z.infer<typeof LinkedIssue>) => `${i.repository.nameWithOwner}#${i.number}`;

/** Pure gate evaluation; every gate reports, none short-circuits. */
export function validateTicket(t: Ticket, config: OmiConfig): Check[] {
  const { owner, projectNumber } = config.github;
  const checks: Check[] = [];

  checks.push(t.state === "OPEN" ? pass("state", "open") : fail("state", "issue is closed"));

  const item = t.projectItems.nodes.find(
    (n) => !n.isArchived && n.project.number === projectNumber && n.project.owner.login === owner,
  );
  checks.push(
    item
      ? pass(
          "project",
          `${owner} Project #${projectNumber}, Status ${item.fieldValueByName?.name ?? "unset"}`,
        )
      : t.projectItems.totalCount > t.projectItems.nodes.length
        ? fail("project", "too many Project items to verify membership", "TICKET_NOT_IN_PROJECT")
        : fail("project", `not in ${owner} Project #${projectNumber}`, "TICKET_NOT_IN_PROJECT"),
  );

  const types = t.labels.nodes
    .map((l) => /^type:(.+)$/.exec(l.name)?.[1])
    .filter((s): s is string => s !== undefined);
  const type = types.length === 1 ? IssueType.safeParse(types[0]).data : undefined;
  if (!type) {
    checks.push(
      fail(
        "type",
        types.length
          ? `expected one valid type:<OMI type> label, got ${types.map((s) => `type:${s}`).join(", ")}`
          : "missing type:<OMI type> label",
      ),
    );
  } else {
    const native = NATIVE_TYPE[type];
    checks.push(
      !native || t.issueType?.name === native
        ? pass("type", type)
        : warn(
            "type",
            `${type}: native Issue Type is ${t.issueType?.name ?? "unset"}, expected ${native}`,
          ),
    );
  }

  checks.push(
    t.subIssuesSummary.total === 0
      ? pass("terminal", "no sub-issues")
      : fail(
          "terminal",
          `has ${t.subIssuesSummary.total} sub-issue(s): work happens on terminal issues`,
        ),
  );

  checks.push(
    !t.parent
      ? pass("parent", "none")
      : t.parent.state === "OPEN"
        ? pass("parent", ref(t.parent))
        : fail("parent", `parent ${ref(t.parent)} is closed`),
  );

  checks.push(
    !t.body.trim()
      ? fail("acceptance", "issue body is empty")
      : ACCEPTANCE.test(t.body)
        ? pass("acceptance", "acceptance criteria present")
        : warn("acceptance", "no acceptance / Definition of Done section or checklist"),
  );

  const open = t.blockedBy.nodes.filter((b) => b.state === "OPEN");
  const unseen = t.blockedBy.totalCount - t.blockedBy.nodes.length;
  checks.push(
    open.length || unseen > 0
      ? fail(
          "dependencies",
          [
            open.length && `blocked by ${open.map(ref).join(", ")}`,
            unseen > 0 && `${unseen} blocker(s) not verified`,
          ]
            .filter(Boolean)
            .join("; "),
          "DEPENDENCY_BLOCKED",
        )
      : pass(
          "dependencies",
          t.blockedBy.totalCount ? `${t.blockedBy.totalCount} blocker(s) closed` : "none",
        ),
  );
  return checks;
}
