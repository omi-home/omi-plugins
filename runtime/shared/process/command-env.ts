// Env of the repo's own commands (checks, setup). They run code the agent may have edited, so they
// must not inherit the master key or any auth token of the host (ARC-001, ADR-0004 D4).
import { DEFAULT_KEY_ENV } from "../contracts.ts";

/** Variables Claude Code reads its auth from. */
export const AUTH_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

export interface CommandEnvOptions {
  /** `secrets.keyEnv`: name of the master key variable (default `OMI_SECRET_KEY`). */
  keyEnv?: string;
  /** Names of the variables the profiles declared for their tokens (legacy `tokenEnv`/`keyEnv`). */
  tokenEnvs?: string[];
}

/** Names to drop: master key, its `_NEXT`, the auth variables and the profiles' token variables. */
export function secretEnvNames(o: CommandEnvOptions = {}): string[] {
  const keyEnv = o.keyEnv ?? DEFAULT_KEY_ENV;
  return [keyEnv, `${keyEnv}_NEXT`, ...AUTH_VARS, ...(o.tokenEnvs ?? [])];
}

/** `host` without the secret variables (names matched case-insensitively, as Windows does). */
export function commandEnv(
  host: NodeJS.ProcessEnv,
  o: CommandEnvOptions = {},
): Record<string, string> {
  const drop = new Set(secretEnvNames(o).map((n) => n.toUpperCase()));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(host)) {
    if (v !== undefined && !drop.has(k.toUpperCase())) env[k] = v;
  }
  return env;
}
