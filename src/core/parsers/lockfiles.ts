// Lockfile readers. Each returns a Lockfile that answers the locked version of
// a package (for a given importer directory in a monorepo) and the host the
// package was resolved from, which the privacy filter uses to keep packages
// from private registries local. Readers never throw: an unreadable lockfile
// answers nothing.

import { parseTree, getNodeValue } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { normalizePypiName } from "../api/purl";
import type { Ecosystem } from "../types";

export interface Lockfile {
  ecosystem: Ecosystem;
  /** The lockfile's base name ("package-lock.json"). */
  kind: string;
  /**
   * The locked version of `name`. `importerDir` is the declaring manifest's
   * directory relative to the lockfile's ("" or "." for the same directory);
   * `range` is the declared range (yarn.lock keys entries by it).
   */
  versions(name: string, importerDir?: string, range?: string): string | undefined;
  /** Lowercase host the package resolves from, when the lockfile records one. */
  resolvedHost(name: string, importerDir?: string): string | undefined;
}

export const NPM_LOCKFILES = ["npm-shrinkwrap.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"] as const;
export const PYPI_LOCKFILES = ["poetry.lock", "uv.lock", "pdm.lock", "Pipfile.lock"] as const;

const EMPTY = (ecosystem: Ecosystem, kind: string): Lockfile => ({
  ecosystem,
  kind,
  versions: () => undefined,
  resolvedHost: () => undefined,
});

export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:?#]+)/i.exec(url.trim());
  return m?.[1]?.toLowerCase();
}

function normDir(dir: string | undefined): string {
  if (!dir || dir === ".") return "";
  return dir.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** package-lock.json and npm-shrinkwrap.json, lockfile versions 1, 2 and 3. */
export function parseNpmLock(text: string, kind = "package-lock.json"): Lockfile {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return EMPTY("npm", kind);
  }
  if (!isRecord(doc)) return EMPTY("npm", kind);
  const packages = isRecord(doc.packages) ? doc.packages : undefined;
  const deps = isRecord(doc.dependencies) ? doc.dependencies : undefined;

  const entry = (name: string, importerDir?: string): Record<string, unknown> | undefined => {
    const dir = normDir(importerDir);
    if (packages) {
      const candidates = dir ? [`${dir}/node_modules/${name}`, `node_modules/${name}`] : [`node_modules/${name}`];
      for (const key of candidates) {
        const e = packages[key];
        if (isRecord(e)) return e;
      }
      return undefined;
    }
    const e = deps?.[name];
    return isRecord(e) ? e : undefined;
  };

  return {
    ecosystem: "npm",
    kind,
    versions(name, importerDir) {
      const e = entry(name, importerDir);
      if (!e || e.link === true) return undefined;
      const v = str(e.version);
      if (!v || /^(?:file|link|git|github|https?):/.test(v) || v.includes("/")) return undefined;
      return v;
    },
    resolvedHost(name, importerDir) {
      const e = entry(name, importerDir);
      return e && e.link !== true ? hostOf(str(e.resolved)) : undefined;
    },
  };
}

/** Removes pnpm peer suffixes: "18.3.1(react@18.3.1)" and "1.0.0_react@18.2.0" become the bare version. */
export function stripPnpmSuffix(v: string): string {
  return v.replace(/\(.*$/, "").replace(/_.*$/, "");
}

/** pnpm-lock.yaml, lockfile versions 5 to 9. */
export function parsePnpmLock(text: string): Lockfile {
  let doc: unknown;
  try {
    doc = parseYaml(text, { maxAliasCount: 100 });
  } catch {
    return EMPTY("npm", "pnpm-lock.yaml");
  }
  if (!isRecord(doc)) return EMPTY("npm", "pnpm-lock.yaml");
  const importers = isRecord(doc.importers) ? doc.importers : { ".": doc };
  const packages = isRecord(doc.packages) ? doc.packages : {};

  const declared = (importer: unknown, name: string): string | undefined => {
    if (!isRecord(importer)) return undefined;
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const s = importer[section];
      if (!isRecord(s)) continue;
      const e = s[name];
      if (typeof e === "string") return e;
      if (isRecord(e) && typeof e.version === "string") return e.version;
    }
    return undefined;
  };

  const raw = (name: string, importerDir?: string): string | undefined => {
    const dir = normDir(importerDir) || ".";
    const own = declared(importers[dir], name);
    if (own) return own;
    if (dir !== ".") {
      const root = declared(importers["."], name);
      if (root) return root;
    }
    for (const imp of Object.values(importers)) {
      const v = declared(imp, name);
      if (v) return v;
    }
    return undefined;
  };

  return {
    ecosystem: "npm",
    kind: "pnpm-lock.yaml",
    versions(name, importerDir) {
      const v = raw(name, importerDir);
      if (!v || /^(?:link|file|workspace):/.test(v)) return undefined;
      const bare = stripPnpmSuffix(v);
      // pnpm writes aliased or non-registry entries as "/name@1.0.0" or "name@1.0.0"; keep plain versions only.
      return /^\d/.test(bare) ? bare : undefined;
    },
    resolvedHost(name, importerDir) {
      const v = raw(name, importerDir);
      if (!v) return undefined;
      const bare = stripPnpmSuffix(v);
      for (const key of [`/${name}@${bare}`, `${name}@${bare}`, `/${name}/${bare}`, `${name}@${v}`, `/${name}@${v}`]) {
        const p = packages[key];
        if (isRecord(p) && isRecord(p.resolution)) return hostOf(str(p.resolution.tarball));
      }
      return undefined;
    },
  };
}

function splitDescriptor(d: string): { name: string; range: string } | undefined {
  const at = d.indexOf("@", d.startsWith("@") ? 1 : 0);
  if (at <= 0) return undefined;
  return { name: d.slice(0, at), range: d.slice(at + 1) };
}

/** yarn.lock, classic (v1) and Berry (v2 and later). */
export function parseYarnLock(text: string): Lockfile {
  interface YarnEntry {
    version?: string;
    resolved?: string;
    ranges: string[];
    nonRegistry: boolean;
  }
  const byName = new Map<string, YarnEntry[]>();
  let current: YarnEntry | undefined;
  try {
    for (const line of text.split(/\r?\n/)) {
      if (line === "" || line.startsWith("#")) continue;
      if (!/^\s/.test(line)) {
        current = undefined;
        const header = line.replace(/:\s*$/, "");
        if (header.startsWith("__metadata")) continue;
        const entry: YarnEntry = { ranges: [], nonRegistry: false };
        for (const part of header.split(/,\s*/)) {
          const d = splitDescriptor(part.trim().replace(/^"|"$/g, ""));
          if (!d) continue;
          let range = d.range;
          if (range.startsWith("npm:")) range = range.slice(4);
          else if (/^(?:workspace|portal|link|file|patch|git|github|https?|exec):/.test(range)) entry.nonRegistry = true;
          entry.ranges.push(range);
          const list = byName.get(d.name) ?? [];
          if (!list.includes(entry)) list.push(entry);
          byName.set(d.name, list);
        }
        current = entry;
        continue;
      }
      if (!current) continue;
      const m = /^\s+(version|resolved|resolution):?\s+"?([^"]*)"?\s*$/.exec(line);
      if (!m) continue;
      if (m[1] === "version") current.version = m[2];
      else if (m[1] === "resolved") current.resolved = m[2];
      else if (m[1] === "resolution" && m[2] && !/@npm:/.test(m[2])) current.nonRegistry = true;
    }
  } catch {
    return EMPTY("npm", "yarn.lock");
  }

  const pick = (name: string, range?: string): YarnEntry | undefined => {
    const list = (byName.get(name) ?? []).filter((e) => !e.nonRegistry && e.version);
    if (list.length === 0) return undefined;
    if (range !== undefined) {
      const wanted = range.replace(/^npm:/, "");
      const hit = list.find((e) => e.ranges.includes(wanted));
      if (hit) return hit;
    }
    return list.reduce((best, e) => (compareLoose(e.version ?? "", best.version ?? "") > 0 ? e : best));
  };

  return {
    ecosystem: "npm",
    kind: "yarn.lock",
    versions: (name, _dir, range) => pick(name, range)?.version,
    resolvedHost: (name) => hostOf(pick(name)?.resolved),
  };
}

/** Numeric-aware comparison good enough to pick the highest locked version. */
function compareLoose(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** bun.lock (the text format). */
export function parseBunLock(text: string): Lockfile {
  let doc: unknown;
  try {
    const tree = parseTree(text, [], { allowTrailingComma: true });
    doc = tree ? getNodeValue(tree) : undefined;
  } catch {
    return EMPTY("npm", "bun.lock");
  }
  if (!isRecord(doc) || !isRecord(doc.packages)) return EMPTY("npm", "bun.lock");
  const packages = doc.packages;
  const entry = (name: string, importerDir?: string): unknown[] | undefined => {
    const dir = normDir(importerDir);
    // Nested entries are keyed "<workspace package>/<name>"; the hoisted one is "<name>".
    const candidates = dir ? [`${dir.split("/").pop() ?? ""}/${name}`, name] : [name];
    for (const k of candidates) {
      const e = packages[k];
      if (Array.isArray(e)) return e;
    }
    return undefined;
  };
  return {
    ecosystem: "npm",
    kind: "bun.lock",
    versions(name, importerDir) {
      const e = entry(name, importerDir);
      const id = str(e?.[0]);
      if (!id) return undefined;
      const d = splitDescriptor(id);
      if (!d || !/^\d/.test(d.range)) return undefined;
      return d.range;
    },
    resolvedHost(name, importerDir) {
      const e = entry(name, importerDir);
      return hostOf(str(e?.[1]));
    },
  };
}

interface PyLocked {
  version?: string;
  host?: string;
}

function pyLockfile(kind: string, map: Map<string, PyLocked>): Lockfile {
  return {
    ecosystem: "pypi",
    kind,
    versions: (name) => map.get(normalizePypiName(name))?.version,
    resolvedHost: (name) => map.get(normalizePypiName(name))?.host,
  };
}

/** poetry.lock and pdm.lock: [[package]] tables with name, version and an optional source. */
export function parsePoetryLock(text: string, kind = "poetry.lock"): Lockfile {
  const map = new Map<string, PyLocked>();
  try {
    const doc = parseToml(text) as { package?: unknown };
    if (Array.isArray(doc.package)) {
      for (const p of doc.package) {
        if (!isRecord(p)) continue;
        const name = str(p.name);
        if (!name) continue;
        const source = isRecord(p.source) ? p.source : undefined;
        const type = str(source?.type);
        const locked: PyLocked = {};
        if (type === undefined || type === "legacy" || type === "pypi") {
          const v = str(p.version);
          if (v) locked.version = v;
        }
        if (type === "legacy") {
          const h = hostOf(str(source?.url));
          if (h) locked.host = h;
        } else if (type !== undefined && type !== "pypi") {
          locked.host = "local";
        }
        map.set(normalizePypiName(name), locked);
      }
    }
  } catch {
    return EMPTY("pypi", kind);
  }
  return pyLockfile(kind, map);
}

/** uv.lock: [[package]] with `source = { registry = "..." }` (or git, path, editable, virtual). */
export function parseUvLock(text: string): Lockfile {
  const map = new Map<string, PyLocked>();
  try {
    const doc = parseToml(text) as { package?: unknown };
    if (Array.isArray(doc.package)) {
      for (const p of doc.package) {
        if (!isRecord(p)) continue;
        const name = str(p.name);
        if (!name) continue;
        const source = isRecord(p.source) ? p.source : {};
        const locked: PyLocked = {};
        if (typeof source.registry === "string") {
          const v = str(p.version);
          if (v) locked.version = v;
          const h = hostOf(source.registry);
          if (h) locked.host = h;
        } else if (Object.keys(source).length > 0) {
          locked.host = "local";
        }
        map.set(normalizePypiName(name), locked);
      }
    }
  } catch {
    return EMPTY("pypi", "uv.lock");
  }
  return pyLockfile("uv.lock", map);
}

/** Pipfile.lock: "default" and "develop" maps with "==x" versions and an index name. */
export function parsePipfileLock(text: string): Lockfile {
  const map = new Map<string, PyLocked>();
  try {
    const doc = JSON.parse(text) as unknown;
    if (!isRecord(doc)) return EMPTY("pypi", "Pipfile.lock");
    const meta = isRecord(doc._meta) ? doc._meta : {};
    const sources = Array.isArray(meta.sources) ? meta.sources.filter(isRecord) : [];
    const hostByIndex = new Map<string, string | undefined>();
    for (const s of sources) {
      const n = str(s.name);
      if (n) hostByIndex.set(n, hostOf(str(s.url)));
    }
    const defaultHost = sources[0] ? hostOf(str(sources[0].url)) : undefined;
    for (const section of ["default", "develop"]) {
      const deps = doc[section];
      if (!isRecord(deps)) continue;
      for (const [name, e] of Object.entries(deps)) {
        if (!isRecord(e)) continue;
        const locked: PyLocked = {};
        const v = str(e.version);
        if (v) locked.version = v.replace(/^===?/, "");
        if (e.git || e.path || e.file || e.editable) locked.host = "local";
        else {
          const idx = str(e.index);
          const h = idx !== undefined ? hostByIndex.get(idx) : defaultHost;
          if (h) locked.host = h;
        }
        if (!map.has(normalizePypiName(name))) map.set(normalizePypiName(name), locked);
      }
    }
  } catch {
    return EMPTY("pypi", "Pipfile.lock");
  }
  return pyLockfile("Pipfile.lock", map);
}

/** Picks the reader by file name; undefined for files that are not lockfiles. */
export function parseLockfile(fileName: string, text: string): Lockfile | undefined {
  switch (fileName) {
    case "package-lock.json":
    case "npm-shrinkwrap.json":
      return parseNpmLock(text, fileName);
    case "pnpm-lock.yaml":
      return parsePnpmLock(text);
    case "yarn.lock":
      return parseYarnLock(text);
    case "bun.lock":
      return parseBunLock(text);
    case "poetry.lock":
      return parsePoetryLock(text, "poetry.lock");
    case "pdm.lock":
      return parsePoetryLock(text, "pdm.lock");
    case "uv.lock":
      return parseUvLock(text);
    case "Pipfile.lock":
      return parsePipfileLock(text);
    default:
      return undefined;
  }
}
