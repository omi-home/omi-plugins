// Step report renderer (spec §12): fills `templates/reports/<category>.md` from a validated
// StepComment. Deterministic, no LLM reformatting; output is sanitized before it leaves.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CarriedFinding,
  commentMarker,
  type StepComment,
  type TokenUsage,
} from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { TEMPLATES_DIR } from "../../shared/plugin-paths.ts";
import { redact } from "../../shared/redact.ts";

const TEMPLATES = join(TEMPLATES_DIR, "reports");

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
  const profile = c.profile ? `profile ${c.profile} (${c.selectionReason ?? "no reason"}) · ` : "";
  return `${profile}requested ${c.requestedModel} · actual ${c.actualModel} (${source})`;
}
const effort = (c: StepComment) =>
  c.executor === "omi-cli"
    ? "n/a (omi-cli)"
    : `requested ${c.requestedEffort} · actual unknown (not observable)${
        c.thinkingObserved === undefined
          ? ""
          : c.thinkingObserved
            ? " · thinking observed"
            : " · no thinking observed"
      }`;

/** Field-wise sum; an optional field stays absent only when no part has it. */
export function sumUsage(parts: TokenUsage[]): TokenUsage | undefined {
  if (!parts.length) return undefined;
  const add = (k: Exclude<keyof TokenUsage, "inputTokens" | "outputTokens">) =>
    parts.some((p) => p[k] !== undefined) ? parts.reduce((n, p) => n + (p[k] ?? 0), 0) : undefined;
  return {
    inputTokens: parts.reduce((n, p) => n + p.inputTokens, 0),
    outputTokens: parts.reduce((n, p) => n + p.outputTokens, 0),
    cacheReadTokens: add("cacheReadTokens"),
    cacheCreationTokens: add("cacheCreationTokens"),
    thinkingTokens: add("thinkingTokens"),
    costUsd: add("costUsd"),
    numTurns: add("numTurns"),
  };
}

/**
 * Observed tokens, cache hit (cache read / all input) and cost. The host computes
 * `total_cost_usd` from list prices, so it is labelled an estimate (wrong behind a gateway).
 */
export function formatUsage(u: TokenUsage): string {
  const read = u.cacheReadTokens ?? 0;
  const allIn = u.inputTokens + read + (u.cacheCreationTokens ?? 0);
  return [
    `${u.inputTokens} in / ${u.outputTokens} out tokens`,
    ...(u.thinkingTokens ? [`${u.thinkingTokens} thinking`] : []),
    ...(read ? [`${read} cache read (${Math.round((100 * read) / allIn)}% hit)`] : []),
    ...(u.numTurns !== undefined ? [`${u.numTurns} turns`] : []),
    ...(u.costUsd !== undefined ? [`≈ $${u.costUsd.toFixed(4)} (list-price estimate)`] : []),
  ].join(" · ");
}

/** Skills installed for the step; the reason shows here when no profile carries it (#199). */
function skills(c: StepComment): string {
  if (c.executor === "omi-cli") return "n/a (omi-cli)";
  if (!c.skills?.length) return "—";
  const why = !c.profile && c.selectionReason ? ` (${c.selectionReason})` : "";
  return `${c.skills.join(", ")}${why}`;
}

/** Observed tokens and wall time (spec §14): never estimated, `not_available` when unknown. */
function cost(c: StepComment): string {
  const u = c.usage;
  const tokens = u
    ? formatUsage(u)
    : c.executor === "omi-cli"
      ? "no tokens (omi-cli)"
      : "tokens not_available";
  const wall =
    c.durationMs === undefined
      ? "wall time not_available"
      : `${(c.durationMs / 1000).toFixed(1)} s wall`;
  return `${tokens} · ${wall}`;
}

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
    skills: cell(skills(c)),
    cost: cell(cost(c)),
    commit: c.commitSha ? c.commitSha.slice(0, 8) : "—",
    status: c.status,
    summary: block(c.summary),
    changes: list(c.changedFiles.map((p) => `\`${p}\``)),
    evidence: list([
      ...c.evidencePaths.map((p) => `\`${p}\``),
      ...(c.warnings ?? []).map((w) => `Warning: ${block(w).replace(/\r?\n/g, " ")}`),
      ...(c.permissionDenials ?? []).map(
        (d) => `Permission denied: \`${block(d).replace(/\r?\n/g, " ").replace(/`/g, "'")}\``,
      ),
    ]),
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
  return fill(c.category, values);
}

function fill(name: string, values: Record<string, string>): string {
  const template = readFileSync(join(TEMPLATES, `${name}.md`), "utf8");
  const out = template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const v = values[key];
    if (v === undefined) {
      throw new OmiError("INTERNAL", `report template ${name}: unknown placeholder ${key}`);
    }
    return v;
  });
  return redact(out);
}

/**
 * Comment deferring findings to another task (spec §12 "Carried findings"), one per source
 * step. `targetId` is the target's logical id (e.g. T3.3); the marker stays parseable by
 * `parseCarriedFindings` and is unique per source run/step for the outbox.
 */
export function renderCarriedFindings(o: {
  targetId: string;
  runId: string;
  stepId: string;
  rows: CarriedFinding[];
}): { marker: string; body: string } {
  const ids = [o.targetId, o.runId, o.stepId];
  if (!o.rows.length || ids.some((v) => !/^[\w.-]{1,100}$/.test(v))) {
    throw new OmiError("CONTRACT_INVALID", "carried findings: need rows and plain identifiers");
  }
  const marker = `<!-- omi:carried-findings=${o.targetId};run=${o.runId};step=${o.stepId} -->`;
  const rows = o.rows.map((r) => `| ${cell(r.source)} | ${cell(r.finding)} | ${cell(r.action)} |`);
  return { marker, body: fill("carried-findings", { marker, rows: rows.join("\n") }) };
}
