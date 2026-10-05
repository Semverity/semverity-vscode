// The compact text shown after an import or manifest line (docs/DESIGN.md 9.4). Pure.

import type { Grade } from "../core/api/types";
import type { AnalysisEntry, LookupResult } from "../core/types";
import { colorIdFor, scoreFor, worse } from "./grades";
import { criticalFindings, otherHardGates } from "./facts";
import { formatScore } from "./labels";
import type { PresentationSettings } from "./settings";

export interface DecorationSpec {
  text: string;
  colorId: string;
  iconGrade: Grade | "none";
  muted: boolean;
}

export interface LineItem {
  entry: AnalysisEntry;
  result?: LookupResult;
  /** An undeclared import on the line being typed: not looked up yet, and not drawn as "scoring…". */
  held?: boolean;
}

interface Piece {
  label: string;
  text: string;
  /** Grade for colour and the worst-of rule; undefined for muted pieces. */
  grade?: Grade;
  muted: boolean;
}

function pieceFor(item: LineItem, s: Pick<PresentationSettings, "showUnscored">): Piece | undefined {
  const { entry, result } = item;
  const label = entry.label;
  if (entry.excluded) return s.showUnscored ? { label, text: "excluded", muted: true } : undefined;
  if (entry.skip || !entry.target) return undefined;
  if (!result) return s.showUnscored && !item.held ? { label, text: "scoring…", muted: true } : undefined;
  switch (result.state) {
    case "scored": {
      const card = result.card;
      const stale = result.stale ? " (cached)" : "";
      const critical = criticalFindings(card);
      const head = scoreFor(card, "headline");
      if (critical.some((c) => c.gate === "malware")) {
        return { label, text: `malware${stale}`, grade: "F", muted: false };
      }
      if (critical.some((c) => c.gate === "kev")) {
        const score = head ? ` · ${formatScore(head.score, head.atMost)} ${head.grade}` : "";
        return { label, text: `KEV${score}${stale}`, grade: "F", muted: false };
      }
      if (!head) return s.showUnscored ? { label, text: `not scored${stale}`, muted: true } : undefined;
      const hard = otherHardGates(card).length;
      const gates = hard > 0 ? ` · ${hard} ${hard === 1 ? "gate" : "gates"}` : "";
      return { label, text: `${formatScore(head.score, head.atMost)} ${head.grade}${gates}${stale}`, grade: head.grade, muted: false };
    }
    case "not_scored":
      return s.showUnscored ? { label, text: "not scored", muted: true } : undefined;
    case "pending":
      return s.showUnscored ? { label, text: "scoring…", muted: true } : undefined;
    case "disabled":
    case "offline":
    case "rate_limited":
    case "error":
      return undefined;
  }
}

/**
 * The decoration of one line from its entries, or undefined when nothing on the
 * line is shown. One entry shows its text alone; several list `name text` joined
 * with " · " and take the colour of the worst grade.
 */
export function decorationFor(items: readonly LineItem[], s: Pick<PresentationSettings, "showUnscored">): DecorationSpec | undefined {
  const pieces: Piece[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const p = pieceFor(item, s);
    if (!p) continue;
    if (seen.has(p.label)) continue;
    seen.add(p.label);
    pieces.push(p);
  }
  if (pieces.length === 0) return undefined;
  let grade: Grade | undefined;
  for (const p of pieces) grade = worse(grade, p.grade);
  const text = pieces.length === 1 ? (pieces[0] as Piece).text : pieces.map((p) => `${p.label} ${p.text}`).join(" · ");
  return {
    text,
    colorId: colorIdFor(grade),
    iconGrade: grade ?? "none",
    muted: grade === undefined,
  };
}

/** Groups entries by line, in line order. */
export function groupByLine<T extends { entry: AnalysisEntry }>(items: readonly T[]): Map<number, T[]> {
  const lines = new Map<number, T[]>();
  for (const item of [...items].sort((a, b) => a.entry.line - b.entry.line)) {
    const list = lines.get(item.entry.line);
    if (list) list.push(item);
    else lines.set(item.entry.line, [item]);
  }
  return lines;
}
