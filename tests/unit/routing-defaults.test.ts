// #250: the agent frontmatter is only the default; it must equal the schema default of agents.routing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseConfig } from "../../runtime/shared/config.ts";
import { Role } from "../../runtime/shared/contracts.ts";

test("a removed role key in agents.routing names its replacement (CR-003)", () => {
  assert.throws(
    () =>
      parseConfig({
        github: { owner: "o", repo: "r", projectNumber: 1 },
        agents: { routing: { "backend-engineer": { model: "sonnet", effort: "low" } } },
      }),
    (e: Error) =>
      (e as { code?: string }).code === "CONFIG_INVALID" &&
      /backend-engineer → software-engineer/.test(e.message),
  );
});

test("agent-pack/agents/<role>.md model/effort equal the agents.routing defaults", () => {
  const c = parseConfig({ github: { owner: "o", repo: "r", projectNumber: 1 } });
  for (const role of Role.options) {
    const fm = readFileSync(
      new URL(`../../agent-pack/agents/${role}.md`, import.meta.url),
      "utf8",
    ).split(/\r?\n---/)[0] as string;
    const get = (k: string) => new RegExp(`^${k}:\\s*(\\S+)`, "m").exec(fm)?.[1];
    assert.deepEqual(
      { model: get("model"), effort: get("effort") },
      c.agents.routing[role],
      `${role} frontmatter drifted from the schema default`,
    );
  }
});
