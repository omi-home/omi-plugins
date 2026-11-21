// File tree walk with lstat: symlinks are never followed (and never listed), so a link cannot
// pull files from outside the repo into the check.
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules"]);

export type RootState = "ok" | "missing" | "symlink" | "not-directory";

/** Repo-relative posix paths of the regular files under `root`, sorted. */
export function scanTree(repoDir: string, root: string): { state: RootState; files: string[] } {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(join(repoDir, root));
  } catch {
    return { state: "missing", files: [] };
  }
  if (st.isSymbolicLink()) return { state: "symlink", files: [] };
  if (!st.isDirectory()) return { state: "not-directory", files: [] };
  const files: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(repoDir, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      // Dirent type comes from the directory entry itself: a symlink is neither file nor directory.
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(child);
      } else if (e.isFile()) files.push(child);
    }
  };
  walk(root);
  return { state: "ok", files: files.sort() };
}

/** True for a regular file (not a symlink) at the repo-relative path. */
export function isRegularFile(repoDir: string, rel: string): boolean {
  try {
    return lstatSync(join(repoDir, rel)).isFile();
  } catch {
    return false;
  }
}
