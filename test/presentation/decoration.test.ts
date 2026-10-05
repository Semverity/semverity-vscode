import { describe, expect, it } from "vitest";
import { decorationFor, groupByLine } from "../../src/presentation/decoration";
import { card, entry, gate, headline, scored, target } from "../helpers/cards";

const on = { showUnscored: true };
const off = { showUnscored: false };

describe("decorationFor", () => {
  it("shows a complete headline as score and grade in the grade colour", () => {
    const spec = decorationFor([{ entry: entry(), result: scored(card({ headline: headline(83.2, "B") })) }], on);
    expect(spec).toEqual({ text: "83 B", colorId: "semverity.gradeB", iconGrade: "B", muted: false });
  });

  it("marks an at-most headline with ≤", () => {
    const spec = decorationFor([{ entry: entry(), result: scored(card({ headline: headline(83, "B", { at_most: true, state: "partial" }) })) }], on);
    expect(spec?.text).toBe("≤83 B");
  });

  it("adds (cached) to a stale answer and keeps the grade colour", () => {
    const spec = decorationFor([{ entry: entry(), result: scored(card({ headline: headline(83, "B") }), { stale: true }) }], on);
    expect(spec).toMatchObject({ text: "83 B (cached)", colorId: "semverity.gradeB", muted: false });
  });

  it("counts fired hard gates other than malware and KEV", () => {
    const one = decorationFor([{ entry: entry(), result: scored(card({ gates: [gate("high_vuln_with_fix"), gate("no_provenance")] })) }], on);
    expect(one?.text).toBe("74 C · 1 gate");
    const two = decorationFor([{ entry: entry(), result: scored(card({ gates: [gate("high_vuln_with_fix"), gate("yanked")] })) }], on);
    expect(two?.text).toBe("74 C · 2 gates");
  });

  it("shows malware in the F colour, own or inherited on an installed path", () => {
    const own = decorationFor([{ entry: entry(), result: scored(card({ gates: [gate("malware")] })) }], on);
    expect(own).toEqual({ text: "malware", colorId: "semverity.gradeF", iconGrade: "F", muted: false });
    const inherited = decorationFor(
      [
        {
          entry: entry(),
          result: scored(
            card({ inheritedGates: [{ gate: "malware", count: 1, nearest_depth: 2, path_class: "installed", example_path: [], caps_at: 0 }] }),
          ),
        },
      ],
      on,
    );
    expect(inherited?.text).toBe("malware");
  });

  it("ignores an inherited malware gate reached only through optional dependencies", () => {
    const spec = decorationFor(
      [
        {
          entry: entry(),
          result: scored(
            card({ inheritedGates: [{ gate: "malware", count: 1, nearest_depth: 2, path_class: "optional", example_path: [], caps_at: 0 }] }),
          ),
        },
      ],
      on,
    );
    expect(spec?.text).toBe("74 C");
  });

  it("shows KEV with the headline in the F colour", () => {
    const spec = decorationFor([{ entry: entry(), result: scored(card({ headline: headline(25, "F"), gates: [gate("kev")] })) }], on);
    expect(spec).toEqual({ text: "KEV · 25 F", colorId: "semverity.gradeF", iconGrade: "F", muted: false });
  });

  it("shows not scored, pending and queued in the muted colour", () => {
    const notScored = decorationFor(
      [{ entry: entry(), result: { state: "not_scored", versionSource: "latest", reason: "not_indexed", validatedAt: 0, stale: false } }],
      on,
    );
    expect(notScored).toEqual({ text: "not scored", colorId: "semverity.unscored", iconGrade: "none", muted: true });
    expect(decorationFor([{ entry: entry(), result: { state: "pending", retryAt: 0 } }], on)?.text).toBe("scoring…");
    expect(decorationFor([{ entry: entry() }], on)?.text).toBe("scoring…");
  });

  it("shows excluded packages as excluded", () => {
    const spec = decorationFor([{ entry: entry({ target: undefined, excluded: { rule: { kind: "pattern", pattern: "@acme/*" } } }) }], on);
    expect(spec).toMatchObject({ text: "excluded", muted: true });
  });

  it("shows nothing for skipped, disabled, offline and error results", () => {
    expect(decorationFor([{ entry: entry({ target: undefined, skip: { reason: "builtin" } }) }], on)).toBeUndefined();
    expect(decorationFor([{ entry: entry(), result: { state: "disabled" } }], on)).toBeUndefined();
    expect(decorationFor([{ entry: entry(), result: { state: "offline", retryAt: 1 } }], on)).toBeUndefined();
    expect(decorationFor([{ entry: entry(), result: { state: "rate_limited", retryAt: 1 } }], on)).toBeUndefined();
    expect(decorationFor([{ entry: entry(), result: { state: "error", message: "boom" } }], on)).toBeUndefined();
  });

  it("hides unscored states when showUnscored is off", () => {
    expect(decorationFor([{ entry: entry() }], off)).toBeUndefined();
    expect(decorationFor([{ entry: entry(), result: { state: "pending", retryAt: 0 } }], off)).toBeUndefined();
    expect(decorationFor([{ entry: entry({ target: undefined, excluded: { rule: { kind: "pattern", pattern: "x" } } }) }], off)).toBeUndefined();
    expect(decorationFor([{ entry: entry(), result: scored() }], off)?.text).toBe("74 C");
  });

  it("lists several packages on one line, coloured by the worst grade", () => {
    const yaml = entry({ label: "PyYAML", target: target("pyyaml", "6.0.3", "manifest", "pypi") });
    const requests = entry({ label: "requests", target: target("requests", "2.32.3", "manifest", "pypi") });
    const os = entry({ label: "os", target: undefined, skip: { reason: "builtin" } });
    const spec = decorationFor(
      [
        { entry: os },
        { entry: yaml, result: scored(card({ name: "pyyaml", ecosystem: "pypi", headline: headline(91, "A") })) },
        { entry: requests, result: scored(card({ name: "requests", ecosystem: "pypi", headline: headline(58.4, "D") })) },
      ],
      on,
    );
    expect(spec).toEqual({ text: "PyYAML 91 A · requests 58 D", colorId: "semverity.gradeD", iconGrade: "D", muted: false });
  });

  it("lists a package once when it is imported twice on a line", () => {
    const spec = decorationFor(
      [
        { entry: entry(), result: scored() },
        { entry: entry({ range: { start: { line: 0, character: 40 }, end: { line: 0, character: 46 } } }), result: scored() },
      ],
      on,
    );
    expect(spec?.text).toBe("74 C");
  });
});

describe("groupByLine", () => {
  it("groups entries by line in line order", () => {
    const a = { entry: entry({ line: 3, label: "a" }) };
    const b = { entry: entry({ line: 1, label: "b" }) };
    const c = { entry: entry({ line: 3, label: "c" }) };
    const lines = groupByLine([a, b, c]);
    expect([...lines.keys()]).toEqual([1, 3]);
    expect(lines.get(3)?.map((i) => i.entry.label)).toEqual(["a", "c"]);
  });
});
