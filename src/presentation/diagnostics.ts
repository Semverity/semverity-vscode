// Problems entries for one analysed entry (docs/DESIGN.md 9.6). Pure.

import { packagePageUrl } from "../core/api/purl";
import type { AnalysisEntry, LookupResult, TextRange } from "../core/types";
import { scoreFor } from "./grades";
import { criticalFindings, otherGates } from "./facts";
import { gateLabelInline } from "./labels";
import type { PresentationSettings } from "./settings";

export type DiagnosticCode = "malware" | "kev" | "gate" | "score";

export interface DiagnosticSpec {
  range: TextRange;
  severity: "error" | "warning" | "information";
  message: string;
  code: DiagnosticCode;
  /** Package page URL (the diagnostic code's link). */
  target: string;
}

type DiagnosticSettings = Pick<PresentationSettings, "scoreBasis" | "warningBelow" | "errorBelow" | "gates" | "siteBaseUrl">;

/** At most three diagnostics for an entry; only scored results produce any. */
export function diagnosticsFor(entry: AnalysisEntry, result: LookupResult | undefined, s: DiagnosticSettings): DiagnosticSpec[] {
  if (!result || result.state !== "scored") return [];
  const { card, coordinate } = result;
  const who = `${coordinate.name} ${coordinate.version}`;
  const suffix = result.stale ? " (cached)" : "";
  const target = packagePageUrl(s.siteBaseUrl, coordinate, coordinate.version);
  const out: DiagnosticSpec[] = [];
  const make = (severity: DiagnosticSpec["severity"], code: DiagnosticCode, message: string): DiagnosticSpec => ({
    range: entry.range,
    severity,
    code,
    message: message + suffix,
    target,
  });

  // 1 and 2: malware and KEV, combined into one error when both fire.
  const critical = criticalFindings(card);
  if (critical.length > 0) {
    const parts = critical.map((f, i) => {
      const subject = i === 0 ? who : "it";
      if (f.own) {
        const what = f.gate === "malware" ? "has a malware finding" : "is affected by a known exploited vulnerability";
        return f.reason ? `${subject} ${what}: ${f.reason}` : `${subject} ${what}`;
      }
      const what = f.gate === "malware" ? "a package with a malware finding" : "a package affected by a known exploited vulnerability";
      return `${subject} ${i === 0 ? "pulls" : "also pulls"} in ${what}${f.depth !== undefined ? ` (depth ${f.depth})` : ""}`;
    });
    const first = critical[0];
    out.push(make("error", first?.gate === "malware" ? "malware" : "kev", parts.join("; ")));
  }

  // 3: the other gates the settings list.
  const listed = otherGates(card).filter((g) => s.gates.includes(g.id));
  if (listed.length > 0) {
    const text = listed
      .map((g) => (g.recommendation ? `${gateLabelInline(g.id)} (${g.recommendation})` : gateLabelInline(g.id)))
      .join("; ");
    out.push(make("warning", "gate", `${who}: ${text}`));
  }

  // 4: the score against the thresholds (compared rounded, as it is shown).
  const basis = scoreFor(card, s.scoreBasis);
  if (basis) {
    const shown = Math.round(basis.score);
    let severity: "error" | "warning" | undefined;
    let threshold = 0;
    if (s.errorBelow > 0 && shown < s.errorBelow) {
      severity = "error";
      threshold = s.errorBelow;
    } else if (s.warningBelow > 0 && shown < s.warningBelow) {
      severity = "warning";
      threshold = s.warningBelow;
    }
    if (severity) {
      const how =
        s.scoreBasis === "own"
          ? "on its own"
          : basis.includes === "with_dependencies"
            ? "with its dependencies"
            : "on its own (dependencies not scored yet)";
      const value = basis.atMost ? `at most ${shown}` : String(shown);
      out.push(make(severity, "score", `${who} scores ${value} (${basis.grade}) ${how}, below ${threshold}`));
    }
  }
  return out;
}
