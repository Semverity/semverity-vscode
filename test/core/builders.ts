// API response builders for core tests (hand-written, shaped like the live API).

import type { PackageCard, PackageList } from "../../src/core/api/types";
import { toPurl } from "../../src/core/api/purl";
import type { Ecosystem } from "../../src/core/types";

export function apiCard(ecosystem: Ecosystem, name: string, version: string, over: Partial<PackageCard> = {}): PackageCard {
  return {
    purl: toPurl({ ecosystem, name, version }),
    ecosystem,
    name,
    version,
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
    evaluated_at: "2026-09-29T02:39:53Z",
    detail: "full",
    source: "index",
    headline: { score: 82.8, grade: "B", basis: "own", context: "registry", state: "not_collected", at_most: true },
    own: { score: 82.76, grade: "B" },
    ...over,
  };
}

export function apiListing(ecosystem: Ecosystem, name: string, versions: string[], over: Partial<PackageList> = {}): PackageList {
  return {
    ecosystem,
    name,
    purl: `pkg:${ecosystem}/${name}`,
    latest: versions[0],
    healthy: versions[0],
    strategy: "healthy",
    source: "index",
    versions: versions.map((v, i) => ({
      version: v,
      purl: toPurl({ ecosystem, name, version: v }),
      published_at: `2026-0${9 - Math.min(i, 8)}-01T00:00:00Z`,
      ...(i === 0 ? { overall: 82.8, headline: { score: 82.8, grade: "B" as const, basis: "own" as const, context: "registry" as const, state: "not_collected" as const, at_most: true }, own: { score: 82.8, grade: "B" as const }, fired_gates: ["no_provenance"] } : {}),
    })),
    ...over,
  };
}

/** Narrows a value the test knows is present; throws with a clear message otherwise. */
export function must<T>(value: T | undefined | null, what = "value"): T {
  if (value === undefined || value === null) throw new Error(`expected ${what}`);
  return value;
}
