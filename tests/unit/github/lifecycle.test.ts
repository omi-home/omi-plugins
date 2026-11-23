// DevTask-0128 #373: the v2 lifecycle steps go through the state engine (omi move / omi sync), never a
// direct Status write; under legacy the helper is not selected (isV2 false) and nothing is touched.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { isV2, lifecycleStart, lifecycleSync } from "../../../runtime/github/cli/lifecycle.ts";
import type { StateDeps } from "../../../runtime/github/cli/state.ts";
import type { OmiConfig } from "../../../runtime/shared/config.ts";
import { MIGRATIONS, migrate } from "../../../runtime/shared/sqlite/migrations.ts";
import { loadDefaultWorkflow } from "../../../runtime/shared/workflow.ts";
import { fakeGithub, type Item } from "./lifecycle-fake.ts";

const config = (model: "v2" | "legacy") =>
  ({ github: { owner: "o", repo: "r", projectNumber: 2, model } }) as OmiConfig;

function engine(model: "v2" | "legacy" = "v2"): StateDeps {
  const db = new DatabaseSync(":memory:");
  migrate(db, MIGRATIONS);
  return { config: config(model), workflow: loadDefaultWorkflow(), db: () => db };
}

const tree = (): Item[] => [
  { number: 10, type: "Epic", status: "Ready" },
  { number: 11, type: "DevTask", status: "Ready", parent: 10 },
];

test("isV2 follows github.model", () => {
  assert.equal(isV2(config("v2")), true);
  assert.equal(isV2(config("legacy")), false);
});

test("start: omi move <n> In progress, cascading to the parent, and idempotent", () => {
  const gh = fakeGithub(tree());
  const state = engine();
  const out = lifecycleStart({ cwd: ".", gh: gh.run, state }, 11);
  assert.equal(out.command, "move");
  assert.equal(gh.byNumber(11).status, "In progress");
  assert.equal(gh.byNumber(10).status, "In progress"); // roll-up is an `auto` rule of the engine
  const before = gh.mutations.length;
  lifecycleStart({ cwd: ".", gh: gh.run, state }, 11);
  assert.equal(gh.mutations.length, before);
});

test("start: a move the workflow does not allow is refused, nothing written", () => {
  const gh = fakeGithub([{ number: 11, type: "DevTask", status: "Done", state: "CLOSED" }]);
  assert.throws(() => lifecycleStart({ cwd: ".", gh: gh.run, state: engine() }, 11));
  assert.equal(gh.mutations.length, 0);
});

test("sync: applies the pending auto rules and reports as JSON data", () => {
  const gh = fakeGithub([
    { number: 10, type: "Epic", status: "Ready" },
    { number: 11, type: "DevTask", status: "In progress", parent: 10 },
  ]);
  const out = lifecycleSync({ cwd: ".", gh: gh.run, state: engine() });
  assert.equal(out.command, "sync");
  assert.equal(gh.byNumber(10).status, "In progress");
  const again = gh.mutations.length;
  lifecycleSync({ cwd: ".", gh: gh.run, state: engine() });
  assert.equal(gh.mutations.length, again);
});

test("legacy workspace: the engine refuses (CONFIG_INVALID), nothing is written", () => {
  const gh = fakeGithub(tree());
  assert.throws(
    () => lifecycleSync({ cwd: ".", gh: gh.run, state: engine("legacy") }),
    /needs github.model: v2/,
  );
  assert.equal(gh.mutations.length, 0);
});
