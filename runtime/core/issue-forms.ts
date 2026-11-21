// Required Issue sections per OMI type (DevTask-0047 #130). The Issue Forms in
// templates/github/ISSUE_TEMPLATE are the only source: a field with `validations.required` is a
// section `omi ticket validate` requires. A form renders each field as `### <label>`; a body
// written by hand passes with any heading level, a heading that starts with the label
// ("Scope / Acceptance (from roadmap)") and non-empty text under it.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { type Check, type IssueType, IssueTypeV2, parseContract } from "./contracts.ts";

const FormBody = z
  .array(
    z.strictObject({
      type: z.enum(["textarea", "input", "dropdown", "checkboxes", "markdown"]),
      id: z.string().regex(/^[a-z0-9-]+$/),
      attributes: z.looseObject({ label: z.string().min(1) }),
      validations: z.strictObject({ required: z.boolean() }).optional(),
    }),
  )
  .min(1);

export const IssueForm = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  title: z.string(),
  labels: z.array(z.string()).min(1),
  body: FormBody,
});
export type IssueForm = z.infer<typeof IssueForm>;

/** Model v2 form: the native issue type replaces the `type:*` label. */
export const IssueFormV2 = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  title: z.string(),
  type: IssueTypeV2,
  body: FormBody,
});
export type IssueFormV2 = z.infer<typeof IssueFormV2>;

/** Doc has one form per variant (ChangeRequest-0013 §11); the `Doc kind` section picks it. */
export const DOC_FORMS = [
  "Doc-vision-scope",
  "Doc-architecture",
  "Doc-design-system",
  "Doc-glossary-domain",
  "Doc-regression-suite",
] as const;

const formPathV2 = (file: string) =>
  new URL(`../../templates/github-v2/ISSUE_TEMPLATE/${file}.yml`, import.meta.url);

const cacheV2 = new Map<string, IssueFormV2>();
const loadFile = (file: string): IssueFormV2 => {
  let f = cacheV2.get(file);
  if (!f) {
    f = parseContract(
      IssueFormV2,
      parse(readFileSync(formPathV2(file), "utf8")),
      `${file} v2 form`,
    );
    cacheV2.set(file, f);
  }
  return f;
};

/** The v2 form(s) of a native type: one, or the five variants for `Doc`. */
export const loadFormsV2 = (type: IssueTypeV2): IssueFormV2[] =>
  type === "Doc" ? DOC_FORMS.map(loadFile) : [loadFile(type)];

/** The variant name a Doc form prefills in its `Doc kind` field. */
const docKind = (f: IssueFormV2): string | undefined => {
  const v = f.body.find((b) => b.id === "doc-kind")?.attributes.value;
  return typeof v === "string" ? v : undefined;
};

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
export const requiredSections = (form: Pick<IssueForm, "body">): string[] =>
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

/**
 * Text under the first heading whose text starts with `label` and has content; undefined when no
 * such heading or all are empty. The label counts as a whole word: "Impact" is not "Impacted
 * files"; "(from roadmap)" may follow.
 */
function sectionText(body: string, label: string): string | undefined {
  const lines = body.split(/\r?\n/);
  const hs = headings(lines);
  const re = new RegExp(`^${reEscape(norm(label))}(?![\\p{L}\\p{N}])`, "u");
  for (const [i, h] of hs.entries()) {
    if (!re.test(h.text)) continue;
    const end = hs.slice(i + 1).find((n) => n.level <= h.level)?.line ?? lines.length;
    const text = lines
      .slice(h.line + 1, end)
      .join("\n")
      .replace(/<!--[\s\S]*?-->/g, "")
      .trim();
    if (!EMPTY.test(text)) return text;
  }
  return undefined;
}

/** Required sections of `type` missing from `body`, or present with nothing under them. */
export function missingSections(body: string, form: Pick<IssueForm, "body">): string[] {
  return requiredSections(form).filter((label) => sectionText(body, label) === undefined);
}

const STORY_TYPES = ["FR", "NFR", "CR"];
const failSections = (detail: string): Check => ({
  name: "sections",
  status: "fail",
  code: "TICKET_INVALID",
  detail,
});

/** Model v2 ready gate: required sections of the native type's form (a Doc: of its variant). */
export function sectionsCheckV2(body: string, type: IssueTypeV2): Check {
  let form = loadFormsV2(type)[0] as IssueFormV2;
  let label: string = type;
  if (type === "Doc") {
    const kind = sectionText(body, "Doc kind");
    const variant = loadFormsV2("Doc").find(
      (f) => docKind(f) && norm(docKind(f) ?? "") === norm(kind ?? ""),
    );
    if (!variant) {
      return failSections(
        `missing or unknown Doc kind: ${loadFormsV2("Doc")
          .map(docKind)
          .join(", ")} (Doc Issue Form)`,
      );
    }
    form = variant;
    label = `Doc ${docKind(variant)}`;
  }
  const missing = missingSections(body, form);
  if (missing.length)
    return failSections(`missing or empty: ${missing.join(", ")} (${label} Issue Form)`);

  if (type === "UserStory") {
    const st = sectionText(body, "Story Type")?.split(/\s+/)[0]?.toUpperCase();
    if (!st || !STORY_TYPES.includes(st)) {
      return failSections(`Story Type must be ${STORY_TYPES.join(", ")} (UserStory Issue Form)`);
    }
    // ChangeRequest-0013 §2.3: a CR names the Story it changes.
    if (
      st === "CR" &&
      !/#\d+/.test(sectionText(body, "Changes") ?? "") &&
      !/^\s*(?:#{1,6}\s+)?changes:\s*#\d+/im.test(body)
    ) {
      return failSections("a CR story needs Changes: #<story cũ> (UserStory Issue Form)");
    }
  }
  return { name: "sections", status: "pass", detail: `${label} required sections present` };
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
