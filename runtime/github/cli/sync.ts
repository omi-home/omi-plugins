// `omi sync [--dry-run]` under model v2 (Feature-0039 #298, ChangeRequest-0013 #302 §9.5, ADR-0005 D2/D5):
// fetch, diff with the snapshot, accept or revert what changed outside omi, sync open/closed, apply the
// `auto` rules to a fixpoint, close finished Milestones, write the snapshot, report. `omi` is the only
// writer of the Project; `--dry-run` computes the same report and writes nothing (not the snapshot).
import { spawnGh } from "../../shared/github/client.ts";
import { redact } from "../../shared/redact.ts";
import { fetchProjectModel } from "../adapters/project-fetch.ts";
import { applyWrites, commentOn } from "../adapters/project-write.ts";
import { readSnapshot, writeSnapshot } from "../adapters/snapshot-store.ts";
import { closeMilestone, latestPoComment, milestoneIsOpen } from "../adapters/sync-support.ts";
import type { ItemWrite } from "../domain/move-plan.ts";
import { type SnapshotItem, toSnapshot } from "../domain/project-snapshot.ts";
import { type PoDecision, planSync } from "../domain/sync-plan.ts";
import type { GithubCliResult } from "./github.ts";
import { requireV2, type StateDeps } from "./state.ts";

const lines = (l: string[]) => l.map((s) => `${s}\n`).join("");

export function projectSync(
  opts: { dryRun?: boolean | undefined },
  deps: StateDeps,
): GithubCliResult {
  requireV2(deps.config, "sync");
  const dryRun = Boolean(opts.dryRun);
  const { config, workflow, run = spawnGh } = deps;
  const { owner, repo, projectNumber } = config.github;
  const key = `${owner}/${repo}`;
  const built = fetchProjectModel(config, run);
  const db = deps.db();
  const previous = readSnapshot(db, key, projectNumber);
  const plan = planSync(built.items, previous, workflow);

  // Rework carries the PO's newest comment into the report (a read; also done on a dry run).
  const decisions: (PoDecision & { comment?: string })[] = plan.poDecisions.map((d) => {
    if (d.to !== "Rework") return d;
    const c = latestPoComment(config, d.issue, run);
    return c ? { ...d, comment: c.body } : d;
  });
  const milestonesToClose = plan.milestones.filter((m) => milestoneIsOpen(config, m, run));

  const finalSnapshot = new Map(toSnapshot(plan.items).map((s) => [s.number, s]));
  if (!dryRun) {
    const patches: SnapshotItem[] = [];
    let complete = false;
    try {
      // A warning is posted before its revert is written, and the snapshot learns an Issue only after
      // its write: a failure anywhere makes the next run see the change again and retry, never silently.
      const revertOf = new Map(plan.reverted.map((r) => [r.issue, r]));
      applyWrites(
        config,
        plan.writes,
        (w: ItemWrite) => {
          const s = finalSnapshot.get(w.issue);
          if (s) patches.push(s);
        },
        run,
        (w: ItemWrite) => {
          const r = revertOf.get(w.issue);
          if (!r) return;
          commentOn(
            config,
            r.issue,
            `omi sync: ${r.type} #${r.issue} was moved to ${r.from}, which ${r.reason}. Restoring ${r.to}. Status changes the PO may make are listed in the workflow.`,
            run,
          );
        },
      );
      for (const m of milestonesToClose) closeMilestone(config, m, run);
      complete = true;
    } finally {
      if (complete) {
        writeSnapshot(db, key, projectNumber, [...finalSnapshot.values()], deps.now);
      } else if (previous !== null && patches.length) {
        // Keep what the PO changed and sync has not handled yet visible to the next run.
        const merged = new Map(previous.map((i) => [i.number, i]));
        for (const p of patches) merged.set(p.number, p);
        writeSnapshot(db, key, projectNumber, [...merged.values()], deps.now);
      }
    }
  }

  const report = {
    dry_run: dryRun,
    first_sync: plan.firstSync,
    external_changes: plan.changes,
    transitions_applied: plan.applied.map((a) => ({
      issue: a.item,
      type: a.type,
      from: a.from,
      to: a.to,
    })),
    po_decisions: decisions,
    reverted: plan.reverted,
    issue_closed_by_pr: plan.closedByPr,
    state_changes: plan.writes
      .filter((w) => w.stateChange)
      .map((w) => ({ issue: w.issue, change: w.stateChange })),
    writes: plan.writes,
    milestones_closed: milestonesToClose,
    queue: plan.queue,
    inbox: plan.inbox,
    skipped: built.skipped,
    foreign: built.foreign,
  };
  const human = [
    ...(dryRun ? ["dry-run   nothing is written"] : []),
    ...(plan.firstSync
      ? ["baseline  first sync: the current state is the baseline, nothing reverted"]
      : []),
    ...decisions.map(
      (d) =>
        `po        #${d.issue}: ${d.from} -> ${d.to}${d.comment ? ` (comment: ${d.comment.split(/\r?\n/)[0]?.slice(0, 120)})` : ""}`,
    ),
    ...plan.reverted.map((r) => `revert    #${r.issue}: ${r.from} -> ${r.to} (${r.reason})`),
    ...plan.writes.map(
      (w) =>
        `status    #${w.issue}: ${w.from} -> ${w.to}${w.stateChange ? ` (${w.stateChange === "close" ? "closed" : "reopened"})` : ""}`,
    ),
    ...plan.closedByPr.map((n) => `pr-closed #${n}: closed by a merged PR`),
    ...milestonesToClose.map((m) => `milestone ${m}: all Epics Done, closed`),
    `queue     ${plan.queue.length} for the Coordinator, ${plan.inbox.length} waiting for the PO`,
    ...(plan.writes.length || plan.reverted.length || milestonesToClose.length
      ? []
      : ["sync      nothing to change"]),
  ];
  return { data: report, human: redact(lines(human)) };
}
