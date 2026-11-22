// `omi issue findings|section get|section set` and `omi handoff show|post`: the command bodies of
// the handoff module; runtime/cli/main.ts only routes to them and wraps the result in its envelope.
import type { OmiConfig } from "../../shared/config.ts";
import { fetchIssueContext, readSection, writeSection } from "../adapters/context.ts";
import { listHandoffs, postHandoff, strip } from "../adapters/handoff.ts";

export interface HandoffOut {
  data: unknown;
  human: string;
}

const lines = (l: string[]) => l.map((s) => `${s}\n`).join("");

export function issueFindings(config: OmiConfig, issue: number): HandoffOut {
  const found = fetchIssueContext(config, issue).carriedFindings;
  const human = found.length
    ? found.map((f) => `- ${f.source}: ${f.finding} → ${f.action}`)
    : [`no carried findings on #${issue}`];
  return { data: { issue, findings: found }, human: lines(human) };
}

export function issueSectionGet(config: OmiConfig, issue: number, section: string): HandoffOut {
  const text = readSection(config, issue, section);
  return { data: { issue, section, text }, human: `${text}\n` };
}

export function issueSectionSet(
  config: OmiConfig,
  issue: number,
  section: string,
  text: string,
): HandoffOut {
  writeSection(config, issue, section, text);
  return { data: { issue, section }, human: `section   #${issue} ${section} updated\n` };
}

export function handoffShow(config: OmiConfig): HandoffOut {
  const h = listHandoffs(config)[0] ?? null;
  const human = h
    ? lines([
        `handoff   ${h.marker} on #${h.issue} ${h.title} (${h.createdAt})`,
        `url       ${h.url}`,
        "",
        strip(h.body),
      ])
    : "handoff   none found\n";
  return { data: h, human };
}

export function handoffPost(config: OmiConfig, text: string, milestone?: number): HandoffOut {
  const r = postHandoff(config, text, { issue: milestone });
  return {
    data: r,
    human: lines([`handoff   ${r.marker} on #${r.issue} (${r.action})`, `url       ${r.url}`]),
  };
}
