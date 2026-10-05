import { describe, expect, it } from "vitest";
import { comparePep440, parsePep440, satisfiesPep440 } from "../../../src/core/resolver/pep440";
import { compareVersions, exactVersion, pickVersion, poetryToPep440 } from "../../../src/core/resolver/versions";

describe("PEP 440", () => {
  it("orders dev, pre, final and post releases", () => {
    const ordered = ["1.0.dev1", "1.0a1.dev1", "1.0a1", "1.0b2", "1.0rc1", "1.0", "1.0.post1", "1.0.1", "1!0.1"];
    const shuffled = [...ordered].reverse();
    expect(shuffled.sort(comparePep440)).toEqual(ordered);
    expect(comparePep440("1.0", "1.0.0")).toBe(0);
    expect(parsePep440("1.0-1")?.post).toBe(1);
    expect(parsePep440("2.0.0rc1")?.pre).toEqual(["rc", 1]);
  });

  it("evaluates specifiers", () => {
    expect(satisfiesPep440("2.31.0", ">=2.0,<3")).toBe(true);
    expect(satisfiesPep440("3.0", ">=2.0,<3")).toBe(false);
    expect(satisfiesPep440("1.4.5", "~=1.4.2")).toBe(true);
    expect(satisfiesPep440("1.5.0", "~=1.4.2")).toBe(false);
    expect(satisfiesPep440("1.9", "~=1.4")).toBe(true);
    expect(satisfiesPep440("2.0", "~=1.4")).toBe(false);
    expect(satisfiesPep440("1.2.7", "==1.2.*")).toBe(true);
    expect(satisfiesPep440("1.3", "==1.2.*")).toBe(false);
    expect(satisfiesPep440("1.3", "!=1.2.*")).toBe(true);
    expect(satisfiesPep440("3.0rc1", "<3.0")).toBe(false);
    expect(satisfiesPep440("1.0.post1", ">1.0")).toBe(false);
    expect(satisfiesPep440("1.0+local", "==1.0")).toBe(true);
    expect(satisfiesPep440("1.0", "===1.0")).toBe(true);
    expect(satisfiesPep440("1.0", "")).toBe(true);
  });
});

describe("versions", () => {
  it("finds exact pins per ecosystem", () => {
    expect(exactVersion("npm", "1.2.3")).toBe("1.2.3");
    expect(exactVersion("npm", "=1.2.3")).toBe("1.2.3");
    expect(exactVersion("npm", "^1.2.3")).toBeUndefined();
    expect(exactVersion("npm", "npm:real@2.0.0")).toBe("2.0.0");
    expect(exactVersion("pypi", "==6.0.1")).toBe("6.0.1");
    expect(exactVersion("pypi", "===6.0.1")).toBe("6.0.1");
    expect(exactVersion("pypi", "==6.*")).toBeUndefined();
    expect(exactVersion("pypi", ">=6,<7")).toBeUndefined();
    expect(exactVersion("golang", "v0.0.0-20240101000000-abcdef123456")).toBe("v0.0.0-20240101000000-abcdef123456");
  });

  it("resolves npm ranges, excluding pre-releases unless the range names one", () => {
    const known = ["4.17.20", "4.17.21", "4.18.0-beta.1", "5.0.0", "3.10.1"];
    expect(pickVersion("npm", "^4.17.0", known)).toBe("4.17.21");
    expect(pickVersion("npm", "~3.10.0", known)).toBe("3.10.1");
    expect(pickVersion("npm", "4.x || 5.x", known)).toBe("5.0.0");
    expect(pickVersion("npm", "4.0.0 - 4.17.20", known)).toBe("4.17.20");
    expect(pickVersion("npm", "^4.18.0-beta.0", known)).toBe("4.18.0-beta.1");
    expect(pickVersion("npm", "*", known)).toBe("5.0.0");
    expect(pickVersion("npm", "^9", known)).toBeUndefined();
    expect(pickVersion("npm", "not a range", known)).toBeUndefined();
  });

  it("resolves PyPI specifiers and Poetry constraints", () => {
    const known = ["5.4.1", "6.0", "6.0.1", "6.0.2rc1", "7.0.0a1"];
    expect(pickVersion("pypi", ">=6,<7", known)).toBe("6.0.1");
    expect(pickVersion("pypi", "~=5.4", known)).toBe("5.4.1");
    expect(pickVersion("pypi", ">=7.0.0a0", known)).toBe("7.0.0a1");
    expect(pickVersion("pypi", "^6.0", known)).toBe("6.0.1");
    expect(pickVersion("pypi", "~6.0.0", known)).toBe("6.0.1");
    expect(pickVersion("pypi", "", known)).toBe("6.0.1");
    expect(poetryToPep440("^0.2.3")).toBe(">=0.2.3,<0.3");
    expect(poetryToPep440("^1.2")).toBe(">=1.2,<2");
    expect(poetryToPep440("~1.2.3")).toBe(">=1.2.3,<1.3");
    expect(poetryToPep440("1.2.3")).toBe("==1.2.3");
  });

  it("orders Go versions including pseudo-versions and +incompatible", () => {
    expect(compareVersions("golang", "v1.10.0", "v1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("golang", "v0.0.0-20240101000000-abcdef123456", "v0.0.1")).toBeLessThan(0);
    expect(compareVersions("golang", "v2.0.0+incompatible", "v1.9.9")).toBeGreaterThan(0);
    expect(pickVersion("golang", "", ["v1.2.0", "v1.10.0", "v2.0.0-rc.1"])).toBe("v1.10.0");
  });
});
