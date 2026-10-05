// Finds the module specifiers of JavaScript and TypeScript imports:
// static imports and re-exports, require(), require.resolve(), import() and
// TypeScript's `import x = require()`. Only string literals in an import
// position are read, so text that merely mentions these words is ignored.

import type { ImportKind, ImportRef } from "../types";
import { lexJs, lineIndex, type JsToken } from "./scan";

const MAX_IMPORT_CLAUSE_TOKENS = 4000;
const STATEMENT_KEYWORDS = new Set(["import", "export", "const", "let", "var", "function", "class", "if", "return", "require"]);

function isStringLike(t: JsToken | undefined): t is JsToken {
  return !!t && t.closed === true && (t.type === "string" || (t.type === "template" && !t.hasSubstitutions));
}

export function parseJsImports(text: string): ImportRef[] {
  const { tokens } = lexJs(text);
  const index = lineIndex(text);
  const out: ImportRef[] = [];
  const seen = new Set<number>();

  const add = (t: JsToken, kind: ImportKind): void => {
    if (seen.has(t.start)) return;
    const value = t.value;
    if (value === "" || /[\r\n]/.test(value)) return;
    seen.add(t.start);
    out.push({
      ecosystem: "npm",
      specifier: value,
      kind,
      range: index.rangeOf(t.contentStart ?? t.start, t.contentEnd ?? t.end),
    });
  };

  const isMemberAccess = (i: number): boolean => {
    const prev = tokens[i - 1];
    return !!prev && prev.type === "punct" && prev.value === "." && !(tokens[i - 2]?.type === "punct" && tokens[i - 2]?.value === ".");
  };

  // From tokens[i] (just after `import` or `export`), skips an import or export
  // clause and returns the index of the token after `from`, or -1.
  const findFrom = (i: number): number => {
    let depth = 0;
    for (let j = i, k = 0; j < tokens.length && k < MAX_IMPORT_CLAUSE_TOKENS; j++, k++) {
      const t = tokens[j] as JsToken;
      if (t.type === "punct") {
        if (t.value === "{") depth++;
        else if (t.value === "}") depth--;
        else if (t.value === "," || t.value === "*") {
          // allowed inside and outside braces
        } else if (t.value === ";" || t.value === "(" || t.value === ")" || t.value === "=") {
          return -1;
        } else if (depth === 0) {
          return -1;
        }
        continue;
      }
      if (t.type === "ident") {
        if (t.value === "from" && depth === 0 && j > i) return j + 1;
        if (depth === 0 && STATEMENT_KEYWORDS.has(t.value)) return -1;
        continue;
      }
      if (t.type === "string" && depth > 0) continue; // import { "string name" as x } from "a"
      return -1;
    }
    return -1;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as JsToken;
    if (t.type !== "ident") continue;

    if (t.value === "import" && !isMemberAccess(i)) {
      const next = tokens[i + 1];
      if (!next) continue;
      if (next.type === "punct" && next.value === ".") continue; // import.meta
      if (next.type === "punct" && next.value === "(") {
        const arg = tokens[i + 2];
        const after = tokens[i + 3];
        if (isStringLike(arg) && after?.type === "punct" && (after.value === ")" || after.value === ",")) {
          add(arg, "dynamic-import");
        }
        continue;
      }
      if (next.type === "string") {
        if (next.closed) add(next, "import");
        continue;
      }
      // import x = require("a") (TypeScript); also `import type x = require("a")`.
      let k = i + 1;
      if (tokens[k]?.type === "ident" && tokens[k]?.value === "type" && tokens[k + 1]?.type === "ident") k++;
      if (tokens[k]?.type === "ident" && tokens[k + 1]?.type === "punct" && tokens[k + 1]?.value === "=") {
        const req = tokens[k + 2];
        const open = tokens[k + 3];
        const arg = tokens[k + 4];
        if (req?.type === "ident" && req.value === "require" && open?.value === "(" && isStringLike(arg)) {
          add(arg, "import-equals");
        }
        continue;
      }
      const fromIdx = findFrom(i + 1);
      if (fromIdx > 0 && isStringLike(tokens[fromIdx]) && tokens[fromIdx]?.type === "string") add(tokens[fromIdx] as JsToken, "import");
      continue;
    }

    if (t.value === "export" && !isMemberAccess(i)) {
      const next = tokens[i + 1];
      if (!next) continue;
      const startsClause =
        (next.type === "punct" && (next.value === "*" || next.value === "{")) ||
        (next.type === "ident" && next.value === "type" && tokens[i + 2]?.type === "punct" && (tokens[i + 2]?.value === "{" || tokens[i + 2]?.value === "*"));
      if (!startsClause) continue;
      const fromIdx = findFrom(i + 1);
      if (fromIdx > 0 && isStringLike(tokens[fromIdx]) && tokens[fromIdx]?.type === "string") add(tokens[fromIdx] as JsToken, "export-from");
      continue;
    }

    if (t.value === "require") {
      const prev = tokens[i - 1];
      if (prev && prev.type === "punct" && prev.value === ".") continue; // obj.require(...)
      let k = i + 1;
      if (tokens[k]?.type === "punct" && tokens[k]?.value === "." && tokens[k + 1]?.type === "ident" && tokens[k + 1]?.value === "resolve") k += 2;
      const open = tokens[k];
      const arg = tokens[k + 1];
      const close = tokens[k + 2];
      if (open?.type === "punct" && open.value === "(" && isStringLike(arg) && close?.type === "punct" && (close.value === ")" || close.value === ",")) {
        const prior = tokens[i - 1];
        const isEquals = prior?.type === "punct" && prior.value === "=" && tokens[i - 3]?.type === "ident" && tokens[i - 3]?.value === "import";
        if (isEquals) continue; // handled by the import branch
        add(arg, "require");
      }
    }
  }
  out.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
  return out;
}
