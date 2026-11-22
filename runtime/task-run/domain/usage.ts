import type { TokenUsage } from "../../shared/contracts.ts";

/** Field-wise sum; an optional field stays absent only when no part has it. */
export function sumUsage(parts: TokenUsage[]): TokenUsage | undefined {
  if (!parts.length) return undefined;
  const add = (k: Exclude<keyof TokenUsage, "inputTokens" | "outputTokens">) =>
    parts.some((p) => p[k] !== undefined) ? parts.reduce((n, p) => n + (p[k] ?? 0), 0) : undefined;
  return {
    inputTokens: parts.reduce((n, p) => n + p.inputTokens, 0),
    outputTokens: parts.reduce((n, p) => n + p.outputTokens, 0),
    cacheReadTokens: add("cacheReadTokens"),
    cacheCreationTokens: add("cacheCreationTokens"),
    thinkingTokens: add("thinkingTokens"),
    costUsd: add("costUsd"),
    numTurns: add("numTurns"),
  };
}
