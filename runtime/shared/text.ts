/** Cuts to at most `max` UTF-16 code units without leaving half of a surrogate pair (emoji). */
export function cutAt(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = Math.max(0, max);
  const last = s.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1; // high surrogate whose pair is cut off
  return s.slice(0, end);
}
