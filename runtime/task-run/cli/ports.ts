// Composition of the delivery workflow's ports (ADR-0006): the task-run adapters, plus the handoff
// adapter that fetches the Issue chain, plus the harness chosen by the profile. The `reports` port
// belongs to reporting, which depends on task-run, so the composition root adds it.
import { fetchIssueContext } from "../../handoff/adapters/context.ts";
import { harnessFor } from "../../harness/adapters/registry.ts";
import type { Harness } from "../../harness/domain/harness.ts";
import type { Selection } from "../../profile/domain/selection.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { runChecks } from "../adapters/checks.ts";
import { commitWork } from "../adapters/commit.ts";
import { runRegressionProof } from "../adapters/regression.ts";
import * as repository from "../adapters/repository.ts";
import { stepSkills, writeRoleFiles } from "../adapters/role-files.ts";
import { git, readMarker } from "../adapters/worktree.ts";
import type { SlicePorts } from "../application/ports.ts";

export const taskRunPorts: Omit<SlicePorts, "reports"> = {
  store: repository, // incl. `upsertReport`
  git,
  workspace: {
    ownedBranch(worktree) {
      const marker = readMarker(worktree);
      if (!marker)
        throw new OmiError("OWNERSHIP_MISMATCH", "task workspace has no OMI ownership marker", {
          path: worktree,
        });
      return marker.branch;
    },
  },
  roleFiles: { stepSkills, writeRoleFiles },
  checks: { runChecks },
  regression: { runProof: runRegressionProof },
  commit: commitWork,
  issueContext: { fetchIssueContext },
};

/** The harness the profile names (`Profile.harness`); the default when no profile is selected. */
export const harnessOf = (selection?: Selection): Harness => harnessFor(selection?.profile.harness);
