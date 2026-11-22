// Reporting side of the task-run `ReportPort`: render a step comment and post what is pending.
// The outbox reads the run store of task-run, so reporting depends on task-run, not the reverse;
// the composition root hands this adapter to the delivery workflow.
import type { ReportPort } from "../../task-run/application/ports.ts";
import { renderStepReport } from "../application/render.ts";
import { publishPending } from "./outbox.ts";

export const stepReports: ReportPort = {
  render: renderStepReport,
  publish: (db, runId, o) => publishPending(db, runId, o),
};
