// Generates schemas/monitor/*.schema.json from the zod contracts (committed; a test fails on drift).
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MONITOR_SCHEMAS, renderSchema } from "./protocol.ts";

export const SCHEMA_DIR = fileURLToPath(new URL("../../schemas/monitor/", import.meta.url));
export const schemaFile = (name: string) => `${SCHEMA_DIR}${name}.schema.json`;

export function writeSchemas() {
  mkdirSync(SCHEMA_DIR, { recursive: true });
  for (const name of Object.keys(MONITOR_SCHEMAS))
    writeFileSync(schemaFile(name), renderSchema(name));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) writeSchemas();
