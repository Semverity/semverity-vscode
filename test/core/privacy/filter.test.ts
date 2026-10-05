import { describe, expect, it } from "vitest";
import { describeExclusion, PrivacyFilter, type PrivacyVerdict } from "../../../src/core/privacy/filter";
import { parseNpmrc } from "../../../src/core/parsers/npmRegistries";
import { matchGoPrivate } from "../../../src/core/privacy/goprivate";
import { compilePattern } from "../../../src/core/privacy/patterns";

function text(v: PrivacyVerdict): string | undefined {
  return v.allowed ? undefined : describeExclusion(v.rule);
}

const options = { excludePatterns: [] as string[], excludeNpmrcScopes: true, trustedRegistryHosts: [] as string[], goPrivate: "" };

describe("exclude patterns", () => {
  it("matches globs with ecosystem prefixes", () => {
    const p = compilePattern("npm:@acme/*");
    expect(p({ ecosystem: "npm", name: "@acme/ui" })).toBe(true);
    expect(p({ ecosystem: "npm", name: "@acme/ui/deep" })).toBe(true);
    expect(p({ ecosystem: "pypi", name: "@acme/ui" })).toBe(false);
    expect(compilePattern("internal-?")({ ecosystem: "npm", name: "internal-a" })).toBe(true);
    expect(compilePattern("internal-?")({ ecosystem: "npm", name: "internal-ab" })).toBe(false);
  });

  it("normalises PyPI names and compares npm and Go names case-sensitively", () => {
    expect(compilePattern("pypi:Acme_*")({ ecosystem: "pypi", name: "acme.tools" })).toBe(true);
    expect(compilePattern("acme-*")({ ecosystem: "pypi", name: "ACME_Lib" })).toBe(true);
    expect(compilePattern("Acme-*")({ ecosystem: "npm", name: "acme-lib" })).toBe(false);
    expect(compilePattern("golang:git.acme.example/*")({ ecosystem: "golang", name: "git.acme.example/team/x" })).toBe(true);
  });
});

describe("GOPRIVATE", () => {
  it("matches leading path elements with path.Match globs", () => {
    expect(matchGoPrivate("*.corp.example,github.com/acme", "git.corp.example/team/lib")).toBe(true);
    expect(matchGoPrivate("github.com/acme", "github.com/acme/repo/sub")).toBe(true);
    expect(matchGoPrivate("github.com/acme", "github.com/acmeco/repo")).toBe(false);
    expect(matchGoPrivate("github.com/*/internal", "github.com/x/internal/y")).toBe(true);
    expect(matchGoPrivate("", "github.com/x/y")).toBe(false);
  });
});

describe("PrivacyFilter", () => {
  it("applies the rules in order and names the rule", () => {
    const f = new PrivacyFilter({ ...options, excludePatterns: ["@acme/secret"], goPrivate: "git.corp.example" });
    expect(f.check({ ecosystem: "npm", name: "@acme/secret" }, { npmRegistries: parseNpmrc("@acme:registry=https://npm.acme.example/") })).toEqual({ allowed: false, rule: { kind: "pattern", pattern: "@acme/secret" } });
    const scoped = f.check({ ecosystem: "npm", name: "@acme/ui" }, { npmRegistries: parseNpmrc("@acme:registry=https://npm.acme.example/") });
    expect(text(scoped)).toBe("the `@acme` scope uses another registry (.npmrc)");
    expect(f.check({ ecosystem: "npm", name: "@public/x" }, { npmRegistries: parseNpmrc("@public:registry=https://registry.npmjs.org/") })).toEqual({ allowed: true });
    expect(f.check({ ecosystem: "npm", name: "lodash" }, { lockfileHost: "npm.acme.example" }).allowed).toBe(false);
    expect(f.check({ ecosystem: "npm", name: "lodash" }, { lockfileHost: "registry.yarnpkg.com" }).allowed).toBe(true);
    expect(f.check({ ecosystem: "pypi", name: "x" }, { lockfileHost: "local" }).allowed).toBe(false);
    expect(f.check({ ecosystem: "pypi", name: "x" }, { indexUrls: ["https://pypi.acme.example/simple"] }).allowed).toBe(false);
    expect(f.check({ ecosystem: "pypi", name: "x" }, { indexUrls: ["https://pypi.org/simple"] }).allowed).toBe(true);
    expect(f.check({ ecosystem: "golang", name: "git.corp.example/lib" }).allowed).toBe(false);
    expect(f.check({ ecosystem: "golang", name: "example.com/x" }, { goLocalReplace: true }).allowed).toBe(false);
    expect(f.check({ ecosystem: "golang", name: "github.com/x/y" })).toEqual({ allowed: true });
  });

  it("treats trusted hosts as public and can turn the .npmrc rule off", () => {
    const f = new PrivacyFilter({ ...options, trustedRegistryHosts: ["Mirror.Example"] });
    expect(f.check({ ecosystem: "npm", name: "lodash" }, { lockfileHost: "mirror.example" }).allowed).toBe(true);
    expect(f.check({ ecosystem: "pypi", name: "x" }, { indexUrls: ["https://mirror.example/simple"] }).allowed).toBe(true);
    const off = new PrivacyFilter({ ...options, excludeNpmrcScopes: false });
    expect(off.check({ ecosystem: "npm", name: "@acme/ui" }, { npmRegistries: parseNpmrc("@acme:registry=https://npm.acme.example/") }).allowed).toBe(true);
  });

  it("refuses packages of a private default registry unless a lockfile shows a public source", () => {
    const f = new PrivacyFilter(options);
    const npmRegistries = parseNpmrc("registry=https://npm.corp.example/");
    expect(text(f.check({ ecosystem: "npm", name: "acme-utils" }, { npmRegistries }))).toBe(
      "the default npm registry (.npmrc) is not the public one and no lockfile shows where the package comes from",
    );
    expect(f.check({ ecosystem: "npm", name: "lodash" }, { npmRegistries, lockfileHost: "registry.npmjs.org" }).allowed).toBe(true);
    expect(f.check({ ecosystem: "npm", name: "acme-utils" }, { npmRegistries, lockfileHost: "npm.corp.example" }).allowed).toBe(false);
    // A scope explicitly bound to the public registry is not affected by the default.
    const both = parseNpmrc("registry=https://npm.corp.example/\n@types:registry=https://registry.npmjs.org/");
    expect(f.check({ ecosystem: "npm", name: "@types/node" }, { npmRegistries: both }).allowed).toBe(true);
    // From the environment too.
    const env = new PrivacyFilter({ ...options, npmEnvRegistries: [{ host: "npm.corp.example", source: "NPM_CONFIG_REGISTRY" }] });
    expect(text(env.check({ ecosystem: "npm", name: "acme-utils" }))).toContain("(NPM_CONFIG_REGISTRY)");
    expect(new PrivacyFilter({ ...options, trustedRegistryHosts: ["npm.corp.example"] }).check({ ecosystem: "npm", name: "x" }, { npmRegistries }).allowed).toBe(true);
  });

  it("refuses every PyPI package when the environment or user configuration names a private index", () => {
    const f = new PrivacyFilter({ ...options, pythonIndexes: [{ url: "https://pypi.acme.example/simple", source: "PIP_INDEX_URL" }] });
    expect(text(f.check({ ecosystem: "pypi", name: "requests" }))).toBe("PIP_INDEX_URL uses a package index other than PyPI");
    const pub = new PrivacyFilter({ ...options, pythonIndexes: [{ url: "https://pypi.org/simple", source: "PIP_INDEX_URL" }] });
    expect(pub.check({ ecosystem: "pypi", name: "requests" }).allowed).toBe(true);
    expect(f.check({ ecosystem: "npm", name: "requests" }).allowed).toBe(true);
    expect(text(new PrivacyFilter(options).check({ ecosystem: "pypi", name: "x" }, { indexUrls: ["https://pypi.acme.example/simple"], indexSource: "pyproject.toml" }))).toBe(
      "pyproject.toml uses a package index other than PyPI",
    );
  });
});
