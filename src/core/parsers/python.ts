// Finds the modules a Python file imports: `import a.b as c, d`,
// `from a.b import c`, `from a import (x, y)`, imports nested in blocks, and
// importlib.import_module("a") or __import__("a") with a literal. Strings,
// docstrings and comments are masked first, so text in them is ignored.

import type { ImportRef } from "../types";
import { lineIndex, maskRange } from "./scan";

interface PyString {
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
}

/** Masks comments and the contents of string literals; returns the masked text and the literals. */
export function maskPython(text: string): { masked: string; strings: PyString[] } {
  const units = text.split("");
  const strings: PyString[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === "#") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      maskRange(units, i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = text.startsWith(c.repeat(3), i);
      const q = triple ? c.repeat(3) : c;
      let j = i + q.length;
      let closed = false;
      while (j < n) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (!triple && text[j] === "\n") break;
        if (text.startsWith(q, j)) {
          closed = true;
          break;
        }
        j++;
      }
      const contentStart = i + q.length;
      const contentEnd = Math.min(j, n);
      strings.push({ start: i, end: closed ? j + q.length : contentEnd, contentStart, contentEnd });
      maskRange(units, contentStart, contentEnd);
      i = closed ? j + q.length : contentEnd;
      continue;
    }
    i++;
  }
  return { masked: units.join(""), strings };
}

/** Splits masked text into logical statements: [start, end) offsets. */
function statements(masked: string): [number, number][] {
  const out: [number, number][] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) {
      out.push([start, i]);
      start = i + 1;
    } else if (c === "\n" && depth === 0) {
      let k = i - 1;
      if (masked[k] === "\r") k--;
      if (masked[k] === "\\") continue;
      out.push([start, i]);
      start = i + 1;
    }
  }
  if (start < masked.length) out.push([start, masked.length]);
  return out;
}

const DOTTED = /[A-Za-z_][A-Za-z0-9_]*(?:[ \t]*\.[ \t]*[A-Za-z_][A-Za-z0-9_]*)*/y;
const IMPORT_KW = /import(?![A-Za-z0-9_])[ \t\\\r\n]+/y;
const FROM_KW = /from(?![A-Za-z0-9_])[ \t\\\r\n]*/y;
const WS = /[ \t\\\r\n]*/y;

function matchAt(re: RegExp, text: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(text);
}

function compact(name: string): string {
  return name.replace(/\s+/g, "");
}

/** The names after `import` in a from-import: `(a as b, c)` gives ["a", "c"]. */
function importedNames(rest: string): string[] {
  const body = rest.replace(/[()\\]/g, " ");
  const names: string[] = [];
  for (const part of body.split(",")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?\s*$/.exec(part);
    if (m?.[1]) names.push(m[1]);
  }
  return names;
}

export function parsePythonImports(text: string): ImportRef[] {
  const { masked, strings } = maskPython(text);
  const index = lineIndex(text);
  const out: ImportRef[] = [];

  const push = (specifier: string, start: number, end: number, kind: ImportRef["kind"], names?: string[]): void => {
    const ref: ImportRef = { ecosystem: "pypi", specifier, kind, range: index.rangeOf(start, end) };
    if (names && names.length > 0) ref.names = names;
    out.push(ref);
  };

  const parseAt = (pos: number, end: number): void => {
    let m = matchAt(IMPORT_KW, masked, pos);
    if (m && m.index + m[0].length <= end) {
      let at = m.index + m[0].length;
      for (;;) {
        const ws = matchAt(WS, masked, at);
        at += ws ? ws[0].length : 0;
        const name = matchAt(DOTTED, masked, at);
        if (!name || name.index + name[0].length > end) break;
        push(compact(name[0]), name.index, name.index + name[0].length, "python-import");
        at = name.index + name[0].length;
        // optional "as alias"
        const rest = /[ \t\\\r\n]+as[ \t\\\r\n]+[A-Za-z_][A-Za-z0-9_]*/y;
        rest.lastIndex = at;
        const as = rest.exec(masked);
        if (as && as.index + as[0].length <= end) at = as.index + as[0].length;
        const comma = /[ \t\\\r\n]*,/y;
        comma.lastIndex = at;
        const c = comma.exec(masked);
        if (!c || c.index + c[0].length > end) break;
        at = c.index + c[0].length;
      }
      return;
    }
    m = matchAt(FROM_KW, masked, pos);
    if (m) {
      let at = m.index + m[0].length;
      const nameStart = at;
      const d = matchAt(/\.*/y, masked, at);
      const dotLen = d ? d[0].length : 0;
      at += dotLen;
      let nameEnd = at;
      const name = matchAt(DOTTED, masked, at);
      if (name && !(dotLen > 0 && name[0] === "import")) nameEnd = at + name[0].length;
      if (nameEnd > end || nameEnd === nameStart) return;
      const imp = /[ \t\\\r\n]+import(?![A-Za-z0-9_])|(?<=\.)[ \t\\\r\n]*import(?![A-Za-z0-9_])/y;
      imp.lastIndex = nameEnd;
      const k = imp.exec(masked);
      if (!k || k.index + k[0].length > end) return;
      push(compact(masked.slice(nameStart, nameEnd)), nameStart, nameEnd, "python-from-import", importedNames(masked.slice(k.index + k[0].length, end)));
    }
  };

  for (const [s, e] of statements(masked)) {
    // Candidate positions: the start of the statement and after each ":" at
    // bracket depth 0 (one-line compound statements such as `try: import x`).
    const candidates: number[] = [];
    const lead = matchAt(/[ \t\r\n\\]*/y, masked, s);
    candidates.push(s + (lead ? lead[0].length : 0));
    let depth = 0;
    for (let i = s; i < e; i++) {
      const c = masked[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
      else if (c === ":" && depth === 0) {
        const ws = matchAt(/[ \t]*/y, masked, i + 1);
        candidates.push(i + 1 + (ws ? ws[0].length : 0));
      }
    }
    for (const pos of candidates) parseAt(pos, e);
  }

  // importlib.import_module("a.b") and __import__("a") with a literal argument.
  for (const str of strings) {
    if (str.contentStart - str.start !== 1) continue; // triple-quoted
    const before = masked.slice(Math.max(0, str.start - 64), str.start);
    if (!/(?:\bimport_module|\b__import__)\s*\(\s*$/.test(before)) continue;
    const prefix = text.slice(Math.max(0, str.start - 2), str.start);
    if (/[A-Za-z]$/.test(prefix)) continue; // f"", b"" and other prefixed strings
    const value = text.slice(str.contentStart, str.contentEnd);
    if (!/^\.*[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(value)) continue;
    push(value, str.contentStart, str.contentEnd, "dynamic-import");
  }

  out.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
  return out;
}
