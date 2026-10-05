import { describe, expect, it } from "vitest";
import { parsePackageJson } from "../../../src/core/parsers/packageJson";
import { parseRequirements, parsePep508 } from "../../../src/core/parsers/requirements";
import { parsePyproject } from "../../../src/core/parsers/pyproject";
import { parseGoMod } from "../../../src/core/parsers/goMod";
import type { ManifestDependency, TextRange } from "../../../src/core/types";

function slice(text: string, r: TextRange | undefined): string {
  if (!r) return "";
  const lines = text.split("\n");
  return (lines[r.start.line] ?? "").slice(r.start.character, r.end.character);
}

const byName = (deps: ManifestDependency[], name: string): ManifestDependency => {
  const d = deps.find((x) => x.rawName === name);
  if (!d) throw new Error(`no ${name}`);
  return d;
};

describe("parsePackageJson", () => {
  const text = `{
  "name": "@acme/app",
  "workspaces": ["packages/*"],
  "imports": { "#internal/*": "./src/internal/*.js" },
  "dependencies": {
    "lodash": "^4.17.20",
    "react": "18.3.1",
    "left": "=1.0.0",
    "real-alias": "npm:@scope/real@^2.1.0",
    "sibling": "workspace:*",
    "local": "file:../local",
    "linked": "link:../linked",
    "gh": "expressjs/express#v5",
    "gitdep": "git+https://example.com/x.git",
    "tarball": "https://example.com/x.tgz",
  },
  // comments and trailing commas are tolerated
  "devDependencies": { "vitest": "^5.0.0" },
  "peerDependencies": { "react-dom": ">=18" }
}`;
  const m = parsePackageJson("file:///w/package.json", text);

  it("reads name, workspaces and imports", () => {
    expect(m.selfName).toBe("@acme/app");
    expect(m.workspaces).toEqual(["packages/*"]);
    expect(m.importsKeys).toEqual(["#internal/*"]);
  });

  it("reads specs with exact ranges", () => {
    const lodash = byName(m.dependencies, "lodash");
    expect(lodash.spec).toBe("^4.17.20");
    expect(lodash.exactVersion).toBeUndefined();
    expect(slice(text, lodash.nameRange)).toBe("lodash");
    expect(slice(text, lodash.specRange)).toBe("^4.17.20");
    expect(byName(m.dependencies, "react").exactVersion).toBe("18.3.1");
    expect(byName(m.dependencies, "left").exactVersion).toBe("1.0.0");
    expect(byName(m.dependencies, "vitest").section).toBe("devDependencies");
    expect(byName(m.dependencies, "react-dom").section).toBe("peerDependencies");
  });

  it("maps npm: aliases to the real package", () => {
    const alias = byName(m.dependencies, "real-alias");
    expect(alias.name).toBe("@scope/real");
    expect(alias.rawName).toBe("real-alias");
    expect(alias.nonRegistry).toBeUndefined();
  });

  it("marks non-registry specs", () => {
    expect(byName(m.dependencies, "sibling").nonRegistry).toBe("workspace");
    expect(byName(m.dependencies, "local").nonRegistry).toBe("file");
    expect(byName(m.dependencies, "linked").nonRegistry).toBe("link");
    expect(byName(m.dependencies, "gh").nonRegistry).toBe("git");
    expect(byName(m.dependencies, "gitdep").nonRegistry).toBe("git");
    expect(byName(m.dependencies, "tarball").nonRegistry).toBe("url");
  });

  it("returns what it can from a broken file", () => {
    const broken = parsePackageJson("file:///w/package.json", `{ "dependencies": { "a": "1.0.0", "b": `);
    expect(broken.dependencies.map((d) => d.name)).toContain("a");
  });
});

describe("parseRequirements", () => {
  const text = [
    "# comment",
    "requests==2.31.0",
    "PyYAML>=6.0,<7  # trailing comment",
    "Django[argon2] ~= 4.2 ; python_version >= '3.8'",
    "numpy (>=1.24)",
    "-r base.txt",
    "--constraint constraints.txt",
    "--index-url https://pypi.example.com/simple",
    "--extra-index-url=https://mirror.example.com/simple",
    "-e git+https://example.com/repo.git#egg=editable_pkg",
    "./local/path",
    "pkg @ https://example.com/pkg-1.0.tar.gz",
    "hashed==1.0 \\",
    "    --hash=sha256:abc",
    "bare",
  ].join("\n");
  const m = parseRequirements("file:///w/requirements.txt", text);

  it("reads names, specs and exact versions", () => {
    const r = byName(m.dependencies, "requests");
    expect(r.exactVersion).toBe("2.31.0");
    expect(slice(text, r.specRange)).toBe("==2.31.0");
    const y = byName(m.dependencies, "PyYAML");
    expect(y.name).toBe("pyyaml");
    expect(y.spec).toBe(">=6.0,<7");
    expect(y.exactVersion).toBeUndefined();
    expect(byName(m.dependencies, "Django").spec).toBe("~= 4.2");
    expect(byName(m.dependencies, "numpy").spec).toBe(">=1.24");
    expect(byName(m.dependencies, "hashed").exactVersion).toBe("1.0");
    expect(byName(m.dependencies, "bare").spec).toBe("");
  });

  it("records includes and index URLs", () => {
    expect(m.includes).toEqual(["base.txt", "constraints.txt"]);
    expect(m.indexUrls).toEqual(["https://pypi.example.com/simple", "https://mirror.example.com/simple"]);
  });

  it("marks editable and direct references", () => {
    expect(byName(m.dependencies, "editable_pkg").nonRegistry).toBe("editable");
    expect(byName(m.dependencies, "pkg").nonRegistry).toBe("url");
    expect(m.dependencies.some((d) => d.rawName === "local")).toBe(false);
  });

  it("parses PEP 508 markers and extras", () => {
    expect(parsePep508("name[a,b]>=1; sys_platform == 'win32'")).toMatchObject({ name: "name", spec: ">=1" });
    expect(parsePep508("name @ git+https://x/y.git")).toMatchObject({ name: "name", nonRegistry: "git" });
  });
});

describe("parsePyproject", () => {
  const text = `[project]
name = "My_Project"
dependencies = [
  "requests>=2.31",
  'PyYAML==6.0.1',  # pinned
  "local @ file:///tmp/x",
]

[project.optional-dependencies]
dev = ["pytest>=8"]

[dependency-groups]
lint = ["ruff==0.6.0", {include-group = "dev"}]

[tool.uv]
dev-dependencies = ["mypy"]

[tool.poetry.dependencies]
python = "^3.11"
httpx = "^0.27"
attrs = { version = "23.2.0", extras = ["x"] }
mylib = { path = "../mylib", develop = true }
fromgit = { git = "https://example.com/x.git" }

[tool.poetry.group.test.dependencies]
hypothesis = "*"
`;
  const m = parsePyproject("file:///w/pyproject.toml", text);

  it("reads the project name", () => {
    expect(m.selfName).toBe("My_Project");
  });

  it("reads PEP 621, PEP 735 and uv lists", () => {
    const req = byName(m.dependencies, "requests");
    expect(req.section).toBe("project.dependencies");
    expect(slice(text, req.nameRange)).toBe("requests");
    expect(slice(text, req.specRange)).toBe(">=2.31");
    expect(byName(m.dependencies, "PyYAML").exactVersion).toBe("6.0.1");
    expect(byName(m.dependencies, "local").nonRegistry).toBe("file");
    expect(byName(m.dependencies, "pytest").section).toBe("project.optional-dependencies.dev");
    expect(byName(m.dependencies, "ruff").section).toBe("dependency-groups.lint");
    expect(byName(m.dependencies, "mypy").section).toBe("tool.uv.dev-dependencies");
  });

  it("reads Poetry tables and groups", () => {
    expect(m.dependencies.some((d) => d.rawName === "python")).toBe(false);
    const httpx = byName(m.dependencies, "httpx");
    expect(httpx.spec).toBe("^0.27");
    expect(slice(text, httpx.nameRange)).toBe("httpx");
    expect(slice(text, httpx.specRange)).toBe("^0.27");
    const attrs = byName(m.dependencies, "attrs");
    expect(attrs.exactVersion).toBe("23.2.0");
    expect(slice(text, attrs.specRange)).toBe("23.2.0");
    expect(byName(m.dependencies, "mylib").nonRegistry).toBe("file");
    expect(byName(m.dependencies, "fromgit").nonRegistry).toBe("git");
    expect(byName(m.dependencies, "hypothesis").section).toBe("tool.poetry.group.test.dependencies");
  });

  it("tolerates a half-typed file", () => {
    const partial = parsePyproject("file:///w/pyproject.toml", `[project]\ndependencies = [\n  "requests>=2",\n  "fla`);
    expect(partial.dependencies.map((d) => d.rawName)).toContain("requests");
  });
});

describe("parseGoMod", () => {
  const text = `module example.com/me/app

go 1.22

require github.com/stretchr/testify v1.9.0

require (
\tgithub.com/aws/aws-sdk-go-v2 v1.30.0
\tgithub.com/aws/aws-sdk-go-v2/service/s3 v1.58.0 // indirect
\tgolang.org/x/mod v0.20.0
\texample.com/forked v1.0.0
\texample.com/local v0.0.0-00010101000000-000000000000
)

replace example.com/forked => github.com/someone/forked v1.1.0

replace (
\texample.com/local => ../local
)
`;
  const m = parseGoMod("file:///w/go.mod", text);

  it("reads the module path and requirements", () => {
    expect(m.module).toBe("example.com/me/app");
    expect(m.dependencies.map((d) => d.name)).toEqual([
      "github.com/stretchr/testify",
      "github.com/aws/aws-sdk-go-v2",
      "github.com/aws/aws-sdk-go-v2/service/s3",
      "golang.org/x/mod",
      "example.com/forked",
      "example.com/local",
    ]);
    const s3 = byName(m.dependencies, "github.com/aws/aws-sdk-go-v2/service/s3");
    expect(s3.indirect).toBe(true);
    expect(s3.exactVersion).toBe("v1.58.0");
    expect(slice(text, s3.specRange)).toBe("v1.58.0");
    expect(slice(text, s3.nameRange)).toBe("github.com/aws/aws-sdk-go-v2/service/s3");
  });

  it("reads replaces and marks local ones", () => {
    expect(m.replaces).toEqual([
      expect.objectContaining({ from: "example.com/forked", to: "github.com/someone/forked", toVersion: "v1.1.0", local: false }),
      expect.objectContaining({ from: "example.com/local", to: "../local", local: true }),
    ]);
    expect(byName(m.dependencies, "example.com/local").nonRegistry).toBe("local-replace");
    expect(byName(m.dependencies, "example.com/forked").nonRegistry).toBeUndefined();
  });
});
