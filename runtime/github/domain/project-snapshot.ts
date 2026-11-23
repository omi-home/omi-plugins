// Snapshot of the previous sync and the diff against the current model (ChangeRequest-0013 #302 §9.5
// steps 2 and 6; ADR-0005 D5). Pure; the store lives in adapters/snapshot-store.ts.
import { z } from "zod";
import { ProjectStatusV2 } from "../../shared/contracts.ts";
import type { WorkItem } from "./project-model.ts";

export const SnapshotItem = z.strictObject({
  number: z.number().int().positive(),
  status: ProjectStatusV2,
  state: z.enum(["open", "closed"]),
  closeReason: z.enum(["completed", "not_planned"]).optional(),
});
export type SnapshotItem = z.infer<typeof SnapshotItem>;

export const toSnapshot = (items: readonly WorkItem[]): SnapshotItem[] =>
  items.map((i) => ({
    number: i.number,
    status: i.status,
    state: i.state,
    ...(i.closeReason ? { closeReason: i.closeReason } : {}),
  }));

export type ExternalChange =
  | { kind: "status_changed"; issue: number; from: ProjectStatusV2; to: ProjectStatusV2 }
  | { kind: "closed"; issue: number; reason?: "completed" | "not_planned" }
  | { kind: "reopened"; issue: number }
  | { kind: "added"; issue: number; status: ProjectStatusV2 }
  | { kind: "removed"; issue: number };

/**
 * Changes between the previous snapshot and now, ordered by issue number (an Issue that both changed
 * status and open/closed yields one entry per kind). No previous snapshot (`null`, a first sync) means
 * there is nothing to compare: no changes.
 */
export function diffSnapshot(
  previous: readonly SnapshotItem[] | null,
  current: readonly SnapshotItem[],
): ExternalChange[] {
  if (previous === null) return [];
  const before = new Map(previous.map((p) => [p.number, p]));
  const now = new Map(current.map((c) => [c.number, c]));
  const out: ExternalChange[] = [];
  for (const c of [...current].sort((a, b) => a.number - b.number)) {
    const p = before.get(c.number);
    if (!p) {
      out.push({ kind: "added", issue: c.number, status: c.status });
      continue;
    }
    if (p.status !== c.status) {
      out.push({ kind: "status_changed", issue: c.number, from: p.status, to: c.status });
    }
    if (p.state !== c.state) {
      out.push(
        c.state === "closed"
          ? {
              kind: "closed",
              issue: c.number,
              ...(c.closeReason ? { reason: c.closeReason } : {}),
            }
          : { kind: "reopened", issue: c.number },
      );
    }
  }
  for (const p of [...previous].sort((a, b) => a.number - b.number)) {
    if (!now.has(p.number)) out.push({ kind: "removed", issue: p.number });
  }
  return out.sort((a, b) => a.issue - b.issue);
}
