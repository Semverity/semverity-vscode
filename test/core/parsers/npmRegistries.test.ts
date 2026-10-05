import { describe, expect, it } from "vitest";
import { mergeRegistryConfig, parseBunfig, parseNpmRegistryFile, parseNpmrc, parseYarnrc, parseYarnrcYml, type NpmRegistryConfig } from "../../../src/core/parsers/npmRegistries";

function flat(config: NpmRegistryConfig): { scopes: Record<string, string[]>; defaults: string[] } {
  const scopes: Record<string, string[]> = {};
  for (const [k, list] of config.scopes) scopes[k] = list.map((b) => `${b.host} (${b.source})`);
  return { scopes, defaults: config.defaults.map((b) => `${b.host} (${b.source})`) };
}

describe("npm registry configuration", () => {
  it("reads the default registry line of .npmrc", () => {
    expect(flat(parseNpmrc("registry = https://npm.corp.example/\n_auth=SECRET"))).toEqual({ scopes: {}, defaults: ["npm.corp.example (.npmrc)"] });
  });

  it("reads Yarn 1 .yarnrc registry lines", () => {
    const text = ['registry "https://npm.corp.example/"', '"@acme:registry" "https://npm.acme.example/"', 'email "someone@example.com"'].join("\n");
    expect(flat(parseYarnrc(text))).toEqual({ scopes: { "@acme": ["npm.acme.example (.yarnrc)"] }, defaults: ["npm.corp.example (.yarnrc)"] });
  });

  it("reads Yarn Berry npmScopes and npmRegistryServer, and never keeps tokens", () => {
    const text = [
      'npmRegistryServer: "https://npm.corp.example"',
      "npmScopes:",
      "  acme:",
      '    npmRegistryServer: "https://npm.acme.example"',
      '    npmAuthToken: "SECRET-TOKEN"',
      "  public:",
      "    npmAlwaysAuth: true",
    ].join("\n");
    const config = parseYarnrcYml(text);
    expect(flat(config)).toEqual({ scopes: { "@acme": ["npm.acme.example (.yarnrc.yml)"] }, defaults: ["npm.corp.example (.yarnrc.yml)"] });
    expect(JSON.stringify([...config.scopes, ...config.defaults])).not.toContain("SECRET");
  });

  it("reads bunfig.toml install.registry and install.scopes in both forms", () => {
    const text = [
      "[install]",
      'registry = { url = "https://npm.corp.example/", token = "SECRET" }',
      "[install.scopes]",
      'acme = "https://npm.acme.example/"',
      '"@other" = { url = "https://npm.other.example/", token = "SECRET" }',
    ].join("\n");
    const config = parseBunfig(text);
    expect(flat(config)).toEqual({
      scopes: { "@acme": ["npm.acme.example (bunfig.toml)"], "@other": ["npm.other.example (bunfig.toml)"] },
      defaults: ["npm.corp.example (bunfig.toml)"],
    });
    expect(JSON.stringify([...config.scopes, ...config.defaults])).not.toContain("SECRET");
  });

  it("keeps every binding when merging and ignores broken files", () => {
    const merged = mergeRegistryConfig(parseNpmrc("@acme:registry=https://registry.npmjs.org/"), parseYarnrcYml("npmScopes:\n  acme:\n    npmRegistryServer: https://npm.acme.example\n"));
    expect(flat(merged).scopes["@acme"]).toEqual(["registry.npmjs.org (.npmrc)", "npm.acme.example (.yarnrc.yml)"]);
    expect(flat(parseYarnrcYml(": : not yaml ["))).toEqual({ scopes: {}, defaults: [] });
    expect(flat(parseBunfig("[install"))).toEqual({ scopes: {}, defaults: [] });
    expect(parseNpmRegistryFile("package.json", "{}")).toBeUndefined();
  });
});
