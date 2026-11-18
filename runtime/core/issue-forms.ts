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

/** Labels of the required fields; Objective has its own gate. */
export const requiredSections = (form: IssueForm): string[] =>
  form.body
    .filter((f) => f.validations?.required && f.attributes.label !== "Objective")
    .map((f) => f.attributes.label);

const norm = (s: string) => s.normalize("NFC").trim().toLowerCase();
/** A form's placeholder for an empty optional field. */
const EMPTY = /^(_no response_)?$/i;

/** Required sections of `type` missing from `body`, or present with nothing under them. */
export function missingSections(body: string, form: IssueForm): string[] {
  const lines = body.split(/\r?\n/);
  const text = (label: string): string | undefined => {
    const at = lines.findIndex((l) => {
      const m = /^#{1,6}\s+(.*)$/.exec(l);
      return m?.[1] !== undefined && norm(m[1]).startsWith(norm(label));
    });
    if (at < 0) return undefined;
    const end = lines.findIndex((l, i) => i > at && /^#{1,6}\s/.test(l));
    return lines
      .slice(at + 1, end < 0 ? undefined : end)
      .join("\n")
      .trim();
  };
  return requiredSections(form).filter((label) => EMPTY.test(text(label) ?? ""));
}

export function sectionsCheck(body: string, type: IssueType): Check {
  const missing = missingSections(body, loadForm(type));
  return missing.length
    ? {
        name: "sections",
        status: "fail",
        code: "TICKET_INVALID",
        detail: `missing or empty: ${missing.join(", ")} (${type} Issue Form)`,
      }
    : { name: "sections", status: "pass", detail: `${type} required sections present` };
}
