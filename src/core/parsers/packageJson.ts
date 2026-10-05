// package.json: dependencies with the exact ranges of names and specs, the
// package name, workspaces and "imports" keys. Parsed with jsonc-parser so a
// half-typed file still yields what can be read.

import { parseTree, type Node } from "jsonc-parser";
import type { ManifestDependency, ParsedManifest } from "../types";
import { lineIndex } from "./scan";

export interface PackageJsonManifest extends ParsedManifest {
  kind: "package.json";
  /** Workspace globs ("packages/*"). */
  workspaces: string[];
  /** Keys of the "imports" field ("#internal/*"). */
  importsKeys: string[];
}

export const NPM_DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

/** Classifies an npm dependency spec: the alias target, a non-registry kind, or a plain registry range. */
export function classifyNpmSpec(spec: string): { aliasOf?: string; range: string; nonRegistry?: string } {
  const s = spec.trim();
  const alias = /^npm:((?:@[^/@\s]+\/)?[^@\s]+)(?:@(.*))?$/.exec(s);
  if (alias) return { aliasOf: alias[1], range: (alias[2] ?? "").trim() };
  if (/^workspace:/.test(s)) return { range: s, nonRegistry: "workspace" };
  if (/^(?:file|portal):/.test(s)) return { range: s, nonRegistry: "file" };
  if (/^link:/.test(s)) return { range: s, nonRegistry: "link" };
  if (/^(?:git\+|git:|github:|gitlab:|bitbucket:|gist:)/.test(s) || /\.git(?:#.*)?$/.test(s)) return { range: s, nonRegistry: "git" };
  if (/^https?:/.test(s)) return { range: s, nonRegistry: "url" };
  if (/^\.{0,2}\//.test(s) || /^~\//.test(s)) return { range: s, nonRegistry: "file" };
  // GitHub shorthand "user/repo" or "user/repo#ref".
  if (/^[A-Za-z0-9][\w.-]*\/[\w.-]+(?:#.*)?$/.test(s)) return { range: s, nonRegistry: "git" };
  return { range: s };
}

/** The single version an npm spec pins, when it pins exactly one ("1.2.3", "=1.2.3", "v1.2.3"). */
export function npmExactVersion(range: string): string | undefined {
  const m = /^\s*=?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\s*$/.exec(range);
  return m ? m[1] : undefined;
}

function stringValue(node: Node | undefined): string | undefined {
  return node && node.type === "string" && typeof node.value === "string" ? node.value : undefined;
}

function property(obj: Node | undefined, key: string): Node | undefined {
  if (!obj || obj.type !== "object") return undefined;
  for (const p of obj.children ?? []) {
    if (p.type === "property" && p.children?.[0]?.value === key) return p.children[1];
  }
  return undefined;
}

export function parsePackageJson(uri: string, text: string): PackageJsonManifest {
  const result: PackageJsonManifest = { uri, kind: "package.json", ecosystem: "npm", dependencies: [], workspaces: [], importsKeys: [] };
  let root: Node | undefined;
  try {
    root = parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
  } catch {
    return result;
  }
  if (!root || root.type !== "object") return result;
  const index = lineIndex(text);

  const name = stringValue(property(root, "name"));
  if (name) result.selfName = name;

  const ws = property(root, "workspaces");
  const wsList = ws?.type === "array" ? ws : property(ws, "packages");
  if (wsList?.type === "array") {
    for (const c of wsList.children ?? []) {
      const v = stringValue(c);
      if (v) result.workspaces.push(v);
    }
  }

  const imports = property(root, "imports");
  if (imports?.type === "object") {
    for (const p of imports.children ?? []) {
      const k = p.children?.[0]?.value;
      if (typeof k === "string") result.importsKeys.push(k);
    }
  }

  for (const section of NPM_DEPENDENCY_SECTIONS) {
    const obj = property(root, section);
    if (!obj || obj.type !== "object") continue;
    for (const p of obj.children ?? []) {
      const keyNode = p.children?.[0];
      const valueNode = p.children?.[1];
      const rawName = keyNode?.value;
      if (!keyNode || typeof rawName !== "string" || rawName === "") continue;
      const spec = stringValue(valueNode) ?? "";
      const cls = classifyNpmSpec(spec);
      const nameRange = index.rangeOf(keyNode.offset + 1, keyNode.offset + keyNode.length - 1);
      const dep: ManifestDependency = {
        ecosystem: "npm",
        name: cls.aliasOf ?? rawName,
        rawName,
        spec,
        section,
        line: nameRange.start.line,
        nameRange,
      };
      if (valueNode && valueNode.type === "string") {
        dep.specRange = index.rangeOf(valueNode.offset + 1, valueNode.offset + valueNode.length - 1);
      }
      if (cls.nonRegistry) dep.nonRegistry = cls.nonRegistry;
      else {
        const exact = npmExactVersion(cls.range);
        if (exact) dep.exactVersion = exact;
      }
      result.dependencies.push(dep);
    }
  }
  return result;
}
