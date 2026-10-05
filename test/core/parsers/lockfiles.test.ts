import { describe, expect, it } from "vitest";
import {
  parseBunLock,
  parseNpmLock,
  parsePipfileLock,
  parsePnpmLock,
  parsePoetryLock,
  parseUvLock,
  parseYarnLock,
  stripPnpmSuffix,
} from "../../../src/core/parsers/lockfiles";
import { parseNpmrc } from "../../../src/core/parsers/npmRegistries";
import { parseTsconfigAliases } from "../../../src/core/parsers/tsconfig";

describe("package-lock.json", () => {
  it("prefers the importer's nested entry over the hoisted one (v3)", () => {
    const lock = parseNpmLock(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "root" },
          "node_modules/lodash": { version: "4.17.21", resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz" },
          "packages/a/node_modules/lodash": { version: "4.17.20", resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz" },
          "node_modules/@acme/private": { version: "1.0.0", resolved: "https://npm.acme.example/@acme/private/-/private-1.0.0.tgz" },
          "node_modules/@acme/a": { resolved: "packages/a", link: true },
        },
      }),
    );
    expect(lock.versions("lodash")).toBe("4.17.21");
    expect(lock.versions("lodash", "packages/a")).toBe("4.17.20");
    expect(lock.versions("lodash", "packages/b")).toBe("4.17.21");
    expect(lock.resolvedHost("@acme/private")).toBe("npm.acme.example");
    expect(lock.resolvedHost("lodash")).toBe("registry.npmjs.org");
    expect(lock.versions("@acme/a")).toBeUndefined();
  });

  it("reads v1 dependencies", () => {
    const lock = parseNpmLock(JSON.stringify({ lockfileVersion: 1, dependencies: { react: { version: "16.14.0", resolved: "https://registry.npmjs.org/react/-/react-16.14.0.tgz" } } }));
    expect(lock.versions("react")).toBe("16.14.0");
  });

  it("answers nothing for an unreadable file", () => {
    expect(parseNpmLock("{not json").versions("x")).toBeUndefined();
  });
});

describe("pnpm-lock.yaml", () => {
  it("reads v9 importers and removes peer suffixes", () => {
    const text = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      react:
        specifier: ^18.3.0
        version: 18.3.1
  packages/ui:
    dependencies:
      react-dom:
        specifier: ^18.3.0
        version: 18.3.1(react@18.3.1)
      sibling:
        specifier: workspace:*
        version: link:../sibling
packages:
  react@18.3.1:
    resolution: {integrity: sha512-x}
  react-dom@18.3.1:
    resolution: {integrity: sha512-y, tarball: https://npm.acme.example/react-dom-18.3.1.tgz}
`;
    const lock = parsePnpmLock(text);
    expect(lock.versions("react")).toBe("18.3.1");
    expect(lock.versions("react-dom", "packages/ui")).toBe("18.3.1");
    expect(lock.versions("sibling", "packages/ui")).toBeUndefined();
    expect(lock.resolvedHost("react-dom", "packages/ui")).toBe("npm.acme.example");
    expect(lock.resolvedHost("react")).toBeUndefined();
  });

  it("reads v6 importers", () => {
    const text = `lockfileVersion: '6.0'
importers:
  .:
    dependencies:
      lodash:
        specifier: ^4.17.0
        version: 4.17.21
packages:
  /lodash@4.17.21:
    resolution: {integrity: sha512-x}
`;
    expect(parsePnpmLock(text).versions("lodash")).toBe("4.17.21");
  });

  it("strips both suffix styles", () => {
    expect(stripPnpmSuffix("18.3.1(react@18.3.1)(x@1)")).toBe("18.3.1");
    expect(stripPnpmSuffix("1.0.0_react@18.2.0")).toBe("1.0.0");
  });
});

describe("yarn.lock", () => {
  it("reads classic entries and picks by declared range", () => {
    const text = `# yarn lockfile v1


"lodash@^4.17.20", lodash@^4.17.21:
  version "4.17.21"
  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz#abc"
  integrity sha512-x

lodash@^3.0.0:
  version "3.10.1"
  resolved "https://registry.yarnpkg.com/lodash/-/lodash-3.10.1.tgz#def"

"@acme/private@^1.0.0":
  version "1.2.0"
  resolved "https://npm.acme.example/@acme/private/-/private-1.2.0.tgz"
`;
    const lock = parseYarnLock(text);
    expect(lock.versions("lodash", undefined, "^3.0.0")).toBe("3.10.1");
    expect(lock.versions("lodash", undefined, "^4.17.21")).toBe("4.17.21");
    expect(lock.versions("lodash")).toBe("4.17.21");
    expect(lock.resolvedHost("@acme/private")).toBe("npm.acme.example");
  });

  it("reads Berry entries and skips workspaces", () => {
    const text = `__metadata:
  version: 8

"react@npm:^18.2.0":
  version: 18.3.1
  resolution: "react@npm:18.3.1"

"@acme/ui@workspace:packages/ui":
  version: 0.0.0-use.local
  resolution: "@acme/ui@workspace:packages/ui"
`;
    const lock = parseYarnLock(text);
    expect(lock.versions("react", undefined, "^18.2.0")).toBe("18.3.1");
    expect(lock.versions("@acme/ui")).toBeUndefined();
  });
});

describe("bun.lock", () => {
  it("reads the text lockfile with trailing commas", () => {
    const text = `{
  "lockfileVersion": 1,
  "workspaces": { "": { "dependencies": { "zod": "^3.23.0" } } },
  "packages": {
    "zod": ["zod@3.23.8", "", {}, "sha512-x"],
    "private": ["private@1.0.0", "https://npm.acme.example/private-1.0.0.tgz", {}, "sha512-y"],
  },
}`;
    const lock = parseBunLock(text);
    expect(lock.versions("zod")).toBe("3.23.8");
    expect(lock.resolvedHost("zod")).toBeUndefined();
    expect(lock.resolvedHost("private")).toBe("npm.acme.example");
  });
});

describe("Python lockfiles", () => {
  it("reads poetry.lock with legacy sources", () => {
    const text = `[[package]]
name = "PyYAML"
version = "6.0.1"

[[package]]
name = "internal-lib"
version = "2.0.0"

[package.source]
type = "legacy"
url = "https://pypi.acme.example/simple"
reference = "acme"

[[package]]
name = "mylib"
version = "0.1.0"

[package.source]
type = "directory"
url = "../mylib"
`;
    const lock = parsePoetryLock(text);
    expect(lock.versions("pyyaml")).toBe("6.0.1");
    expect(lock.versions("PyYAML")).toBe("6.0.1");
    expect(lock.resolvedHost("internal_lib")).toBe("pypi.acme.example");
    expect(lock.resolvedHost("mylib")).toBe("local");
    expect(lock.versions("mylib")).toBeUndefined();
  });

  it("reads uv.lock sources", () => {
    const text = `version = 1

[[package]]
name = "requests"
version = "2.32.3"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "me"
version = "0.1.0"
source = { editable = "." }
`;
    const lock = parseUvLock(text);
    expect(lock.versions("requests")).toBe("2.32.3");
    expect(lock.resolvedHost("requests")).toBe("pypi.org");
    expect(lock.resolvedHost("me")).toBe("local");
  });

  it("reads Pipfile.lock with named indexes", () => {
    const text = JSON.stringify({
      _meta: { sources: [{ name: "pypi", url: "https://pypi.org/simple" }, { name: "acme", url: "https://pypi.acme.example/simple" }] },
      default: { requests: { version: "==2.32.3" }, internal: { version: "==1.0.0", index: "acme" } },
      develop: { pytest: { version: "==8.3.2", index: "pypi" } },
    });
    const lock = parsePipfileLock(text);
    expect(lock.versions("requests")).toBe("2.32.3");
    expect(lock.versions("pytest")).toBe("8.3.2");
    expect(lock.resolvedHost("requests")).toBe("pypi.org");
    expect(lock.resolvedHost("internal")).toBe("pypi.acme.example");
  });
});

describe(".npmrc", () => {
  it("reads only scope registry lines and never keeps credentials", () => {
    const text = [
      "registry=https://registry.npmjs.org/",
      "@acme:registry=https://npm.acme.example/",
      "//npm.acme.example/:_authToken=SECRET-TOKEN-VALUE",
      "@Other:registry = 'https://registry.npmjs.org/'",
      "@env:registry=${PRIVATE_REGISTRY}",
      "always-auth=true",
    ].join("\n");
    const config = parseNpmrc(text);
    expect([...config.scopes].map(([k, v]) => [k, v.map((b) => b.host)])).toEqual([
      ["@acme", ["npm.acme.example"]],
      ["@other", ["registry.npmjs.org"]],
      ["@env", ["unknown"]],
    ]);
    expect(config.defaults).toEqual([{ host: "registry.npmjs.org", source: ".npmrc" }]);
    expect(JSON.stringify([...config.scopes, ...config.defaults])).not.toContain("SECRET");
  });
});

describe("tsconfig", () => {
  it("reads paths and baseUrl from JSONC", () => {
    const aliases = parseTsconfigAliases(`{
      // comment
      "compilerOptions": { "baseUrl": "./src", "paths": { "@app/*": ["src/app/*"], "config": ["src/config.ts"], }, },
    }`);
    expect(aliases).toEqual({ patterns: ["@app/*", "config"], baseUrl: "./src" });
  });
});
