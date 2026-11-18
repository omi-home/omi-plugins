// T2.4 GitHub client contract: error classification, GraphQL envelope handling and
// ticket gates, against a mocked `gh` runner (no network).
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { classify, type GhRunner, graphql } from "../../runtime/adapters/github/client.ts";
import { fetchTicket, type Ticket, validateTicket } from "../../runtime/adapters/github/ticket.ts";
import { github } from "../../runtime/cli/doctor.ts";
import { parseConfig } from "../../runtime/core/config.ts";

const config = parseConfig({ github: { owner: "o", repo: "r", projectNumber: 2 } });
const gh =
  (stdout: unknown, status = 0, stderr = ""): GhRunner =>
  () => ({ status, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr });
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code: string }).code;
  }
  return "no-throw";
};

test("classify: gh stderr → error code (CR-001)", () => {
  const cases: [string, string][] = [
    ["gh: API rate limit exceeded for user (HTTP 403)", "GITHUB_RATE_LIMITED"],
    ["You have exceeded a secondary rate limit", "GITHUB_RATE_LIMITED"],
    ["gh: Bad credentials (HTTP 401)", "GITHUB_AUTH"],
    ["FORBIDDEN Resource not accessible by integration", "GITHUB_AUTH"],
    ["To get started with GitHub CLI, please run:  gh auth login", "GITHUB_AUTH"],
    ["gh: Server Error (HTTP 502)", "GITHUB_UNAVAILABLE"],
    [
      'Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host',
      "NETWORK",
    ],
    ["proxyconnect tcp: ... actively refused it.", "NETWORK"],
    ["something unexpected", "INTERNAL"],
  ];
  for (const [stderr, code] of cases) assert.equal(classify({ stderr }, "x").code, code, stderr);
  const enoent = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
  assert.equal(classify({ stderr: "", error: enoent }, "x").code, "GITHUB_AUTH");
  const timeout = Object.assign(new Error("spawnSync gh ETIMEDOUT"), { code: "ETIMEDOUT" });
  assert.equal(classify({ stderr: "", error: timeout }, "x").transient, true);
});

test("classify: token in gh output is redacted", () => {
  const tok = `ghp_${"a".repeat(36)}`;
  assert.ok(!classify({ stderr: `Bad credentials ${tok}` }, "x").message.includes(tok));
});

test("graphql: NOT_FOUND tolerated, other errors classified, junk stdout handled (CR-002)", () => {
  const S = z.strictObject({ repository: z.null() });
  const notFound = { data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "no" }] };
  assert.deepEqual(graphql("q", {}, S, "t", gh(notFound, 1)), { repository: null });
  const limited = { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] };
  assert.equal(
    codeOf(() => graphql("q", {}, S, "t", gh(limited, 1))),
    "GITHUB_RATE_LIMITED",
  );
  const scopes = { errors: [{ type: "INSUFFICIENT_SCOPES", message: "needs read:project" }] };
  assert.equal(
    codeOf(() => graphql("q", {}, S, "t", gh(scopes, 1))),
    "GITHUB_AUTH",
  );
  assert.equal(
    codeOf(() => graphql("q", {}, S, "t", gh("", 1, "HTTP 503"))),
    "GITHUB_UNAVAILABLE",
  );
  assert.equal(
    codeOf(() => graphql("q", {}, S, "t", gh("<html>", 0))),
    "INTERNAL",
  );
  // Unexpected data shape is a contract error, not a crash.
  assert.equal(
    codeOf(() => graphql("q", {}, S, "t", gh({ data: { x: 1 } }))),
    "CONTRACT_INVALID",
  );
});

test("graphql: numbers are typed (-F), strings raw (-f)", () => {
  let seen: string[] = [];
  graphql("q", { owner: "o", number: 7 }, z.unknown(), "t", (a) => {
    seen = a;
    return { status: 0, stdout: '{"data":{}}', stderr: "" };
  });
  assert.deepEqual(seen.slice(4), ["-f", "owner=o", "-F", "number=7"]);
});

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  number: 5,
  title: "t",
  state: "OPEN",
  body: "## Acceptance\n- [ ] works",
  issueType: { name: "Task" },
  labels: { totalCount: 1, nodes: [{ name: "type:dev-task" }] },
  parent: { number: 1, state: "OPEN", repository: { nameWithOwner: "o/r" } },
  subIssuesSummary: { total: 0, completed: 0 },
  blockedBy: {
    totalCount: 1,
    nodes: [{ number: 3, state: "CLOSED", repository: { nameWithOwner: "o/r" } }],
  },
  projectItems: {
    totalCount: 1,
    nodes: [
      {
        id: "PVTI_1",
        isArchived: false,
        project: { number: 2, owner: { login: "o" } },
        fieldValueByName: { name: "Ready" },
      },
    ],
  },
  ...over,
});
const gate = (t: Ticket, name: string) => validateTicket(t, config).find((c) => c.name === name);

test("validateTicket: valid ticket passes every gate", () => {
  assert.deepEqual(
    validateTicket(ticket(), config).filter((c) => c.status !== "pass"),
    [],
  );
});

test("validateTicket: each gate fails with its own code", () => {
  const open = { number: 9, state: "OPEN", repository: { nameWithOwner: "o/r" } } as const;
  const cases: [Partial<Ticket>, string, string][] = [
    [{ state: "CLOSED" }, "state", "TICKET_INVALID"],
    [{ projectItems: { totalCount: 0, nodes: [] } }, "project", "TICKET_NOT_IN_PROJECT"],
    [{ labels: { totalCount: 0, nodes: [] } }, "type", "TICKET_INVALID"],
    [{ labels: { totalCount: 1, nodes: [{ name: "type:epik" }] } }, "type", "TICKET_INVALID"],
    [
      { labels: { totalCount: 2, nodes: [{ name: "type:bug" }, { name: "type:dev-task" }] } },
      "type",
      "TICKET_INVALID",
    ],
    [{ subIssuesSummary: { total: 2, completed: 1 } }, "terminal", "TICKET_INVALID"],
    [{ parent: { ...open, state: "CLOSED" } }, "parent", "TICKET_INVALID"],
    [{ body: "  " }, "acceptance", "TICKET_INVALID"],
    [{ blockedBy: { totalCount: 1, nodes: [open] } }, "dependencies", "DEPENDENCY_BLOCKED"],
    // Unpaged blockers are treated as blocking: fail closed.
    [{ blockedBy: { totalCount: 51, nodes: [] } }, "dependencies", "DEPENDENCY_BLOCKED"],
  ];
  for (const [over, name, code] of cases) {
    const c = gate(ticket(over), name);
    assert.equal(c?.status, "fail", `${name}: ${JSON.stringify(over)}`);
    assert.equal(c?.code, code, name);
  }
  // Wrong project (number or owner) and archived items do not count as membership.
  const item = ticket().projectItems.nodes[0] as Ticket["projectItems"]["nodes"][number];
  for (const other of [
    { ...item, project: { number: 1, owner: { login: "o" } } },
    { ...item, project: { number: 2, owner: { login: "x" } } },
    { ...item, isArchived: true },
  ]) {
    assert.equal(
      gate(ticket({ projectItems: { totalCount: 1, nodes: [other] } }), "project")?.status,
      "fail",
    );
  }
});

test("validateTicket: soft gates warn", () => {
  assert.equal(gate(ticket({ body: "do the thing" }), "acceptance")?.status, "warn");
  assert.equal(gate(ticket({ issueType: { name: "Bug" } }), "type")?.status, "warn");
  // Types without a native counterpart (spike) never warn on native type.
  const spike = { labels: { totalCount: 1, nodes: [{ name: "type:spike" }] }, issueType: null };
  assert.equal(gate(ticket(spike), "type")?.status, "pass");
});

test("fetchTicket: missing repo/issue → TICKET_INVALID; strict response shape", () => {
  const nf = { type: "NOT_FOUND", message: "x" };
  assert.equal(
    codeOf(() => fetchTicket(config, 1, gh({ data: { repository: null }, errors: [nf] }, 1))),
    "TICKET_INVALID",
  );
  assert.equal(
    codeOf(() =>
      fetchTicket(config, 1, gh({ data: { repository: { issue: null } }, errors: [nf] }, 1)),
    ),
    "TICKET_INVALID",
  );
  const t = ticket();
  assert.deepEqual(fetchTicket(config, 5, gh({ data: { repository: { issue: t } } })), t);
  const extra = { ...t, surprise: true };
  assert.equal(
    codeOf(() => fetchTicket(config, 5, gh({ data: { repository: { issue: extra } } }))),
    "CONTRACT_INVALID",
  );
});

const env = (over: Record<string, unknown> = {}) => ({
  data: {
    viewer: { login: "me" },
    rateLimit: { limit: 5000, remaining: 4000, resetAt: "2026-11-17T10:00:00Z" },
    repository: {
      visibility: "PUBLIC",
      viewerPermission: "WRITE",
      defaultBranchRef: { name: "develop" },
    },
    repositoryOwner: { projectV2: { title: "P", closed: false } },
    ...over,
  },
});
const status = (checks: ReturnType<typeof github>) =>
  Object.fromEntries(checks.map((c) => [c.name, `${c.status}${c.code ? `:${c.code}` : ""}`]));

test("doctor github: permission, project, rate-limit diagnostics", () => {
  assert.deepEqual(status(github(config, gh(env()))), {
    "github-auth": "pass",
    "github-rate-limit": "pass",
    "github-project": "pass",
    "github-permission": "pass",
    "github-visibility": "pass",
    "default-branch": "pass",
  });
  const bad = status(
    github(
      config,
      gh(
        env({
          rateLimit: { limit: 5000, remaining: 10, resetAt: "2026-11-17T10:00:00Z" },
          repository: {
            visibility: "PRIVATE",
            viewerPermission: "READ",
            defaultBranchRef: { name: "main" },
          },
          repositoryOwner: { projectV2: null },
        }),
      ),
    ),
  );
  assert.equal(bad["github-rate-limit"], "warn");
  assert.equal(bad["github-project"], "fail:CONFIG_INVALID");
  assert.equal(bad["github-permission"], "fail:GITHUB_AUTH");
  assert.equal(bad["github-visibility"], "warn");
  assert.equal(bad["default-branch"], "warn");
});

test("doctor github: transport failures become one classified check, never a crash", () => {
  for (const [run, code] of [
    [gh("", 1, "dial tcp: no such host"), "NETWORK"],
    [gh("", 1, "gh: Bad credentials (HTTP 401)"), "GITHUB_AUTH"],
    [gh("not json"), "INTERNAL"],
    [gh({ data: { unexpected: 1 } }), "CONTRACT_INVALID"],
  ] as const) {
    assert.deepEqual(status(github(config, run)), { "github-auth": `fail:${code}` });
  }
  assert.deepEqual(status(github(undefined, gh({ data: { viewer: { login: "me" } } }))), {
    "github-auth": "pass",
  });
});
