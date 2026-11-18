// Deterministic GitHub access through the authenticated `gh` CLI (spec §9, ADR-0001 D7).
// Every failure is classified into an OmiError code so callers can tell retryable
// (network, rate limit, 5xx) from actionable (auth, scopes) failures.
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { type AuthorAssociation, parseContract } from "../../core/contracts.ts";
import { type ErrorCode, OmiError } from "../../core/errors/errors.ts";

export interface GhResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}
/** Injectable for contract tests; production spawns `gh`. `input` goes to stdin. */
export type GhRunner = (args: string[], input?: string) => GhResult;

export const spawnGh: GhRunner = (args, input) =>
  spawnSync("gh", args, { encoding: "utf8", timeout: 30_000, windowsHide: true, input });

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

const TRUSTED: readonly AuthorAssociation[] = ["OWNER", "MEMBER", "COLLABORATOR"];
const VIEWER = "query{ viewer{ login } }";
const viewers = new WeakMap<GhRunner, string>();

/**
 * Who may write OMI markers (carried findings, handoffs, outbox reports): owners, members,
 * collaborators, and the identity `gh` runs as (a bot or a private org member shows as NONE /
 * CONTRIBUTOR). Anyone can comment on a public repository; their markers are text, never state.
 * The viewer is read once per runner, and only when an association is not trusted.
 */
export function markerAuthor(run: GhRunner) {
  return (association: string | undefined, login: string | undefined): boolean => {
    if (TRUSTED.some((t) => t === association)) return true;
    if (!login) return false;
    let viewer = viewers.get(run);
    if (viewer === undefined) {
      viewer = graphql(VIEWER, {}, Viewer, "viewer", run).viewer.login;
      viewers.set(run, viewer);
    }
    return login === viewer;
  };
}

/** A REST issue comment (`gh api .../comments`). */
export const RestComment = z.looseObject({
  id: z.int().positive(),
  html_url: z.string(),
  body: z.string(),
  author_association: z.string().optional(),
  user: z.looseObject({ login: z.string() }).nullable().optional(),
});
export type RestComment = z.infer<typeof RestComment>;

const Viewer = z.strictObject({ viewer: z.strictObject({ login: z.string() }) });

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
  /** Lists and objects only with `viaStdin`. */
  vars: Record<string, unknown>,
  schema: S,
  name: string,
  run: GhRunner = spawnGh,
  /** Send query and variables as JSON on stdin: large values (Issue bodies) exceed argv limits. */
  viaStdin = false,
): z.infer<S> {
  const args = ["api", "graphql"];
  if (viaStdin) args.push("--input", "-");
  else {
    args.push("-f", `query=${query}`);
    for (const [k, v] of Object.entries(vars)) {
      if (typeof v === "object") throw new OmiError("INTERNAL", `${name}: ${k} needs viaStdin`);
      args.push(typeof v === "number" ? "-F" : "-f", `${k}=${String(v)}`);
    }
  }
  const r = viaStdin ? run(args, JSON.stringify({ query, variables: vars })) : run(args);
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
