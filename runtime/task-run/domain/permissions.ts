// Command grants beyond the repository's configured checks (DevTask-0131 #382). Pure data: the
// application layer turns them into `--allowedTools` rules and the role files name them to the agent.
// Reviewers get no shell read commands (DevTask-0138 #395, Bug-0012 #391): they read with the
// harness's Read/Grep/Glob tools and read-only git.

/** `npm run <script>` the implementing roles may run besides the configured checks. */
export const EDITOR_NPM_SCRIPTS: readonly string[] = ["check", "arch", "test", "format"];
