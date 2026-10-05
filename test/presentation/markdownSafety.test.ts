// Regression tests: text from the API or the workspace must never turn into a
// link (and so never into a command link) in a trusted hover. The output is
// rendered with marked, a CommonMark renderer, and every href is checked.

import { marked } from "marked";
import { describe, expect, it } from "vitest";
import { exclusionMarkdown, hoverMarkdown, type HoverContext } from "../../src/presentation/hover";
import { code, inlineMarkdown } from "../../src/presentation/markdown";
import { card, entry, gate, headline, listing, NOW, scored } from "../helpers/cards";

const ctx: HoverContext = { siteBaseUrl: "https://semverity.dev", now: NOW, signedIn: true };

function hrefs(md: string): string[] {
  const html = marked.parse(md, { async: false });
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1] ?? "");
}

const ENC = encodeURIComponent(JSON.stringify([{ uri: "file:///etc/package.json", range: {}, newText: "x" }]));
const LINK = `[Use 4.18.1](command:semverity.applyVersion?${ENC})`;

/** Strings that try to break out of a code span with runs of backticks. */
const HOSTILE = [
  `Deprecated \`\`\`${LINK}\``,
  `\`\`${LINK}\`\``,
  `a \`b\` \`\`${LINK}\` c`,
  `\`x\`\`\`${LINK}\`\`\`y\``,
  `\`\`\` ${LINK} \`\`\``,
  `\\\`${LINK}\\\``,
  `<command:semverity.applyVersion?${ENC}>`,
  `[x]: command:semverity.applyVersion\n\n[x]`,
  `\`[a](command:x)\``,
  `${"`".repeat(7)}${LINK}${"`".repeat(3)}`,
];

describe("Markdown safety of untrusted text", () => {
  it.each(HOSTILE)("inlineMarkdown never renders a link: %s", (text) => {
    expect(hrefs(inlineMarkdown(text))).toEqual([]);
    expect(hrefs(`before ${inlineMarkdown(text)} after ${code("`")} ${inlineMarkdown(text)}`)).toEqual([]);
  });

  it("code() survives any backtick run and empty text", () => {
    for (const text of ["a`b", "``", "` x `", "a```b", "`", ""]) {
      const md = `${code(text)} [ok](https://e.test)`;
      expect(hrefs(md)).toEqual(["https://e.test"]);
    }
    expect(code("")).toBe("");
  });

  it("keeps the single-backtick code spans of honest text", () => {
    expect(inlineMarkdown("use `pkg@2` instead [x]")).toBe("use `pkg@2` instead \\[x\\]");
  });

  it("hover links are only the ones the presenter emitted", () => {
    const hostile = HOSTILE.join(" ");
    const c = card({
      headline: headline(40, "F"),
      gates: [gate("yanked", { reason: hostile, recommendation: hostile }), gate("unfixed_high_vuln", { hard: false, reason: hostile })],
      notes: [hostile, hostile],
    });
    const md = hoverMarkdown(entry(), scored(c, { listing: listing("4.18.1") }), {
      ...ctx,
      applyCommand: { title: "Use 4.18.1", args: { id: "abc-1" } },
    });
    const links = hrefs(md);
    const commands = links.filter((h) => h.startsWith("command:"));
    expect(commands).toEqual([`command:semverity.applyVersion?${encodeURIComponent(JSON.stringify([{ id: "abc-1" }]))}`]);
    expect(links.filter((h) => !h.startsWith("command:"))).toEqual(["https://semverity.dev/registry/npm/lodash/versions/4.17.21"]);
  });

  it("bare URLs, www hosts and email addresses in untrusted text never autolink", () => {
    for (const text of ["see https://evil.example/x", "see HTTP://evil.example", "ftp://evil.example", "see www.evil.example", "Www.evil.example", "mail a@evil.example", "mailto:a@evil.example"]) {
      expect(hrefs(inlineMarkdown(text))).toEqual([]);
    }
    const hostile = "moved to https://evil.example and www.evil.example, ask a@evil.example";
    const c = card({ headline: headline(40, "F"), gates: [gate("yanked", { reason: hostile, recommendation: hostile })], notes: [hostile] });
    const md = hoverMarkdown(entry(), scored(c), ctx);
    expect(hrefs(md)).toEqual(["https://semverity.dev/registry/npm/lodash/versions/4.17.21"]);
    expect(md).toMatchSnapshot();
  });

  it("theme icon syntax in untrusted text is escaped", () => {
    expect(inlineMarkdown("$(debug-alt) run")).toBe("\\$(debug-alt) run");
    const hostile = "$(rocket) $(sync~spin) $(zap)";
    const c = card({ headline: headline(40, "F"), gates: [gate("yanked", { reason: hostile })], notes: [hostile] });
    const md = hoverMarkdown(entry(), scored(c), ctx);
    // Every "$(" the hover holds that is not escaped is one the presenter emitted itself.
    const icons = [...md.matchAll(/(?<!\\)\$\(([^)]*)\)/g)].map((m) => m[1]);
    expect(icons).not.toContain("debug-alt");
    expect(icons).not.toContain("rocket");
    expect(icons).not.toContain("sync~spin");
    expect(icons).not.toContain("zap");
    expect(md).toMatchSnapshot();
  });

  it("an exclusion pattern from workspace settings renders as code only", () => {
    const pattern = `golang:*[x](command:semverity.applyVersion?${ENC})\`\``;
    expect(hrefs(exclusionMarkdown({ kind: "pattern", pattern }))).toEqual([]);
    const md = hoverMarkdown(entry({ target: undefined, excluded: { rule: { kind: "pattern", pattern } } }), undefined, ctx);
    expect(hrefs(md)).toEqual([]);
    expect(hrefs(exclusionMarkdown({ kind: "registry-scope", scope: `@a\`[x](command:y)\``, source: ".npmrc" }))).toEqual([]);
  });

  it("a hostile range in the version source label renders as code only", () => {
    const md = hoverMarkdown(entry({ target: { id: { ecosystem: "npm", name: "x" }, range: `^1\`\`${LINK}\``, versionSource: "range" } }), undefined, ctx);
    expect(hrefs(md)).toEqual([]);
  });
});
