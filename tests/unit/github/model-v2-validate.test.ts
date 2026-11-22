// DevTask-0100 #309: model v2 tree, title, sections and the model choice of `omi ticket validate`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ticketValidate } from "../../../runtime/cli/task.ts";
import {
  hierarchyChecks,
  type Link,
  loadHierarchyV2,
  titleCheckV2,
} from "../../../runtime/github/application/hierarchy.ts";
import {
  DOC_FORMS,
  loadFormsV2,
  requiredSections,
  sectionsCheckV2,
} from "../../../runtime/github/application/issue-forms.ts";
import { IssueTypeV2 } from "../../../runtime/shared/contracts.ts";
import type { GhRunner } from "../../../runtime/shared/github/client.ts";
import type { Ticket } from "../../../runtime/ticket/adapters/ticket.ts";

type T = IssueTypeV2;
const h = loadHierarchyV2();
const chain = (...types: T[]): Link<T>[] => types.map((type, i) => ({ number: i + 1, type }));
const verdict = (...types: T[]) => {
  const [self, ...up] = chain(...types);
  const [c] = hierarchyChecks(self as Link<T>, up, h);
  return `${c?.status}${c?.status === "fail" ? `: ${c.detail}` : ""}`;
};

test("v2 tree: Epic, Doc, ADR have no parent; everything else needs one", () => {
  for (const root of ["Epic", "Doc", "ADR"] as const) assert.equal(verdict(root), "pass", root);
  for (const t of ["UserStory", "DesignTask", "DevTask", "QATask", "Bug"] as const) {
    assert.match(verdict(t), /fail: .*needs a parent/, t);
  }
  assert.match(verdict("Epic", "Epic"), /cannot be a child/);
  assert.match(verdict("Doc", "Epic"), /cannot be a child/);
  assert.match(verdict("ADR", "UserStory"), /cannot be a child/);
});

test("v2 tree: allowed parent → child pairs and nothing else", () => {
  const allowed: Record<string, T[]> = {
    Epic: ["UserStory", "Bug"],
    UserStory: ["DesignTask", "DevTask", "QATask", "Bug"],
    Bug: ["DevTask", "QATask"],
  };
  for (const parent of IssueTypeV2.options) {
    for (const child of IssueTypeV2.options) {
      const ok = allowed[parent]?.includes(child) ?? false;
      const v = verdict(child, parent);
      assert.equal(v === "pass" || v.startsWith("pass"), ok, `${child} under ${parent}: ${v}`);
    }
  }
});

test("v2 tree: leaves take no children; Bug takes only DevTask and QATask; depth 4", () => {
  for (const leaf of ["DesignTask", "DevTask", "QATask"] as const) {
    assert.match(verdict("DevTask", leaf, "UserStory", "Epic"), /cannot be a child/, leaf);
  }
  assert.match(verdict("DesignTask", "Bug", "Epic"), /cannot be a child/);
  assert.equal(verdict("DevTask", "Bug", "UserStory", "Epic"), "pass");
  assert.match(
    verdict("DevTask", "Bug", "Bug", "UserStory", "Epic"),
    /cannot be a child|exceeds 4/,
  );
  // a story-less Bug under an Epic (found after Done) is valid
  assert.equal(verdict("QATask", "Bug", "Epic"), "pass");
  // five levels is over the depth even when every pair is allowed
  const deep = hierarchyChecks({ number: 9, type: "DevTask" }, chain("Bug", "UserStory", "Epic"), {
    ...h,
    maxDepth: 3,
  });
  assert.match(deep[0]?.detail ?? "", /depth 4 exceeds 3/);
});

test("v2 title: native type name, per-type number", () => {
  assert.equal(titleCheckV2("UserStory-0001-Login", "UserStory").status, "pass");
  assert.equal(titleCheckV2("QATask-0001-Login", "QATask").detail, "QATask-0001");
  assert.equal(titleCheckV2("DevTask-0100-x", "QATask").status, "fail");
  assert.equal(titleCheckV2("User Story-0001-x", "UserStory").status, "fail");
  assert.equal(titleCheckV2("UserStory-1-x", "UserStory").status, "fail");
  assert.equal(titleCheckV2("dev-task-0001-x", "DevTask").status, "fail");
});

const sec = (label: string, text = "content") => `## ${label}\n${text}`;
const body = (...labels: string[]) => labels.map((l) => sec(l)).join("\n\n");

test("v2 forms: one per type, five Doc variants, native type, unique ids", () => {
  for (const type of IssueTypeV2.options) {
    const forms = loadFormsV2(type);
    assert.equal(forms.length, type === "Doc" ? DOC_FORMS.length : 1, type);
    for (const f of forms) {
      assert.equal(f.type, type);
      assert.equal(f.title, `${type}-NNNN-`);
      const ids = f.body.map((b) => b.id);
      assert.equal(new Set(ids).size, ids.length, `${type}: duplicate ids`);
    }
  }
});

test("v2 sections: every required section of every form is enforced", () => {
  for (const type of IssueTypeV2.options) {
    for (const form of loadFormsV2(type)) {
      const labels = requiredSections(form);
      assert.ok(labels.length > 0, form.name);
      const kind = form.body.find((b) => b.id === "doc-kind")?.attributes.value;
      const extra =
        type === "UserStory" ? sec("Story Type", "FR") : kind ? sec("Doc kind", String(kind)) : "";
      const full = `${body(...labels.filter((l) => l !== "Story Type" && l !== "Doc kind"))}\n\n${extra}`;
      assert.equal(sectionsCheckV2(full, type).status, "pass", form.name);
      for (const l of labels.filter((x) => x !== "Doc kind" && x !== "Story Type")) {
        const without = full.replace(`## ${l}\ncontent`, "");
        const c = sectionsCheckV2(without, type);
        assert.equal(c.status, "fail", `${form.name} without ${l}`);
        assert.equal(c.code, "TICKET_INVALID");
        assert.match(c.detail, new RegExp(l.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
      }
    }
  }
});

test("v2 sections: required sections per type follow ChangeRequest-0013 §11", () => {
  const req = (t: T) => requiredSections(loadFormsV2(t)[0] as ReturnType<typeof loadFormsV2>[0]);
  assert.deepEqual(req("DevTask"), [
    "Objective",
    "Technical approach",
    "Affected areas",
    "Verification",
  ]);
  assert.deepEqual(req("QATask"), ["AC coverage", "Test cases", "Regression scope", "Environment"]);
  assert.ok(req("Bug").includes("Steps to reproduce") && req("Bug").includes("Severity"));
  assert.ok(req("ADR").includes("Decision") && req("ADR").includes("Consequences"));
  assert.ok(req("UserStory").includes("Acceptance Criteria"));
});

test("v2 sections: Doc variant comes from the Doc kind section", () => {
  const arch = `${sec("Doc kind", "Architecture")}\n${body("Context", "Components", "Data model", "Integrations", "Deployment / Environments")}`;
  assert.equal(sectionsCheckV2(arch, "Doc").status, "pass");
  assert.match(sectionsCheckV2(arch, "Doc").detail, /Doc Architecture/);
  // the same body as a Design System lacks its sections
  const asDs = arch.replace("Architecture", "Design System");
  const c = sectionsCheckV2(asDs, "Doc");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /Principles/);
  const none = sectionsCheckV2(body("Context"), "Doc");
  assert.equal(none.status, "fail");
  assert.match(none.detail, /Doc kind/);
  assert.equal(sectionsCheckV2(sec("Doc kind", "Wiki"), "Doc").status, "fail");
});

test("v2 sections: UserStory Story Type and CR needs Changes: #", () => {
  const base = body("User story", "Acceptance Criteria");
  const story = (st: string, extra = "") => `${base}\n\n${sec("Story Type", st)}\n${extra}`;
  assert.equal(sectionsCheckV2(story("FR"), "UserStory").status, "pass");
  assert.equal(sectionsCheckV2(story("NFR"), "UserStory").status, "pass");
  assert.match(sectionsCheckV2(story("XX"), "UserStory").detail, /Story Type must be/);
  const cr = sectionsCheckV2(story("CR"), "UserStory");
  assert.equal(cr.status, "fail");
  assert.match(cr.detail, /Changes: #/);
  assert.equal(sectionsCheckV2(story("CR", sec("Changes", "#12")), "UserStory").status, "pass");
  assert.equal(sectionsCheckV2(story("CR", "Changes: #12"), "UserStory").status, "pass");
  assert.equal(sectionsCheckV2(story("CR", sec("Changes", "later")), "UserStory").status, "fail");
});

// --- model choice of `omi ticket validate` ---------------------------------------------------

function workspace(model: "legacy" | "v2") {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "omi-v2-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  mkdirSync(join(root, ".omi-plugins"));
  writeFileSync(
    join(root, ".omi-plugins", "omi.config.yaml"),
    `github:\n  owner: o\n  repo: repo\n  projectNumber: 2\n  model: ${model}\n`,
  );
  return root;
}

const DEV_BODY = body("Objective", "Technical approach", "Affected areas", "Verification");
const ticketOf = (n: number, o: Partial<Ticket>): Ticket => ({
  number: n,
  title: `DevTask-0001-x`,
  state: "OPEN",
  body: "## Objective\nx\n\n## Scope / Acceptance\n- [ ] done",
  issueType: null,
  labels: { totalCount: 0, nodes: [] },
  parent: null,
  subIssuesSummary: { total: 0, completed: 0 },
  blockedBy: { totalCount: 0, nodes: [] },
  projectItems: {
    totalCount: 1,
    nodes: [
      {
        id: "I",
        isArchived: false,
        project: { number: 2, owner: { login: "o" } },
        fieldValueByName: { name: "Ready" },
      },
    ],
  },
  ...o,
});
const link = (n: number) => ({
  number: n,
  state: "OPEN" as const,
  repository: { nameWithOwner: "o/repo" },
});

function fakeGh(tickets: Record<number, Ticket>): GhRunner {
  return (args) => {
    const n = Number(args.find((a) => /^number=/.test(a))?.slice("number=".length));
    const issue = tickets[n] ?? null;
    return { status: 0, stdout: JSON.stringify({ data: { repository: { issue } } }), stderr: "" };
  };
}
const status = (cs: { name: string; status: string }[], name: string) =>
  cs.find((c) => c.name === name)?.status;

test("ticket validate at v2 reads the native type and checks tree, title and sections", () => {
  const root = workspace("v2");
  const gh = fakeGh({
    1: ticketOf(1, { title: "Epic-0001-x", issueType: { name: "Epic" } }),
    2: ticketOf(2, {
      title: "UserStory-0001-x",
      issueType: { name: "UserStory" },
      parent: link(1),
      body: `${body("User story", "Acceptance Criteria")}\n\n${sec("Story Type", "FR")}`,
      subIssuesSummary: { total: 1, completed: 0 },
    }),
    3: ticketOf(3, {
      title: "DevTask-0001-x",
      issueType: { name: "DevTask" },
      parent: link(2),
      body: DEV_BODY,
    }),
    4: ticketOf(4, { title: "DevTask-0002-x", issueType: { name: "DevTask" }, body: DEV_BODY }),
    5: ticketOf(5, {
      title: "DevTask-0003-x",
      issueType: { name: "QATask" },
      body: DEV_BODY,
      parent: link(2),
    }),
    6: ticketOf(6, {
      issueType: null,
      labels: { totalCount: 1, nodes: [{ name: "type:dev-task" }] },
    }),
    7: ticketOf(7, { title: "DevTask-0004-x", issueType: { name: "Task" } }),
    8: ticketOf(8, {
      title: "DevTask-0005-x",
      issueType: { name: "DevTask" },
      parent: link(3),
      body: DEV_BODY,
    }),
  });
  const v = (n: number) => ticketValidate({ cwd: root, gh }, n);

  const ok = v(3);
  assert.deepEqual(
    ok.filter((c) => c.status === "fail"),
    [],
  );
  assert.equal(status(ok, "type"), "pass");
  assert.equal(status(ok, "hierarchy"), "pass");
  assert.equal(status(ok, "sections"), "pass");
  assert.equal(status(ok, "title"), "pass");
  // a container with sub-issues is fine; Epic needs no parent but its sections
  assert.equal(status(v(2), "terminal"), "pass");
  assert.equal(status(v(2), "sections"), "pass");
  assert.equal(status(v(1), "hierarchy"), "pass");
  assert.equal(status(v(1), "sections"), "fail");
  // no parent
  assert.equal(status(v(4), "hierarchy"), "fail");
  // title prefix of another type
  assert.equal(status(v(5), "title"), "fail");
  // the legacy label is not read at v2; an unknown native type is a contract error
  const noNative = v(6);
  assert.equal(noNative.find((c) => c.name === "type")?.status, "fail");
  assert.equal(noNative.find((c) => c.name === "type")?.code, "TICKET_INVALID");
  assert.equal(v(7).find((c) => c.name === "type")?.code, "CONTRACT_INVALID");
  // a leaf with a child fails terminal and the child fails the tree
  assert.equal(status(v(8), "hierarchy"), "fail");
  // a parent in another repository still counts as a parent (CR-001)
  const foreign = fakeGh({
    9: ticketOf(9, {
      title: "DevTask-0006-x",
      issueType: { name: "DevTask" },
      body: DEV_BODY,
      parent: { number: 50, state: "OPEN", repository: { nameWithOwner: "o/other" } },
    }),
  });
  assert.equal(status(ticketValidate({ cwd: root, gh: foreign }, 9), "hierarchy"), "pass");
  const leafWithChild = fakeGh({
    3: ticketOf(3, {
      title: "DevTask-0001-x",
      issueType: { name: "DevTask" },
      body: DEV_BODY,
      subIssuesSummary: { total: 1, completed: 0 },
    }),
  });
  assert.equal(status(ticketValidate({ cwd: root, gh: leafWithChild }, 3), "terminal"), "fail");
});

test("ticket validate at legacy keeps the legacy rules and ignores the native type", () => {
  const root = workspace("legacy");
  const gh = fakeGh({
    1: ticketOf(1, {
      title: "DevTask-0001-x",
      issueType: { name: "Task" },
      labels: { totalCount: 1, nodes: [{ name: "type:dev-task" }] },
    }),
    2: ticketOf(2, { title: "DevTask-0002-x", issueType: { name: "DevTask" } }),
  });
  const ok = ticketValidate({ cwd: root, gh }, 1);
  assert.equal(status(ok, "type"), "pass");
  assert.equal(status(ok, "sections"), "pass");
  assert.equal(status(ok, "executable"), "pass");
  const noLabel = ticketValidate({ cwd: root, gh }, 2);
  assert.equal(noLabel.find((c) => c.name === "type")?.status, "fail");
  assert.equal(noLabel.find((c) => c.name === "type")?.detail, "missing type:<OMI type> label");
});
