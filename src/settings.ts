// Reads the `semverity.*` settings into plain values (docs/DESIGN.md 9.2) and
// derives the core and presentation options from them. No vscode import: the
// adapter passes workspace.getConfiguration("semverity") as a ConfigLike.

import { npmRegistriesFromEnv, pythonIndexesFrom } from "./core/privacy/localConfig";
import type { CoreOptions, Ecosystem } from "./core/types";
import type { ScoreBasis } from "./presentation/grades";
import { DEFAULT_WARNING_GATES, type PresentationSettings } from "./presentation/settings";

export interface ConfigLike {
  get<T>(key: string): T | undefined;
  inspect<T>(key: string):
    | { defaultValue?: T; globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T }
    | undefined;
}

export interface Settings {
  networkEnabled: boolean;
  apiBaseUrl: string;
  siteBaseUrl: string;
  ecosystems: Record<Ecosystem, boolean>;
  decorationsEnabled: boolean;
  showUnscored: boolean;
  hoversEnabled: boolean;
  diagnosticsEnabled: boolean;
  scoreBasis: ScoreBasis;
  warningBelow: number;
  errorBelow: number;
  gates: string[];
  excludePatterns: string[];
  excludeNpmrcScopes: boolean;
  trustedRegistryHosts: string[];
  lookupUndeclaredImports: boolean;
  cacheTtlHours: number;
  negativeTtlMinutes: number;
  maxRequestsPerMinute: number;
  editDebounceMs: number;
  statusBarEnabled: boolean;
}

export const DEFAULT_API_BASE_URL = "https://api.semverity.dev";
export const DEFAULT_SITE_BASE_URL = "https://semverity.dev";

function bool(config: ConfigLike, key: string, fallback: boolean): boolean {
  const v = config.get<unknown>(key);
  return typeof v === "boolean" ? v : fallback;
}

/**
 * A switch that any level can turn off but only the combination of all levels
 * keeps on: false when the user, workspace or folder value is false. A
 * workspace can narrow what is sent, never widen what the user turned off.
 */
export function stickyOff(config: ConfigLike, key: string, fallback: boolean): boolean {
  const info = config.inspect<unknown>(key);
  if (info) {
    const levels = [info.globalValue, info.workspaceValue, info.workspaceFolderValue];
    if (levels.some((v) => v === false)) return false;
    if (levels.some((v) => v === true)) return true;
    return typeof info.defaultValue === "boolean" ? info.defaultValue : fallback;
  }
  return bool(config, key, fallback);
}

function num(config: ConfigLike, key: string, fallback: number, min: number, max: number): number {
  const v = config.get<unknown>(key);
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter((x) => x.length > 0);
}

/** An http(s) URL without a trailing slash, or the fallback when the value is not one. */
export function normalizeBaseUrl(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  try {
    const u = new URL(value.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return fallback;
    if (u.username || u.password) return fallback;
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

/** "https://Mirror.Example.com:8443/npm/" -> "mirror.example.com:8443"; plain hosts are lowercased. */
export function normalizeHost(value: string): string | undefined {
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(v)) {
    try {
      return new URL(v).host || undefined;
    } catch {
      return undefined;
    }
  }
  return v.replace(/\/.*$/, "") || undefined;
}

/**
 * The exclude patterns of every level, unioned: a workspace can add exclusions
 * but never remove the user's.
 */
export function unionExcludePatterns(config: ConfigLike): string[] {
  const info = config.inspect<string[]>("privacy.excludePatterns");
  const all = [
    ...strings(info?.defaultValue),
    ...strings(info?.globalValue),
    ...strings(info?.workspaceValue),
    ...strings(info?.workspaceFolderValue),
  ];
  if (!info) all.push(...strings(config.get<string[]>("privacy.excludePatterns")));
  return [...new Set(all)];
}

export function readSettings(config: ConfigLike): Settings {
  const basis = config.get<unknown>("diagnostics.scoreBasis");
  const gates = config.get<unknown>("diagnostics.gates");
  return {
    networkEnabled: stickyOff(config, "network.enabled", true),
    apiBaseUrl: normalizeBaseUrl(config.get("api.baseUrl"), DEFAULT_API_BASE_URL),
    siteBaseUrl: normalizeBaseUrl(config.get("site.baseUrl"), DEFAULT_SITE_BASE_URL),
    ecosystems: {
      npm: stickyOff(config, "ecosystems.npm", true),
      pypi: stickyOff(config, "ecosystems.pypi", true),
      golang: stickyOff(config, "ecosystems.golang", true),
    },
    decorationsEnabled: bool(config, "decorations.enabled", true),
    showUnscored: bool(config, "decorations.showUnscored", true),
    hoversEnabled: bool(config, "hovers.enabled", true),
    diagnosticsEnabled: bool(config, "diagnostics.enabled", true),
    scoreBasis: basis === "own" ? "own" : "headline",
    warningBelow: num(config, "diagnostics.warningBelow", 65, 0, 100),
    errorBelow: num(config, "diagnostics.errorBelow", 0, 0, 100),
    gates: Array.isArray(gates) ? strings(gates) : [...DEFAULT_WARNING_GATES],
    excludePatterns: unionExcludePatterns(config),
    excludeNpmrcScopes: bool(config, "privacy.excludeNpmrcScopes", true),
    trustedRegistryHosts: [
      ...new Set(
        strings(config.get("privacy.trustedRegistryHosts"))
          .map(normalizeHost)
          .filter((h): h is string => h !== undefined),
      ),
    ],
    lookupUndeclaredImports: bool(config, "privacy.lookupUndeclaredImports", true),
    cacheTtlHours: num(config, "cache.ttlHours", 24, 1, 168),
    negativeTtlMinutes: num(config, "cache.negativeTtlMinutes", 60, 5, 1440),
    maxRequestsPerMinute: Math.round(num(config, "network.maxRequestsPerMinute", 60, 1, 60)),
    editDebounceMs: num(config, "editDebounceMs", 600, 100, 5000),
    statusBarEnabled: bool(config, "statusBar.enabled", true),
  };
}

const GO_PRIVACY_VARS = ["GOPRIVATE", "GONOPROXY", "GONOSUMDB"] as const;

/**
 * The location of the file `go env -w` writes, following Go's own rules: $GOENV
 * when set ("off" disables it), else os.UserConfigDir()/go/env. undefined when
 * no location can be derived.
 */
export function goEnvFilePath(
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
  home: string | undefined,
): string | undefined {
  const explicit = env.GOENV?.trim();
  if (explicit === "off") return undefined;
  if (explicit) return explicit;
  const sep = platform === "win32" ? "\\" : "/";
  let configDir: string | undefined;
  if (platform === "win32") configDir = env.APPDATA || undefined;
  else if (platform === "darwin") configDir = home ? `${home}/Library/Application Support` : undefined;
  else if (platform === "plan9") configDir = home ? `${home}/lib` : undefined;
  else configDir = env.XDG_CONFIG_HOME || (home ? `${home}/.config` : undefined);
  return configDir ? `${configDir}${sep}go${sep}env` : undefined;
}

/** Reads GOPRIVATE, GONOPROXY and GONOSUMDB from the text of a Go env file (KEY=VALUE lines). */
export function parseGoEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if ((GO_PRIVACY_VARS as readonly string[]).includes(key)) out[key] = line.slice(eq + 1).trim();
  }
  return out;
}

/**
 * GOPRIVATE, GONOPROXY and GONOSUMDB from the extension host environment and
 * from the Go env file, comma-joined (empty entries dropped). Both sources are
 * kept: VS Code started from a desktop launcher often lacks the shell's
 * variables, and the union only ever excludes more.
 */
export function goPrivateFrom(env: Readonly<Record<string, string | undefined>>, goEnvFileText?: string): string {
  const file = goEnvFileText !== undefined ? parseGoEnvFile(goEnvFileText) : {};
  const values = [...GO_PRIVACY_VARS.map((k) => env[k]?.trim() ?? ""), ...GO_PRIVACY_VARS.map((k) => file[k] ?? "")];
  return [...new Set(values.flatMap((v) => v.split(",")).map((v) => v.trim()).filter((v) => v.length > 0))].join(",");
}

export function toCoreOptions(
  s: Settings,
  extensionVersion: string,
  env: Readonly<Record<string, string | undefined>>,
  goEnvFileText?: string,
  /** The user and site pip.conf and uv.toml contents, read by the adapter. */
  pythonConfigs: readonly { kind: "pip" | "uv"; text: string }[] = [],
): CoreOptions {
  return {
    apiBaseUrl: s.apiBaseUrl,
    userAgent: `semverity-vscode/${extensionVersion}`,
    ecosystems: { ...s.ecosystems },
    networkEnabled: s.networkEnabled,
    excludePatterns: [...s.excludePatterns],
    excludeNpmrcScopes: s.excludeNpmrcScopes,
    trustedRegistryHosts: [...s.trustedRegistryHosts],
    lookupUndeclaredImports: s.lookupUndeclaredImports,
    cacheTtlMs: s.cacheTtlHours * 3_600_000,
    negativeTtlMs: s.negativeTtlMinutes * 60_000,
    maxRequestsPerMinute: s.maxRequestsPerMinute,
    goPrivate: goPrivateFrom(env, goEnvFileText),
    npmEnvRegistries: npmRegistriesFromEnv(env),
    pythonIndexes: pythonIndexesFrom(env, pythonConfigs),
  };
}

export function toPresentationSettings(s: Settings): PresentationSettings {
  return {
    decorations: s.decorationsEnabled,
    showUnscored: s.showUnscored,
    hovers: s.hoversEnabled,
    diagnostics: s.diagnosticsEnabled,
    scoreBasis: s.scoreBasis,
    warningBelow: s.warningBelow,
    errorBelow: s.errorBelow,
    gates: [...s.gates],
    siteBaseUrl: s.siteBaseUrl,
  };
}
