// `omi arch show` / the packet excerpt: the cut at 30 modules never drops a module the scope
// touches (carried finding #328 CR-002): touched modules first, then their dependencies.
import assert from "node:assert/strict";
import { test } from "node:test";
import { archShow, MAX_EXCERPT_MODULES } from "../../../runtime/architecture/application/arch.ts";
import { makeRepo, validContract } from "./helpers.ts";

const deps = Array.from({ length: 40 }, (_, i) => `dep${String(i).padStart(2, "0")}`);
const contract = () => ({
  ...validContract(),
  modules: [
    ...deps.map((id) => ({ id, path: `src/${id}`, description: id })),
    { id: "zed", path: "src/zed", description: "touched last", dependsOn: deps },
  ],
  legacy: [],
});

test("excerpt: a touched module is kept first even when it is declared after 40 dependencies", () => {
  const { dir, cleanup } = makeRepo({}, contract());
  try {
    const r = archShow({ cwd: dir, scope: ["src/zed/domain/x.ts"] });
    assert.equal(r.modules.length, MAX_EXCERPT_MODULES);
    assert.equal(r.modules[0]?.id, "zed");
    assert.deepEqual(
      r.modules.slice(1).map((m) => m.id),
      deps.slice(0, MAX_EXCERPT_MODULES - 1),
      "dependencies follow in contract order, the cut drops the last ones",
    );
  } finally {
    cleanup();
  }
});

test("excerpt: several touched modules all survive the cut; no scope keeps contract order", () => {
  const { dir, cleanup } = makeRepo({}, contract());
  try {
    const r = archShow({ cwd: dir, scope: ["src/dep39", "src/zed"] });
    assert.deepEqual(
      r.modules.slice(0, 2).map((m) => m.id),
      ["dep39", "zed"],
    );
    assert.equal(r.modules.length, MAX_EXCERPT_MODULES);
    const all = archShow({ cwd: dir });
    assert.deepEqual(
      all.modules.map((m) => m.id),
      deps.slice(0, MAX_EXCERPT_MODULES),
    );
  } finally {
    cleanup();
  }
});
