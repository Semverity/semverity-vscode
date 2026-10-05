import { describe, expect, it } from "vitest";
import { parsePythonImports } from "../../../src/core/parsers/python";

const specs = (text: string): string[] => parsePythonImports(text).map((i) => i.specifier);

describe("parsePythonImports", () => {
  it("finds import and from-import forms", () => {
    const text = ["import os", "import a.b.c as d, e", "from yaml import safe_load", "from google.cloud import storage", "from x import (y,", "    z)"].join("\n");
    expect(specs(text)).toEqual(["os", "a.b.c", "e", "yaml", "google.cloud", "x"]);
  });

  it("records the names a from-import imports", () => {
    const text = ["from google.cloud import storage, bigquery as bq", "from x import (y as z,  # comment", "    w,)", "from os import *", "import a"].join("\n");
    expect(parsePythonImports(text).map((i) => i.names)).toEqual([["storage", "bigquery"], ["y", "w"], undefined, undefined]);
  });

  it("finds indented, one-line compound and semicolon-separated imports", () => {
    const text = [
      "def f():",
      "    import requests",
      "try: import ujson as json",
      "except ImportError: import json",
      "if TYPE_CHECKING:",
      "    from numpy import ndarray",
      "import sys; import attr",
    ].join("\n");
    expect(specs(text)).toEqual(["requests", "ujson", "json", "numpy", "sys", "attr"]);
  });

  it("joins backslash continuations", () => {
    expect(specs("import a, \\\n    b")).toEqual(["a", "b"]);
  });

  it("ignores docstrings, strings and comments", () => {
    const text = ['"""', "import not_this", '"""', "# import nor_this", "x = 'import nope'", "s = f\"{import_thing}\"", "import yes"].join("\n");
    expect(specs(text)).toEqual(["yes"]);
  });

  it("keeps relative imports as written", () => {
    expect(specs("from . import sibling\nfrom .pkg import thing\nfrom ..up.mod import x\nfrom .import y")).toEqual([".", ".pkg", "..up.mod", "."]);
  });

  it("finds importlib.import_module and __import__ with a literal", () => {
    const text = 'import importlib\nm = importlib.import_module("yaml")\nn = __import__(\'requests.adapters\')\no = importlib.import_module(name)';
    const refs = parsePythonImports(text);
    expect(refs.map((r) => [r.specifier, r.kind])).toEqual([
      ["importlib", "python-import"],
      ["yaml", "dynamic-import"],
      ["requests.adapters", "dynamic-import"],
    ]);
  });

  it("reports the range of the dotted name", () => {
    const refs = parsePythonImports("from google.cloud import storage\n    import  PIL.Image as I");
    expect(refs[0]?.range).toEqual({ start: { line: 0, character: 5 }, end: { line: 0, character: 17 } });
    expect(refs[1]?.range).toEqual({ start: { line: 1, character: 12 }, end: { line: 1, character: 21 } });
  });

  it("does not match identifiers that start with import or from", () => {
    expect(specs("important = 1\nfromage = 2\nimportlib_metadata = 3")).toEqual([]);
  });
});
