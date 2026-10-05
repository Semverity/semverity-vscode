// Low-level text scanning shared by the parsers: offset to position mapping,
// a small JavaScript lexer that understands comments, strings, template
// literals and regular expression literals, and comment masking that keeps
// every offset (masked characters become spaces, newlines are kept).

import type { TextPosition, TextRange } from "../types";

export interface LineIndex {
  positionAt(offset: number): TextPosition;
  rangeOf(start: number, end: number): TextRange;
  /** Offset of the first character of a zero-based line. */
  lineStart(line: number): number;
}

export function lineIndex(text: string): LineIndex {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  const positionAt = (offset: number): TextPosition => {
    const o = Math.max(0, Math.min(offset, text.length));
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= o) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: o - (starts[lo] ?? 0) };
  };
  return {
    positionAt,
    rangeOf: (start, end) => ({ start: positionAt(start), end: positionAt(end) }),
    lineStart: (line) => starts[Math.max(0, Math.min(line, starts.length - 1))] ?? 0,
  };
}

/** Replaces [start, end) with spaces, keeping line breaks. */
export function maskRange(chars: string[], start: number, end: number): void {
  for (let i = start; i < end; i++) {
    const c = chars[i];
    if (c !== "\n" && c !== "\r") chars[i] = " ";
  }
}

export type JsTokenType = "ident" | "punct" | "string" | "template" | "regex" | "number";

export interface JsToken {
  type: JsTokenType;
  /** Identifier name, punctuation character, or the string's decoded-enough content (escapes kept as written). */
  value: string;
  start: number;
  end: number;
  /** For strings and templates: the content offsets, without the quotes. */
  contentStart?: number;
  contentEnd?: number;
  /** For templates: true when the literal has `${...}` substitutions. */
  hasSubstitutions?: boolean;
  /** For strings and templates: false when the literal runs to the end of the line or file without its closing quote. */
  closed?: boolean;
}

const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
]);

function isIdentStart(c: string): boolean {
  return /[A-Za-z_$]/.test(c) || c.charCodeAt(0) > 0x7f;
}

function isIdentPart(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) > 0x7f;
}

export interface JsLexResult {
  tokens: JsToken[];
  /** [start, end) of every comment. */
  comments: [number, number][];
}

/** Tokenises JavaScript or TypeScript well enough to find import forms. Never throws. */
export function lexJs(text: string): JsLexResult {
  const tokens: JsToken[] = [];
  const comments: [number, number][] = [];
  // Each entry is "brace" for a plain "{", or "template" for a "${" inside a template literal.
  const braces: ("brace" | "template")[] = [];
  const n = text.length;
  let i = 0;

  const regexAllowed = (): boolean => {
    const prev = tokens[tokens.length - 1];
    if (!prev) return true;
    if (prev.type === "punct") return !(prev.value === ")" || prev.value === "]" || prev.value === "}");
    if (prev.type === "ident") return REGEX_KEYWORDS.has(prev.value);
    return false;
  };

  // Scans template characters from `from` (just after "`" or after the "}" closing a substitution).
  const scanTemplate = (tokenStart: number, from: number, continued: boolean): void => {
    let j = from;
    while (j < n) {
      const c = text[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "`") {
        tokens.push({
          type: "template",
          value: text.slice(from, j),
          start: tokenStart,
          end: j + 1,
          contentStart: from,
          contentEnd: j,
          hasSubstitutions: continued,
          closed: true,
        });
        i = j + 1;
        return;
      }
      if (c === "$" && text[j + 1] === "{") {
        tokens.push({
          type: "template",
          value: text.slice(from, j),
          start: tokenStart,
          end: j + 2,
          contentStart: from,
          contentEnd: j,
          hasSubstitutions: true,
        });
        braces.push("template");
        i = j + 2;
        return;
      }
      j++;
    }
    tokens.push({ type: "template", value: text.slice(from), start: tokenStart, end: n, contentStart: from, contentEnd: n, hasSubstitutions: continued, closed: false });
    i = n;
  };

  while (i < n) {
    const c = text[i] as string;
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v" || c === " " || c === "﻿") {
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      comments.push([i, stop]);
      i = stop;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      comments.push([i, stop]);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== "\n") {
        if (text[j] === "\\") j++;
        j++;
      }
      const closed = j < n && text[j] === c;
      tokens.push({ type: "string", value: text.slice(i + 1, Math.min(j, n)), start: i, end: closed ? j + 1 : j, contentStart: i + 1, contentEnd: Math.min(j, n), closed });
      i = closed ? j + 1 : j;
      continue;
    }
    if (c === "`") {
      scanTemplate(i, i + 1, false);
      continue;
    }
    if (c === "}" && braces[braces.length - 1] === "template") {
      braces.pop();
      scanTemplate(i, i + 1, true);
      continue;
    }
    if (c === "/" && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      let ok = false;
      while (j < n && text[j] !== "\n") {
        const d = text[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) {
          ok = true;
          break;
        }
        j++;
      }
      if (ok) {
        j++;
        while (j < n && isIdentPart(text[j] as string)) j++;
        tokens.push({ type: "regex", value: text.slice(i, j), start: i, end: j });
        i = j;
        continue;
      }
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(text[j] as string)) j++;
      tokens.push({ type: "ident", value: text.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(text[j] as string)) j++;
      tokens.push({ type: "number", value: text.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    if (c === "{") braces.push("brace");
    else if (c === "}") braces.pop();
    tokens.push({ type: "punct", value: c, start: i, end: i + 1 });
    i++;
  }
  return { tokens, comments };
}

/** Masks JavaScript and TypeScript comments, respecting strings, templates and regular expressions. */
export function stripJsComments(text: string): string {
  const { comments } = lexJs(text);
  if (comments.length === 0) return text;
  // split("") works on UTF-16 units, so offsets hold.
  const units = text.split("");
  for (const [s, e] of comments) maskRange(units, s, e);
  return units.join("");
}

/** Masks Go comments, respecting interpreted strings, raw strings and runes. */
export function stripGoComments(text: string): string {
  const units = text.split("");
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      maskRange(units, i, stop);
      i = stop;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      maskRange(units, i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== "\n") {
        if (text[j] === "\\") j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      i = end < 0 ? n : end + 1;
      continue;
    }
    i++;
  }
  return units.join("");
}
