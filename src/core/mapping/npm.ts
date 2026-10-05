// JavaScript and TypeScript specifiers to npm package names
// (docs/DESIGN.md section 7.1). Relative paths, built-ins, scheme specifiers,
// aliases and the workspace's own packages never become lookups.

import { matchesPathsPattern } from "../parsers/tsconfig";
import type { SkipReason } from "../types";
import { NODE_BUILTINS } from "./nodeBuiltins";

export interface NpmAliasContext {
  /** tsconfig or jsconfig `paths` patterns of the nearest config. */
  patterns?: readonly string[];
  /** First path segments (file and directory names, extensions removed) under that config's `baseUrl`. */
  baseUrlNames?: ReadonlySet<string>;
  /** Names of the workspace's own packages (every package.json "name"). */
  selfNames?: ReadonlySet<string>;
}

export type NpmMapping = { name: string } | { skip: SkipReason; detail?: string };

const VALID_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/i;

/** The npm package a specifier refers to, or why it is not looked up. */
export function npmPackageFor(specifier: string, aliases: NpmAliasContext = {}): NpmMapping {
  const spec = specifier.trim();
  if (spec === "") return { skip: "unmapped" };

  // Relative and absolute paths, file: URLs.
  if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === ".." || spec.startsWith("/") || /^file:/i.test(spec) || /^[A-Za-z]:[\\/]/.test(spec)) {
    return { skip: "relative" };
  }

  const first = spec.split("/")[0] ?? spec;
  if (/^node:/i.test(spec) || NODE_BUILTINS.has(first)) return { skip: "builtin", detail: spec.replace(/^node:/i, "") };

  // npm:name@range maps to name; any other scheme (bun:, deno:, virtual:, jsr:, https:) is not an npm package.
  const npmScheme = /^npm:((?:@[^/@]+\/)?[^@/]+)/i.exec(spec);
  if (npmScheme?.[1]) return withSelf(npmScheme[1], aliases);
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) return { skip: "builtin", detail: spec };

  if (spec.startsWith("#")) return { skip: "alias" };
  for (const p of aliases.patterns ?? []) {
    if (matchesPathsPattern(spec, p)) return { skip: "alias", detail: p };
  }
  if (aliases.baseUrlNames?.has(first)) return { skip: "alias", detail: "baseUrl" };
  if (spec.startsWith("@/") || spec.startsWith("~/") || /^~[^/]/.test(spec) || spec === "@" || spec === "~") return { skip: "alias" };
  if (spec.includes("!")) return { skip: "unmapped", detail: "loader syntax" };

  let name: string;
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    if (parts.length < 2 || !parts[1]) return { skip: "unmapped" };
    name = `${parts[0]}/${parts[1]}`;
  } else {
    name = first;
  }
  return withSelf(name, aliases);
}

function withSelf(name: string, aliases: NpmAliasContext): NpmMapping {
  if (name.length > 214 || !VALID_NAME.test(name) || name.startsWith(".") || name.startsWith("_")) return { skip: "unmapped" };
  if (aliases.selfNames?.has(name)) return { skip: "self" };
  return { name };
}
