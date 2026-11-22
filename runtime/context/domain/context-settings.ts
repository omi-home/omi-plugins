// `omi context apply` (DevTask-0067 #202), pure part: turn unneeded `/context` items into the
// project settings Spike-0010 verified, merge them into the workspace `.claude/settings.json`
// and record what OMI added, so a re-run changes nothing and `--remove` takes back only that.
import { z } from "zod";
import { type ContextUsage, parseContract } from "../../shared/contracts.ts";

/** Entries OMI added to the workspace settings (stored next to the state, never in settings). */
export const AppliedContext = z.strictObject({
  enabledPlugins: z.array(z.string().min(1)).default([]),
  skillOverrides: z.array(z.string().min(1)).default([]),
  deniedMcpServers: z.array(z.string().min(1)).default([]),
  disableClaudeAiConnectors: z.boolean().default(false),
  disableBundledSkills: z.boolean().default(false),
});
export type AppliedContext = z.infer<typeof AppliedContext>;
export const NOTHING_APPLIED: AppliedContext = AppliedContext.parse({});

/** The settings keys OMI touches, typed; every other key passes through untouched. */
const Settings = z.looseObject({
  enabledPlugins: z.record(z.string(), z.unknown()).optional(),
  skillOverrides: z.record(z.string(), z.unknown()).optional(),
  deniedMcpServers: z.array(z.unknown()).optional(),
  disableClaudeAiConnectors: z.unknown().optional(),
  disableBundledSkills: z.unknown().optional(),
});
export type Settings = z.infer<typeof Settings>;
/** Validated, but the input itself is returned: zod output reorders keys, a rewrite must not. */
export function parseSettings(input: unknown, name: string): Settings {
  parseContract(Settings, input, name, "CONFIG_INVALID");
  return input as Settings;
}

/** claude.ai connectors appear in `/context` as servers named `claude_ai_<Name>`. */
const CLAUDE_AI = /^claude_ai_/;

/**
 * Desired entries for the unneeded items. A plugin is switched off under every id of that name
 * the user enables plus `<name>@synced` (the claude.ai copy loads in its place otherwise).
 * `disableBundledSkills` only when the PO agreed (`--bundled`).
 */
export function desiredContext(o: {
  unneeded: ContextUsage["items"];
  userPluginIds: string[];
  bundled: boolean;
}): AppliedContext {
  const names = (kind: string) => o.unneeded.filter((i) => i.kind === kind).map((i) => i.id);
  const plugins = names("plugin");
  const mcp = names("mcp");
  return {
    enabledPlugins: [
      ...new Set(
        plugins.flatMap((p) => [
          ...o.userPluginIds.filter((id) => id.split("@")[0] === p),
          `${p}@synced`,
        ]),
      ),
    ].sort(),
    skillOverrides: [...new Set(names("skill"))].sort(),
    deniedMcpServers: [...new Set(mcp.filter((s) => !CLAUDE_AI.test(s)))].sort(),
    disableClaudeAiConnectors: mcp.some((s) => CLAUDE_AI.test(s)),
    disableBundledSkills: o.bundled,
  };
}

const serverName = (e: unknown) =>
  typeof e === "object" && e !== null ? (e as { serverName?: unknown }).serverName : undefined;

/** Takes back what OMI added, where the value is still the one OMI wrote. */
export function removeContext(settings: Settings, applied: AppliedContext): Settings {
  const out: Settings = structuredClone(settings);
  const drop = (key: "enabledPlugins" | "skillOverrides", ids: string[], v: unknown) => {
    const m = out[key];
    if (!m) return;
    for (const id of ids) if (m[id] === v) delete m[id];
    if (!Object.keys(m).length) delete out[key]; // OMI emptied it
  };
  drop("enabledPlugins", applied.enabledPlugins, false);
  drop("skillOverrides", applied.skillOverrides, "off");
  if (out.deniedMcpServers && applied.deniedMcpServers.length) {
    out.deniedMcpServers = out.deniedMcpServers.filter(
      (e) => !applied.deniedMcpServers.includes(String(serverName(e))),
    );
    if (!out.deniedMcpServers.length) delete out.deniedMcpServers;
  }
  if (applied.disableClaudeAiConnectors && out.disableClaudeAiConnectors === true) {
    delete out.disableClaudeAiConnectors;
  }
  if (applied.disableBundledSkills && out.disableBundledSkills === true) {
    delete out.disableBundledSkills;
  }
  return out;
}

/**
 * Adds the desired entries the settings do not already hold. Only what OMI really added goes in
 * the record: a key the PO set (to any value) stays theirs.
 */
export function addContext(
  settings: Settings,
  want: AppliedContext,
): { settings: Settings; applied: AppliedContext } {
  const s = structuredClone(settings);
  const applied: AppliedContext = structuredClone(NOTHING_APPLIED);
  const plugins = { ...s.enabledPlugins };
  for (const id of want.enabledPlugins) {
    if (!(id in plugins)) {
      plugins[id] = false;
      applied.enabledPlugins.push(id);
    }
  }
  const skills = { ...s.skillOverrides };
  for (const k of want.skillOverrides) {
    if (!(k in skills)) {
      skills[k] = "off";
      applied.skillOverrides.push(k);
    }
  }
  const denied = [...(s.deniedMcpServers ?? [])];
  for (const name of want.deniedMcpServers) {
    if (!denied.some((e) => serverName(e) === name)) {
      denied.push({ serverName: name });
      applied.deniedMcpServers.push(name);
    }
  }
  const out: Settings = { ...s };
  if (applied.enabledPlugins.length) out.enabledPlugins = plugins;
  if (applied.skillOverrides.length) out.skillOverrides = skills;
  if (applied.deniedMcpServers.length) out.deniedMcpServers = denied;
  if (want.disableClaudeAiConnectors && s.disableClaudeAiConnectors === undefined) {
    out.disableClaudeAiConnectors = true;
    applied.disableClaudeAiConnectors = true;
  }
  if (want.disableBundledSkills && s.disableBundledSkills === undefined) {
    out.disableBundledSkills = true;
    applied.disableBundledSkills = true;
  }
  return { settings: out, applied };
}

/** `+ path = value` / `- path = value` lines between two settings objects (OMI keys only). */
export function settingsDiff(before: Settings, after: Settings): string[] {
  const flat = (s: Settings) => {
    const m = new Map<string, string>();
    for (const [k, v] of Object.entries(s.enabledPlugins ?? {}))
      m.set(`enabledPlugins.${k}`, JSON.stringify(v));
    for (const [k, v] of Object.entries(s.skillOverrides ?? {}))
      m.set(`skillOverrides.${k}`, JSON.stringify(v));
    for (const e of s.deniedMcpServers ?? [])
      m.set(`deniedMcpServers[${String(serverName(e))}]`, JSON.stringify(e));
    for (const k of ["disableClaudeAiConnectors", "disableBundledSkills"] as const) {
      if (s[k] !== undefined) m.set(k, JSON.stringify(s[k]));
    }
    return m;
  };
  const [a, b] = [flat(before), flat(after)];
  return [
    ...[...a].filter(([k, v]) => b.get(k) !== v).map(([k, v]) => `- ${k} = ${v}`),
    ...[...b].filter(([k, v]) => a.get(k) !== v).map(([k, v]) => `+ ${k} = ${v}`),
  ];
}
