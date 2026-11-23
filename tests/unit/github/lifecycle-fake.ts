// A stateful fake GitHub for the v2 lifecycle tests (DevTask-0128 #373): every query reads `items`,
// every mutation changes it and is logged in `mutations`.

import { ProjectStatusV2 } from "../../../runtime/shared/contracts.ts";
import type { GhRunner } from "../../../runtime/shared/github/client.ts";

export interface Item {
  number: number;
  type: string;
  status: string | null;
  state?: "OPEN" | "CLOSED";
  stateReason?: string | null;
  parent?: number;
  blockedBy?: number[];
}

export function fakeGithub(items: Item[]) {
  const mutations: string[] = [];
  const byNumber = (n: number) => items.find((i) => i.number === n) as Item;
  const num = (id: string) => Number(id.replace(/^\D+/, ""));
  const repo = { nameWithOwner: "o/r" };
  const content = (i: Item) => ({
    __typename: "Issue",
    number: i.number,
    state: i.state ?? "OPEN",
    stateReason: i.stateReason ?? null,
    repository: repo,
    issueType: { name: i.type },
    milestone: null,
    labels: { pageInfo: { hasNextPage: false }, nodes: [] },
    parent: i.parent ? { number: i.parent, repository: repo } : null,
    subIssues: {
      pageInfo: { hasNextPage: false },
      nodes: items
        .filter((c) => c.parent === i.number)
        .map((c) => ({ number: c.number, repository: repo })),
    },
    blockedBy: {
      pageInfo: { hasNextPage: false },
      nodes: (i.blockedBy ?? []).map((b) => ({
        number: b,
        state: byNumber(b).state ?? "OPEN",
        stateReason: byNumber(b).stateReason ?? null,
        repository: repo,
      })),
    },
    closedByPullRequestsReferences: { pageInfo: { hasNextPage: false }, nodes: [] },
  });
  const run: GhRunner = (args, input) => {
    const vars: Record<string, string> = {};
    let query = "";
    if (args.includes("--input")) {
      const body = JSON.parse(input ?? "{}") as {
        query: string;
        variables: Record<string, string>;
      };
      query = body.query;
      Object.assign(vars, body.variables);
    } else {
      args.forEach((a, k) => {
        if (/^-[fF]$/.test(args[k - 1] ?? "")) {
          const [key, ...v] = a.split("=");
          if (key === "query") query = v.join("=");
          else vars[key as string] = v.join("=");
        }
      });
    }
    const data = (d: unknown) => ({ status: 0, stdout: JSON.stringify({ data: d }), stderr: "" });
    if (query.includes("viewer")) return data({ viewer: { login: "bot" } });
    if (query.includes("items(first:")) {
      return data({
        repositoryOwner: {
          projectV2: {
            items: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: items.map((i) => ({
                fieldValueByName: i.status === null ? null : { name: i.status },
                content: content(i),
              })),
            },
          },
        },
      });
    }
    if (query.includes('field(name:"Status")')) {
      return data({
        repositoryOwner: {
          projectV2: {
            id: "P",
            field: {
              id: "F",
              options: ProjectStatusV2.options.map((n) => ({ id: `opt:${n}`, name: n })),
            },
          },
        },
      });
    }
    if (query.includes("projectItems(first:50")) {
      const i = byNumber(Number(vars.number));
      return data({
        repository: {
          issue: {
            number: i.number,
            parent: null,
            projectItems: {
              nodes: [
                {
                  id: `item${i.number}`,
                  project: { number: 2, owner: { login: "o" } },
                  fieldValueByName: i.status === null ? null : { name: i.status },
                },
              ],
            },
          },
        },
      });
    }
    if (query.includes("issue(number:$number){ id }")) {
      return data({ repository: { issue: { id: `ID${vars.number}` } } });
    }
    if (query.includes("updateProjectV2ItemFieldValue")) {
      byNumber(num(vars.i as string)).status = (vars.o as string).replace("opt:", "");
      mutations.push(`status ${num(vars.i as string)} ${vars.o}`);
    } else if (query.includes("closeIssue")) {
      const i = byNumber(num(vars.id as string));
      i.state = "CLOSED";
      i.stateReason = query.includes("NOT_PLANNED") ? "NOT_PLANNED" : "COMPLETED";
      mutations.push(`close ${i.number} ${i.stateReason}`);
    } else if (query.includes("reopenIssue")) {
      const i = byNumber(num(vars.id as string));
      i.state = "OPEN";
      i.stateReason = "REOPENED";
      mutations.push(`reopen ${i.number}`);
    } else if (query.includes("addComment")) {
      mutations.push(`comment ${vars.id}`);
    } else {
      return { status: 1, stdout: "", stderr: `unexpected query: ${query.slice(0, 80)}` };
    }
    return data({});
  };
  return { run, mutations, items, byNumber };
}
