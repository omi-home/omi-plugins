// Deterministic GitHub access through the authenticated `gh` CLI (spec §9, ADR-0001 D7).
// Every failure is classified into an OmiError code so callers can tell retryable
// (network, rate limit, 5xx) from actionable (auth, scopes) failures.
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { parseContract } from "../../core/contracts.ts";
import { type ErrorCode, OmiError } from "../../core/errors/errors.ts";

export interface GhResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}
/** Injectable for contract tests; production spawns `gh`. */
export type GhRunner = (args: string[]) => GhResult;

export const spawnGh: GhRunner = (args) =>
  spawnSync("gh", args, { encoding: "utf8", timeout: 30_000, windowsHide: true });

const RULES: [RegExp, ErrorCode][] = [
  [/rate limit|RATE_LIMITED|HTTP 429/i, "GITHUB_RATE_LIMITED"],
  [
    /HTTP 401|Bad credentials|not logged in|gh auth login|INSUFFICIENT_SCOPES|FORBIDDEN|HTTP 403/i,
    "GITHUB_AUTH",
  ],
  [/HTTP 5\d\d|SERVICE_UNAVAILABLE|Something went wrong/i, "GITHUB_UNAVAILABLE"],
  [
    /dial tcp|no such host|connection (refused|reset)|actively refused|timed? ?out|TLS handshake|EOF|ECONN|ENOTFOUND|ETIMEDOUT/i,
    "NETWORK",
  ],
];

/** Maps a failed `gh` invocation (or GraphQL error text) to a classified OmiError. */
export function classify(r: Pick<GhResult, "stderr" | "error">, what: string): OmiError {
  const err = r.error as NodeJS.ErrnoException | undefined;
  if (err?.code === "ENOENT") return new OmiError("GITHUB_AUTH", "gh CLI not found on PATH");
  if (err?.code === "ETIMEDOUT") return new OmiError("NETWORK", `${what}: gh timed out`);
  const text = `${r.stderr} ${err?.message ?? ""}`;
  const code = RULES.find(([re]) => re.test(text))?.[1] ?? "INTERNAL";
  // First line only: gh echoes request bodies on some errors.
  const first = text.trim().split(/\r?\n/)[0]?.slice(0, 300) ?? "";
  return new OmiError(code, `${what}: ${first || "gh failed"}`);
}

const GqlError = z.looseObject({ type: z.string().optional(), message: z.string() });
export type GqlError = z.infer<typeof GqlError>;
const GqlEnvelope = z.looseObject({
  data: z.unknown().optional(),
  errors: z.array(GqlError).optional(),
});

/**
 * Runs a GraphQL query. Returns `data` validated against `schema`; GraphQL `NOT_FOUND`
 * errors are tolerated (the field is null in `data`), every other error is classified.
 * ponytail: no in-process retry; transient errors surface as exit 75 and the caller's
 * attempt budget (maxAttempts) retries.
 */
export function graphql<S extends z.ZodType>(
  query: string,
  vars: Record<string, string | number>,
  schema: S,
  name: string,
  run: GhRunner = spawnGh,
): z.infer<S> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars))
    args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
  const r = run(args);
  let body: unknown;
  try {
    body = JSON.parse(r.stdout);
  } catch {
    // Transport/auth failures print no JSON on stdout.
    throw classify(r, name);
  }
  const env = parseContract(GqlEnvelope, body, `${name} response`);
  const errors = (env.errors ?? []).filter((e) => e.type !== "NOT_FOUND");
  if (errors.length) {
    throw classify({ stderr: errors.map((e) => `${e.type ?? ""} ${e.message}`).join("\n") }, name);
  }
  if (r.status !== 0 && !env.errors?.length) throw classify(r, name);
  return parseContract(schema, env.data, `${name} data`);
}
