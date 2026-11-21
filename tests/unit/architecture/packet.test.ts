// T4 #328: the task packet carries the architecture excerpt of the worktree's contract.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildTaskPacket } from "../../../runtime/core/handoff/packet.ts";
import { architectureExcerpt } from "../../../runtime/core/workflow-engine/slice.ts";
import { parseConfig } from "../../../runtime/shared/config.ts";
import { makeRepo, validContract } from "./helpers.ts";

const config = parseConfig({ github: { owner: "o", repo: "r", projectNumber: 2 } });
const base = "a".repeat(40);
const packet = (dir: string, architecture?: unknown) =>
  buildTaskPacket({
    workflowRunId: "r1",
    issue: { repository: "o/r", number: 1 },
    stepId: "implement",
    role: "backend-engineer",
    round: 1,
    attempt: 1,
    scope: [],
    worktree: dir,
    baseSha: base,
    issueContext: [
      {
        issue: { repository: "o/r", number: 1 },
        type: "dev-task",
        title: "t",
        body: "b",
        truncated: false,
      },
    ],
    openFindings: [],
    carriedFindings: [],
    readOnlyArtifacts: [],
    ...(architecture ? { architecture: architecture as never } : {}),
  });

test("packet: repo without a contract has no architecture field", () => {
  const r = makeRepo({});
  try {
    const dir = r.dir;
    rmSync(join(dir, "omi-architecture.yaml"));
    assert.equal(architectureExcerpt(dir, config, []), undefined);
    assert.equal("architecture" in packet(dir), false);
  } finally {
    r.cleanup();
  }
});

test("packet: an invalid contract gives no field instead of failing the step", () => {
  const r = makeRepo({}, { schemaVersion: 1 });
  try {
    assert.equal(architectureExcerpt(r.dir, config, []), undefined);
  } finally {
    r.cleanup();
  }
});

test("packet: contract present -> excerpt with layers and placement, all modules for empty scope", () => {
  const r = makeRepo({});
  try {
    const ex = architectureExcerpt(r.dir, config, []);
    assert.ok(ex);
    assert.equal(ex.contractPath, "omi-architecture.yaml");
    assert.equal(ex.layers.length, 4);
    assert.equal(ex.placement.length, 1);
    assert.deepEqual(ex.modules.map((m) => m.id).sort(), [
      "billing",
      "kernel",
      "orders",
      "reports",
    ]);
    assert.deepEqual(packet(r.dir, ex).architecture, ex);
  } finally {
    r.cleanup();
  }
});

test("packet: scope picks the touched modules plus their dependsOn", () => {
  const r = makeRepo({});
  try {
    const ex = architectureExcerpt(r.dir, config, ["src/orders/domain/x.ts"]);
    assert.deepEqual(ex?.modules.map((m) => m.id).sort(), ["billing", "orders"]);
  } finally {
    r.cleanup();
  }
});

test("packet: at most 30 modules", () => {
  const c = validContract();
  c.modules = Array.from({ length: 35 }, (_, i) => ({
    id: `mod-${String(i).padStart(2, "0")}`,
    path: `src/mod-${i}`,
    description: "m",
  })) as never;
  const r = makeRepo({}, c);
  try {
    assert.equal(architectureExcerpt(r.dir, config, [])?.modules.length, 30);
  } finally {
    r.cleanup();
  }
});
