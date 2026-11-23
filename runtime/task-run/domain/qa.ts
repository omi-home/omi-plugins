// QATask contracts (DevTask-0134 #385, ChangeRequest-0013 §3.2/§11): the Test design table and the
// Verify `Run #k` report. Pure: no I/O. Unknown fields are refused (strict).
import { z } from "zod";
import { parseContract } from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";

/** `TC-<story>-<n>`, e.g. `TC-42-03`. */
export const tcId = (story: number) => new RegExp(`^TC-${story}-\\d{2,}$`);

const text = (max: number) => z.string().min(1).max(max);

export const TestCase = z.strictObject({
  id: z.string().regex(/^TC-\d+-\d{2,}$/),
  ac: text(500),
  steps: text(2000),
  expected: text(1000),
  auto: z.boolean(),
  regression: z.boolean(),
});
export type TestCase = z.infer<typeof TestCase>;

export const TestDesignResult = z.strictObject({
  acCoverage: text(2000),
  cases: z.array(TestCase).min(1).max(200),
});
export type TestDesignResult = z.infer<typeof TestDesignResult>;

/** The Test design result of a QATask whose parent is Issue `story`: ids carry that number, once. */
export function parseTestDesign(input: unknown, story: number): TestDesignResult {
  const r = parseContract(TestDesignResult, input, "test design");
  const seen = new Set<string>();
  for (const c of r.cases) {
    if (!tcId(story).test(c.id)) {
      throw new OmiError("CONTRACT_INVALID", `test design: ${c.id} is not TC-${story}-<n>`, {
        issues: [{ path: "cases.id", message: `expected TC-${story}-<n>` }],
      });
    }
    if (seen.has(c.id)) {
      throw new OmiError("CONTRACT_INVALID", `test design: duplicate ${c.id}`, {
        issues: [{ path: "cases.id", message: "duplicate id" }],
      });
    }
    seen.add(c.id);
  }
  return r;
}

const cell = (s: string) => s.replaceAll("|", "\\|").replace(/\s*\r?\n\s*/g, " ");
const yn = (b: boolean) => (b ? "Y" : "N");

/** §11 body of a Test design QATask: `AC coverage` and the table `ID | AC | Steps | Expected | Auto | Regression`. */
export function renderTestDesign(r: TestDesignResult): string {
  return [`**AC coverage:** ${cell(r.acCoverage)}`, "", renderTestTable(r.cases), ""].join("\n");
}

/** The §11 table: header and one row per case. */
export function renderTestTable(cases: TestCase[]): string {
  const rows = cases.map(
    (c) =>
      `| ${c.id} | ${cell(c.ac)} | ${cell(c.steps)} | ${cell(c.expected)} | ${yn(c.auto)} | ${yn(c.regression)} |`,
  );
  return [
    "| ID | AC | Steps | Expected | Auto (Y/N) | Regression (Y/N) |",
    "|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

export const CaseVerdict = z.enum(["pass", "fail", "blocked"]);

export const VerifyResult = z.strictObject({
  cases: z
    .array(
      z.strictObject({
        id: z.string().regex(/^TC-\d+-\d{2,}$/),
        result: CaseVerdict,
        note: text(500).optional(),
      }),
    )
    .max(200),
  defects: z
    .array(
      z.strictObject({
        title: text(200),
        repro: text(2000),
        expected: text(1000),
        actual: text(1000),
        severity: z.enum(["critical", "high", "medium", "low"]),
        tc: z.array(z.string().regex(/^TC-\d+-\d{2,}$/)).max(50),
      }),
    )
    .max(50),
  /** Manual `Regression = Y` cases the Coordinator adds to the Doc "Regression Suite". */
  manualRegression: z.array(text(500)).max(50),
});
export type VerifyResult = z.infer<typeof VerifyResult>;

export const parseVerify = (input: unknown): VerifyResult =>
  parseContract(VerifyResult, input, "verify result");

/** A Verify passes only when no case failed or is blocked, no defect is reported, and the checks passed. */
export const verifyPassed = (r: VerifyResult, checksPassed: boolean): boolean =>
  checksPassed && !r.defects.length && r.cases.every((c) => c.result === "pass");

/**
 * Case ids with an automatic test in the check output: a `Auto = Y` case with no test naming
 * its id is `blocked` (a missing test is a gap, never a silent pass).
 */
export const missingAuto = (table: TestCase[], output: string): string[] =>
  table.filter((c) => c.auto && !output.includes(c.id)).map((c) => c.id);

/**
 * Gate TCG-001 (DevTask-0143 #408): ids of the `Auto = Y` cases of a Test design table that no test
 * source names. An id counts as named only as a whole (`TC-7-01` is not in `TC-7-010`).
 */
export function missingAutoTests(table: TestCase[], testSources: string[]): string[] {
  return table
    .filter(
      (c) =>
        c.auto && !testSources.some((s) => new RegExp(`(?<![A-Za-z0-9])${c.id}(?!\\d)`).test(s)),
    )
    .map((c) => c.id);
}

/** The JSON a QA Engineer puts in its `qa` section, with or without a code fence. */
export function jsonOf(markdown: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(markdown);
  try {
    return JSON.parse((fenced ? (fenced[1] as string) : markdown).trim());
  } catch {
    throw new OmiError("CONTRACT_INVALID", "qa section: not valid JSON", {
      issues: [{ path: "sectionUpdates", message: "the qa section must hold the JSON result" }],
    });
  }
}

/** The cases of a rendered Test design table (`renderTestDesign`); other lines are ignored. */
export function parseTestTable(markdown: string): TestCase[] {
  const out: TestCase[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line
      .trim()
      .replace(/^\||(?<!\\)\|$/g, "")
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replaceAll("\\|", "|"));
    const [id, ac, steps, expected, auto, regression] = cells;
    if (cells.length !== 6 || !id || !/^TC-\d+-\d{2,}$/.test(id)) continue;
    out.push({
      id,
      ac: ac as string,
      steps: steps as string,
      expected: expected as string,
      auto: auto === "Y",
      regression: regression === "Y",
    });
  }
  return out;
}

/**
 * The verdict per table case: a case the QA Engineer did not report is `blocked`, and an `Auto = Y`
 * case reported `pass` without a test naming its id in the check output is `blocked` too.
 * Cases outside the table (a Bug's Retest) are kept as reported.
 */
export function reconcile(table: TestCase[], r: VerifyResult, output: string): VerifyResult {
  const reported = new Map(r.cases.map((c) => [c.id, c]));
  const listed = table.map((t): VerifyResult["cases"][number] => {
    const got = reported.get(t.id);
    if (!got) return { id: t.id, result: "blocked", note: "not reported" };
    if (t.auto && got.result === "pass" && !output.includes(t.id)) {
      return { ...got, result: "blocked", note: "no automated test carries this id" };
    }
    return got;
  });
  const extra = r.cases.filter((c) => !table.some((t) => t.id === c.id));
  return { ...r, cases: [...listed, ...extra] };
}

const RUN_MARKER = /<!-- omi:qa-run=(\d+) commit=([0-9a-f]{7,40}) -->/;

/**
 * Run number of a new report: the next after the existing `Run #k` comments, or the same `k`
 * (the comment is updated, not duplicated) when the last run was on the same commit.
 */
export function nextRun(
  comments: { id: number; body: string }[],
  commit: string,
): { k: number; updateId?: number } {
  let last: { k: number; commit: string; id: number } | undefined;
  for (const c of comments) {
    const m = RUN_MARKER.exec(c.body);
    if (m && (!last || Number(m[1]) > last.k)) {
      last = { k: Number(m[1]), commit: m[2] as string, id: c.id };
    }
  }
  if (!last) return { k: 1 };
  return last.commit === commit ? { k: last.k, updateId: last.id } : { k: last.k + 1 };
}

/** `Run #k · <commit> · pass/fail by ID · Bug tạo ra: #…` (bugs are filled in by the Coordinator). */
export function renderRun(o: {
  k: number;
  commit: string;
  result: VerifyResult;
  checksPassed: boolean;
  qaTaskNumber: number;
  bugs?: number[];
  /** Proposed Bug bodies (§11) of a FAILED run, for the Coordinator. */
  proposals?: string[];
}): string {
  const { k, commit, result: r } = o;
  const verdict = verifyPassed(r, o.checksPassed) ? "PASSED" : "FAILED";
  const lines = [
    `<!-- omi:qa-run=${k} commit=${commit} -->`,
    `**Run #${k}** · \`${commit.slice(0, 8)}\` · ${verdict} · Bug tạo ra: ${
      o.bugs?.length ? o.bugs.map((b) => `#${b}`).join(", ") : "—"
    }`,
    "",
    `Automated suite: ${o.checksPassed ? "pass" : "fail"}`,
    "",
    ...r.cases.map((c) => `- ${c.id}: ${c.result}${c.note ? ` — ${c.note}` : ""}`),
  ];
  if (r.manualRegression.length) {
    lines.push(
      "",
      "Manual regression (Regression = Y):",
      ...r.manualRegression.map((m) => `- ${m}`),
    );
  }
  if (o.proposals?.length) {
    lines.push(
      "",
      "<details><summary>Proposed Bugs (the Coordinator creates them)</summary>",
      "",
      ...o.proposals.flatMap((p) => [p, ""]),
      "</details>",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Bug body proposal of §11 for each defect: `Found in: QATask #n · TC-…`. */
export function proposeBugs(r: VerifyResult, qaTaskNumber: number, commit: string): string[] {
  return r.defects.map((d) =>
    [
      `## ${d.title}`,
      `**Steps to reproduce:** ${d.repro}`,
      `**Expected / Actual:** ${d.expected} / ${d.actual}`,
      `**Severity:** ${d.severity}`,
      `**Environment / commit:** develop @ ${commit.slice(0, 8)}`,
      `**Found in:** QATask #${qaTaskNumber}${d.tc.length ? ` · ${d.tc.join(", ")}` : ""}`,
    ].join("\n"),
  );
}
