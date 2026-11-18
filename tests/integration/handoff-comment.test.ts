// DevTask-0049 #144: `omi handoff show|post` against an in-memory GitHub: none, newest of several,
// re-post is a no-op, explicit marker updates, active Milestone selection, redaction.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhRunner } from "../../runtime/adapters/github/client.ts";
import { listHandoffs, postHandoff } from "../../runtime/adapters/github/handoff.ts";
import type { OmiConfig } from "../../runtime/core/config.ts";
import type { OmiError } from "../../runtime/core/errors/errors.ts";

const config = { github: { owner: "o", repo: "r", projectNumber: 2 } } as OmiConfig;

interface C {
  id: number;
  body: string;
  createdAt: string;
}

function fakeGh(seed: Record<number, C[]>, statuses: Record<number, string> = {}) {
  const comments = new Map(Object.entries(seed).map(([k, v]) => [Number(k), v]));
  const writes: string[] = [];
  let seq = 100;
  const url = (n: number, id: number) => `https://x/${n}#c${id}`;
  const out = (data: unknown) => ({ status: 0, stdout: JSON.stringify(data), stderr: "" });
  const run: GhRunner = (args, input) => {
    const query = args[2] === "-f" ? (args[3] ?? "") : "";
    if (query.includes("search(")) {
      const nodes = [...comments].map(([n, cs]) => ({
        number: n,
        title: `Milestone ${n}`,
        comments: {
          nodes: cs.map((c) => ({ url: url(n, c.id), body: c.body, createdAt: c.createdAt })),
        },
      }));
      return out({ data: { search: { nodes: [...nodes, {}] } } });
    }
    if (query.includes("type:milestone")) {
      const nodes = Object.entries(statuses).map(([n, s]) => ({
        number: Number(n),
        projectItems: {
          nodes: [{ project: { number: 2, owner: { login: "o" } }, fieldValueByName: { name: s } }],
        },
      }));
      return out({ data: { repository: { issues: { nodes } } } });
    }
    const path = args.find((a) => a.startsWith("repos/")) ?? "";
    if (args.includes("--paginate")) {
      const n = Number(/issues\/(\d+)\/comments/.exec(path)?.[1]);
      const page = (comments.get(n) ?? []).map((c) => ({
        id: c.id,
        html_url: url(n, c.id),
        body: c.body,
      }));
      return out([page]);
    }
    const { body } = JSON.parse(input ?? "{}");
    if (args.includes("POST")) {
      const n = Number(/issues\/(\d+)\/comments/.exec(path)?.[1]);
      const c = { id: ++seq, body, createdAt: "2026-11-18T23:00:00Z" };
      comments.set(n, [...(comments.get(n) ?? []), c]);
      writes.push(`POST ${n}`);
      return out({ id: c.id, html_url: url(n, c.id), body });
    }
    if (args.includes("PATCH")) {
      const id = Number(/comments\/(\d+)$/.exec(path)?.[1]);
      for (const [n, cs] of comments) {
        const c = cs.find((x) => x.id === id);
        if (c) {
          c.body = body;
          writes.push(`PATCH ${id}`);
          return out({ id, html_url: url(n, id), body });
        }
      }
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return { run, comments, writes };
}

const now = new Date(2026, 10, 19, 9);

test("show: no handoff anywhere is an empty list", () => {
  const { run } = fakeGh({
    5: [{ id: 1, body: "plain comment", createdAt: "2026-11-01T00:00:00Z" }],
  });
  assert.deepEqual(listHandoffs(config, run), []);
});

test("show: newest handoff first, across Issues; quotes of the marker are not handoffs", () => {
  const { run } = fakeGh({
    57: [
      {
        id: 1,
        body: "<!-- omi:handoff=2026-11-17-s11 -->\nold",
        createdAt: "2026-11-17T10:00:00Z",
      },
      { id: 2, body: "see `<!-- omi:handoff=x -->`", createdAt: "2026-11-18T12:00:00Z" },
    ],
    64: [
      {
        id: 3,
        body: "<!-- omi:handoff=2026-11-18-s13b -->\nnew",
        createdAt: "2026-11-18T06:00:00Z",
      },
    ],
  });
  const all = listHandoffs(config, run);
  assert.deepEqual(
    all.map((h) => [h.marker, h.issue]),
    [
      ["2026-11-18-s13b", 64],
      ["2026-11-17-s11", 57],
    ],
  );
});

test("post: new marker is today + next session, on the one active Milestone", () => {
  const gh = fakeGh(
    {
      57: [
        {
          id: 1,
          body: "<!-- omi:handoff=2026-11-18-s13b -->\nx",
          createdAt: "2026-11-18T06:00:00Z",
        },
      ],
    },
    { 57: "Done", 64: "In Progress", 70: "Backlog" },
  );
  const r = postHandoff(config, "## Handoff\nnext: #145", { now, run: gh.run });
  assert.deepEqual([r.marker, r.issue, r.action], ["2026-11-19-s14", 64, "created"]);
  assert.equal(
    gh.comments.get(64)?.[0]?.body,
    "<!-- omi:handoff=2026-11-19-s14 -->\n## Handoff\nnext: #145\n",
  );

  // Same text again (search not yet indexed): found on the Issue itself, nothing written.
  const again = postHandoff(config, "## Handoff\nnext: #145\n", { now, run: gh.run });
  assert.deepEqual([again.marker, again.action], ["2026-11-19-s14", "unchanged"]);
  assert.deepEqual(gh.writes, ["POST 64"]);
});

test("post: a text opening with its marker updates that comment, unchanged text is a no-op", () => {
  const gh = fakeGh({
    64: [
      {
        id: 7,
        body: "<!-- omi:handoff=2026-11-19-s14 -->\nv1\n",
        createdAt: "2026-11-19T01:00:00Z",
      },
    ],
  });
  const r = postHandoff(config, "<!-- omi:handoff=2026-11-19-s14 -->\nv2", {
    issue: 64,
    run: gh.run,
  });
  assert.equal(r.action, "updated");
  const same = postHandoff(config, "<!-- omi:handoff=2026-11-19-s14 -->\nv2", {
    issue: 64,
    run: gh.run,
  });
  assert.equal(same.action, "unchanged");
  assert.deepEqual(gh.writes, ["PATCH 7"]);
});

test("post: secrets are redacted before they leave the process", () => {
  const gh = fakeGh({});
  postHandoff(config, `token: ghp_${"a".repeat(36)} at C:\\Users\\alice\\x`, {
    issue: 9,
    now,
    run: gh.run,
  });
  const body = gh.comments.get(9)?.[0]?.body ?? "";
  assert.doesNotMatch(body, /ghp_a|alice/);
  assert.match(body, /REDACTED/);
});

test("post: zero or several active Milestones ask for --milestone; empty text is refused", () => {
  const cases: Record<number, string>[] = [{}, { 57: "In Review", 64: "In Progress" }];
  for (const statuses of cases) {
    assert.throws(
      () => postHandoff(config, "x", { run: fakeGh({}, statuses).run }),
      (e: OmiError) => e.code === "USAGE_INVALID" && /--milestone/.test(e.message),
    );
  }
  assert.throws(
    () => postHandoff(config, "<!-- omi:handoff=a-s1 -->\n  ", { issue: 1, run: fakeGh({}).run }),
    (e: OmiError) => e.code === "USAGE_INVALID",
  );
});

test("post: a BOM or blank lines before the marker do not duplicate it", () => {
  const gh = fakeGh({
    64: [
      {
        id: 7,
        body: "<!-- omi:handoff=2026-11-19-s14 -->\nv1\n",
        createdAt: "2026-11-19T01:00:00Z",
      },
    ],
  });
  postHandoff(config, "﻿\n<!-- omi:handoff=2026-11-19-s14 -->\nv2", { issue: 64, run: gh.run });
  assert.equal(gh.comments.get(64)?.[0]?.body, "<!-- omi:handoff=2026-11-19-s14 -->\nv2\n");
});

test("post: a marker that lives on another Milestone is refused, not copied", () => {
  const gh = fakeGh({
    57: [
      {
        id: 7,
        body: "<!-- omi:handoff=2026-11-19-s14 -->\nv1\n",
        createdAt: "2026-11-19T01:00:00Z",
      },
    ],
  });
  assert.throws(
    () =>
      postHandoff(config, "<!-- omi:handoff=2026-11-19-s14 -->\nv2", { issue: 64, run: gh.run }),
    (e: OmiError) => e.code === "USAGE_INVALID" && /--milestone 57/.test(e.message),
  );
  assert.deepEqual(gh.writes, []);
});
