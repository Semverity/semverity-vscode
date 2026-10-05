// Which documents the extension reads (docs/DESIGN.md 9.1). Kept free of the
// vscode import so it is unit tested.

import type { ManifestKind } from "../core/types";

export const SOURCE_LANGUAGES: readonly string[] = [
  "javascript",
  "javascriptreact",
  "typescript",
  "typescriptreact",
  "python",
  "go",
];

/** Schemes whose documents are read; output panels, diff views of git objects and the like are not. */
export const SUPPORTED_SCHEMES: readonly string[] = ["file", "untitled", "vscode-remote", "vscode-vfs"];

export const MANIFEST_GLOBS: readonly string[] = ["**/package.json", "**/requirements*.txt", "**/pyproject.toml", "**/go.mod"];

/** Directories whose files are never analysed (installed packages and vendored code). */
const IGNORED_DIR = /(^|\/)(node_modules|\.venv|venv|site-packages|vendor)\//;

/** Documents larger than this are skipped. */
export const MAX_DOCUMENT_CHARS = 1_000_000;

export function manifestKindOf(path: string): ManifestKind | undefined {
  const base = path.split("/").pop() ?? "";
  if (base === "package.json") return "package.json";
  if (base === "pyproject.toml") return "pyproject";
  if (base === "go.mod") return "go.mod";
  if (/^requirements.*\.txt$/i.test(base)) return "requirements";
  return undefined;
}

/** The language id the core is given for a manifest, whatever the editor calls it. */
export function manifestLanguageId(kind: ManifestKind): string {
  switch (kind) {
    case "package.json":
      return "json";
    case "requirements":
      return "pip-requirements";
    case "pyproject":
      return "toml";
    case "go.mod":
      return "go.mod";
  }
}

export function isIgnoredPath(path: string): boolean {
  return IGNORED_DIR.test(path);
}

/** True for a source file of a supported language or a supported manifest, outside ignored directories. */
export function isSupportedDocument(doc: { scheme: string; path: string; languageId: string }): boolean {
  if (!SUPPORTED_SCHEMES.includes(doc.scheme)) return false;
  if (isIgnoredPath(doc.path)) return false;
  if (manifestKindOf(doc.path)) return true;
  return SOURCE_LANGUAGES.includes(doc.languageId);
}

/** File names the watchers report to the workspace index. */
export const WATCHED_FILES_GLOB =
  "**/{package.json,package-lock.json,npm-shrinkwrap.json,pnpm-lock.yaml,yarn.lock,bun.lock,requirements*.txt,pyproject.toml,poetry.lock,uv.lock,pdm.lock,Pipfile.lock,go.mod,go.work,.npmrc,tsconfig.json,jsconfig.json}";
