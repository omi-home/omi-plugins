import { redact, redactDeep } from "../../reporting/redact.ts";

/**
 * Error taxonomy. `transient` errors are retried as a new technical attempt and
 * MUST NOT count as a review round (spec §10).
 */
export const ERROR_CODES = {
  USAGE_INVALID: { transient: false },
  CONFIG_INVALID: { transient: false },
  CONTRACT_INVALID: { transient: false },
  SCHEMA_VERSION_UNSUPPORTED: { transient: false },
  TICKET_INVALID: { transient: false },
  TICKET_NOT_IN_PROJECT: { transient: false },
  DEPENDENCY_BLOCKED: { transient: false },
  POLICY_VIOLATION: { transient: false },
  INVALID_TRANSITION: { transient: false },
  OWNERSHIP_MISMATCH: { transient: false },
  WORKTREE_DIRTY: { transient: false },
  CLEANUP_UNSAFE: { transient: false },
  GITHUB_AUTH: { transient: false },
  GITHUB_RATE_LIMITED: { transient: true },
  GITHUB_UNAVAILABLE: { transient: true },
  NETWORK: { transient: true },
  LOCK_HELD: { transient: true },
  REPORT_NOT_POSTED: { transient: true },
  INTERNAL: { transient: false },
} as const satisfies Record<string, { transient: boolean }>;

export type ErrorCode = keyof typeof ERROR_CODES;

export class OmiError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(redact(message));
    this.name = "OmiError";
    this.code = code;
    this.details = redactDeep(details);
  }

  get transient(): boolean {
    return ERROR_CODES[this.code].transient;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      transient: this.transient,
      details: this.details,
    };
  }
}

export const isTransient = (err: unknown): boolean => err instanceof OmiError && err.transient;
