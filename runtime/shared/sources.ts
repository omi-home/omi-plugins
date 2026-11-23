// Pure parsing of Issue bodies for the packet's `Sources` section and for Issue references.
// Bodies are untrusted data: everything here only extracts numbers and splits text.
import type { IssueRef } from "./contracts.ts";

/** Most Issues of a `## Sources` section that enter a packet. */
export const MAX_SOURCES = 4;

const SOURCES_HEADING = /^#{1,6}\s*sources\s*$/i;
const ANY_HEADING = /^#{1,6}\s/;
const FENCE = /^\s*(```|~~~)/;

/** Body of the `## Sources` section (heading to next heading); null when absent. */
export function sourcesSection(body: string): string | null {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => SOURCES_HEADING.test(l.trim()));
  if (start < 0) return null;
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (ANY_HEADING.test(l.trim())) break;
    out.push(l);
  }
  return out.join("\n");
}

/** `#n` and `owner/repo#n` references of a Sources section, deduped, at most `MAX_SOURCES`. */
export function parseSources(body: string, defaultRepository: string): IssueRef[] {
  const section = sourcesSection(body);
  if (section === null) return [];
  const out: IssueRef[] = [];
  const seen = new Set<string>();
  for (const m of section.matchAll(/(?<![\w/.-])(?:([\w.-]+\/[\w.-]+))?#(\d{1,7})(?!\w)/g)) {
    const repository = m[1] ?? defaultRepository;
    const number = Number(m[2]);
    const key = `${repository.toLowerCase()}#${number}`;
    if (number < 1 || seen.has(key)) continue;
    seen.add(key);
    out.push({ repository, number });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

/** Same-repository `#n` mentioned in prose (not code, HTML comments or the Sources section). */
export function mentionedIssues(body: string): number[] {
  let text = body.replace(/<!--[\s\S]*?-->/g, "");
  const kept: string[] = [];
  let fenced = false;
  let inSources = false;
  for (const line of text.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (ANY_HEADING.test(line.trim())) inSources = SOURCES_HEADING.test(line.trim());
    if (!inSources) kept.push(line);
  }
  text = kept.join("\n").replace(/`[^`\n]*`/g, "");
  const out = new Set<number>();
  for (const m of text.matchAll(/(?<![\w/&#.-])#(\d{1,7})(?!\w)/g)) out.add(Number(m[1]));
  return [...out].filter((n) => n > 0);
}
