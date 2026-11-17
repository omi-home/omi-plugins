// Named-agent launcher (ADR-0001 D1): one `claude -p --agent` process per step, cwd = task worktree.
// Grants Read on <plugin-root>/resources/** only, so the agent can load its rule pack (D3).
import { isAbsolute, join, resolve } from "node:path";
import type { Role, TokenUsage } from "../../core/contracts.ts";
import { OmiError } from "../../core/errors/errors.ts";

export const PLUGIN_NAME = "omi-engineering";

export interface AgentLaunch {
  command: "claude";
  args: string[];
  cwd: string;
  /** Prompt goes through stdin: no shell quoting, no Windows command-line length limit. */
  stdin: string;
}

/** Absolute path → Claude permission-rule form: `E:\a\b` → `//e/a/b`, `/home/x` → `//home/x`. */
export function permissionPath(absPath: string): string {
  const p = resolve(absPath).replaceAll("\\", "/");
  const drive = /^([A-Za-z]):\//.exec(p);
  return drive?.[1] ? `//${drive[1].toLowerCase()}/${p.slice(3)}` : `/${p}`;
}

export function buildAgentLaunch(o: {
  pluginRoot: string;
  role: Role;
  worktree: string;
  prompt: string;
  /** Load the plugin from source (`--plugin-dir`) instead of the installed copy. */
  fromSource?: boolean;
  /** Extra permission rules, e.g. `Bash(npm test)` for the repo's own check commands. */
  allowedTools?: string[];
  /** Let the agent edit files in its worktree (implementing roles only). */
  acceptEdits?: boolean;
}): AgentLaunch {
  for (const [name, p] of [
    ["pluginRoot", o.pluginRoot],
    ["worktree", o.worktree],
  ] as const) {
    if (!isAbsolute(p)) throw new OmiError("CONTRACT_INVALID", `${name} must be an absolute path`);
  }
  const resources = permissionPath(join(o.pluginRoot, "resources"));
  return {
    command: "claude",
    args: [
      "-p",
      "--agent",
      `${PLUGIN_NAME}:${o.role}`,
      "--allowedTools",
      `Read(${resources}/**)`,
      ...(o.allowedTools ?? []),
      ...(o.acceptEdits ? ["--permission-mode", "acceptEdits"] : []),
      "--output-format",
      "stream-json",
      "--verbose",
      ...(o.fromSource ? ["--plugin-dir", o.pluginRoot] : []),
    ],
    cwd: o.worktree,
    stdin: o.prompt,
  };
}

export interface AgentObservation {
  /** From assistant `message.model` (ADR-0001 D2); "unknown" when none observed. */
  actualModel: string;
  actualEffort: "unknown";
  isError: boolean;
  result: string;
  /** `<tool>:<file_path?>` for every permission the run was denied. */
  permissionDenials: string[];
  /** Host-reported token usage of the run (result event `usage`), when present. */
  usage?: TokenUsage;
}

const nonNeg = (v: unknown) => (typeof v === "number" && v >= 0 ? Math.trunc(v) : undefined);

/**
 * Reads a stream-json transcript. `modelUsage` is not used: it includes host-internal models.
 * Broken lines (a transcript cut by timeout or crash) are skipped; no result event is an error.
 */
export function observeRun(streamJson: string): AgentObservation {
  const events = streamJson
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  const models = [
    ...new Set(
      events
        .filter((e) => e.type === "assistant")
        .map((e) => e.message?.model)
        .filter((m) => typeof m === "string" && m !== "<synthetic>"),
    ),
  ];
  const result = events.findLast((e) => e.type === "result");
  if (!result) throw new OmiError("INTERNAL", "agent run produced no result event");
  const u = result.usage ?? {};
  const input = nonNeg(u.input_tokens);
  const output = nonNeg(u.output_tokens);
  return {
    actualModel: models.length ? models.join(",") : "unknown",
    actualEffort: "unknown",
    isError: Boolean(result.is_error),
    result: String(result.result ?? ""),
    permissionDenials: (result.permission_denials ?? []).map(
      (d: { tool_name: string; tool_input?: { file_path?: string } }) =>
        `${d.tool_name}:${d.tool_input?.file_path ?? ""}`,
    ),
    ...(input !== undefined && output !== undefined
      ? {
          usage: {
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: nonNeg(u.cache_read_input_tokens),
            cacheCreationTokens: nonNeg(u.cache_creation_input_tokens),
          },
        }
      : {}),
  };
}
