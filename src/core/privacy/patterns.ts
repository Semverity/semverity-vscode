// semverity.privacy.excludePatterns: an optional "npm:", "pypi:" or "golang:"
// prefix, then a glob where "*" matches any run of characters (including "/")
// and "?" matches one character. PyPI names are compared after PEP 503
// normalisation; npm and Go names case-sensitively.

import { normalizePypiName } from "../api/purl";
import type { Ecosystem, PackageId } from "../types";

function globToRegExp(glob: string, flags = ""): RegExp {
  let re = "";
  for (const c of glob) {
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else re += c.replace(/[.+^${}()|[\]\\/-]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, flags);
}

/** Normalises the literal parts of a PyPI glob, keeping its wildcards. */
function normalizePypiGlob(glob: string): string {
  return glob
    .split(/([*?])/)
    .map((part) => (part === "*" || part === "?" ? part : part.toLowerCase().replace(/[-_.]+/g, "-")))
    .join("");
}

export function compilePattern(pattern: string): (id: PackageId) => boolean {
  const p = pattern.trim();
  if (p === "") return () => false;
  const m = /^(npm|pypi|golang|go):(.*)$/.exec(p);
  const ecosystem: Ecosystem | undefined = m ? (m[1] === "go" ? "golang" : (m[1] as Ecosystem)) : undefined;
  const glob = m ? (m[2] ?? "") : p;
  const raw = globToRegExp(glob);
  const pypi = globToRegExp(normalizePypiGlob(glob));
  return (id) => {
    if (ecosystem && id.ecosystem !== ecosystem) return false;
    if (id.ecosystem === "pypi") return pypi.test(normalizePypiName(id.name));
    return raw.test(id.name);
  };
}
