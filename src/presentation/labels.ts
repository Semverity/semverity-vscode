// Human-readable labels for gates, version sources, ages and scores. Pure.

import type { Ecosystem, VersionSource } from "../core/types";

const GATE_LABELS: Record<string, string> = {
  malware: "Malware finding",
  kev: "Known exploited vulnerability (KEV)",
  high_vuln_with_fix: "High severity advisory with a fix",
  unfixed_high_vuln: "High severity advisory without a fix",
  moderate_vuln_with_fix: "Moderate severity advisory with a fix",
  chain_unfixed_critical: "Unfixed critical advisory",
  yanked: "Yanked, retracted or deprecated version",
  license_denied: "License not allowed",
  typosquat: "Possible typosquat",
  install_script_untrusted: "Untrusted install script",
  unpinned: "Unpinned version",
  denied_package: "Denied package",
  dependency_confusion: "Dependency confusion risk",
  archived: "Archived source repository",
  prerelease: "Prerelease version",
  min_age: "Published very recently",
  bus_factor_one: "Single maintainer",
  no_provenance: "No build provenance",
  source_repo_missing: "Source repository missing",
  publisher_suspicious: "Suspicious publisher",
  readme_suspicious: "Suspicious readme",
  notes_suspicious: "Suspicious release notes",
};

/** "high_vuln_with_fix" -> "High severity advisory with a fix"; unknown ids are de-snaked. */
export function gateLabel(id: string): string {
  const known = GATE_LABELS[id];
  if (known) return known;
  const words = id.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : id;
}

/** The label with a lowercase first letter, for use inside a sentence (acronyms kept). */
export function gateLabelInline(id: string): string {
  const label = gateLabel(id);
  if (/^[A-Z]{2}/.test(label)) return label;
  return label.charAt(0).toLowerCase() + label.slice(1);
}

export function ecosystemLabel(e: Ecosystem): string {
  switch (e) {
    case "npm":
      return "npm";
    case "pypi":
      return "PyPI";
    case "golang":
      return "Go";
  }
}

export interface VersionSourceDetail {
  /** The declared range, for source "range". */
  range?: string;
  /** The lockfile file name, for source "lockfile". */
  lockfile?: string;
  /** Whether a manifest declares the package (source "latest"). */
  declared?: boolean;
}

/** Where the version came from, as the hover's first line says it. */
export function versionSourceLabel(source: VersionSource, detail: VersionSourceDetail = {}): string {
  switch (source) {
    case "lockfile":
      return detail.lockfile ? `locked version (${detail.lockfile})` : "locked version";
    case "manifest":
      return "declared version";
    case "range":
      return detail.range ? `newest known version matching \`${detail.range.replace(/`/g, "")}\`` : "newest known version matching the declared range";
    case "latest":
      return detail.declared ? "latest version" : "latest version (not declared)";
  }
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function relativeAge(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}

/** Rounded to an integer, with "≤" when the score is an upper bound. */
export function formatScore(score: number, atMost: boolean): string {
  const n = Math.round(score);
  return atMost ? `≤${n}` : String(n);
}

/** "14:32" in local time. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "2026-09-29" from an RFC 3339 time; undefined when it does not parse. */
export function isoDate(rfc3339: string | undefined): string | undefined {
  if (!rfc3339) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(rfc3339);
  return m?.[1];
}

/** "package-lock.json" from a URI string. */
export function fileName(uri: string): string {
  const path = uri.split(/[?#]/)[0] ?? uri;
  const last = path.split("/").pop() ?? path;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}
