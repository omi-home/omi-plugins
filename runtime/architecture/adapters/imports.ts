// Hand-written TS/JS import scanner (TS 7 has no JS compiler API). It tokenizes enough to skip
// comments, strings, template literals and regex literals, then reads static specifiers of
// `import … from`, `import "x"`, `export … from`, `import("x")` and `require("x")`.
// Dynamic imports with a non-literal argument are ignored.

export interface Specifier {
  specifier: string;
  line: number;
}

interface Tok {
  t: "id" | "str" | "p" | "other";
  v: string;
  line: number;
}

const ID_START = /[A-Za-z_$\u0080-￿]/;
const ID_PART = /[A-Za-z0-9_$\u0080-￿]/;
/** Keywords after which a `/` starts a regex, not a division. */
const REGEX_AFTER = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let depth = 0;
  const templates: number[] = [];

  const regexAllowed = () => {
    const p = toks[toks.length - 1];
    if (!p) return true;
    if (p.t === "id") return REGEX_AFTER.has(p.v);
    if (p.t === "str" || p.t === "other") return false;
    return !(p.v === ")" || p.v === "]" || p.v === "}");
  };

  /** Reads template text from i (just after "`" or "}") up to the closing "`" or the next "${". */
  const template = () => {
    while (i < n) {
      const c = src[i] as string;
      if (c === "\\") {
        if (src[i + 1] === "\n") line++;
        i += 2;
      } else if (c === "`") {
        i++;
        toks.push({ t: "other", v: "`", line });
        return;
      } else if (c === "$" && src[i + 1] === "{") {
        i += 2;
        templates.push(depth);
        return;
      } else {
        if (c === "\n") line++;
        i++;
      }
    }
  };

  while (i < n) {
    const c = src[i] as string;
    if (c === "\n") {
      line++;
      i++;
    } else if (c === " " || c === "\t" || c === "\r" || c === "﻿") i++;
    else if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      i += 2;
    } else if (c === '"' || c === "'") {
      const start = line;
      let v = "";
      i++;
      while (i < n && src[i] !== c && src[i] !== "\n") {
        if (src[i] === "\\" && i + 1 < n) {
          if (src[i + 1] === "\n") line++;
          v += src[i + 1];
          i += 2;
        } else v += src[i++];
      }
      i++; // closing quote (or the newline of an unterminated string)
      toks.push({ t: "str", v, line: start });
    } else if (c === "`") {
      i++;
      template();
    } else if (c === "}" && templates.length && templates[templates.length - 1] === depth) {
      templates.pop();
      i++;
      template();
    } else if (c === "/" && regexAllowed()) {
      let inClass = false;
      i++;
      while (i < n && src[i] !== "\n") {
        const d = src[i] as string;
        if (d === "\\") i++;
        else if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        i++;
      }
      i++;
      while (i < n && ID_PART.test(src[i] as string)) i++;
      toks.push({ t: "other", v: "/re/", line });
    } else if (ID_START.test(c)) {
      const s = i;
      while (i < n && ID_PART.test(src[i] as string)) i++;
      toks.push({ t: "id", v: src.slice(s, i), line });
    } else if (c >= "0" && c <= "9") {
      while (i < n && /[0-9A-Za-z_.]/.test(src[i] as string)) i++;
      toks.push({ t: "other", v: "0", line });
    } else {
      if (c === "{") depth++;
      else if (c === "}") depth--;
      toks.push({ t: "p", v: c, line });
      i++;
    }
  }
  return toks;
}

const EXPORT_STOP = new Set([
  "function",
  "class",
  "const",
  "let",
  "var",
  "default",
  "interface",
  "enum",
  "namespace",
  "declare",
  "abstract",
  "async",
  "module",
]);

export function scanImports(src: string): Specifier[] {
  const toks = tokenize(src);
  const out: Specifier[] = [];
  const isP = (t: Tok | undefined, v: string) => t?.t === "p" && t.v === v;

  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i] as Tok;
    if (tok.t !== "id" || isP(toks[i - 1], ".")) continue;
    const next = toks[i + 1];

    if (tok.v === "require" || (tok.v === "import" && isP(next, "("))) {
      const arg = toks[i + 2];
      const end = toks[i + 3];
      if (
        isP(next, "(") &&
        arg?.t === "str" &&
        (isP(end, ")") || (tok.v === "import" && isP(end, ",")))
      ) {
        out.push({ specifier: arg.v, line: arg.line });
      }
    } else if (tok.v === "import") {
      if (next?.t === "str") {
        out.push({ specifier: next.v, line: next.line });
        continue;
      }
      if (isP(next, ".")) continue; // import.meta
      for (let j = i + 1; j < toks.length && j < i + 2000; j++) {
        const t = toks[j] as Tok;
        if (isP(t, ";") || isP(t, "=") || isP(t, "(")) break;
        if (t.t === "str" && toks[j - 1]?.v === "from") {
          out.push({ specifier: t.v, line: t.line });
          break;
        }
      }
    } else if (tok.v === "export") {
      for (let j = i + 1; j < toks.length && j < i + 2000; j++) {
        const t = toks[j] as Tok;
        if (isP(t, ";") || isP(t, "=") || isP(t, "(")) break;
        if (t.t === "id" && EXPORT_STOP.has(t.v)) break;
        if (t.t === "str" && toks[j - 1]?.v === "from") {
          out.push({ specifier: t.v, line: t.line });
          break;
        }
      }
    }
  }
  const seen = new Set<string>();
  return out.filter((s) => {
    const k = `${s.line}\0${s.specifier}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
