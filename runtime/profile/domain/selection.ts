// The execution choice the Coordinator makes per task run: pure validation against the profiles
// of the machine. Reading profiles and decrypting tokens is injected (adapters).
import { type Profile, ProfileEffort } from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { PROFILES_FILE } from "../../shared/workspace.ts";

/** The env variable a profile's secret is read from. */
export const secretEnv = (p: Profile) =>
  p.auth.type === "subscription" ? p.auth.tokenEnv : p.auth.keyEnv;

export interface ProfileListing {
  name: string;
  harness: Profile["harness"];
  auth: Profile["auth"]["type"];
  /** Variable name only; its value is never read out, just whether it is set. */
  secretEnv: string;
  secretSet: boolean;
  models: string[];
  efforts: Profile["efforts"];
}

/** The execution choice the Coordinator made for the agent steps of one `task run`/`task analyze`. */
export interface Selection {
  profile: Profile;
  model: string;
  effort: ProfileEffort;
  reason: string;
  /**
   * The decrypted token, only on call (ADR-0004 D4). A function, so JSON.stringify of a selection
   * (packet, state, log) can never carry it; each call registers the value with `redact`.
   */
  secret: () => string;
}

/** Decrypts a profile's token (throws an OmiError when it cannot). */
export type SecretResolver = (profile: Profile) => string;

/**
 * Validates `--profile/--model/--effort/--reason` against the machine's profiles (#217). No
 * `--profile` means no selection: steps keep the `agents.routing` defaults. Model and effort
 * default to the first the profile lists; the reason is required and recorded; the profile's
 * token must decrypt now, so nothing starts that cannot authenticate.
 */
export function selectProfile(
  profiles: Profile[],
  o: { profile?: string; model?: string; effort?: string; reason?: string },
  resolveSecret?: SecretResolver,
): Selection | undefined {
  if (o.profile === undefined) {
    if (o.model !== undefined || o.effort !== undefined) {
      throw new OmiError("USAGE_INVALID", "--model and --effort need --profile");
    }
    return undefined;
  }
  const profile = profiles.find((p) => p.name === o.profile);
  if (!profile) {
    throw new OmiError(
      "USAGE_INVALID",
      `no profile ${o.profile} in ${PROFILES_FILE}: see \`omi profile list\``,
    );
  }
  if (profile.disabled) throw new OmiError("USAGE_INVALID", `profile ${profile.name} is disabled`);
  if (!resolveSecret) throw new OmiError("INTERNAL", "no secret resolver for a profile selection");
  resolveSecret(profile); // fails early: missing key, no token, wrong key
  const model = o.model ?? profile.models[0];
  if (!model || !profile.models.includes(model)) {
    throw new OmiError(
      "USAGE_INVALID",
      `profile ${profile.name} offers models ${profile.models.join(", ")}`,
    );
  }
  const effort = o.effort ?? profile.efforts[0];
  const parsed = ProfileEffort.safeParse(effort);
  if (!parsed.success || !profile.efforts.includes(parsed.data)) {
    throw new OmiError(
      "USAGE_INVALID",
      `profile ${profile.name} offers efforts ${profile.efforts.join(", ")}`,
    );
  }
  const reason = o.reason?.trim();
  if (!reason) throw new OmiError("USAGE_INVALID", "--reason is required with --profile");
  return { profile, model, effort: parsed.data, reason, secret: () => resolveSecret(profile) };
}
