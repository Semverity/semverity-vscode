import { describe, expect, it } from "vitest";
import { bumpEdit, bumpTitle, looseCompare, rewriteSpec } from "../../src/presentation/quickfix";
import { declaredIn, dependency, range } from "../helpers/cards";

describe("rewriteSpec for package.json", () => {
  it.each([
    ["^4.17.20", "^4.18.1"],
    ["~4.17.20", "~4.18.1"],
    [">=4.17.20", ">=4.18.1"],
    ["=4.17.20", "=4.18.1"],
    ["4.17.20", "4.18.1"],
    ["v4.17.20", "4.18.1"],
    ["^4.17", "^4.18.1"],
    ["4.17.20-beta.1", "4.18.1"],
    ["4.x", "^4.18.1"],
    ["*", "^4.18.1"],
    ["", "^4.18.1"],
    ["latest", "^4.18.1"],
    [">=4 <5", "^4.18.1"],
    ["^3.0.0 || ^4.0.0", "^4.18.1"],
    ["4.0.0 - 4.17.0", "^4.18.1"],
    ["<5", "^4.18.1"],
  ])("%s becomes %s", (spec, want) => {
    expect(rewriteSpec("package.json", spec, "4.18.1")).toBe(want);
  });

  it("keeps an npm alias prefix", () => {
    expect(rewriteSpec("package.json", "npm:lodash@^4.17.20", "4.18.1")).toBe("npm:lodash@^4.18.1");
    expect(rewriteSpec("package.json", "npm:@scope/real@~1.0.0", "1.2.0")).toBe("npm:@scope/real@~1.2.0");
    expect(rewriteSpec("package.json", "npm:real@1.x", "1.2.0")).toBe("npm:real@^1.2.0");
  });
});

describe("rewriteSpec for requirements and PEP 621", () => {
  it.each([
    ["==6.0.1", "==6.0.3"],
    ["===6.0.1", "===6.0.3"],
    ["~=6.0", "~=6.0.3"],
    [">=6.0", ">=6.0.3"],
    ["== 6.0.1", "==6.0.3"],
    [">=5,<7", "==6.0.3"],
    ["<7", "==6.0.3"],
    ["!=6.0.0", "==6.0.3"],
    ["==6.*", "==6.0.3"],
    ["", "==6.0.3"],
  ])("%s becomes %s", (spec, want) => {
    expect(rewriteSpec("requirements", spec, "6.0.3")).toBe(want);
    expect(rewriteSpec("pyproject", spec, "6.0.3", "pep621")).toBe(want);
  });
});

describe("rewriteSpec for Poetry", () => {
  it.each([
    ["^6.0", "^6.0.3"],
    ["~6.0", "~6.0.3"],
    ["==6.0.1", "==6.0.3"],
    ["6.0.1", "6.0.3"],
    [">=6,<7", "^6.0.3"],
    ["*", "^6.0.3"],
    [">=6", "^6.0.3"],
  ])("%s becomes %s", (spec, want) => {
    expect(rewriteSpec("pyproject", spec, "6.0.3", "poetry")).toBe(want);
  });

  it("detects Poetry specs when no flavour is given", () => {
    expect(rewriteSpec("pyproject", "^6.0", "6.0.3")).toBe("^6.0.3");
    expect(rewriteSpec("pyproject", "6.0.1", "6.0.3")).toBe("6.0.3");
    expect(rewriteSpec("pyproject", "~=6.0", "6.0.3")).toBe("~=6.0.3");
  });
});

describe("rewriteSpec for go.mod", () => {
  it("replaces the version token", () => {
    expect(rewriteSpec("go.mod", "v1.8.4", "v1.9.0")).toBe("v1.9.0");
    expect(rewriteSpec("go.mod", "v0.0.0-20240101000000-abcdef123456", "1.0.0")).toBe("v1.0.0");
  });
});

describe("bumpEdit", () => {
  it("edits the spec range of the declaring manifest", () => {
    const edit = bumpEdit(declaredIn(), "4.18.1");
    expect(edit).toEqual({ uri: "file:///work/app/package.json", range: range(5, 15, 23), newText: "^4.18.1" });
  });

  it("uses the Poetry flavour for tool.poetry sections", () => {
    const dep = dependency({ ecosystem: "pypi", name: "pyyaml", rawName: "PyYAML", spec: "6.0.1", section: "tool.poetry.dependencies" });
    const edit = bumpEdit(declaredIn(dep, { manifestKind: "pyproject", manifestUri: "file:///work/pyproject.toml" }), "6.0.3");
    expect(edit?.newText).toBe("6.0.3");
    const pep = dependency({ ecosystem: "pypi", name: "pyyaml", rawName: "PyYAML", spec: ">=6", section: "project.dependencies" });
    expect(bumpEdit(declaredIn(pep, { manifestKind: "pyproject" }), "6.0.3")?.newText).toBe(">=6.0.3");
  });

  it("does nothing without a spec range, for non-registry specs, or when nothing changes", () => {
    expect(bumpEdit(declaredIn(dependency({ specRange: undefined })), "4.18.1")).toBeUndefined();
    expect(bumpEdit(declaredIn(dependency({ nonRegistry: "workspace", spec: "workspace:*" })), "4.18.1")).toBeUndefined();
    expect(bumpEdit(declaredIn(dependency({ spec: "^4.18.1" })), "4.18.1")).toBeUndefined();
  });
});

describe("bumpTitle", () => {
  it("bumps up and changes down", () => {
    expect(bumpTitle("lodash", "4.17.21", "4.18.1")).toBe("Bump lodash to 4.18.1 (Semverity healthy version)");
    expect(bumpTitle("lodash", "4.18.1", "4.17.21")).toBe("Change lodash to 4.17.21 (Semverity healthy version)");
    expect(bumpTitle("x", "1.0.0", "0.9.0", () => 1)).toBe("Bump x to 0.9.0 (Semverity healthy version)");
  });

  it("compares versions numerically", () => {
    expect(looseCompare("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(looseCompare("v1.2.3", "1.2.3")).toBe(0);
    expect(looseCompare("1.0.0-beta", "1.0.0")).toBeLessThan(0);
    expect(looseCompare("2.0", "2.0.1")).toBeLessThan(0);
  });
});
