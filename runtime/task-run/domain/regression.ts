// Regression proof of a Bug's DevTask (DevTask-0140 #404): pure rules. Which test files carry a
// `TC-<bug>-<n>` code, which commit is "before the fix", the command line, and the report section.
// No I/O: the adapter runs the commands.

/** Marker an Issue body may carry to name the commit before the fix. */
const PRE_FIX = /<!--\s*omi:pre-fix-commit=([0-9a-fA-F]{7,40})\s*-->/;

/** The commit named by `<!-- omi:pre-fix-commit=<sha> -->` in an Issue body, lower-cased. */
export function preFixMarker(body: string): string | undefined {
  return PRE_FIX.exec(body)?.[1]?.toLowerCase();
}

/** True when `text` names a case `TC-<bug>-<n>` (not `TC-<bug>0-1`, not `TC-<bug>-x`). */
export function hasTcCode(text: string, bug: number): boolean {
  return new RegExp(`(^|[^\\w-])TC-${bug}-\\d+`).test(text);
}

/** Changed test files whose content carries a `TC-<bug>-<n>` code. */
export function tcFiles(
  changedTests: string[],
  contentOf: (file: string) => string,
  bug: number,
): string[] {
  return changedTests.filter((f) => hasTcCode(contentOf(f), bug));
}

/** Quotes one path for the platform shell (double quotes work in sh and cmd.exe). */
export const quoteFile = (f: string): string => `"${f.replaceAll("\\", "/").replaceAll('"', "")}"`;

/** `{files}` of the configured command replaced by the quoted files, each on its own. */
export function fillCommand(command: string, files: string[]): string {
  return command.replaceAll("{files}", () => files.map(quoteFile).join(" "));
}

export interface ProofRun {
  commit: string;
  exit: number | null;
  outcome: string;
  tail: string;
  logPath: string | null;
}

export interface ProofReport {
  /** Commit before the fix and where it came from. */
  preFix: string;
  source: string;
  command: string;
  files: string[];
  before: ProofRun;
  after: ProofRun;
}

/** Findings of a finished proof: the bug must fail before the fix and pass on HEAD. */
export function proofFindings(
  p: ProofReport,
): { id: string; observed: string; expected: string }[] {
  const out: { id: string; observed: string; expected: string }[] = [];
  if (p.before.outcome !== "fail") {
    // A timeout or a missing tool proves nothing either: only a real failing run reproduces the bug.
    out.push({
      id: "REG-002",
      observed:
        p.before.outcome === "pass"
          ? `The regression test does not reproduce the bug: it passes on ${p.preFix.slice(0, 8)}, before the fix.\n${p.before.tail}`
          : `The regression test did not run to a verdict on ${p.preFix.slice(0, 8)}, before the fix: ${p.before.outcome}.\n${p.before.tail}`,
      expected: "The TC-<bug>-<n> test fails on the commit before the fix.",
    });
  }
  if (p.after.outcome !== "pass") {
    out.push({
      id: "REG-002",
      observed: `The regression test does not pass after the fix: ${p.after.outcome}${p.after.exit === null ? "" : ` (exit ${p.after.exit})`} on ${p.after.commit.slice(0, 8)}.\n${p.after.tail}`,
      expected: "The TC-<bug>-<n> test passes on HEAD.",
    });
  }
  return out;
}

const verdict = (r: ProofRun, expectFail: boolean) =>
  expectFail
    ? r.outcome === "fail"
      ? "fail (expected)"
      : `${r.outcome} (unexpected: the bug is not reproduced)`
    : r.outcome === "pass"
      ? "pass (expected)"
      : `${r.outcome} (unexpected)`;

/** Markdown of the "Regression proof" report section; `tail` is already redacted. */
export function renderProof(p: ProofReport): string {
  const row = (r: ProofRun, label: string, expectFail: boolean) =>
    `| ${label} \`${r.commit.slice(0, 8)}\` | ${r.exit ?? "—"} | ${verdict(r, expectFail)} |`;
  const tail = (r: ProofRun, label: string) =>
    r.tail ? `\n${label} output (tail):\n\`\`\`\n${r.tail}\n\`\`\`` : "";
  return [
    "### Regression proof",
    `- Commit before the fix: \`${p.preFix}\` (${p.source})`,
    `- Command: \`${p.command}\``,
    `- Test files: ${p.files.map((f) => `\`${f}\``).join(", ")}`,
    "",
    "| commit | exit | result |",
    "|---|---|---|",
    row(p.before, "before fix", true),
    row(p.after, "HEAD", false),
    tail(p.before, "Before fix"),
    tail(p.after, "HEAD"),
  ].join("\n");
}
