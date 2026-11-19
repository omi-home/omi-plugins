// `/context` of `claude -p` (DevTask-0066 #201): parse its markdown tables into typed items and
// classify each as needed / unneeded / unknown for OMI. Pure: measuring is runtime/cli/context.ts.
import { isAbsolute, relative } from "node:path";
import {
  type ContextClass,
  type ContextItemKind,
  ContextUsage,
  parseContract,
} from "./contracts.ts";

/** `7.1k`, `~170`, `661`, `1m` → tokens. */
export function tokenCount(s: string): number {
  const m = /^~?\s*([\d.]+)\s*([km]?)$/i.exec(s.trim());
  if (!m) return 0;
  const n =
    Number(m[1]) * (m[2]?.toLowerCase() === "k" ? 1e3 : m[2]?.toLowerCase() === "m" ? 1e6 : 1);
  return Math.round(n);
}

/** Data rows of the table under `### <heading>` (header and separator rows skipped). */
function table(text: string, heading: string): string[][] {
  const start = text.search(new RegExp(`^###\\s+${heading}\\s*$`, "im"));
  if (start < 0) return [];
  const rows: string[][] = [];
  for (const line of text.slice(start).split(/\r?\n/).slice(1)) {
    if (/^###?\s/.test(line)) break;
    if (!line.startsWith("|")) continue;
    rows.push(
      line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  }
  return rows.slice(2);
}

/** Sums tokens per (kind, id): MCP tools roll up to their server, plugin skills/agents to the plugin. */
export function parseContext(text: string): ContextUsage {
  const total = tokenCount(/\*\*Tokens:\*\*\s*([\d.~]+[km]?)/i.exec(text)?.[1] ?? "");
  const items = new Map<
    string,
    { kind: ContextItemKind; id: string; source: string; tokens: number }
  >();
  const add = (kind: ContextItemKind, id: string, source: string, t: string) => {
    const key = `${kind}\0${id}`;
    const item = items.get(key) ?? { kind, id, source, tokens: 0 };
    item.tokens += tokenCount(t);
    items.set(key, item);
  };
  for (const [, server = "", t = ""] of table(text, "MCP Tools")) add("mcp", server, "MCP", t);
  for (const [type = "", path = "", t = ""] of table(text, "Memory Files"))
    add("memory", path, type, t);
  for (const [name = "", source = "", t = ""] of table(text, "Skills")) {
    const plugin = /^Plugin \((.+)\)$/.exec(source)?.[1];
    if (plugin) add("plugin", plugin, "Plugin", t);
    else add("skill", name, source, t);
  }
  for (const [name = "", source = "", t = ""] of table(text, "Custom Agents")) {
    if (source === "Plugin" && name.includes(":"))
      add("plugin", name.split(":")[0] as string, "Plugin", t);
    else add("agent", name, source, t);
  }
  return parseContract(
    ContextUsage,
    {
      total,
      categories: table(text, "Estimated usage by category").map(([name = "", t = ""]) => ({
        name,
        tokens: tokenCount(t),
      })),
      items: [...items.values()],
    },
    "/context output",
  );
}

const inside = (path: string, root: string) => {
  const rel = relative(root, path);
  return !rel.startsWith("..") && !isAbsolute(rel);
};

/**
 * Kept by the PO (`context.keep`) or OMI's own (plugins `omi-*`, memory files and project skills
 * of the workspace) → needed. User-level skills, other plugins and MCP servers → unneeded. Memory
 * files outside the workspace, agents and other skill sources → unknown (the PO decides).
 */
export function classify(
  item: ContextUsage["items"][number],
  o: { keep: readonly string[]; workspace: string },
): ContextClass {
  if (o.keep.includes(item.id)) return "needed";
  switch (item.kind) {
    case "plugin":
      return item.id.startsWith("omi-") ? "needed" : "unneeded";
    case "mcp":
      return "unneeded";
    case "memory":
      return inside(item.id, o.workspace) ? "needed" : "unknown";
    case "skill":
      return item.source === "Project" ? "needed" : item.source === "User" ? "unneeded" : "unknown";
    case "agent":
      return "unknown";
  }
}
