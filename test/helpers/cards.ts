// Builders for cards, results and analysis entries used by the presentation
// tests (and available to the core tests). Every value is hand-written fixture
// data; nothing comes from a real workspace.

import type { Grade, Headline, PackageCard } from "../../src/core/api/types";
import type {
  AnalysisEntry,
  CardSummary,
  Coordinate,
  DeclaredIn,
  FiredGate,
  ListingSummary,
  LookupResult,
  LookupTarget,
  ManifestDependency,
  TextRange,
  VersionSource,
} from "../../src/core/types";

export const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
export const HOUR = 3_600_000;

export function range(line: number, start: number, end: number): TextRange {
  return { start: { line, character: start }, end: { line, character: end } };
}

export function headline(score: number, grade: Grade, extra: Partial<Headline> = {}): Headline {
  return {
    score,
    grade,
    basis: "with_dependencies",
    context: "registry",
    state: "complete",
    at_most: false,
    ...extra,
  };
}

/** A scored card for lodash 4.17.21 (headline 74 C, own 80 B) unless overridden. */
export function card(overrides: Partial<CardSummary> = {}): CardSummary {
  return {
    purl: "pkg:npm/lodash@4.17.21",
    ecosystem: "npm",
    name: "lodash",
    version: "4.17.21",
    resolution: "public",
    overall: 80.2,
    coverage: 91.4,
    headline: headline(74.4, "C"),
    own: { score: 80.2, grade: "B" },
    security: { score: 87, grade: "B", scored: true },
    gates: [],
    inheritedGates: [],
    weakest: [],
    dimensions: [],
    notes: [],
    flags: [],
    advisoryIds: [],
    evaluatedAt: "2026-09-29T02:39:53Z",
    detail: "full",
    ...overrides,
  };
}

export function gate(id: string, extra: Partial<FiredGate> = {}): FiredGate {
  const hard = ["malware", "kev", "high_vuln_with_fix", "yanked", "license_denied", "typosquat", "install_script_untrusted", "unpinned", "denied_package", "dependency_confusion"].includes(id);
  return { id, hard, immutable: id === "malware", ...extra };
}

export function coordinateOf(c: CardSummary): Coordinate {
  return { ecosystem: c.ecosystem, name: c.name, version: c.version };
}

export function scored(c: CardSummary = card(), extra: { listing?: ListingSummary; stale?: boolean; validatedAt?: number; versionSource?: VersionSource } = {}): LookupResult {
  return {
    state: "scored",
    coordinate: coordinateOf(c),
    versionSource: extra.versionSource ?? "lockfile",
    card: c,
    listing: extra.listing,
    validatedAt: extra.validatedAt ?? NOW - 3 * HOUR,
    stale: extra.stale ?? false,
  };
}

export function listing(healthy: string, extra: Partial<ListingSummary> = {}): ListingSummary {
  return {
    id: { ecosystem: "npm", name: "lodash" },
    latest: healthy,
    healthy,
    strategy: "healthy",
    versions: [{ version: healthy, headline: headline(82.8, "B", { basis: "own", state: "not_collected", at_most: true }), own: { score: 82.8, grade: "B" }, firedGates: [] }],
    ...extra,
  };
}

export function target(name = "lodash", version: string | undefined = "4.17.21", versionSource: VersionSource = "lockfile", ecosystem: Coordinate["ecosystem"] = "npm"): LookupTarget {
  return { id: { ecosystem, name }, version, versionSource };
}

export function dependency(overrides: Partial<ManifestDependency> = {}): ManifestDependency {
  return {
    ecosystem: "npm",
    name: "lodash",
    rawName: "lodash",
    spec: "^4.17.20",
    section: "dependencies",
    line: 5,
    nameRange: range(5, 5, 11),
    specRange: range(5, 15, 23),
    ...overrides,
  };
}

export function declaredIn(dep: ManifestDependency = dependency(), extra: Partial<DeclaredIn> = {}): DeclaredIn {
  return { manifestUri: "file:///work/app/package.json", manifestKind: "package.json", dependency: dep, ...extra };
}

export function entry(overrides: Partial<AnalysisEntry> = {}): AnalysisEntry {
  return {
    label: "lodash",
    line: 0,
    range: range(0, 20, 26),
    target: target(),
    ...overrides,
  };
}

/** A full API card, for tests of code that reads the wire format. */
export function packageCard(overrides: Partial<PackageCard> = {}): PackageCard {
  return {
    purl: "pkg:npm/lodash@4.18.1",
    ecosystem: "npm",
    name: "lodash",
    version: "4.18.1",
    resolution: "public",
    overall: 82.76,
    coverage: 79.15,
    security_score: { score: 87, grade: "B", scored: true, coverage: 1 },
    gates: [
      { id: "malware", fired: false, hard: true, immutable: true },
      { id: "no_provenance", fired: true, hard: false, immutable: false, reason: "no verified build provenance" },
    ],
    flags: ["no_build_provenance"],
    notes: ["Community and bus factor: only 35% of the evidence available"],
    license: "MIT",
    scoring_version: 1,
    evaluated_at: "2026-09-29T02:39:53Z",
    detail: "full",
    source: "index",
    headline: { score: 82.8, grade: "B", basis: "own", context: "registry", state: "not_collected", at_most: true },
    own: { score: 82.76, grade: "B" },
    ...overrides,
  };
}
