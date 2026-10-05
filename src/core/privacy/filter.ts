// The privacy filter (docs/DESIGN.md section 6.2). It runs after mapping and
// before anything is queued: a package it refuses never reaches the lookup
// service, so nothing about it is sent. The first rule that matches wins and
// is reported for the hover as structured data (see ExclusionRule).

import { hostOf } from "../parsers/lockfiles";
import type { NpmRegistryConfig, RegistryBinding } from "../parsers/npmRegistries";
import type { ExclusionRule, PackageId } from "../types";
import { matchGoPrivate } from "./goprivate";
import { compilePattern } from "./patterns";

export const PUBLIC_NPM_HOSTS: readonly string[] = ["registry.npmjs.org", "registry.yarnpkg.com"];
export const PUBLIC_PYPI_HOSTS: readonly string[] = ["pypi.org", "files.pythonhosted.org", "pypi.python.org"];

/** A Python package index URL and where it is configured ("PIP_INDEX_URL", "the pip configuration"). */
export interface PythonIndex {
  url: string;
  source: string;
}

export interface LocalSignals {
  /** npm registry bindings from every .npmrc, .yarnrc, .yarnrc.yml and bunfig.toml between the file and the workspace root, and the user's. */
  npmRegistries?: NpmRegistryConfig;
  /** The host the lockfile resolves the package from ("local" for path, git and editable sources). */
  lockfileHost?: string;
  /** Index URLs (-i, --index-url, --extra-index-url, --find-links, pyproject indexes) that apply to the package. */
  indexUrls?: readonly string[];
  /** Where `indexUrls` come from, for the hover; "its requirements file" when absent. */
  indexSource?: string;
  /** go.mod replaces the module with a local directory. */
  goLocalReplace?: boolean;
}

export interface PrivacyOptions {
  excludePatterns: readonly string[];
  /** Refuse npm packages bound to a non-public registry by the workspace or user registry configuration. */
  excludeNpmrcScopes: boolean;
  trustedRegistryHosts: readonly string[];
  goPrivate: string;
  /** Default npm registries from the environment (NPM_CONFIG_REGISTRY and the Yarn and Bun equivalents). */
  npmEnvRegistries?: readonly RegistryBinding[];
  /** Python indexes from the environment and the user pip and uv configuration; they apply to every PyPI package. */
  pythonIndexes?: readonly PythonIndex[];
}

export type PrivacyVerdict = { allowed: true } | { allowed: false; rule: ExclusionRule };

/** The parts of a rule's sentence: plain text, and user or workspace supplied values to show as code. */
export type RulePart = { text: string } | { code: string };

export function exclusionParts(rule: ExclusionRule): RulePart[] {
  switch (rule.kind) {
    case "pattern":
      return [{ text: "matches " }, { code: rule.pattern }];
    case "registry-scope":
      return [{ text: "the " }, { code: rule.scope }, { text: ` scope uses another registry (${rule.source})` }];
    case "private-registry":
      return [{ text: `the default npm registry (${rule.source}) is not the public one and no lockfile shows where the package comes from` }];
    case "lockfile-local":
      return [{ text: "the lockfile resolves it from a local or version control source" }];
    case "lockfile-registry":
      return [{ text: "the lockfile resolves it from a registry other than the public one" }];
    case "python-index":
      return [{ text: `${rule.source} uses a package index other than PyPI` }];
    case "go-local-replace":
      return [{ text: "go.mod replaces it with a local directory" }];
    case "goprivate":
      return [{ text: "matches GOPRIVATE, GONOPROXY or GONOSUMDB" }];
  }
}

/** The rule as plain text (logs and tests); values are quoted with backticks. */
export function describeExclusion(rule: ExclusionRule): string {
  return exclusionParts(rule)
    .map((p) => ("code" in p ? `\`${p.code}\`` : p.text))
    .join("");
}

export class PrivacyFilter {
  private patterns: { source: string; test: (id: PackageId) => boolean }[] = [];
  private options: PrivacyOptions;
  private trusted = new Set<string>();

  constructor(options: PrivacyOptions) {
    this.options = options;
    this.update(options);
  }

  update(options: PrivacyOptions): void {
    this.options = options;
    this.patterns = options.excludePatterns.filter((p) => p.trim() !== "").map((p) => ({ source: p.trim(), test: compilePattern(p) }));
    this.trusted = new Set(options.trustedRegistryHosts.map((h) => h.trim().toLowerCase()).filter(Boolean));
  }

  private isPublicHost(host: string, ecosystem: PackageId["ecosystem"]): boolean {
    const h = host.toLowerCase();
    if (this.trusted.has(h)) return true;
    if (ecosystem === "npm") return PUBLIC_NPM_HOSTS.includes(h);
    if (ecosystem === "pypi") return PUBLIC_PYPI_HOSTS.includes(h);
    return false;
  }

  private privateIndex(urls: readonly string[]): boolean {
    return urls.some((url) => {
      const host = hostOf(url);
      return host === undefined || !this.isPublicHost(host, "pypi");
    });
  }

  check(id: PackageId, local: LocalSignals = {}): PrivacyVerdict {
    // 1. Exclude patterns.
    for (const p of this.patterns) {
      if (p.test(id)) return { allowed: false, rule: { kind: "pattern", pattern: p.source } };
    }

    // 2. npm registry configuration: a scope bound to another registry, or a
    // non-public default registry when no lockfile says where the package came from.
    if (id.ecosystem === "npm" && this.options.excludeNpmrcScopes) {
      const config = local.npmRegistries;
      let scopeIsPublic = false;
      if (id.name.startsWith("@")) {
        const scope = (id.name.split("/")[0] ?? "").toLowerCase();
        const bindings = config?.scopes.get(scope) ?? [];
        const other = bindings.find((b) => !this.isPublicHost(b.host, "npm"));
        if (other) return { allowed: false, rule: { kind: "registry-scope", scope, source: other.source } };
        scopeIsPublic = bindings.length > 0;
      }
      if (!scopeIsPublic && local.lockfileHost === undefined) {
        const defaults = [...(config?.defaults ?? []), ...(this.options.npmEnvRegistries ?? [])];
        const other = defaults.find((b) => !this.isPublicHost(b.host, "npm"));
        if (other) return { allowed: false, rule: { kind: "private-registry", source: other.source } };
      }
    }

    // 3. Lockfile sources.
    if (local.lockfileHost && (id.ecosystem === "npm" || id.ecosystem === "pypi")) {
      if (local.lockfileHost === "local") return { allowed: false, rule: { kind: "lockfile-local" } };
      if (!this.isPublicHost(local.lockfileHost, id.ecosystem)) return { allowed: false, rule: { kind: "lockfile-registry" } };
    }

    // 4. Python indexes: the workspace's, then the environment and user configuration.
    if (id.ecosystem === "pypi") {
      if (local.indexUrls && this.privateIndex(local.indexUrls)) {
        return { allowed: false, rule: { kind: "python-index", source: local.indexSource ?? "its requirements file" } };
      }
      const global = (this.options.pythonIndexes ?? []).find((i) => this.privateIndex([i.url]));
      if (global) return { allowed: false, rule: { kind: "python-index", source: global.source } };
    }

    // 5. Go private modules and local replaces.
    if (id.ecosystem === "golang") {
      if (local.goLocalReplace) return { allowed: false, rule: { kind: "go-local-replace" } };
      if (matchGoPrivate(this.options.goPrivate, id.name)) return { allowed: false, rule: { kind: "goprivate" } };
    }
    return { allowed: true };
  }
}
