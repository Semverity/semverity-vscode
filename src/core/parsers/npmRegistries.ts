// npm registry configuration: which registry each scope (and the default) is
// bound to, read from .npmrc, the Yarn 1 .yarnrc, the Yarn Berry .yarnrc.yml
// and Bun's bunfig.toml. Only registry URLs are kept, reduced to their host;
// tokens, passwords and every other setting are skipped without being stored,
// so no credential enters the extension's memory beyond this scan.

import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { hostOf } from "./lockfiles";

/** A registry host and the file (or variable) that configured it. */
export interface RegistryBinding {
  /** Lowercase host ("npm.acme.example"); "unknown" when the URL cannot be read (a variable, a typo). */
  host: string;
  /** ".npmrc", ".yarnrc", ".yarnrc.yml", "bunfig.toml" or an environment variable name. */
  source: string;
}

/**
 * Every registry binding found, kept rather than overridden: which tool (npm,
 * Yarn, pnpm, Bun) installs the workspace is not known, so the privacy filter
 * refuses a package when any of the bindings that could apply is not public.
 */
export interface NpmRegistryConfig {
  /** "@scope" (lowercase) to the registries it is bound to. */
  scopes: Map<string, RegistryBinding[]>;
  /** The default (unscoped) registries configured. */
  defaults: RegistryBinding[];
}

/** The workspace files that configure npm registries, by base name. */
export const NPM_REGISTRY_FILES = [".npmrc", ".yarnrc", ".yarnrc.yml", "bunfig.toml"] as const;
export type NpmRegistryFile = (typeof NPM_REGISTRY_FILES)[number];

export function emptyRegistryConfig(): NpmRegistryConfig {
  return { scopes: new Map(), defaults: [] };
}

function addScope(config: NpmRegistryConfig, scope: string, b: RegistryBinding): void {
  const list = config.scopes.get(scope);
  if (list) list.push(b);
  else config.scopes.set(scope, [b]);
}

function binding(url: unknown, source: string): RegistryBinding | undefined {
  if (typeof url !== "string") return undefined;
  const value = url.trim().replace(/^["']|["']$/g, "");
  if (value === "") return undefined;
  return { host: hostOf(value) ?? "unknown", source };
}

function scopeKey(name: string): string {
  const s = name.trim().replace(/^["']|["']$/g, "").toLowerCase();
  return s.startsWith("@") ? s : `@${s}`;
}

/** .npmrc: `@scope:registry=<url>` and `registry=<url>` lines only. */
export function parseNpmrc(text: string): NpmRegistryConfig {
  const config = emptyRegistryConfig();
  for (const line of text.split(/\r?\n/)) {
    const scoped = /^\s*(@[^\s:=]+):registry\s*=\s*(.*?)\s*$/.exec(line);
    if (scoped?.[1]) {
      const b = binding(scoped[2] ?? "", ".npmrc") ?? { host: "unknown", source: ".npmrc" };
      addScope(config, scoped[1].toLowerCase(), b);
      continue;
    }
    const plain = /^\s*registry\s*=\s*(.*?)\s*$/.exec(line);
    if (plain) config.defaults.push(binding(plain[1] ?? "", ".npmrc") ?? { host: "unknown", source: ".npmrc" });
  }
  return config;
}

/** Yarn 1 .yarnrc: `registry "<url>"` and `"@scope:registry" "<url>"` lines only. */
export function parseYarnrc(text: string): NpmRegistryConfig {
  const config = emptyRegistryConfig();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*("?)(@[^\s:"]+:registry|registry)\1\s+(.*?)\s*$/.exec(line);
    if (!m?.[2]) continue;
    const b = binding(m[3] ?? "", ".yarnrc") ?? { host: "unknown", source: ".yarnrc" };
    if (m[2] === "registry") config.defaults.push(b);
    else addScope(config, m[2].slice(0, -":registry".length).toLowerCase(), b);
  }
  return config;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Yarn Berry .yarnrc.yml: `npmRegistryServer` and `npmScopes.<scope>.npmRegistryServer`. */
export function parseYarnrcYml(text: string): NpmRegistryConfig {
  const config = emptyRegistryConfig();
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return config;
  }
  if (!isRecord(doc)) return config;
  const def = binding(doc["npmRegistryServer"], ".yarnrc.yml");
  if (def) config.defaults.push(def);
  const scopes = doc["npmScopes"];
  if (isRecord(scopes)) {
    for (const [name, value] of Object.entries(scopes)) {
      if (!isRecord(value)) continue;
      // A scope without its own server uses the default one, which the default check covers.
      const b = binding(value["npmRegistryServer"], ".yarnrc.yml");
      if (b) addScope(config, scopeKey(name), b);
    }
  }
  return config;
}

/** Bun's bunfig.toml: `[install] registry` and `[install.scopes]` (a URL string or a table with `url`). */
export function parseBunfig(text: string): NpmRegistryConfig {
  const config = emptyRegistryConfig();
  let doc: unknown;
  try {
    doc = parseToml(text);
  } catch {
    return config;
  }
  const install = isRecord(doc) ? doc["install"] : undefined;
  if (!isRecord(install)) return config;
  const urlOf = (v: unknown): unknown => (isRecord(v) ? v["url"] : v);
  const def = binding(urlOf(install["registry"]), "bunfig.toml");
  if (def) config.defaults.push(def);
  const scopes = install["scopes"];
  if (isRecord(scopes)) {
    for (const [name, value] of Object.entries(scopes)) {
      const b = binding(urlOf(value), "bunfig.toml") ?? { host: "unknown", source: "bunfig.toml" };
      addScope(config, scopeKey(name), b);
    }
  }
  return config;
}

export function parseNpmRegistryFile(fileName: string, text: string): NpmRegistryConfig | undefined {
  switch (fileName) {
    case ".npmrc":
      return parseNpmrc(text);
    case ".yarnrc":
      return parseYarnrc(text);
    case ".yarnrc.yml":
      return parseYarnrcYml(text);
    case "bunfig.toml":
      return parseBunfig(text);
    default:
      return undefined;
  }
}

/** Every binding of both configurations. */
export function mergeRegistryConfig(a: NpmRegistryConfig, b: NpmRegistryConfig): NpmRegistryConfig {
  const merged = emptyRegistryConfig();
  for (const c of [a, b]) {
    for (const [k, list] of c.scopes) for (const x of list) addScope(merged, k, x);
    merged.defaults.push(...c.defaults);
  }
  return merged;
}
