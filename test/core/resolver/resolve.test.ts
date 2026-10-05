import { beforeEach, describe, expect, it } from "vitest";
import { describeExclusion, PrivacyFilter } from "../../../src/core/privacy/filter";
import { analyzeDocument, classifyDocument } from "../../../src/core/resolver/resolve";
import { WorkspaceIndexImpl } from "../../../src/core/resolver/workspaceIndex";
import type { AnalysisEntry, DocumentAnalysis } from "../../../src/core/types";
import { FakeClock } from "../../helpers/fakeClock";
import { MemoryFiles } from "../../helpers/memoryFiles";
import { ROOT, WORKSPACE } from "../../fixtures/workspace";
import { must } from "../builders";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const options = { ecosystems: { npm: true, pypi: true, golang: true }, lookupUndeclaredImports: true };
const privacy = { excludePatterns: [] as string[], excludeNpmrcScopes: true, trustedRegistryHosts: [] as string[], goPrivate: "git.corp.example" };

let files: MemoryFiles;
let index: WorkspaceIndexImpl;
let filter: PrivacyFilter;

function analyze(rel: string, languageId: string, opts = options): DocumentAnalysis {
  const uri = `${ROOT}/${rel}`;
  return analyzeDocument({ uri, languageId, text: files.files.get(uri) ?? "" }, index, filter, opts);
}

function summary(e: AnalysisEntry): string {
  if (e.skip) return `${e.label}: skip ${e.skip.reason}`;
  if (e.excluded) return `${e.label}: excluded (${describeExclusion(e.excluded.rule)})`;
  const t = must(e.target);
  return `${e.label}: ${t.id.name} ${t.version ?? t.range ?? ""} ${t.versionSource}${e.declaredIn ? " declared" : ""}`.replace(/  +/g, " ");
}

beforeEach(async () => {
  files = new MemoryFiles([ROOT]).add(WORKSPACE);
  index = new WorkspaceIndexImpl(files, silent);
  filter = new PrivacyFilter(privacy);
  await index.rebuild();
});

describe("classifyDocument", () => {
  it("recognises manifests by name and sources by language", () => {
    expect(classifyDocument("file:///w/package.json", "json")).toMatchObject({ kind: "manifest", manifestKind: "package.json" });
    expect(classifyDocument("file:///w/requirements-dev.txt", "plaintext")).toMatchObject({ kind: "manifest", manifestKind: "requirements" });
    expect(classifyDocument("file:///w/constraints.txt", "pip-requirements")).toMatchObject({ kind: "manifest", manifestKind: "requirements" });
    expect(classifyDocument("file:///w/go.mod", "go.mod")).toMatchObject({ kind: "manifest", manifestKind: "go.mod" });
    expect(classifyDocument("file:///w/a.tsx", "typescriptreact")).toEqual({ kind: "source", ecosystem: "npm" });
    expect(classifyDocument("file:///w/a.rs", "rust")).toEqual({ kind: "unsupported" });
  });
});

describe("analyze a TypeScript file in a monorepo", () => {
  it("maps, versions and filters every import", () => {
    const a = analyze("packages/web/src/index.ts", "typescript");
    expect(a.kind).toBe("source");
    expect(a.entries.map(summary)).toEqual([
      "lodash: lodash 4.17.20 lockfile declared",
      "react: react 18.3.1 lockfile declared",
      "@acme/ui: skip self",
      "@acme/private: excluded (the `@acme` scope uses another registry (.npmrc))",
      "./local: skip relative",
      "node:fs: skip builtin",
      "@app/store: skip alias",
      "components/Button: skip alias",
      "chalk: chalk 5.3.0 lockfile declared",
      "zod: zod ^3.23.0 range declared",
      "left-pad: left-pad 1.3.0 lockfile",
      "express: express latest",
      "mirror-only: excluded (the lockfile resolves it from a registry other than the public one)",
    ]);
    const lodash = must(a.entries[0]);
    expect(lodash.declaredIn?.manifestUri).toBe(`${ROOT}/packages/web/package.json`);
    expect(lodash.declaredIn?.dependency.specRange).toBeDefined();
    expect(lodash.range).toEqual({ start: { line: 0, character: 16 }, end: { line: 0, character: 25 } });
  });

  it("names the lockfile that pinned a version, and only then", () => {
    const a = analyze("packages/web/src/index.ts", "typescript");
    const byLabel = (label: string) => must(a.entries.find((e) => e.label === label)?.target);
    expect(byLabel("lodash").lockfile).toBe("package-lock.json");
    expect(byLabel("left-pad").lockfile).toBe("package-lock.json");
    expect(byLabel("zod").lockfile).toBeUndefined();
    expect(byLabel("express").lockfile).toBeUndefined();
    const py = analyze("py/pyproject.toml", "toml");
    expect(must(py.entries[0]?.target).lockfile).toBe("uv.lock");
  });

  it("treats trusted mirrors as public", () => {
    filter = new PrivacyFilter({ ...privacy, trustedRegistryHosts: ["registry.mirror.example"] });
    const a = analyze("packages/web/src/index.ts", "typescript");
    expect(a.entries.map(summary)).toContain("mirror-only: mirror-only 2.0.0 lockfile");
  });

  it("skips undeclared imports when that is turned off", () => {
    const a = analyze("packages/web/src/index.ts", "typescript", { ...options, lookupUndeclaredImports: false });
    expect(a.entries.map(summary)).toContain("express: skip undeclared");
    expect(a.entries.map(summary)).toContain("left-pad: skip undeclared");
  });

  it("returns nothing before the index is ready or for a disabled ecosystem", async () => {
    index = new WorkspaceIndexImpl(files, silent);
    expect(analyze("packages/web/src/index.ts", "typescript").entries).toEqual([]);
    await index.rebuild();
    expect(analyze("packages/web/src/index.ts", "typescript", { ...options, ecosystems: { npm: false, pypi: true, golang: true } }).entries).toEqual([]);
  });
});

describe("analyze package.json", () => {
  it("resolves each dependency against the lockfile importer", () => {
    const a = analyze("packages/web/package.json", "json");
    expect(a.kind).toBe("manifest");
    expect(a.entries.map(summary)).toEqual([
      "lodash: lodash 4.17.20 lockfile declared",
      "react: react 18.3.1 lockfile declared",
      "@acme/ui: skip non-registry",
      "@acme/private: excluded (the `@acme` scope uses another registry (.npmrc))",
      "chalk-alias: chalk 5.3.0 lockfile declared",
      "zod: zod ^3.23.0 range declared",
      "next: next latest declared",
    ]);
    expect(a.entries[0]?.specRange).toBeDefined();
  });

  it("uses unsaved editor text", () => {
    const uri = `${ROOT}/packages/web/package.json`;
    const a = analyzeDocument({ uri, languageId: "json", text: '{ "dependencies": { "left-pad": "1.3.0", "is-odd": "=3.0.1" } }' }, index, filter, options);
    expect(a.entries.map(summary)).toEqual(["left-pad: left-pad 1.3.0 lockfile declared", "is-odd: is-odd 3.0.1 manifest declared"]);
  });
});

describe("analyze Python", () => {
  it("maps imports through the table, the requirements and the workspace", () => {
    const a = analyze("py/app/main.py", "python");
    expect(a.entries.map(summary)).toEqual([
      "os: skip builtin",
      "requests: requests 2.31.0 manifest declared",
      "PyYAML: PyYAML >=6.0 range declared",
      "opencv-python-headless: opencv-python-headless latest declared",
      "app.models: skip local-module",
      "httpx: httpx 0.27.2 lockfile declared",
      // Undeclared: requirements-private.txt names a private index that could serve it.
      "numpy: excluded (a Python manifest of the workspace uses a package index other than PyPI)",
      "internal-tool: excluded (its requirements file uses a package index other than PyPI)",
      "py_service: skip self",
    ]);
  });

  it("skips namespace and plain directories of the workspace as local modules", async () => {
    files.files.delete(`${ROOT}/py/requirements-private.txt`);
    files.files.set(`${ROOT}/py/acme/platform/util.py`, "");
    files.files.set(`${ROOT}/scripts/build_tool.py`, "");
    await index.rebuild();
    files.files.set(`${ROOT}/py/app/main.py`, "from acme.platform import util\nfrom scripts import build_tool\nfrom google.cloud import storage\nimport numpy\n");
    expect(analyze("py/app/main.py", "python").entries.map(summary)).toEqual([
      "acme.platform: skip local-module",
      "scripts: skip local-module",
      "google-cloud-storage: google-cloud-storage latest",
      "numpy: numpy latest",
    ]);
  });

  it("looks up undeclared imports at latest when no workspace manifest names a private index", async () => {
    files.files.delete(`${ROOT}/py/requirements-private.txt`);
    await index.rebuild();
    expect(analyze("py/app/main.py", "python").entries.map(summary)).toContain("numpy: numpy latest");
  });

  it("analyses requirements and pyproject manifests", () => {
    expect(analyze("py/requirements.txt", "pip-requirements").entries.map(summary)).toEqual([
      "requests: requests 2.31.0 manifest declared",
      "PyYAML: pyyaml >=6.0 range declared",
      "opencv-python-headless: opencv-python-headless latest declared",
      "localpkg: skip non-registry",
    ]);
    expect(analyze("py/pyproject.toml", "toml").entries.map(summary)).toEqual(["httpx: httpx 0.27.2 lockfile declared"]);
    expect(analyze("py/requirements-private.txt", "pip-requirements").entries.map(summary)).toEqual([
      "internal-tool: excluded (its requirements file uses a package index other than PyPI)",
    ]);
  });
});

describe("analyze Go", () => {
  it("maps imports to modules with replaces, GOPRIVATE and well-known hosts", () => {
    const a = analyze("go/main.go", "go");
    expect(a.entries.map(summary)).toEqual([
      "fmt: skip builtin",
      "github.com/stretchr/testify: github.com/stretchr/testify v1.9.0 manifest declared",
      "github.com/aws/aws-sdk-go-v2/service/s3: github.com/aws/aws-sdk-go-v2/service/s3 v1.58.0 manifest declared",
      "github.com/aws/aws-sdk-go-v2: github.com/aws/aws-sdk-go-v2 v1.30.0 manifest declared",
      "github.com/someone/forked: github.com/someone/forked v1.1.0 manifest declared",
      "example.com/local: skip non-registry",
      "example.com/acme/svc/internal/db: skip self",
      "github.com/spf13/cobra: github.com/spf13/cobra latest",
      "git.unknown.example/x/y: skip unmapped",
      "git.corp.example/team/lib: excluded (matches GOPRIVATE, GONOPROXY or GONOSUMDB)",
    ]);
  });

  it("analyses go.mod", () => {
    expect(analyze("go/go.mod", "go.mod").entries.map(summary)).toEqual([
      "github.com/stretchr/testify: github.com/stretchr/testify v1.9.0 manifest declared",
      "github.com/aws/aws-sdk-go-v2: github.com/aws/aws-sdk-go-v2 v1.30.0 manifest declared",
      "github.com/aws/aws-sdk-go-v2/service/s3: github.com/aws/aws-sdk-go-v2/service/s3 v1.58.0 manifest declared",
      "example.com/forked: github.com/someone/forked v1.1.0 manifest declared",
      "example.com/local: skip non-registry",
      "git.corp.example/team/lib: excluded (matches GOPRIVATE, GONOPROXY or GONOSUMDB)",
    ]);
  });
});

describe("WorkspaceIndex", () => {
  it("lists manifests and reacts to file changes", async () => {
    expect(index.manifests().map((m) => m.uri.slice(ROOT.length + 1))).toEqual([
      "go/go.mod",
      "package.json",
      "packages/ui/package.json",
      "packages/web/package.json",
      "py/pyproject.toml",
      "py/requirements-private.txt",
      "py/requirements.txt",
    ]);
    let fired = 0;
    index.onDidChange(() => fired++);
    files.files.set(`${ROOT}/packages/web/package.json`, '{ "dependencies": { "lodash": "4.17.21" } }');
    await index.fileChanged(`${ROOT}/packages/web/package.json`);
    expect(fired).toBe(1);
    expect(analyze("packages/web/src/index.ts", "typescript").entries.map(summary)).toContain("react: react 18.3.1 lockfile");
    files.files.delete(`${ROOT}/.npmrc`);
    await index.fileChanged(`${ROOT}/.npmrc`);
    // The scope binding is gone, but the lockfile still names the private registry.
    expect(analyze("packages/web/src/index.ts", "typescript").entries.map(summary)).toContain(
      "@acme/private: excluded (the lockfile resolves it from a registry other than the public one)",
    );
  });

  it("skips a Python module created after the index was built and announces it once", async () => {
    const clock = new FakeClock();
    index = new WorkspaceIndexImpl(files, silent, clock);
    files.files.delete(`${ROOT}/py/requirements-private.txt`);
    await index.rebuild();
    files.files.set(`${ROOT}/py/app/main.py`, "import helpers\nimport numpy\n");
    expect(analyze("py/app/main.py", "python").entries.map(summary)).toEqual(["helpers: helpers latest", "numpy: numpy latest"]);
    let fired = 0;
    index.onDidChange(() => fired++);
    files.files.set(`${ROOT}/py/helpers.py`, "");
    files.files.set(`${ROOT}/py/tools/__init__.py`, "");
    await index.fileChanged(`${ROOT}/py/helpers.py`);
    await index.fileChanged(`${ROOT}/py/tools/__init__.py`);
    await index.fileChanged(`${ROOT}/py/helpers.py`);
    expect(fired).toBe(0);
    await clock.advance(1000);
    expect(fired).toBe(1);
    expect(analyze("py/app/main.py", "python").entries.map(summary)).toEqual(["helpers: skip local-module", "numpy: numpy latest"]);
    // A name already known announces nothing.
    await index.fileChanged(`${ROOT}/py/helpers.py`);
    await clock.advance(1000);
    expect(fired).toBe(1);
  });

  it("follows the unsaved text of an open manifest, and fires once per change", async () => {
    let fired = 0;
    index.onDidChange(() => fired++);
    const uri = `${ROOT}/packages/web/package.json`;
    const before = must(index.findDeclaration("npm", `${ROOT}/packages/web/src/index.ts`, "lodash", "rawName"));
    const edited = `{\n  "name": "@acme/web",\n  "description": "added above",\n  "dependencies": {\n    "lodash": "^4.17.21"\n  }\n}\n`;
    index.documentChanged(uri, edited);
    index.documentChanged(uri, edited);
    await Promise.resolve();
    expect(fired).toBe(1);
    const after = must(index.findDeclaration("npm", `${ROOT}/packages/web/src/index.ts`, "lodash", "rawName"));
    expect(after.dep.spec).toBe("^4.17.21");
    expect(after.dep.line).toBeGreaterThan(before.dep.line);
    // Manifests outside the workspace folders are not indexed.
    index.documentChanged("file:///elsewhere/package.json", '{ "dependencies": { "x": "1" } }');
    await Promise.resolve();
    expect(fired).toBe(1);
    expect(index.manifests().some((m) => m.uri.startsWith("file:///elsewhere"))).toBe(false);
  });

  it("reads scope bindings from the user .npmrc too", async () => {
    files.files.delete(`${ROOT}/.npmrc`);
    files.userNpmrc = "@acme:registry=https://npm.acme.example/\n";
    await index.rebuild();
    expect(analyze("packages/web/src/index.ts", "typescript").entries.map(summary)).toContain(
      "@acme/private: excluded (the `@acme` scope uses another registry (.npmrc))",
    );
  });

  it("reads Yarn Berry scopes, whose lockfile names no registry", async () => {
    const yarn = new MemoryFiles(["file:///berry"]).add({
      "package.json": JSON.stringify({ name: "app", dependencies: { "@acme/core": "^1.0.0", lodash: "^4.17.0" } }),
      ".yarnrc.yml": 'nodeLinker: node-modules\nnpmScopes:\n  acme:\n    npmRegistryServer: "https://npm.acme.example"\n    npmAuthToken: "${TOKEN}"\n',
      "yarn.lock": '__metadata:\n  version: 8\n\n"@acme/core@npm:^1.0.0":\n  version: 1.2.0\n  resolution: "@acme/core@npm:1.2.0"\n\n"lodash@npm:^4.17.0":\n  version: 4.17.21\n  resolution: "lodash@npm:4.17.21"\n',
      "src/index.ts": 'import core from "@acme/core";\nimport _ from "lodash";\n',
    });
    const idx = new WorkspaceIndexImpl(yarn, silent);
    await idx.rebuild();
    const uri = "file:///berry/src/index.ts";
    const a = analyzeDocument({ uri, languageId: "typescript", text: must(yarn.files.get(uri)) }, idx, filter, options);
    expect(a.entries.map(summary)).toEqual([
      "@acme/core: excluded (the `@acme` scope uses another registry (.yarnrc.yml))",
      "lodash: lodash 4.17.21 lockfile declared",
    ]);
  });

  it("refuses unscoped packages behind a private default registry when pnpm records no tarball", async () => {
    const pnpm = new MemoryFiles(["file:///corp"]).add({
      "package.json": JSON.stringify({ name: "app", dependencies: { "acme-utils": "^2.0.0" } }),
      ".npmrc": "registry=https://npm.corp.example/\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      acme-utils:\n        specifier: ^2.0.0\n        version: 2.1.0\npackages:\n  acme-utils@2.1.0:\n    resolution: {integrity: sha512-x}\n",
      "bunfig.toml": '[install.scopes]\nother = "https://npm.other.example/"\n',
      "src/a.ts": 'import u from "acme-utils";\nimport o from "@other/x";\n',
    });
    const idx = new WorkspaceIndexImpl(pnpm, silent);
    await idx.rebuild();
    const uri = "file:///corp/src/a.ts";
    const a = analyzeDocument({ uri, languageId: "typescript", text: must(pnpm.files.get(uri)) }, idx, filter, options);
    expect(a.entries.map(summary)).toEqual([
      "acme-utils: excluded (the default npm registry (.npmrc) is not the public one and no lockfile shows where the package comes from)",
      "@other/x: excluded (the `@other` scope uses another registry (bunfig.toml))",
    ]);
  });

  it("ignores documents inside dependency folders", () => {
    const uri = `${ROOT}/node_modules/x/index.js`;
    expect(analyzeDocument({ uri, languageId: "javascript", text: 'require("y")' }, index, filter, options).kind).toBe("unsupported");
  });
});
