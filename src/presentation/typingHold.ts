// Holds back the lookup of an undeclared import on the line being typed, so
// the half-typed names an editor's auto-closed quotes expose ("l", "lo",
// "lod") are not looked up, cached as "not scored" or drawn as "scoring…".
// A line is released when the cursor leaves it, the document is saved, or no
// edit happened for a while. Pure: timers are injected.

import type { AnalysisEntry } from "../core/types";

export const TYPING_IDLE_MS = 2000;

export interface HoldTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class TypingHold {
  private readonly held = new Map<string, { line: number; timer: unknown }>();

  constructor(
    /** Called when a document's held line is released (look its imports up now). */
    private readonly onRelease: (uri: string) => void,
    private readonly timers: HoldTimers,
    private readonly idleMs = TYPING_IDLE_MS,
  ) {}

  /** An edit ended on `line` of the document. */
  edited(uri: string, line: number): void {
    const current = this.held.get(uri);
    if (current) this.timers.clearTimeout(current.timer);
    const changedLine = current !== undefined && current.line !== line;
    const timer = this.timers.setTimeout(() => this.release(uri), this.idleMs);
    this.held.set(uri, { line, timer });
    // Typing moved to another line: the previous one is finished.
    if (changedLine) this.onRelease(uri);
  }

  /** The cursor is on `line`; leaving the held line releases it. */
  cursorMoved(uri: string, line: number): void {
    const current = this.held.get(uri);
    if (current && current.line !== line) this.release(uri);
  }

  saved(uri: string): void {
    if (this.held.has(uri)) this.release(uri);
  }

  /** Forgets a closed document without a release callback. */
  forget(uri: string): void {
    const current = this.held.get(uri);
    if (current) this.timers.clearTimeout(current.timer);
    this.held.delete(uri);
  }

  /** True for an undeclared import on the line being typed. */
  holds(uri: string, entry: AnalysisEntry): boolean {
    if (!entry.target || entry.declaredIn) return false;
    return this.held.get(uri)?.line === entry.line;
  }

  dispose(): void {
    for (const h of this.held.values()) this.timers.clearTimeout(h.timer);
    this.held.clear();
  }

  private release(uri: string): void {
    const current = this.held.get(uri);
    if (!current) return;
    this.timers.clearTimeout(current.timer);
    this.held.delete(uri);
    this.onRelease(uri);
  }
}

/** The line an edit ends on: the start line plus the line breaks it inserted. */
export function lineAfterEdit(startLine: number, insertedText: string): number {
  let n = 0;
  for (const c of insertedText) if (c === "\n") n++;
  return startLine + n;
}
