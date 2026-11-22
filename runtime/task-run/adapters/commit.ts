// The runtime commits an implementing step's work (DevTask-0085 #262): the agent only writes code
// and tests, so it needs no git write permission. The message comes from data, never from the LLM.

import { OmiError } from "../../shared/errors/errors.ts";
import { redact } from "../../shared/redact.ts";
import type { CommitInfo } from "../application/ports.ts";
import { git } from "./worktree.ts";

/** Directories no task commit may contain, whatever the repo's .gitignore says. */
const UNSAFE_DIRS = new Set([".git", ".omi-plugins", "node_modules", ".ssh", ".aws"]);
/**
 * OMI's own local config directory: refused at the repo root, and anywhere else unless the file is
 * tracked (a plugin template such as `templates/workspace/.omi-plugins/omi.config.yaml`).
 */
const LOCAL_CONFIG_DIR = ".omi-plugins";
/** File names that hold secrets or machine-local configuration. */
const UNSAFE_FILE =
  /^(\.env(\..+)?|omi\.config\.json|\.npmrc|\.netrc|credentials(\.json)?|id_(rsa|dsa|ecdsa|ed25519)|.+\.(pem|key|p12|pfx|jks|keystore))$/i;
const SAFE_ENV_TEMPLATE = /^\.env\.(example|sample|template)$/i;

/**
 * Why `path` (repo-relative) must not be committed, or undefined when it is safe. `tracked`: the
 * file is already in git, which lets a nested `.omi-plugins/` file (a template) through.
 */
export function unsafeReason(path: string, tracked = false): string | undefined {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  const dir = parts
    .slice(0, -1)
    .find((p, i) => UNSAFE_DIRS.has(p) && !(p === LOCAL_CONFIG_DIR && i > 0 && tracked));
  if (dir) return `inside ${dir}/`;
  const name = parts.at(-1) ?? "";
  if (UNSAFE_DIRS.has(name)) return `is ${name}`;
  if (UNSAFE_FILE.test(name) && !SAFE_ENV_TEMPLATE.test(name)) return "looks like a secret file";
  return undefined;
}

export type { CommitInfo };

/** `<type>(<scope>): <title> (#n)`, then round/attempt, then attribution. */
export function commitMessage(i: CommitInfo): string[] {
  const type = i.type === "bug" ? "fix" : "feat";
  const model = i.model.replace(/[^\w.-]/g, "") || "unknown";
  return [
    `${type}(${i.scope}): ${i.title.replace(/\s+/g, " ").trim()} (#${i.issue})`,
    `OMI step ${i.stepId}, round ${i.round}, attempt ${i.attempt}.`,
    `Co-Authored-By: ${model} <noreply@anthropic.com>`,
  ];
}

/**
 * Commits everything the step changed in `worktree`. Refuses (POLICY_VIOLATION) when a path is not
 * safe to commit; nothing is staged then. Returns the new commit SHA, or null when there is
 * nothing to commit.
 */
export function commitWork(worktree: string, info: CommitInfo): string | null {
  const names = (args: string[]) => git(args, worktree).split("\0").filter(Boolean);
  const paths = new Set([
    ...names(["ls-files", "--others", "--exclude-standard", "-z"]),
    ...names(["diff", "--name-only", "-z", "HEAD"]),
  ]);
  const nested = [...paths].filter((p) => p.split("/").slice(1).includes(LOCAL_CONFIG_DIR));
  const tracked = new Set(nested.length ? names(["ls-files", "-z", "--", ...nested]) : []);
  const refused = [...paths].flatMap((p) => {
    const why = unsafeReason(p, tracked.has(p));
    return why ? [`${p} (${why})`] : [];
  });
  if (refused.length) {
    throw new OmiError(
      "POLICY_VIOLATION",
      redact(`the step left files that must not be committed: ${refused.slice(0, 20).join(", ")}`),
      { files: refused.slice(0, 20) },
    );
  }
  git(["add", "-A"], worktree);
  if (!git(["status", "--porcelain"], worktree)) return null;
  const [title, ...body] = commitMessage(info);
  git(["commit", "-q", "-m", title as string, ...body.flatMap((b) => ["-m", b])], worktree);
  return git(["rev-parse", "HEAD"], worktree);
}
