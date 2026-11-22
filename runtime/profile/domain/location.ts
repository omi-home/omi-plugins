// Where the machine profile database lives (Feature-0044 #337). Pure: no fs, the caller injects
// the environment, the platform and the home directory.
import { posix, win32 } from "node:path";
import { OmiError } from "../../shared/errors/errors.ts";

/** Absolute file path of the machine profile DB; set by tests and by users who want another place. */
export const PROFILE_DB_ENV = "OMI_PROFILE_DB";

export interface ProfileDbLocationInput {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
}

export interface ProfileDbLocation {
  path: string;
  source: "env" | "default";
}

/** `profiles.sqlite` of this OS user: one file for every workspace on the machine. */
export function resolveProfileDbPath({
  env,
  platform,
  home,
}: ProfileDbLocationInput): ProfileDbLocation {
  const p = platform === "win32" ? win32 : posix;
  const fromEnv = env[PROFILE_DB_ENV]?.trim();
  if (fromEnv) {
    if (!p.isAbsolute(fromEnv)) {
      throw new OmiError("CONFIG_INVALID", `${PROFILE_DB_ENV} must be an absolute file path`);
    }
    return { path: p.normalize(fromEnv), source: "env" };
  }
  const needHome = () => {
    if (!home) throw new OmiError("CONFIG_INVALID", "cannot locate the home directory");
    return home;
  };
  if (platform === "win32") {
    const base = env.LOCALAPPDATA?.trim() || win32.join(needHome(), "AppData", "Local");
    return { path: win32.join(base, "omi", "profiles.sqlite"), source: "default" };
  }
  if (platform === "darwin") {
    return {
      path: posix.join(needHome(), "Library", "Application Support", "omi", "profiles.sqlite"),
      source: "default",
    };
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && posix.isAbsolute(xdg) ? xdg : posix.join(needHome(), ".config");
  return { path: posix.join(base, "omi", "profiles.sqlite"), source: "default" };
}
