// DevTask-0143 #408: `omi qa plan` against an in-memory GitHub: Test design + Verify of a Story,
// Fix + Retest of a Bug, idempotent re-run, `--dev` blockers, refusals before any write.
import assert from "node:assert/strict";
import { test } from "node:test";
import { qaPlan } from "../../../runtime/github/adapters/qa-plan.ts";
import { markerOf } from "../../../runtime/github/application/qa-plan.ts";
import type { OmiConfig } from "../../../runtime/shared/config.ts";
import type { OmiError } from "../../../runtime/shared/errors/errors.ts";
import type { GhRunner } from "../../../runtime/shared/github/client.ts";

const V2_TYPES = ["Doc", "ADR", "Epic", "UserStory", "DesignTask", "DevTask", "QATask", "Bug"];

interface Fake {
  title: string;
  type: string;
  parent?: string;
  state?: "OPEN" | "CLOSED";
  stateReason?: string;
  body?: string;
  labels?: string[];
  inProject?: boolean;
  blockedBy?: string[];
  status?: string;
  itemId?: string;
}

function fakeGh(seed: Record<string, Fake>, o: { legacy?: boolean; noLabel?: boolean } = {}) {
  const issues = new Map(Object.entries(seed));
  const writes: string[] = [];
  const labelsInRepo = new Set<string>(o.noLabel ? [] : ["qa:test-design"]);
  const num = (k: string) => Number(k.split("#")[1]);
  const repoOf = (k: string) => k.split("#")[0] as string;
  const byId = (id: string) => id.replace(/^I_/, "");
  const labels = (i: Fake) => ({
    nodes: [...(o.legacy ? [`type:${i.type}`] : []), ...(i.labels ?? [])].map((name) => ({ name })),
  });
  const issueType = (i: Fake) => (o.legacy ? null : { name: i.type });
  let seq = 0;
  const items = (i: Fake) => {
    if (!i.inProject) return { nodes: [] };
    if (!i.itemId) i.itemId = `PVTI_${++seq}`;
    return {
      nodes: [
        {
          id: i.itemId,
          project: { number: 2, owner: { login: "o" } },
          fieldValueByName: i.status ? { name: i.status } : null,
        },
      ],
    };
  };
  const up = (k: string | undefined, depth: number): unknown => {
    if (!k) return null;
    const i = issues.get(k) as Fake;
    const base = { number: num(k), repository: { nameWithOwner: repoOf(k) } };
    return depth <= 0
      ? base
      : { ...base, labels: labels(i), issueType: issueType(i), parent: up(i.parent, depth - 1) };
  };
  const node = (k: string, i: Fake) => ({
    id: `I_${k}`,
    number: num(k),
    title: i.title,
    body: i.body ?? "",
    state: i.state ?? "OPEN",
    stateReason: i.stateReason ?? (i.state === "CLOSED" ? "COMPLETED" : null),
    repository: { nameWithOwner: repoOf(k) },
    issueType: issueType(i),
    labels: labels(i),
  });
  const ok = (data: unknown) => ({ status: 0, stdout: JSON.stringify({ data }), stderr: "" });

  const run: GhRunner = (args, input) => {
    if (args.includes("POST")) {
      const name = (args.find((a) => a.startsWith("name=")) as string).slice(5);
      labelsInRepo.add(name);
      writes.push(`new-label:${name}`);
      return { status: 0, stdout: JSON.stringify({ node_id: `LBL_${name}` }), stderr: "" };
    }
    let query: string;
    let vars: Record<string, string>;
    if (input) ({ query, variables: vars } = JSON.parse(input));
    else {
      query = (args[3] ?? "").slice("query=".length);
      vars = Object.fromEntries(
        args
          .slice(4)
          .filter((_, n) => n % 2 === 1)
          .map((kv) => kv.split(/=(.*)/s).slice(0, 2)),
      );
    }
    const at = () => `${vars.owner}/${vars.repo}#${Number(vars.number)}`;
    if (query.includes("subIssues(")) {
      const k = at();
      const self = issues.get(k);
      if (!self) return ok({ repository: { issue: null } });
      const kids = [...issues.entries()].filter(([, i]) => i.parent === k);
      return ok({
        repository: {
          issue: {
            ...node(k, self),
            subIssues: { totalCount: kids.length, nodes: kids.map(([ck, ci]) => node(ck, ci)) },
          },
        },
      });
    }
    if (query.includes("$name:String!")) {
      const name = vars.name as string;
      return ok({
        repository: { label: labelsInRepo.has(name) ? { id: `LBL_${name}` } : null },
      });
    }
    if (query.includes("issue(number:$number){ id }")) {
      const k = at();
      return ok({ repository: { issue: issues.has(k) ? { id: `I_${k}` } : null } });
    }
    if (query.includes("addLabelsToLabelable")) {
      const i = issues.get(byId(vars.id as string)) as Fake;
      const name = (vars.l as string).replace("LBL_", "");
      i.labels = [...(i.labels ?? []), name];
      writes.push(`label:${byId(vars.id as string)}:${name}`);
      return ok({});
    }
    if (query.includes("blockedBy(first")) {
      const k = at();
      const i = issues.get(k);
      if (!i) return ok({ repository: { issue: null } });
      const by = i.blockedBy ?? [];
      return ok({
        repository: {
          issue: {
            id: `I_${k}`,
            number: num(k),
            state: i.state ?? "OPEN",
            stateReason: null,
            repository: { nameWithOwner: repoOf(k) },
            blockedBy: {
              totalCount: by.length,
              nodes: by.map((b) => ({ number: num(b), repository: { nameWithOwner: repoOf(b) } })),
            },
          },
        },
      });
    }
    if (query.includes("addBlockedBy")) {
      const i = issues.get(byId(vars.i as string)) as Fake;
      i.blockedBy = [...(i.blockedBy ?? []), byId(vars.b as string)];
      writes.push(`blocked:${byId(vars.i as string)}<-${byId(vars.b as string)}`);
      return ok({});
    }
    if (query.includes("createIssue")) {
      const n =
        Math.max(0, ...[...issues.keys()].filter((k) => repoOf(k) === "o/repo").map(num)) + 1;
      const type = o.legacy
        ? (vars.label as string).replace("LABEL_", "")
        : (vars.type as string).replace("IT_", "");
      issues.set(`o/repo#${n}`, { title: vars.title as string, type, body: vars.body });
      writes.push(`create:${type}`);
      return ok({ createIssue: { issue: { id: `I_o/repo#${n}`, number: n } } });
    }
    if (query.includes("updateIssue")) {
      (issues.get(byId(vars.id as string)) as Fake).title = vars.title as string;
      writes.push(`title:${vars.title}`);
      return ok({});
    }
    if (query.includes("addSubIssue")) {
      (issues.get(byId(vars.c as string)) as Fake).parent = byId(vars.p as string);
      writes.push(`parent:${byId(vars.c as string)}->${byId(vars.p as string)}`);
      return ok({});
    }
    if (query.includes("addProjectV2ItemById")) {
      const i = issues.get(byId(vars.c as string)) as Fake;
      i.inProject = true;
      return ok({ addProjectV2ItemById: { item: { id: items(i).nodes[0]?.id } } });
    }
    if (query.includes('field(name:"Status")')) {
      const options = (o.legacy ? ["Backlog", "Ready"] : ["Draft", "Ready"]).map((name) => ({
        id: `OPT_${name}`,
        name,
      }));
      return ok({ repositoryOwner: { projectV2: { id: "P", field: { id: "F", options } } } });
    }
    if (query.includes("updateProjectV2ItemFieldValue")) {
      const i = [...issues.values()].find((x) => x.itemId === vars.i) as Fake;
      i.status = (vars.o as string).replace("OPT_", "");
      return ok({});
    }
    if (query.includes("issueTypes")) {
      return ok({
        repository: {
          id: "R",
          url: "https://github.com/o/repo",
          issueTypes: {
            nodes: o.legacy
              ? [{ id: "IT_TASK", name: "Task" }]
              : V2_TYPES.map((name) => ({ id: `IT_${name}`, name })),
          },
          label: { id: `LABEL_${String(vars.label).replace(/^type:/, "")}` },
        },
        repositoryOwner: { projectV2: { id: "P" } },
      });
    }
    if (query.includes("issues(first:100")) {
      const all = [...issues.entries()].filter(([k]) => repoOf(k) === "o/repo");
      return ok({
        repository: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: all.map(([k, i]) => ({
              id: `I_${k}`,
              number: num(k),
              title: i.title,
              state: i.state ?? "OPEN",
              issueType: issueType(i),
              labels: labels(i),
              parent: i.parent
                ? { number: num(i.parent), repository: { nameWithOwner: repoOf(i.parent) } }
                : null,
              projectItems: items(i),
            })),
          },
        },
      });
    }
    if (query.includes("issue(number") && query.includes("state")) {
      const k = at();
      const i = issues.get(k);
      if (!i) return ok({ repository: { issue: null } });
      return ok({
        repository: {
          issue: {
            id: `I_${k}`,
            state: i.state ?? "OPEN",
            number: num(k),
            repository: { nameWithOwner: repoOf(k) },
            labels: labels(i),
            issueType: issueType(i),
            projectItems: items(i),
            parent: up(i.parent, 6),
          },
        },
      });
    }
    throw new Error(`unexpected query ${query.slice(0, 80)}`);
  };
  return { run, issues, writes };
}

const v2 = { github: { owner: "o", repo: "repo", projectNumber: 2, model: "v2" } } as OmiConfig;
const legacy = { github: { owner: "o", repo: "repo", projectNumber: 2 } } as OmiConfig;
const qaCfg = (c: OmiConfig) => ({ ...c, qa: { designLabel: "qa:test-design" } }) as OmiConfig;

const STORY_BODY = `## User story
As a x

## Story Type
FR

## Acceptance Criteria
- AC1: Given a, when b, then c
- AC2: Given d, when e, then f
`;
const BUG_BODY = `## Steps to reproduce
1. open the page
2. click save

## Expected / Actual
Saved / HTTP 500

## Severity
high

## Environment / commit
develop @ abc12345
`;
const story = (extra: Record<string, Fake> = {}): Record<string, Fake> => ({
  "o/repo#1": { title: "Epic-0001-Gốc", type: "Epic", inProject: true },
  "o/repo#2": {
    title: "UserStory-0001-Lưu",
    type: "UserStory",
    parent: "o/repo#1",
    inProject: true,
    body: STORY_BODY,
  },
  "o/repo#3": { title: "DevTask-0001-A", type: "DevTask", parent: "o/repo#2", inProject: true },
  "o/repo#4": {
    title: "DevTask-0002-Bỏ",
    type: "DevTask",
    parent: "o/repo#2",
    inProject: true,
    state: "CLOSED",
    stateReason: "NOT_PLANNED",
  },
  ...extra,
});
const bug = (): Record<string, Fake> => ({
  "o/repo#1": { title: "Epic-0001-Gốc", type: "Epic", inProject: true },
  "o/repo#2": {
    title: "Bug-0001-Lỗi lưu",
    type: "Bug",
    parent: "o/repo#1",
    inProject: true,
    body: BUG_BODY,
  },
});

test("TC-408-01: Story → Test design (labelled) + Verify blocked by its open DevTasks", () => {
  const gh = fakeGh(story());
  const r = qaPlan(qaCfg(v2), 2, {}, gh.run);
  assert.deepEqual(r.target, { number: 2, kind: "story", storyType: "FR" });
  assert.deepEqual(
    r.issues.map((i) => [i.kind, i.created]),
    [
      ["test-design", true],
      ["verify", true],
    ],
  );
  const [td, vf] = r.issues.map((i) => gh.issues.get(`o/repo#${i.number}`) as Fake);
  assert.equal(td?.type, "QATask");
  assert.equal(td?.parent, "o/repo#2");
  assert.deepEqual(td?.labels, ["qa:test-design"]);
  assert.equal(vf?.labels, undefined); // Verify is not a Test design
  assert.deepEqual(markerOf(td?.body ?? ""), { target: 2, kind: "test-design" });
  assert.deepEqual(markerOf(vf?.body ?? ""), { target: 2, kind: "verify" });
  for (const body of [td?.body ?? "", vf?.body ?? ""]) {
    assert.match(body, /## AC coverage\n- AC1: Given a, when b, then c\n- AC2/);
    assert.match(
      body,
      /## Test cases\n\| ID \| AC \| Steps \| Expected \| Auto \(Y\/N\) \| Regression \(Y\/N\) \|\n\|---\|/,
    );
    assert.match(body, /## Regression scope\nSuite tự động của repo .*khu vực manual/);
    assert.match(body, /## Environment\n\S/);
  }
  // Only the open DevTask #3 blocks Verify; #4 was closed not planned.
  assert.deepEqual(
    r.dependencies.map((d) => [d.issue, d.blockedBy, d.added]),
    [[`o/repo#${r.issues[1]?.number}`, "o/repo#3", true]],
  );
});

test("TC-408-02: a re-run writes nothing; --dev adds only the missing blocker", () => {
  const gh = fakeGh(
    story({
      "o/repo#9": {
        title: "DevTask-0005-Sau",
        type: "DevTask",
        parent: "o/repo#1",
        inProject: true,
      },
    }),
  );
  qaPlan(qaCfg(v2), 2, {}, gh.run);
  const writes = gh.writes.length;
  const again = qaPlan(qaCfg(v2), 2, {}, gh.run);
  assert.equal(gh.writes.length, writes);
  assert.deepEqual(
    again.issues.map((i) => [i.created, i.changes]),
    [
      [false, []],
      [false, []],
    ],
  );
  assert.ok(again.dependencies.every((d) => !d.added));
  assert.equal([...gh.issues.values()].filter((i) => i.type === "QATask").length, 2);

  const more = qaPlan(qaCfg(v2), 2, { dev: [{ owner: "o", repo: "repo", number: 9 }] }, gh.run);
  assert.deepEqual(
    more.dependencies.map((d) => [d.blockedBy, d.added]),
    [
      ["o/repo#3", false],
      ["o/repo#9", true],
    ],
  );
  assert.equal(gh.writes.length, writes + 1);
});

test("TC-408-03: a crash after create is completed (label, dependency), never duplicated", () => {
  const gh = fakeGh(
    story({
      "o/repo#5": {
        title: "QATask-0001-Test design #2",
        type: "QATask",
        parent: "o/repo#2",
        inProject: true,
        body: "<!-- omi:qa-plan=2;kind=test-design -->\n## Objective\nx",
      },
    }),
    { noLabel: true },
  );
  const r = qaPlan(qaCfg(v2), 2, {}, gh.run);
  assert.deepEqual(r.issues[0]?.changes, ["label"]); // existing task: only the label is added
  assert.ok(gh.writes.includes("new-label:qa:test-design")); // the repository lacked it
  assert.equal([...gh.issues.values()].filter((i) => i.type === "QATask").length, 2);
});

test("TC-408-04: Bug → DevTask Fix (reproduction copied, regression box) + Retest blocked by it", () => {
  const gh = fakeGh(bug());
  const r = qaPlan(qaCfg(v2), 2, {}, gh.run);
  assert.deepEqual(r.target, { number: 2, kind: "bug" });
  const [fix, retest] = r.issues.map((i) => gh.issues.get(`o/repo#${i.number}`) as Fake);
  assert.equal(fix?.type, "DevTask");
  assert.equal(retest?.type, "QATask");
  assert.equal(fix?.parent, "o/repo#2");
  assert.match(fix?.body ?? "", /## Steps to reproduce\n1\. open the page\n2\. click save/);
  assert.match(fix?.body ?? "", /## Expected\nSaved \/ HTTP 500/);
  assert.match(fix?.body ?? "", /## Actual\nSaved \/ HTTP 500/);
  assert.match(fix?.body ?? "", /- \[ \] regression test `TC-2-<n>` fail trước fix, pass sau fix/);
  assert.deepEqual(markerOf(retest?.body ?? ""), { target: 2, kind: "retest" });
  assert.deepEqual(
    r.dependencies.map((d) => [d.issue, d.blockedBy]),
    [[`o/repo#${r.issues[1]?.number}`, `o/repo#${r.issues[0]?.number}`]],
  );
  const writes = gh.writes.length;
  qaPlan(qaCfg(v2), 2, {}, gh.run);
  assert.equal(gh.writes.length, writes);
});

test("TC-408-05: legacy model: FR → test-task Test design + Verify under it", () => {
  const gh = fakeGh(
    {
      "o/repo#1": { title: "Feature-0001-F", type: "feature", inProject: true },
      "o/repo#2": {
        title: "FunctionalRequirement-0001-Lưu",
        type: "fr",
        parent: "o/repo#1",
        inProject: true,
        body: "## Objective\nx\n\n## Scope / Acceptance\n- [ ] AC1 lưu được\n",
      },
      "o/repo#3": {
        title: "DevTask-0001-A",
        type: "dev-task",
        parent: "o/repo#2",
        inProject: true,
      },
    },
    { legacy: true },
  );
  const r = qaPlan(qaCfg(legacy), 2, {}, gh.run);
  assert.equal(r.target.storyType, "FR");
  assert.deepEqual(
    r.issues.map((i) => (gh.issues.get(`o/repo#${i.number}`) as Fake).type),
    ["test-task", "test-task"],
  );
  assert.match(
    (gh.issues.get(`o/repo#${r.issues[0]?.number}`) as Fake).body ?? "",
    /- \[ \] AC1 lưu được/,
  );
  assert.deepEqual(
    r.dependencies.map((d) => d.blockedBy),
    ["o/repo#3"],
  );
});

test("TC-408-06: wrong target, missing AC or reproduction are refused before any write", () => {
  const gh = fakeGh(story());
  assert.throws(
    () => qaPlan(qaCfg(v2), 3, {}, gh.run),
    (e: OmiError) => e.code === "USAGE_INVALID" && /Story \(FR, NFR, CR\) or a Bug/.test(e.message),
  );
  assert.throws(
    () => qaPlan(qaCfg(v2), 42, {}, gh.run),
    (e: OmiError) => e.code === "TICKET_INVALID" && /not found/.test(e.message),
  );
  const noAc = fakeGh(
    story({
      "o/repo#2": {
        title: "UserStory-0001-Lưu",
        type: "UserStory",
        parent: "o/repo#1",
        inProject: true,
        body: "## User story\nx\n\n## Story Type\nFR\n",
      },
    }),
  );
  assert.throws(
    () => qaPlan(qaCfg(v2), 2, {}, noAc.run),
    (e: OmiError) => e.code === "TICKET_INVALID" && /Acceptance Criteria/.test(e.message),
  );
  const noSteps = fakeGh({
    ...bug(),
    "o/repo#2": {
      title: "Bug-0001-L",
      type: "Bug",
      parent: "o/repo#1",
      inProject: true,
      body: "## Severity\nhigh",
    },
  });
  assert.throws(
    () => qaPlan(qaCfg(v2), 2, {}, noSteps.run),
    (e: OmiError) => e.code === "TICKET_INVALID" && /Steps to reproduce/.test(e.message),
  );
  assert.deepEqual([...gh.writes, ...noAc.writes, ...noSteps.writes], []);
});
