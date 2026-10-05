import { describe, expect, it } from "vitest";
import { parseGoImports } from "../../../src/core/parsers/go";

describe("parseGoImports", () => {
  it("finds single, grouped, aliased, blank and dot imports", () => {
    const text = [
      "package main",
      "",
      'import "fmt"',
      "import (",
      '\t"net/http"',
      '\tlog "github.com/sirupsen/logrus"',
      '\t_ "github.com/lib/pq"',
      '\t. "github.com/onsi/gomega"',
      "\t`github.com/raw/path`",
      ")",
      'import yaml "gopkg.in/yaml.v3"',
      "",
      "func main() {",
      '\ts := "import \\"not/this\\""',
      "}",
    ].join("\n");
    expect(parseGoImports(text).map((i) => i.specifier)).toEqual([
      "fmt",
      "net/http",
      "github.com/sirupsen/logrus",
      "github.com/lib/pq",
      "github.com/onsi/gomega",
      "github.com/raw/path",
      "gopkg.in/yaml.v3",
    ]);
  });

  it("ignores commented imports", () => {
    const text = 'package x\n// import "commented/out"\n/*\nimport "block/comment"\n*/\nimport (\n\t"a.com/x" // trailing\n\t// "b.com/y"\n)';
    expect(parseGoImports(text).map((i) => i.specifier)).toEqual(["a.com/x"]);
  });

  it("reports the range of the path text", () => {
    const refs = parseGoImports('package x\nimport (\n\tlog "github.com/sirupsen/logrus"\n)');
    expect(refs[0]?.range).toEqual({ start: { line: 2, character: 6 }, end: { line: 2, character: 32 } });
  });
});
