// Where the plugin's own files live (ADR-0006). The only place that resolves a path from the location
// of this source file: every module reads config/, templates/ and schemas/ through these constants,
// so moving a module never breaks an asset path.
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute plugin root (holds bin/, config/, templates/, schemas/, agent-pack/, skills/), no trailing separator. */
export const PLUGIN_ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, "");

/** Default policies and GitHub models read by the runtime. */
export const CONFIG_DIR = join(PLUGIN_ROOT, "config");
/** Templates rendered or copied by the runtime. */
export const TEMPLATES_DIR = join(PLUGIN_ROOT, "templates");
/** JSON schemas published for other repositories (omi-monitor). */
export const SCHEMAS_DIR = join(PLUGIN_ROOT, "schemas");
