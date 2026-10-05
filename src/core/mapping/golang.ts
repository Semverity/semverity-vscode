// Go import paths to module paths (docs/DESIGN.md section 7.3): the longest
// module in go.mod that prefixes the import at a "/" boundary, with replace
// directives applied; the standard library and the main module are skipped.

import { replacementFor, type GoReplace } from "../parsers/goMod";
import type { SkipReason } from "../types";

export interface GoMappingContext {
  /** Module paths of the workspace's own modules (go.mod `module` lines and go.work members). */
  mainModules?: ReadonlySet<string>;
  /** require lines of the nearest go.mod. */
  requires?: readonly { path: string; version?: string }[];
  replaces?: readonly GoReplace[];
  /** Guess a module for imports no go.mod declares (well-known hosts only). */
  lookupUndeclared?: boolean;
}

export type GoMapping =
  | {
      /** The module to look up (the replacement when a replace applies). */
      module: string;
      declared: boolean;
      /** The version to look up, when go.mod names one (the replacement's version when replaced). */
      version?: string;
      /** The module as required, when a replace changed it. */
      requiredAs?: string;
    }
  | { skip: SkipReason; detail?: string };

/** Standard library: the first path element has no dot (fmt, net/http), or the path is "C". */
export function isGoStdlib(path: string): boolean {
  if (path === "C") return true;
  const first = path.split("/")[0] ?? "";
  return !first.includes(".");
}

function isPrefix(module: string, importPath: string): boolean {
  return importPath === module || importPath.startsWith(`${module}/`);
}

const MAJOR = /^v[0-9]+$/;

/** A module path guess for an undeclared import on a well-known host; undefined for other hosts. */
export function guessGoModule(importPath: string): string | undefined {
  const parts = importPath.split("/");
  const host = parts[0] ?? "";
  const take = (n: number): string | undefined => (parts.length >= n ? parts.slice(0, n).join("/") : undefined);
  switch (host) {
    case "github.com":
    case "gitlab.com":
    case "bitbucket.org": {
      const base = take(3);
      if (!base) return undefined;
      return parts[3] && MAJOR.test(parts[3]) && parts[3] !== "v0" && parts[3] !== "v1" ? `${base}/${parts[3]}` : base;
    }
    case "golang.org":
      return parts[1] === "x" ? take(3) : undefined;
    case "google.golang.org":
    case "go.uber.org":
    case "k8s.io":
    case "sigs.k8s.io":
      return take(2);
    case "gopkg.in": {
      // gopkg.in/<name>.vN or gopkg.in/<user>/<name>.vN
      if (parts[1] && /\.v[0-9]+$/.test(parts[1])) return take(2);
      if (parts[2] && /\.v[0-9]+$/.test(parts[2])) return take(3);
      return undefined;
    }
    default:
      return undefined;
  }
}

export function goModuleFor(importPath: string, ctx: GoMappingContext = {}): GoMapping {
  const path = importPath.trim();
  if (path === "") return { skip: "unmapped" };
  if (path.startsWith("./") || path.startsWith("../") || path.startsWith("/")) return { skip: "relative" };
  if (isGoStdlib(path)) return { skip: "builtin", detail: path };
  for (const m of ctx.mainModules ?? []) {
    if (isPrefix(m, path)) return { skip: "self", detail: m };
  }

  let best: { path: string; version?: string } | undefined;
  for (const r of ctx.requires ?? []) {
    if (isPrefix(r.path, path) && (!best || r.path.length > best.path.length)) best = r;
  }
  // A replace target can also be imported directly when its module is replaced in place.
  if (!best) {
    for (const r of ctx.replaces ?? []) {
      if (isPrefix(r.from, path) && (!best || r.from.length > best.path.length)) best = { path: r.from };
    }
  }

  if (best) {
    const rep = replacementFor([...(ctx.replaces ?? [])], best.path, best.version);
    if (rep?.local) return { skip: "non-registry", detail: "replaced by a local directory" };
    if (rep) {
      const out: GoMapping = { module: rep.to, declared: true, requiredAs: best.path };
      if (rep.toVersion) out.version = rep.toVersion;
      return out;
    }
    const out: GoMapping = { module: best.path, declared: true };
    if (best.version) out.version = best.version;
    return out;
  }

  if (!ctx.lookupUndeclared) return { skip: "undeclared" };
  const guess = guessGoModule(path);
  if (!guess) return { skip: "unmapped", detail: "not declared in go.mod" };
  return { module: guess, declared: false };
}
