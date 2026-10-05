// Registry and package index configuration that lives outside the workspace:
// environment variables and the user's pip and uv configuration files. Only
// URLs are read (credentials inside a URL never leave this module: the filter
// reduces each URL to its host), and nothing here is ever sent.

import { parse as parseToml } from "smol-toml";
import type { RegistryBinding } from "../parsers/npmRegistries";
import { hostOf } from "../parsers/lockfiles";
import type { PythonIndex } from "./filter";

type Env = Readonly<Record<string, string | undefined>>;

/** Environment variables that set the default npm registry for npm, pnpm, Yarn and Bun. */
const NPM_REGISTRY_VARS = ["NPM_CONFIG_REGISTRY", "npm_config_registry", "YARN_NPM_REGISTRY_SERVER", "YARN_REGISTRY", "BUN_CONFIG_REGISTRY"];

/** Variables that name Python package indexes (pip and uv); list values are whitespace separated. */
const PYTHON_INDEX_VARS = [
  "PIP_INDEX_URL",
  "PIP_EXTRA_INDEX_URL",
  "PIP_FIND_LINKS",
  "UV_INDEX_URL",
  "UV_EXTRA_INDEX_URL",
  "UV_DEFAULT_INDEX",
  "UV_INDEX",
  "UV_FIND_LINKS",
];

export function npmRegistriesFromEnv(env: Env): RegistryBinding[] {
  const out: RegistryBinding[] = [];
  for (const name of NPM_REGISTRY_VARS) {
    const value = env[name]?.trim();
    if (value) out.push({ host: hostOf(value) ?? "unknown", source: name });
  }
  return out;
}

export function pythonIndexesFromEnv(env: Env): PythonIndex[] {
  const out: PythonIndex[] = [];
  for (const name of PYTHON_INDEX_VARS) {
    for (const raw of (env[name] ?? "").split(/\s+/)) {
      // UV_INDEX entries may be named: "internal=https://...".
      const url = raw.replace(/^[A-Za-z0-9_.-]+=(?=[a-z][a-z0-9+.-]*:)/i, "").trim();
      if (url) out.push({ url, source: name });
    }
  }
  return out;
}

const PIP_KEYS = new Set(["index-url", "extra-index-url", "find-links", "index_url", "extra_index_url", "find_links"]);

/** index-url, extra-index-url and find-links values of a pip.conf or pip.ini, in any section. */
export function parsePipConfig(text: string): string[] {
  const urls: string[] = [];
  let current: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s[#;].*$/, "");
    if (/^\s*[#;]/.test(line) || line.trim() === "") {
      if (line.trim() === "") current = undefined;
      continue;
    }
    if (/^\s+\S/.test(line) && current !== undefined) {
      // A continuation line of a multi-value key.
      urls.push(...line.trim().split(/\s+/));
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = undefined;
      continue;
    }
    const m = /^\s*([A-Za-z_-]+)\s*[=:]\s*(.*)$/.exec(line);
    if (!m?.[1]) {
      current = undefined;
      continue;
    }
    const key = m[1].toLowerCase();
    if (!PIP_KEYS.has(key)) {
      current = undefined;
      continue;
    }
    current = key;
    urls.push(...(m[2] ?? "").trim().split(/\s+/).filter(Boolean));
  }
  return urls;
}

function isTable(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Index URLs of a uv.toml: `index`, `index-url`, `extra-index-url`, `find-links` and the same under `[pip]`. */
export function parseUvConfig(text: string): string[] {
  let doc: unknown;
  try {
    doc = parseToml(text);
  } catch {
    return [];
  }
  if (!isTable(doc)) return [];
  const urls: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v.trim() !== "") urls.push(v.trim());
    else if (Array.isArray(v)) for (const x of v) add(x);
  };
  for (const t of [doc, doc["pip"]]) {
    if (!isTable(t)) continue;
    add(t["index-url"]);
    add(t["extra-index-url"]);
    add(t["find-links"]);
    const index = t["index"];
    if (Array.isArray(index)) for (const i of index) if (isTable(i) && i["explicit"] !== true) add(i["url"]);
  }
  return urls;
}

/** Where pip and uv read user and site configuration on this platform, most specific first. */
export function pythonConfigPaths(env: Env, platform: string, home: string | undefined): { path: string; kind: "pip" | "uv" }[] {
  const out: { path: string; kind: "pip" | "uv" }[] = [];
  const sep = platform === "win32" ? "\\" : "/";
  const j = (...parts: string[]) => parts.join(sep);
  if (env.PIP_CONFIG_FILE && env.PIP_CONFIG_FILE !== "os.devnull") out.push({ path: env.PIP_CONFIG_FILE, kind: "pip" });
  if (env.UV_CONFIG_FILE) out.push({ path: env.UV_CONFIG_FILE, kind: "uv" });
  if (platform === "win32") {
    if (env.APPDATA) {
      out.push({ path: j(env.APPDATA, "pip", "pip.ini"), kind: "pip" });
      out.push({ path: j(env.APPDATA, "uv", "uv.toml"), kind: "uv" });
    }
    if (home) out.push({ path: j(home, "pip", "pip.ini"), kind: "pip" });
    if (env.PROGRAMDATA) {
      out.push({ path: j(env.PROGRAMDATA, "pip", "pip.ini"), kind: "pip" });
      out.push({ path: j(env.PROGRAMDATA, "uv", "uv.toml"), kind: "uv" });
    }
    return out;
  }
  const xdg = env.XDG_CONFIG_HOME || (home ? j(home, ".config") : undefined);
  if (xdg) {
    out.push({ path: j(xdg, "pip", "pip.conf"), kind: "pip" });
    out.push({ path: j(xdg, "uv", "uv.toml"), kind: "uv" });
  }
  if (home) {
    out.push({ path: j(home, ".pip", "pip.conf"), kind: "pip" });
    if (platform === "darwin") out.push({ path: j(home, "Library", "Application Support", "pip", "pip.conf"), kind: "pip" });
  }
  for (const dir of (env.XDG_CONFIG_DIRS || "/etc/xdg").split(":").filter(Boolean)) out.push({ path: j(dir, "pip", "pip.conf"), kind: "pip" });
  out.push({ path: "/etc/pip.conf", kind: "pip" });
  out.push({ path: j("/etc", "uv", "uv.toml"), kind: "uv" });
  return out;
}

/** The Python indexes of the environment and of the given configuration file contents. */
export function pythonIndexesFrom(env: Env, configs: readonly { kind: "pip" | "uv"; text: string }[]): PythonIndex[] {
  const out = pythonIndexesFromEnv(env);
  for (const c of configs) {
    const urls = c.kind === "pip" ? parsePipConfig(c.text) : parseUvConfig(c.text);
    const source = c.kind === "pip" ? "the pip configuration" : "the uv configuration";
    for (const url of urls) out.push({ url, source });
  }
  return out;
}
