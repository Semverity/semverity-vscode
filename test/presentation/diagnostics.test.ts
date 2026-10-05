import { describe, expect, it } from "vitest";
import { diagnosticsFor } from "../../src/presentation/diagnostics";
import { DEFAULT_PRESENTATION_SETTINGS, type PresentationSettings } from "../../src/presentation/settings";
import { card, entry, gate, headline, scored } from "../helpers/cards";

const s: PresentationSettings = DEFAULT_PRESENTATION_SETTINGS;
const page = "https://semverity.dev/registry/npm/lodash/versions/4.17.21";

describe("diagnosticsFor", () => {
  it("reports nothing for a healthy package or an unscored result", () => {
    expect(diagnosticsFor(entry(), scored(card({ headline: headline(83, "B") })), s)).toEqual([]);
    expect(diagnosticsFor(entry(), undefined, s)).toEqual([]);
    expect(diagnosticsFor(entry(), { state: "pending", retryAt: 0 }, s)).toEqual([]);
    expect(
      diagnosticsFor(entry(), { state: "not_scored", versionSource: "latest", reason: "not_indexed", validatedAt: 0, stale: false }, s),
    ).toEqual([]);
  });

  it("reports malware as an error with the entry range and the package page", () => {
    const e = entry();
    const [d, ...rest] = diagnosticsFor(e, scored(card({ headline: headline(0, "F"), gates: [gate("malware", { reason: "MAL-2026-1 reported" })] })), {
      ...s,
      warningBelow: 0,
    });
    expect(rest).toEqual([]);
    expect(d).toEqual({
      range: e.range,
      severity: "error",
      code: "malware",
      message: "lodash 4.17.21 has a malware finding: MAL-2026-1 reported",
      target: page,
    });
  });

  it("reports an inherited malware finding on an installed path with its depth", () => {
    const c = card({ inheritedGates: [{ gate: "malware", count: 1, nearest_depth: 2, path_class: "installed", example_path: [], caps_at: 0 }] });
    const [d] = diagnosticsFor(entry(), scored(c), { ...s, warningBelow: 0 });
    expect(d?.message).toBe("lodash 4.17.21 pulls in a package with a malware finding (depth 2)");
    expect(d?.code).toBe("malware");
  });

  it("reports KEV, and combines it with malware into one diagnostic", () => {
    const kev = diagnosticsFor(entry(), scored(card({ gates: [gate("kev", { reason: "CVE-2026-0001" })] })), { ...s, warningBelow: 0 });
    expect(kev).toHaveLength(1);
    expect(kev[0]).toMatchObject({ code: "kev", severity: "error", message: "lodash 4.17.21 is affected by a known exploited vulnerability: CVE-2026-0001" });
    const both = diagnosticsFor(entry(), scored(card({ gates: [gate("kev", { reason: "CVE-1" }), gate("malware", { reason: "MAL-1" })] })), {
      ...s,
      warningBelow: 0,
    });
    expect(both).toHaveLength(1);
    expect(both[0]?.code).toBe("malware");
    expect(both[0]?.message).toBe(
      "lodash 4.17.21 has a malware finding: MAL-1; it is affected by a known exploited vulnerability: CVE-1",
    );
  });

  it("reports malware and KEV whatever the gate list and thresholds", () => {
    const out = diagnosticsFor(entry(), scored(card({ headline: headline(95, "A"), gates: [gate("malware")] })), {
      ...s,
      gates: [],
      warningBelow: 0,
      errorBelow: 0,
    });
    expect(out.map((d) => d.code)).toEqual(["malware"]);
  });

  it("warns for listed gates only, joined, with recommendations", () => {
    const c = card({
      headline: headline(83, "B"),
      gates: [gate("high_vuln_with_fix", { recommendation: "bump to 4.18.0" }), gate("yanked"), gate("no_provenance")],
    });
    const out = diagnosticsFor(entry(), scored(c), s);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      code: "gate",
      severity: "warning",
      message: "lodash 4.17.21: high severity advisory with a fix (bump to 4.18.0); yanked, retracted or deprecated version",
    });
    expect(diagnosticsFor(entry(), scored(c), { ...s, gates: ["no_provenance"] })[0]?.message).toBe("lodash 4.17.21: no build provenance");
    expect(diagnosticsFor(entry(), scored(c), { ...s, gates: [] })).toEqual([]);
  });

  it("warns below warningBelow; 65 is not below 65", () => {
    const at = diagnosticsFor(entry(), scored(card({ headline: headline(65, "C") })), s);
    expect(at).toEqual([]);
    const roundsUp = diagnosticsFor(entry(), scored(card({ headline: headline(64.6, "D") })), s);
    expect(roundsUp).toEqual([]);
    const below = diagnosticsFor(entry(), scored(card({ headline: headline(58.2, "D") })), s);
    expect(below).toHaveLength(1);
    expect(below[0]).toMatchObject({ code: "score", severity: "warning", message: "lodash 4.17.21 scores 58 (D) with its dependencies, below 65" });
  });

  it("raises an error below errorBelow, before the warning", () => {
    const out = diagnosticsFor(entry(), scored(card({ headline: headline(40, "F") })), { ...s, errorBelow: 50 });
    expect(out).toEqual([expect.objectContaining({ severity: "error", message: "lodash 4.17.21 scores 40 (F) with its dependencies, below 50" })]);
  });

  it("turns score diagnostics off with thresholds of 0", () => {
    expect(diagnosticsFor(entry(), scored(card({ headline: headline(10, "F") })), { ...s, warningBelow: 0, errorBelow: 0 })).toEqual([]);
  });

  it("switches the basis to the own score", () => {
    const c = card({ headline: headline(58, "D"), own: { score: 70, grade: "C" } });
    expect(diagnosticsFor(entry(), scored(c), { ...s, scoreBasis: "own" })).toEqual([]);
    const low = card({ headline: headline(58, "D"), own: { score: 60, grade: "D" } });
    expect(diagnosticsFor(entry(), scored(low), { ...s, scoreBasis: "own" })[0]?.message).toBe("lodash 4.17.21 scores 60 (D) on its own, below 65");
  });

  it("says when the headline is the own score or an upper bound", () => {
    const own = card({ headline: headline(58, "D", { basis: "own", state: "not_collected", at_most: true }) });
    expect(diagnosticsFor(entry(), scored(own), s)[0]?.message).toBe(
      "lodash 4.17.21 scores at most 58 (D) on its own (dependencies not scored yet), below 65",
    );
  });

  it("appends (cached) to stale answers", () => {
    const out = diagnosticsFor(entry(), scored(card({ headline: headline(58, "D"), gates: [gate("kev")] }), { stale: true }), s);
    expect(out.map((d) => d.message.endsWith(" (cached)"))).toEqual([true, true]);
  });

  it("produces at most three diagnostics", () => {
    const c = card({ headline: headline(20, "F"), gates: [gate("malware"), gate("kev"), gate("yanked")] });
    expect(diagnosticsFor(entry(), scored(c), s).map((d) => d.code)).toEqual(["malware", "gate", "score"]);
  });
});
