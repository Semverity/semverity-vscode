// The workspace index: every manifest, lockfile, .npmrc scope binding,
// tsconfig alias and Python module name in the workspace, kept in memory so
// that analysis stays synchronous and network free. Built from the FileSource
// port; nothing here is ever sent anywhere.

import { Emitter } from "../emitter";
import type { Clock, FileSource, Logger } from "../ports";
import { normalizePypiName } from "../api/purl";
import type { Ecosystem, ParsedManifest } from "../types";
import { ancestors, basename, dirname, isUnder, join, relative } from "../uri";
import { parseGoMod, type GoModManifest } from "../parsers/goMod";
import { NPM_LOCKFILES, PYPI_LOCKFILES, parseLockfile, type Lockfile } from "../parsers/lockfiles";
import {
  emptyRegistryConfig,
  mergeRegistryConfig,
  NPM_REGISTRY_FILES,
  parseNpmRegistryFile,
  type NpmRegistryConfig,
} from "../parsers/npmRegistries";
import { parsePackageJson, type PackageJsonManifest } from "../parsers/packageJson";
import { parsePyproject } from "../parsers/pyproject";
import { parseRequirements, type RequirementsManifest } from "../parsers/requirements";
import { parseTsconfigAliases, type TsconfigAliases } from "../parsers/tsconfig";
import type { WorkspaceIndex } from "../index";

export type AnyManifest = PackageJsonManifest | RequirementsManifest | GoModManifest | ParsedManifest;

/** Directories whose contents are never indexed or analysed. */
export const EXCLUDE_GLOB = "**/{node_modules,.git,.hg,.svn,.venv,venv,.env,env,site-packages,__pypackages__,vendor,.tox,.nox,__pycache__,bower_components,.yarn}/**";
const IGNORED_SEGMENTS = new Set(["node_modules", ".venv", "venv", "site-packages", "vendor", "__pypackages__", "bower_components", ".git"]);

const MANIFEST_GLOBS = ["**/package.json", "**/requirements*.txt", "**/pyproject.toml", "**/go.mod"];
const LOCKFILE_GLOB = `**/{${[...NPM_LOCKFILES, ...PYPI_LOCKFILES].join(",")}}`;
const MAX_MANIFESTS = 2000;
const MAX_PY_FILES = 20000;
const MAX_BASEURL_FILES = 3000;
const PY_CHANGE_COALESCE_MS = 300;
const READ_CONCURRENCY = 16;
const JS_EXTENSIONS = /\.(?:d\.ts|tsx?|jsx?|mjs|cjs|mts|cts|json|vue|svelte)$/;

/** True for files inside dependency folders and virtual environments (node_modules, .venv, vendor ...). */
export function isIgnoredUri(uri: string): boolean {
  const path = uri.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
  return path.split("/").some((seg) => IGNORED_SEGMENTS.has(seg));
}

export function manifestKindOf(fileName: string): ParsedManifest["kind"] | undefined {
  if (fileName === "package.json") return "package.json";
  if (/^requirements.*\.txt$/i.test(fileName)) return "requirements";
  if (fileName === "pyproject.toml") return "pyproject";
  if (fileName === "go.mod") return "go.mod";
  return undefined;
}

export function parseManifest(uri: string, text: string, kind: ParsedManifest["kind"]): AnyManifest {
  switch (kind) {
    case "package.json":
      return parsePackageJson(uri, text);
    case "requirements":
      return parseRequirements(uri, text);
    case "pyproject":
      return parsePyproject(uri, text);
    case "go.mod":
      return parseGoMod(uri, text);
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

interface TsconfigInfo {
  aliases: TsconfigAliases;
  baseUrlNames: Set<string>;
  kind: "tsconfig.json" | "jsconfig.json";
}

export class WorkspaceIndexImpl implements WorkspaceIndex {
  private readonly changeEmitter = new Emitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  private manifestsByUri = new Map<string, AnyManifest>();
  private lockfilesByUri = new Map<string, Lockfile>();
  /** Registry configuration by file URI (.npmrc, .yarnrc, .yarnrc.yml, bunfig.toml). */
  private registriesByUri = new Map<string, NpmRegistryConfig>();
  private userRegistries: NpmRegistryConfig = emptyRegistryConfig();
  private tsconfigByUri = new Map<string, TsconfigInfo>();
  private pyModules = new Set<string>();
  /** Directory names between a workspace root and a Python file (namespace packages, src layouts, scripts folders). */
  private pyDirs = new Set<string>();
  private derived: Derived | undefined;
  private isReady = false;
  private building: Promise<void> | undefined;

  /** Pending coalesced change notification for new Python module names. */
  private pyChangeTimer: unknown;

  constructor(
    private readonly files: FileSource,
    private readonly logger: Logger,
    /** When given, change notifications for new Python modules are coalesced (a checkout can create many files at once). */
    private readonly clock?: Clock,
  ) {}

  /** False until the first rebuild finished; analysis before that would miss local names and private scopes. */
  get ready(): boolean {
    return this.isReady;
  }

  rebuild(): Promise<void> {
    if (this.building) return this.building;
    this.building = this.doRebuild().finally(() => {
      this.building = undefined;
    });
    return this.building;
  }

  private async doRebuild(): Promise<void> {
    const started = Date.now();
    const find = async (glob: string, max: number): Promise<string[]> => {
      try {
        return (await this.files.findFiles(glob, EXCLUDE_GLOB, max)).filter((u) => !isIgnoredUri(u));
      } catch {
        return [];
      }
    };
    const [manifestLists, lockUris, npmrcUris, tsUris, pyUris] = await Promise.all([
      Promise.all(MANIFEST_GLOBS.map((g) => find(g, MAX_MANIFESTS))),
      find(LOCKFILE_GLOB, 500),
      find(`**/{${NPM_REGISTRY_FILES.join(",")}}`, 400),
      find("**/{tsconfig,jsconfig}.json", 500),
      find("**/*.py", MAX_PY_FILES),
    ]);

    const manifests = new Map<string, AnyManifest>();
    await mapLimit(manifestLists.flat(), READ_CONCURRENCY, async (uri) => {
      const kind = manifestKindOf(basename(uri));
      const text = kind ? await this.read(uri) : undefined;
      if (kind && text !== undefined) manifests.set(uri, parseManifest(uri, text, kind));
    });
    const lockfiles = new Map<string, Lockfile>();
    await mapLimit(lockUris, 4, async (uri) => {
      const text = await this.read(uri);
      const lock = text !== undefined ? parseLockfile(basename(uri), text) : undefined;
      if (lock) lockfiles.set(uri, lock);
    });
    const registries = new Map<string, NpmRegistryConfig>();
    await mapLimit(npmrcUris, READ_CONCURRENCY, async (uri) => {
      const text = await this.read(uri);
      const config = text !== undefined ? parseNpmRegistryFile(basename(uri), text) : undefined;
      if (config) registries.set(uri, config);
    });
    let user = emptyRegistryConfig();
    for (const name of NPM_REGISTRY_FILES) {
      try {
        const text = await this.files.readUserConfig(name);
        const config = text !== undefined ? parseNpmRegistryFile(name, text) : undefined;
        if (config) user = mergeRegistryConfig(user, config);
      } catch {
        // No user file of this kind.
      }
    }
    const tsconfigs = new Map<string, TsconfigInfo>();
    await mapLimit(tsUris, READ_CONCURRENCY, async (uri) => {
      const info = await this.readTsconfig(uri);
      if (info) tsconfigs.set(uri, info);
    });

    this.manifestsByUri = manifests;
    this.lockfilesByUri = lockfiles;
    this.registriesByUri = registries;
    this.userRegistries = user;
    this.tsconfigByUri = tsconfigs;
    this.pyModules = new Set();
    this.pyDirs = new Set();
    for (const uri of pyUris) this.addPythonFile(uri);
    this.derived = undefined;
    this.isReady = true;
    this.logger.info(`Indexed ${manifests.size} manifests and ${lockfiles.size} lockfiles in ${Date.now() - started} ms.`);
    this.changeEmitter.fire();
  }

  private async read(uri: string): Promise<string | undefined> {
    try {
      return await this.files.readText(uri);
    } catch {
      return undefined;
    }
  }

  private async readTsconfig(uri: string): Promise<TsconfigInfo | undefined> {
    const text = await this.read(uri);
    if (text === undefined) return undefined;
    const aliases = parseTsconfigAliases(text);
    const baseUrlNames = new Set<string>();
    if (aliases.baseUrl !== undefined) {
      const baseDir = join(dirname(uri), aliases.baseUrl);
      const root = this.rootFor(uri);
      if (root && isUnder(baseDir, root)) {
        const rel = relative(root, baseDir);
        const glob = rel ? `${rel}/**` : "**";
        let found: string[];
        try {
          found = await this.files.findFiles(glob, EXCLUDE_GLOB, MAX_BASEURL_FILES);
        } catch {
          found = [];
        }
        for (const f of found) {
          if (!isUnder(f, baseDir)) continue;
          const first = relative(baseDir, f).split("/")[0];
          if (!first) continue;
          baseUrlNames.add(first.replace(JS_EXTENSIONS, ""));
        }
      }
    }
    return { aliases, baseUrlNames, kind: basename(uri) === "jsconfig.json" ? "jsconfig.json" : "tsconfig.json" };
  }

  /**
   * Records the module names a Python file provides: its own name (or its
   * package's, for __init__.py), and every directory between the workspace
   * root and the file, since any of them can be imported as a PEP 420
   * namespace package or from a src layout. True when a name is new.
   */
  private addPythonFile(uri: string): boolean {
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
    const name = basename(uri);
    let grew = false;
    let mod: string | undefined;
    if (name === "__init__.py") mod = basename(dirname(uri));
    else if (name.endsWith(".py")) mod = name.slice(0, -3);
    if (mod !== undefined && identifier.test(mod) && !this.pyModules.has(mod)) {
      this.pyModules.add(mod);
      grew = true;
    }
    const root = this.rootFor(uri);
    if (root) {
      const dirs = relative(root, dirname(uri)).split("/").filter((d) => d !== "");
      for (const dir of dirs) {
        if (!identifier.test(dir) || this.pyDirs.has(dir)) continue;
        this.pyDirs.add(dir);
        grew = true;
      }
    }
    return grew;
  }

  /** Tells the ui to re-analyse after new local Python modules appeared, so their imports are skipped. */
  private pythonModulesGrew(): void {
    if (!this.clock) {
      this.changeEmitter.fire();
      return;
    }
    if (this.pyChangeTimer !== undefined) return;
    this.pyChangeTimer = this.clock.setTimeout(() => {
      this.pyChangeTimer = undefined;
      this.changeEmitter.fire();
    }, PY_CHANGE_COALESCE_MS);
  }

  /** Records a Python file seen outside the index scan (the document being analysed). */
  notePythonFile(uri: string): void {
    // No change event here: this runs during an analysis, which already sees the name.
    if (!isIgnoredUri(uri)) this.addPythonFile(uri);
  }

  /** Last editor text seen per manifest URI (documentChanged), to fire only on real changes. */
  private editorText = new Map<string, string>();
  private changeQueued = false;

  documentChanged(uri: string, text: string): void {
    if (!this.isReady || isIgnoredUri(uri) || !this.rootFor(uri)) return;
    const kind = manifestKindOf(basename(uri));
    if (!kind || this.editorText.get(uri) === text) return;
    this.editorText.set(uri, text);
    let manifest: AnyManifest;
    try {
      manifest = parseManifest(uri, text, kind);
    } catch {
      return;
    }
    this.manifestsByUri.set(uri, manifest);
    this.derived = undefined;
    // Asynchronously: the caller is in the middle of an analysis.
    if (this.changeQueued) return;
    this.changeQueued = true;
    queueMicrotask(() => {
      this.changeQueued = false;
      this.changeEmitter.fire();
    });
  }

  async fileChanged(uri: string): Promise<void> {
    if (isIgnoredUri(uri)) return;
    const name = basename(uri);
    const kind = manifestKindOf(name);
    if (kind) {
      this.editorText.delete(uri);
      const text = await this.read(uri);
      if (text === undefined) this.manifestsByUri.delete(uri);
      else this.manifestsByUri.set(uri, parseManifest(uri, text, kind));
    } else if ((NPM_LOCKFILES as readonly string[]).includes(name) || (PYPI_LOCKFILES as readonly string[]).includes(name)) {
      const text = await this.read(uri);
      const lock = text !== undefined ? parseLockfile(name, text) : undefined;
      if (lock) this.lockfilesByUri.set(uri, lock);
      else this.lockfilesByUri.delete(uri);
    } else if ((NPM_REGISTRY_FILES as readonly string[]).includes(name)) {
      const text = await this.read(uri);
      const config = text !== undefined ? parseNpmRegistryFile(name, text) : undefined;
      if (config) this.registriesByUri.set(uri, config);
      else this.registriesByUri.delete(uri);
    } else if (name === "tsconfig.json" || name === "jsconfig.json") {
      const info = await this.readTsconfig(uri);
      if (info) this.tsconfigByUri.set(uri, info);
      else this.tsconfigByUri.delete(uri);
    } else if (name.endsWith(".py")) {
      // Module names only grow; no surface depends on a removal.
      if ((await this.files.exists(uri).catch(() => false)) && this.addPythonFile(uri) && this.isReady) this.pythonModulesGrew();
      return;
    } else {
      return;
    }
    this.derived = undefined;
    this.changeEmitter.fire();
  }

  manifests(): ParsedManifest[] {
    return [...this.manifestsByUri.values()].sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
  }

  manifest(uri: string): AnyManifest | undefined {
    return this.manifestsByUri.get(uri);
  }

  dispose(): void {
    if (this.pyChangeTimer !== undefined && this.clock) this.clock.clearTimeout(this.pyChangeTimer);
    this.pyChangeTimer = undefined;
    this.changeEmitter.dispose();
  }

  // ---- queries used by the resolver ------------------------------------------

  rootFor(uri: string): string | undefined {
    let best: string | undefined;
    for (const root of this.files.roots()) {
      const r = root.replace(/\/+$/, "");
      if (isUnder(uri, r) && (!best || r.length > best.length)) best = r;
    }
    return best;
  }

  /** Directories from the file's directory up to its workspace root, nearest first. */
  dirsUp(uri: string): string[] {
    const root = this.rootFor(uri);
    return root ? ancestors(uri, root) : [];
  }

  private get d(): Derived {
    this.derived ??= derive(this.manifestsByUri, this.lockfilesByUri);
    return this.derived;
  }

  manifestsIn(dir: string): AnyManifest[] {
    return this.d.manifestsByDir.get(dir) ?? [];
  }

  /** The nearest manifest (from the file's directory up) of the ecosystem that declares `name`. */
  findDeclaration(ecosystem: Ecosystem, fromUri: string, name: string, by: "name" | "rawName" = "name"): { manifest: AnyManifest; dep: ParsedManifest["dependencies"][number] } | undefined {
    const want = ecosystem === "pypi" ? normalizePypiName(name) : name;
    for (const dir of this.dirsUp(fromUri)) {
      for (const m of this.manifestsIn(dir)) {
        if (m.ecosystem !== ecosystem) continue;
        const dep = m.dependencies.find((d) => (ecosystem === "pypi" ? d.name === want : (by === "rawName" ? d.rawName : d.name) === want));
        if (dep) return { manifest: m, dep };
      }
    }
    return undefined;
  }

  /** The nearest lockfile of the ecosystem, from `dir` up to the root. */
  lockfileFor(ecosystem: Ecosystem, fromDir: string): { lockfile: Lockfile; dir: string } | undefined {
    const order: readonly string[] = ecosystem === "npm" ? NPM_LOCKFILES : ecosystem === "pypi" ? PYPI_LOCKFILES : [];
    if (order.length === 0) return undefined;
    const root = this.rootFor(fromDir);
    const dirs = root ? ancestors(`${fromDir}/x`, root) : [];
    for (const dir of dirs) {
      const here = this.d.lockfilesByDir.get(dir);
      if (!here) continue;
      for (const name of order) {
        const lock = here.get(name);
        if (lock) return { lockfile: lock, dir };
      }
    }
    return undefined;
  }

  /**
   * Every npm registry binding that can apply to a file: the user's .npmrc,
   * .yarnrc, .yarnrc.yml and bunfig.toml, then those of every directory from
   * the workspace root down to the file's directory.
   */
  npmRegistries(uri: string): NpmRegistryConfig {
    let merged = this.userRegistries;
    for (const dir of [...this.dirsUp(uri)].reverse()) {
      for (const name of NPM_REGISTRY_FILES) {
        const config = this.registriesByUri.get(`${dir}/${name}`);
        if (config) merged = mergeRegistryConfig(merged, config);
      }
    }
    return merged;
  }

  /** The nearest tsconfig.json (or jsconfig.json) aliases. */
  tsconfigFor(uri: string): { patterns: string[]; baseUrlNames: Set<string> } | undefined {
    for (const dir of this.dirsUp(uri)) {
      const ts = this.tsconfigByUri.get(`${dir}/tsconfig.json`) ?? this.tsconfigByUri.get(`${dir}/jsconfig.json`);
      if (ts) return { patterns: ts.aliases.patterns, baseUrlNames: ts.baseUrlNames };
    }
    return undefined;
  }

  /** The nearest package.json directory of a file (the lockfile importer of an undeclared import). */
  nearestManifestDir(uri: string, ecosystem: Ecosystem): string | undefined {
    for (const dir of this.dirsUp(uri)) {
      if (this.manifestsIn(dir).some((m) => m.ecosystem === ecosystem)) return dir;
    }
    return undefined;
  }

  nearestGoMod(uri: string): GoModManifest | undefined {
    for (const dir of this.dirsUp(uri)) {
      const m = this.manifestsIn(dir).find((x) => x.kind === "go.mod");
      if (m) return m as GoModManifest;
    }
    return undefined;
  }

  /** The workspace's own package names (normalised for PyPI). */
  selfNames(ecosystem: Ecosystem): ReadonlySet<string> {
    return this.d.selfNames[ecosystem];
  }

  /** Every PyPI distribution declared by a manifest or locked by a lockfile, by normalised name. */
  pypiDeclared(): { has(name: string): boolean } {
    const declared = this.d.pypiDeclared;
    const locks = [...this.lockfilesByUri.values()].filter((l) => l.ecosystem === "pypi");
    return { has: (name: string) => declared.has(name) || locks.some((l) => l.versions(name) !== undefined) };
  }

  /** Every package index URL the workspace's Python manifests configure (for imports no manifest declares). */
  pypiIndexUrls(): readonly string[] {
    return this.d.pypiIndexUrls;
  }

  pythonModules(): ReadonlySet<string> {
    return this.pyModules;
  }

  /** Directory names that hold Python files inside the workspace (see addPythonFile). */
  pythonDirs(): ReadonlySet<string> {
    return this.pyDirs;
  }

  /** Module paths of the workspace's Go modules. */
  goMainModules(): ReadonlySet<string> {
    return this.d.selfNames.golang;
  }
}

interface Derived {
  manifestsByDir: Map<string, AnyManifest[]>;
  lockfilesByDir: Map<string, Map<string, Lockfile>>;
  selfNames: Record<Ecosystem, Set<string>>;
  pypiDeclared: Set<string>;
  pypiIndexUrls: string[];
}

function derive(manifests: Map<string, AnyManifest>, lockfiles: Map<string, Lockfile>): Derived {
  const manifestsByDir = new Map<string, AnyManifest[]>();
  const selfNames: Record<Ecosystem, Set<string>> = { npm: new Set(), pypi: new Set(), golang: new Set() };
  const pypiDeclared = new Set<string>();
  const pypiIndexUrls = new Set<string>();
  for (const m of manifests.values()) {
    for (const url of m.indexUrls ?? []) pypiIndexUrls.add(url);
    const dir = dirname(m.uri);
    const list = manifestsByDir.get(dir) ?? [];
    list.push(m);
    manifestsByDir.set(dir, list);
    if (m.kind === "go.mod") {
      const mod = (m as GoModManifest).module;
      if (mod) selfNames.golang.add(mod);
    } else if (m.selfName) {
      selfNames[m.ecosystem].add(m.ecosystem === "pypi" ? normalizePypiName(m.selfName) : m.selfName);
    }
    if (m.ecosystem === "pypi") for (const d of m.dependencies) pypiDeclared.add(d.name);
  }
  // Stable order inside a directory: package.json, pyproject.toml, requirements files, go.mod.
  const rank: Record<string, number> = { "package.json": 0, pyproject: 1, requirements: 2, "go.mod": 3 };
  for (const list of manifestsByDir.values()) list.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || (a.uri < b.uri ? -1 : 1));
  const lockfilesByDir = new Map<string, Map<string, Lockfile>>();
  for (const [uri, lock] of lockfiles) {
    const dir = dirname(uri);
    const here = lockfilesByDir.get(dir) ?? new Map<string, Lockfile>();
    here.set(basename(uri), lock);
    lockfilesByDir.set(dir, here);
  }
  return { manifestsByDir, lockfilesByDir, selfNames, pypiDeclared, pypiIndexUrls: [...pypiIndexUrls] };
}
