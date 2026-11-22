// Numeric `major.minor.patch` comparison for tool versions (node, git, gh, agent harnesses).

/** First `x.y.z` in `s` as numbers, or undefined. */
export const semver = (s: string) => /(\d+)\.(\d+)\.(\d+)/.exec(s)?.slice(1).map(Number);

export function atLeast(version: string, min: string): boolean {
  const [a, b] = [semver(version), semver(min)];
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] as number) > (b[i] as number);
  }
  return true;
}
