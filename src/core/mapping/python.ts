// Python import names to PyPI distribution names (docs/DESIGN.md section 7.2).
// The installed metadata of the user's environment is not available to the
// extension, so the curated table and the workspace's declared requirements
// stand in for it.

import { normalizePypiName } from "../api/purl";
import type { SkipReason } from "../types";
import { PYTHON_STDLIB } from "./pythonStdlib";
import { PYTHON_IMPORT_TO_DIST } from "./pythonTable";

export interface PythonMappingContext {
  /** Top-level module and package names that exist inside the workspace (a .py file or a package with __init__.py). */
  localModules?: ReadonlySet<string>;
  /**
   * Directory names inside the workspace that hold Python files (PEP 420
   * namespace packages, src layouts, scripts folders). An import of one is local
   * unless the workspace declares a distribution of that name.
   */
  localDirs?: ReadonlySet<string>;
  /** The workspace's own project names, PEP 503 normalised. */
  selfNames?: ReadonlySet<string>;
}

export type PythonMapping = { name: string; declared: boolean } | { skip: SkipReason; detail?: string };

/**
 * Namespace roots shared by many unrelated distributions: the bare root names
 * no project (or a placeholder one), so an import that does not reach a known
 * subpackage is left unmapped rather than looked up under the root name.
 */
export const PYTHON_NAMESPACE_ROOTS: ReadonlySet<string> = new Set([
  "google",
  "google.cloud",
  "azure",
  "azure.mgmt",
  "azure.storage",
  "azure.keyvault",
  "azure.ai",
  "backports",
  "jaraco",
  "zope",
  "sphinxcontrib",
  "opentelemetry.instrumentation",
  "opentelemetry.exporter",
]);

/** Distribution candidates for an import, in preference order (the curated table, else the normalised top-level name). */
export function pythonCandidates(importName: string): string[] {
  const parts = importName.split(".");
  for (let n = parts.length; n >= 1; n--) {
    const hit = PYTHON_IMPORT_TO_DIST.get(parts.slice(0, n).join("."));
    if (hit) return [...hit];
  }
  return [parts[0] ?? importName];
}

/**
 * The distribution a dotted name maps to through the table (a key of at least
 * `minParts` elements) or a declared requirement; undefined when neither knows it.
 */
function specificMatch(name: string, declared: { has(name: string): boolean }, minParts: number): { name: string; declared: boolean } | undefined {
  const parts = name.split(".");
  let table: readonly string[] | undefined;
  for (let n = parts.length; n >= minParts; n--) {
    table = PYTHON_IMPORT_TO_DIST.get(parts.slice(0, n).join("."));
    if (table) break;
  }
  for (const c of table ?? []) if (declared.has(normalizePypiName(c))) return { name: c, declared: true };
  // Namespace packages: "google.cloud.firestore" may be declared as google-cloud-firestore.
  for (let n = parts.length; n >= Math.max(2, minParts); n--) {
    const dashed = parts.slice(0, n).join("-");
    if (declared.has(normalizePypiName(dashed))) return { name: dashed, declared: true };
  }
  const top = parts[0] ?? name;
  if (minParts <= 1 && declared.has(normalizePypiName(top))) return { name: top, declared: true };
  if (table?.[0]) return { name: table[0], declared: false };
  return undefined;
}

function isNamespaceRoot(name: string): boolean {
  const parts = name.split(".");
  for (let n = 1; n <= parts.length; n++) if (PYTHON_NAMESPACE_ROOTS.has(parts.slice(0, n).join("."))) return true;
  return false;
}

/**
 * The distribution that provides `importName`. `declared` holds the PEP 503
 * normalised names of every distribution the workspace declares; a declared
 * candidate wins over the table's default. `fromNames` are the names a
 * from-import imports (`from google.cloud import storage` passes ["storage"]):
 * they are tried as submodules first, since a namespace package is often
 * imported that way.
 */
export function pythonDistributionFor(
  importName: string,
  declared: { has(name: string): boolean },
  ctx: PythonMappingContext = {},
  fromNames: readonly string[] = [],
): PythonMapping {
  const name = importName.trim();
  if (name === "" || name.startsWith(".")) return { skip: "relative" };
  const top = name.split(".")[0] ?? name;
  if (PYTHON_STDLIB.has(top)) return { skip: "builtin", detail: top };
  if (ctx.localModules?.has(top)) return { skip: "local-module", detail: top };

  const depth = name.split(".").length;
  let chosen: { name: string; declared: boolean } | undefined;
  for (const n of fromNames) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) continue;
    chosen = specificMatch(`${name}.${n}`, declared, depth + 1);
    if (chosen) break;
  }
  chosen ??= specificMatch(name, declared, 1);

  // A directory of the workspace is local unless a manifest declares the name.
  if (ctx.localDirs?.has(top) && !chosen?.declared) return { skip: "local-module", detail: top };
  if (!chosen) {
    if (isNamespaceRoot(name)) return { skip: "unmapped", detail: name };
    chosen = { name: top, declared: false };
  }
  if (ctx.selfNames?.has(normalizePypiName(chosen.name))) return { skip: "self" };
  return chosen;
}
