// Task packet builder and step-result acceptance (spec §11). The packet is what an agent gets
// instead of the chat; the result is a recommendation the runtime verifies before acting on it.
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  parseContract,
  SCHEMA_VERSION,
  STEP_RESULT_SCHEMA,
  StepResult,
  TaskPacket,
} from "../contracts.ts";
import { OmiError } from "../errors/errors.ts";

/** Raw agent output above this is rejected before parsing. */
export const MAX_RESULT_CHARS = 64 * 1024;

export type TaskPacketInput = Omit<TaskPacket, "schemaVersion" | "outputSchema">;

/** Validates a packet; caller supplies the run's owned worktree and the GitHub context. */
export function buildTaskPacket(input: TaskPacketInput): TaskPacket {
  const packet = parseContract(
    TaskPacket,
    { ...input, schemaVersion: SCHEMA_VERSION, outputSchema: STEP_RESULT_SCHEMA },
    "task packet",
  );
  if (!existsSync(packet.worktree) || !statSync(packet.worktree).isDirectory()) {
    throw new OmiError("CONTRACT_INVALID", "task packet: worktree does not exist");
  }
  return packet;
}

/** The whole output as JSON, or the last ```json fenced block in it. */
function extractJson(raw: string): unknown {
  const text = raw.trim();
  const fenced = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)].at(-1)?.[1];
  try {
    return JSON.parse(text.startsWith("{") ? text : (fenced ?? ""));
  } catch {
    throw new OmiError("CONTRACT_INVALID", "step result: output is not a JSON object");
  }
}

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** Tracked files changed since `base` (committed or not) plus untracked, non-ignored files. */
function changedSince(worktree: string, base: string): Set<string> {
  const out = git(worktree, ["diff", "--name-only", "-z", base]).concat(
    git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]),
  );
  return new Set(out.split("\0").filter(Boolean));
}

const isCommitAfter = (worktree: string, base: string, sha: string) => {
  try {
    git(worktree, ["merge-base", "--is-ancestor", base, sha]);
    return true;
  } catch {
    return false; // unknown object or not descended from base
  }
};

const norm = (p: string) => p.replaceAll("\\", "/").replace(/^\.\//, "");
/** `src` and `src/` cover `src/x`, never `srcX/y`. */
const inScope = (f: string, s: string) =>
  f === s.replace(/\/$/, "") || f.startsWith(s.endsWith("/") ? s : `${s}/`);

/**
 * Parses raw agent output and checks it answers this packet: same run/issue/step/round/
 * attempt/role, claimed files really changed, evidence exists, commit descends from baseSha,
 * changes stay inside the packet scope.
 */
export function acceptStepResult(packet: TaskPacket, raw: string): StepResult {
  if (raw.length > MAX_RESULT_CHARS) {
    throw new OmiError(
      "CONTRACT_INVALID",
      `step result: ${raw.length} chars exceeds the ${MAX_RESULT_CHARS} limit`,
    );
  }
  const r = parseContract(StepResult, extractJson(raw), "step result");

  const mismatch: string[] = (
    ["workflowRunId", "stepId", "round", "attempt", "role"] as const
  ).filter((k) => r[k] !== packet[k]);
  if (r.issue.repository !== packet.issue.repository || r.issue.number !== packet.issue.number) {
    mismatch.push("issue");
  }
  if (mismatch.length) {
    throw new OmiError(
      "OWNERSHIP_MISMATCH",
      `step result does not answer this packet: ${mismatch.join(", ")}`,
      { fields: mismatch },
    );
  }

  const changed = changedSince(packet.worktree, packet.baseSha);
  const issues: { path: string; message: string }[] = [];
  for (const f of r.changedFiles) {
    if (!changed.has(norm(f))) issues.push({ path: f, message: "not changed in the worktree" });
    else if (packet.scope.length && !packet.scope.some((s) => inScope(norm(f), norm(s)))) {
      issues.push({ path: f, message: "outside packet scope" });
    }
  }
  for (const p of r.evidencePaths) {
    if (!existsSync(join(packet.worktree, p))) issues.push({ path: p, message: "does not exist" });
  }
  if (r.commitSha && !isCommitAfter(packet.worktree, packet.baseSha, r.commitSha)) {
    issues.push({ path: "commitSha", message: "not a commit descended from baseSha" });
  }
  if (issues.length) {
    throw new OmiError("CONTRACT_INVALID", "step result: claims do not match the worktree", {
      issues,
    });
  }
  return r;
}
