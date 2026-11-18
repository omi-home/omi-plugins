// `omi issue create` (DevTask-0046 #129): an Issue of one OMI type, titled
// `<IssueType>-<NNNN>-<Tiêu đề>` (number = highest of that type + 1, read from GitHub), linked as a
// native sub-issue of a parent the hierarchy matrix allows, and added to the configured Project.
// Read before every write: a second run with the same type + title finds the Issue it made and
// only completes the steps still missing; a wrong parent or a cycle is refused before any write.
import { z } from "zod";
import type { OmiConfig } from "../../core/config.ts";
import type { IssueType } from "../../core/contracts.ts";
import { OmiError } from "../../core/errors/errors.ts";
import {
  hierarchyChecks,
  type Link,
  labelType,
  loadHierarchy,
  numberedAs,
  titleType,
} from "../../core/hierarchy.ts";
import { redact } from "../../reporting/redact.ts";
import { type GhRunner, graphql, spawnGh } from "./client.ts";
import { NATIVE_TYPE } from "./ticket.ts";

export interface IssueAt {
  owner: string;
  repo: string;
  number: number;
}

export interface CreateIssueInput {
  type: IssueType;
  title: string;
  body: string;
  parent?: IssueAt;
}

export interface CreateIssueResult {
  number: number;
  url: string;
  title: string;
  created: boolean;
  /** What this run wrote: create, title, parent, project. Empty on a no-op re-run. */
  changes: string[];
}

const labelsOf = z.strictObject({ nodes: z.array(z.strictObject({ name: z.string() })) });
const typeOf = (labels: z.infer<typeof labelsOf>) => labelType(labels.nodes);
const projectItems = z.strictObject({
  nodes: z.array(
    z.strictObject({
      project: z.strictObject({
        number: z.int(),
        owner: z.strictObject({ login: z.string().optional() }),
      }),
    }),
  ),
});
const PROJECT_ITEMS =
  "projectItems(first:20,includeArchived:false){nodes{project{number owner{... on Organization{login} ... on User{login}}}}}";
const inProject = (items: z.infer<typeof projectItems>, c: OmiConfig) =>
  items.nodes.some(
    (n) =>
      n.project.number === c.github.projectNumber &&
      n.project.owner.login?.toLowerCase() === c.github.owner.toLowerCase(),
  );

// --- repository facts -------------------------------------------------------------------------

const FACTS = `query($owner:String!,$repo:String!,$label:String!,$number:Int!){
  repository(owner:$owner,name:$repo){ id url issueTypes(first:25){nodes{id name}} label(name:$label){id} }
  repositoryOwner(login:$owner){
    ... on Organization{projectV2(number:$number){id}} ... on User{projectV2(number:$number){id}} }
}`;
const Facts = z.strictObject({
  repository: z
    .strictObject({
      id: z.string(),
      url: z.string(),
      issueTypes: z
        .strictObject({ nodes: z.array(z.strictObject({ id: z.string(), name: z.string() })) })
        .nullable(),
      label: z.strictObject({ id: z.string() }).nullable(),
    })
    .nullable(),
  repositoryOwner: z
    .strictObject({ projectV2: z.strictObject({ id: z.string() }).nullable().optional() })
    .nullable(),
});

// --- all Issues of the repository (numbering + finding an earlier run's Issue) -----------------

const LIST = `query($owner:String!,$repo:String!,$after:String){
  repository(owner:$owner,name:$repo){ issues(first:100,after:$after,states:[OPEN,CLOSED]){
    pageInfo{hasNextPage endCursor}
    nodes{ id number title state labels(first:20){nodes{name}}
      parent{number repository{nameWithOwner}} ${PROJECT_ITEMS} }
  } }
}`;
const Listed = z.strictObject({
  id: z.string(),
  number: z.int().positive(),
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED"]),
  labels: labelsOf,
  parent: z
    .strictObject({
      number: z.int().positive(),
      repository: z.strictObject({ nameWithOwner: z.string() }),
    })
    .nullable(),
  projectItems,
});
type Listed = z.infer<typeof Listed>;
const ListData = z.strictObject({
  repository: z.strictObject({
    issues: z.strictObject({
      pageInfo: z.strictObject({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
      nodes: z.array(Listed),
    }),
  }),
});

/** ponytail: full scan of the repository's Issues, 100 per call; a search index if repos get huge. */
function listIssues(c: OmiConfig, run: GhRunner): Listed[] {
  const out: Listed[] = [];
  let after: string | null = null;
  do {
    const vars: Record<string, string> = { owner: c.github.owner, repo: c.github.repo };
    if (after) vars.after = after;
    const page = graphql(LIST, vars, ListData, "issue list", run).repository.issues;
    out.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return out;
}

const numbered = numberedAs;
/** The title without its own type prefix, NFC, trimmed: what a re-run compares. */
const bare = (title: string, type: IssueType) =>
  title
    .normalize("NFC")
    .replace(numbered(title, type)?.[0] ?? "", "")
    .trim();

// --- the parent and its ancestors -------------------------------------------------------------

const NODE = "number repository{nameWithOwner} labels(first:20){nodes{name}}";
const parentQuery = (depth: number) => {
  let up = "parent{number repository{nameWithOwner}}"; // one level past depth: "too deep" shows
  for (let i = 0; i < depth; i++) up = `parent{${NODE} ${up}}`;
  return `query($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){
    issue(number:$number){ id state ${NODE} ${PROJECT_ITEMS} ${up} } } }`;
};
interface Up {
  number: number;
  repository: { nameWithOwner: string };
  labels?: z.infer<typeof labelsOf>;
  parent?: Up | null;
}
const Up: z.ZodType<Up> = z.strictObject({
  number: z.int().positive(),
  repository: z.strictObject({ nameWithOwner: z.string() }),
  labels: labelsOf.optional(), // absent on the extra level
  get parent() {
    return Up.nullable().optional();
  },
});
const ParentData = z.strictObject({
  repository: z
    .strictObject({
      issue: z
        .strictObject({
          id: z.string(),
          state: z.enum(["OPEN", "CLOSED"]),
          number: z.int().positive(),
          repository: z.strictObject({ nameWithOwner: z.string() }),
          labels: labelsOf,
          projectItems,
          parent: Up.nullable(),
        })
        .nullable(),
    })
    .nullable(),
});

const refOf = (at: IssueAt) => `${at.owner}/${at.repo}#${at.number}`;

/** Reads the parent and refuses it before any write: closed, outside the Project, wrong type pair, cycle, too deep. */
function checkParent(
  c: OmiConfig,
  at: IssueAt,
  self: Link,
  run: GhRunner,
): { id: string; repository: string } {
  const h = loadHierarchy();
  const p = graphql(parentQuery(h.maxDepth), { ...at }, ParentData, "parent issue", run).repository
    ?.issue;
  if (!p) throw new OmiError("TICKET_INVALID", `parent ${refOf(at)} not found`);
  if (p.state !== "OPEN") throw new OmiError("POLICY_VIOLATION", `parent ${refOf(at)} is closed`);
  const home = `${c.github.owner}/${c.github.repo}`.toLowerCase();
  if (p.repository.nameWithOwner.toLowerCase() !== home && !inProject(p.projectItems, c)) {
    throw new OmiError(
      "TICKET_NOT_IN_PROJECT",
      `parent ${refOf(at)} is in another repository and not in ${c.github.owner} Project #${c.github.projectNumber}`,
    );
  }
  const type = typeOf(p.labels);
  if (!type) throw new OmiError("TICKET_INVALID", `parent ${refOf(at)} has no valid type:* label`);
  const chain: Link[] = [{ number: p.number, type, repo: p.repository.nameWithOwner }];
  for (let n: Up | null | undefined = p.parent; n; n = n.parent) {
    chain.push({
      number: n.number,
      type: n.labels && typeOf(n.labels),
      repo: n.repository.nameWithOwner,
    });
  }
  const bad = hierarchyChecks(self, chain, h).find((x) => x.status === "fail");
  if (bad) throw new OmiError("POLICY_VIOLATION", bad.detail);
  return { id: p.id, repository: p.repository.nameWithOwner };
}

// --- writes -----------------------------------------------------------------------------------

const CREATE = `mutation($repo:ID!,$title:String!,$body:String!,$label:ID!,$type:ID){
  createIssue(input:{repositoryId:$repo,title:$title,body:$body,labelIds:[$label],issueTypeId:$type}){
    issue{id number} } }`;
const Created = z.strictObject({
  createIssue: z.strictObject({
    issue: z.strictObject({ id: z.string(), number: z.int().positive() }),
  }),
});
const SET_TITLE = `mutation($id:ID!,$title:String!){updateIssue(input:{id:$id,title:$title}){issue{id}}}`;
const ADD_SUB = `mutation($p:ID!,$c:ID!){addSubIssue(input:{issueId:$p,subIssueId:$c}){issue{id}}}`;
const ADD_ITEM = `mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id}}}`;
const write = (q: string, vars: Record<string, string>, name: string, run: GhRunner) =>
  graphql(q, vars, z.unknown(), name, run, true);

/** Highest `<Prefix>-NNNN` of `type` among `issues`, other than `except`. */
const highest = (issues: Listed[], type: IssueType, except: number) =>
  Math.max(
    0,
    ...issues
      .filter((i) => i.number !== except)
      .map((i) => Number(numbered(i.title, type)?.[2] ?? 0)),
  );

export function createIssue(
  c: OmiConfig,
  input: CreateIssueInput,
  run: GhRunner = spawnGh,
): CreateIssueResult {
  const { owner, repo, projectNumber } = c.github;
  const text = bare(redact(input.title), input.type);
  if (!text) throw new OmiError("USAGE_INVALID", "--title is empty");

  const facts = graphql(
    FACTS,
    { owner, repo, label: `type:${input.type}`, number: projectNumber },
    Facts,
    "repository facts",
    run,
  );
  const repoId = facts.repository?.id;
  const labelId = facts.repository?.label?.id;
  const projectId = facts.repositoryOwner?.projectV2?.id;
  if (!repoId) throw new OmiError("CONFIG_INVALID", `repository ${owner}/${repo} not accessible`);
  if (!labelId)
    throw new OmiError("CONFIG_INVALID", `label type:${input.type} missing in ${owner}/${repo}`);
  if (!projectId)
    throw new OmiError("CONFIG_INVALID", `Project #${projectNumber} not found for ${owner}`);

  let issues = listIssues(c, run);
  const same = issues.filter(
    (i) =>
      i.state === "OPEN" && typeOf(i.labels) === input.type && bare(i.title, input.type) === text,
  );
  if (same.length > 1) {
    throw new OmiError(
      "POLICY_VIOLATION",
      `several ${input.type} Issues already titled "${text}": ${same.map((i) => `#${i.number}`).join(", ")}`,
    );
  }
  const found = same[0];

  // Every check before the first write.
  const parent = input.parent
    ? checkParent(
        c,
        input.parent,
        { number: found?.number ?? 0, type: input.type, repo: `${owner}/${repo}` },
        run,
      )
    : undefined;
  if (found?.parent && input.parent) {
    const has = `${found.parent.repository.nameWithOwner}#${found.parent.number}`.toLowerCase();
    if (has !== refOf(input.parent).toLowerCase()) {
      throw new OmiError(
        "POLICY_VIOLATION",
        `#${found.number} already has parent ${has}, not ${refOf(input.parent)}`,
      );
    }
  }

  const changes: string[] = [];
  let id = found?.id;
  let number = found?.number;
  if (!id || !number) {
    const nativeName = NATIVE_TYPE[input.type];
    const native = facts.repository?.issueTypes?.nodes.find((t) => t.name === nativeName)?.id;
    const vars: Record<string, string> = {
      repo: repoId,
      title: text,
      body: redact(input.body),
      label: labelId,
    };
    if (native) vars.type = native;
    const made = graphql(CREATE, vars, Created, "create issue", run, true).createIssue.issue;
    ({ id, number } = made);
    changes.push("create");
    issues = [
      ...issues,
      {
        ...made,
        title: text,
        state: "OPEN",
        labels: { nodes: [{ name: `type:${input.type}` }] },
        parent: null,
        projectItems: { nodes: [] },
      },
    ];
  }
  const self = issues.find((i) => i.number === number) as Listed;

  if (parent && !self.parent) {
    write(ADD_SUB, { p: parent.id, c: id }, "add sub-issue", run);
    changes.push("parent");
  }
  if (!inProject(self.projectItems, c)) {
    write(ADD_ITEM, { p: projectId, c: id }, "add to project", run);
    changes.push("project");
  }

  // Number after creating, then re-read: two creators racing for one number → the later Issue
  // takes the next one. ponytail: 3 renumbers, then an error; a lock if creators race harder.
  let title = self.title;
  for (let round = 0; ; round++) {
    const m = numbered(title, input.type);
    const clash =
      m &&
      issues.some(
        (i) => i.number < (number as number) && numbered(i.title, input.type)?.[2] === m[2],
      );
    if (m && !clash) break;
    if (round === 3) {
      throw new OmiError(
        "POLICY_VIOLATION",
        `#${number}: ${title} is still taken by a lower Issue after 3 renumbers; retry`,
      );
    }
    const next = String(highest(issues, input.type, number) + 1).padStart(4, "0");
    title = `${titleType(input.type)}-${next}-${text}`;
    write(SET_TITLE, { id, title }, "set title", run);
    if (!changes.includes("title")) changes.push("title");
    issues = listIssues(c, run);
  }
  return {
    number,
    url: `${facts.repository?.url}/issues/${number}`,
    title,
    created: changes.includes("create"),
    changes,
  };
}
