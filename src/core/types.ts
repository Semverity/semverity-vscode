// Shared domain types of the core layer. The ui layer reads these; it never
// reaches into core internals (see docs/DESIGN.md section 3).

import type { Grade, Headline, InheritedGate, Contribution, OwnScore } from "./api/types";

export type Ecosystem = "npm" | "pypi" | "golang";
export const ECOSYSTEMS: readonly Ecosystem[] = ["npm", "pypi", "golang"];

/**
 * A package identity in the API's terms: the ecosystem plus the registry-native
 * name (npm names as published, PyPI names normalised per PEP 503, Go module paths).
 */
export interface PackageId {
  ecosystem: Ecosystem;
  name: string;
}

/**
 * A package version. Coordinates are the only data that ever leave the machine
 * (as a purl or as an API path); nothing else is sent.
 */
export interface Coordinate extends PackageId {
  version: string;
}

/** Where the version of a lookup came from. */
export type VersionSource =
  /** Pinned by a lockfile (package-lock.json, yarn.lock, pnpm-lock.yaml, poetry.lock, uv.lock, Pipfile.lock). */
  | "lockfile"
  /** An exact version in a manifest (`"1.2.3"`, `==1.2.3`, a go.mod requirement). */
  | "manifest"
  /** A range in a manifest, resolved against the versions Semverity knows. */
  | "range"
  /** Nothing local names a version: the latest release Semverity knows. */
  | "latest";

/** Zero-based position, like the LSP and vscode.Position. Local only. */
export interface TextPosition {
  line: number;
  character: number;
}

/** Half-open range. Local only. */
export interface TextRange {
  start: TextPosition;
  end: TextPosition;
}

export type ImportKind =
  | "import"
  | "export-from"
  | "require"
  | "dynamic-import"
  | "import-equals"
  | "python-import"
  | "python-from-import"
  | "go-import";

/** One import found in a source file, before it is mapped to a package. */
export interface ImportRef {
  ecosystem: Ecosystem;
  /** The text as written: "lodash/fp", "@scope/pkg/sub", "yaml", "google.cloud.storage", "github.com/a/b/c". */
  specifier: string;
  kind: ImportKind;
  /** Range of the specifier text, without quotes. */
  range: TextRange;
  /** Python from-imports: the names imported (`from google.cloud import storage` gives ["storage"]); `*` is left out. */
  names?: string[];
}

export type ManifestKind = "package.json" | "requirements" | "pyproject" | "go.mod";

/** One dependency declared in a manifest, with the ranges a quick fix edits. */
export interface ManifestDependency {
  ecosystem: Ecosystem;
  /** Registry-native, normalised name (the npm alias target for `npm:` aliases). */
  name: string;
  /** The name as written in the manifest. */
  rawName: string;
  /** The version text as written: "^4.17.20", "==6.0.1", ">=2,<3", "v1.2.3"; "" when absent. */
  spec: string;
  /** The single version the spec pins, when it pins exactly one. */
  exactVersion?: string;
  /** Section or table: "dependencies", "devDependencies", "project.dependencies", "tool.poetry.group.dev.dependencies", "require". */
  section: string;
  line: number;
  nameRange: TextRange;
  /** Range of `spec` in the file; absent when the manifest names no version. */
  specRange?: TextRange;
  /** Set when the dependency does not come from the public registry: "workspace", "file", "link", "git", "url", "local-replace", "editable", "index" (a named, non-default package index). */
  nonRegistry?: string;
  /** go.mod `// indirect`. */
  indirect?: boolean;
}

export interface ParsedManifest {
  uri: string;
  kind: ManifestKind;
  ecosystem: Ecosystem;
  dependencies: ManifestDependency[];
  /** package.json "name", pyproject [project].name, go.mod module path. */
  selfName?: string;
  /** Python manifests: the package index URLs they configure (requirements options, pyproject uv, Poetry and PDM sources). */
  indexUrls?: string[];
}

/** What to look up: a package and either a concrete version or a range or "latest". */
export interface LookupTarget {
  id: PackageId;
  /** Concrete version when known locally. */
  version?: string;
  /** Declared range to resolve against the known versions (versionSource "range"). */
  range?: string;
  versionSource: VersionSource;
  /**
   * The base name of the lockfile that pinned the version ("package-lock.json"),
   * when versionSource is "lockfile". Local only: never part of a request or a cache key.
   */
  lockfile?: string;
}

export type SkipReason =
  /** node:fs, fs, os, sys, fmt, net/http ... */
  | "builtin"
  /** ./x, ../x, /abs, from . import x */
  | "relative"
  /** tsconfig paths, package.json imports (#x), bundler aliases such as @/ and ~/ */
  | "alias"
  /** A module or package that exists inside the workspace. */
  | "local-module"
  /** The workspace's own package or module. */
  | "self"
  /** workspace:, file:, link:, git and URL specs, local go.mod replaces. */
  | "non-registry"
  /** The ecosystem is turned off in settings. */
  | "ecosystem-off"
  /** Not declared in any manifest and semverity.privacy.lookupUndeclaredImports is off. */
  | "undeclared"
  /** No package could be derived (an unknown Go host with no go.mod match, an invalid name). */
  | "unmapped";

/**
 * Why the privacy filter refused a package, as data: the presentation renders
 * any user-supplied part (a pattern, a scope) as a code span, never as Markdown.
 */
export type ExclusionRule =
  /** semverity.privacy.excludePatterns */
  | { kind: "pattern"; pattern: string }
  /** An npm scope bound to a non-public registry; `source` is the file name (".npmrc", ".yarnrc.yml", "bunfig.toml"). */
  | { kind: "registry-scope"; scope: string; source: string }
  /** The default npm registry is not a public one and no lockfile says where the package came from. */
  | { kind: "private-registry"; source: string }
  | { kind: "lockfile-local" }
  | { kind: "lockfile-registry" }
  /** A Python package index other than PyPI; `source` names where it is configured. */
  | { kind: "python-index"; source: string }
  | { kind: "go-local-replace" }
  | { kind: "goprivate" };

/** Where a dependency is declared, so a quick fix can edit it. Local only. */
export interface DeclaredIn {
  manifestUri: string;
  manifestKind: ManifestKind;
  dependency: ManifestDependency;
}

/** One line item of an analysed document: an import or a manifest dependency. */
export interface AnalysisEntry {
  /** Display name: the package name, or the specifier when it was skipped. */
  label: string;
  line: number;
  /** The specifier (source files) or the dependency name (manifests). */
  range: TextRange;
  /** Manifest entries: the version text range. */
  specRange?: TextRange;
  /** Absent when skipped or excluded. */
  target?: LookupTarget;
  skip?: { reason: SkipReason; detail?: string };
  /** Set when the privacy filter refused the package; `rule` names the pattern or source of the rule. */
  excluded?: { rule: ExclusionRule };
  declaredIn?: DeclaredIn;
}

export interface DocumentAnalysis {
  uri: string;
  kind: "source" | "manifest" | "unsupported";
  ecosystem?: Ecosystem;
  entries: AnalysisEntry[];
}

/** A fired gate kept in the summary (unfired gates are dropped). */
export interface FiredGate {
  id: string;
  hard: boolean;
  immutable: boolean;
  reason?: string;
  recommendation?: string;
  evidence?: string;
}

/**
 * A trimmed PackageCard: what the cache stores and the presentation reads.
 * Built by summarizeCard() in src/core/api/summary.ts.
 */
export interface CardSummary {
  purl: string;
  ecosystem: Ecosystem;
  name: string;
  version: string;
  resolution: string;
  overall: number;
  /** Own-score evidence coverage, percent 0..100. */
  coverage: number;
  headline?: Headline;
  own?: OwnScore;
  security?: { score: number; grade: Grade | ""; scored: boolean; gated?: boolean };
  gates: FiredGate[];
  inheritedGates: InheritedGate[];
  /** with_dependencies.top, at most three. */
  weakest: Contribution[];
  withDependencies?: {
    state: string;
    score: number | null;
    grade: Grade | null;
    coverage: number | null;
    drop: number | null;
    nodes?: number;
    atMost: boolean;
  };
  /** Dimension id, name and score only, lowest first. */
  dimensions: { id: string; name?: string; score: number; coverage: number }[];
  notes: string[];
  flags: string[];
  license?: string;
  /** At most ten. */
  advisoryIds: string[];
  evaluatedAt?: string;
  detail?: "full" | "compact";
  /**
   * Built from the package listing's entry for this version (headline, own
   * score, fired gate ids), shown while the full card is fetched. Never cached.
   */
  fromListing?: boolean;
}

/** The parts of a listing the extension keeps. */
export interface ListingSummary {
  id: PackageId;
  latest?: string;
  healthy?: string;
  strategy?: string;
  /** The listing's entries for latest and healthy, when scored. */
  versions: { version: string; headline?: Headline; own?: OwnScore; firedGates: string[] }[];
  /** The newest scored version (its entry is in `versions`), for the "latest scored" hint. */
  latestScored?: string;
  /** Every listed version string, for range resolution. Not for display. */
  allVersions?: string[];
  /** True when `allVersions` holds only the newest part of the list (a persisted copy of a long listing). */
  allVersionsTruncated?: boolean;
}

/** The outcome of looking one target up, as the presentation sees it. */
export type LookupResult =
  | {
      state: "scored";
      coordinate: Coordinate;
      versionSource: VersionSource;
      card: CardSummary;
      /** Present once the listing was read (hover, diagnostics, quick fix). */
      listing?: ListingSummary;
      /** Epoch ms of the last successful fetch or revalidation. */
      validatedAt: number;
      /** True when the answer is past its lifetime and could not be rechecked, or older than the TTL. */
      stale: boolean;
    }
  | {
      state: "not_scored";
      /** Absent when the package itself is unknown (no version could be chosen). */
      coordinate?: Coordinate;
      versionSource: VersionSource;
      reason: "not_indexed" | "not_found" | "invalid";
      /** For a version that is not scored: the latest version Semverity knows, when the listing exists. */
      listing?: ListingSummary;
      validatedAt: number;
      stale: boolean;
    }
  | { state: "pending"; coordinate?: Coordinate; retryAt: number }
  | { state: "disabled" }
  | { state: "rate_limited"; retryAt: number }
  | { state: "offline"; retryAt: number }
  | { state: "error"; message: string; retryAt?: number };

export type NetworkState = "ok" | "disabled" | "offline" | "rate_limited" | "unauthorized";

export interface NetworkStatus {
  state: NetworkState;
  /** Epoch ms when requests resume (offline, rate_limited). */
  retryAt?: number;
  /** An API key is set and was not refused. */
  signedIn: boolean;
}

/** Options the ui layer derives from settings and passes to the core. */
export interface CoreOptions {
  apiBaseUrl: string;
  /** "semverity-vscode/<extension version>"; nothing else identifies the client. */
  userAgent: string;
  ecosystems: Record<Ecosystem, boolean>;
  networkEnabled: boolean;
  /** Union of the user and workspace values (a workspace can add exclusions, never remove the user's). */
  excludePatterns: string[];
  excludeNpmrcScopes: boolean;
  /** Hosts treated like the public registries (mirrors); lowercase host names. */
  trustedRegistryHosts: string[];
  lookupUndeclaredImports: boolean;
  /** Lifetime of an answer without Cache-Control max-age, and the age after which an unrechecked answer is stale. */
  cacheTtlMs: number;
  /** Lifetime of a not-scored answer. */
  negativeTtlMs: number;
  maxRequestsPerMinute: number;
  /** GOPRIVATE, GONOPROXY and GONOSUMDB from the extension host environment and the `go env -w` file, comma-joined. */
  goPrivate: string;
  /** Default npm registries set in the environment (NPM_CONFIG_REGISTRY and the pnpm, Yarn and Bun equivalents). */
  npmEnvRegistries?: { host: string; source: string }[];
  /** Python indexes from the environment (PIP_INDEX_URL, UV_INDEX_URL ...) and the user pip and uv configuration. */
  pythonIndexes?: { url: string; source: string }[];
}

export interface Disposable {
  dispose(): void;
}

export type Listener<T> = (value: T) => void;
export type Event<T> = (listener: Listener<T>) => Disposable;
