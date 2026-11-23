// Command grants beyond the repository's configured checks (DevTask-0131 #382). Pure data: the
// application layer turns them into `--allowedTools` rules and the role files name them to the agent.
import type { Role } from "../../shared/contracts.ts";

/** `npm run <script>` the implementing roles may run besides the configured checks. */
export const EDITOR_NPM_SCRIPTS: readonly string[] = ["check", "arch", "test", "format"];
/** Roles that review a diff: they get the read commands below, also as pipeline parts. */
export const REVIEWER_ROLES: readonly Role[] = ["code-reviewer", "security-reviewer"];
/** Read-only commands of a reviewer (none of them writes). */
export const READ_COMMANDS: readonly string[] = ["grep", "cat", "head", "tail", "wc"];
