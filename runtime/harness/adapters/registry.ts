// Picks the harness adapter by `Profile.harness` (ADR-0006 D7). A harness is added here by its
// adapter alone; `task-run` only ever sees the `Harness` port.
import type { Harness as HarnessName } from "../../shared/contracts.ts";
import type { Harness } from "../domain/harness.ts";
import { claudeCode } from "./claude-code/harness.ts";

const ADAPTERS = { claudecode: claudeCode } as const satisfies Record<HarnessName, Harness>;

export const harnessFor = (name: HarnessName = "claudecode"): Harness => ADAPTERS[name];
