// File tree walk with lstat: symlinks are never followed (and never listed), so a link cannot
// pull files from outside the repo into the check. A symlinked parent directory is caught by
// comparing real paths with the repo's.
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules"]);

export type RootState = "ok" | "missing" | "symlink" | "not-directory" | "outside-repo";

/** True when `rel` under `repoDir` resolves, through every symlink, to a place inside the repo. */
export function insideRepo(repoDir: string, rel: string): boolean {
  try {
    const out = relative(realpathSync(repoDir), realpathSync(join(repoDir, rel)));
    return out === "" || (!out.startsWith("..") && !isAbsolute(out));
  } catch {
    return false;
  }
}

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
  if (!insideRepo(repoDir, root)) return { state: "outside-repo", files: [] };
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

/** True for a regular file (not a symlink) at the repo-relative path, really inside the repo. */
export function isRegularFile(repoDir: string, rel: string): boolean {
  try {
    return lstatSync(join(repoDir, rel)).isFile() && insideRepo(repoDir, rel);
  } catch {
    return false;
  }
}
