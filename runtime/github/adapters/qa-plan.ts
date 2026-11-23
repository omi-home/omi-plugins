// `omi qa plan <n>` (DevTask-0143 #408): the QA tasks of Story #n (FR/NFR/CR → QATask "Test design"
// + QATask "Verify" Blocked by the Story's DevTasks) or Bug #n (→ DevTask "Fix" + QATask "Retest"
// Blocked by it). Built on `createIssue` and `addDependency`: read first, write only what is
// missing, so a re-run changes nothing; a task `qa plan` made is recognised by the marker on its
// first body line (`<!-- omi:qa-plan=<n>;kind=… -->`), not by its title.
import { z } from "zod";
import { type OmiConfig, workflowModel } from "../../shared/config.ts";
import { type IssueType, IssueTypeV2 } from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { api, type GhRunner, graphql, spawnGh } from "../../shared/github/client.ts";
import { labelType } from "../application/hierarchy.ts";
import {
  acceptanceOf,
  type BugFacts,
  bugFactsOf,
  changesOf,
  fixBody,
  markerOf,
  type PlanKind,
  planTitle,
  retestBody,
  type StoryFacts,
  type StoryType,
  storyTaskBody,
  storyTypeOf,
} from "../application/qa-plan.ts";
import { addDependency, type DependResult } from "./dependency.ts";
import { createIssue, type IssueAt } from "./issue.ts";

const LABEL_COLOR = "5319e7";

const labelsOf = z.strictObject({ nodes: z.array(z.strictObject({ name: z.string() })) });
const Node = z.strictObject({
  id: z.string(),
  number: z.int().positive(),
  title: z.string(),
  body: z.string(),
  state: z.enum(["OPEN", "CLOSED"]),
  stateReason: z.string().nullable(),
  repository: z.strictObject({ nameWithOwner: z.string() }),
  issueType: z.strictObject({ name: z.string() }).nullable().optional(),
  labels: labelsOf,
});
type Node = z.infer<typeof Node>;
const FIELDS =
  "id number title body state stateReason repository{nameWithOwner} issueType{name} labels(first:20){nodes{name}}";
const READ = `query($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){
  issue(number:$number){ ${FIELDS} subIssues(first:100){ totalCount nodes{ ${FIELDS} } } } } }`;
const ReadData = z.strictObject({
  repository: z
    .strictObject({
      issue: Node.extend({
        subIssues: z.strictObject({ totalCount: z.int(), nodes: z.array(Node) }),
      }).nullable(),
    })
    .nullable(),
});

const ISSUE_ID = `query($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){ issue(number:$number){ id } } }`;
const IdData = z.strictObject({
  repository: z.strictObject({ issue: z.strictObject({ id: z.string() }).nullable() }).nullable(),
});
const LABEL = `query($owner:String!,$repo:String!,$name:String!){ repository(owner:$owner,name:$repo){ label(name:$name){ id } } }`;
const LabelData = z.strictObject({
  repository: z.strictObject({ label: z.strictObject({ id: z.string() }).nullable() }).nullable(),
});
const ADD_LABEL = `mutation($id:ID!,$l:ID!){ addLabelsToLabelable(input:{labelableId:$id,labelIds:[$l]}){ clientMutationId } }`;
const CreatedLabel = z.looseObject({ node_id: z.string() });

export interface PlannedIssue {
  kind: PlanKind;
  /** `owner/repo#n`. */
  ref: string;
  number: number;
  title: string;
  /** False when an earlier run (or a person) already made it. */
  created: boolean;
  /** What this run wrote on it: create, project, parent, status, title, label. */
  changes: string[];
}

export interface QaPlanResult {
  target: { number: number; kind: "story" | "bug"; storyType?: StoryType };
  issues: PlannedIssue[];
  dependencies: DependResult[];
}

const refOf = (a: { owner: string; repo: string; number: number }) =>
  `${a.owner}/${a.repo}#${a.number}`;
const refOfNode = (n: Node) => `${n.repository.nameWithOwner}#${n.number}`;
const atOf = (n: Node): IssueAt => {
  const [owner = "", repo = ""] = n.repository.nameWithOwner.split("/");
  return { owner, repo, number: n.number };
};

/** A native type name (v2) or the legacy `type:*` label of an Issue. */
const typeOf = (n: Node, v2: boolean): string | undefined =>
  v2 ? IssueTypeV2.safeParse(n.issueType?.name).data : labelType(n.labels.nodes);

function read(c: OmiConfig, number: number, run: GhRunner) {
  const { owner, repo } = c.github;
  const issue = graphql(READ, { owner, repo, number }, ReadData, "qa plan issue", run).repository
    ?.issue;
  if (!issue) throw new OmiError("TICKET_INVALID", `#${number} not found in ${owner}/${repo}`);
  if (issue.subIssues.totalCount > issue.subIssues.nodes.length) {
    throw new OmiError(
      "POLICY_VIOLATION",
      `#${number} has ${issue.subIssues.totalCount} sub-issues, only ${issue.subIssues.nodes.length} readable: the plan would not be verified`,
    );
  }
  return issue;
}

/** Adds the label to the Issue, creating the label in the repository when it is missing. */
function addLabel(c: OmiConfig, number: number, name: string, run: GhRunner): void {
  const { owner, repo } = c.github;
  const id = graphql(ISSUE_ID, { owner, repo, number }, IdData, "issue id", run).repository?.issue
    ?.id;
  if (!id) throw new OmiError("TICKET_INVALID", `#${number} not found in ${owner}/${repo}`);
  let labelId = graphql(LABEL, { owner, repo, name }, LabelData, "label", run).repository?.label
    ?.id;
  if (!labelId) {
    const made = api(
      run,
      [
        "-X",
        "POST",
        `repos/${owner}/${repo}/labels`,
        "-f",
        `name=${name}`,
        "-f",
        `color=${LABEL_COLOR}`,
        "-f",
        "description=QATask Test design (omi qa plan)",
      ],
      "create label",
    );
    labelId = CreatedLabel.parse(made).node_id;
  }
  graphql(ADD_LABEL, { id, l: labelId }, z.unknown(), "add label", run, true);
}

/**
 * Plans the QA tasks of Story or Bug `number`. `dev` adds DevTasks the Story does not list as
 * sub-issues (made later, or elsewhere) to the Verify / Retest blockers.
 */
export function qaPlan(
  c: OmiConfig,
  number: number,
  opts: { dev?: IssueAt[] } = {},
  run: GhRunner = spawnGh,
): QaPlanResult {
  const v2 = workflowModel(c) === "v2";
  const { owner, repo } = c.github;
  const target = read(c, number, run);
  const type = typeOf(target, v2);

  let kind: "story" | "bug";
  let storyType: StoryType | undefined;
  if (v2 ? type === "UserStory" : type === "fr" || type === "nfr" || type === "change-request") {
    kind = "story";
    const legacy: Record<string, StoryType> = { fr: "FR", nfr: "NFR", "change-request": "CR" };
    storyType = v2 ? storyTypeOf(target.body) : legacy[type as string];
    if (!storyType) {
      throw new OmiError("TICKET_INVALID", `#${number}: Story Type must be FR, NFR or CR`);
    }
  } else if (type === (v2 ? "Bug" : "bug")) {
    kind = "bug";
  } else {
    throw new OmiError(
      "USAGE_INVALID",
      `#${number} is ${type ?? "of no known type"}: \`qa plan\` takes a Story (FR, NFR, CR) or a Bug`,
    );
  }
  if (target.state !== "OPEN") throw new OmiError("POLICY_VIOLATION", `#${number} is closed`);

  const devType = v2 ? "DevTask" : "dev-task";
  const qaType = v2 ? "QATask" : "test-task";
  const typed = (t: string) => t as IssueType | IssueTypeV2;
  const children = target.subIssues.nodes;
  /** Closed as not planned / duplicate: dropped, so a re-run plans it again. */
  const dropped = (n: Node) => n.state === "CLOSED" && n.stateReason !== "COMPLETED";
  const made = new Map<PlanKind, Node>();
  for (const ch of children) {
    const m = markerOf(ch.body);
    // A Done task counts too: re-running after Verify is Done must not plan a second one.
    if (m && m.target === number && !made.has(m.kind) && !dropped(ch)) made.set(m.kind, ch);
  }

  const parent = { owner, repo, number };
  const issues: PlannedIssue[] = [];
  const ensure = (k: PlanKind, t: string, body: () => string, label?: string): number => {
    const existing = made.get(k);
    const changes: string[] = [];
    let at: { number: number; title: string; ref: string };
    let created = false;
    if (existing) at = { number: existing.number, title: existing.title, ref: refOfNode(existing) };
    else {
      const r = createIssue(
        c,
        { type: typed(t), title: planTitle(number, k), body: body(), parent },
        run,
      );
      changes.push(...r.changes);
      created = r.created;
      at = { number: r.number, title: r.title, ref: `${owner}/${repo}#${r.number}` };
    }
    if (label && !existing?.labels.nodes.some((l) => l.name === label)) {
      addLabel(c, at.number, label, run);
      changes.push("label");
    }
    issues.push({ kind: k, ...at, created, changes });
    return at.number;
  };

  const blockers = new Map<string, IssueAt>();
  for (const ch of children) {
    if (typeOf(ch, v2) === devType && !dropped(ch))
      blockers.set(refOfNode(ch).toLowerCase(), atOf(ch));
  }
  for (const d of opts.dev ?? []) blockers.set(refOf(d).toLowerCase(), d);

  let gate: number;
  if (kind === "story") {
    const ac = acceptanceOf(target.body);
    if (!ac) {
      throw new OmiError(
        "TICKET_INVALID",
        `#${number} has no Acceptance Criteria: \`task analyze ${number}\` first`,
      );
    }
    const facts: StoryFacts = {
      number,
      type: storyType as StoryType,
      ac,
      changes: storyType === "CR" ? changesOf(target.body) : undefined,
    };
    ensure("test-design", qaType, () => storyTaskBody("test-design", facts), c.qa.designLabel);
    gate = ensure("verify", qaType, () => storyTaskBody("verify", facts));
  } else {
    const facts: BugFacts | undefined = bugFactsOf(number, target.title, target.body);
    if (!facts) {
      throw new OmiError(
        "TICKET_INVALID",
        `Bug #${number} needs Steps to reproduce and Expected / Actual before it can be planned`,
      );
    }
    const fix = ensure("fix", devType, () => fixBody(facts));
    blockers.set(`${owner}/${repo}#${fix}`.toLowerCase(), { owner, repo, number: fix });
    gate = ensure("retest", qaType, () => retestBody(facts));
  }

  const dependencies = [...blockers.values()].map((b) =>
    addDependency({ owner, repo, number: gate }, b, run),
  );
  return {
    target: { number, kind, ...(storyType ? { storyType } : {}) },
    issues,
    dependencies,
  };
}
