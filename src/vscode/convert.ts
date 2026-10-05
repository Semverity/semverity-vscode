// Conversions between the core's plain ranges and vscode ranges.

import * as vscode from "vscode";
import type { TextPosition, TextRange } from "../core/types";

export function toRange(r: TextRange): vscode.Range {
  return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
}

export function fromRange(r: vscode.Range): TextRange {
  return {
    start: { line: r.start.line, character: r.start.character },
    end: { line: r.end.line, character: r.end.character },
  };
}

export function containsPosition(r: TextRange, p: TextPosition): boolean {
  const afterStart = p.line > r.start.line || (p.line === r.start.line && p.character >= r.start.character);
  const beforeEnd = p.line < r.end.line || (p.line === r.end.line && p.character <= r.end.character);
  return afterStart && beforeEnd;
}

export function sameRange(a: TextRange, b: TextRange): boolean {
  return (
    a.start.line === b.start.line &&
    a.start.character === b.start.character &&
    a.end.line === b.end.line &&
    a.end.character === b.end.character
  );
}
