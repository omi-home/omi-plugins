// DevTask-0038 #90: `omi github repo plan|apply|validate` against an in-memory repository:
// reapply = zero writes, approved plan only, stricter protection kept, private Free 403,
// permission denied.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhRunner } from "../../runtime/adapters/github/client.ts";
import {
  approvedActions,
  repoApply,
  repoPlan,
  repoValidate,
} from "../../runtime/adapters/github/repo.ts";
import { type OmiConfig, parseConfig } from "../../runtime/core/config.ts";
import type { OmiError } from "../../runtime/core/errors/errors.ts";
import { loadRepoConfig } from "../../runtime/core/repo-config.ts";

const config = (privateRepoRiskAccepted = false): OmiConfig =>
  parseConfig({ github: { owner: "o", repo: "r", projectNumber: 2, privateRepoRiskAccepted } });
const desired = loadRepoConfig();

type Prot = Record<string, unknown> | null;
interface State {
  labels: { name: string; color: string; description: string | null }[];
  protection: Record<string, Prot | "free">;
  merge: { allow_squash_merge: boolean; allow_merge_commit: boolean; allow_rebase_merge: boolean };
  admin: boolean;
  denyWrites?: boolean;
}

const on = (enabled: boolean) => ({ enabled });
/** omi-home/omi-plugins after PO's 2026-11-17 setup, minus the labels added by #90. */
const seed = (): State => ({
  labels: [
    ...desired.labels.filter((l) => l.name.startsWith("type:")),
    { name: "bug", color: "d73a4a", description: "Something isn't working" },
  ],
  protection: {
    main: {
      required_pull_request_reviews: { required_approving_review_count: 0 },
      enforce_admins: on(true),
      required_linear_history: on(false),
      allow_force_pushes: on(false),
      allow_deletions: on(false),
      required_conversation_resolution: on(true),
    },
    develop: null, // not protected yet
  },
  merge: { allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true },
  admin: true,
});

function fakeRepo(state: State) {
  const writes: string[] = [];
  const bodies: Record<string, unknown> = {};
  const ok = (data: unknown) => ({ status: 0, stdout: JSON.stringify(data), stderr: "" });
  const err = (code: number, message: string) => ({
    status: 1,
    stdout: JSON.stringify({ message, status: String(code) }),
    stderr: `gh: ${message} (HTTP ${code})`,
  });
  const run: GhRunner = (args, input) => {
    const method = args[args.indexOf("--method") + 1] ?? "GET";
    const write = args.includes("--method");
    const path = args.find((a) => a.startsWith("repos/")) as string;
    const body = input ? JSON.parse(input) : undefined;
    if (write && state.denyWrites) return err(403, "Resource not accessible by integration");
    const branch = /branches\/([^/]+)\/protection$/.exec(path)?.[1];
    if (branch) {
      const name = decodeURIComponent(branch);
      if (!(name in state.protection)) return err(404, "Branch not found");
      const p = state.protection[name];
      if (p === "free") {
        return err(
          403,
          "Upgrade to GitHub Pro or make this repository public to enable this feature.",
        );
      }
      if (method === "PUT") {
        writes.push(`protect:${name}`);
        bodies[name] = body;
        state.protection[name] = {
          required_status_checks: body.required_status_checks,
          required_pull_request_reviews: body.required_pull_request_reviews,
          enforce_admins: on(body.enforce_admins),
          required_linear_history: on(body.required_linear_history),
          allow_force_pushes: on(body.allow_force_pushes),
          allow_deletions: on(body.allow_deletions),
          required_conversation_resolution: on(body.required_conversation_resolution),
        };
        return ok({});
      }
      return p ? ok(p) : err(404, "Branch not protected");
    }
    if (path.includes("/labels")) {
      if (method === "POST") {
        state.labels.push(body);
        writes.push(`label+:${body.name}`);
        return ok(body);
      }
      if (method === "PATCH") {
        const name = decodeURIComponent(path.split("/labels/")[1] as string);
        const l = state.labels.find((x) => x.name === name);
        const { new_name, ...rest } = body;
        Object.assign(l ?? {}, rest, new_name ? { name: new_name } : {});
        writes.push(`label~:${name}`);
        return ok(l);
      }
      return ok([state.labels.slice(0, 20), state.labels.slice(20)]);
    }
    if (method === "PATCH") {
      Object.assign(state.merge, body);
      writes.push("merge");
      return ok({});
    }
    return ok({ ...state.merge, private: false, permissions: { admin: state.admin } });
  };
  return { run, writes, bodies };
}

test("apply writes the approved plan; reapply writes nothing", () => {
  const state = seed();
  const gh = fakeRepo(state);
  const plan = repoPlan(config(), gh.run);
  assert.equal(gh.writes.length, 0, "plan is read-only");
  assert.deepEqual(plan.foreign, ["bug"]);
  const r = repoApply(config(), plan.actions, gh.run);
  assert.deepEqual(r.plan.actions, []);
  assert.equal(gh.writes.filter((w) => w.startsWith("label+")).length, desired.labels.length - 13);
  assert.deepEqual(
    gh.writes.filter((w) => !w.startsWith("label")),
    ["protect:develop"],
    "main already meets its minimums",
  );
  assert.ok(
    state.labels.some((l) => l.name === "bug"),
    "foreign label kept",
  );
  assert.ok(repoValidate(config(), gh.run).every((c) => c.status !== "fail"));

  const n = gh.writes.length;
  const again = repoApply(config(), [], gh.run);
  assert.deepEqual(again.applied, []);
  assert.equal(gh.writes.length, n);
});

test("a plan that changed since approval is refused before any write", () => {
  const gh = fakeRepo(seed());
  const approved = repoPlan(config(), gh.run).actions.slice(1);
  assert.throws(
    () => repoApply(config(), approved, gh.run),
    (e: OmiError) =>
      e.code === "POLICY_VIOLATION" && /changed since it was approved/.test(e.message),
  );
  assert.deepEqual(gh.writes, []);
});

test("stricter existing protection and extra settings survive the PUT", () => {
  const state = seed();
  state.protection.develop = {
    required_status_checks: { strict: true, contexts: ["ci"] },
    required_pull_request_reviews: {
      required_approving_review_count: 2,
      dismiss_stale_reviews: true,
    },
    enforce_admins: on(false),
    required_linear_history: on(true),
    allow_force_pushes: on(false),
    allow_deletions: on(false),
    required_conversation_resolution: on(false),
    lock_branch: on(true),
  };
  const gh = fakeRepo(state);
  const plan = repoPlan(config(), gh.run);
  const protect = plan.actions.find((a) => a.kind === "protect");
  assert.deepEqual(protect, {
    kind: "protect",
    branch: "develop",
    enable: ["enforce-admins", "conversation-resolution"],
  });
  repoApply(config(), plan.actions, gh.run);
  const body = gh.bodies.develop as Record<string, unknown>;
  assert.deepEqual(body.required_status_checks, { strict: true, contexts: ["ci"] });
  assert.equal(
    (body.required_pull_request_reviews as Record<string, unknown>).required_approving_review_count,
    2,
  );
  assert.equal(body.required_linear_history, true);
  assert.equal(body.lock_branch, true);
  assert.equal(body.enforce_admins, true);
  assert.equal(body.allow_force_pushes, false);
});

test("private repo on Free: protection unsupported (D5), never written; risk acceptance warns", () => {
  const state = seed();
  state.protection = { main: "free", develop: "free" };
  const gh = fakeRepo(state);
  const plan = repoPlan(config(), gh.run);
  assert.deepEqual(
    plan.actions.filter((a) => a.kind === "unsupported").map((a) => ("what" in a ? a.what : "")),
    ["protection of main", "protection of develop"],
  );
  repoApply(config(), plan.actions, gh.run);
  assert.ok(!gh.writes.some((w) => w.startsWith("protect")));
  const status = (accepted: boolean) =>
    repoValidate(config(accepted), gh.run)
      .filter((c) => c.name.startsWith("protection"))
      .map((c) => c.status);
  assert.deepEqual(status(false), ["fail", "fail"]);
  assert.deepEqual(status(true), ["warn", "warn"]);
});

test("permission denied: no admin is refused before writing; a 403 write is an auth error", () => {
  const state = seed();
  state.admin = false;
  const gh = fakeRepo(state);
  const plan = repoPlan(config(), gh.run);
  // Protection is admin-only: reported as manual, not a cryptic 404.
  assert.deepEqual(
    plan.actions.filter((a) => a.kind === "manual").map((a) => ("reason" in a ? a.reason : "")),
    ["reading protection needs admin rights", "reading protection needs admin rights"],
  );
  assert.throws(
    () => repoApply(config(), plan.actions, gh.run),
    (e: OmiError) => e.code === "GITHUB_AUTH" && /no admin rights/.test(e.message),
  );
  assert.deepEqual(gh.writes, []);

  const denied = seed();
  denied.denyWrites = true;
  const d = fakeRepo(denied);
  assert.throws(
    () => repoApply(config(), repoPlan(config(), d.run).actions, d.run),
    (e: OmiError) => e.code === "GITHUB_AUTH",
  );
});

test("a label differing only in case is renamed; the approved plan matches after redaction", () => {
  const state = seed();
  state.labels.push({
    name: "Security",
    color: "ee0701",
    description: "Security Reviewer is mandatory",
  });
  const gh = fakeRepo(state);
  const plan = repoPlan(config(), gh.run);
  const rename = plan.actions.find((a) => a.kind === "update-label");
  assert.deepEqual(rename && "current" in rename ? [rename.current, rename.name] : [], [
    "Security",
    "security",
  ]);
  // As saved from `--output json`: the envelope, redacted.
  const file = JSON.parse(JSON.stringify({ ok: false, command: "github repo plan", data: plan }));
  repoApply(config(), approvedActions(file), gh.run);
  assert.ok(state.labels.some((l) => l.name === "security"));
  assert.ok(!state.labels.some((l) => l.name === "Security"));
  assert.throws(() => approvedActions({ actions: [], foreign: [], extra: 1 }), /--approved-plan/);
});
