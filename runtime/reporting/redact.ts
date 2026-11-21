// Secret/PII scrubber for anything leaving the process (logs, errors, GitHub comments).
// ponytail: pattern list, not entropy detection; extend when a new credential format appears.
const RULES: [RegExp, string][] = [
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED:github-token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED:github-token]"],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, "[REDACTED:anthropic-key]"],
  [/\b(Bearer|token|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]"],
  [/(\w+:\/\/)[^\s/:@]+:[^\s/@]+@/g, "$1[REDACTED]@"],
  [
    /\b(password|passwd|secret|token|api[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
    "$1$2[REDACTED]",
  ],
  [/\b([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"']+/gi, "$1<user>"],
  [/(\/(?:home|Users)\/)[^/\s"']+/g, "$1<user>"],
];

/** Decrypted tokens of this process (ADR-0004 D4): scrubbed verbatim wherever they appear. */
const known = new Set<string>();
const MIN_SECRET_CHARS = 6;

/** Adds a decrypted token to the process's redact list. Too short a value would mangle ordinary text. */
export function registerSecret(value: string): void {
  if (value.length >= MIN_SECRET_CHARS) known.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const s of known) out = out.replaceAll(s, "[REDACTED:secret]");
  return RULES.reduce((s, [re, to]) => s.replace(re, to), out);
}

/** Deep-redacts every string inside a JSON-like value. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  }
  return value;
}
