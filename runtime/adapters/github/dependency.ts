// `omi issue depend` (DevTask-0029 #60): record "A is blocked by B" with GitHub's native
// dependency (addBlockedBy, Spike-0005 #8). Read → diff → write: an existing link is a no-op
// (GitHub errors on duplicates), a link that would close a cycle is refused. Blockers may live in
// another repository; `omi ticket validate` keeps an Issue with open blockers out of `task start`.
import { z } from "zod";
import { OmiError } from "../../core/errors/errors.ts";
import { type GhRunner, graphql, spawnGh } from "./client.ts";
import type { IssueAt } from "./issue.ts";

const PAGE = 50;
/**
 * ponytail: the cycle search reads one Issue per gh call and refuses past this many; batch a BFS
 * frontier into one aliased query if graphs grow.
 */
const MAX_VISITED = 200;

const NODE = `query($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){
  issue(number:$number){ id number repository{ nameWithOwner }
    blockedBy(first:${PAGE}){ totalCount nodes{ number repository{ nameWithOwner } } } } } }`;

const Ref = z.strictObject({
  number: z.int(),
  repository: z.strictObject({ nameWithOwner: z.string() }),
});
const NodeData = z.strictObject({
  repository: z
    .strictObject({
      issue: Ref.extend({
        id: z.string(),
        blockedBy: z.strictObject({ totalCount: z.int(), nodes: z.array(Ref) }),
      }).nullable(),
    })
    .nullable(),
});

const ADD = `mutation($i:ID!,$b:ID!){ addBlockedBy(input:{issueId:$i,blockingIssueId:$b}){ issue{ id } } }`;

const key = (r: z.infer<typeof Ref>) => `${r.repository.nameWithOwner}#${r.number}`.toLowerCase();
const at = (r: z.infer<typeof Ref>): IssueAt => {
  const [owner = "", repo = ""] = r.repository.nameWithOwner.split("/");
  return { owner, repo, number: r.number };
};

function read(i: IssueAt, run: GhRunner) {
  const n = graphql(NODE, { ...i }, NodeData, "issue dependencies", run).repository?.issue;
  if (!n) {
    throw new OmiError(
      "TICKET_INVALID",
      `${i.owner}/${i.repo}#${i.number} not found or not readable`,
    );
  }
  if (n.blockedBy.totalCount > n.blockedBy.nodes.length) {
    throw new OmiError(
      "POLICY_VIOLATION",
      `${key(n)}: ${n.blockedBy.totalCount - n.blockedBy.nodes.length} blocker(s) not readable (private repository, or above ${PAGE}): cycle check not verified`,
    );
  }
  return n;
}

export interface DependResult {
  issue: string;
  blockedBy: string;
  added: boolean;
}

/** Makes `issue` blocked by `on`. Refuses itself, cycles and graphs it cannot fully read. */
export function addDependency(issue: IssueAt, on: IssueAt, run: GhRunner = spawnGh): DependResult {
  const a = read(issue, run);
  const b = read(on, run);
  const result = { issue: key(a), blockedBy: key(b) };
  if (result.issue === result.blockedBy) {
    throw new OmiError("USAGE_INVALID", "an Issue cannot block itself");
  }
  if (a.blockedBy.nodes.some((x) => key(x) === result.blockedBy))
    return { ...result, added: false };

  // Would `a` become reachable from itself? Walk what `b` is (transitively) blocked by.
  const path = new Map<string, string | null>([[result.blockedBy, null]]);
  const queue = [b];
  while (queue.length) {
    const cur = queue.shift() as typeof b;
    for (const next of cur.blockedBy.nodes) {
      const k = key(next);
      if (path.has(k)) continue;
      path.set(k, key(cur));
      if (k === result.issue) {
        const chain = [k];
        for (let p = path.get(k); p; p = path.get(p) ?? null) chain.push(p);
        throw new OmiError(
          "POLICY_VIOLATION",
          `cycle: ${[result.issue, ...chain.reverse()].join(" → ")} (blocked by)`,
        );
      }
      if (path.size > MAX_VISITED) {
        throw new OmiError(
          "POLICY_VIOLATION",
          `dependency graph above ${MAX_VISITED} Issues: not verified`,
        );
      }
      queue.push(read(at(next), run));
    }
  }
  graphql(ADD, { i: a.id, b: b.id }, z.unknown(), "add blocked-by", run);
  return { ...result, added: true };
}
