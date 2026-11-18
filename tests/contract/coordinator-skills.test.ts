// Feature-0023 #143: daily-operation skills are thin entry points that only call the omi CLI
// (Script first, ADR-0001 D3): valid frontmatter, every command they name exists in `omi help`,
// no raw git/gh/npm steps.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HELP } from "../../runtime/cli/main.ts";

/** Skill → minimum number of `omi …` commands it must name. */
const SCRIPT_ONLY = { "omi-resume": 6, "omi-status": 3 };

for (const [name, min] of Object.entries(SCRIPT_ONLY)) {
  test(`skills/${name} has frontmatter and only calls omi commands`, () => {
    const text = readFileSync(new URL(`../../skills/${name}/SKILL.md`, import.meta.url), "utf8");
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
    assert.match(front, new RegExp(`^name: ${name}$`, "m"));
    assert.match(front, /^description: .{40,}$/m);
    assert.match(text, /resources\/role-rules\//, "must forbid reading role-rules");

    const code = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] as string);
    const commands = code.filter((c) => /^omi /.test(c));
    assert.ok(commands.length >= min, `${name}: ${commands.length} omi commands`);
    for (const c of commands) {
      // Every leading word is the command: `omi task status <n>` → "task status".
      const words = c.split(" ").slice(1);
      const end = words.findIndex((w) => !/^[a-z]+$/.test(w));
      const cmd = (end < 0 ? words : words.slice(0, end)).join(" ");
      assert.match(HELP, new RegExp(`^  ${cmd}(\\s|$)`, "m"), `unknown command in ${name}: ${c}`);
    }
    for (const c of code) assert.doesNotMatch(c, /^(git|gh|npm|node) /, `raw step: ${c}`);
  });
}
