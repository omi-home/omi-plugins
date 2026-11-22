// Claude Code adapter of the `Harness` port: one `claude -p --agent` process per step.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { OmiError } from "../../../shared/errors/errors.ts";
import { AGENT_PACK, type AgentLaunch, type Harness } from "../../domain/harness.ts";
import {
  AUTH_ENV,
  buildAgentLaunch,
  detectQuota,
  harnessVersion,
  observeRun,
  versionRefusal,
} from "./launch.ts";

const AGENT_TIMEOUT_MS = 30 * 60_000;

export const spawnAgent = (l: AgentLaunch): string => {
  // A gateway profile authenticates with its own key (#217).
  if (!l.env[AUTH_ENV] && !l.env.ANTHROPIC_API_KEY && !l.env.ANTHROPIC_AUTH_TOKEN) {
    throw new OmiError(
      "CONFIG_INVALID",
      `${AUTH_ENV} is not set: run \`claude setup-token\` and export it, or pick a profile (agents do not use the host login)`,
    );
  }
  rmSync(l.configDir, { recursive: true, force: true }); // a fresh config dir per run (D5)
  mkdirSync(l.configDir, { recursive: true });
  const r = spawnSync(l.command, l.args, {
    cwd: l.cwd,
    env: l.env,
    input: l.stdin,
    encoding: "utf8",
    timeout: AGENT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    throw new OmiError("INTERNAL", "claude CLI not found on PATH");
  }
  return r.stdout ?? ""; // a cut or failed run has no result event: observeRun reports it
};

export const claudeCode: Harness = {
  name: "claudecode",
  capabilities: ["skills", "hooks", "subagent", "effort"],
  agentPack: AGENT_PACK,
  version: (cwd) => harnessVersion("claudecode", cwd),
  versionRefusal: (version) => versionRefusal(version, "claudecode"),
  launch: buildAgentLaunch,
  run: spawnAgent,
  observe: observeRun,
  detectQuota,
};
