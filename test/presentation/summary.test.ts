import { describe, expect, it } from "vitest";
import type { NetworkStatus } from "../../src/core/types";
import { manifestDescription, statusBarModel, summarize, treeOrder, type SummaryItem } from "../../src/presentation/summary";
import { card, entry, gate, headline, scored, target } from "../helpers/cards";

function item(name: string, score: number | undefined, extra: Partial<Parameters<typeof card>[0]> = {}): SummaryItem {
  const e = entry({ label: name, target: target(name, "1.0.0") });
  if (score === undefined) return { entry: e };
  const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 65 ? "C" : score >= 50 ? "D" : "F";
  return { entry: e, result: scored(card({ name, version: "1.0.0", headline: headline(score, grade), ...extra })) };
}

const ok: NetworkStatus = { state: "ok", signedIn: false };

describe("summarize", () => {
  it("counts distinct packages per state and grade and finds the lowest", () => {
    const items: SummaryItem[] = [
      item("a", 91),
      item("a", 91),
      item("b", 58.4),
      item("c", 74),
      item("d", undefined),
      { entry: entry({ label: "e" }), result: { state: "not_scored", versionSource: "latest", reason: "not_indexed", validatedAt: 0, stale: false } },
      { entry: entry({ label: "@acme/x", target: undefined, excluded: { rule: { kind: "pattern", pattern: "x" } } }) },
      { entry: entry({ label: "fs", target: undefined, skip: { reason: "builtin" } }) },
    ];
    // "e" uses the default target (lodash), distinct from the others.
    const s = summarize(items);
    expect(s).toMatchObject({ total: 6, scored: 3, notScored: 1, pending: 1, excluded: 1, malware: 0, kev: 0, gated: 0 });
    expect(s.grades).toEqual({ A: 1, B: 0, C: 1, D: 1, F: 0 });
    expect(s.lowest).toMatchObject({ score: 58.4, grade: "D", label: "b" });
  });

  it("counts malware, KEV and listed gates", () => {
    const s = summarize([item("a", 0, { gates: [gate("malware")] }), item("b", 25, { gates: [gate("kev")] }), item("c", 80, { gates: [gate("yanked")] }), item("d", 80, { gates: [gate("no_provenance")] })]);
    expect(s).toMatchObject({ malware: 1, kev: 1, gated: 1 });
    expect(summarize([item("d", 80, { gates: [gate("no_provenance")] })], { gates: ["no_provenance"] }).gated).toBe(1);
  });
});

describe("statusBarModel", () => {
  it("shows the count and lowest score", () => {
    const m = statusBarModel(summarize([item("a", 91), item("b", 70)]), ok);
    expect(m.text).toBe("$(shield) 2 deps · lowest 70 C");
    expect(m.severity).toBe("none");
  });

  it("warns when the lowest is below warningBelow", () => {
    const m = statusBarModel(summarize([item("a", 91), item("b", 58)]), ok, { warningBelow: 65 });
    expect(m).toMatchObject({ text: "$(shield) 2 deps · lowest 58 D", severity: "warning" });
  });

  it("errors for malware or KEV", () => {
    expect(statusBarModel(summarize([item("a", 91), item("b", 25, { gates: [gate("kev")] })]), ok)).toMatchObject({ text: "$(error) 2 deps · KEV", severity: "error" });
    expect(statusBarModel(summarize([item("a", 0, { gates: [gate("malware")] })]), ok).text).toBe("$(error) 1 dep · malware");
  });

  it("counts fired warning gates", () => {
    const m = statusBarModel(summarize([item("a", 74, { gates: [gate("yanked")] }), item("b", 80, { gates: [gate("typosquat")] }), item("c", 90)]), ok);
    expect(m).toMatchObject({ text: "$(warning) 3 deps · 2 gates · lowest 74 C", severity: "warning" });
  });

  it("shows the name alone before anything is scored, and off when lookups are off", () => {
    expect(statusBarModel(summarize([item("a", undefined)]), ok).text).toBe("$(shield) Semverity");
    const notScored: SummaryItem = {
      entry: entry({ label: "b", target: target("b", "1.0.0") }),
      result: { state: "not_scored", coordinate: { ecosystem: "npm", name: "b", version: "1.0.0" }, versionSource: "lockfile", reason: "not_indexed", validatedAt: 0, stale: false },
    };
    expect(statusBarModel(summarize([notScored]), ok).text).toBe("$(shield) 1 dep · none scored");
    expect(statusBarModel(summarize([notScored, item("a", undefined)]), ok).text).toBe("$(shield) Semverity");
    expect(statusBarModel(summarize([item("a", 91)]), { state: "disabled", signedIn: false }).text).toBe("$(shield) Semverity off");
  });

  it("prefixes offline and rate limited states", () => {
    expect(statusBarModel(summarize([item("a", 91)]), { state: "offline", signedIn: false, retryAt: 0 }).text).toBe("$(cloud-offline) $(shield) 1 dep · lowest 91 A");
    expect(statusBarModel(summarize([item("a", 91)]), { state: "rate_limited", signedIn: false, retryAt: 0 }).text).toBe("$(watch) $(shield) 1 dep · lowest 91 A");
  });

  it("puts counts, sign-in state and links in the tooltip", () => {
    const m = statusBarModel(summarize([item("a", 91), item("b", 58), item("c", undefined)]), { state: "ok", signedIn: true }, { scope: "this file" });
    expect(m.tooltipMarkdown).toContain("**Semverity** · this file");
    expect(m.tooltipMarkdown).toContain("Grades: A 1 · D 1");
    expect(m.tooltipMarkdown).toContain("1 pending");
    expect(m.tooltipMarkdown).toContain("Signed in with an API key");
    expect(m.tooltipMarkdown).toContain("[Check Workspace](command:semverity.checkWorkspace)");
    expect(m.tooltipMarkdown).toContain("[Turn lookups off](command:semverity.toggleLookups)");
    const off = statusBarModel(summarize([]), { state: "disabled", signedIn: false });
    expect(off.tooltipMarkdown).toContain("Signed out: public index only");
    expect(off.tooltipMarkdown).toContain("[Turn lookups on](command:semverity.toggleLookups)");
  });
});

describe("manifestDescription", () => {
  it("summarises a manifest", () => {
    expect(manifestDescription(summarize([item("a", 91), item("b", 58)]))).toBe("2 dependencies · lowest 58 D");
    expect(manifestDescription(summarize([item("a", 25, { gates: [gate("kev")] })]))).toBe("1 dependency · KEV · lowest 25 F");
  });
});

describe("treeOrder", () => {
  it("sorts malware and KEV, other gates, ascending score, not scored, pending, excluded", () => {
    const items: SummaryItem[] = [
      { entry: entry({ label: "excluded", target: undefined, excluded: { rule: { kind: "pattern", pattern: "x" } } }) },
      item("pending", undefined),
      { entry: entry({ label: "notscored" }), result: { state: "not_scored", versionSource: "latest", reason: "not_indexed", validatedAt: 0, stale: false } },
      item("high", 95),
      item("low", 55),
      item("gated", 85, { gates: [gate("yanked")] }),
      item("kev", 25, { gates: [gate("kev")] }),
    ];
    expect([...items].sort(treeOrder).map((i) => i.entry.label)).toEqual(["kev", "gated", "low", "high", "notscored", "pending", "excluded"]);
  });
});
