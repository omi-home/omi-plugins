// Child process of the AC-6 test: adds `count` profiles named `<prefix>-<i>` to the machine DB that
// OMI_PROFILE_DB points at, one short transaction each, like concurrent `omi profile add` calls.

import { withProfileDb } from "../../runtime/profile/adapters/profile-store.ts";
import { addProfile } from "../../runtime/profile/adapters/profiles.ts";
import { Profile } from "../../runtime/shared/contracts.ts";

const [prefix, count] = [process.argv[2] as string, Number(process.argv[3])];
for (let i = 0; i < count; i++) {
  const profile = Profile.parse({
    name: `${prefix}-${i}`,
    harness: "claudecode",
    auth: { type: "subscription", tokenEnv: "OMI_T_SUB" },
    models: ["m1"],
    efforts: ["high"],
  });
  withProfileDb(process.env, (db) => addProfile(db, profile, null, new Date().toISOString()));
}
