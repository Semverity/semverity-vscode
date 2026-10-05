// Trims API answers to what the extension shows and stores: sub-signals,
// sources and unfired gates are dropped, so a cached card stays small.

import { ECOSYSTEMS, type CardSummary, type Coordinate, type Ecosystem, type ListingSummary } from "../types";
import { toPurl } from "./purl";
import type { PackageCard, PackageList, PackageVersionEntry } from "./types";

function asEcosystem(e: string): Ecosystem | undefined {
  return (ECOSYSTEMS as readonly string[]).includes(e) ? (e as Ecosystem) : undefined;
}

export function summarizeCard(card: PackageCard): CardSummary | undefined {
  const ecosystem = asEcosystem(card.ecosystem);
  if (!ecosystem) return undefined;
  const wd = card.with_dependencies;
  const summary: CardSummary = {
    purl: card.purl,
    ecosystem,
    name: card.name,
    version: card.version,
    resolution: card.resolution,
    overall: card.overall,
    coverage: card.coverage,
    gates: (card.gates ?? [])
      .filter((g) => g.fired)
      .map((g) => {
        const fired: CardSummary["gates"][number] = { id: g.id, hard: g.hard, immutable: g.immutable };
        if (g.reason) fired.reason = g.reason;
        if (g.recommendation) fired.recommendation = g.recommendation;
        if (g.evidence) fired.evidence = g.evidence;
        return fired;
      }),
    inheritedGates: wd?.inherited_gates ?? [],
    weakest: (wd?.top ?? []).slice(0, 3),
    dimensions: (card.dimensions ?? [])
      .map((d) => {
        const dim: CardSummary["dimensions"][number] = { id: d.id, score: d.score, coverage: d.coverage };
        if (d.name) dim.name = d.name;
        return dim;
      })
      .sort((a, b) => a.score - b.score),
    notes: card.notes ?? [],
    flags: card.flags ?? [],
    advisoryIds: (card.advisory_ids ?? []).slice(0, 10),
  };
  if (card.headline) summary.headline = card.headline;
  if (card.own) summary.own = card.own;
  if (card.security_score) {
    const s = card.security_score;
    summary.security = { score: s.score, grade: s.grade, scored: s.scored };
    if (s.gated !== undefined) summary.security.gated = s.gated;
  }
  if (wd) {
    summary.withDependencies = {
      state: wd.state,
      score: wd.score,
      grade: wd.grade,
      coverage: wd.coverage,
      drop: wd.drop,
      atMost: wd.at_most,
    };
    if (wd.nodes !== undefined) summary.withDependencies.nodes = wd.nodes;
  }
  if (card.license) summary.license = card.license;
  if (card.evaluated_at) summary.evaluatedAt = card.evaluated_at;
  if (card.detail) summary.detail = card.detail;
  return summary;
}

/** Gates that are hard whatever the policy; a listing entry names fired gates without the flag. */
const ALWAYS_HARD = new Set(["malware", "kev"]);

/**
 * A card built from a listing's entry for one version: the headline, the own
 * score and the fired gate ids. It lets a latest or range target show its
 * score as soon as the listing arrives; the full card follows.
 */
export function cardFromListing(c: Coordinate, entry: ListingSummary["versions"][number]): CardSummary | undefined {
  const score = entry.own?.score ?? entry.headline?.score;
  if (score === undefined) return undefined;
  const card: CardSummary = {
    purl: toPurl(c),
    ecosystem: c.ecosystem,
    name: c.name,
    version: c.version,
    resolution: "listing",
    overall: score,
    coverage: Number.NaN,
    gates: entry.firedGates.map((id) => ({ id, hard: ALWAYS_HARD.has(id), immutable: false })),
    inheritedGates: [],
    weakest: [],
    dimensions: [],
    notes: [],
    flags: [],
    advisoryIds: [],
    fromListing: true,
  };
  if (entry.headline) card.headline = entry.headline;
  if (entry.own) card.own = entry.own;
  return card;
}

function isScored(v: PackageVersionEntry): boolean {
  return v.headline !== undefined || v.own !== undefined || v.overall !== undefined;
}

function versionEntry(v: PackageVersionEntry): ListingSummary["versions"][number] {
  const e: ListingSummary["versions"][number] = { version: v.version, firedGates: v.fired_gates ?? [] };
  if (v.headline) e.headline = v.headline;
  if (v.own) e.own = v.own;
  else if (v.overall !== undefined && !v.headline) {
    // Older answers carry only the own score as `overall`.
    e.own = { score: v.overall, grade: gradeFor(v.overall) };
  }
  return e;
}

/** Semverity's score bands: A >= 90, B >= 80, C >= 65, D >= 50, else F. */
export function gradeFor(score: number): "A" | "B" | "C" | "D" | "F" {
  return score >= 90 ? "A" : score >= 80 ? "B" : score >= 65 ? "C" : score >= 50 ? "D" : "F";
}

/**
 * The parts of a listing the extension keeps: latest, healthy, the entries of
 * latest, healthy and the newest scored version, and (in `allVersions`) every
 * listed version string for range resolution.
 */
export function summarizeListing(list: PackageList): ListingSummary | undefined {
  const ecosystem = asEcosystem(list.ecosystem);
  if (!ecosystem) return undefined;
  const versions = list.versions ?? [];
  const summary: ListingSummary = { id: { ecosystem, name: list.name }, versions: [] };
  if (list.latest) summary.latest = list.latest;
  if (list.healthy) summary.healthy = list.healthy;
  if (list.strategy) summary.strategy = list.strategy;

  const keep = new Set<string>();
  if (list.latest) keep.add(list.latest);
  if (list.healthy) keep.add(list.healthy);
  const scored = versions.filter(isScored);
  const newestScored = newestByPublished(scored);
  if (newestScored) {
    keep.add(newestScored.version);
    summary.latestScored = newestScored.version;
  }
  for (const v of versions) {
    if (keep.has(v.version) && isScored(v)) summary.versions.push(versionEntry(v));
  }
  summary.allVersions = versions.filter((v) => !v.yanked).map((v) => v.version);
  return summary;
}

function newestByPublished(entries: PackageVersionEntry[]): PackageVersionEntry | undefined {
  let best: PackageVersionEntry | undefined;
  for (const e of entries) {
    if (e.prerelease) continue;
    if (!best) best = e;
    else if ((e.published_at ?? "") > (best.published_at ?? "")) best = e;
  }
  return best ?? entries[0];
}
