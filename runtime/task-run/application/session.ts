import type { AgentObservation } from "../../harness/domain/harness.ts";

/**
 * True when a resumed run failed because the session could not be loaded, not because the agent erred.
 * An auth failure or a missing session yields no usage or zero turns; the agent's own text is not trusted.
 */
export function resumeNotLoaded(o: AgentObservation): boolean {
  return (
    o.isError &&
    (!o.usage || o.usage.numTurns === 0 || /no conversation found with session id/i.test(o.result))
  );
}
