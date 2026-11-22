// Loaded with `node --import` by the `test` script: no test may touch the real machine profile DB
// (Feature-0044 #337). The test run gets a temp file unless the caller already chose one.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.OMI_PROFILE_DB) {
  process.env.OMI_PROFILE_DB = join(
    mkdtempSync(join(tmpdir(), "omi-profiles-")),
    "profiles.sqlite",
  );
}
