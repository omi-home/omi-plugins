// The runtime commits an implementing step's work (DevTask-0085 #262): the agent only writes code
// and tests, so it needs no git write permission. The message comes from data, never from the LLM.
import { redact } from "../../reporting/redact.ts";
import { git } from "../../resources/worktree.ts";
import { OmiError } from "../errors/errors.ts";

/** Directories no task commit may contain, whatever the repo's .gitignore says. */
const UNSAFE_DIRS = new Set([".git", ".omi-plugins", "node_modules", ".ssh", ".aws"]);
/** File names that hold secrets or machine-local configuration. */
const UNSAFE_FILE =
  /^(\.env(\..+)?|omi\.config\.json|\.npmrc|\.netrc|credentials(\.json)?|id_(rsa|dsa|ecdsa|ed25519)|.+\.(pem|key|p12|pfx|jks|keystore))$/i;
const SAFE_ENV_TEMPLATE = /^\.env\.(example|sample|template)$/i;

/** Why `path` (repo-relative) must not be committed, or undefined when it is safe. */
export function unsafeReason(path: string): string | undefined {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  const dir = parts.slice(0, -1).find((p) => UNSAFE_DIRS.has(p));
  if (dir) return `inside ${dir}/`;
  const name = parts.at(-1) ?? "";
  if (UNSAFE_DIRS.has(name)) return `is ${name}`;
  if (UNSAFE_FILE.test(name) && !SAFE_ENV_TEMPLATE.test(name)) return "looks like a secret file";
  return undefined;
}

export interface CommitInfo {
  /** Issue type label (`dev-task`, `bug`, …). */
  type: string;
  title: string;
  issue: number;
  round: number;
  attempt: number;
  stepId: string;
  /** Short name of the role, used as the commit scope. */
  scope: string;
  /** Model the host observed, for the attribution line. */
  model: string;
}

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
  const refused = [...paths].flatMap((p) => {
    const why = unsafeReason(p);
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
