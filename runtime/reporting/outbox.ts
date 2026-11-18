// Outbox publisher (spec §12, ADR-0001 "outbox comment"): pending reports become exactly one
// GitHub comment each. Always search the marker before POST, so a crash after POST and before
// the ID was stored ends in a PATCH, never a duplicate. Persist happened before; this publishes.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  classify,
  type GhRunner,
  markerAuthor,
  RestComment,
  spawnGh,
} from "../adapters/github/client.ts";
import { type IssueRef, parseContract } from "../core/contracts.ts";
import { isTransient, OmiError } from "../core/errors/errors.ts";
import type { Db } from "../persistence/db.ts";
import {
  acquireLease,
  markReported,
  type PendingReport,
  pendingReports,
  releaseLease,
} from "../persistence/repository.ts";
import { redact } from "./redact.ts";

const Comment = RestComment;
type Comment = z.infer<typeof Comment>;

export interface PublishOptions {
  gh?: GhRunner;
  /** Identifies this publisher for the per-run lease (two runners never publish the same run). */
  holder?: string;
  /** Tries per report on transient errors (rate limit, 5xx, network). */
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => void;
}

const LEASE_MS = 5 * 60_000;
const blockingSleep = (ms: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function api(run: GhRunner, args: string[], what: string, input?: string): unknown {
  const r = run(["api", ...args], input);
  if (r.status !== 0 || r.error) throw classify(r, what);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new OmiError("INTERNAL", `${what}: response is not JSON`);
  }
}

const path = (t: IssueRef) => `repos/${t.repository}/issues`;

function findByMarker(run: GhRunner, target: IssueRef, marker: string): Comment | undefined {
  const pages = api(
    run,
    ["--paginate", "--slurp", `${path(target)}/${target.number}/comments?per_page=100`],
    "list comments",
  );
  const all = parseContract(z.array(z.array(Comment)), pages, "list comments").flat();
  // Our bodies open with it; a quote elsewhere, or a stranger squatting the marker, is not ours.
  const trusted = markerAuthor(run);
  return all.find((c) => c.body.startsWith(marker) && trusted(c.author_association, c.user?.login));
}

function publishOne(run: GhRunner, r: PendingReport): Comment {
  const body = redact(r.body);
  const existing = findByMarker(run, r.target, r.marker);
  if (existing?.body === body) return existing;
  const [method, url] = existing
    ? ["PATCH", `${path(r.target)}/comments/${existing.id}`]
    : ["POST", `${path(r.target)}/${r.target.number}/comments`];
  const out = api(
    run,
    ["-X", method, url, "--input", "-"],
    `${method} comment`,
    JSON.stringify({ body }),
  );
  return parseContract(Comment, out, `${method} comment`);
}

/**
 * Publishes every pending report of a run, oldest first, stopping at the first failure so a
 * later report never overtakes an earlier one. Transient errors back off with jitter.
 * ponytail: backoff ignores GitHub's Retry-After/X-RateLimit-Reset headers (gh hides them on
 * errors); read them via `gh api -i` if fixed delays prove too eager.
 */
export function publishPending(db: Db, runId: string, o: PublishOptions = {}): number {
  const run = o.gh ?? spawnGh;
  const holder = o.holder ?? randomUUID();
  const maxAttempts = o.maxAttempts ?? 3;
  const base = o.baseDelayMs ?? 1000;
  const sleep = o.sleep ?? blockingSleep;
  const key = `outbox:${runId}`;
  acquireLease(db, { key, holder, ttlMs: LEASE_MS });
  try {
    let posted = 0;
    for (const r of pendingReports(db, runId)) {
      for (let attempt = 1; ; attempt++) {
        try {
          const c = publishOne(run, r);
          markReported(db, { marker: r.marker, commentId: String(c.id), commentUrl: c.html_url });
          posted++;
          break;
        } catch (e) {
          if (!isTransient(e) || attempt >= maxAttempts) throw e;
          sleep(base * 2 ** (attempt - 1) * (0.5 + Math.random() / 2));
        }
      }
    }
    return posted;
  } finally {
    releaseLease(db, { key, holder });
  }
}
