// Manifest edits that move a dependency to the healthy version (docs/DESIGN.md 9.7). Pure.

import { redeclare } from "../core/resolver/declarations";
import type { DeclaredIn, ManifestKind, TextRange } from "../core/types";

/** How a pyproject dependency is written: Poetry tables or PEP 621 / PEP 735 strings. */
export type PyprojectFlavor = "poetry" | "pep621";

export interface ManifestEdit {
  uri: string;
  range: TextRange;
  newText: string;
}

function rewriteNpm(spec: string, version: string): string {
  const s = spec.trim();
  const alias = /^npm:((?:@[^/@\s]+\/)?[^@\s]+)@(.*)$/.exec(s);
  if (alias) return `npm:${alias[1]}@${rewriteNpm(alias[2] ?? "", version)}`;
  const single = /^(\^|~|>=|=)?\s*v?(\d+)(\.\d+)?(\.\d+)?([-+][0-9A-Za-z.+-]*)?$/.exec(s);
  // Wildcards (1.x, *), unions, spaces and hyphen ranges never match: they become ^version.
  if (single) return `${single[1] ?? ""}${version}`;
  return `^${version}`;
}

function rewritePep508(spec: string, version: string): string {
  const s = spec.trim();
  if (s.includes(",")) return `==${version}`;
  const single = /^(===|==|~=|>=)\s*([^\s,;*]+)$/.exec(s);
  if (single) return `${single[1]}${version}`;
  return `==${version}`;
}

function rewritePoetry(spec: string, version: string): string {
  const s = spec.trim();
  if (s.includes(",") || s.includes("||") || s.includes("|")) return `^${version}`;
  const m = /^(\^|~(?!=)|==)?\s*\d[^\s*]*$/.exec(s);
  if (m) return `${m[1] ?? ""}${version}`;
  return `^${version}`;
}

/**
 * The manifest version text after moving to `version`, keeping the author's
 * operator where the spec has a single one (see docs/DESIGN.md 9.7).
 */
export function rewriteSpec(kind: ManifestKind, spec: string, version: string, flavor?: PyprojectFlavor): string {
  switch (kind) {
    case "package.json":
      return rewriteNpm(spec, version);
    case "requirements":
      return rewritePep508(spec, version);
    case "pyproject": {
      const f = flavor ?? (/^\s*(\^|~(?!=)|\d)/.test(spec) ? "poetry" : "pep621");
      return f === "poetry" ? rewritePoetry(spec, version) : rewritePep508(spec, version);
    }
    case "go.mod":
      return version.startsWith("v") ? version : `v${version}`;
  }
}

/**
 * True for a plain version string (digits, letters, dots, plus, minus and
 * underscore). The healthy version comes from the API: anything else (quotes,
 * spaces, line breaks) is never written into a manifest.
 */
export function isPlainVersion(version: string): boolean {
  return /^v?[0-9][0-9A-Za-z.+_-]{0,63}$/.test(version);
}

/** The edit that moves a declared dependency to `version`; undefined when the manifest cannot be edited. */
export function bumpEdit(declaredIn: DeclaredIn, version: string): ManifestEdit | undefined {
  const dep = declaredIn.dependency;
  if (!dep.specRange || dep.nonRegistry || !isPlainVersion(version)) return undefined;
  const flavor: PyprojectFlavor | undefined =
    declaredIn.manifestKind === "pyproject" ? (dep.section.startsWith("tool.poetry") ? "poetry" : "pep621") : undefined;
  const newText = rewriteSpec(declaredIn.manifestKind, dep.spec, version, flavor);
  if (newText === dep.spec.trim()) return undefined;
  return { uri: declaredIn.manifestUri, range: dep.specRange, newText };
}

/**
 * The edit against the manifest's current text: the dependency is found again
 * by parsing `text`, so unsaved edits above it or an earlier bump do not
 * misplace the range. undefined when it is gone or already at `version`.
 */
export function currentBumpEdit(declaredIn: DeclaredIn, version: string, text: string): ManifestEdit | undefined {
  const now = redeclare(declaredIn, text);
  return now ? bumpEdit(now, version) : undefined;
}

/** Numeric-aware comparison good enough to tell an upgrade from a downgrade. */
export function looseCompare(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split(/[.+-]/)
      .map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return typeof y === "number" ? -1 : 1;
    if (y === undefined) return typeof x === "number" ? 1 : -1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    if (typeof x === "number") return 1;
    if (typeof y === "number") return -1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** "Bump lodash to 4.18.1 (Semverity healthy version)", or "Change ... to" for a lower version. */
export function bumpTitle(name: string, from: string, to: string, compare: (a: string, b: string) => number = looseCompare): string {
  const verb = compare(to, from) >= 0 ? "Bump" : "Change";
  return `${verb} ${name} to ${to} (Semverity healthy version)`;
}
