import { describe, expect, it } from "vitest";
import { ancestors, basename, dirname, isUnder, join, relative } from "../../src/core/uri";
import { Emitter } from "../../src/core/emitter";

describe("uri helpers", () => {
  it("splits and joins file URIs", () => {
    expect(dirname("file:///ws/a/b.ts")).toBe("file:///ws/a");
    expect(dirname("file:///ws")).toBe("file:///");
    expect(basename("file:///ws/a/my%20file.ts")).toBe("my file.ts");
    expect(join("file:///ws/a", "./src", "../lib", "x.ts")).toBe("file:///ws/a/lib/x.ts");
    expect(join("file:///c%3A/ws", "src")).toBe("file:///c%3A/ws/src");
  });

  it("walks ancestors up to a root, nearest first", () => {
    expect(ancestors("file:///ws/a/b/c.ts", "file:///ws")).toEqual(["file:///ws/a/b", "file:///ws/a", "file:///ws"]);
    expect(ancestors("file:///other/c.ts", "file:///ws")).toEqual([]);
    expect(isUnder("file:///ws2/x", "file:///ws")).toBe(false);
  });

  it("computes relative paths", () => {
    expect(relative("file:///ws", "file:///ws/packages/web")).toBe("packages/web");
    expect(relative("file:///ws/a", "file:///ws/b/c")).toBe("../b/c");
    expect(relative("file:///ws", "file:///ws")).toBe("");
  });
});

describe("Emitter", () => {
  it("delivers to listeners until disposed, isolating failures", () => {
    const e = new Emitter<number>();
    const seen: number[] = [];
    e.event(() => {
      throw new Error("listener failure");
    });
    const sub = e.event((v) => seen.push(v));
    e.fire(1);
    sub.dispose();
    e.fire(2);
    expect(seen).toEqual([1]);
  });
});
