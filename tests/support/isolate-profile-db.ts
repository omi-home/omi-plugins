// Loaded with `node --import` by the `test` script: no test may touch the real machine profile DB
// (Feature-0044 #337). Every test process (one per test file) gets its own temp DB, so files running
// in parallel never share profiles. A DB the caller chose is kept: it differs from the marker below,
// which holds the last path this file generated (children inherit both variables).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MARKER = "OMI_TEST_PROFILE_DB_AUTO";
const chosen = process.env.OMI_PROFILE_DB;

if (!chosen || chosen === process.env[MARKER]) {
  const file = join(mkdtempSync(join(tmpdir(), "omi-profiles-")), "profiles.sqlite");
  process.env.OMI_PROFILE_DB = file;
  process.env[MARKER] = file;
}
