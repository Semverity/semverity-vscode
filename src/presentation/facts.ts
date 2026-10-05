// Facts every surface derives the same way from a card: the critical findings
// (malware and KEV, own or inherited on an installed path) and the other gates.

import type { CardSummary, FiredGate } from "../core/types";

export type CriticalGate = "malware" | "kev";

export interface CriticalFinding {
  gate: CriticalGate;
  /** True when the package itself carries the gate; false when a dependency does. */
  own: boolean;
  reason?: string;
  recommendation?: string;
  /** Depth of the nearest dependency that carries it (inherited findings). */
  depth?: number;
}

export const CRITICAL_GATES: readonly CriticalGate[] = ["malware", "kev"];

function isCritical(id: string): id is CriticalGate {
  return id === "malware" || id === "kev";
}

/** Malware and KEV findings of a card, own findings first; inherited ones count only on an installed path. */
export function criticalFindings(card: CardSummary): CriticalFinding[] {
  const out: CriticalFinding[] = [];
  for (const gate of CRITICAL_GATES) {
    const own = card.gates.find((g) => g.id === gate);
    if (own) {
      out.push({ gate, own: true, reason: own.reason, recommendation: own.recommendation });
      continue;
    }
    const inherited = card.inheritedGates
      .filter((g) => g.gate === gate && g.path_class === "installed")
      .sort((a, b) => a.nearest_depth - b.nearest_depth)[0];
    if (inherited) out.push({ gate, own: false, depth: inherited.nearest_depth });
  }
  return out;
}

/** Fired gates of the card other than malware and KEV. */
export function otherGates(card: CardSummary): FiredGate[] {
  return card.gates.filter((g) => !isCritical(g.id));
}

/** Fired hard gates other than malware and KEV (the decoration's "n gates"). */
export function otherHardGates(card: CardSummary): FiredGate[] {
  return otherGates(card).filter((g) => g.hard);
}
