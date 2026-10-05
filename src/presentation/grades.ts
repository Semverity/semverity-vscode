// Grades, grade colours and the score a surface shows for a card. Pure.

import type { Grade } from "../core/api/types";
import type { CardSummary } from "../core/types";

/** Best to worst. */
export const GRADE_ORDER: readonly Grade[] = ["A", "B", "C", "D", "F"];

/** Which score the thresholds and summaries read. */
export type ScoreBasis = "headline" | "own";

/** Colour id contributed in package.json for a grade; `semverity.unscored` when there is none. */
export function colorIdFor(grade: Grade | undefined): string {
  return grade ? `semverity.grade${grade}` : "semverity.unscored";
}

/**
 * Hex values of the contributed colour defaults (package.json `contributes.colors`),
 * used where a ThemeColor cannot be (the shield icon is an SVG data URI).
 */
export const GRADE_HEX: Record<"dark" | "light", Record<Grade | "none", string>> = {
  dark: { A: "#4ade80", B: "#a3e635", C: "#facc15", D: "#fb923c", F: "#f87171", none: "#9ca3af" },
  light: { A: "#15803d", B: "#4d7c0f", C: "#a16207", D: "#c2410c", F: "#b91c1c", none: "#6b7280" },
};

/** The score bands of the Semverity grade (A >= 90, B >= 80, C >= 65, D >= 50, else F). */
export function gradeForScore(score: number): Grade {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 65) return "C";
  if (score >= 50) return "D";
  return "F";
}

export interface BasisScore {
  score: number;
  grade: Grade;
  /** The headline is an upper bound (dependencies not all scored). */
  atMost: boolean;
  /** "with_dependencies" when the score includes dependencies, else "own". */
  includes: "with_dependencies" | "own";
}

/**
 * The score shown for a card under a basis. The headline falls back to the own
 * score when the server sent no headline; the own score falls back to `overall`.
 */
export function scoreFor(card: CardSummary, basis: ScoreBasis): BasisScore | undefined {
  if (basis === "headline" && card.headline) {
    return {
      score: card.headline.score,
      grade: card.headline.grade,
      atMost: card.headline.at_most,
      includes: card.headline.basis,
    };
  }
  if (card.own) return { score: card.own.score, grade: card.own.grade, atMost: false, includes: "own" };
  if (typeof card.overall === "number" && Number.isFinite(card.overall)) {
    return { score: card.overall, grade: gradeForScore(card.overall), atMost: false, includes: "own" };
  }
  return undefined;
}

/** The worse of two grades; undefined only when both are. */
export function worse(a: Grade | undefined, b: Grade | undefined): Grade | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return GRADE_ORDER.indexOf(a) >= GRADE_ORDER.indexOf(b) ? a : b;
}

/** A 12 px shield in the given colour, as SVG source (the adapter turns it into a data URI). */
export function shieldSvg(hex: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 16 16">` +
    `<path fill="${hex}" d="M8 1 2 3.5v4.1c0 3.4 2.5 6.4 6 7.4 3.5-1 6-4 6-7.4V3.5L8 1z"/></svg>`
  );
}
