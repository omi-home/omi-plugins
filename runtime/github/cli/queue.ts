// `omi queue` and `omi inbox` under model v2 (Feature-0039 #298, ChangeRequest-0013 #302 §9.4/§9.6):
// read-only views of what the Coordinator has to do and what waits for the PO. They fetch the Project,
// read the snapshot and the open runs from state.sqlite, and write nothing (not GitHub, not the state).
import { spawnGh } from "../../shared/github/client.ts";
import { redact } from "../../shared/redact.ts";
import type { Db } from "../../shared/sqlite/db.ts";
import { fetchProjectIssues } from "../adapters/project-fetch.ts";
import { readPoDecisions } from "../adapters/snapshot-store.ts";
import { buildProjectModel } from "../domain/build-model.ts";
import { poInboxGroups, workQueue } from "../domain/work-queues.ts";
import type { GithubCliResult } from "./github.ts";
import { requireV2, type StateDeps } from "./state.ts";

const lines = (l: string[]) => l.map((s) => `${s}\n`).join("");

function fetchModel(deps: StateDeps) {
  const { issues, foreign } = fetchProjectIssues(deps.config, deps.run ?? spawnGh);
  const built = buildProjectModel(issues, deps.workflow);
  const titles = new Map(issues.map((i) => [i.number, i.title ?? ""]));
  return { ...built, titles, foreign };
}

export interface QueueDeps extends StateDeps {
  /** Issues of `repository` that have an open run (built by the caller from task-run's open runs). */
  openRunIssues: (repository: string, db: Db) => ReadonlySet<number>;
}

/** `omi queue`: Ready not yet taken (no open run), Rework, the PO decisions the last sync accepted. */
export function projectQueue(deps: QueueDeps): GithubCliResult {
  requireV2(deps.config, "queue");
  const { owner, repo, projectNumber } = deps.config.github;
  const key = `${owner}/${repo}`;
  const { items, titles, skipped, foreign } = fetchModel(deps);
  const db = deps.db();
  const queue = workQueue(
    {
      items,
      titles,
      poDecisions: readPoDecisions(db, key, projectNumber),
      openRunIssues: deps.openRunIssues(key, db),
    },
    deps.workflow,
  );
  const human = queue.length
    ? queue.map(
        (q) => `#${q.issue} ${q.type} [${q.status}] ${q.title || "(no title)"} - ${q.reason}`,
      )
    : ["queue     nothing for the Coordinator"];
  return { data: { queue, skipped, foreign }, human: redact(lines(human)) };
}

/** `omi inbox`: items waiting for the PO at Awaiting PO and Acceptance, grouped by status. */
export function projectInbox(deps: StateDeps): GithubCliResult {
  requireV2(deps.config, "inbox");
  const { items, titles, skipped, foreign } = fetchModel(deps);
  const inbox = poInboxGroups(items, titles, deps.workflow);
  const human = inbox.some((g) => g.items.length)
    ? inbox.flatMap((g) => [
        `${g.status} (${g.items.length})`,
        ...g.items.map((i) => `  #${i.issue} ${i.type} ${i.title || "(no title)"}`),
      ])
    : ["inbox     nothing waiting for the PO"];
  return { data: { inbox, skipped, foreign }, human: redact(lines(human)) };
}
