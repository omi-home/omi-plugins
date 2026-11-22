// OMI CLI entry. Pure function of argv/cwd → {code, stdout, stderr}; bin/omi does the I/O.
// Everything leaving the process goes through redact.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { archCheck, archShow, humanReport, violationError } from "../architecture/cli/arch.ts";
import { cleanupApply, cleanupScan, type ScanResult } from "../cleanup/cli/cleanup.ts";
import { taskFinalize } from "../cleanup/cli/finalize.ts";
import { contextApply, contextPlan, humanContextPlan } from "../context/cli/context.ts";
import {
  githubProjectApply,
  githubProjectPlan,
  githubRepoApply,
  githubRepoPlan,
  issueCreate,
  issueDepend,
  projectValidate,
  repoValidate,
} from "../github/cli/github.ts";
import {
  handoffPost,
  handoffShow,
  issueFindings,
  issueSectionGet,
  issueSectionSet,
} from "../handoff/cli/handoff.ts";
import { agentPreToolUse, type HookInput, preToolUse, sessionStart } from "../hook/cli/hook.ts";
import { MONITOR_PROTOCOL_VERSION } from "../monitor/cli/protocol.ts";
import {
  type ProfileDeps,
  profileAdd,
  profileEdit,
  profileImport,
  profileList,
  profileRemove,
  profileSetToken,
} from "../profile/cli/profile.ts";
import { secretInitKey, secretRotateKey } from "../profile/cli/secret.ts";
import { prCreate, prMerge, prValidate } from "../release/cli/pr.ts";
import { releaseCheck, releaseTag } from "../release/cli/release.ts";
import { formatUsage, stepReports, sumUsage } from "../reporting/cli/usage.ts";
import { repo } from "../shared/config.ts";
import { type ProfileView, ProjectStatus, Role, type TokenUsage } from "../shared/contracts.ts";
import { ERROR_CODES, OmiError } from "../shared/errors/errors.ts";
import { PLUGIN_ROOT } from "../shared/plugin-paths.ts";
import { redact, redactDeep } from "../shared/redact.ts";
import { CONFIG_FILE, locate } from "../shared/workspace.ts";
import { taskAnalyze } from "../task-run/cli/analyze.ts";
import { ticketValidate } from "../task-run/cli/gates.ts";
import { taskRun } from "../task-run/cli/run.ts";
import { skillList } from "../task-run/cli/skills.ts";
import { taskStart } from "../task-run/cli/start.ts";
import {
  NO_PROFILE,
  NO_STATUS,
  NOT_IN_PROJECT,
  status,
  statusKey,
} from "../task-run/cli/status.ts";
import { taskStatus } from "../task-run/cli/task-status.ts";
import { taskUnblock } from "../task-run/cli/unblock.ts";
import { configGet, configSet } from "../workspace/cli/config.ts";
import { type Check, doctor, probeProfiles } from "../workspace/cli/doctor.ts";
import { projectInit } from "../workspace/cli/init.ts";
import { workspaceInit, workspaceMigrate } from "../workspace/cli/workspace.ts";

const humanScan = (s: ScanResult) => [
  ...s.runs.map(
    (r) =>
      `#${String(r.issue).padEnd(5)} ${r.state.padEnd(16)} ${[
        r.mergedPr ? `merged PR #${r.mergedPr}` : "not merged",
        r.worktree ? `worktree${r.worktree.exists ? "" : " (missing)"}` : "no worktree",
        r.pendingReports ? `${r.pendingReports} pending report(s)` : "",
        r.openAttempts ? `${r.openAttempts} open attempt(s)` : "",
        r.crashedAttempts ? `${r.crashedAttempts} crashed (process gone): ${r.hint}` : "",
        r.unknownAttempts ? `${r.unknownAttempts} unknown (no PID)` : "",
        r.leased ? "leased (running)" : "",
      ]
        .filter(Boolean)
        .join(", ")}`,
  ),
  ...s.orphans.map((p) => `orphan    ${p} (not owned: left alone)`),
  ...s.prunable.map((p) => `prunable  ${p}`),
];

export const HELP = `Usage: omi <command> [--output human|json]

Commands:
  doctor [--probe]       Check tools, repository, AGENTS.md, workspace config and GitHub access;
                         --probe runs one short claude call per active profile (spends tokens)
  status [--milestone <n>]
                         Read-only overview of a Milestone (default: the active one): its Issues by
                         Project Status with open PRs, local runs and leftovers, Status drift and
                         governance gaps
  ticket validate <n>    Check Issue #n against the ticket-first gates (no changes). github.model
                         legacy: type:* label, issue-hierarchy.yaml, templates/github forms; v2: native
                         issue type, issue-hierarchy-v2.yaml (Epic/Doc/ADR have no parent, others need
                         one), title <IssueType>-<NNNN>-, sections of templates/github-v2 forms
  task start <n>         Validate Issue #n, create or reuse its run and worktree, mark it In Progress
  task status <n>        Show the local run, worktree and transitions of Issue #n
  task run <n>           Start Issue #n and drive its planned Engineer (label role:*) → checks → Code
                         Reviewer (→ Security Reviewer when risk:high/security or asked) (→ Architect)
                         → release validation (→ Manual QA for bugs, ui, qa:manual) until In Review
                         or it needs a person (Waiting PO, Blocked). Runs agents: spends tokens.
  task analyze <n>       Feature / Change Request / FR / NFR #n: BA (→ UI/UX with label ui) (→ Architect)
                         write their sections into the Issue body, then Waiting PO. No worktree.
                         Runs agents: spends tokens.
                         task run / task analyze: --profile <name> [--model <id>] [--effort <level>]
                         --reason <text> runs every agent step on that profile (\`profile list\`);
                         model/effort default to the profile's first; none: agents.routing.
                         --skills <role>=<skill>,<skill> (repeatable, needs --reason) adds skills
                         from that role's set (\`skill list\`) to its steps; defaults always install
  task unblock <n>       Clear a BLOCKED run of Issue #n (a person decided): resume it through the FSM,
                         post one report (who, --reason <text>); the next \`task run\` re-runs the step
                         that reported BLOCKED
  task finalize <n>      After Issue #n's PR is merged: verify the merge receipt, clean the owned
                         worktree, branch and temp dirs safely (no --force), post one cleanup report,
                         then Done + parent roll-up. --dry-run shows the cleanup plan only
  pr create <n>          Push Issue #n's task branch, create or reuse its PR → develop (Release: develop →
                         main) and verify base, head and the one primary Issue; marks it In Review.
                         --title <text> (default: Issue title), --body-file <path> (extra PR description)
  pr validate <n>        Read-only merge eligibility of Issue #n's task PR: state, base, primary
                         Issue, tip, conflicts, CI, reviews, merge method, protection, risk
  pr merge <n>           Merge Issue #n's task PR when every gate passes (configured method, pinned
                         to the validated head); risk:high goes to Waiting PO and is not merged
  release check <n>      Read-only gate for Release Issue #n: plugin.json and package.json agree on a
                         semver, CHANGELOG.md has "## [<version>]", tag <plugin>--v<version> is free and
                         newer on origin, develop is ahead of main, the Milestone's other work is closed
  release tag <n>        After the PO merged #n's PR (develop → main): tag its merge commit
                         <plugin>--v<version>, push the tag, close #n, Done + roll-up. Re-run: no-op
  issue create           Create an Issue: --type <OMI type> --title <text> --body-file <path>
                         [--parent <n|owner/repo#n>]. Numbered <IssueType>-<NNNN>- per type, linked
                         as a sub-issue (hierarchy matrix checked first), added to the Project.
                         Re-running with the same type and title completes the same Issue.
                         github.model v2: --type is a native type name (DevTask), set as the Issue's issue
                         type (no type:* label); a non-root type needs --parent (issue-hierarchy-v2.yaml)
  issue depend <n> --on <m|owner/repo#m>
                         Record that Issue #n is blocked by #m (native dependency; another repo is
                         fine). Refuses cycles; re-running is a no-op. \`ticket validate\` then holds
                         #n until #m is closed
  issue findings <n>     List the findings other tasks carried over to Issue #n
                         (<!-- omi:carried-findings=... --> comments: source | finding | action)
  issue section get <n> <name>   Print the <!-- omi:section=<name> --> section of Issue #n
  issue section set <n> <name>   Replace (or append) that section with --body-file <path>
  workspace init [--name <n>] [--repo <path|url>]
                         Build <name>-workspace/ (default: next to the repo) with .claude/, .omi-plugins/
                         (omi.config.yaml, omi.config.json) and the Coordinator's AGENTS.md, and clone the
                         repo into it. Re-running reports each item created or kept; never overwrites
  workspace migrate [--name <n>] [--dry-run]
                         From a repo on the old layout (.omi/config.yaml, worktrees): build the workspace
                         with workspace init, copy the config and the state into .omi-plugins/. Refused
                         while a run is open or a task worktree is left; deletes nothing in the repo and
                         lists the old files to remove in a task PR. Re-running keeps what exists
  github project init [--title <text>]
                         Bootstrap this repo into OMI: find or create the Project (title, default: repo
                         name), link it, write the github section of .omi-plugins/omi.config.yaml and
                         install templates/github/ into .github/ where missing. Re-running changes nothing;
                         never overwrites a file. github.model v2: also creates/updates the organization's
                         8 issue types (needs the admin:org scope; a personal account is refused)
  github project plan    Diff the Project's custom fields (config/github/project.yaml), views, built-in
                         workflows and Insights (views.yaml) and list items whose Status their type does
                         not use (status-transitions.yaml). github.model v2: also the organization's issue
                         types (config/github/issue-types.yaml), and reads project-v2.yaml + views-v2.yaml
                         (7 views, Status of 10 options) instead; lists every enabled built-in workflow
                         with the manual step to turn it off; Status drift is then checked against
                         workflow.yaml (github.workflow override) by native issue type, not
                         status-transitions.yaml, and also lists items with no issue type or no
                         Status. Read-only; exits 1 while anything is
                         pending, manual or drifting. \`project plan\` is an alias
  github project apply   Create missing fields, options and views (by name + layout); never deletes. View
                         filters/grouping/sort, workflows, iteration fields and conflicts are printed as
                         manual steps (exit 1); Insights as unsupported. github.model v2: creates missing
                         issue types and updates their name/description/color, never deletes or disables
                         one; no admin:org scope: \`gh auth refresh -s admin:org\`. Also sets each view's
                         filter and layout (updateProjectV2View); group/sort/columns, the Type field and
                         built-in workflows stay manual. \`project apply\` is an alias
  github project validate
                         The same diff as checks (extra fields/views/issue types and Insights: warnings;
                         github.model v2: the manual steps with no API are one warning, \`manual-steps\`)
  github repo plan       Diff the repository's labels, main/develop protection and merge methods against
                         config/github/repository.yaml (github.model v2: the flag labels of
                         repository-v2.yaml). Read-only; exits 1 while anything differs
  github repo apply --approved-plan <file>
                         Apply exactly the plan the PO approved (\`github repo plan --output json\`
                         saved to <file>): adds labels, tightens protection, sets merge methods; never
                         deletes or loosens. Refused when the plan changed since approval
  github repo validate   The same diff as checks (private repo on Free: protection unsupported, D5)
  handoff show           Print the newest session handoff (comment opening <!-- omi:handoff=... -->)
                         found in the repository; none is not an error
  handoff post --body-file <path> [--milestone <n>]
                         Post the handoff on the active Milestone (the one open Milestone In Progress or
                         In Review) with marker <date>-s<N>; the same text again changes nothing, a text
                         opening with an existing marker updates that comment. Redacted
  profile list           Read-only: execution profiles of state.sqlite (harness, auth, models, efforts,
                         whether a token is stored); never prints a token
  profile add <name> --auth subscription --token-env <VAR> | --auth gateway --base-url <url>
                         --scheme <x-api-key|bearer> --key-env <VAR>; --models a,b --efforts high,medium
                         [--harness claudecode] [--disabled] [--token-stdin]
                         Add a profile; --token-stdin seals the token read from stdin
  profile edit <name> [--auth ...] [--token-env|--key-env|--base-url|--scheme <v>] [--models a,b]
                         [--efforts a,b] [--disabled|--enabled]
                         Change a profile; its name cannot change (add a new one, remove the old)
  profile remove <name>  Delete a profile and its sealed token
  profile set-token <name>
                         Seal the token read from stdin (never argv) for the profile; overwrites
  profile import [--dry-run]
                         One-time move of omi.config.json (and a YAML profiles section) into the
                         database: seals each token from the env variable the profile declares, renames
                         the file to <file>.<timestamp>.bak. Re-running is safe; env variables are kept
  secret init-key        Create the master key (AES-256-GCM, 32 bytes) in the user environment variable
                         secrets.keyEnv (default OMI_SECRET_KEY); never printed. Refused when a key is
                         set or the database holds sealed tokens. Windows; elsewhere prints how
  secret rotate-key      Re-seal every token with the key in <keyEnv>_NEXT in one transaction; any
                         failure keeps the old key valid. Afterwards swap the variables yourself
  config get [path]      Read-only: the validated settings of .omi-plugins/omi.config.yaml (defaults
                         applied), or one value by dotted path (checks.test.run); data has an etag
  config set [--body-file <path>] [--if-match <etag>] [--confirm-commands]
                         Edit omi.config.yaml from JSON {"changes":[{"path":"git.baseBranch","value":"dev"},
                         {"path":"setup","unset":true}]} (stdin, or --body-file). Validated as a whole,
                         comments kept, written atomically; unknown fields or wrong types: CONFIG_INVALID
                         and the file stays; stale --if-match: CONFIG_CONFLICT; changing checks or setup
                         (shell commands) needs --confirm-commands: POLICY_VIOLATION
  skill list [--role <role>]
                         Read-only: each role's default and allowed skills (agent-pack) and what each
                         skill is for; the input for \`task run --skills\`
  context plan [--role <role>]
                         Read-only: measure the context a session starts with in the workspace and in
                         a task workspace of each role (\`/context\`, no tokens) and classify every
                         plugin, skill, MCP server and memory file as needed / unneeded / unknown;
                         keep list: context.keep in omi.config.yaml
  context apply [--dry-run] [--remove] [--bundled]
                         Switch the workspace's unneeded items off in its .claude/settings.json only
                         (enabledPlugins incl. @synced, skillOverrides, disableClaudeAiConnectors,
                         deniedMcpServers; disableBundledSkills only with --bundled). Re-run changes
                         nothing; --remove takes back what OMI added; other keys untouched
  cleanup scan           Inventory open runs, owned worktrees, merged-but-uncleaned tasks, unposted
                         reports, attempts left open by a crash, orphan and prunable worktrees
  cleanup apply --safe   Recover crashed attempts, post pending reports, finalize merged tasks and
                         prune missing worktrees; orphans are reported, never removed
  hook pre-tool-use      Coordinator plugin hook (hook input JSON on stdin): exit 2 with the reason when
                         the call edits the main repo, commits on or pushes to develop/main, or uses
                         --force; anything else (or no OMI workspace, bad input) passes
  hook session-start     Coordinator plugin hook: short summary (latest handoff, Milestone status)
  hook agent-pre-tool-use
                         Agent-pack hook (hook input JSON on stdin): exit 2 when an agent runs git
                         push or gh, or writes a file outside its task workspace (CLAUDE_PROJECT_DIR)
  arch check [--repo <dir>] [--contract <relPath>] [--output text|json]
                         Deterministic architecture check against omi-architecture.yaml: imports across
                         module boundaries or layers, forbidden packages, files in the wrong place,
                         files in no declared module. Exit 1 (ARCH_VIOLATION) with a fix per violation;
                         a missing or invalid contract is CONTRACT_INVALID. No agent, no child process
  arch show [--scope <relPath>…] [--repo <dir>] [--contract <relPath>] [--output json]
                         Read-only: the layers, placement rules and the modules touching --scope (plus
                         their dependsOn; all when no scope), at most 30
  version                Print the OMI version
  help                   Show this help

Exit codes: 0 ok, 1 failed check or error, 2 usage error, 75 transient error (retry)
`;

export const EXIT = { ok: 0, failed: 1, usage: 2, transient: 75 } as const;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const VERSION: string = JSON.parse(
  readFileSync(resolve(PLUGIN_ROOT, "package.json"), "utf8"),
).version;

/** 0 when nothing failed; 75 when every failure is transient (retry helps); else 1. */
const checksExit = (checks: Check[]) => {
  const failed = checks.filter((c) => c.status === "fail");
  if (!failed.length) return EXIT.ok;
  return failed.every((c) => c.code && ERROR_CODES[c.code].transient)
    ? EXIT.transient
    : EXIT.failed;
};

const issueArg = (a: string | undefined) => {
  const m = /^#?(\d+)$/.exec(a ?? "");
  if (!m || Number(m[1]) < 1) throw new OmiError("USAGE_INVALID", "expected an issue number");
  return Number(m[1]);
};

const sectionArg = (a: string | undefined) => {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(a ?? "")) {
    throw new OmiError("USAGE_INVALID", "expected a section name (lowercase letters, digits, -)");
  }
  return a as string;
};

/** Subcommands: <group> <action> <issue>. */
const NESTED = new Set([
  "ticket validate",
  "task start",
  "task status",
  "task run",
  "task analyze",
  "task finalize",
  "task unblock",
  "pr create",
  "pr validate",
  "pr merge",
  "issue depend",
  "issue findings",
  "release check",
  "release tag",
]);
const GITHUB_REPO = new Set(["plan", "apply", "validate"]);
const GITHUB_PROJECT = new Set(["init", "plan", "apply", "validate"]);
/** Subcommands without an issue: <group> <action>. */
const REPO_WIDE = new Set([
  "cleanup scan",
  "cleanup apply",
  "project plan",
  "project apply",
  "handoff show",
  "handoff post",
  "workspace init",
  "workspace migrate",
  "context plan",
  "context apply",
  "profile list",
  "config get",
  "config set",
  "profile add",
  "profile edit",
  "profile remove",
  "profile set-token",
  "profile import",
  "secret init-key",
  "secret rotate-key",
  "skill list",
  "hook pre-tool-use",
  "hook session-start",
  "hook agent-pre-tool-use",
  "arch check",
  "arch show",
]);

/** Profile subcommands that take the profile name as their one positional. */
const NAMED = new Set(["profile add", "profile edit", "profile remove", "profile set-token"]);

/** Process inputs the CLI reads; tests replace them. */
export interface CliIo {
  env?: NodeJS.ProcessEnv;
  /** The whole of stdin (secrets arrive here, never in argv). */
  stdin?: () => string;
}

/** A github-module command result as a CLI result: `failed` exits 1. */
const githubOut = (
  ok: (data: unknown, human: string, code?: number) => CliResult,
  r: { data: unknown; human: string; failed?: boolean },
): CliResult => ok(r.data, r.human, r.failed ? EXIT.failed : EXIT.ok);

const pickFlags = (v: {
  profile?: string;
  model?: string;
  effort?: string;
  reason?: string;
  skills?: string[];
}) => ({
  profile: v.profile,
  model: v.model,
  effort: v.effort,
  reason: v.reason,
  skills: v.skills,
});

const profileFlags = (v: Record<string, string | boolean | string[] | undefined>) => ({
  harness: v.harness as string | undefined,
  auth: v.auth as string | undefined,
  tokenEnv: v["token-env"] as string | undefined,
  keyEnv: v["key-env"] as string | undefined,
  baseUrl: v["base-url"] as string | undefined,
  scheme: v.scheme as string | undefined,
  models: v.models as string | undefined,
  efforts: v.efforts as string | undefined,
  disabled: v.disabled as boolean | undefined,
  enabled: v.enabled as boolean | undefined,
});

const humanProfile = (p: ProfileView) =>
  `${p.name.padEnd(16)} ${p.harness} ${p.auth.type} ${p.disabled ? "disabled" : "active"} ${p.hasToken ? "sealed" : "UNSEALED"}  models ${p.models.join(",")}  efforts ${p.efforts.join(",")}`;

const lines = (l: string[]) => l.map((s) => `${s}\n`).join("");

const humanChecks = (checks: Check[]) =>
  checks
    .map((c) => `${c.status.toUpperCase().padEnd(5)} ${c.name.padEnd(18)} ${c.detail}\n`)
    .join("");

export function main(argv: string[], cwd = process.cwd(), io: CliIo = {}): CliResult {
  // Decided before parsing so that usage errors are structured too.
  const json = argv.some(
    (a, i) => a === "--output=json" || (a === "json" && argv[i - 1] === "--output"),
  );
  let command = "";
  const envelope = (body: object) =>
    `${JSON.stringify(redactDeep({ ok: false, command, protocolVersion: MONITOR_PROTOCOL_VERSION, ...body }))}\n`;
  const ok = (data: unknown, human: string, code: number = EXIT.ok): CliResult => ({
    code,
    stdout: json ? envelope({ ok: code === EXIT.ok, data }) : redact(human),
    stderr: "",
  });

  try {
    let parsed: ReturnType<typeof parse>;
    try {
      parsed = parse(argv);
    } catch (e) {
      throw new OmiError("USAGE_INVALID", (e as Error).message);
    }
    const { values, positionals } = parsed;
    // `text` is an alias of `human` (omi arch check --output text|json).
    if (values.output !== "human" && values.output !== "text" && values.output !== "json") {
      throw new OmiError("USAGE_INVALID", "--output must be human, text or json");
    }
    command = values.help ? "help" : (positionals[0] ?? "");
    let rest = positionals.slice(1);
    if (
      !values.help &&
      (NESTED.has(`${command} ${rest[0]}`) || REPO_WIDE.has(`${command} ${rest[0]}`))
    ) {
      command = `${command} ${rest[0]}`;
      rest = rest.slice(1);
    } else if (command === "issue" && (rest[0] === "create" || rest[0] === "section")) {
      command = rest[0] === "create" ? "issue create" : `issue section ${rest[1] ?? ""}`;
      rest = rest.slice(rest[0] === "create" ? 1 : 2);
      if (
        command !== "issue create" &&
        command !== "issue section get" &&
        command !== "issue section set"
      ) {
        throw new OmiError("USAGE_INVALID", "expected issue section get|set <n> <name>");
      }
    } else if (command === "github" && rest[0] === "repo" && GITHUB_REPO.has(rest[1] ?? "")) {
      command = `github repo ${rest[1]}`;
      rest = rest.slice(2);
    } else if (command === "github" && rest[0] === "project" && GITHUB_PROJECT.has(rest[1] ?? "")) {
      command = `github project ${rest[1]}`;
      rest = rest.slice(2);
    } else if (
      [
        "ticket",
        "task",
        "pr",
        "cleanup",
        "issue",
        "project",
        "github",
        "handoff",
        "release",
        "workspace",
        "hook",
        "config",
        "profile",
        "secret",
        "arch",
      ].includes(command)
    ) {
      throw new OmiError("USAGE_INVALID", `unknown ${command} action: ${rest[0] ?? "(none)"}`);
    }
    const issue =
      NESTED.has(command) || command.startsWith("issue section") ? issueArg(rest.shift()) : 0;
    const section = command.startsWith("issue section") ? sectionArg(rest.shift()) : "";
    const profileName = NAMED.has(command) ? rest.shift() : undefined;
    const deps = (): ProfileDeps => ({
      workspace: locate(cwd).workspace,
      env: io.env ?? process.env,
      stdin: io.stdin ?? (() => readFileSync(0, "utf8")),
    });
    const bodyFile = (): string => {
      const file = values["body-file"];
      if (!file) throw new OmiError("USAGE_INVALID", "--body-file is required");
      try {
        return readFileSync(resolve(cwd, file), "utf8");
      } catch {
        throw new OmiError("USAGE_INVALID", `cannot read --body-file ${file}`);
      }
    };
    const configPath = command === "config get" ? rest.shift() : undefined;
    if (rest.length) throw new OmiError("USAGE_INVALID", `unexpected argument: ${rest[0]}`);

    switch (command) {
      case "help":
        return ok({ help: HELP }, HELP);
      case "version":
        return ok({ omi: VERSION }, `omi ${VERSION}\n`);
      case "status": {
        const milestone = values.milestone === undefined ? undefined : issueArg(values.milestone);
        const r = status({ cwd, milestone, cleanupScan });
        const order: string[] = [...ProjectStatus.options, NO_STATUS, NOT_IN_PROJECT];
        const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length);
        const keys = Object.keys(r.byStatus).sort((a, b) => rank(a) - rank(b));
        const counted: string[] = [ProjectStatus.enum.Done, ProjectStatus.enum.Cancelled];
        const fail = (s: { ok: false; error: { code: string; message: string } }) =>
          `unavailable (${s.error.code}: ${s.error.message})`;
        const human = [
          `milestone #${r.milestone.number} ${r.milestone.title} (${statusKey(r.milestone)})`,
          ...keys.flatMap((k) => {
            const all = r.byStatus[k] ?? [];
            if (counted.includes(k)) return [`${k.padEnd(12)} ${all.length} issue(s)`];
            return all.map(
              (i, n) =>
                `${(n ? "" : k).padEnd(12)} ${"  ".repeat(i.depth - 1)}#${i.number} ${i.title}${i.state === "CLOSED" ? " (closed)" : ""}${i.prs.map((p) => ` PR #${p.number}${p.draft ? " (draft)" : ""}`).join("")}`,
            );
          }),
          ...(r.usage.ok
            ? r.usage.value.flatMap((u) => [
                `usage     #${u.issue} ${u.runId} (${u.models.join(",")}): ${formatUsage(u.usage)}`,
                // Per profile once a run used one (`routing` = no profile chosen).
                ...(u.byProfile.some((b) => b.profile !== NO_PROFILE)
                  ? u.byProfile.map((b) => `            ${b.profile}: ${formatUsage(b.usage)}`)
                  : []),
              ])
            : [`usage     ${fail(r.usage)}`]),
          ...(r.cleanup.ok
            ? humanScan(r.cleanup.value).map((l) => `run       ${l}`)
            : [`runs      ${fail(r.cleanup)}`]),
          ...(r.drift.ok
            ? r.drift.value.map((d) => `drift     ${d.issue} ${d.status ?? "unset"}: ${d.reason}`)
            : [`drift     ${fail(r.drift)}`]),
          ...(r.governance.ok
            ? r.governance.value.map(
                (c) => `governance ${c.status.toUpperCase()} ${c.name}: ${c.detail}`,
              )
            : [`governance ${fail(r.governance)}`]),
        ];
        return ok(r, lines(human));
      }
      case "context plan": {
        const p = contextPlan({ cwd, role: values.role });
        return ok(p, lines(humanContextPlan(p)));
      }
      case "context apply": {
        const r = contextApply({
          cwd,
          dryRun: values["dry-run"],
          remove: values.remove,
          bundled: values.bundled,
        });
        const verb = r.dryRun ? "would change" : r.changed ? "changed" : "unchanged";
        return ok(
          r,
          lines([`settings  ${r.settingsPath} (${verb})`, ...r.diff.map((d) => `  ${d}`)]),
        );
      }
      case "profile list": {
        const profiles = profileList(deps());
        return ok(
          { profiles },
          lines(
            profiles.length
              ? profiles.map(humanProfile)
              : ["profiles  none: steps use agents.routing"],
          ),
        );
      }
      case "config get": {
        const r = configGet(locate(cwd).workspace, configPath);
        return ok(r, `${JSON.stringify(r.value, null, 2)}\n`);
      }
      case "config set": {
        const r = configSet(locate(cwd).workspace, {
          input: values["body-file"] ? bodyFile() : readFileSync(0, "utf8"),
          ifMatch: values["if-match"],
          confirmCommands: values["confirm-commands"],
        });
        return ok(
          r,
          lines([`config    ${r.changed ? "updated" : "unchanged"} (etag ${r.etag.slice(0, 12)})`]),
        );
      }
      case "profile add": {
        const p = profileAdd(
          deps(),
          profileName,
          profileFlags(values),
          Boolean(values["token-stdin"]),
        );
        return ok({ profile: p }, lines([humanProfile(p)]));
      }
      case "profile edit": {
        const p = profileEdit(deps(), profileName, { ...profileFlags(values), name: values.name });
        return ok({ profile: p }, lines([humanProfile(p)]));
      }
      case "profile remove": {
        const r = profileRemove(deps(), profileName);
        return ok(r, lines([`removed   ${r.removed}`]));
      }
      case "profile set-token": {
        const p = profileSetToken(deps(), profileName);
        return ok({ profile: p }, lines([humanProfile(p)]));
      }
      case "profile import": {
        const r = profileImport(deps(), Boolean(values["dry-run"]));
        const human = [
          ...(r.dryRun ? ["dry run  nothing changed"] : []),
          ...r.imported.map((n) => `imported  ${n}`),
          ...r.kept.map((n) => `kept      ${n} (already in the database)`),
          ...r.differing.map(
            (n) => `differs   ${n} (the file declares it differently: \`omi profile edit ${n}\`)`,
          ),
          ...r.tokensStored.map((n) => `token     ${n} sealed`),
          ...r.tokensMissing.map(
            (n) => `no token  ${n} (its env variable is not set: \`profile set-token\`)`,
          ),
          ...r.backups.map((f) => `backup    ${f}`),
          ...(r.imported.length || r.kept.length || r.backups.length
            ? ["note      env variables are kept until ChangeRequest-0004 #241 releases"]
            : ["import    nothing to import"]),
        ];
        return ok(r, lines(human));
      }
      case "secret init-key": {
        const d = deps();
        const r = secretInitKey({ workspace: d.workspace, env: d.env });
        return ok(
          r,
          lines([
            `key       ${r.keyEnv} written to the user environment (fingerprint ${r.fingerprint})`,
            `next      ${r.next}`,
          ]),
        );
      }
      case "secret rotate-key": {
        const d = deps();
        const r = secretRotateKey({ workspace: d.workspace, env: d.env });
        return ok(
          r,
          lines([
            `rotated   ${r.rotated} token(s), new fingerprint ${r.fingerprint}`,
            `next      ${r.next}`,
          ]),
        );
      }
      case "skill list": {
        const role = values.role === undefined ? undefined : Role.safeParse(values.role);
        if (role && !role.success) {
          throw new OmiError("USAGE_INVALID", `--role takes one of ${Role.options.join(", ")}`);
        }
        const r = skillList(role ? [role.data] : Role.options);
        return ok(
          r,
          lines([
            ...r.roles.map(
              (x) =>
                `${x.role.padEnd(22)} default ${x.default.join(",")}  allowed ${x.allowed.join(",") || "-"}`,
            ),
            "",
            ...r.skills.map((s) => `${s.name.padEnd(30)} ${s.description}`),
          ]),
        );
      }
      case "arch check": {
        const report = archCheck({ cwd, repo: values.repo, contract: values.contract });
        if (!report.passed) throw violationError(report);
        return ok(report, humanReport(report));
      }
      case "arch show": {
        const excerpt = archShow({
          cwd,
          repo: values.repo,
          contract: values.contract,
          scope: values.scope,
        });
        return ok(excerpt, `${JSON.stringify(excerpt, null, 2)}\n`);
      }
      case "doctor": {
        const checks = doctor(cwd);
        // Spends tokens: only on request (#219).
        if (values.probe) checks.push(...probeProfiles(locate(cwd).workspace));
        return ok({ checks }, humanChecks(checks), checksExit(checks));
      }
      case "release check": {
        const checks = releaseCheck({ cwd }, issue);
        return ok({ issue, checks }, humanChecks(checks), checksExit(checks));
      }
      case "release tag": {
        const r = releaseTag({ cwd }, issue);
        const human = [
          `tag       ${r.tag} @ ${r.commit.slice(0, 12)}${r.created ? "" : " (exists)"}`,
          `pr        ${r.pr}`,
          ...(r.closed ? [`closed    #${issue}`] : []),
          ...r.changes.map((c) => `status    ${c.issue}: ${c.from ?? "unset"} → ${c.to}`),
          ...(r.held ? [`held      ${r.held}`] : []),
        ];
        return ok(r, lines(human));
      }
      case "ticket validate": {
        const checks = ticketValidate({ cwd }, issue);
        return ok({ issue, checks }, humanChecks(checks), checksExit(checks));
      }
      case "task start": {
        const r = taskStart({ cwd }, issue);
        const human = [
          `run       ${r.run.id} (${r.run.state})`,
          `worktree  ${r.workspace.path}${r.workspace.reused ? " (reused)" : ""}${r.workspace.dirty ? " (dirty)" : ""}`,
          `branch    ${r.workspace.branch} @ base ${r.workspace.baseSha.slice(0, 12)}`,
          ...r.status.map((c) => `status    ${c.issue}: ${c.from ?? "unset"} → ${c.to}`),
        ];
        return ok(r, lines(human));
      }
      case "task status": {
        const st = taskStatus({ cwd }, issue);
        const human = st.run
          ? [
              `run       ${st.run.id} (${st.run.state})`,
              `worktree  ${st.worktree ? `${st.worktree.path}${st.worktree.exists ? "" : " (missing)"}` : "none"}`,
              `branch    ${st.branch ?? "none"}`,
              ...st.transitions.map((t) => `  ${t.from ?? "-"} → ${t.to} (${t.event})`),
              ...st.usage.map(
                (u) =>
                  `usage     ${u.stepId} r${u.round} a${u.attempt} ${u.role} (${u.profile ? `${u.profile} ` : ""}${u.actualModel ?? "unknown"}): ${formatUsage(u.usage)}`,
              ),
              ...(st.usage.length > 1
                ? [
                    `usage     total: ${formatUsage(sumUsage(st.usage.map((u) => u.usage)) as TokenUsage)}`,
                  ]
                : []),
            ]
          : [`no run for issue #${issue}`];
        return ok(st, lines(human));
      }
      case "task run": {
        const r = taskRun({ cwd, reports: stepReports, pick: pickFlags(values) }, issue);
        const human = [
          `run       ${r.run.id} (${r.state}, round ${r.round})`,
          ...(r.status
            ? [`status    ${r.status.issue}: ${r.status.from ?? "unset"} → ${r.status.to}`]
            : []),
          ...(r.error ? [`error     ${r.error.code}: ${r.error.message} (${r.error.file})`] : []),
        ];
        return ok(r, lines(human));
      }
      case "task analyze": {
        const r = taskAnalyze({ cwd, reports: stepReports, pick: pickFlags(values) }, issue);
        const human = [
          `run       ${r.run.id} (${r.state})`,
          ...(r.status
            ? [`status    ${r.status.issue}: ${r.status.from ?? "unset"} → ${r.status.to}`]
            : []),
          ...(r.error ? [`error     ${r.error.code}: ${r.error.message} (${r.error.file})`] : []),
        ];
        return ok(r, lines(human));
      }
      case "task unblock": {
        const r = taskUnblock({ cwd, reports: stepReports, reason: values.reason }, issue);
        const human = [
          `run       ${r.run.id} (${r.state}, unblocked by ${r.by})`,
          ...(r.status
            ? [`status    ${r.status.issue}: ${r.status.from ?? "unset"} → ${r.status.to}`]
            : []),
        ];
        return ok(r, lines(human));
      }
      case "issue create":
        return githubOut(
          ok,
          issueCreate(values, bodyFile, () => repo(cwd).config),
        );
      case "issue depend":
        return githubOut(
          ok,
          issueDepend(issue, values.on, () => repo(cwd).config),
        );
      case "issue findings": {
        const r = issueFindings(repo(cwd).config, issue);
        return ok(r.data, r.human);
      }
      case "issue section get": {
        const r = issueSectionGet(repo(cwd).config, issue, section);
        return ok(r.data, r.human);
      }
      case "issue section set": {
        const text = bodyFile();
        const r = issueSectionSet(repo(cwd).config, issue, section, text);
        return ok(r.data, r.human);
      }
      case "pr create": {
        const body = values["body-file"] ? bodyFile() : undefined;
        const r = prCreate({ cwd, title: values.title, body }, issue);
        const human = [
          `pr        ${r.pr.url}${r.created ? "" : " (existing)"}`,
          ...r.checks.map(
            (c) => `${c.status.toUpperCase().padEnd(5)} ${c.name.padEnd(10)} ${c.detail}`,
          ),
          ...(r.status
            ? [`status    ${r.status.issue}: ${r.status.from ?? "unset"} → ${r.status.to}`]
            : []),
        ];
        return ok(r, lines(human));
      }
      case "task finalize": {
        const r = taskFinalize({ cwd, reports: stepReports, dryRun: values["dry-run"] }, issue);
        const human = [
          `run       ${r.run.id} (${r.run.state})`,
          ...(r.cleanup?.steps.map(
            (s) => `${s.status.toUpperCase().padEnd(7)} ${s.name.padEnd(22)} ${s.detail ?? ""}`,
          ) ?? []),
          ...r.status.map((c) => `status    ${c.issue}: ${c.from ?? "unset"} → ${c.to}`),
          ...(r.held ? [`held      ${r.held}`] : []),
        ];
        return ok(r, lines(human), r.cleanup?.state === "CLEANUP_FAILED" ? EXIT.failed : EXIT.ok);
      }
      case "handoff show": {
        const r = handoffShow(repo(cwd).config);
        return ok(r.data, r.human);
      }
      case "hook pre-tool-use":
      case "hook agent-pre-tool-use":
      case "hook session-start": {
        // Fail-open: a broken hook input or a failing lookup never blocks the session.
        let input: HookInput = {};
        try {
          input = JSON.parse(readFileSync(0, "utf8"));
        } catch {
          // no or bad stdin: empty input
        }
        if (command === "hook session-start") return ok(null, sessionStart(input, { cleanupScan }));
        let why: string | null = null;
        try {
          why = command === "hook agent-pre-tool-use" ? agentPreToolUse(input) : preToolUse(input);
        } catch {
          why = null;
        }
        return why
          ? {
              code: 2,
              stdout: "",
              stderr: `${why}
`,
            }
          : ok(null, "");
      }
      case "handoff post": {
        const text = bodyFile();
        const milestone = values.milestone === undefined ? undefined : issueArg(values.milestone);
        const r = handoffPost(repo(cwd).config, text, milestone);
        return ok(r.data, r.human);
      }
      case "cleanup scan": {
        const r = cleanupScan({ cwd });
        return ok(r, lines(humanScan(r)));
      }
      case "cleanup apply": {
        const r = cleanupApply({ cwd, safe: values.safe });
        const human = [
          ...r.outcomes.map(
            (o) =>
              `#${String(o.issue).padEnd(5)} ${o.error ? `FAIL ${o.error.code}: ${o.error.message}` : o.actions.join("; ")}`,
          ),
          ...(r.pruned ? ["git worktree prune"] : []),
          ...r.scan.orphans.map((p) => `orphan    ${p} (not owned: left alone)`),
        ];
        return ok(r, lines(human), r.outcomes.some((o) => o.error) ? EXIT.failed : EXIT.ok);
      }
      case "project plan":
      case "github project plan":
        return githubOut(ok, githubProjectPlan(repo(cwd).config));
      case "project apply":
      case "github project apply":
        return githubOut(ok, githubProjectApply(repo(cwd).config));
      case "github project validate": {
        const checks = projectValidate(repo(cwd).config);
        return ok({ checks }, humanChecks(checks), checksExit(checks));
      }
      case "workspace init": {
        const r = workspaceInit({ cwd, name: values.name, repo: values.repo });
        const human = [
          `workspace ${r.workspace}`,
          ...r.items.map((i) => `${i.result.padEnd(9)} ${i.path}`),
          "next      cd into the workspace, then `omi github project init` (skill omi-start)",
        ];
        return ok(r, lines(human));
      }
      case "workspace migrate": {
        const r = workspaceMigrate({ cwd, name: values.name, dryRun: values["dry-run"] });
        const human = [
          `workspace ${r.workspace}${r.dryRun ? " (dry run: nothing changed)" : ""}`,
          ...r.actions.map((a) => `${r.dryRun ? "would" : "done "}     ${a}`),
          ...r.remove.map((f) => `remove    ${f} (old layout: git rm it in a task PR)`),
          ...(r.dryRun ? [] : ["next      open Claude Code in the workspace; `omi doctor` there"]),
        ];
        return ok(r, lines(human));
      }
      case "github project init": {
        const r = projectInit({ cwd, title: values.title });
        const human = [
          `project   #${r.project.number} ${r.project.title}${r.project.created ? " (created)" : ""}`,
          `repo      ${r.owner}/${r.repo}${r.linked ? " (linked)" : ""}`,
          `config    ${r.config === "created" ? "created" : "kept"} ${CONFIG_FILE}`,
          ...r.templates.copied.map((f) => `template  ${f}`),
          ...(r.templates.kept.length
            ? [`template  ${r.templates.kept.length} kept (already present)`]
            : []),
          ...(r.issueTypes?.applied.map((a) => `issuetype ${a}`) ?? []),
          ...(r.issueTypes?.manual.map((m) => `manual    issue type ${m}`) ?? []),
          "next      github repo plan, github project apply (see skills/omi-start)",
        ];
        return ok(r, lines(human));
      }
      case "github repo plan":
        return githubOut(ok, githubRepoPlan(repo(cwd).config));
      case "github repo apply":
        return githubOut(
          ok,
          githubRepoApply(cwd, values["approved-plan"], () => repo(cwd).config),
        );
      case "github repo validate": {
        const checks = repoValidate(repo(cwd).config);
        return ok({ checks }, humanChecks(checks), checksExit(checks));
      }
      case "pr validate": {
        const r = prValidate({ cwd }, issue);
        return ok(r, `pr        ${r.pr ?? "none"}\n${humanChecks(r.checks)}`, checksExit(r.checks));
      }
      case "pr merge": {
        const r = prMerge({ cwd }, issue);
        const human = [
          `merged    ${r.receipt.url} (${r.receipt.headSha.slice(0, 12)} → ${r.receipt.mergeCommit?.slice(0, 12) ?? "?"})`,
        ];
        return ok(r, humanChecks(r.checks) + lines(human));
      }
      case "":
        throw new OmiError("USAGE_INVALID", "missing command (see `omi help`)");
      default:
        throw new OmiError("USAGE_INVALID", `unknown command: ${command} (see \`omi help\`)`);
    }
  } catch (e) {
    const err = e instanceof OmiError ? e : new OmiError("INTERNAL", "unexpected error");
    const code =
      err.code === "USAGE_INVALID" ? EXIT.usage : err.transient ? EXIT.transient : EXIT.failed;
    return json
      ? { code, stdout: envelope({ error: err.toJSON() }), stderr: "" }
      : { code, stdout: "", stderr: `omi: ${err.code}: ${err.message}\n` };
  }
}

const parse = (args: string[]) =>
  parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      output: { type: "string", default: "human" },
      help: { type: "boolean", short: "h" },
      title: { type: "string" },
      "body-file": { type: "string" },
      "dry-run": { type: "boolean" },
      safe: { type: "boolean" },
      reason: { type: "string" },
      profile: { type: "string" },
      skills: { type: "string", multiple: true },
      model: { type: "string" },
      effort: { type: "string" },
      type: { type: "string" },
      parent: { type: "string" },
      on: { type: "string" },
      "approved-plan": { type: "string" },
      milestone: { type: "string" },
      name: { type: "string" },
      repo: { type: "string" },
      contract: { type: "string" },
      scope: { type: "string", multiple: true },
      role: { type: "string" },
      remove: { type: "boolean" },
      bundled: { type: "boolean" },
      probe: { type: "boolean" },
      "if-match": { type: "string" },
      "confirm-commands": { type: "boolean" },
      harness: { type: "string" },
      auth: { type: "string" },
      "token-env": { type: "string" },
      "key-env": { type: "string" },
      "base-url": { type: "string" },
      scheme: { type: "string" },
      models: { type: "string" },
      efforts: { type: "string" },
      disabled: { type: "boolean" },
      enabled: { type: "boolean" },
      "token-stdin": { type: "boolean" },
    },
  });
