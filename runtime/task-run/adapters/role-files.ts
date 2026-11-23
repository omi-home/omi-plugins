// Role files of a task workspace (ADR-0002 D2, ADR-0003 D4/D5): before each agent run OMI writes,
// next to the clone, `AGENTS.md`, `REPORT.md` (the step report template), `.claude/settings.json`
// and `.claude/skills/` (only the skills chosen for this step). AGENTS.md holds only rules, the fixed
// part first for cache hits (DevTask-0064 #198): agents-md/core.md, editing.md or read-only.md, the
// repository line, agents-md/<role>.md. Generated every time: never edit them by hand.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_PACK } from "../../harness/domain/harness.ts";
import { READ_ONLY_ROLES, type ReportCategory, Role } from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { PLUGIN_ROOT } from "../../shared/plugin-paths.ts";
import { EDITOR_NPM_SCRIPTS } from "../domain/permissions.ts";
import type { SkillChoice } from "../domain/run.ts";

/** Skill the Coordinator always adds on rework for roles that change files (Spike-0011 §4). */
export const REWORK_SKILL = "receiving-review-findings";
/** Steps whose job needs one skill outside the role's defaults (the review escalation). */
const STEP_SKILL: Record<string, string> = { architect: "root-cause-analysis" };

export type { SkillChoice };

const csv = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** `<!-- omi:skills: … default: a, b … allowed: c -->` of agents/<role>.md. */
export function roleSkills(
  pluginRoot: string,
  role: Role,
): { default: string[]; allowed: string[] } {
  const agent = readFileSync(join(pluginRoot, AGENT_PACK, "agents", `${role}.md`), "utf8");
  const block = /<!-- omi:skills:[^\n]*\n([\s\S]*?)-->/.exec(agent.replaceAll("\r\n", "\n"))?.[1];
  const line = (key: string) =>
    block ? new RegExp(`^${key}:(.*)$`, "m").exec(block)?.[1] : undefined;
  const [d, a] = [line("default"), line("allowed")];
  if (d === undefined || a === undefined) {
    throw new OmiError(
      "CONFIG_INVALID",
      `agents/${role}.md has no omi:skills default/allowed block`,
    );
  }
  return { default: csv(d), allowed: csv(a) };
}

/**
 * `--skills <role>=<a>,<b>` (repeatable) checked against each role's set; `--reason` is required.
 * A skill outside the role's default + allowed set is refused before anything starts.
 */
export function parseSkillChoice(
  pluginRoot: string,
  flags: string[] | undefined,
  reason: string | undefined,
): SkillChoice | undefined {
  if (!flags?.length) return undefined;
  const byRole: SkillChoice["byRole"] = {};
  for (const flag of flags) {
    const [name = "", list = ""] = flag.split("=", 2);
    const role = Role.safeParse(name.trim());
    if (!role.success || !flag.includes("=")) {
      throw new OmiError("USAGE_INVALID", `--skills takes <role>=<skill>,<skill>: ${name.trim()}`);
    }
    const set = roleSkills(pluginRoot, role.data);
    for (const s of csv(list)) {
      if (![...set.default, ...set.allowed].includes(s)) {
        throw new OmiError(
          "USAGE_INVALID",
          `skill ${s} is not in the set of ${role.data}: see \`omi skill list\``,
        );
      }
    }
    byRole[role.data] = [...new Set([...(byRole[role.data] ?? []), ...csv(list)])];
  }
  const why = reason?.trim();
  if (!why) throw new OmiError("USAGE_INVALID", "--reason is required with --skills");
  return { byRole, reason: why };
}

/** Skills of one step: role defaults, the Coordinator's choice, rework and step skills. */
export function stepSkills(
  pluginRoot: string,
  step: { role: Role; stepId: string; round: number },
  choice?: SkillChoice,
): string[] {
  const set = roleSkills(pluginRoot, step.role);
  const auto = [
    ...(step.round >= 2 && !READ_ONLY_ROLES.includes(step.role) ? [REWORK_SKILL] : []),
    ...(STEP_SKILL[step.stepId] ? [STEP_SKILL[step.stepId] as string] : []),
  ].filter((s) => set.allowed.includes(s));
  return [...new Set([...set.default, ...(choice?.byRole[step.role] ?? []), ...auto])];
}

export function writeRoleFiles(o: {
  taskRoot: string;
  pluginRoot: string;
  role: Role;
  category: ReportCategory;
  /** Implementing roles may edit files in the clone. */
  edits: boolean;
  /** The clone as the agent addresses it from the task workspace (e.g. `omi-plugins`). */
  repo: string;
  /** Skills installed for this run; default: the role's defaults. */
  skills?: string[];
  /** Check commands this role may run (the repo's configured `checks`); none for read-only roles. */
  checks?: string[];
}): void {
  const part = (name: string) =>
    readFileSync(join(o.pluginRoot, AGENT_PACK, "agents-md", `${name}.md`), "utf8").trim();
  // Must name exactly what prepareAgent grants: an instruction outside allowedTools blocks the step (#252).
  const checks = o.checks ?? [];
  const checkLine = checks.length
    ? ` The repository's check commands are ${checks.map((c) => `\`cd ${o.repo} && ${c}\``).join(", ")}; each may take extra arguments (e.g. one test file). Run each check as its own command: no \`;\`, no pipes, no chaining. Once a \`cd ${o.repo} && …\` has run, the shell stays inside the repository, so run the bare check (e.g. \`${checks[0]}\`) and never \`cd ${o.repo}\` again. No other command is permitted.`
    : "";
  const editLine = o.edits
    ? ` You may also run \`git mv\` (as \`git -C ${o.repo} mv\`) and the repository's npm scripts ${EDITOR_NPM_SCRIPTS.map((s) => `\`npm run ${s}\``).join(", ")}, each with or without arguments.`
    : "";
  // Hook rule (agentPreToolUse): a git argument cannot leave the workspace. Said once, to every role.
  const readLine = ` Read files with the Read, Grep and Glob tools; there are no shell read commands. Git runs only on paths inside this workspace: an argument with a \`..\` path component, an absolute path, a leading \`~\`, shell characters (\`$\`, backtick, \`{ }\`, \`*\`, \`?\`, \`[\`, \`<\`, \`>\`, and \`\\\` in Bash), \`--no-index\`, \`-c\`, \`--git-dir\`, \`--work-tree\` or \`-C\` with another directory makes the hook refuse the command.`;
  const repoLine = `The product repository is \`${o.repo}/\`. Your shell starts in this workspace: run git as \`git -C ${o.repo} <command>\` (never \`cd\` before git: it is refused). ${checks.length ? `Once a check's \`cd ${o.repo} && …\` has run, the shell stays inside the repository: run read-only git bare there (\`git status\`, \`git diff\`, \`git log\`, \`git show\`), not \`git -C ${o.repo}\`.` : ""}${checkLine}${editLine}${readLine} Paths in your result are relative to the repository (\`src/x.ts\`, not \`${o.repo}/src/x.ts\`).`;
  const sections = [part("core"), part(o.edits ? "editing" : "read-only"), repoLine, part(o.role)];
  mkdirSync(join(o.taskRoot, ".claude"), { recursive: true });
  writeFileSync(
    join(o.taskRoot, "AGENTS.md"),
    `<!-- Generated by OMI; rewritten before every run. -->\n${sections.join("\n\n")}\n`,
  );
  writeFileSync(
    join(o.taskRoot, "REPORT.md"),
    readFileSync(join(o.pluginRoot, "templates", "reports", `${o.category}.md`)),
  );
  writeFileSync(
    join(o.taskRoot, ".claude", "settings.json"),
    // OMI_REPO: the one directory the agent hook lets `git -C` name (agentPreToolUse).
    `${JSON.stringify({ permissions: { defaultMode: o.edits ? "acceptEdits" : "default" }, env: { OMI_REPO: o.repo } }, null, 2)}\n`,
  );
  // Only the chosen skills: a skill dropped since the last run is gone (re-runs are safe).
  const skillsDir = join(o.taskRoot, ".claude", "skills");
  rmSync(skillsDir, { recursive: true, force: true });
  for (const s of o.skills ?? roleSkills(o.pluginRoot, o.role).default) {
    cpSync(join(o.pluginRoot, AGENT_PACK, "skill-library", s), join(skillsDir, s), {
      recursive: true,
    });
  }
}

/** `omi skill list`: each role's sets and every library skill's description (#199). */
export function skillList(roles: readonly Role[], pluginRoot = PLUGIN_ROOT) {
  const library = join(pluginRoot, AGENT_PACK, "skill-library");
  return {
    roles: roles.map((role) => ({ role, ...roleSkills(pluginRoot, role) })),
    skills: readdirSync(library)
      .sort()
      .map((name) => {
        const text = readFileSync(join(library, name, "SKILL.md"), "utf8");
        return { name, description: /^description: (.*)$/m.exec(text)?.[1]?.trim() ?? "" };
      }),
  };
}
