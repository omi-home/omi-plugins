// Composition of the delivery workflow's ports (ADR-0006): the task-run adapters, plus the handoff
// adapter that fetches the Issue chain, plus the harness chosen by the profile. The `reports` port
// belongs to reporting, which depends on task-run, so the composition root adds it.
import { fetchIssueContext } from "../../handoff/adapters/context.ts";
import { harnessFor } from "../../harness/adapters/registry.ts";
import type { Harness } from "../../harness/domain/harness.ts";
import type { Selection } from "../../profile/domain/selection.ts";
import { runChecks } from "../adapters/checks.ts";
import { commitWork } from "../adapters/commit.ts";
import * as repository from "../adapters/repository.ts";
import { stepSkills, writeRoleFiles } from "../adapters/role-files.ts";
import { git } from "../adapters/worktree.ts";
import type { SlicePorts } from "../application/ports.ts";

export const taskRunPorts: Omit<SlicePorts, "reports"> = {
  store: repository,
  git,
  roleFiles: { stepSkills, writeRoleFiles },
  checks: { runChecks },
  commit: commitWork,
  issueContext: { fetchIssueContext },
};

/** The harness the profile names (`Profile.harness`); the default when no profile is selected. */
export const harnessOf = (selection?: Selection): Harness => harnessFor(selection?.profile.harness);
