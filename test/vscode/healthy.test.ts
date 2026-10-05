import { describe, expect, it } from "vitest";
import { parseGoMod } from "../../src/core/parsers/goMod";
import { parsePackageJson } from "../../src/core/parsers/packageJson";
import type { DeclaredIn } from "../../src/core/types";
import { currentBumpEdit, isPlainVersion, type ManifestEdit } from "../../src/presentation/quickfix";
import type { Core } from "../../src/core/index";
import { healthyEdit, listingNow } from "../../src/vscode/healthy";
import { PendingEdits } from "../../src/vscode/pendingEdits";
import { card, entry, listing, scored } from "../helpers/cards";

/** Applies a single-line edit to text. */
function apply(text: string, edit: ManifestEdit): string {
  const lines = text.split("\n");
  const { start, end } = edit.range;
  const line = lines[start.line] ?? "";
  lines[start.line] = line.slice(0, start.character) + edit.newText + (lines[end.line] ?? "").slice(end.character);
  return lines.join("\n");
}

const URI = "file:///ws/package.json";

function declared(text: string, name: string): DeclaredIn {
  const m = parsePackageJson(URI, text);
  const dep = m.dependencies.find((d) => d.name === name);
  if (!dep) throw new Error(name);
  return { manifestUri: URI, manifestKind: "package.json", dependency: dep };
}

describe("currentBumpEdit", () => {
  it("finds the dependency again in the current text instead of trusting an old range", () => {
    const saved = '{\n  "dependencies": {\n    "x": "^1.2"\n  }\n}\n';
    const stale = declared(saved, "x");
    // The first bump, then a second request computed from the stale parse.
    const once = apply(saved, must(currentBumpEdit(stale, "1.10.3", saved)));
    expect(once).toContain('"x": "^1.10.3"');
    expect(currentBumpEdit(stale, "1.10.3", once)).toBeUndefined();
    // Unsaved lines above the dependency move it down.
    const edited = '{\n  "name": "app",\n  "description": "more",\n  "dependencies": {\n    "x": "^1.2"\n  }\n}\n';
    expect(apply(edited, must(currentBumpEdit(stale, "1.10.3", edited)))).toContain('"x": "^1.10.3"');
    // A dependency that is gone is not edited.
    expect(currentBumpEdit(stale, "1.10.3", '{ "dependencies": {} }')).toBeUndefined();
  });

  it("never writes a version that is not plain", () => {
    const text = '{ "dependencies": { "x": "^1.2.0" } }';
    expect(currentBumpEdit(declared(text, "x"), '1.3.0", "postinstall": "curl evil', text)).toBeUndefined();
    expect(isPlainVersion("1.3.0")).toBe(true);
    expect(isPlainVersion("v0.0.0-20240101000000-abcdef123456")).toBe(true);
    expect(isPlainVersion("2.0.0rc1")).toBe(true);
    expect(isPlainVersion("1.0 ")).toBe(false);
    expect(isPlainVersion("latest")).toBe(false);
  });
});

describe("healthyEdit", () => {
  it("offers no go.mod bump when a replace swaps in another module", () => {
    const gomod = "module example.com/app\n\nrequire github.com/a/b v1.2.3\n\nreplace github.com/a/b v1.2.3 => github.com/x/b v1.5.0\n";
    const m = parseGoMod("file:///ws/go.mod", gomod);
    const dep = must(m.dependencies.find((d) => d.name === "github.com/a/b"));
    const decl: DeclaredIn = { manifestUri: m.uri, manifestKind: "go.mod", dependency: dep };
    const replaced = entry({ target: { id: { ecosystem: "golang", name: "github.com/x/b" }, version: "v1.5.0", versionSource: "manifest" }, declaredIn: decl });
    const result = scored(card({ ecosystem: "golang", name: "github.com/x/b", version: "v1.5.0" }));
    expect(healthyEdit(replaced, result, listing("v1.6.0"))).toBeUndefined();
    // Without the replace, the require line is bumped.
    const plain = entry({ target: { id: { ecosystem: "golang", name: "github.com/a/b" }, version: "v1.2.3", versionSource: "manifest" }, declaredIn: decl });
    const plainResult = scored(card({ ecosystem: "golang", name: "github.com/a/b", version: "v1.2.3" }));
    expect(healthyEdit(plain, plainResult, listing("v1.6.0"))?.edit.newText).toBe("v1.6.0");
  });
});

describe("listingNow", () => {
  function fakeCore(answer: () => Promise<ReturnType<typeof listing> | undefined>) {
    let calls = 0;
    const core = {
      lookups: {
        status: () => ({ state: "online" }),
        listing: () => {
          calls++;
          return answer();
        },
      },
    } as unknown as Core;
    return { core, calls: () => calls };
  }
  const target = { id: { ecosystem: "npm" as const, name: "lodash" }, version: "4.17.21", versionSource: "manifest" as const };

  it("answers a cached listing at once", async () => {
    const f = fakeCore(() => Promise.resolve(listing("4.18.1")));
    expect((await listingNow(f.core, entry({ target }), scored(card())))?.healthy).toBe("4.18.1");
  });

  it("does not wait for a listing that is not cached, but requests it", async () => {
    const f = fakeCore(() => new Promise(() => undefined));
    const started = Date.now();
    expect(await listingNow(f.core, entry({ target }), scored(card()))).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(500);
    expect(f.calls()).toBe(1);
  });
});

describe("PendingEdits", () => {
  it("hands out opaque ids and forgets the oldest", () => {
    const pending = new PendingEdits();
    const decl = declared('{ "dependencies": { "x": "1.0.0" } }', "x");
    const first = pending.register({ declaredIn: decl, version: "1.1.0" });
    expect(pending.get(first)?.version).toBe("1.1.0");
    expect(pending.get({ uri: "file:///etc/passwd" })).toBeUndefined();
    expect(pending.get("nope")).toBeUndefined();
    for (let i = 0; i < 250; i++) pending.register({ declaredIn: decl, version: `1.${i}.0` });
    expect(pending.get(first)).toBeUndefined();
  });
});

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("missing");
  return v;
}
