import { describe, expect, it } from "vitest";
import {
  cardPath,
  coordinateKey,
  fromPurl,
  listingPath,
  normalizePypiName,
  packagePageUrl,
  toPurl,
} from "../../src/core/api/purl";

describe("purl and paths", () => {
  it("encodes an npm scope the way the API echoes it", () => {
    expect(toPurl({ ecosystem: "npm", name: "@types/node", version: "26.6.4" })).toBe("pkg:npm/%40types/node@26.6.4");
  });

  it("normalises PyPI names per PEP 503", () => {
    expect(normalizePypiName("PyYAML")).toBe("pyyaml");
    expect(normalizePypiName("Foo__Bar.baz")).toBe("foo-bar-baz");
    expect(toPurl({ ecosystem: "pypi", name: "PyYAML", version: "6.0.3" })).toBe("pkg:pypi/pyyaml@6.0.3");
  });

  it("keeps Go module paths and encodes build metadata", () => {
    expect(toPurl({ ecosystem: "golang", name: "github.com/stretchr/testify", version: "v1.12.1" })).toBe(
      "pkg:golang/github.com/stretchr/testify@v1.12.1",
    );
    expect(toPurl({ ecosystem: "golang", name: "github.com/a/b", version: "v2.0.0+incompatible" })).toBe(
      "pkg:golang/github.com/a/b@v2.0.0%2Bincompatible",
    );
  });

  it("round-trips purls the API returns", () => {
    expect(fromPurl("pkg:npm/%40types/node@26.6.4")).toEqual({ ecosystem: "npm", name: "@types/node", version: "26.6.4" });
    expect(fromPurl("pkg:cargo/serde@1.0.0")).toBeUndefined();
  });

  it("builds listing and card paths with a raw scope", () => {
    expect(listingPath({ ecosystem: "npm", name: "@types/node" })).toBe("/v1/packages/npm/@types/node");
    expect(cardPath({ ecosystem: "npm", name: "lodash", version: "4.18.1" })).toBe("/v1/packages/npm/lodash/versions/4.18.1");
  });

  it("uses the unambiguous forms for names with a versions segment", () => {
    const id = { ecosystem: "golang" as const, name: "example.com/versions/v2" };
    expect(listingPath(id)).toBe("/v1/packages/golang/example.com/versions/v2/versions");
    expect(cardPath({ ...id, version: "v2.0.0" })).toBe("/v1/packages/golang/example.com/versions/v2?version=v2.0.0");
  });

  it("links package pages", () => {
    expect(packagePageUrl("https://semverity.dev/", { ecosystem: "npm", name: "@types/node" })).toBe(
      "https://semverity.dev/registry/npm/@types/node",
    );
    expect(packagePageUrl("https://semverity.dev", { ecosystem: "pypi", name: "PyYAML" }, "6.0.3")).toBe(
      "https://semverity.dev/registry/pypi/pyyaml/versions/6.0.3",
    );
  });

  it("keys coordinates case-insensitively for PyPI only", () => {
    expect(coordinateKey({ ecosystem: "pypi", name: "PyYAML", version: "6.0.3" })).toBe("pypi:pyyaml@6.0.3");
    expect(coordinateKey({ ecosystem: "npm", name: "React", version: "1.0.0" })).toBe("npm:React@1.0.0");
  });
});
