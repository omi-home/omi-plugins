// T3.1 task packet + step-result acceptance: missing role, fake path, invalid status, oversized
// output; Issue context chain and carried findings against a mocked `gh` runner.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GhRunner } from "../../runtime/adapters/github/client.ts";
import {
  fetchIssueContext,
  PER_ISSUE_CHARS,
  parseCarriedFindings,
  TOTAL_CHARS,
} from "../../runtime/adapters/github/context.ts";
import { parseConfig } from "../../runtime/core/config.ts";
import type { Role } from "../../runtime/core/contracts.ts";
import {
  acceptStepResult,
  buildTaskPacket,
  MAX_RESULT_CHARS,
  type TaskPacketInput,
} from "../../runtime/core/handoff/packet.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "omi-handoff-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.invalid");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "a");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  return { dir, base: git(dir, "rev-parse", "HEAD") };
}

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code: string }).code;
  }
  return "no-throw";
};

const input = (worktree: string, baseSha: string): TaskPacketInput => ({
  workflowRunId: "32-abc",
  issue: { repository: "o/r", number: 32 },
  stepId: "implement",
  role: "backend-engineer",
  round: 1,
  attempt: 1,
  scope: ["src/"],
  worktree,
  baseSha,
  issueContext: [
    {
      issue: { repository: "o/r", number: 32 },
      type: "dev-task",
      title: "t",
      body: "b",
      truncated: false,
    },
  ],
  openFindings: [],
  carriedFindings: [],
  readOnlyArtifacts: [],
});

const result = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    workflowRunId: "32-abc",
    issue: { repository: "o/r", number: 32 },
    stepId: "implement",
    round: 1,
    attempt: 1,
    role: "backend-engineer",
    status: "PASSED",
    summary: "done",
    ...extra,
  });

test("buildTaskPacket: valid packet carries the output schema; missing role / bad worktree rejected", () => {
  const { dir, base } = repo();
  const p = buildTaskPacket(input(dir, base));
  assert.equal(p.outputSchema, "step-result@1");
  const { role: _, ...noRole } = input(dir, base);
  assert.equal(
    codeOf(() => buildTaskPacket(noRole as TaskPacketInput)),
    "CONTRACT_INVALID",
  );
  assert.equal(
    codeOf(() => buildTaskPacket({ ...input(dir, base), role: "wizard" as never })),
    "CONTRACT_INVALID",
  );
  assert.equal(
    codeOf(() => buildTaskPacket({ ...input(dir, base), worktree: "relative/path" })),
    "CONTRACT_INVALID",
  );
  assert.equal(
    codeOf(() => buildTaskPacket({ ...input(dir, base), worktree: join(dir, "missing") })),
    "CONTRACT_INVALID",
  );
  assert.equal(
    codeOf(() => buildTaskPacket({ ...input(dir, base), scope: ["../escape"] })),
    "CONTRACT_INVALID",
  );
});

test("acceptStepResult: real changes, evidence and commit accepted, also from a fenced block", () => {
  const { dir, base } = repo();
  const p = buildTaskPacket(input(dir, base));
  execFileSync("git", ["-C", dir, "checkout", "-qb", "work"]);
  writeFileSync(join(dir, "src.txt"), "x"); // outside scope, unclaimed: fine
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "new.ts"), "n");
  git(dir, "add", "src/new.ts");
  git(dir, "commit", "-qm", "work");
  const sha = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "src", "untracked.ts"), "u");
  const raw = result({
    changedFiles: ["src/new.ts", "src\\untracked.ts"],
    evidencePaths: ["a.txt"],
    commitSha: sha,
    usage: { inputTokens: 10, outputTokens: 5 },
    sectionUpdates: [{ section: "as-built", markdown: "x" }],
  });
  assert.equal(acceptStepResult(p, raw).usage?.outputTokens, 5);
  assert.equal(acceptStepResult(p, `Done.\n\`\`\`json\n${raw}\n\`\`\`\n`).status, "PASSED");
});

test("acceptStepResult: fake paths, foreign commit, out-of-scope file rejected", () => {
  const { dir, base } = repo();
  const p = buildTaskPacket(input(dir, base));
  const bad = (extra: Record<string, unknown>) => codeOf(() => acceptStepResult(p, result(extra)));
  assert.equal(bad({ changedFiles: ["src/never-touched.ts"] }), "CONTRACT_INVALID");
  assert.equal(bad({ evidencePaths: ["reports/missing.md"] }), "CONTRACT_INVALID");
  assert.equal(bad({ evidencePaths: ["../outside.md"] }), "CONTRACT_INVALID");
  assert.equal(bad({ commitSha: "deadbeefdeadbeef" }), "CONTRACT_INVALID");
  writeFileSync(join(dir, "a.txt"), "changed");
  assert.equal(bad({ changedFiles: ["a.txt"] }), "CONTRACT_INVALID"); // scope is src/
  writeFileSync(join(dir, "srcX.ts"), "x");
  const narrow = buildTaskPacket({ ...input(dir, base), scope: ["src"] });
  assert.equal(
    codeOf(() => acceptStepResult(narrow, result({ changedFiles: ["srcX.ts"] }))),
    "CONTRACT_INVALID",
  );
});

test("acceptStepResult: read-only roles change no files; owned sections only by their owner", () => {
  const { dir, base } = repo();
  writeFileSync(join(dir, "a.txt"), "changed by the engineer earlier");
  const ba = buildTaskPacket({ ...input(dir, base), role: "business-analyst", scope: [] });
  const code = (extra: Record<string, unknown>) =>
    codeOf(() => acceptStepResult(ba, result({ role: "business-analyst", ...extra })));
  const analysis = { section: "analysis", markdown: "### Goal\nx" };
  assert.equal(
    acceptStepResult(ba, result({ role: "business-analyst", sectionUpdates: [analysis] }))
      .sectionUpdates[0]?.section,
    "analysis",
  );
  const own = { sectionUpdates: [analysis] };
  assert.equal(code({ ...own, changedFiles: ["a.txt"] }), "CONTRACT_INVALID"); // really changed
  assert.equal(code({ ...own, commitSha: base }), "CONTRACT_INVALID");
  assert.equal(
    code({ sectionUpdates: [{ section: "architecture", markdown: "x" }] }),
    "CONTRACT_INVALID",
  );
  const be = buildTaskPacket({ ...input(dir, base), scope: [] });
  assert.equal(
    codeOf(() => acceptStepResult(be, result({ sectionUpdates: [analysis] }))),
    "CONTRACT_INVALID",
  );
});

test("acceptStepResult: review lenses, verdicts, security escalation, QA must produce", () => {
  const { dir, base } = repo();
  const as = (role: Role, extra: Record<string, unknown>) =>
    codeOf(() =>
      acceptStepResult(
        buildTaskPacket({ ...input(dir, base), role, scope: [] }),
        result({ role, ...extra }),
      ),
    );
  const f = (id: string, severity: string) => ({ id, severity, observed: "o", expected: "e" });
  // One owner per lens: a code reviewer cannot raise security findings.
  assert.equal(
    as("code-reviewer", { status: "FAILED", findings: [f("SEC-001", "high")] }),
    "CONTRACT_INVALID",
  );
  assert.equal(
    as("code-reviewer", { status: "FAILED", findings: [f("CR-001", "high")] }),
    "no-throw",
  );
  // PASSED means no medium+ finding left.
  assert.equal(as("code-reviewer", { findings: [f("CR-001", "medium")] }), "CONTRACT_INVALID");
  assert.equal(as("code-reviewer", { findings: [f("CR-001", "low")] }), "no-throw");
  // Critical security → BLOCKED (PO escalation), never FAILED/PASSED.
  const crit = { findings: [f("SEC-001", "critical")] };
  assert.equal(as("security-reviewer", { ...crit, status: "FAILED" }), "CONTRACT_INVALID");
  assert.equal(
    as("security-reviewer", { ...crit, status: "BLOCKED", blockerReason: "PO" }),
    "no-throw",
  );
  assert.equal(
    as("security-reviewer", { status: "FAILED", findings: [f("SEC-002", "high")] }),
    "no-throw",
  );
  // Automation QA authors tests: PASSED without a changed file is "just ran the tests".
  assert.equal(as("automation-qa-engineer", {}), "CONTRACT_INVALID");
  // Manual QA reports through its `qa` section, never by editing.
  assert.equal(as("manual-qa-engineer", {}), "CONTRACT_INVALID");
  assert.equal(
    as("manual-qa-engineer", { sectionUpdates: [{ section: "qa", markdown: "### Test cases" }] }),
    "no-throw",
  );
});

test("acceptStepResult: invalid status, wrong identity, junk and oversized output rejected", () => {
  const { dir, base } = repo();
  const p = buildTaskPacket(input(dir, base));
  const code = (raw: string) => codeOf(() => acceptStepResult(p, raw));
  assert.equal(code(result({ status: "DONE" })), "CONTRACT_INVALID");
  assert.equal(code(result({ status: "RUNNING" })), "CONTRACT_INVALID");
  assert.equal(code(result({ status: "BLOCKED" })), "CONTRACT_INVALID"); // needs blockerReason
  assert.equal(code(result({ role: "code-reviewer" })), "OWNERSHIP_MISMATCH");
  assert.equal(code(result({ round: 2 })), "OWNERSHIP_MISMATCH");
  assert.equal(code(result({ issue: { repository: "o/r", number: 1 } })), "OWNERSHIP_MISMATCH");
  assert.equal(code(result({ extra: true })), "CONTRACT_INVALID");
  assert.equal(code("I think it went well"), "CONTRACT_INVALID");
  assert.equal(code(result({ summary: "x".repeat(MAX_RESULT_CHARS) })), "CONTRACT_INVALID");
});

const config = parseConfig({ github: { owner: "o", repo: "r", projectNumber: 2 } });
const node = (number: number, body: string, type: string, parent: unknown = null) => ({
  number,
  title: `#${number}`,
  body,
  repository: { nameWithOwner: "o/r" },
  labels: { nodes: [{ name: `type:${type}` }, { name: "risk:low" }] },
  parent,
});

const CARRIED = `<!-- omi:carried-findings=T3.1 -->
## Finding

| Nguồn | Finding | Việc cần làm |
|---|---|---|
| #20 T1.5 · CR-001 | flaky \`HANDOFF:.*\` match | use structured result |
| #24 · CR-002 | free-text kind | enum in contracts.ts |
`;

test("parseCarriedFindings: rows of marked tables only, header and separator skipped", () => {
  const rows = parseCarriedFindings([CARRIED, "| a | b | c |\n|---|---|---|\n| x | y | z |"]);
  assert.deepEqual(rows, [
    {
      source: "#20 T1.5 · CR-001",
      finding: "flaky `HANDOFF:.*` match",
      action: "use structured result",
    },
    { source: "#24 · CR-002", finding: "free-text kind", action: "enum in contracts.ts" },
  ]);
});

test("fetchIssueContext: chain nearest first, bounded, redacted, carried findings read", () => {
  const big = "s".repeat(PER_ISSUE_CHARS + 500);
  const tok = `ghp_${"a".repeat(36)}`;
  // 4 full-size ancestors exceed TOTAL_CHARS: the last is cut, anything above is dropped.
  const top = node(98, big, "epic", node(99, "never reached", "epic"));
  const m = node(30, big, "milestone", node(96, big, "epic", node(97, big, "epic", top)));
  const f = node(31, `token ${tok}`, "feature", m);
  const issue = {
    ...node(32, "## Scope\nx", "dev-task", f),
    comments: { nodes: [{ body: "lgtm" }, { body: CARRIED }] },
  };
  let args: string[] = [];
  const gh: GhRunner = (a) => {
    args = a;
    return { status: 0, stderr: "", stdout: JSON.stringify({ data: { repository: { issue } } }) };
  };
  const ctx = fetchIssueContext(config, 32, gh);
  assert.ok(args.some((a) => a.includes("parent{")));
  assert.deepEqual(
    ctx.issueContext.map((e) => [e.issue.number, e.type, e.truncated]),
    [
      [32, "dev-task", false],
      [31, "feature", false],
      [30, "milestone", true],
      [96, "epic", true],
      [97, "epic", true],
      [98, "epic", true],
    ],
  );
  const total = ctx.issueContext.reduce((n, e) => n + e.body.length, 0);
  assert.ok(total <= TOTAL_CHARS);
  assert.ok(!JSON.stringify(ctx).includes(tok));
  assert.equal(ctx.carriedFindings.length, 2);

  const missing: GhRunner = () => ({
    status: 0,
    stderr: "",
    stdout: JSON.stringify({ data: { repository: { issue: null } } }),
  });
  assert.equal(
    codeOf(() => fetchIssueContext(config, 9, missing)),
    "TICKET_INVALID",
  );
});
