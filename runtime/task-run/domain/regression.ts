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

/** The section must fit `StepComment.regressionProof` (8000 characters). */
export const PROOF_MAX_CHARS = 7500;
const COMMAND_MAX = 500;
const FILES_MAX = 1200;
const TAIL_MAX = 1500;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Markdown of the "Regression proof" report section, always within PROOF_MAX_CHARS; `tail` is already redacted. */
export function renderProof(p: ProofReport): string {
  const row = (r: ProofRun, label: string, expectFail: boolean) =>
    `| ${label} \`${r.commit.slice(0, 8)}\` | ${r.exit ?? "—"} | ${verdict(r, expectFail)} |`;
  const tail = (r: ProofRun, label: string) =>
    r.tail
      ? `\n${label} output (tail):\n\`\`\`\n${r.tail.length > TAIL_MAX ? `…${r.tail.slice(-(TAIL_MAX - 1))}` : r.tail}\n\`\`\``
      : "";
  const shown: string[] = [];
  let used = 0;
  for (const f of p.files) {
    const item = `\`${f}\``;
    if (used + item.length > FILES_MAX) break;
    shown.push(item);
    used += item.length + 2;
  }
  const more = p.files.length - shown.length;
  const out = [
    "### Regression proof",
    `- Commit before the fix: \`${p.preFix}\` (${clip(p.source, 100)})`,
    `- Command: \`${clip(p.command, COMMAND_MAX)}\``,
    `- Test files: ${shown.join(", ")}${more > 0 ? ` … and ${more} more` : ""}`,
    "",
    "| commit | exit | result |",
    "|---|---|---|",
    row(p.before, "before fix", true),
    row(p.after, "HEAD", false),
    tail(p.before, "Before fix"),
    tail(p.after, "HEAD"),
  ].join("\n");
  return clip(out, PROOF_MAX_CHARS);
}
