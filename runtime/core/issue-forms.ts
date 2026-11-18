// Required Issue sections per OMI type (DevTask-0047 #130). The Issue Forms in
// templates/github/ISSUE_TEMPLATE are the only source: a field with `validations.required` is a
// section `omi ticket validate` requires. A form renders each field as `### <label>`; a body
// written by hand passes with any heading level, a heading that starts with the label
// ("Scope / Acceptance (from roadmap)") and non-empty text under it.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { type Check, type IssueType, parseContract } from "./contracts.ts";

export const IssueForm = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  title: z.string(),
  labels: z.array(z.string()).min(1),
  body: z
    .array(
      z.strictObject({
        type: z.enum(["textarea", "input", "dropdown", "checkboxes", "markdown"]),
        id: z.string().regex(/^[a-z0-9-]+$/),
        attributes: z.looseObject({ label: z.string().min(1) }),
        validations: z.strictObject({ required: z.boolean() }).optional(),
      }),
    )
    .min(1),
});
export type IssueForm = z.infer<typeof IssueForm>;

export const formPath = (type: IssueType) =>
  new URL(`../../templates/github/ISSUE_TEMPLATE/${type}.yml`, import.meta.url);

const cache = new Map<IssueType, IssueForm>();
export const loadForm = (type: IssueType): IssueForm => {
  let f = cache.get(type);
  if (!f) {
    f = parseContract(IssueForm, parse(readFileSync(formPath(type), "utf8")), `${type} Issue Form`);
    cache.set(type, f);
  }
  return f;
};

/** Labels of the form's required fields. */
export const requiredSections = (form: IssueForm): string[] =>
  form.body.filter((f) => f.validations?.required).map((f) => f.attributes.label);

const norm = (s: string) => s.normalize("NFC").trim().toLowerCase();
/** Nothing filled in: blank, the form's `_No response_`, or a placeholder. */
const EMPTY = /^(_no response_|tbd|todo|n\/a|-)?$/i;
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Heading {
  line: number;
  level: number;
  text: string;
}

/** Markdown headings outside fenced code blocks. */
function headings(lines: string[]): Heading[] {
  const out: Heading[] = [];
  let fence = false;
  lines.forEach((l, line) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const m = !fence && /^(#{1,6})\s+(.*)$/.exec(l);
    if (m) out.push({ line, level: (m[1] as string).length, text: norm(m[2] as string) });
  });
  return out;
}

/** Required sections of `type` missing from `body`, or present with nothing under them. */
export function missingSections(body: string, form: IssueForm): string[] {
  const lines = body.split(/\r?\n/);
  const hs = headings(lines);
  const filled = (label: string) => {
    // The label as a whole word: "Impact" is not "Impacted files"; "(from roadmap)" may follow.
    const re = new RegExp(`^${reEscape(norm(label))}(?![\\p{L}\\p{N}])`, "u");
    return hs.some((h, i) => {
      if (!re.test(h.text)) return false;
      const end = hs.slice(i + 1).find((n) => n.level <= h.level)?.line ?? lines.length;
      const text = lines
        .slice(h.line + 1, end)
        .join("\n")
        .replace(/<!--[\s\S]*?-->/g, "")
        .trim();
      return !EMPTY.test(text);
    });
  };
  return requiredSections(form).filter((label) => !filled(label));
}

/** Ready gate; Objective is left to its own gate (which also accepts "Mục tiêu"). */
export function sectionsCheck(body: string, type: IssueType): Check {
  const missing = missingSections(body, loadForm(type)).filter((l) => l !== "Objective");
  return missing.length
    ? {
        name: "sections",
        status: "fail",
        code: "TICKET_INVALID",
        detail: `missing or empty: ${missing.join(", ")} (${type} Issue Form)`,
      }
    : { name: "sections", status: "pass", detail: `${type} required sections present` };
}
