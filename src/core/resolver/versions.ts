// Version helpers per ecosystem: exact pins, range resolution against the
// versions Semverity knows, and ordering. npm uses semver; PyPI uses PEP 440
// (with Poetry's ^ and ~ translated); Go uses semver after removing the "v".

import semver from "semver";
import type { Ecosystem } from "../types";
import { npmExactVersion } from "../parsers/packageJson";
import { pep440ExactVersion } from "../parsers/requirements";
import { comparePep440, isPep440Prerelease, parsePep440, parseSpecifier, satisfiesPep440 } from "./pep440";

function goSemver(v: string): string | null {
  return semver.valid(v.replace(/^v/, ""), { loose: false });
}

export function compareVersions(ecosystem: Ecosystem, a: string, b: string): number {
  if (ecosystem === "pypi") return comparePep440(a, b);
  const va = ecosystem === "golang" ? goSemver(a) : semver.valid(a, { loose: true });
  const vb = ecosystem === "golang" ? goSemver(b) : semver.valid(b, { loose: true });
  if (va && vb) return semver.compare(va, vb, { loose: true });
  if (va) return 1;
  if (vb) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The single version a manifest spec pins, when it pins exactly one. */
export function exactVersion(ecosystem: Ecosystem, spec: string): string | undefined {
  const s = spec.trim();
  if (s === "") return undefined;
  if (ecosystem === "npm") {
    const alias = /^npm:(?:@[^/]+\/)?[^@]+@(.*)$/.exec(s);
    return npmExactVersion(alias ? (alias[1] ?? "") : s);
  }
  if (ecosystem === "pypi") return pep440ExactVersion(s);
  return /^v\d/.test(s) ? s : undefined;
}

/** Translates Poetry's caret and tilde constraints (and a bare version) into a PEP 440 specifier. */
export function poetryToPep440(constraint: string): string {
  return constraint
    .split(",")
    .map((part) => {
      const s = part.trim();
      if (s === "" || s === "*") return "";
      const caret = /^\^\s*(\d+(?:\.\d+)*)(.*)$/.exec(s);
      if (caret?.[1]) {
        const nums = caret[1].split(".").map(Number);
        const idx = nums.findIndex((x) => x !== 0);
        const bumpAt = idx < 0 ? nums.length - 1 : idx;
        const upper = nums.slice(0, bumpAt + 1);
        upper[bumpAt] = (upper[bumpAt] ?? 0) + 1;
        return `>=${caret[1]}${caret[2] ?? ""},<${upper.join(".")}`;
      }
      const tilde = /^~(?!=)\s*(\d+(?:\.\d+)*)(.*)$/.exec(s);
      if (tilde?.[1]) {
        const nums = tilde[1].split(".").map(Number);
        const keep = nums.length >= 2 ? nums.slice(0, 2) : nums.slice(0, 1);
        keep[keep.length - 1] = (keep[keep.length - 1] ?? 0) + 1;
        return `>=${tilde[1]}${tilde[2] ?? ""},<${keep.join(".")}`;
      }
      if (/^\d/.test(s)) return s.includes("*") ? `==${s}` : `==${s}`;
      return s;
    })
    .filter((s) => s !== "")
    .join(",");
}

/**
 * The newest known version that satisfies a declared range; undefined when
 * none does or the range cannot be read. Pre-releases count only when the range
 * names one.
 */
export function pickVersion(ecosystem: Ecosystem, range: string, known: readonly string[]): string | undefined {
  const r = range.trim();
  if (ecosystem === "npm") {
    const effective = r === "" || r === "latest" ? "*" : r;
    if (!semver.validRange(effective, { loose: true })) return undefined;
    const valid = known.filter((v) => semver.valid(v, { loose: true }));
    return semver.maxSatisfying(valid, effective, { loose: true, includePrerelease: false }) ?? undefined;
  }
  if (ecosystem === "pypi") {
    const spec = /^[\^~]|^\d|^\*$/.test(r) || /,\s*[\^~]/.test(r) ? poetryToPep440(r) : r;
    const clauses = parseSpecifier(spec);
    if (!clauses) return undefined;
    const allowPre = clauses.some((c) => {
      const p = parsePep440(c.version.replace(/\.\*$/, ""));
      return !!p && isPep440Prerelease(p);
    });
    let best: string | undefined;
    for (const v of known) {
      const p = parsePep440(v);
      if (!p || (!allowPre && isPep440Prerelease(p))) continue;
      if (!satisfiesPep440(v, spec)) continue;
      if (best === undefined || comparePep440(v, best) > 0) best = v;
    }
    return best;
  }
  // Go: go.mod versions are exact; a "range" here is a version or empty (newest release).
  if (r !== "") return known.includes(r) ? r : undefined;
  let best: string | undefined;
  for (const v of known) {
    const s = goSemver(v);
    if (!s || semver.prerelease(s)) continue;
    if (best === undefined || compareVersions("golang", v, best) > 0) best = v;
  }
  return best;
}
