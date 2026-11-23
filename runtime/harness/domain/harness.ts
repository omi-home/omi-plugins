// Port of an agent harness (ADR-0006 D7): the vendor-neutral surface `task-run` uses to run one
// named agent per step in its own process (ADR-0001 D1), read its result, detect an exhausted
// quota, report the model and effort the host observed, load the agent pack, and declare what the
// harness can do. Adapters live in `adapters/<name>/`; `task-run` never imports them.
import type { Selection } from "../../profile/domain/selection.ts";
import type {
  Harness as HarnessName,
  QuotaSignal,
  Role,
  TokenUsage,
} from "../../shared/contracts.ts";

export const PLUGIN_NAME = "omi-engineering";
/** Agent pack inside the plugin root (ADR-0003 D3): the only plugin an agent run loads. */
export const AGENT_PACK = "agent-pack";

/** What a harness can do; a step needing one the harness lacks is refused, never skipped silently. */
export type HarnessCapability = "skills" | "hooks" | "subagent" | "effort";

/** One agent process: what to run, where, with which env and stdin. */
export interface AgentLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Created when missing, never wiped: it holds the sessions a later run may resume (#407). */
  configDir: string;
  /** Prompt goes through stdin: no shell quoting, no Windows command-line length limit. */
  stdin: string;
}

export interface LaunchRequest {
  pluginRoot: string;
  role: Role;
  /** Task workspace: cwd of the agent, holds the role files and the harness home. */
  taskRoot: string;
  /** The repository the agent works on; added to the agent's reach when outside `taskRoot`. */
  worktree: string;
  prompt: string;
  /** Extra permission rules, e.g. `Bash(npm test)` for the repo's own check commands. */
  allowedTools?: string[];
  /** Let the agent edit files in its worktree (implementing roles only). */
  acceptEdits?: boolean;
  hostEnv?: NodeJS.ProcessEnv;
  /** Profile, model and effort the Coordinator chose; none keeps the agent's own defaults. */
  selection?: Selection;
  /** `agents.routing[role]`: used when there is no profile selection. */
  route?: { model: string; effort: string };
  /**
   * The harness session of this run (#407): `new` starts it under that id, `resume` continues the
   * one a previous run saved under it. Without it the run keeps no session.
   */
  session?: { mode: "new" | "resume"; id: string };
}

/** What the host observed of a finished run, never what the agent claims. */
export interface AgentObservation {
  /** The model(s) the host reports; "unknown" when none observed. */
  actualModel: string;
  /** Not observable on every harness (ADR-0001 D2): "unknown" then. */
  actualEffort: "unknown";
  /** Whether any assistant turn carried a thinking block: the observable trace of effort. */
  thinkingObserved: boolean;
  isError: boolean;
  result: string;
  /** `<tool>:<command | file_path | "">` for every permission the run was denied. */
  permissionDenials: string[];
  usage?: TokenUsage;
  durationMs?: number;
}

export interface QuotaDetection {
  signal: QuotaSignal;
  /** The raw host event, kept so the first real signal is recorded. */
  event: unknown;
}

export interface Harness {
  readonly name: HarnessName;
  readonly capabilities: readonly HarnessCapability[];
  /** The agent pack the harness loads, inside the plugin root. */
  readonly agentPack: string;
  /** The harness CLI to run. */
  readonly command: string;
  /** Versions verified with this adapter: `min` inclusive, `below` exclusive. */
  readonly verified: { readonly min: string; readonly below: string };
  /**
   * Env of an agent process: the allowlisted part of `host`; with a profile selection, that
   * profile's auth instead of the host's own.
   */
  env(host: NodeJS.ProcessEnv, selection?: Selection): Record<string, string>;
  /** Installed version of the harness CLI, or undefined when it does not run. */
  version(cwd?: string): string | undefined;
  /** Why this version may not run agents, or null when it is in the verified range. */
  versionRefusal(version: string | undefined): string | null;
  /** The process to run for one agent step. */
  launch(request: LaunchRequest): AgentLaunch;
  /** Runs it in its own process and returns the raw output stream. */
  run(launch: AgentLaunch): string;
  /** Reads the output stream of a run: result, model, usage, denials. */
  observe(output: string): AgentObservation;
  /** The quota signal of a run, when its profile ran out. */
  detectQuota(output: string): QuotaDetection | null;
}
