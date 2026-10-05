// Finds Go import paths: `import "p"`, `import name "p"`, `import _ "p"`,
// `import . "p"` and grouped `import ( ... )` blocks, with interpreted or raw
// string paths. Comments are masked first.

import type { ImportRef } from "../types";
import { lineIndex, stripGoComments } from "./scan";

const SPEC = /^[ \t]*(?:([A-Za-z_][A-Za-z0-9_]*|\.)[ \t]+)?("([^"\\\n]*)"|`([^`]*)`)/;

export function parseGoImports(text: string): ImportRef[] {
  // Imports precede every other top-level declaration, so the scan stops at the first one.
  const full = stripGoComments(text);
  const firstDecl = /^(?:func|var|const|type)\b/m.exec(full);
  const masked = firstDecl ? full.slice(0, firstDecl.index) : full;
  const index = lineIndex(text);
  const out: ImportRef[] = [];

  const addSpec = (specText: string, specOffset: number): void => {
    const m = SPEC.exec(specText);
    if (!m) return;
    const path = m[3] ?? m[4] ?? "";
    if (path === "") return;
    const quoteOffset = specOffset + (m.index ?? 0) + m[0].length - (m[2]?.length ?? 0);
    const start = quoteOffset + 1;
    out.push({ ecosystem: "golang", specifier: path, kind: "go-import", range: index.rangeOf(start, start + path.length) });
  };

  const re = /(^|[\s;}])import(?=[\s("`])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    let at = m.index + m[0].length;
    while (at < masked.length && /[ \t\r\n]/.test(masked[at] as string)) at++;
    if (masked[at] === "(") {
      const close = findGroupClose(masked, at + 1);
      const body = masked.slice(at + 1, close);
      let offset = at + 1;
      // One spec per line or per ";" in the group.
      for (const part of body.split(/(\n|;)/)) {
        if (part !== "\n" && part !== ";") addSpec(part, offset);
        offset += part.length;
      }
      re.lastIndex = close + 1;
    } else {
      const lineEnd = masked.indexOf("\n", at);
      addSpec(masked.slice(at, lineEnd < 0 ? masked.length : lineEnd), at);
    }
  }
  return out;
}

function findGroupClose(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === ")") return i;
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"' && text[i] !== "\n") {
        if (text[i] === "\\") i++;
        i++;
      }
    } else if (c === "`") {
      const end = text.indexOf("`", i + 1);
      i = end < 0 ? text.length : end;
    }
    i++;
  }
  return text.length;
}
