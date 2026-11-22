// DevTask-0101 #310: native issue types of the organization against an in-memory GitHub:
// plan / apply read → diff → write, a second run writes nothing, nothing is ever deleted or
// disabled, a personal account and a missing admin:org scope are refused with guidance.
import assert from "node:assert/strict";
import { test } from "node:test";
import { issueTypeChecks } from "../../../runtime/cli/doctor.ts";
import {
  hasAdminOrg,
  issueTypeApply,
  issueTypePlan,
  tokenScopes,
} from "../../../runtime/github/adapters/issue-types.ts";
import { projectPlan, projectValidate } from "../../../runtime/github/adapters/project-fields.ts";
import { loadIssueTypesConfig } from "../../../runtime/github/application/issue-type-config.ts";
import type { OmiConfig } from "../../../runtime/shared/config.ts";
import type { OmiError } from "../../../runtime/shared/errors/errors.ts";
import type { GhRunner } from "../../../runtime/shared/github/client.ts";

const v2 = { github: { owner: "o", repo: "repo", projectNumber: 2, model: "v2" } } as OmiConfig;
const legacy = { github: { owner: "o", repo: "repo", projectNumber: 2 } } as OmiConfig;
const desired = loadIssueTypesConfig().types;

interface FakeType {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  isEnabled: boolean;
}
/** An organization type already as desired. */
const exact = (name: string): FakeType => {
  const d = desired.find((t) => t.name === name);
  assert.ok(d);
  return { id: `IT_${name}`, name, description: d.description, color: d.color, isEnabled: true };
};

function fakeOrg(
  seed: FakeType[],
  opts: {
    kind?: "Organization" | "User";
    /** Value of X-OAuth-Scopes; null: no header (fine-grained token). */
    scopes?: string | null;
    /** The write fails with this GraphQL error type. */
    writeError?: string;
  } = {},
) {
  const types = structuredClone(seed);
  const writes: string[] = [];
  let seq = 0;
  const ok = (data: unknown) => ({ status: 0, stdout: JSON.stringify({ data }), stderr: "" });
  const run: GhRunner = (args, input) => {
    if (args[0] === "api" && args[1] === "--include") {
      const scopes = opts.scopes === undefined ? "repo, admin:org, project" : opts.scopes;
      return {
        status: 0,
        stdout: `HTTP/2.0 200 OK\r\n${scopes === null ? "" : `X-Oauth-Scopes: ${scopes}\r\n`}\r\n{}`,
        stderr: "",
      };
    }
    const { query, variables: v } = input
      ? JSON.parse(input)
      : {
          query: (args[3] ?? "").slice("query=".length),
          variables: Object.fromEntries(
            args
              .slice(4)
              .filter((_, i) => i % 2 === 1)
              .map((kv) => kv.split(/=(.*)/s).slice(0, 2)),
          ),
        };
    if (/createIssueType|updateIssueType/.test(query) && opts.writeError) {
      return {
        status: 1,
        stdout: JSON.stringify({ errors: [{ type: opts.writeError, message: "no access" }] }),
        stderr: "",
      };
    }
    if (query.includes("createIssueType")) {
      assert.equal(v.input.ownerId, "ORG");
      types.push({
        id: `new${++seq}`,
        name: v.input.name,
        description: v.input.description,
        color: v.input.color,
        isEnabled: v.input.isEnabled,
      });
      writes.push(`create:${v.input.name}`);
      return ok({ createIssueType: { issueType: { id: "x" } } });
    }
    if (query.includes("updateIssueType")) {
      const { issueTypeId, ...set } = v.input;
      Object.assign(types.find((t) => t.id === issueTypeId) as FakeType, set);
      writes.push(`update:${issueTypeId}:${Object.keys(set).sort().join("+")}`);
      return ok({ updateIssueType: { issueType: { id: issueTypeId } } });
    }
    if (query.includes("issueTypes(first:25)")) {
      const kind = opts.kind ?? "Organization";
      return ok({
        repositoryOwner:
          kind === "Organization"
            ? { __typename: kind, id: "ORG", issueTypes: { nodes: types } }
            : { __typename: kind, id: "USER" },
      });
    }
    // The Project reads of plan / validate: an empty Project.
    if (query.includes("viewerCanUpdate")) {
      return ok({
        repositoryOwner: {
          projectV2: {
            id: "P",
            viewerCanUpdate: true,
            fields: { nodes: [] },
            views: { nodes: [] },
            workflows: { nodes: [] },
          },
        },
      });
    }
    if (query.includes("items(first:100")) {
      return ok({
        repositoryOwner: {
          projectV2: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
        },
      });
    }
    throw new Error(`unexpected query ${query.slice(0, 80)}`);
  };
  return { run, types, writes };
}

const throws = (fn: () => unknown): OmiError => {
  try {
    fn();
  } catch (e) {
    return e as OmiError;
  }
  assert.fail("expected an error");
};

test("plan reports every missing type, read-only", () => {
  const gh = fakeOrg([]);
  const plan = issueTypePlan(v2, gh.run);
  assert.deepEqual(
    plan.actions.map((a) => a.kind),
    Array(8).fill("create-issue-type"),
  );
  assert.deepEqual(gh.writes, []);
});

test("plan: only what differs; a type GitHub has but the config does not is reported, not touched", () => {
  const gh = fakeOrg([
    ...desired.map((t) => exact(t.name)).filter((t) => t.name !== "Bug" && t.name !== "Doc"),
    { ...exact("Doc"), description: "old", color: "RED" },
    { id: "IT_X", name: "Feature", description: null, color: null, isEnabled: true },
  ]);
  const plan = issueTypePlan(v2, gh.run);
  assert.deepEqual(plan.extra, ["Feature"]);
  assert.equal(plan.actions.length, 2);
  assert.ok(plan.actions.some((a) => a.kind === "create-issue-type" && a.type.name === "Bug"));
  assert.ok(plan.actions.some((a) => a.kind === "update-issue-type" && a.name === "Doc"));
});

test("apply creates the 8 types; a second apply writes nothing", () => {
  const gh = fakeOrg([]);
  const first = issueTypeApply(v2, gh.run);
  assert.equal(first.applied.length, 8);
  assert.deepEqual(first.plan.actions, []);
  assert.equal(gh.types.length, 8);
  assert.ok(gh.types.every((t) => t.isEnabled));
  gh.writes.length = 0;
  const again = issueTypeApply(v2, gh.run);
  assert.deepEqual(again.applied, []);
  assert.deepEqual(gh.writes, []);
});

test("apply fixes description and color in place and keeps the ID; an extra type survives", () => {
  const gh = fakeOrg([
    { ...exact("Doc"), description: "old", color: "RED" },
    { id: "IT_X", name: "Feature", description: "kept", color: "BLUE", isEnabled: true },
  ]);
  issueTypeApply(v2, gh.run);
  const doc = gh.types.find((t) => t.name === "Doc");
  assert.equal(doc?.id, "IT_Doc");
  assert.equal(doc?.description, desired.find((t) => t.name === "Doc")?.description);
  assert.equal(doc?.color, "GRAY");
  assert.ok(gh.writes.includes("update:IT_Doc:color+description"));
  assert.deepEqual(
    gh.types.find((t) => t.name === "Feature"),
    { id: "IT_X", name: "Feature", description: "kept", color: "BLUE", isEnabled: true },
  );
});

test("apply never deletes or disables: no write ever sets isEnabled false", () => {
  const gh = fakeOrg([
    { id: "IT_X", name: "Feature", description: null, color: null, isEnabled: true },
    { ...exact("Bug"), isEnabled: false },
  ]);
  issueTypeApply(v2, gh.run);
  assert.equal(gh.types.find((t) => t.name === "Feature")?.isEnabled, true);
  assert.equal(
    gh.types.find((t) => t.name === "Bug")?.isEnabled,
    true,
    "a disabled type is enabled",
  );
  assert.ok(gh.writes.every((w) => w.startsWith("create:") || w.startsWith("update:")));
  assert.equal(gh.types.length, 9);
});

test("a personal account is refused with a clear error (D8), before any write", () => {
  const gh = fakeOrg([], { kind: "User" });
  const e = throws(() => issueTypeApply(v2, gh.run));
  assert.equal(e.code, "CONFIG_INVALID");
  assert.match(e.message, /personal account/);
  assert.match(e.message, /organization/);
  assert.equal(throws(() => issueTypePlan(v2, gh.run)).code, "CONFIG_INVALID");
  assert.deepEqual(gh.writes, []);
});

test("a token without admin:org is refused before any write, with the refresh command", () => {
  const gh = fakeOrg([], { scopes: "repo, project" });
  const e = throws(() => issueTypeApply(v2, gh.run));
  assert.equal(e.code, "GITHUB_AUTH");
  assert.match(e.message, /gh auth refresh -s admin:org/);
  assert.deepEqual(gh.writes, []);
});

test("an auth refusal on the write itself (token scopes unknown) gets the same guidance", () => {
  const gh = fakeOrg([], { scopes: null, writeError: "INSUFFICIENT_SCOPES" });
  const e = throws(() => issueTypeApply(v2, gh.run));
  assert.equal(e.code, "GITHUB_AUTH");
  assert.match(e.message, /gh auth refresh -s admin:org/);
});

test("apply with nothing to write does not need the scope", () => {
  const gh = fakeOrg(
    desired.map((t) => exact(t.name)),
    { scopes: "repo" },
  );
  assert.deepEqual(issueTypeApply(v2, gh.run).applied, []);
});

test("tokenScopes reads the header; none means unknown", () => {
  assert.deepEqual(tokenScopes(fakeOrg([], { scopes: "repo, admin:org" }).run), [
    "repo",
    "admin:org",
  ]);
  assert.equal(tokenScopes(fakeOrg([], { scopes: null }).run), undefined);
  assert.equal(hasAdminOrg(undefined), undefined);
  assert.equal(hasAdminOrg(["repo"]), false);
  assert.equal(hasAdminOrg(["repo", "admin:org"]), true);
});

test("project plan / validate list issue types under v2 only", () => {
  const gh = fakeOrg([exact("Doc")]);
  const plan = projectPlan(v2, gh.run);
  assert.equal(plan.issueTypes?.actions.length, 7);
  const checks = projectValidate(v2, gh.run);
  const c = checks.find((x) => x.name === "issue-types");
  assert.equal(c?.status, "fail");
  assert.match(c?.detail ?? "", /missing issue type Epic/);
  assert.deepEqual(gh.writes, [], "plan and validate are read-only");

  // legacy: no issue type read at all (the fake would answer, the plan must not ask)
  const calls: string[] = [];
  const spy: GhRunner = (args, input) => {
    calls.push(input ?? args.join(" "));
    return gh.run(args, input);
  };
  assert.equal(projectPlan(legacy, spy).issueTypes, undefined);
  assert.ok(calls.every((c) => !c.includes("issueTypes")));
});

test("doctor: v2 reports missing types and checks admin:org only while something is to write", () => {
  const missing = issueTypeChecks(v2, fakeOrg([exact("Doc")]).run);
  assert.deepEqual(
    missing.map((c) => `${c.name}:${c.status}`),
    ["issue-types:fail", "admin-org-scope:pass"],
  );
  assert.match(missing[0]?.detail ?? "", /missing issue type Epic/);

  const noScope = issueTypeChecks(v2, fakeOrg([], { scopes: "repo" }).run);
  const scope = noScope.find((c) => c.name === "admin-org-scope");
  assert.equal(scope?.status, "fail");
  assert.equal(scope?.code, "GITHUB_AUTH");
  assert.match(scope?.detail ?? "", /gh auth refresh -s admin:org/);

  const unknown = issueTypeChecks(v2, fakeOrg([], { scopes: null }).run);
  assert.equal(unknown.find((c) => c.name === "admin-org-scope")?.status, "warn");

  const done = issueTypeChecks(
    v2,
    fakeOrg(
      desired.map((t) => exact(t.name)),
      { scopes: "repo" },
    ).run,
  );
  assert.deepEqual(
    done.map((c) => `${c.name}:${c.status}`),
    ["issue-types:pass"],
  );

  const drift = issueTypeChecks(
    v2,
    fakeOrg(desired.map((t) => ({ ...exact(t.name), color: "RED" }))).run,
  );
  assert.equal(drift[0]?.status, "warn", "a difference without a missing type only warns");

  const personal = issueTypeChecks(v2, fakeOrg([], { kind: "User" }).run);
  assert.equal(personal[0]?.status, "fail");
  assert.match(personal[0]?.detail ?? "", /personal account/);
});
