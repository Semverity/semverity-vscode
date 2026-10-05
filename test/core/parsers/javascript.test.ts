import { describe, expect, it } from "vitest";
import { parseJsImports } from "../../../src/core/parsers/javascript";

const specs = (text: string): string[] => parseJsImports(text).map((i) => i.specifier);

describe("parseJsImports", () => {
  it("finds every static import form", () => {
    const text = [
      `import x from "a";`,
      `import { b, c as d } from 'b';`,
      `import * as ns from "c";`,
      `import "d";`,
      `import type { T } from "e";`,
      `import x2, { y } from "f";`,
      `import def, * as all from "g";`,
    ].join("\n");
    expect(specs(text)).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  it("finds re-exports", () => {
    const text = [`export * from "a";`, `export * as ns from "b";`, `export { x } from "c";`, `export type { T } from "d";`, `export { y };`, `export const z = 1;`].join("\n");
    expect(specs(text)).toEqual(["a", "b", "c", "d"]);
    expect(parseJsImports(text).map((i) => i.kind)).toEqual(["export-from", "export-from", "export-from", "export-from"]);
  });

  it("finds require, require.resolve, dynamic import and import-equals", () => {
    const text = [
      `const a = require("a");`,
      `const p = require.resolve("b");`,
      "const c = await import(`c`);",
      `const d = import("d", { with: { type: "json" } });`,
      `import e = require("e");`,
    ].join("\n");
    const refs = parseJsImports(text);
    expect(refs.map((r) => [r.specifier, r.kind])).toEqual([
      ["a", "require"],
      ["b", "require"],
      ["c", "dynamic-import"],
      ["d", "dynamic-import"],
      ["e", "import-equals"],
    ]);
  });

  it("handles multi-line imports", () => {
    const text = `import {\n  a,\n  b,\n} from "multi";\nimport\n  def\nfrom\n  "spread";`;
    const refs = parseJsImports(text);
    expect(refs.map((r) => r.specifier)).toEqual(["multi", "spread"]);
    expect(refs[0]?.range).toEqual({ start: { line: 3, character: 8 }, end: { line: 3, character: 13 } });
  });

  it("ignores imports inside comments, strings, templates and regular expressions", () => {
    const text = [
      `// import a from "commented";`,
      `/* const b = require("block"); */`,
      `const s = 'import c from "in-string"';`,
      "const t = `require(\"in-template\")`;",
      `const re = /import d from "regex"/;`,
      `const url = "https://example.com//x"; import real from "real";`,
      `obj.require("member");`,
      `const m = import.meta.url;`,
    ].join("\n");
    expect(specs(text)).toEqual(["real"]);
  });

  it("skips template literals with substitutions and non-literal arguments", () => {
    const text = "const a = require(`./x/${name}`);\nconst b = import(name);\nconst c = require(\"a\" + b);";
    expect(specs(text)).toEqual([]);
  });

  it("reports exact ranges on CRLF input", () => {
    const text = `import a from "lodash";\r\nconst b = require('@scope/pkg/sub');\r\n`;
    const refs = parseJsImports(text);
    expect(refs[0]?.range).toEqual({ start: { line: 0, character: 15 }, end: { line: 0, character: 21 } });
    expect(refs[1]?.range).toEqual({ start: { line: 1, character: 19 }, end: { line: 1, character: 33 } });
  });

  it("does not mistake a division for a regular expression", () => {
    const text = `const x = a / b; import y from "after-division"; const z = c / d;`;
    expect(specs(text)).toEqual(["after-division"]);
  });

  it("survives unterminated input", () => {
    expect(specs(`import x from "unterminated`)).toEqual([]);
    expect(specs("const t = `open template ${")).toEqual([]);
    expect(specs(`import { a, b from "x"`)).toEqual([]);
  });
});
