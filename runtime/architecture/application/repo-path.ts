// Path safety for the architecture check: nothing outside the repo is ever read.
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

/** True when `rel` under `repoDir` resolves, through every symlink, to a place inside the repo. */
export function insideRepo(repoDir: string, rel: string): boolean {
  try {
    const out = relative(realpathSync(repoDir), realpathSync(join(repoDir, rel)));
    return out === "" || (!out.startsWith("..") && !isAbsolute(out));
  } catch {
    return false;
  }
}
