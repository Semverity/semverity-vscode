import { describe, expect, it } from "vitest";
import { npmPackageFor } from "../../../src/core/mapping/npm";

describe("npmPackageFor", () => {
  const ctx = { patterns: ["@app/*", "config"], baseUrlNames: new Set(["components"]), selfNames: new Set(["@acme/app", "my-lib"]) };
  const cases: [string, ReturnType<typeof npmPackageFor>][] = [
    ["./x", { skip: "relative" }],
    ["../x/y", { skip: "relative" }],
    ["/abs/path", { skip: "relative" }],
    ["file:///x.js", { skip: "relative" }],
    ["node:fs", { skip: "builtin", detail: "fs" }],
    ["fs", { skip: "builtin", detail: "fs" }],
    ["fs/promises", { skip: "builtin", detail: "fs/promises" }],
    ["node:test", { skip: "builtin", detail: "test" }],
    ["bun:sqlite", { skip: "builtin", detail: "bun:sqlite" }],
    ["virtual:pwa-register", { skip: "builtin", detail: "virtual:pwa-register" }],
    ["https://esm.sh/react", { skip: "builtin", detail: "https://esm.sh/react" }],
    ["npm:preact@10", { name: "preact" }],
    ["npm:@scope/x@^1", { name: "@scope/x" }],
    ["#internal/util", { skip: "alias" }],
    ["@app/store", { skip: "alias", detail: "@app/*" }],
    ["config", { skip: "alias", detail: "config" }],
    ["components/Button", { skip: "alias", detail: "baseUrl" }],
    ["@/utils", { skip: "alias" }],
    ["~/utils", { skip: "alias" }],
    ["~utils", { skip: "alias" }],
    ["style-loader!css-loader!./x.css", { skip: "unmapped", detail: "loader syntax" }],
    ["@scope/name/sub/path", { name: "@scope/name" }],
    ["lodash/fp", { name: "lodash" }],
    ["lodash", { name: "lodash" }],
    ["JSONStream", { name: "JSONStream" }],
    ["@scope", { skip: "unmapped" }],
    ["bad name", { skip: "unmapped" }],
    ["my-lib/x", { skip: "self" }],
    ["@acme/app", { skip: "self" }],
  ];
  for (const [spec, want] of cases) {
    it(`maps ${spec}`, () => {
      expect(npmPackageFor(spec, ctx)).toEqual(want);
    });
  }

  it("rejects names over 214 characters", () => {
    expect(npmPackageFor("a".repeat(215))).toEqual({ skip: "unmapped" });
  });
});
