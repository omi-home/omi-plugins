// `omi task analyze <n>` (PO 2026-11-18): run the analysis workflow of a Feature, Change Request
// or requirement without a worktree. Analysts read the main checkout; their sections are written
// into the Issue body; the Issue then waits for the PO (Waiting PO). A held earlier analysis is
// superseded (cancelled) by the new run. Spends tokens.
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { setStatus } from "../../github/adapters/project.ts";
import { isV2, lifecycleStart, lifecycleSync } from "../../github/cli/lifecycle.ts";
import { writeSection } from "../../handoff/adapters/context.ts";
import { loadProfiles, profileSecretResolver } from "../../profile/adapters/profile-config.ts";
import { selectProfile } from "../../profile/domain/selection.ts";
import { repo } from "../../shared/config.ts";
import type { IssueType } from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { spawnGh } from "../../shared/github/client.ts";
import { PLUGIN_ROOT } from "../../shared/plugin-paths.ts";
import { openState, statePath } from "../../shared/sqlite/db.ts";
import { fetchTicket, validateTicket } from "../../ticket/adapters/ticket.ts";
import {
  acquireLease,
  advanceRun,
  createRun,
  getRun,
  liveRun,
  releaseLease,
} from "../adapters/repository.ts";
import { parseSkillChoice } from "../adapters/role-files.ts";
import { git } from "../adapters/worktree.ts";
import { runAnalysis } from "../application/slice.ts";
import type { RunRow } from "../domain/run.ts";
import { commandEnvFor, RUN_LEASE_MS, step } from "./common.ts";
import { typeOf } from "./gates.ts";
import { harnessOf, taskRunPorts } from "./ports.ts";
import { type AgentRunDeps, blockedBy, harnessGate, planFor, type RunResult } from "./run.ts";

export function taskAnalyze(deps: AgentRunDeps, issue: number): RunResult {
  const gh = deps.gh ?? spawnGh;
  const { root, workspace, config } = repo(deps.cwd);
  const selection = selectProfile(
    loadProfiles(workspace, deps.hostEnv ?? process.env),
    deps.pick ?? {},
    profileSecretResolver(workspace, deps.hostEnv ?? process.env),
  );
  const skills = parseSkillChoice(PLUGIN_ROOT, deps.pick?.skills, deps.pick?.reason);
  const ref = { repository: `${config.github.owner}/${config.github.repo}`, number: issue };
  const ticket = fetchTicket(config, issue, gh);
  const bad = validateTicket(ticket, config).find((c) => c.status === "fail");
  if (bad) throw new OmiError(bad.code ?? "TICKET_INVALID", `${bad.name}: ${bad.detail}`);
  const plan = planFor(config, ticket, gh);
  if (plan.kind !== "analysis") {
    throw new OmiError("POLICY_VIOLATION", `${plan.workflow}: use \`omi task run ${issue}\``);
  }
  harnessGate(deps, selection);
  const file = statePath(deps.cwd);
  const db = openState(file);
  const lease = `task:${ref.repository}#${issue}`;
  const session = deps.session ?? randomUUID();
  try {
    acquireLease(db, { key: lease, holder: session, ttlMs: RUN_LEASE_MS });
    try {
      let run = liveRun(db, ref);
      if (run && run.state !== "TICKET_VALIDATED") {
        advanceRun(db, run.id, { type: "CANCEL" }); // superseded by this new analysis
        run = undefined;
      }
      run ??= createRun(db, {
        id: `${issue}-${randomUUID().slice(0, 8)}`,
        issue: ref,
        workflow: typeOf(ticket) as IssueType,
      });
      if (run.state === "CREATED") run = step(db, run, "TICKET_VALID");
      // v2 has no Analysis status: the work is "In progress" (omi move). Legacy keeps Analysis.
      const v2 = isV2(config);
      if (v2) lifecycleStart({ cwd: deps.cwd, gh, state: deps.state }, issue);
      else setStatus(config, issue, "Analysis", gh);
      const evidenceOf = (id: string) => join(dirname(file), "evidence", id);
      const ctx = runAnalysis(
        {
          db,
          config,
          gh,
          pluginRoot: PLUGIN_ROOT,
          evidenceDir: evidenceOf(run.id),
          ports: { ...taskRunPorts, reports: deps.reports },
          harness: harnessOf(selection),
          runAgent: deps.runAgent,
          hostEnv: deps.hostEnv,
          commandEnv: commandEnvFor(workspace, deps.hostEnv ?? process.env),
          selection,
          skills,
          writeSection: (section, md) => writeSection(config, issue, section, md, gh),
        },
        {
          run,
          worktree: root,
          taskRoot: join(evidenceOf(run.id), "workspace"),
          baseSha: git(["rev-parse", "HEAD"], root),
          plan,
        },
      );
      // Analysis done or an open question: either way the PO decides next.
      // v2 (no Waiting PO / direct Blocked): `omi sync`; the Coordinator moves the Issue on from there.
      const engine = v2 ? lifecycleSync({ cwd: deps.cwd, gh, state: deps.state }) : undefined;
      const status = v2
        ? null
        : setStatus(config, issue, ctx.state === "BLOCKED" ? "Blocked" : "Waiting PO", gh);
      return {
        run: getRun(db, run.id) as RunRow,
        state: ctx.state,
        round: ctx.round,
        status,
        ...(engine ? { engine } : {}),
        ...blockedBy(ctx.state, evidenceOf(run.id)),
      };
    } finally {
      releaseLease(db, { key: lease, holder: session });
    }
  } finally {
    db.close();
  }
}
