// Project writes of the task lifecycle (`task start/run/unblock/analyze/finalize`, `pr create/merge`),
// chosen by `github.model` (DevTask-0128 #373, ChangeRequest-0013 #302 §9.6, ADR-0005 D2):
//   legacy → the callers keep their direct Status writes (this module is not used);
//   v2     → `omi move <n> "In progress"` before work is handed to an agent, `omi sync` after (In review,
//            Done and the parents' roll-up are `auto` rules). The state engine is the only Project writer.
import { type OmiConfig, workflowModel } from "../../shared/config.ts";
import type { GhRunner } from "../../shared/github/client.ts";
import { issueMove, type StateDeps, stateDeps } from "./state.ts";
import { projectSync } from "./sync.ts";

/** What the state engine did for a lifecycle step (null under `legacy`). */
export interface EngineOutcome {
  command: "move" | "sync";
  data: unknown;
}

export interface LifecycleDeps {
  cwd: string;
  gh?: GhRunner;
  /** Engine dependencies (tests); default: the workspace of `cwd`. */
  state?: StateDeps;
}

export const isV2 = (config: OmiConfig): boolean => workflowModel(config) === "v2";

const engine = (deps: LifecycleDeps): StateDeps => ({
  ...(deps.state ?? stateDeps(deps.cwd)),
  ...(deps.gh ? { run: deps.gh } : {}),
});

/** v2: `omi move <issue> "In progress"` (a no-op when it already is). */
export function lifecycleStart(deps: LifecycleDeps, issue: number): EngineOutcome {
  const r = issueMove(issue, "In progress", {}, engine(deps));
  return { command: "move", data: r.data };
}

/** v2: `omi sync`, which applies In review / Done / roll-up. */
export function lifecycleSync(deps: LifecycleDeps): EngineOutcome {
  return { command: "sync", data: projectSync({}, engine(deps)).data };
}
