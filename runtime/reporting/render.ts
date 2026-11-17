// Step report renderer (spec §12): fills `templates/reports/<category>.md` from a validated
// StepComment. Deterministic, no LLM reformatting; output is sanitized before it leaves.
import { readFileSync } from "node:fs";
import { commentMarker, type StepComment } from "../core/contracts.ts";
import { OmiError } from "../core/errors/errors.ts";
import { redact } from "./redact.ts";

const TEMPLATES = new URL("../../templates/reports/", import.meta.url);

/** Agent text must not forge an `omi:` marker or break out of its section. */
const block = (s: string) => {
  const t = s.replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;");
  return (t.match(/```/g)?.length ?? 0) % 2 ? `${t}\n\`\`\`` : t; // close a dangling fence
};
/** Table cells: one line, no column breaks. */
const cell = (s: string) => block(s).replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "_None_");

/** Requested vs actual, labelled with where the actual value came from (ADR-0001 D2). */
function model(c: StepComment): string {
  if (c.executor === "omi-cli") return "n/a (omi-cli)";
  const source = c.actualModel === "unknown" ? "not observed" : "observed";
  return `requested ${c.requestedModel} · actual ${c.actualModel} (${source})`;
}
const effort = (c: StepComment) =>
  c.executor === "omi-cli"
    ? "n/a (omi-cli)"
    : `requested ${c.requestedEffort} · actual unknown (not observable)`;

export function renderStepReport(c: StepComment): string {
  const values: Record<string, string> = {
    marker: commentMarker(c),
    ticket: `${c.issue.repository}#${c.issue.number}`,
    workflow: cell(c.workflow),
    stepTitle: cell(c.stepTitle),
    round: String(c.round),
    attempt: String(c.attempt),
    executor: c.executor,
    model: cell(model(c)),
    effort: cell(effort(c)),
    commit: c.commitSha ? c.commitSha.slice(0, 8) : "—",
    status: c.status,
    summary: block(c.summary),
    evidence: list(c.evidencePaths.map((p) => `\`${p}\``)),
    findings: list(
      c.findings.map((f) =>
        cell(
          [
            f.id,
            f.severity,
            f.path && (f.line ? `${f.path}:${f.line}` : f.path),
            f.observed,
            `expected: ${f.expected}`,
          ]
            .filter(Boolean)
            .join(" · "),
        ),
      ),
    ),
    nextAction: block(c.nextAction),
    executionId: c.executionId,
    createdAt: c.createdAt,
  };
  const template = readFileSync(new URL(`${c.category}.md`, TEMPLATES), "utf8");
  const out = template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const v = values[key];
    if (v === undefined) {
      throw new OmiError("INTERNAL", `report template ${c.category}: unknown placeholder ${key}`);
    }
    return v;
  });
  return redact(out);
}
