import { describe, expect, it } from "vitest";
import { hoverMarkdown, type HoverContext } from "../../src/presentation/hover";
import { clockTime } from "../../src/presentation/labels";
import { card, declaredIn, entry, gate, headline, HOUR, listing, NOW, scored, target } from "../helpers/cards";

const ctx: HoverContext = { siteBaseUrl: "https://semverity.dev", now: NOW, signedIn: false, lockfile: "package-lock.json" };

describe("hoverMarkdown for scored results", () => {
  it("renders a complete headline", () => {
    const md = hoverMarkdown(entry(), scored(card({ headline: headline(83.2, "B"), own: { score: 85.1, grade: "B" } })), ctx);
    expect(md).toMatchSnapshot();
    expect(md).toContain("$(shield) **lodash** 4.17.21 · npm · locked version (package-lock.json)");
    expect(md).toContain("**83 B** with dependencies");
    expect(md).not.toContain("at most");
    expect(md).toContain("Own score **85 B** · Security **B** (87) · Evidence coverage 91%");
    expect(md).toContain("[Open on semverity.dev](https://semverity.dev/registry/npm/lodash/versions/4.17.21) · scored 2026-09-29 · checked 3 h ago");
    expect(md).not.toContain("Why the score is low");
  });

  it("renders an at-most headline with its coverage", () => {
    const md = hoverMarkdown(entry(), scored(card({ headline: headline(74, "C", { at_most: true, state: "partial", coverage: 82.4 }) })), ctx);
    expect(md).toContain("**74 C** with dependencies · at most, 82% of dependencies scored");
  });

  it("renders a headline on the own basis", () => {
    const md = hoverMarkdown(entry(), scored(card({ headline: headline(82.8, "B", { basis: "own", state: "not_collected", at_most: true }) })), ctx);
    expect(md).toContain("**83 B** own score only, dependencies not scored yet");
  });

  it("lists malware and KEV first, then other hard gates, then soft gates", () => {
    const c = card({
      headline: headline(0, "F"),
      gates: [
        gate("no_provenance"),
        gate("high_vuln_with_fix", { reason: "GHSA-r5fr-rjxr-66jc (HIGH)", recommendation: "bump to 4.18.0" }),
        gate("kev", { reason: "CVE-2026-0001 is KEV-listed" }),
        gate("malware", { reason: "MAL-2026-1" }),
        gate("unfixed_high_vuln", { hard: false }),
      ],
    });
    const md = hoverMarkdown(entry(), scored(c), ctx);
    expect(md).toMatchSnapshot();
    const lines = md.split("\n").map((l) => l.trim());
    const at = (prefix: string) => lines.findIndex((l) => l.startsWith(prefix));
    expect(at("$(error) Malware finding: MAL-2026-1")).toBeGreaterThan(0);
    expect(at("$(error) Known exploited vulnerability (KEV): CVE-2026-0001 is KEV-listed")).toBeGreaterThan(at("$(error) Malware"));
    expect(at("$(warning) High severity advisory with a fix: GHSA-r5fr-rjxr-66jc (HIGH). bump to 4.18.0")).toBeGreaterThan(at("$(error) Known"));
    expect(at("$(warning) High severity advisory without a fix")).toBeGreaterThan(at("$(warning) High severity advisory with a fix"));
    expect(at("$(info) No build provenance")).toBeGreaterThan(at("$(warning) High severity advisory without"));
  });

  it("explains inherited malware and KEV", () => {
    const c = card({
      inheritedGates: [
        { gate: "kev", count: 1, nearest_depth: 3, path_class: "installed", example_path: [], caps_at: 25 },
        { gate: "malware", count: 1, nearest_depth: 2, path_class: "installed", example_path: [], caps_at: 0 },
        { gate: "chain_unfixed_critical", count: 2, nearest_depth: 1, path_class: "optional", example_path: [], caps_at: null },
      ],
    });
    const md = hoverMarkdown(entry(), scored(c), ctx);
    expect(md).toContain("$(error) Pulls in a package with a malware finding (depth 2)");
    expect(md).toContain("$(error) Pulls in a package affected by a known exploited vulnerability (KEV) (depth 3)");
    expect(md).toContain("$(warning) Pulls in 2 packages with: Unfixed critical advisory through optional dependencies only (depth 1)");
  });

  it("explains a low score", () => {
    const c = card({
      headline: headline(58, "D"),
      weakest: [
        { purl: "pkg:npm/minimist@1.2.0", kind: "weakest", points: 12.34, own: 41, depth: 2, path_class: "installed", path: [] },
        { purl: "pkg:npm/%40scope/evil@1.0.0", kind: "gate", gate: "kev", points: 8, own: null, depth: 3, path_class: "installed", path: [] },
        { purl: "pkg:npm/x@1.0.0", kind: "breadth", points: 1, own: 70, depth: 1, path_class: "installed", path: [] },
      ],
      dimensions: [
        { id: "best_practices", name: "Best practices", score: 52, coverage: 1 },
        { id: "community", name: "Community", score: 40, coverage: 1 },
        { id: "security", name: "Security", score: 65, coverage: 1 },
      ],
      notes: ["Community and bus factor: only 35% of the evidence available", "second", "third"],
    });
    const md = hoverMarkdown(entry(), scored(c), ctx);
    expect(md).toMatchSnapshot();
    expect(md).toContain("**Why the score is low**");
    expect(md).toContain("- Weakest dependency: `minimist` 1.2.0 (own 41), 12.3 points");
    expect(md).toContain("- `@scope/evil` 1.0.0 carries a gate (Known exploited vulnerability (KEV)), 8.0 points");
    expect(md).toContain("- Lowest areas: Community 40, Best practices 52");
    expect(md).toContain("- Community and bus factor\\: only 35% of the evidence available");
    expect(md).toContain("- second");
    expect(md).not.toContain("- third");
    expect(md).not.toContain("x` 1.0.0");
  });

  it("shows the healthy version with and without an apply link", () => {
    const r = scored(card(), { listing: listing("4.18.1") });
    const without = hoverMarkdown(entry(), r, ctx);
    expect(without).toContain("**Healthy version:** 4.18.1 (≤83 B)");
    expect(without).not.toContain("command:semverity.applyVersion");
    const args = { uri: "file:///work/app/package.json", range: { start: { line: 5, character: 15 }, end: { line: 5, character: 23 } }, newText: "^4.18.1" };
    const withLink = hoverMarkdown(entry({ declaredIn: declaredIn() }), r, { ...ctx, applyCommand: { title: "Use 4.18.1", args } });
    expect(withLink).toContain(
      `**Healthy version:** 4.18.1 (≤83 B) · [Use 4.18.1](command:semverity.applyVersion?${encodeURIComponent(JSON.stringify([args]))})`,
    );
  });

  it("hides the healthy line when it is the current version", () => {
    const md = hoverMarkdown(entry(), scored(card(), { listing: listing("4.17.21") }), ctx);
    expect(md).not.toContain("Healthy version");
  });

  it("ends a stale answer with its age", () => {
    const md = hoverMarkdown(entry(), scored(card(), { stale: true, validatedAt: NOW - 50 * HOUR }), ctx);
    expect(md.trim().endsWith("cached, last checked 2 days ago")).toBe(true);
  });

  it("labels each version source", () => {
    const at = (versionSource: "manifest" | "range" | "latest", extra = {}) =>
      hoverMarkdown(entry({ target: { ...target(), versionSource, ...extra } }), scored(card()), ctx).split("\n")[0];
    expect(at("manifest")).toContain("· declared version");
    expect(at("range", { range: "^4.17.0" })).toContain("· newest known version matching `^4.17.0`");
    expect(at("latest")).toContain("· latest version (not declared)");
  });

  it("escapes server text so it cannot add links", () => {
    const c = card({ gates: [gate("yanked", { reason: "see [here](command:workbench.action.reloadWindow)" })] });
    const md = hoverMarkdown(entry(), scored(c), ctx);
    expect(md).not.toContain("[here](command:");
    expect(md).toContain("see \\[here\\](command\\:workbench.action.reloadWindow)");
  });

  it("builds page links with packagePageUrl for scoped names", () => {
    const c = card({ name: "@types/node", purl: "pkg:npm/%40types/node@22.0.0", version: "22.0.0" });
    const md = hoverMarkdown(entry({ label: "@types/node", target: target("@types/node", "22.0.0") }), scored(c), ctx);
    expect(md).toContain("(https://semverity.dev/registry/npm/@types/node/versions/22.0.0)");
  });
});

describe("hoverMarkdown for other states", () => {
  it("says a version is not scored, with the latest scored version, signed out", () => {
    const md = hoverMarkdown(
      entry(),
      {
        state: "not_scored",
        coordinate: { ecosystem: "npm", name: "lodash", version: "4.17.21" },
        versionSource: "lockfile",
        reason: "not_indexed",
        listing: listing("4.18.1"),
        validatedAt: NOW,
        stale: false,
      },
      ctx,
    );
    expect(md).toMatchSnapshot();
    expect(md).toContain("Semverity has not scored lodash 4.17.21 yet.");
    expect(md).toContain("Latest scored version: 4.18.1 (≤83 B)");
    expect(md).toContain("With an API key, Semverity collects public packages it has not seen ([Set API Key](command:semverity.setApiKey)).");
  });

  it("prefers the listing's newest scored version for the hint", () => {
    const l = {
      ...listing("4.18.1"),
      latest: "5.0.0-rc.1",
      latestScored: "4.18.0",
      versions: [{ version: "4.18.0", own: { score: 81, grade: "B" as const }, firedGates: [] }],
    };
    const md = hoverMarkdown(
      entry(),
      { state: "not_scored", coordinate: { ecosystem: "npm", name: "lodash", version: "4.17.21" }, versionSource: "lockfile", reason: "not_indexed", listing: l, validatedAt: NOW, stale: false },
      ctx,
    );
    expect(md).toContain("Latest scored version: 4.18.0 (81 B)");
  });

  it("does not offer an API key when signed in", () => {
    const md = hoverMarkdown(
      entry(),
      { state: "not_scored", versionSource: "latest", reason: "not_found", validatedAt: NOW, stale: false },
      { ...ctx, signedIn: true },
    );
    expect(md).toContain("Semverity has not scored lodash yet.");
    expect(md).not.toContain("API key");
  });

  it("describes pending, excluded and disabled", () => {
    expect(hoverMarkdown(entry(), { state: "pending", coordinate: { ecosystem: "npm", name: "lodash", version: "4.17.21" }, retryAt: NOW }, ctx)).toContain(
      "Semverity is scoring lodash 4.17.21; this updates by itself.",
    );
    const excluded = hoverMarkdown(entry({ label: "@acme/ui", target: undefined, excluded: { rule: { kind: "pattern", pattern: "@acme/*" } } }), undefined, ctx);
    expect(excluded).toContain("Not looked up: matches `@acme/*`. Nothing about this package was sent.");
    expect(hoverMarkdown(entry(), { state: "disabled" }, ctx)).toContain("Network lookups are off (`semverity.network.enabled`).");
  });

  it("gives the retry time when offline or rate limited", () => {
    const at = NOW + 10 * 60_000;
    expect(hoverMarkdown(entry(), { state: "offline", retryAt: at }, ctx)).toContain(`The Semverity API is not reachable; retrying at ${clockTime(at)}.`);
    expect(hoverMarkdown(entry(), { state: "rate_limited", retryAt: at }, ctx)).toContain(`retrying at ${clockTime(at)}.`);
  });

  it("has no hover for skipped entries", () => {
    expect(hoverMarkdown(entry({ target: undefined, skip: { reason: "builtin" } }), undefined, ctx)).toBe("");
  });
});

describe("hoverMarkdown for an answer built from the listing", () => {
  it("shows the headline and says the full card is loading", () => {
    const c = card({ fromListing: true, headline: headline(82.8, "B"), own: { score: 82.8, grade: "B" }, security: undefined, coverage: Number.NaN });
    const md = hoverMarkdown(entry(), scored(c), ctx);
    expect(md).toContain("**83 B** with dependencies");
    expect(md).toContain("Own score **83 B** · full card loading");
    expect(md).not.toContain("Security not scored");
    expect(md).not.toContain("NaN");
  });
});
