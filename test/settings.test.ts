import { describe, expect, it } from "vitest";
import {
  goEnvFilePath,
  goPrivateFrom,
  parseGoEnvFile,
  normalizeBaseUrl,
  normalizeHost,
  readSettings,
  toCoreOptions,
  toPresentationSettings,
  type ConfigLike,
} from "../src/settings";
import { pythonConfigPaths } from "../src/core/privacy/localConfig";

interface Levels {
  defaultValue?: unknown;
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

/** A ConfigLike over per-key levels; get() returns the most specific level, like VS Code. */
function config(values: Record<string, unknown | Levels> = {}): ConfigLike {
  const levels = (key: string): Levels | undefined => {
    const v = values[key];
    if (v === undefined) return undefined;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Levels;
    return { globalValue: v };
  };
  return {
    get<T>(key: string): T | undefined {
      const l = levels(key);
      if (!l) return undefined;
      return (l.workspaceFolderValue ?? l.workspaceValue ?? l.globalValue ?? l.defaultValue) as T | undefined;
    },
    inspect<T>(key: string) {
      return levels(key) as { defaultValue?: T; globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined;
    },
  };
}

describe("readSettings", () => {
  it("has the documented defaults", () => {
    const s = readSettings(config());
    expect(s).toEqual({
      networkEnabled: true,
      apiBaseUrl: "https://api.semverity.dev",
      siteBaseUrl: "https://semverity.dev",
      ecosystems: { npm: true, pypi: true, golang: true },
      decorationsEnabled: true,
      showUnscored: true,
      hoversEnabled: true,
      diagnosticsEnabled: true,
      scoreBasis: "headline",
      warningBelow: 65,
      errorBelow: 0,
      gates: [
        "high_vuln_with_fix",
        "unfixed_high_vuln",
        "yanked",
        "typosquat",
        "install_script_untrusted",
        "dependency_confusion",
        "denied_package",
        "license_denied",
      ],
      excludePatterns: [],
      excludeNpmrcScopes: true,
      trustedRegistryHosts: [],
      lookupUndeclaredImports: true,
      cacheTtlHours: 24,
      negativeTtlMinutes: 60,
      maxRequestsPerMinute: 60,
      editDebounceMs: 600,
      statusBarEnabled: true,
    });
  });

  it("reads values and clamps numbers", () => {
    const s = readSettings(
      config({
        "network.enabled": false,
        "ecosystems.pypi": false,
        "diagnostics.scoreBasis": "own",
        "diagnostics.warningBelow": 150,
        "diagnostics.errorBelow": -3,
        "diagnostics.gates": ["yanked", 3, " "],
        "network.maxRequestsPerMinute": 500,
        "cache.ttlHours": 0,
        "editDebounceMs": "fast",
      }),
    );
    expect(s.networkEnabled).toBe(false);
    expect(s.ecosystems).toEqual({ npm: true, pypi: false, golang: true });
    expect(s.scoreBasis).toBe("own");
    expect(s.warningBelow).toBe(100);
    expect(s.errorBelow).toBe(0);
    expect(s.gates).toEqual(["yanked"]);
    expect(s.maxRequestsPerMinute).toBe(60);
    expect(s.cacheTtlHours).toBe(1);
    expect(s.editDebounceMs).toBe(600);
  });

  it("lets any level turn lookups and ecosystems off, but no level turn them back on", () => {
    const s = readSettings(
      config({
        "network.enabled": { defaultValue: true, globalValue: false, workspaceValue: true },
        "ecosystems.golang": { defaultValue: true, globalValue: false, workspaceFolderValue: true },
        "ecosystems.npm": { defaultValue: true, workspaceValue: false },
        "ecosystems.pypi": { defaultValue: true, globalValue: true },
      }),
    );
    expect(s.networkEnabled).toBe(false);
    expect(s.ecosystems).toEqual({ npm: false, pypi: true, golang: false });
    expect(readSettings(config({ "network.enabled": { defaultValue: true } })).networkEnabled).toBe(true);
  });

  it("unions exclude patterns across levels", () => {
    const s = readSettings(
      config({
        "privacy.excludePatterns": {
          defaultValue: [],
          globalValue: ["@acme/*", "acme-*"],
          workspaceValue: ["golang:git.example.com/*", "@acme/*"],
          workspaceFolderValue: ["pypi:internal-*"],
        },
      }),
    );
    expect(s.excludePatterns).toEqual(["@acme/*", "acme-*", "golang:git.example.com/*", "pypi:internal-*"]);
  });

  it("falls back to the default URLs for invalid or non-http values", () => {
    expect(readSettings(config({ "api.baseUrl": "ftp://x" })).apiBaseUrl).toBe("https://api.semverity.dev");
    expect(readSettings(config({ "api.baseUrl": "not a url" })).apiBaseUrl).toBe("https://api.semverity.dev");
    expect(readSettings(config({ "api.baseUrl": "https://user:pw@api.example.test" })).apiBaseUrl).toBe("https://api.semverity.dev");
    expect(readSettings(config({ "api.baseUrl": "http://127.0.0.1:8080/" })).apiBaseUrl).toBe("http://127.0.0.1:8080");
    expect(normalizeBaseUrl("https://api.example.test/base/?q=1#h", "d")).toBe("https://api.example.test/base");
  });

  it("normalises trusted hosts", () => {
    expect(readSettings(config({ "privacy.trustedRegistryHosts": ["Mirror.Example.TEST", "https://npm.example.test:8443/repo/", "mirror.example.test"] })).trustedRegistryHosts).toEqual([
      "mirror.example.test",
      "npm.example.test:8443",
    ]);
    expect(normalizeHost("  ")).toBeUndefined();
  });
});

describe("toCoreOptions", () => {
  it("derives the core options", () => {
    const s = readSettings(config({ "cache.ttlHours": 12, "cache.negativeTtlMinutes": 30, "privacy.excludePatterns": ["@acme/*"] }));
    const o = toCoreOptions(s, "0.1.0", { GOPRIVATE: "git.example.com/*", GONOPROXY: "", GONOSUMDB: " corp.example.test " });
    expect(o).toEqual({
      apiBaseUrl: "https://api.semverity.dev",
      userAgent: "semverity-vscode/0.1.0",
      ecosystems: { npm: true, pypi: true, golang: true },
      networkEnabled: true,
      excludePatterns: ["@acme/*"],
      excludeNpmrcScopes: true,
      trustedRegistryHosts: [],
      lookupUndeclaredImports: true,
      cacheTtlMs: 12 * 3_600_000,
      negativeTtlMs: 30 * 60_000,
      maxRequestsPerMinute: 60,
      goPrivate: "git.example.com/*,corp.example.test",
      npmEnvRegistries: [],
      pythonIndexes: [],
    });
  });

  it("collects npm registries and Python indexes from the environment and the pip and uv files", () => {
    const s = readSettings(config({}));
    const env = {
      NPM_CONFIG_REGISTRY: "https://npm.corp.example/",
      PIP_EXTRA_INDEX_URL: "https://pypi.acme.example/simple https://other.example/simple",
      UV_INDEX: "internal=https://uv.acme.example/simple",
    };
    const pip = "[global]\nindex-url = https://pip.acme.example/simple\nextra-index-url =\n    https://a.example/simple\n    https://b.example/simple\ntimeout = 60\n";
    const uv = 'index-url = "https://uvc.example/simple"\n[[index]]\nname = "x"\nurl = "https://idx.example/simple"\n[[index]]\nname = "y"\nurl = "https://explicit.example/simple"\nexplicit = true\n';
    const o = toCoreOptions(s, "0.1.0", env, undefined, [
      { kind: "pip", text: pip },
      { kind: "uv", text: uv },
    ]);
    expect(o.npmEnvRegistries).toEqual([{ host: "npm.corp.example", source: "NPM_CONFIG_REGISTRY" }]);
    expect(o.pythonIndexes).toEqual([
      { url: "https://pypi.acme.example/simple", source: "PIP_EXTRA_INDEX_URL" },
      { url: "https://other.example/simple", source: "PIP_EXTRA_INDEX_URL" },
      { url: "https://uv.acme.example/simple", source: "UV_INDEX" },
      { url: "https://pip.acme.example/simple", source: "the pip configuration" },
      { url: "https://a.example/simple", source: "the pip configuration" },
      { url: "https://b.example/simple", source: "the pip configuration" },
      { url: "https://uvc.example/simple", source: "the uv configuration" },
      { url: "https://idx.example/simple", source: "the uv configuration" },
    ]);
  });

  it("knows where pip and uv keep their configuration", () => {
    expect(pythonConfigPaths({}, "linux", "/home/u").map((p) => p.path)).toEqual([
      "/home/u/.config/pip/pip.conf",
      "/home/u/.config/uv/uv.toml",
      "/home/u/.pip/pip.conf",
      "/etc/xdg/pip/pip.conf",
      "/etc/pip.conf",
      "/etc/uv/uv.toml",
    ]);
    expect(pythonConfigPaths({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", "C:\\Users\\u").map((p) => p.path)).toEqual([
      "C:\\Users\\u\\AppData\\Roaming\\pip\\pip.ini",
      "C:\\Users\\u\\AppData\\Roaming\\uv\\uv.toml",
      "C:\\Users\\u\\pip\\pip.ini",
    ]);
  });

  it("joins the Go privacy variables", () => {
    expect(goPrivateFrom({})).toBe("");
    expect(goPrivateFrom({ GOPRIVATE: "a", GONOPROXY: "b", GONOSUMDB: "c" })).toBe("a,b,c");
    expect(goPrivateFrom({ GOPRIVATE: "a,b", GONOPROXY: "b" })).toBe("a,b");
  });

  it("adds the values `go env -w` wrote to the Go env file", () => {
    const file = ["# written by go env -w", "GOPROXY=https://proxy.golang.org,direct", "GOPRIVATE=git.example.com/*,corp.example.test", "GONOSUMDB = gitlab.example.test ", "bogus"].join("\n");
    expect(parseGoEnvFile(file)).toEqual({ GOPRIVATE: "git.example.com/*,corp.example.test", GONOSUMDB: "gitlab.example.test" });
    expect(goPrivateFrom({ GOPRIVATE: "corp.example.test" }, file)).toBe("corp.example.test,git.example.com/*,gitlab.example.test");
    const s = readSettings(config({}));
    expect(toCoreOptions(s, "0.1.0", {}, "GOPRIVATE=git.example.com\r\n").goPrivate).toBe("git.example.com");
  });

  it("finds the Go env file where Go keeps it", () => {
    expect(goEnvFilePath({}, "linux", "/home/u")).toBe("/home/u/.config/go/env");
    expect(goEnvFilePath({ XDG_CONFIG_HOME: "/cfg" }, "linux", "/home/u")).toBe("/cfg/go/env");
    expect(goEnvFilePath({}, "darwin", "/Users/u")).toBe("/Users/u/Library/Application Support/go/env");
    expect(goEnvFilePath({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", "C:\\Users\\u")).toBe("C:\\Users\\u\\AppData\\Roaming\\go\\env");
    expect(goEnvFilePath({ GOENV: "/etc/goenv" }, "linux", "/home/u")).toBe("/etc/goenv");
    expect(goEnvFilePath({ GOENV: "off" }, "linux", "/home/u")).toBeUndefined();
    expect(goEnvFilePath({}, "linux", undefined)).toBeUndefined();
  });
});

describe("toPresentationSettings", () => {
  it("maps the surface settings", () => {
    const p = toPresentationSettings(readSettings(config({ "decorations.enabled": false, "site.baseUrl": "https://example.test/" })));
    expect(p).toMatchObject({ decorations: false, hovers: true, diagnostics: true, siteBaseUrl: "https://example.test", warningBelow: 65 });
  });
});
