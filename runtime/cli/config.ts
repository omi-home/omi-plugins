// `omi config get|set`: validated, comment-preserving edits of <workspace>/.omi-plugins/omi.config.yaml
// (ADR-0004; omi-monitor's settings form). A rejected edit leaves the file untouched.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMap, parseDocument } from "yaml";
import { type OmiConfig, parseConfig } from "../core/config.ts";
import { parseContract } from "../core/contracts.ts";
import { OmiError } from "../core/errors/errors.ts";
import { CONFIG_FILE } from "../core/workspace.ts";
import { ConfigSetInput } from "../monitor/protocol.ts";

/** Top-level keys whose values are shell commands OMI runs: changing them needs `--confirm-commands`. */
const COMMAND_KEYS = new Set(["checks", "setup"]);

export const etagOf = (text: string) => createHash("sha256").update(text).digest("hex");

const readFile = (workspace: string) => {
  try {
    return readFileSync(join(workspace, CONFIG_FILE), "utf8");
  } catch {
    throw new OmiError("CONFIG_INVALID", `${CONFIG_FILE} not found`);
  }
};

const load = (text: string) => {
  const doc = parseDocument(text);
  if (doc.errors.length) {
    throw new OmiError("CONFIG_INVALID", `${CONFIG_FILE}: invalid YAML`, {
      line: doc.errors[0]?.linePos?.[0]?.line,
    });
  }
  return doc;
};

const isPlain = (v: unknown) => v === null || typeof v !== "object";

const segments = (path: string) => {
  const parts = path.split(".");
  if (parts.some((p) => !p || p === "__proto__" || p === "constructor" || p === "prototype")) {
    throw new OmiError("USAGE_INVALID", "invalid config path");
  }
  return parts;
};

/** The effective (validated, defaults applied) config, or one value of it. */
export function configGet(workspace: string, path?: string) {
  const text = readFile(workspace);
  const config = parseConfig(load(text).toJS());
  let value: unknown = config;
  if (path !== undefined) {
    for (const key of segments(path)) {
      if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) {
        throw new OmiError("USAGE_INVALID", `no config value at ${path}`);
      }
      value = (value as Record<string, unknown>)[key];
    }
  }
  return { path: path ?? null, value, etag: etagOf(text) };
}

export interface ConfigSetOptions {
  /** Raw JSON text of a ConfigSetInput. */
  input: string;
  ifMatch?: string;
  confirmCommands?: boolean;
}

export function configSet(workspace: string, o: ConfigSetOptions) {
  let raw: unknown;
  try {
    raw = JSON.parse(o.input.replace(/^﻿/, ""));
  } catch {
    throw new OmiError("USAGE_INVALID", "config set input is not valid JSON");
  }
  const input = parseContract(ConfigSetInput, raw, "config set input", "CONFIG_INVALID");

  const file = join(workspace, CONFIG_FILE);
  const text = readFile(workspace);
  if (o.ifMatch !== undefined && o.ifMatch !== etagOf(text)) {
    throw new OmiError(
      "CONFIG_CONFLICT",
      `${CONFIG_FILE} changed since it was read: read it again`,
    );
  }
  const doc = load(text);
  if (!isMap(doc.contents)) {
    throw new OmiError("CONFIG_INVALID", `${CONFIG_FILE} has no settings yet`);
  }
  const touched = new Set<string>();
  for (const change of input.changes) {
    const path = segments(change.path);
    touched.add(path[0] as string);
    if ("unset" in change) doc.deleteIn(path);
    // A plain scalar overwrites the old node's value in place, so its comments survive.
    else doc.setIn(path, isPlain(change.value) ? change.value : doc.createNode(change.value));
  }

  // Validate the result as a whole; the file is only written when it parses.
  const config: OmiConfig = parseConfig(doc.toJS());
  if (!o.confirmCommands && [...touched].some((k) => COMMAND_KEYS.has(k))) {
    throw new OmiError(
      "POLICY_VIOLATION",
      "checks and setup are shell commands OMI runs: pass --confirm-commands to change them",
    );
  }

  const next = doc.toString();
  if (next === text) return { changed: false, etag: etagOf(text), config };
  // Atomic: temp file in the same directory, then rename; re-check the etag just before it.
  if (o.ifMatch !== undefined && etagOf(readFile(workspace)) !== o.ifMatch) {
    throw new OmiError("CONFIG_CONFLICT", `${CONFIG_FILE} changed while it was edited`);
  }
  const tmp = join(
    dirname(file),
    `.omi.config.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(tmp, next, { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    rmSync(tmp, { force: true });
    throw new OmiError("INTERNAL", `cannot write ${CONFIG_FILE}`);
  }
  return { changed: true, etag: etagOf(next), config };
}
