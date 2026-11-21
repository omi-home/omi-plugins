// Minimal glob over posix repo paths: `*` (not `/`), `?` (one char, not `/`), `**` (anything,
// across `/`). `**/` also matches zero directories. Not path.matchesGlob / fs.glob: both are
// experimental on Node 22.

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const out = new RegExp(`^${re}$`);
  cache.set(glob, out);
  return out;
}

export const matchGlob = (glob: string, path: string): boolean => globToRegExp(glob).test(path);

/** True when any of the globs matches the path. */
export const matchAny = (globs: readonly string[], path: string): boolean =>
  globs.some((g) => matchGlob(g, path));
