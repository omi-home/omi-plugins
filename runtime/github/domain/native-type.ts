import type { IssueType } from "../../shared/contracts.ts";

/** Native Issue Type expected for an OMI type (ADR-0001 D6); unlisted types have none. */
export const NATIVE_TYPE: Partial<Record<IssueType, string>> = {
  bug: "Bug",
  feature: "Feature",
  "dev-task": "Task",
  "test-task": "Task",
  "devops-task": "Task",
  "documentation-task": "Task",
};
