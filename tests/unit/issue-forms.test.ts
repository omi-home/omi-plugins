// DevTask-0047 #130: Issue Forms for the 13 OMI types, config.yml, PR template, the .github copy of
// this repo, and the required-section check `omi ticket validate` runs.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { IssueType } from "../../runtime/core/contracts.ts";
import { titleType } from "../../runtime/core/hierarchy.ts";
import {
  loadForm,
  missingSections,
  requiredSections,
  sectionsCheck,
} from "../../runtime/core/issue-forms.ts";

const root = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
const files = (dir: string): string[] =>
  readdirSync(new URL(dir, root), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) =>
      `${d.parentPath.replace(/\\/g, "/").split(dir)[1] ?? ""}/${d.name}`.replace(/^\//, ""),
    )
    .sort();

test("one valid Issue Form per OMI type, labelled type:<slug>, title prefix, unique ids", () => {
  const forms = readdirSync(new URL("templates/github/ISSUE_TEMPLATE/", root)).filter(
    (f) => f !== "config.yml",
  );
  assert.deepEqual(forms.sort(), IssueType.options.map((t) => `${t}.yml`).sort());
  for (const type of IssueType.options) {
    const f = loadForm(type); // schema-checked
    assert.deepEqual(f.labels, [`type:${type}`], type);
    assert.equal(f.title, `${titleType(type)}-NNNN-`, type);
    const ids = f.body.map((b) => b.id);
    assert.equal(new Set(ids).size, ids.length, `${type}: duplicate ids`);
    assert.equal(f.body[0]?.attributes.label, "Objective", type);
    assert.equal(f.body[0]?.validations?.required, true, type);
  }
});

test("type-specific required fields (Bug, NFR, Change Request, Spike)", () => {
  const req = (t: Parameters<typeof loadForm>[0]) => requiredSections(loadForm(t)).slice(1);
  assert.equal(requiredSections(loadForm("bug"))[0], "Objective");
  assert.deepEqual(req("bug"), ["Steps to Reproduce", "Expected", "Actual", "Severity"]);
  assert.deepEqual(req("nfr"), ["Threshold", "Verification", "Scope / Acceptance"]);
  assert.deepEqual(req("change-request"), ["Current State", "Proposal", "Impact"]);
  assert.deepEqual(req("spike"), ["Question", "Timebox", "Expected Output"]);
  assert.deepEqual(req("dev-task"), ["Scope / Acceptance"]);
  assert.deepEqual(req("epic"), []); // a prefilled Definition of Done cannot be "required"
});

test("config.yml disables blank issues; PR template closes its Issue and asks for evidence", () => {
  assert.deepEqual(parse(read("templates/github/ISSUE_TEMPLATE/config.yml")), {
    blank_issues_enabled: false,
  });
  const pr = read("templates/github/PULL_REQUEST_TEMPLATE.md");
  assert.match(pr, /^Closes #<issue>$/m);
  assert.match(pr, /- \[ \] .*check/);
});

test("this repository's .github is the templates/github copy", () => {
  const want = files("templates/github");
  assert.deepEqual(files(".github"), want);
  for (const f of want) assert.equal(read(`.github/${f}`), read(`templates/github/${f}`), f);
});

test("missing or empty required sections are reported; hand-written headings pass", () => {
  const bug = loadForm("bug");
  // What the form renders: `### <label>` per field, `_No response_` for an empty optional one.
  const rendered = [
    "### Objective\n\nfix it",
    "### Steps to Reproduce\n\n1. run",
    "### Expected\n\nok",
    "### Actual\n\ncrash",
    "### Severity\n\nhigh",
    "### Environment\n\n_No response_",
  ].join("\n\n");
  assert.deepEqual(missingSections(rendered, bug), []);
  assert.deepEqual(missingSections(rendered.replace("### Expected\n\nok", ""), bug), ["Expected"]);
  assert.deepEqual(missingSections(rendered.replace("high", "_No response_"), bug), ["Severity"]);

  const task =
    "## Objective\nx\n\n## Scope / Acceptance (from roadmap)\n- [ ] a\n## Dependencies\n";
  assert.equal(sectionsCheck(task, "dev-task").status, "pass");
  const empty = sectionsCheck(
    "## Objective\nx\n## Scope / Acceptance\n\n## Dependencies\nnone",
    "dev-task",
  );
  assert.equal(empty.status, "fail");
  assert.equal(empty.code, "TICKET_INVALID");
  assert.match(empty.detail, /Scope \/ Acceptance/);

  // Subheadings and code fences stay inside a section; "Impact" is not "Impacted files";
  // an HTML comment or TBD is a placeholder, not content.
  const cr = loadForm("change-request");
  const crBody = (impact: string) =>
    [
      "## Objective\nx",
      "## Impacted files\n",
      "## Current State\n### a\n- now",
      "## Proposal\n```sh\n# not a heading\n```",
      `## Impact\n${impact}`,
    ].join("\n");
  assert.deepEqual(missingSections(crBody("risk"), cr), []);
  assert.deepEqual(missingSections(crBody("<!-- fill in -->"), cr), ["Impact"]);
  assert.deepEqual(missingSections(crBody("TBD"), cr), ["Impact"]);
  assert.deepEqual(missingSections(crBody("risk").replace("### a\n- now", ""), cr), [
    "Current State",
  ]);
});
