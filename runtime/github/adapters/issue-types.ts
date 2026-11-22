// Native issue types of the organization (model v2; DevTask-0101 #310, ADR-0005 D1/D8): read,
// diff and write with createIssueType / updateIssueType. Read → diff → write; a second run writes
// nothing. Never deletes or disables a type. Only an organization owns issue types.
import { z } from "zod";
import type { OmiConfig } from "../../shared/config.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { type GhRunner, graphql, spawnGh } from "../../shared/github/client.ts";
import {
  type ActualIssueType,
  type IssueTypeAction,
  type IssueTypePlan,
  type IssueTypesConfig,
  issueTypeWrites,
  loadIssueTypesConfig,
  planIssueTypes,
} from "../application/issue-type-config.ts";

export const ADMIN_ORG_HINT = "gh auth refresh -s admin:org";

const READ = `query($owner:String!){ repositoryOwner(login:$owner){ __typename id
  ... on Organization{ issueTypes(first:25){ nodes{ id name description color isEnabled } } } } }`;

const Read = z.strictObject({
  repositoryOwner: z
    .strictObject({
      __typename: z.string(),
      id: z.string(),
      issueTypes: z
        .strictObject({
          nodes: z.array(
            z.strictObject({
              id: z.string(),
              name: z.string(),
              description: z.string().nullable(),
              color: z.string().nullable(),
              isEnabled: z.boolean(),
            }),
          ),
        })
        .optional(),
    })
    .nullable(),
});

const CREATE = `mutation($input:CreateIssueTypeInput!){ createIssueType(input:$input){ issueType{ id } } }`;
const UPDATE = `mutation($input:UpdateIssueTypeInput!){ updateIssueType(input:$input){ issueType{ id } } }`;

export interface OrgIssueTypes {
  ownerId: string;
  types: ActualIssueType[];
}

/** The organization's issue types. A personal account has none: refused (ADR-0005 D8). */
export function readOrgIssueTypes(owner: string, run: GhRunner = spawnGh): OrgIssueTypes {
  const o = graphql(READ, { owner }, Read, "issue types", run).repositoryOwner;
  if (!o) throw new OmiError("CONFIG_INVALID", `owner ${owner} not found or not accessible`);
  if (o.__typename !== "Organization" || !o.issueTypes) {
    throw new OmiError(
      "CONFIG_INVALID",
      `${owner} is a personal account: model v2 needs an organization to own the issue types (ADR-0005 D8)`,
    );
  }
  return { ownerId: o.id, types: o.issueTypes.nodes };
}

/**
 * OAuth scopes of the token `gh` uses (`X-OAuth-Scopes` header); undefined when GitHub sends none
 * (a fine-grained or app token): then the scope cannot be told.
 */
export function tokenScopes(run: GhRunner = spawnGh): string[] | undefined {
  const r = run(["api", "--include", "user"]);
  const header = /^x-oauth-scopes:[ \t]*(.*)$/im.exec(r.stdout ?? "");
  if (!header) return undefined;
  return (header[1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `admin:org` present, absent, or unknown (undefined). */
export const hasAdminOrg = (scopes: string[] | undefined) => scopes?.includes("admin:org");

const missingScope = (what: string) =>
  new OmiError(
    "GITHUB_AUTH",
    `${what}: the token lacks the admin:org scope: run \`${ADMIN_ORG_HINT}\``,
  );

export function issueTypePlan(
  c: Pick<OmiConfig, "github">,
  run: GhRunner = spawnGh,
  desired: IssueTypesConfig = loadIssueTypesConfig(),
): IssueTypePlan {
  return planIssueTypes(desired, readOrgIssueTypes(c.github.owner, run).types);
}

/**
 * Creates missing types and updates name / description / color (and enables a disabled one).
 * Refuses before any write when the token is known to lack `admin:org`; a GitHub auth refusal
 * on a write gets the same hint. Reads back after writing. Never deletes or disables.
 */
export function issueTypeApply(
  c: Pick<OmiConfig, "github">,
  run: GhRunner = spawnGh,
  desired: IssueTypesConfig = loadIssueTypesConfig(),
): { applied: IssueTypeAction[]; plan: IssueTypePlan } {
  const read = readOrgIssueTypes(c.github.owner, run);
  const plan = planIssueTypes(desired, read.types);
  const todo = issueTypeWrites(plan);
  if (!todo.length) return { applied: [], plan };
  if (hasAdminOrg(tokenScopes(run)) === false) throw missingScope("issue types");
  for (const a of todo) {
    try {
      if (a.kind === "create-issue-type") {
        graphql(
          CREATE,
          {
            input: {
              ownerId: read.ownerId,
              name: a.type.name,
              description: a.type.description,
              color: a.type.color,
              isEnabled: true,
            },
          },
          z.unknown(),
          `create issue type ${a.type.name}`,
          run,
          true,
        );
      } else if (a.kind === "update-issue-type") {
        graphql(
          UPDATE,
          { input: { issueTypeId: a.id, ...a.set } },
          z.unknown(),
          `update issue type ${a.name}`,
          run,
          true,
        );
      }
    } catch (e) {
      if (e instanceof OmiError && e.code === "GITHUB_AUTH") {
        throw missingScope(e.message);
      }
      throw e;
    }
  }
  return { applied: todo, plan: issueTypePlan(c, run, desired) };
}
