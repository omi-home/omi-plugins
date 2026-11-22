// DevTask-0098 #307: model v2 enums, `github.model` config and reading an Issue's type per model.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig, workflowModel } from "../../../runtime/shared/config.ts";
import {
  IssueType,
  IssueTypeV2,
  ProjectStatusV2,
  RoleV2,
} from "../../../runtime/shared/contracts.ts";
import type { GhRunner } from "../../../runtime/shared/github/client.ts";
import { fetchTicket, readIssueType } from "../../../runtime/ticket/adapters/ticket.ts";

const gh = { owner: "o", repo: "r", projectNumber: 2 };
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code: string }).code;
  }
  return "no-throw";
};

const issue = (issueType: { name: string } | null, labels: string[]) => ({
  data: {
    repository: {
      issue: {
        number: 7,
        title: "t",
        state: "OPEN",
        body: "b",
        issueType,
        labels: { totalCount: labels.length, nodes: labels.map((name) => ({ name })) },
        parent: null,
        subIssuesSummary: { total: 0, completed: 0 },
        blockedBy: { totalCount: 0, nodes: [] },
        projectItems: { totalCount: 0, nodes: [] },
      },
    },
  },
});
const runner =
  (payload: unknown): GhRunner =>
  () => ({ status: 0, stdout: JSON.stringify(payload), stderr: "" });
const ticket = (issueType: { name: string } | null, labels: string[]) =>
  fetchTicket(parseConfig({ github: gh }), 7, runner(issue(issueType, labels)));

test("v2 enums carry the exact native names", () => {
  assert.deepEqual(IssueTypeV2.options, [
    "Doc",
    "ADR",
    "Epic",
    "UserStory",
    "DesignTask",
    "DevTask",
    "QATask",
    "Bug",
  ]);
  assert.equal(ProjectStatusV2.options.length, 10);
  assert.ok(ProjectStatusV2.options.includes("Awaiting PO"));
  assert.ok(ProjectStatusV2.options.includes("In progress"));
  assert.deepEqual(RoleV2.options, [
    "software-engineer",
    "qa-engineer",
    "uiux-designer",
    "code-reviewer",
    "security-reviewer",
  ]);
  assert.ok(IssueType.options.includes("dev-task"), "legacy enum is untouched");
});

test("github.model defaults to legacy; v2 accepted; anything else rejected", () => {
  assert.equal(workflowModel(parseConfig({ github: gh })), "legacy");
  assert.equal(workflowModel(parseConfig({ github: { ...gh, model: "v2" } })), "v2");
  assert.equal(workflowModel(parseConfig({ github: { ...gh, model: "legacy" } })), "legacy");
  const bad = (github: object) => codeOf(() => parseConfig({ github }));
  assert.equal(bad({ ...gh, model: "v3" }), "CONFIG_INVALID");
  assert.equal(bad({ ...gh, modle: "v2" }), "CONFIG_INVALID");
});

test("legacy reads the type:* label", () => {
  assert.equal(readIssueType(ticket(null, ["type:dev-task"]), "legacy"), "dev-task");
  const read = (t: ReturnType<typeof ticket>, m: "legacy" | "v2") =>
    codeOf(() => readIssueType(t, m));
  assert.equal(read(ticket(null, []), "legacy"), "TICKET_INVALID");
  assert.equal(
    codeOf(() => readIssueType(ticket(null, ["type:nope"]), "legacy")),
    "TICKET_INVALID",
  );
});

test("v2 reads the native issue type", () => {
  assert.equal(readIssueType(ticket({ name: "QATask" }, ["type:bug"]), "v2"), "QATask");
  assert.equal(
    codeOf(() => readIssueType(ticket(null, ["type:bug"]), "v2")),
    "TICKET_INVALID",
  );
  assert.equal(
    codeOf(() => readIssueType(ticket({ name: "Task" }, []), "v2")),
    "CONTRACT_INVALID",
  );
});
