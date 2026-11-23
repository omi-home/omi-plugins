// DevTask-0142 #407 probe: what Claude Code (-p, stream-json) does with --session-id / --resume.
// Live runs cost tokens: opt in with OMI_LIVE=1. The outcome of each branch is recorded in
// docs/runbooks/operations.md (mục "Session agent"); a branch that fails means the runtime falls
// back to a new session with the full packet, so nothing here is assumed by the product code.
//   (a) --session-id <uuid> without --no-session-persistence stores the session under CLAUDE_CONFIG_DIR
//   (b) --resume <uuid> with a new prompt remembers the first one
//   (c) --resume with another profile's CLAUDE_CODE_OAUTH_TOKEN (OMI_PROBE_TOKEN_2) still runs
//   (d) --agent / --allowedTools / --model passed again on resume take effect (observed model)
import "../../support/isolate-profile-db.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnAgent } from "../../../runtime/harness/adapters/claude-code/harness.ts";
import {
  buildAgentLaunch,
  observeRun,
} from "../../../runtime/harness/adapters/claude-code/launch.ts";
import type { AgentLaunch } from "../../../runtime/harness/domain/harness.ts";

const pluginRoot = fileURLToPath(new URL("../../../", import.meta.url)).replace(/[\\/]$/, "");
const hasClaude = spawnSync("claude", ["--version"]).status === 0;
const live = hasClaude && process.env.OMI_LIVE === "1";
const skip = !live && "set OMI_LIVE=1 (costs tokens)";

/** The launch of the engineer; `plain` drops the agent and plugin so the answer is free text. */
function launch(o: {
  taskRoot: string;
  prompt: string;
  session: { mode: "new" | "resume"; id: string };
  plain?: boolean;
  model?: string;
  token?: string;
  allowedTools?: string[];
}): AgentLaunch {
  const repo = join(o.taskRoot, "repo");
  mkdirSync(repo, { recursive: true });
  const l = buildAgentLaunch({
    pluginRoot,
    role: "software-engineer",
    taskRoot: o.taskRoot,
    worktree: repo,
    prompt: o.prompt,
    session: o.session,
    ...(o.allowedTools ? { allowedTools: o.allowedTools } : {}),
    ...(o.model ? { route: { model: o.model, effort: "low" } } : {}),
  });
  const drop = (args: string[], flag: string) => {
    const i = args.indexOf(flag);
    return i < 0 ? args : [...args.slice(0, i), ...args.slice(i + 2)];
  };
  const args = o.plain ? drop(drop(l.args, "--agent"), "--plugin-dir") : l.args;
  return { ...l, args, env: o.token ? { ...l.env, CLAUDE_CODE_OAUTH_TOKEN: o.token } : l.env };
}

const files = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? files(p) : [p];
      })
    : [];

test("live (a)+(b): --session-id stores the session under CLAUDE_CONFIG_DIR; --resume remembers it", {
  skip,
}, () => {
  const taskRoot = mkdtempSync(join(tmpdir(), "omi-probe-"));
  const id = randomUUID();
  const word = `kiwi-${randomUUID().slice(0, 8)}`;
  const first = launch({
    taskRoot,
    plain: true,
    session: { mode: "new", id },
    prompt: `The code word is ${word}. Reply with the single word OK.`,
  });
  const a = observeRun(spawnAgent(first));
  assert.equal(a.isError, false, a.result);
  assert.ok(
    files(first.configDir).some((f) => f.includes(id)),
    "(a) a file named after the session id exists under CLAUDE_CONFIG_DIR",
  );
  const again = launch({
    taskRoot,
    plain: true,
    session: { mode: "resume", id },
    prompt: "What was the code word? Reply with the word only.",
  });
  const b = observeRun(spawnAgent(again));
  assert.equal(b.isError, false, b.result);
  assert.ok(b.result.includes(word), `(b) resumed session remembers: ${b.result}`);
});

test("live (c): resume with another profile's token (OMI_PROBE_TOKEN_2)", {
  skip:
    skip || (!process.env.OMI_PROBE_TOKEN_2 && "set OMI_PROBE_TOKEN_2 (a second profile's token)"),
}, () => {
  const taskRoot = mkdtempSync(join(tmpdir(), "omi-probe-"));
  const id = randomUUID();
  const word = `plum-${randomUUID().slice(0, 8)}`;
  observeRun(
    spawnAgent(
      launch({
        taskRoot,
        plain: true,
        session: { mode: "new", id },
        prompt: `The code word is ${word}. Reply OK.`,
      }),
    ),
  );
  const r = observeRun(
    spawnAgent(
      launch({
        taskRoot,
        plain: true,
        token: process.env.OMI_PROBE_TOKEN_2,
        session: { mode: "resume", id },
        prompt: "What was the code word? Reply with the word only.",
      }),
    ),
  );
  // Either outcome is a result to record; the runtime handles an error by starting a new session.
  console.log(`probe (c): isError=${r.isError} remembers=${r.result.includes(word)}`);
});

test("live (d): --agent, --allowedTools and --model passed again on resume take effect", {
  skip,
}, () => {
  const taskRoot = mkdtempSync(join(tmpdir(), "omi-probe-"));
  const id = randomUUID();
  const base = { taskRoot, prompt: "Reply with the single word OK." };
  const a = observeRun(
    spawnAgent(launch({ ...base, session: { mode: "new", id }, model: "sonnet" })),
  );
  assert.match(a.actualModel, /^claude-sonnet-/);
  const l = launch({ ...base, session: { mode: "resume", id }, model: "haiku" });
  assert.ok(l.args.includes("--agent") && l.args.includes("--model"));
  const r = observeRun(spawnAgent(l));
  assert.match(r.actualModel, /^claude-haiku-/, "(d) --model on resume is observed");
});

test("live (d2): --allowedTools and --agent still bind after --resume (a tool outside the list is refused)", {
  skip,
}, () => {
  const taskRoot = mkdtempSync(join(tmpdir(), "omi-probe-"));
  const id = randomUUID();
  const probe = "Run the shell command `curl --version` with the Bash tool, then reply DONE.";
  const allowedTools = ["Bash(git status)"];
  spawnAgent(launch({ taskRoot, session: { mode: "new", id }, prompt: "Reply OK.", allowedTools }));
  const l = launch({ taskRoot, session: { mode: "resume", id }, prompt: probe, allowedTools });
  const i = l.args.indexOf("--allowedTools");
  assert.ok(i >= 0 && l.args.includes("--agent"), "both flags are passed on resume");
  assert.ok(!l.args[i + 1]?.includes("curl"), "curl is outside the allow-list");
  const r = observeRun(spawnAgent(l));
  assert.ok(
    r.permissionDenials.some((d) => d.includes("curl")),
    `(d) a tool outside --allowedTools is still refused after --resume: ${r.permissionDenials.join("|")}`,
  );
});
