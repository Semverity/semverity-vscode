// Finds a declared dependency again in the current text of its manifest, so an
// edit computed from an older parse (the workspace index, a hover shown before
// the user typed) lands on the version text as it is now.

import type { DeclaredIn } from "../types";
import { parseManifest } from "./workspaceIndex";

/** The declaration of the same dependency (name, raw name and section) in `text`; undefined when it is gone. */
export function redeclare(declaredIn: DeclaredIn, text: string): DeclaredIn | undefined {
  let manifest;
  try {
    manifest = parseManifest(declaredIn.manifestUri, text, declaredIn.manifestKind);
  } catch {
    return undefined;
  }
  const old = declaredIn.dependency;
  const same = manifest.dependencies.filter((d) => d.name === old.name && d.rawName === old.rawName && d.section === old.section);
  if (same.length === 0) return undefined;
  // Duplicates (a requirement listed twice): the one nearest the old line.
  const dep = same.reduce((best, d) => (Math.abs(d.line - old.line) < Math.abs(best.line - old.line) ? d : best));
  return { manifestUri: declaredIn.manifestUri, manifestKind: declaredIn.manifestKind, dependency: dep };
}
