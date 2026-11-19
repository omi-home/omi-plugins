// `omi context plan` (DevTask-0066 #201, read-only): measures the context a session starts with —
// in the workspace (Coordinator) and in a task workspace of each role (agent) — through
// `/context` of `claude -p` (local command, no model call, no tokens) and classifies each item.
// System tools and the like have no switch: they are reported only. `apply` is DevTask-0067 #202.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_PACK, agentEnv, PLUGIN_NAME } from "../adapters/claude/launch.ts";
import { loadConfig } from "../core/config.ts";
import { classify, parseContext } from "../core/context-usage.ts";
import { type ContextClass, type ContextUsage, Role } from "../core/contracts.ts";
import { OmiError } from "../core/errors/errors.ts";
import { locate } from "../core/workspace.ts";
import { writeRoleFiles } from "../resources/role-files.ts";

const PLUGIN_ROOT = fileURLToPath(new URL("../../", import.meta.url));

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
