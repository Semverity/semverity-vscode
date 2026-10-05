// requirements*.txt (pip's format) and the PEP 508 requirement strings shared
// with pyproject.toml. Only the subset the extension needs is understood:
// names, extras, version specifiers, markers, direct references, editable and
// path requirements, -r and -c includes, and index options.

import { normalizePypiName } from "../api/purl";
import type { ManifestDependency, ParsedManifest } from "../types";
import { lineIndex } from "./scan";

export interface RequirementsManifest extends ParsedManifest {
  kind: "requirements";
  /** --index-url, -i, --extra-index-url and --find-links values. */
  indexUrls: string[];
  /** -r and -c targets, as written. */
  includes: string[];
}

export interface Pep508 {
  name: string;
  /** Offsets relative to the parsed string. */
  nameStart: number;
  nameEnd: number;
  /** The version specifier as written ("" when absent), without parentheses. */
  spec: string;
  specStart: number;
  specEnd: number;
  /** "url" or "git" for `name @ url` direct references. */
  nonRegistry?: string;
}

const NAME = /^[ \t]*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/;

/** Parses one PEP 508 requirement string; undefined when it does not start with a name. */
export function parsePep508(text: string): Pep508 | undefined {
  const m = NAME.exec(text);
  if (!m || !m[1]) return undefined;
  const nameStart = m[0].length - m[1].length;
  const nameEnd = m[0].length;
  let at = nameEnd;
  const skipWs = (): void => {
    while (at < text.length && /[ \t]/.test(text[at] as string)) at++;
  };
  skipWs();
  if (text[at] === "[") {
    const close = text.indexOf("]", at);
    if (close < 0) return undefined;
    at = close + 1;
    skipWs();
  }
  const result: Pep508 = { name: m[1], nameStart, nameEnd, spec: "", specStart: at, specEnd: at };
  if (text[at] === "@") {
    const url = text.slice(at + 1).trim();
    result.nonRegistry = /^git\+/.test(url) ? "git" : /^file:/.test(url) ? "file" : "url";
    return result;
  }
  const markerAt = text.indexOf(";", at);
  let end = markerAt < 0 ? text.length : markerAt;
  let start = at;
  if (text[at] === "(") {
    const close = text.indexOf(")", at);
    start = at + 1;
    end = close < 0 ? end : close;
  }
  // Trim the specifier to its non-blank extent.
  while (start < end && /\s/.test(text[start] as string)) start++;
  while (end > start && /\s/.test(text[end - 1] as string)) end--;
  const spec = text.slice(start, end);
  if (spec !== "" && !/^(?:===|==|!=|<=|>=|~=|<|>)/.test(spec)) {
    // Not a version specifier: something else follows the name (a pip option, a typo).
    return { ...result, spec: "", specStart: at, specEnd: at };
  }
  result.spec = spec;
  result.specStart = start;
  result.specEnd = end;
  return result;
}

/** The single version a PEP 440 specifier pins: one `==X` (no wildcard) or `===X` clause. */
export function pep440ExactVersion(spec: string): string | undefined {
  const s = spec.trim();
  if (s.includes(",")) return undefined;
  const m = /^(?:===|==)\s*([^\s*,;]+)$/.exec(s);
  return m ? m[1] : undefined;
}

const OPTION_WITH_VALUE = /^(-r|--requirement|-c|--constraint|-i|--index-url|--extra-index-url|-f|--find-links|-e|--editable)(?:[ \t]*=[ \t]*|[ \t]+)(\S+)/;

export function parseRequirements(uri: string, text: string): RequirementsManifest {
  const result: RequirementsManifest = { uri, kind: "requirements", ecosystem: "pypi", dependencies: [], indexUrls: [], includes: [] };
  const index = lineIndex(text);
  // Mask line continuations and comments, keeping every offset.
  const units = text.split("");
  for (let i = 0; i < units.length; i++) {
    if (units[i] === "\\" && (units[i + 1] === "\n" || (units[i + 1] === "\r" && units[i + 2] === "\n"))) {
      units[i] = " ";
      if (units[i + 1] === "\r") units[i + 1] = " ";
      units[i + (units[i + 1] === "\n" ? 1 : 2)] = " ";
    }
  }
  let masked = units.join("");
  masked = masked.replace(/(^|[ \t])#[^\n]*/gm, (m, lead: string) => lead + " ".repeat(m.length - lead.length));

  let offset = 0;
  for (const raw of masked.split("\n")) {
    const lineStart = offset;
    offset += raw.length + 1;
    const line = raw.replace(/\r$/, "");
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const lead = line.length - line.trimStart().length;

    const opt = OPTION_WITH_VALUE.exec(trimmed);
    if (opt) {
      const [, flag, value] = opt as unknown as [string, string, string];
      if (flag === "-r" || flag === "--requirement" || flag === "-c" || flag === "--constraint") result.includes.push(value);
      else if (flag === "-e" || flag === "--editable") {
        const egg = /#egg=([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(value);
        if (egg?.[1]) {
          const nameAt = lineStart + lead + trimmed.indexOf(egg[1]);
          result.dependencies.push(nonRegistryDep(egg[1], index, nameAt, "editable"));
        }
      } else result.indexUrls.push(value);
      continue;
    }
    if (trimmed.startsWith("-")) continue; // other pip options (--pre, --trusted-host, --no-binary ...)

    // Direct URLs and local paths: only a #egg= name can be read.
    if (/^(?:[a-z][a-z0-9+.-]*:\/\/|git\+|\.{1,2}\/|\/|[A-Za-z]:[\\/]|\.$)/.test(trimmed) || /\.(?:whl|tar\.gz|zip)$/.test(trimmed.split(/\s/)[0] ?? "")) {
      const egg = /#egg=([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(trimmed);
      if (egg?.[1]) {
        const nameAt = lineStart + lead + trimmed.indexOf(egg[1]);
        result.dependencies.push(nonRegistryDep(egg[1], index, nameAt, /git\+/.test(trimmed) ? "git" : /^(?:\.|\/|[A-Za-z]:)/.test(trimmed) ? "file" : "url"));
      }
      continue;
    }

    // Drop per-requirement options (--hash=..., --global-option ...) before parsing.
    const optAt = trimmed.search(/\s--?[a-z]/);
    const reqText = optAt >= 0 ? trimmed.slice(0, optAt) : trimmed;
    const req = parsePep508(reqText);
    if (!req) continue;
    const base = lineStart + lead;
    result.dependencies.push(pep508Dep(req, base, index, "requirements"));
  }
  return result;
}

/** A ManifestDependency from a parsed PEP 508 string located at `base` in the file. */
export function pep508Dep(req: Pep508, base: number, index: ReturnType<typeof lineIndex>, section: string): ManifestDependency {
  const nameRange = index.rangeOf(base + req.nameStart, base + req.nameEnd);
  const dep: ManifestDependency = {
    ecosystem: "pypi",
    name: normalizePypiName(req.name),
    rawName: req.name,
    spec: req.spec,
    section,
    line: nameRange.start.line,
    nameRange,
  };
  if (req.nonRegistry) dep.nonRegistry = req.nonRegistry;
  else {
    if (req.spec !== "") dep.specRange = index.rangeOf(base + req.specStart, base + req.specEnd);
    const exact = pep440ExactVersion(req.spec);
    if (exact) dep.exactVersion = exact;
  }
  return dep;
}

function nonRegistryDep(name: string, index: ReturnType<typeof lineIndex>, at: number, kind: string): ManifestDependency {
  const nameRange = index.rangeOf(at, at + name.length);
  return {
    ecosystem: "pypi",
    name: normalizePypiName(name),
    rawName: name,
    spec: "",
    section: "requirements",
    line: nameRange.start.line,
    nameRange,
    nonRegistry: kind,
  };
}
