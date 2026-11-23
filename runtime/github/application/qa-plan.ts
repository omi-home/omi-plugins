// `omi qa plan` (DevTask-0143 #408): the QA tasks of the approved QA process (PO 2026-11-23, s71),
// as pure functions: the marker that makes a re-run recognise a task it made, and the bodies
// (ChangeRequest-0013 §11 QATask / DevTask / Bug forms). No I/O.
import { sectionText } from "./issue-forms.ts";

/** What a planned task is for: Story → Test design + Verify; Bug → Fix + Retest. */
export type PlanKind = "test-design" | "verify" | "fix" | "retest";
export type StoryType = "FR" | "NFR" | "CR";

export const PLAN_KINDS: readonly PlanKind[] = ["test-design", "verify", "fix", "retest"];

/** `<!-- omi:qa-plan=<story>;kind=<kind> -->`: the first line of every task `qa plan` creates. */
export const planMarker = (target: number, kind: PlanKind) =>
  `<!-- omi:qa-plan=${target};kind=${kind} -->`;

const MARKER = /<!--\s*omi:qa-plan=(\d+);kind=(test-design|verify|fix|retest)\s*-->/;

/** The marker of a task body; undefined when the body has none. */
export function markerOf(body: string): { target: number; kind: PlanKind } | undefined {
  const m = MARKER.exec(body);
  return m ? { target: Number(m[1]), kind: m[2] as PlanKind } : undefined;
}

/** Title text of a planned task (the type prefix and number are added by `issue create`). */
export const planTitle = (target: number, kind: PlanKind) =>
  ({
    "test-design": `Test design #${target}`,
    verify: `Verify #${target}`,
    fix: `Fix #${target}`,
    retest: `Retest #${target}`,
  })[kind];

/** The Story's type from its body (`Story Type` section of the UserStory form). */
export function storyTypeOf(body: string): StoryType | undefined {
  const t = sectionText(body, "Story Type")?.split(/\s+/)[0]?.toUpperCase();
  return t === "FR" || t === "NFR" || t === "CR" ? t : undefined;
}

/** The Acceptance Criteria of a Story: v2 `Acceptance Criteria`, legacy `Scope / Acceptance`. */
export const acceptanceOf = (body: string): string | undefined =>
  sectionText(body, "Acceptance Criteria") ?? sectionText(body, "Scope / Acceptance");

/** The story a CR changes (`Changes: #n`), if its body says. */
export function changesOf(body: string): number | undefined {
  const t = sectionText(body, "Changes") ?? /^\s*changes:\s*(#\d+)/im.exec(body)?.[1];
  const m = t ? /#(\d+)/.exec(t) : null;
  return m ? Number(m[1]) : undefined;
}

/** Regression scope of a Story by its type (the table of ChangeRequest-0013 §3.2). */
export const REGRESSION_SCOPE: Record<StoryType, string> = {
  FR: "Suite tự động của repo (các `checks` trong omi.config.yaml) và các case `Regression = Y` của chức năng liền kề; khu vực manual: mục của FR trong Doc Regression Suite.",
  NFR: "Suite tự động của repo, cộng kiểm tra ngưỡng phi chức năng của NFR (hiệu năng, bảo mật, độ tin cậy) và các case `Regression = Y` của chức năng bị ảnh hưởng; khu vực manual: mục NFR trong Doc Regression Suite.",
  CR: "Suite tự động của repo, cộng mọi case `Regression = Y` của Story mà CR thay đổi và của chính CR; khu vực manual: mục của Story đó trong Doc Regression Suite.",
};

const BUG_REGRESSION =
  "Suite tự động của repo và các case `Regression = Y` của khu vực chứa lỗi; khu vực manual: mục liên quan trong Doc Regression Suite.";
const ENVIRONMENT =
  "Nhánh `develop` mới nhất; các lệnh `checks` của repo (omi.config.yaml). QATask chỉ đọc: không commit, không PR; kết quả ghi bằng comment `Run #k` theo mã TC.";

const TABLE = [
  "| ID | AC | Steps | Expected | Auto (Y/N) | Regression (Y/N) |",
  "|---|---|---|---|---|---|",
].join("\n");

const join = (parts: string[]) => `${parts.join("\n\n")}\n`;

export interface StoryFacts {
  number: number;
  type: StoryType;
  /** Acceptance Criteria copied from the Story body. */
  ac: string;
  /** CR: the Story it changes. */
  changes?: number;
}

const regressionOf = (s: StoryFacts) =>
  REGRESSION_SCOPE[s.type] + (s.changes ? ` Story bị đổi: #${s.changes}.` : "");

/** Body of the Test design / Verify QATask of a Story (the form's empty table, the Story's AC). */
export function storyTaskBody(kind: "test-design" | "verify", s: StoryFacts): string {
  const objective =
    kind === "test-design"
      ? `Thiết kế test case cho ${s.type} #${s.number}: mỗi AC có ít nhất một case \`TC-${s.number}-<n>\` (QATask chỉ đọc, không PR).`
      : `Verify ${s.type} #${s.number}: chạy các case của QATask Test design cùng Story và báo cáo kết quả theo mã TC bằng comment \`Run #k\`; điều kiện đóng Story.`;
  const done =
    kind === "test-design"
      ? [
          `- [ ] Bảng \`TC-${s.number}-<n>\` phủ mọi Acceptance Criteria bên dưới`,
          "- [ ] Mỗi case ghi rõ Auto (Y/N) và Regression (Y/N)",
        ]
      : [
          `- [ ] Mọi case \`TC-${s.number}-<n>\` có kết quả trong comment \`Run #k\``,
          "- [ ] Lỗi tìm thấy được báo cho Coordinator để tạo Bug",
        ];
  return join([
    planMarker(s.number, kind),
    `## Objective\n${objective}`,
    `## AC coverage\n${s.ac}`,
    `## Test cases\n${TABLE}`,
    `## Regression scope\n${regressionOf(s)}`,
    `## Environment\n${ENVIRONMENT}`,
    `## Scope / Acceptance\n${done.join("\n")}`,
  ]);
}

export interface BugFacts {
  number: number;
  title: string;
  steps: string;
  expected: string;
  actual: string;
}

/** The Bug's reproduction, from either the v2 form (`Expected / Actual`) or the legacy one. */
export function bugFactsOf(number: number, title: string, body: string): BugFacts | undefined {
  const steps = sectionText(body, "Steps to reproduce");
  const both = sectionText(body, "Expected / Actual");
  const expected = both ?? sectionText(body, "Expected");
  const actual = both ?? sectionText(body, "Actual");
  return steps && expected && actual ? { number, title, steps, expected, actual } : undefined;
}

/** Body of the DevTask "Fix" of a Bug: reproduction copied, regression test as an acceptance box. */
export function fixBody(b: BugFacts): string {
  return join([
    planMarker(b.number, "fix"),
    `## Objective\nSửa Bug #${b.number}: ${b.title}.`,
    `## Steps to reproduce\n${b.steps}`,
    `## Expected\n${b.expected}`,
    `## Actual\n${b.actual}`,
    "## Technical approach\nTái hiện lỗi theo các bước trên, sửa nguyên nhân gốc, thêm test hồi quy mang mã `TC-" +
      `${b.number}-<n>` +
      "` trong tên test.",
    "## Affected areas\nVùng code chứa lỗi (xác định khi tái hiện).",
    `## Verification\nTest \`TC-${b.number}-<n>\` fail trước khi sửa, pass sau khi sửa; các lệnh \`checks\` của repo pass.`,
    `## Scope / Acceptance\n- [ ] regression test \`TC-${b.number}-<n>\` fail trước fix, pass sau fix\n- [ ] Các bước Steps to reproduce không còn tái hiện`,
  ]);
}

/** Body of the QATask "Retest" of a Bug (read-only; the empty table is filled by the QA Engineer's report). */
export function retestBody(b: BugFacts): string {
  return join([
    planMarker(b.number, "retest"),
    `## Objective\nRetest + regression Bug #${b.number}: ${b.title}. QATask chỉ đọc, không PR.`,
    `## AC coverage\nBug không còn tái hiện:\n\n${b.steps}\n\nMong đợi: ${b.expected}`,
    `## Test cases\n${TABLE}`,
    `## Regression scope\n${BUG_REGRESSION}`,
    `## Environment\n${ENVIRONMENT}`,
    `## Scope / Acceptance\n- [ ] Steps to reproduce của Bug #${b.number} không còn tái hiện\n- [ ] Case \`Regression = Y\` của khu vực lỗi pass`,
  ]);
}
