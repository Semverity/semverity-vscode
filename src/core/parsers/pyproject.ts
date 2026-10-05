// pyproject.toml: PEP 621 dependencies and optional dependencies, PEP 735
// dependency groups, uv dev dependencies and Poetry dependency tables. A small
// TOML scanner records the offsets of keys and strings (smol-toml has no
// positions), and keeps working on a file that is half typed.

import { parse as parseToml } from "smol-toml";
import { normalizePypiName } from "../api/purl";
import type { ManifestDependency, ParsedManifest } from "../types";
import { parsePep508, pep508Dep, pep440ExactVersion } from "./requirements";
import { lineIndex } from "./scan";

interface TomlString {
  text: string;
  contentStart: number;
  contentEnd: number;
}

type TomlValue =
  | { type: "string"; str: TomlString }
  | { type: "array"; items: TomlString[] }
  | { type: "inline"; entries: Map<string, TomlString> }
  | { type: "other" };

interface TomlEntry {
  path: string[];
  keyStart: number;
  keyEnd: number;
  value: TomlValue;
}

/** Scans TOML text into key paths with string offsets. Tolerant of errors. */
export function scanToml(text: string): TomlEntry[] {
  const entries: TomlEntry[] = [];
  const n = text.length;
  let i = 0;
  let table: string[] = [];

  const skipSpaces = (): void => {
    while (i < n && (text[i] === " " || text[i] === "\t")) i++;
  };
  const skipToLineEnd = (): void => {
    const e = text.indexOf("\n", i);
    i = e < 0 ? n : e + 1;
  };
  const readKeyPart = (): { key: string; start: number; end: number } | undefined => {
    skipSpaces();
    const start = i;
    const c = text[i];
    if (c === '"' || c === "'") {
      const close = text.indexOf(c, i + 1);
      if (close < 0) return undefined;
      i = close + 1;
      return { key: text.slice(start + 1, close), start: start + 1, end: close };
    }
    while (i < n && /[A-Za-z0-9_-]/.test(text[i] as string)) i++;
    if (i === start) return undefined;
    return { key: text.slice(start, i), start, end: i };
  };
  const readDottedKey = (): { parts: string[]; start: number; end: number } | undefined => {
    const parts: string[] = [];
    let start = -1;
    let end: number;
    for (;;) {
      const p = readKeyPart();
      if (!p) return undefined;
      if (start < 0) start = p.start;
      end = p.end;
      parts.push(p.key);
      skipSpaces();
      if (text[i] === ".") {
        i++;
        continue;
      }
      return { parts, start, end };
    }
  };
  const readString = (): TomlString | undefined => {
    const c = text[i];
    if (c !== '"' && c !== "'") return undefined;
    const triple = text.startsWith(c.repeat(3), i);
    const q = triple ? c.repeat(3) : c;
    const contentStart = i + q.length;
    let j = contentStart;
    while (j < n) {
      if (c === '"' && text[j] === "\\") {
        j += 2;
        continue;
      }
      if (!triple && text[j] === "\n") break;
      if (text.startsWith(q, j)) break;
      j++;
    }
    const contentEnd = Math.min(j, n);
    i = text.startsWith(q, j) ? j + q.length : j;
    return { text: text.slice(contentStart, contentEnd), contentStart, contentEnd };
  };
  const skipComment = (): void => {
    if (text[i] === "#") {
      const e = text.indexOf("\n", i);
      i = e < 0 ? n : e;
    }
  };
  const readArray = (): TomlString[] => {
    // i is at "["
    const items: TomlString[] = [];
    i++;
    let depth = 1;
    while (i < n && depth > 0) {
      const c = text[i];
      if (c === "#") skipComment();
      else if (c === '"' || c === "'") {
        const s = readString();
        if (s && depth === 1) items.push(s);
        continue;
      } else if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") depth--;
      i++;
    }
    return items;
  };
  const readInline = (): Map<string, TomlString> => {
    // i is at "{"; inline tables are one line in TOML 1.0, but tolerate more.
    const map = new Map<string, TomlString>();
    i++;
    for (;;) {
      skipSpaces();
      if (i >= n || text[i] === "}" || text[i] === "\n") {
        if (text[i] === "}") i++;
        return map;
      }
      if (text[i] === ",") {
        i++;
        continue;
      }
      const key = readDottedKey();
      if (!key) {
        skipToLineEnd();
        return map;
      }
      skipSpaces();
      if (text[i] !== "=") return map;
      i++;
      skipSpaces();
      const c = text[i];
      if (c === '"' || c === "'") {
        const s = readString();
        if (s) map.set(key.parts.join("."), s);
      } else if (c === "[") readArray();
      else if (c === "{") readInline();
      else while (i < n && text[i] !== "," && text[i] !== "}" && text[i] !== "\n") i++;
    }
  };

  while (i < n) {
    skipSpaces();
    const c = text[i];
    if (c === undefined) break;
    if (c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "#") {
      skipToLineEnd();
      continue;
    }
    if (c === "[") {
      const double = text[i + 1] === "[";
      i += double ? 2 : 1;
      const key = readDottedKey();
      table = key ? key.parts : [];
      skipToLineEnd();
      continue;
    }
    const key = readDottedKey();
    if (!key) {
      skipToLineEnd();
      continue;
    }
    skipSpaces();
    if (text[i] !== "=") {
      skipToLineEnd();
      continue;
    }
    i++;
    skipSpaces();
    const path = [...table, ...key.parts];
    const v = text[i];
    let value: TomlValue;
    if (v === '"' || v === "'") {
      const s = readString();
      value = s ? { type: "string", str: s } : { type: "other" };
    } else if (v === "[") value = { type: "array", items: readArray() };
    else if (v === "{") value = { type: "inline", entries: readInline() };
    else {
      value = { type: "other" };
      skipToLineEnd();
    }
    entries.push({ path, keyStart: key.start, keyEnd: key.end, value });
  }
  return entries;
}

function isPoetryDependencyPath(path: string[]): string | undefined {
  // tool.poetry.dependencies.<name>, tool.poetry.dev-dependencies.<name>, tool.poetry.group.<g>.dependencies.<name>
  if (path[0] !== "tool" || path[1] !== "poetry") return undefined;
  if (path.length === 4 && (path[2] === "dependencies" || path[2] === "dev-dependencies")) return path.slice(0, 3).join(".");
  if (path.length === 6 && path[2] === "group" && path[4] === "dependencies") return path.slice(0, 5).join(".");
  return undefined;
}

/** The single version a Poetry constraint pins ("1.2.3", "==1.2.3"). */
export function poetryExactVersion(spec: string): string | undefined {
  const s = spec.trim();
  if (/^\d+(?:\.\d+)*(?:[a-z0-9.+-]*)$/i.test(s) && !s.includes("*")) return s;
  return pep440ExactVersion(s);
}

function isTable(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function tableAt(doc: Record<string, unknown>, path: string[]): Record<string, unknown> | undefined {
  let at: unknown = doc;
  for (const key of path) {
    if (!isTable(at)) return undefined;
    at = at[key];
  }
  return isTable(at) ? at : undefined;
}

/**
 * Package index URLs a pyproject.toml configures: uv's `index`, `index-url`,
 * `extra-index-url` and `find-links` (also under `tool.uv.pip`), Poetry's and
 * PDM's `source` tables. Only URLs are read.
 */
export function pyprojectIndexUrls(doc: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v.trim() !== "") urls.push(v.trim());
    else if (Array.isArray(v)) for (const x of v) add(x);
  };
  // An explicit index (uv `explicit = true`, Poetry `priority = "explicit"`)
  // serves only the packages pinned to it, which pyprojectPinnedSources marks.
  const addSources = (v: unknown) => {
    if (!Array.isArray(v)) return;
    for (const s of v) {
      if (!isTable(s) || s["explicit"] === true || s["priority"] === "explicit") continue;
      add(s["url"]);
    }
  };
  for (const uv of [tableAt(doc, ["tool", "uv"]), tableAt(doc, ["tool", "uv", "pip"])]) {
    if (!uv) continue;
    addSources(uv["index"]);
    add(uv["index-url"]);
    add(uv["extra-index-url"]);
    add(uv["find-links"]);
  }
  addSources(tableAt(doc, ["tool", "poetry"])?.["source"]);
  addSources(tableAt(doc, ["tool", "pdm"])?.["source"]);
  return urls;
}

/**
 * Dependencies `[tool.uv.sources]` takes from somewhere other than the default
 * index (a named index, git, a path, a URL or the workspace), by normalised
 * name, with the kind of source.
 */
export function pyprojectPinnedSources(doc: Record<string, unknown>): Map<string, string> {
  const pinned = new Map<string, string>();
  const sources = tableAt(doc, ["tool", "uv", "sources"]);
  for (const [name, value] of Object.entries(sources ?? {})) {
    const entries = Array.isArray(value) ? value : [value];
    for (const v of entries) {
      if (!isTable(v)) continue;
      const kind = "git" in v ? "git" : "path" in v ? "file" : "url" in v ? "url" : "workspace" in v ? "workspace" : "index" in v ? "index" : undefined;
      if (kind) pinned.set(normalizePypiName(name), kind);
    }
  }
  return pinned;
}

export function parsePyproject(uri: string, text: string): ParsedManifest {
  const result: ParsedManifest = { uri, kind: "pyproject", ecosystem: "pypi", dependencies: [] };
  const index = lineIndex(text);
  let entries: TomlEntry[];
  try {
    entries = scanToml(text);
  } catch {
    entries = [];
  }

  for (const e of entries) {
    const p = e.path;
    const joined = p.join(".");
    if ((joined === "project.name" || joined === "tool.poetry.name") && e.value.type === "string") {
      result.selfName ??= e.value.str.text;
      continue;
    }
    let section: string | undefined;
    if (joined === "project.dependencies" || joined === "tool.uv.dev-dependencies") section = joined;
    else if (p.length === 3 && p[0] === "project" && p[1] === "optional-dependencies") section = joined;
    else if (p.length === 2 && p[0] === "dependency-groups") section = joined;
    if (section && e.value.type === "array") {
      for (const item of e.value.items) {
        const req = parsePep508(item.text);
        if (req) result.dependencies.push(pep508Dep(req, item.contentStart, index, section));
      }
      continue;
    }
    const poetrySection = isPoetryDependencyPath(p);
    if (poetrySection) {
      const rawName = p[p.length - 1] as string;
      if (rawName.toLowerCase() === "python") continue;
      const nameRange = index.rangeOf(e.keyStart, e.keyEnd);
      const dep: ManifestDependency = {
        ecosystem: "pypi",
        name: normalizePypiName(rawName),
        rawName,
        spec: "",
        section: poetrySection,
        line: nameRange.start.line,
        nameRange,
      };
      let specStr: TomlString | undefined;
      if (e.value.type === "string") specStr = e.value.str;
      else if (e.value.type === "inline") {
        const m = e.value.entries;
        if (m.has("git")) dep.nonRegistry = "git";
        else if (m.has("path")) dep.nonRegistry = "file";
        else if (m.has("url")) dep.nonRegistry = "url";
        else if (m.has("source")) dep.nonRegistry = "index";
        specStr = m.get("version");
      }
      if (specStr && !dep.nonRegistry) {
        dep.spec = specStr.text;
        dep.specRange = index.rangeOf(specStr.contentStart, specStr.contentEnd);
        const exact = poetryExactVersion(specStr.text);
        if (exact) dep.exactVersion = exact;
      }
      result.dependencies.push(dep);
    }
  }

  let doc: unknown;
  try {
    doc = parseToml(text);
  } catch {
    // Half-typed file: keep what the scanner found.
  }
  if (result.selfName === undefined && isTable(doc)) {
    // The scanner missed it (unusual layout); ask the real TOML parser.
    const name = tableAt(doc, ["project"])?.["name"] ?? tableAt(doc, ["tool", "poetry"])?.["name"];
    if (typeof name === "string") result.selfName = name;
  }
  if (isTable(doc)) {
    const indexUrls = pyprojectIndexUrls(doc);
    if (indexUrls.length > 0) result.indexUrls = indexUrls;
    const pinned = pyprojectPinnedSources(doc);
    for (const dep of result.dependencies) {
      const kind = pinned.get(dep.name);
      if (kind && !dep.nonRegistry) dep.nonRegistry = kind;
    }
  }
  return result;
}
