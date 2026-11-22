// `omi issue create` (DevTask-0046 #129): an Issue of one OMI type, titled
// `<IssueType>-<NNNN>-<Tiêu đề>` (number = highest of that type + 1, read from GitHub), linked as a
// native sub-issue of a parent the hierarchy matrix allows, and added to the configured Project.
// Read before every write: a second run with the same type + title finds the Issue it made and
// only completes the steps still missing; a wrong parent or a cycle is refused before any write.
import { z } from "zod";
import { type OmiConfig, workflowModel } from "../../shared/config.ts";
import { type IssueType, IssueTypeV2 } from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { type GhRunner, graphql, spawnGh } from "../../shared/github/client.ts";
import { redact } from "../../shared/redact.ts";
import { resolveWorkflow } from "../../shared/workflow.ts";
import {
  hierarchyChecks,
  type Link,
  labelType,
  loadHierarchy,
  loadHierarchyV2,
  TITLE_PREFIX,
  titleType,
} from "../application/hierarchy.ts";
import { loadForm, missingSections, sectionsCheckV2 } from "../application/issue-forms.ts";
import { loadProjectConfig } from "../application/project-config.ts";
import { NATIVE_TYPE } from "../domain/native-type.ts";
import { initialStatus } from "../domain/workflow-queries.ts";
import { setItemStatus, statusField } from "./project.ts";

export interface IssueAt {
  owner: string;
  repo: string;
  number: number;
}

export interface CreateIssueInput {
  /** Legacy model: an OMI type (`dev-task`); v2: a native type name (`DevTask`). */
  type: IssueType | IssueTypeV2;
  title: string;
  body: string;
  parent?: IssueAt;
}

export interface CreateIssueResult {
  number: number;
  url: string;
  title: string;
  created: boolean;
  /** What this run wrote: create, title, parent, project, status. Empty on a no-op re-run. */
  changes: string[];
}

const labelsOf = z.strictObject({ nodes: z.array(z.strictObject({ name: z.string() })) });
const issueTypeOf = z.strictObject({ name: z.string() }).nullable().optional();
/** The type of an Issue under the model in use: the native type name (v2) or the `type:*` label. */
const typeOf = (
  n: { labels?: z.infer<typeof labelsOf>; issueType?: z.infer<typeof issueTypeOf> },
  v2: boolean,
): string | undefined =>
  v2 ? IssueTypeV2.safeParse(n.issueType?.name).data : n.labels && labelType(n.labels.nodes);
const projectItems = z.strictObject({
  nodes: z.array(
    z.strictObject({
      id: z.string().optional(),
      project: z.strictObject({
        number: z.int(),
        owner: z.strictObject({ login: z.string().optional() }),
      }),
      fieldValueByName: z.strictObject({ name: z.string().optional() }).nullable().optional(),
    }),
  ),
});
const PROJECT_ITEMS =
  'projectItems(first:20,includeArchived:false){nodes{id project{number owner{... on Organization{login} ... on User{login}}} fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}';
const projectItem = (items: z.infer<typeof projectItems>, c: OmiConfig) =>
  items.nodes.find(
    (n) =>
      n.project.number === c.github.projectNumber &&
      n.project.owner.login?.toLowerCase() === c.github.owner.toLowerCase(),
  );
const inProject = (items: z.infer<typeof projectItems>, c: OmiConfig) => !!projectItem(items, c);

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
    nodes{ id number title state issueType{name} labels(first:20){nodes{name}}
      parent{number repository{nameWithOwner}} ${PROJECT_ITEMS} }
  } }
}`;
const Listed = z.strictObject({
  id: z.string(),
  number: z.int().positive(),
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED"]),
  issueType: issueTypeOf,
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

/** `TITLE_PREFIX` match of `title` when its prefix is `prefix`. */
const numbered = (title: string, prefix: string) => {
  const m = TITLE_PREFIX.exec(title);
  return m?.[1] === prefix ? m : null;
};
/** The title prefix of a type: the native name (v2) or `dev-task` → `DevTask`. */
const prefixOf = (type: string, v2: boolean) => (v2 ? type : titleType(type as IssueType));
/** The title without its own type prefix, NFC, trimmed: what a re-run compares. */
const bare = (title: string, prefix: string) =>
  title
    .normalize("NFC")
    .replace(numbered(title, prefix)?.[0] ?? "", "")
    .trim();

// --- the parent and its ancestors -------------------------------------------------------------

const NODE = "number repository{nameWithOwner} issueType{name} labels(first:20){nodes{name}}";
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
  issueType?: z.infer<typeof issueTypeOf>;
  parent?: Up | null;
}
const Up: z.ZodType<Up> = z.strictObject({
  number: z.int().positive(),
  repository: z.strictObject({ nameWithOwner: z.string() }),
  labels: labelsOf.optional(), // absent on the extra level
  issueType: issueTypeOf,
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
          issueType: issueTypeOf,
          projectItems,
          parent: Up.nullable(),
        })
        .nullable(),
    })
    .nullable(),
});

const refOf = (at: IssueAt) => `${at.owner}/${at.repo}#${at.number}`;

/** The tree of the model in use; only v2 has `roots` (types that take no parent). */
const hierarchyOf = (
  v2: boolean,
): {
  maxDepth: number;
  children: Partial<Record<string, readonly string[]>>;
  roots?: readonly string[];
} => (v2 ? loadHierarchyV2() : loadHierarchy());

/** Reads the parent and refuses it before any write: closed, outside the Project, wrong type pair, cycle, too deep. */
function checkParent(
  c: OmiConfig,
  at: IssueAt,
  self: Link<string>,
  run: GhRunner,
): { id: string; repository: string } {
  const v2 = workflowModel(c) === "v2";
  const h = hierarchyOf(v2);
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
  const type = typeOf(p, v2);
  if (!type) {
    throw new OmiError(
      "TICKET_INVALID",
      `parent ${refOf(at)} has no valid ${v2 ? "native issue type" : "type:* label"}`,
    );
  }
  const chain: Link<string>[] = [{ number: p.number, type, repo: p.repository.nameWithOwner }];
  for (let n: Up | null | undefined = p.parent; n; n = n.parent) {
    chain.push({ number: n.number, type: typeOf(n, v2), repo: n.repository.nameWithOwner });
  }
  const bad = hierarchyChecks(self, chain, h).find((x) => x.status === "fail");
  if (bad) throw new OmiError("POLICY_VIOLATION", bad.detail);
  return { id: p.id, repository: p.repository.nameWithOwner };
}

// --- writes -----------------------------------------------------------------------------------

const CREATE = `mutation($repo:ID!,$title:String!,$body:String!,$label:ID!,$type:ID){
  createIssue(input:{repositoryId:$repo,title:$title,body:$body,labelIds:[$label],issueTypeId:$type}){
    issue{id number} } }`;
/** Model v2: the native issue type replaces the `type:*` label. */
const CREATE_V2 = `mutation($repo:ID!,$title:String!,$body:String!,$type:ID!){
  createIssue(input:{repositoryId:$repo,title:$title,body:$body,issueTypeId:$type}){
    issue{id number} } }`;
const Created = z.strictObject({
  createIssue: z.strictObject({
    issue: z.strictObject({ id: z.string(), number: z.int().positive() }),
  }),
});
const SET_TITLE = `mutation($id:ID!,$title:String!){updateIssue(input:{id:$id,title:$title}){issue{id}}}`;
const ADD_SUB = `mutation($p:ID!,$c:ID!){addSubIssue(input:{issueId:$p,subIssueId:$c}){issue{id}}}`;
const ADD_ITEM = `mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id}}}`;
const Added = z.strictObject({
  addProjectV2ItemById: z.strictObject({ item: z.strictObject({ id: z.string() }) }),
});
const write = (q: string, vars: Record<string, string>, name: string, run: GhRunner) =>
  graphql(q, vars, z.unknown(), name, run, true);

/** Highest `<Prefix>-NNNN` of `type` among `issues`, other than `except`. */
const highest = (issues: Listed[], prefix: string, except: number) =>
  Math.max(
    0,
    ...issues
      .filter((i) => i.number !== except)
      .map((i) => Number(numbered(i.title, prefix)?.[2] ?? 0)),
  );

export function createIssue(
  c: OmiConfig,
  input: CreateIssueInput,
  run: GhRunner = spawnGh,
): CreateIssueResult {
  const { owner, repo, projectNumber } = c.github;
  const v2 = workflowModel(c) === "v2";
  const type: string = input.type;
  // Legacy keeps its behaviour (an unknown type fails on its missing label).
  if (v2 && !IssueTypeV2.safeParse(type).success) {
    throw new OmiError(
      "USAGE_INVALID",
      `--type must be one of ${IssueTypeV2.options.join(", ")} (github.model v2)`,
    );
  }
  const prefix = prefixOf(type, v2);
  const text = bare(redact(input.title), prefix);
  if (!text) throw new OmiError("USAGE_INVALID", "--title is empty");

  const facts = graphql(
    FACTS,
    { owner, repo, label: `type:${type}`, number: projectNumber },
    Facts,
    "repository facts",
    run,
  );
  const repoId = facts.repository?.id;
  const labelId = facts.repository?.label?.id;
  const projectId = facts.repositoryOwner?.projectV2?.id;
  if (!repoId) throw new OmiError("CONFIG_INVALID", `repository ${owner}/${repo} not accessible`);
  // v2 has no type label; the native type must exist instead (`omi github project apply` makes it).
  const native = facts.repository?.issueTypes?.nodes.find(
    (t) => t.name === (v2 ? type : NATIVE_TYPE[type as IssueType]),
  )?.id;
  if (v2 && !native) {
    throw new OmiError(
      "CONFIG_INVALID",
      `issue type ${type} missing in ${owner}: run \`omi github project apply\``,
    );
  }
  if (!v2 && !labelId)
    throw new OmiError("CONFIG_INVALID", `label type:${type} missing in ${owner}/${repo}`);
  if (!projectId)
    throw new OmiError("CONFIG_INVALID", `Project #${projectNumber} not found for ${owner}`);

  let issues = listIssues(c, run);
  const same = issues.filter(
    (i) => i.state === "OPEN" && typeOf(i, v2) === type && bare(i.title, prefix) === text,
  );
  if (same.length > 1) {
    throw new OmiError(
      "POLICY_VIOLATION",
      `several ${type} Issues already titled "${text}": ${same.map((i) => `#${i.number}`).join(", ")}`,
    );
  }
  const found = same[0];
  if (!found) {
    if (v2) {
      const gate = sectionsCheckV2(input.body, type as IssueTypeV2);
      if (gate.status === "fail") {
        throw new OmiError("TICKET_INVALID", `--body-file: ${gate.detail}`);
      }
    } else {
      const missing = missingSections(input.body, loadForm(type as IssueType));
      if (missing.length) {
        throw new OmiError(
          "TICKET_INVALID",
          `--body-file is missing required sections of the ${type} Issue Form: ${missing.join(", ")}`,
        );
      }
    }
  }

  // Every check before the first write.
  const me: Link<string> = { number: found?.number ?? 0, type, repo: `${owner}/${repo}` };
  const parent = input.parent ? checkParent(c, input.parent, me, run) : undefined;
  if (v2 && !input.parent) {
    // Only Epic, Doc and ADR have no parent: any other type needs one (ADR-0005 D3).
    const bad = hierarchyChecks(me, [], hierarchyOf(true), !!found?.parent).find(
      (x) => x.status === "fail",
    );
    if (bad) throw new OmiError("POLICY_VIOLATION", bad.detail);
  }
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
    const vars: Record<string, string> = { repo: repoId, title: text, body: redact(input.body) };
    if (!v2 && labelId) vars.label = labelId;
    if (native) vars.type = native;
    const made = graphql(v2 ? CREATE_V2 : CREATE, vars, Created, "create issue", run, true)
      .createIssue.issue;
    ({ id, number } = made);
    changes.push("create");
    issues = [
      ...issues,
      {
        ...made,
        title: text,
        state: "OPEN",
        issueType: v2 ? { name: type } : null,
        labels: { nodes: v2 ? [] : [{ name: `type:${type}` }] },
        parent: null,
        projectItems: { nodes: [] },
      },
    ];
  }
  const self = issues.find((i) => i.number === number) as Listed;

  const item = projectItem(self.projectItems, c);
  let itemId = item?.id;
  if (!item) {
    itemId = graphql(ADD_ITEM, { p: projectId, c: id }, Added, "add to project", run, true)
      .addProjectV2ItemById.item.id;
    changes.push("project");
  }
  // After the Project add: a new Project's built-in "auto-add sub-issues" workflow would otherwise
  // race it and the add fails with "Content already exists in this project".
  if (parent && !self.parent) {
    write(ADD_SUB, { p: parent.id, c: id }, "add sub-issue", run);
    changes.push("parent");
  }
  // Initial Status from the desired state (DevTask-0030 #62); set once, never overwritten.
  // A Project without that option (`omi github project apply` not run) leaves it unset, reported as
  // drift by `omi github project plan`, rather than failing an Issue that is already created.
  if (itemId && !item?.fieldValueByName?.name) {
    try {
      const initial = v2
        ? initialStatus(type as IssueTypeV2, resolveWorkflow(c.github.workflow))
        : loadProjectConfig().initialStatus;
      setItemStatus(statusField(c, run), itemId, initial, run);
      changes.push("status");
    } catch (e) {
      if (!(e instanceof OmiError && e.code === "CONFIG_INVALID")) throw e;
    }
  }

  // Number after creating, then re-read: two creators racing for one number → the later Issue
  // takes the next one. ponytail: 3 renumbers, then an error; a lock if creators race harder.
  let title = self.title;
  for (let round = 0; ; round++) {
    const m = numbered(title, prefix);
    const clash =
      m &&
      issues.some((i) => i.number < (number as number) && numbered(i.title, prefix)?.[2] === m[2]);
    if (m && !clash) break;
    if (round === 3) {
      throw new OmiError(
        "POLICY_VIOLATION",
        `#${number}: ${title} is still taken by a lower Issue after 3 renumbers; retry`,
      );
    }
    const next = String(highest(issues, prefix, number) + 1).padStart(4, "0");
    title = `${prefix}-${next}-${text}`;
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
