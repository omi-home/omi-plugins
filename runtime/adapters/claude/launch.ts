// Named-agent launcher (ADR-0002 D2/D4/D5): one `claude -p --agent` process per step, cwd = the
// task workspace (role files next to the clone are loaded natively), plugin from `--plugin-dir`,
// a fresh CLAUDE_CONFIG_DIR per run and an env built from an allowlist, never the host's env.
import { spawnSync } from "node:child_process";
import { isAbsolute, join, relative } from "node:path";
import { type Selection, secretEnv } from "../../core/config.ts";
import type { Harness, QuotaSignal, Role, TokenUsage } from "../../core/contracts.ts";
import { OmiError } from "../../core/errors/errors.ts";

const semver = (s: string) => /(\d+)\.(\d+)\.(\d+)/.exec(s)?.slice(1).map(Number);

export function atLeast(version: string, min: string): boolean {
  const [a, b] = [semver(version), semver(min)];
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] as number) > (b[i] as number);
  }
  return true;
}

/**
 * Harness registry (#219): the CLI each harness runs and the versions verified with this adapter.
 * `min`: first Claude Code that reads AGENTS.md natively (T0.4); `below`: the next minor line,
 * not verified yet (Spike-0009 ran 2.1.325). Raise it after a probe on the new line.
 */
export const HARNESSES = {
  claudecode: { command: "claude", min: "2.1.277", below: "2.2.0" },
} as const satisfies Record<Harness, { command: string; min: string; below: string }>;

/** Installed version of a harness CLI, or undefined when it does not run. */
export function harnessVersion(h: Harness = "claudecode", cwd?: string): string | undefined {
  const r = spawnSync(HARNESSES[h].command, ["--version"], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  return r.status === 0 ? semver(r.stdout ?? "")?.join(".") : undefined;
}

/** Why this version of the harness may not run agents, or null when it is in the verified range. */
export function versionRefusal(version: string | undefined, h: Harness = "claudecode") {
  const { command, min, below } = HARNESSES[h];
  if (!version) return `${command} not found on PATH`;
  return atLeast(version, min) && !atLeast(version, below)
    ? null
    : `${command} ${version} is outside the verified range >=${min} <${below}`;
}

export const PLUGIN_NAME = "omi-engineering";
/** Agent pack inside the plugin root (ADR-0003 D3): the only plugin an agent run loads. */
export const AGENT_PACK = "agent-pack";
/** Subscription token (`claude setup-token`); with a profile, the profile supplies it (#217). */
export const AUTH_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

/**
 * Host variables an agent may inherit: OS basics for claude, git and npm, proxies, and the auth
 * token. Everything else (ANTHROPIC_API_KEY, GH_TOKEN, CLAUDECODE, …) is dropped (D5).
 */
export const ENV_ALLOWLIST = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "CommonProgramFiles",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "USER",
  "USERNAME",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "CLAUDE_CODE_GIT_BASH_PATH",
  AUTH_ENV,
];

export interface AgentLaunch {
  command: "claude";
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Wiped and recreated before every run. */
  configDir: string;
  /** Prompt goes through stdin: no shell quoting, no Windows command-line length limit. */
  stdin: string;
}

/** Allowlisted host variables (names matched case-insensitively, as Windows does). */
export function agentEnv(host: NodeJS.ProcessEnv): Record<string, string> {
  const allowed = new Map(ENV_ALLOWLIST.map((k) => [k.toUpperCase(), k]));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(host)) {
    if (v !== undefined && allowed.has(k.toUpperCase())) env[k] = v;
  }
  return env;
}

/**
 * Auth env of a profile (#217): the secret is read from the variable the profile names and set
 * under the one name Claude Code reads for that auth; the host's own auth variables never pass
 * (`ANTHROPIC_API_KEY` would win over an OAuth token, Spike-0009 Q3).
 */
export function profileEnv(sel: Selection, host: NodeJS.ProcessEnv): Record<string, string> {
  const name = secretEnv(sel.profile);
  const secret = host[name];
  if (!secret)
    throw new OmiError("CONFIG_INVALID", `profile ${sel.profile.name}: ${name} is not set`);
  const a = sel.profile.auth;
  if (a.type === "subscription") return { [AUTH_ENV]: secret };
  return a.scheme === "x-api-key"
    ? { ANTHROPIC_BASE_URL: a.baseUrl, ANTHROPIC_API_KEY: secret }
    : { ANTHROPIC_BASE_URL: a.baseUrl, ANTHROPIC_AUTH_TOKEN: secret };
}

/** Allowlisted host env without the host's auth token, plus the profile's auth. */
export function selectionEnv(sel: Selection, host: NodeJS.ProcessEnv): Record<string, string> {
  const base = agentEnv(host);
  for (const k of Object.keys(base)) if (k.toUpperCase() === AUTH_ENV) delete base[k];
  return { ...base, ...profileEnv(sel, host) };
}

export function buildAgentLaunch(o: {
  pluginRoot: string;
  role: Role;
  /** Task workspace: cwd of the agent, holds the role files and `.omi-home/claude/`. */
  taskRoot: string;
  /** The repository the agent works on; added with `--add-dir` when outside `taskRoot`. */
  worktree: string;
  prompt: string;
  /** Extra permission rules, e.g. `Bash(npm test)` for the repo's own check commands. */
  allowedTools?: string[];
  /** Let the agent edit files in its worktree (implementing roles only). */
  acceptEdits?: boolean;
  hostEnv?: NodeJS.ProcessEnv;
  /** Profile, model and effort the Coordinator chose; none keeps the agent's own defaults. */
  selection?: Selection;
}): AgentLaunch {
  for (const [name, p] of [
    ["pluginRoot", o.pluginRoot],
    ["taskRoot", o.taskRoot],
    ["worktree", o.worktree],
  ] as const) {
    if (!isAbsolute(p)) throw new OmiError("CONTRACT_INVALID", `${name} must be an absolute path`);
  }
  const rel = relative(o.taskRoot, o.worktree);
  const outside = rel.startsWith("..") || isAbsolute(rel);
  const configDir = join(o.taskRoot, ".omi-home", "claude");
  const host = o.hostEnv ?? process.env;
  const sel = o.selection;
  return {
    command: "claude",
    args: [
      "-p",
      "--agent",
      `${PLUGIN_NAME}:${o.role}`,
      "--plugin-dir",
      join(o.pluginRoot, AGENT_PACK),
      "--setting-sources",
      "project,local",
      ...(outside ? ["--add-dir", o.worktree] : []),
      ...(o.allowedTools?.length ? ["--allowedTools", ...o.allowedTools] : []),
      ...(o.acceptEdits ? ["--permission-mode", "acceptEdits"] : []),
      ...(sel ? ["--model", sel.model, "--effort", sel.effort] : []),
      "--no-session-persistence",
      "--output-format",
      "stream-json",
      "--verbose",
    ],
    cwd: o.taskRoot,
    env: { ...(sel ? selectionEnv(sel, host) : agentEnv(host)), CLAUDE_CONFIG_DIR: configDir },
    configDir,
    stdin: o.prompt,
  };
}

export interface AgentObservation {
  /** From assistant `message.model` (ADR-0001 D2); "unknown" when none observed. */
  actualModel: string;
  actualEffort: "unknown";
  /**
   * Whether any assistant turn carried a thinking block: the observable trace of effort
   * (`thinking_tokens` is 0 behind a gateway, Spike-0009 addendum 2).
   */
  thinkingObserved: boolean;
  isError: boolean;
  result: string;
  /** `<tool>:<command | file_path | "">` for every permission the run was denied. */
  permissionDenials: string[];
  /** Host-reported token usage of the run (result event `usage`), when present. */
  usage?: TokenUsage;
  /** Host-reported `duration_ms` of the run, when present. */
  durationMs?: number;
}

const nonNeg = (v: unknown) => (typeof v === "number" && v >= 0 ? Math.trunc(v) : undefined);

/** Parsed events of a stream-json transcript; broken lines (a cut transcript) are skipped. */
const streamEvents = (streamJson: string) =>
  streamJson
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });

/**
 * The quota signal of a run, if its profile ran out (#218): a `rate_limit_event` with
 * `status=rejected`, or an error result with `api_error_status` 429 or 402. `event` is the raw
 * host event, kept so the first real signal is recorded (Spike-0009 Q4 never saw a rejection).
 */
export function detectQuota(streamJson: string): { signal: QuotaSignal; event: unknown } | null {
  const events = streamEvents(streamJson);
  const rejected = events.find(
    (e) => e.type === "rate_limit_event" && e.rate_limit_info?.status === "rejected",
  );
  if (rejected) return { signal: "rate_limit_rejected", event: rejected };
  const failed = events.findLast((e) => e.type === "result" && e.is_error);
  const status = Number(failed?.api_error_status);
  if (status === 429) return { signal: "http_429", event: failed };
  if (status === 402) return { signal: "http_402", event: failed };
  return null;
}

/**
 * Reads a stream-json transcript. `modelUsage` is not used: it includes host-internal models.
 * Broken lines (a transcript cut by timeout or crash) are skipped; no result event is an error.
 */
export function observeRun(streamJson: string): AgentObservation {
  const events = streamEvents(streamJson);
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
    thinkingObserved: events.some(
      (e) =>
        e.type === "assistant" &&
        Array.isArray(e.message?.content) &&
        e.message.content.some(
          (b: { type?: unknown }) => b?.type === "thinking" || b?.type === "redacted_thinking",
        ),
    ),
    isError: Boolean(result.is_error),
    result: String(result.result ?? ""),
    // A Bash denial carries its command, not a path: without it a BLOCKED step is undiagnosable (#252).
    permissionDenials: (result.permission_denials ?? []).map(
      (d: { tool_name: string; tool_input?: { file_path?: string; command?: string } }) =>
        `${d.tool_name}:${d.tool_input?.command ?? d.tool_input?.file_path ?? ""}`,
    ),
    ...(input !== undefined && output !== undefined
      ? {
          usage: {
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: nonNeg(u.cache_read_input_tokens),
            cacheCreationTokens: nonNeg(u.cache_creation_input_tokens),
            thinkingTokens: nonNeg(u.output_tokens_details?.thinking_tokens ?? u.thinking_tokens),
            costUsd:
              typeof result.total_cost_usd === "number" && result.total_cost_usd >= 0
                ? result.total_cost_usd
                : undefined,
            numTurns: nonNeg(result.num_turns),
          },
        }
      : {}),
    ...(nonNeg(result.duration_ms) !== undefined ? { durationMs: nonNeg(result.duration_ms) } : {}),
  };
}
