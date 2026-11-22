// `omi context plan` (DevTask-0066 #201, read-only): measures the context a session starts with —
// in the workspace (Coordinator) and in a task workspace of each role (agent) — through
// `/context` of `claude -p` (local command, no model call, no tokens) and classifies each item.
// System tools and the like have no switch: they are reported only. `apply` is DevTask-0067 #202.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_PACK, agentEnv, PLUGIN_NAME } from "../../adapters/claude/launch.ts";
import { SETTINGS } from "../../cli/workspace.ts";
import { locate, WORKSPACE_DIR } from "../../core/workspace.ts";
import { writeRoleFiles } from "../../resources/role-files.ts";
import { loadConfig } from "../../shared/config.ts";
import {
  type ContextClass,
  type ContextUsage,
  parseContract,
  Role,
} from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { PLUGIN_ROOT } from "../../shared/plugin-paths.ts";
import {
  AppliedContext,
  addContext,
  desiredContext,
  NOTHING_APPLIED,
  parseSettings,
  removeContext,
  type Settings,
  settingsDiff,
} from "../domain/context-settings.ts";
import { classify, parseContext } from "../domain/context-usage.ts";

/** Runs `claude <args>` in cwd with `/context` on stdin (a Git Bash argument would be rewritten). */
export type ContextRunner = (o: {
  cwd: string;
  args: string[];
  env?: Record<string, string>;
}) => string;

export const spawnContext: ContextRunner = (o) => {
  const r = spawnSync("claude", o.args, {
    cwd: o.cwd,
    input: "/context",
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    ...(o.env ? { env: o.env } : {}),
  });
  if (r.status !== 0) {
    throw new OmiError("INTERNAL", "could not run `claude -p /context`", {
      exitCode: r.status,
    });
  }
  return r.stdout ?? "";
};

export interface ContextTarget {
  /** `workspace` or the role of a task workspace. */
  target: string;
  total: number;
  categories: ContextUsage["categories"];
  items: (ContextUsage["items"][number] & { class: ContextClass })[];
}

/** The workspace session as the Coordinator starts it (host config, workspace settings). */
export function measureWorkspace(o: {
  workspace: string;
  keep: readonly string[];
  run?: ContextRunner;
}): ContextTarget {
  const usage = parseContext((o.run ?? spawnContext)({ cwd: o.workspace, args: ["-p"] }));
  return target("workspace", usage, o.keep, o.workspace);
}

/** An agent run of `role`: same launch as `omi task run` (fresh config dir, allowlisted env). */
export function measureRole(o: {
  role: Role;
  keep: readonly string[];
  run?: ContextRunner;
  pluginRoot?: string;
  hostEnv?: NodeJS.ProcessEnv;
}): ContextTarget {
  const pluginRoot = o.pluginRoot ?? PLUGIN_ROOT;
  const root = mkdtempSync(join(tmpdir(), "omi-context-"));
  try {
    writeRoleFiles({
      taskRoot: root,
      pluginRoot,
      role: o.role,
      category: "implementation",
      edits: false,
      repo: "repo",
    });
    const stdout = (o.run ?? spawnContext)({
      cwd: root,
      args: [
        "-p",
        "--agent",
        `${PLUGIN_NAME}:${o.role}`,
        "--plugin-dir",
        join(pluginRoot, AGENT_PACK),
        "--setting-sources",
        "project,local",
      ],
      env: { ...agentEnv(o.hostEnv ?? process.env), CLAUDE_CONFIG_DIR: join(root, ".claude-home") },
    });
    return target(o.role, parseContext(stdout), o.keep, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const target = (
  name: string,
  usage: ContextUsage,
  keep: readonly string[],
  workspace: string,
): ContextTarget => ({
  target: name,
  total: usage.total,
  categories: usage.categories,
  items: usage.items.map((i) => ({ ...i, class: classify(i, { keep, workspace }) })),
});

/** Categories no project setting can switch off. */
const FIXED = ["System prompt", "System tools"];

export interface ContextPlan {
  keep: string[];
  targets: ContextTarget[];
}

export function contextPlan(deps: {
  cwd: string;
  role?: string;
  run?: ContextRunner;
  pluginRoot?: string;
}): ContextPlan {
  const loc = locate(deps.cwd);
  const { keep } = loadConfig(loc.workspace).context;
  const roles = deps.role === undefined ? Role.options : [Role.parse(deps.role)];
  return {
    keep,
    targets: [
      measureWorkspace({ workspace: loc.workspace, keep, run: deps.run }),
      ...roles.map((role) =>
        measureRole({ role, keep, run: deps.run, pluginRoot: deps.pluginRoot }),
      ),
    ],
  };
}

/** Human lines: per target the total, then switchable items by class, then fixed categories. */
export function humanContextPlan(p: ContextPlan): string[] {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const order: ContextClass[] = ["unneeded", "unknown", "needed"];
  return p.targets.flatMap((t) => {
    const unneeded = t.items
      .filter((i) => i.class === "unneeded")
      .reduce((n, i) => n + i.tokens, 0);
    return [
      `${t.target.padEnd(24)} ${k(t.total)} tokens at start${unneeded ? ` (${k(unneeded)} in unneeded items)` : ""}`,
      ...[...t.items]
        .sort((a, b) => order.indexOf(a.class) - order.indexOf(b.class) || b.tokens - a.tokens)
        .map((i) => `  ${i.class.padEnd(9)} ${i.kind.padEnd(7)} ${i.id} ${k(i.tokens)}`),
      ...t.categories
        .filter((c) => FIXED.includes(c.name))
        .map((c) => `  ${"fixed".padEnd(9)} ${c.name} ${k(c.tokens)} (no switch: reported only)`),
    ];
  });
}

/** What OMI added to the workspace settings, next to the state (never inside settings.json). */
export const APPLIED_FILE = "context-apply.json";

const readJson = (file: string): unknown => {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new OmiError("CONFIG_INVALID", `${file}: invalid JSON`);
  }
};

/** Plugin ids the user enables (read only: OMI never writes ~/.claude). */
export function userPluginIds(configDir: string): string[] {
  const data = readJson(join(configDir, "settings.json"));
  if (data === undefined) return [];
  return Object.keys(parseSettings(data, "user settings").enabledPlugins ?? {});
}

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])].sort();

export interface ContextApplyResult {
  settingsPath: string;
  /** `+`/`-` lines of the OMI-managed keys. */
  diff: string[];
  changed: boolean;
  dryRun: boolean;
  removed: boolean;
}

/**
 * `omi context apply [--dry-run] [--remove] [--bundled]`: switch the workspace's unneeded items off
 * in its `.claude/settings.json` only. Items OMI switched off earlier no longer show in `/context`,
 * so the wanted set is the earlier record plus the new plan, minus `context.keep`: a re-run changes
 * nothing. `--remove` takes back exactly what OMI added; other keys are never touched.
 */
export function contextApply(deps: {
  cwd: string;
  dryRun?: boolean;
  remove?: boolean;
  /** PO agreed to `disableBundledSkills`. */
  bundled?: boolean;
  run?: ContextRunner;
  userConfigDir?: string;
}): ContextApplyResult {
  const loc = locate(deps.cwd);
  const settingsPath = join(loc.workspace, SETTINGS);
  const recordPath = join(loc.workspace, WORKSPACE_DIR, APPLIED_FILE);
  const raw = readJson(settingsPath);
  const settings = raw === undefined ? {} : parseSettings(raw, SETTINGS);
  const record = (() => {
    const r = readJson(recordPath);
    return r === undefined ? NOTHING_APPLIED : parseContract(AppliedContext, r, APPLIED_FILE);
  })();
  const base = removeContext(settings, record);
  let next: Settings = base;
  let applied: AppliedContext | null = null;
  if (!deps.remove) {
    const { keep } = loadConfig(loc.workspace).context;
    const plan = measureWorkspace({ workspace: loc.workspace, keep, run: deps.run });
    const fresh = desiredContext({
      unneeded: plan.items.filter((i) => i.class === "unneeded"),
      userPluginIds: userPluginIds(
        deps.userConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
      ),
      bundled: Boolean(deps.bundled),
    });
    const kept = (id: string) => keep.includes(id) || keep.includes(id.split("@")[0] as string);
    const want: AppliedContext = {
      enabledPlugins: union(record.enabledPlugins, fresh.enabledPlugins).filter((i) => !kept(i)),
      skillOverrides: union(record.skillOverrides, fresh.skillOverrides).filter((i) => !kept(i)),
      deniedMcpServers: union(record.deniedMcpServers, fresh.deniedMcpServers).filter(
        (i) => !kept(i),
      ),
      disableClaudeAiConnectors:
        (record.disableClaudeAiConnectors || fresh.disableClaudeAiConnectors) &&
        !keep.some((k) => k.startsWith("claude_ai_")),
      disableBundledSkills: Boolean(deps.bundled) || record.disableBundledSkills,
    };
    ({ settings: next, applied } = addContext(base, want));
  }
  const diff = settingsDiff(settings, next);
  const changed = JSON.stringify(settings) !== JSON.stringify(next);
  if (!deps.dryRun) {
    if (changed) writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
    if (applied) writeFileSync(recordPath, `${JSON.stringify(applied, null, 2)}\n`);
    else rmSync(recordPath, { force: true });
  }
  return {
    settingsPath,
    diff,
    changed,
    dryRun: Boolean(deps.dryRun),
    removed: Boolean(deps.remove),
  };
}
