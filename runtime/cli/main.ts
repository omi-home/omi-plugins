// OMI CLI entry. Pure function of argv/cwd → {code, stdout, stderr}; bin/omi does the I/O.
// Everything leaving the process goes through redact.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { OmiError } from "../core/errors/errors.ts";
import { redact, redactDeep } from "../reporting/redact.ts";
import { type Check, doctor } from "./doctor.ts";

export const HELP = `Usage: omi <command> [--output human|json]

Commands:
  doctor    Check tools, repository, AGENTS.md, .omi/config.yaml and GitHub access
  version   Print the OMI version
  help      Show this help

Exit codes: 0 ok, 1 failed check or error, 2 usage error, 75 transient error (retry)
`;

export const EXIT = { ok: 0, failed: 1, usage: 2, transient: 75 } as const;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const VERSION: string = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;

const humanChecks = (checks: Check[]) =>
  checks
    .map((c) => `${c.status.toUpperCase().padEnd(5)} ${c.name.padEnd(18)} ${c.detail}\n`)
    .join("");

export function main(argv: string[], cwd = process.cwd()): CliResult {
  // Decided before parsing so that usage errors are structured too.
  const json = argv.some(
    (a, i) => a === "--output=json" || (a === "json" && argv[i - 1] === "--output"),
  );
  let command = "";
  const envelope = (body: object) =>
    `${JSON.stringify(redactDeep({ ok: false, command, ...body }))}\n`;
  const ok = (data: unknown, human: string, code: number = EXIT.ok): CliResult => ({
    code,
    stdout: json ? envelope({ ok: code === EXIT.ok, data }) : redact(human),
    stderr: "",
  });

  try {
    let parsed: ReturnType<typeof parse>;
    try {
      parsed = parse(argv);
    } catch (e) {
      throw new OmiError("USAGE_INVALID", (e as Error).message);
    }
    const { values, positionals } = parsed;
    if (values.output !== "human" && values.output !== "json") {
      throw new OmiError("USAGE_INVALID", "--output must be human or json");
    }
    command = values.help ? "help" : (positionals[0] ?? "");
    if (positionals.length > 1) {
      throw new OmiError("USAGE_INVALID", `unexpected argument: ${positionals[1]}`);
    }

    switch (command) {
      case "help":
        return ok({ help: HELP }, HELP);
      case "version":
        return ok({ omi: VERSION }, `omi ${VERSION}\n`);
      case "doctor": {
        const checks = doctor(cwd);
        const failed = checks.some((c) => c.status === "fail");
        return ok({ checks }, humanChecks(checks), failed ? EXIT.failed : EXIT.ok);
      }
      case "":
        throw new OmiError("USAGE_INVALID", "missing command (see `omi help`)");
      default:
        throw new OmiError("USAGE_INVALID", `unknown command: ${command} (see \`omi help\`)`);
    }
  } catch (e) {
    const err = e instanceof OmiError ? e : new OmiError("INTERNAL", "unexpected error");
    const code =
      err.code === "USAGE_INVALID" ? EXIT.usage : err.transient ? EXIT.transient : EXIT.failed;
    return json
      ? { code, stdout: envelope({ error: err.toJSON() }), stderr: "" }
      : { code, stdout: "", stderr: `omi: ${err.code}: ${err.message}\n` };
  }
}

const parse = (args: string[]) =>
  parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      output: { type: "string", default: "human" },
      help: { type: "boolean", short: "h" },
    },
  });
