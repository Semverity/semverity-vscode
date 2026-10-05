import { describe, expect, it } from "vitest";
import { colorIdFor, gradeForScore, scoreFor, shieldSvg, worse } from "../../src/presentation/grades";
import { fileName, formatScore, gateLabel, gateLabelInline, isoDate, relativeAge, versionSourceLabel } from "../../src/presentation/labels";
import { code, commandLink, escapeMarkdown, inlineMarkdown, urlLink } from "../../src/presentation/markdown";
import { isSupportedDocument, manifestKindOf, manifestLanguageId } from "../../src/vscode/selectors";
import { card, headline } from "../helpers/cards";

describe("grades", () => {
  it("maps grades to colour ids", () => {
    expect(colorIdFor("A")).toBe("semverity.gradeA");
    expect(colorIdFor("F")).toBe("semverity.gradeF");
    expect(colorIdFor(undefined)).toBe("semverity.unscored");
  });

  it("uses the score bands", () => {
    expect([90, 89.9, 80, 79.9, 65, 64.9, 50, 49.9].map(gradeForScore)).toEqual(["A", "B", "B", "C", "C", "D", "D", "F"]);
  });

  it("picks the worse grade", () => {
    expect(worse("A", "C")).toBe("C");
    expect(worse("F", "B")).toBe("F");
    expect(worse(undefined, "B")).toBe("B");
    expect(worse(undefined, undefined)).toBeUndefined();
  });

  it("reads the score for a basis, falling back to own and overall", () => {
    const c = card({ headline: headline(74, "C", { at_most: true }), own: { score: 80, grade: "B" } });
    expect(scoreFor(c, "headline")).toEqual({ score: 74, grade: "C", atMost: true, includes: "with_dependencies" });
    expect(scoreFor(c, "own")).toEqual({ score: 80, grade: "B", atMost: false, includes: "own" });
    expect(scoreFor(card({ headline: undefined }), "headline")?.score).toBe(80.2);
    expect(scoreFor(card({ headline: undefined, own: undefined, overall: 62 }), "own")).toEqual({ score: 62, grade: "D", atMost: false, includes: "own" });
  });

  it("draws a shield in the given colour", () => {
    expect(shieldSvg("#123456")).toContain('fill="#123456"');
  });
});

describe("labels", () => {
  it("labels gates, known and unknown", () => {
    expect(gateLabel("kev")).toBe("Known exploited vulnerability (KEV)");
    expect(gateLabel("some_new_gate")).toBe("Some new gate");
    expect(gateLabelInline("yanked")).toBe("yanked, retracted or deprecated version");
    expect(gateLabelInline("kev")).toBe("known exploited vulnerability (KEV)");
  });

  it("labels version sources", () => {
    expect(versionSourceLabel("lockfile", { lockfile: "yarn.lock" })).toBe("locked version (yarn.lock)");
    expect(versionSourceLabel("lockfile")).toBe("locked version");
    expect(versionSourceLabel("manifest")).toBe("declared version");
    expect(versionSourceLabel("range", { range: "^4.17.0" })).toBe("newest known version matching `^4.17.0`");
    expect(versionSourceLabel("latest")).toBe("latest version (not declared)");
    expect(versionSourceLabel("latest", { declared: true })).toBe("latest version");
  });

  it("formats ages, scores, dates and file names", () => {
    const now = 1_000_000_000_000;
    expect(relativeAge(now - 10_000, now)).toBe("just now");
    expect(relativeAge(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeAge(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(relativeAge(now - 50 * 3_600_000, now)).toBe("2 days ago");
    expect(formatScore(82.76, false)).toBe("83");
    expect(formatScore(82.4, true)).toBe("≤82");
    expect(isoDate("2026-09-29T02:39:53Z")).toBe("2026-09-29");
    expect(isoDate(undefined)).toBeUndefined();
    expect(fileName("file:///work/app/package-lock.json")).toBe("package-lock.json");
  });
});

describe("markdown", () => {
  it("escapes link and emphasis syntax", () => {
    expect(escapeMarkdown("[x](command:y) *b* _i_ <b>")).toBe("\\[x\\](command\\:y) \\*b\\* \\_i\\_ \\<b\\>");
    expect(escapeMarkdown("a\nb")).toBe("a b");
  });

  it("keeps balanced code spans", () => {
    expect(inlineMarkdown("matches `@acme/*` [x]")).toBe("matches `@acme/*` \\[x\\]");
    expect(inlineMarkdown("one ` tick")).toBe("one \\` tick");
  });

  it("builds code spans, command links and URL links", () => {
    expect(code("a`b")).toBe("``a`b``");
    expect(commandLink("Go", "semverity.refresh")).toBe("[Go](command:semverity.refresh)");
    expect(commandLink("Go", "x", { a: 1 })).toBe(`[Go](command:x?${encodeURIComponent('[{"a":1}]')})`);
    expect(urlLink("Page", "https://e.test/a (b)")).toBe("[Page](https://e.test/a%20%28b%29)");
  });
});

describe("selectors", () => {
  it("recognises manifests", () => {
    expect(manifestKindOf("/w/package.json")).toBe("package.json");
    expect(manifestKindOf("/w/requirements-dev.txt")).toBe("requirements");
    expect(manifestKindOf("/w/requirements.txt")).toBe("requirements");
    expect(manifestKindOf("/w/pyproject.toml")).toBe("pyproject");
    expect(manifestKindOf("/w/go.mod")).toBe("go.mod");
    expect(manifestKindOf("/w/go.sum")).toBeUndefined();
    expect(manifestLanguageId("requirements")).toBe("pip-requirements");
  });

  it("accepts supported documents only", () => {
    expect(isSupportedDocument({ scheme: "file", path: "/w/src/a.ts", languageId: "typescript" })).toBe(true);
    expect(isSupportedDocument({ scheme: "untitled", path: "Untitled-1", languageId: "python" })).toBe(true);
    expect(isSupportedDocument({ scheme: "file", path: "/w/go.mod", languageId: "plaintext" })).toBe(true);
    expect(isSupportedDocument({ scheme: "file", path: "/w/README.md", languageId: "markdown" })).toBe(false);
    expect(isSupportedDocument({ scheme: "git", path: "/w/src/a.ts", languageId: "typescript" })).toBe(false);
    expect(isSupportedDocument({ scheme: "output", path: "x", languageId: "typescript" })).toBe(false);
    expect(isSupportedDocument({ scheme: "file", path: "/w/node_modules/x/index.js", languageId: "javascript" })).toBe(false);
    expect(isSupportedDocument({ scheme: "file", path: "/w/.venv/lib/site-packages/x/pyproject.toml", languageId: "toml" })).toBe(false);
    expect(isSupportedDocument({ scheme: "file", path: "/w/vendor/github.com/a/b/go.mod", languageId: "go.mod" })).toBe(false);
  });
});
