// The workflow of a workspace: the plugin default plus the `github.workflow` override of its
// omi.config.yaml (schema, merge and validation: shared/workflow.ts).
import { readConfigData } from "../../shared/config.ts";
import { resolveWorkflow, type Workflow } from "../../shared/workflow.ts";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The workflow of a workspace: default plus `github.workflow` of its omi.config.yaml, if any. */
export function loadWorkflow(workspace: string): Workflow {
  const data = readConfigData(workspace);
  const github = isRecord(data) ? data.github : undefined;
  return resolveWorkflow(isRecord(github) ? github.workflow : undefined);
}
