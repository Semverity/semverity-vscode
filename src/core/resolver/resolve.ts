// Document analysis: parse, map, choose a version and apply the privacy
// filter (docs/DESIGN.md sections 6 to 8). Synchronous and network free; the
// result names what to look up, never how.

import semver from "semver";
import { classifyNpmSpec } from "../parsers/packageJson";
import { parseJsImports } from "../parsers/javascript";
import { parsePythonImports } from "../parsers/python";
import { parseGoImports } from "../parsers/go";
import { replacementFor, type GoModManifest } from "../parsers/goMod";
import type { NpmRegistryConfig } from "../parsers/npmRegistries";
import { npmPackageFor } from "../mapping/npm";
import { pythonDistributionFor } from "../mapping/python";
import { goModuleFor } from "../mapping/golang";
import type { LocalSignals, PrivacyFilter } from "../privacy/filter";
import { basename, dirname, relative } from "../uri";
import { normalizePypiName } from "../api/purl";
import type {
  AnalysisEntry,
  DeclaredIn,
  DocumentAnalysis,
  Ecosystem,
  ImportRef,
  LookupTarget,
  ManifestDependency,
  ManifestKind,
  PackageId,
} from "../types";
import { isIgnoredUri, manifestKindOf, parseManifest, type AnyManifest, type WorkspaceIndexImpl } from "./workspaceIndex";

export interface ResolveOptions {
  ecosystems: Record<Ecosystem, boolean>;
  lookupUndeclaredImports: boolean;
}

export const MAX_DOCUMENT_BYTES = 1024 * 1024;

const JS_LANGUAGES = new Set(["javascript", "javascriptreact", "typescript", "typescriptreact"]);

export type DocumentClass = { kind: "manifest"; manifestKind: ManifestKind; ecosystem: Ecosystem } | { kind: "source"; ecosystem: Ecosystem } | { kind: "unsupported" };

export function classifyDocument(uri: string, languageId: string): DocumentClass {
  const name = basename(uri);
  let manifestKind = manifestKindOf(name);
  if (!manifestKind && languageId === "pip-requirements") manifestKind = "requirements";
  if (!manifestKind && languageId === "go.mod" && name.endsWith(".mod")) manifestKind = "go.mod";
  if (manifestKind) {
    const ecosystem: Ecosystem = manifestKind === "package.json" ? "npm" : manifestKind === "go.mod" ? "golang" : "pypi";
    return { kind: "manifest", manifestKind, ecosystem };
  }
  if (JS_LANGUAGES.has(languageId)) return { kind: "source", ecosystem: "npm" };
  if (languageId === "python") return { kind: "source", ecosystem: "pypi" };
  if (languageId === "go") return { kind: "source", ecosystem: "golang" };
  return { kind: "unsupported" };
}

export function analyzeDocument(
  doc: { uri: string; languageId: string; text: string },
  index: WorkspaceIndexImpl,
  filter: PrivacyFilter,
  options: ResolveOptions,
): DocumentAnalysis {
  const cls = classifyDocument(doc.uri, doc.languageId);
  if (cls.kind === "unsupported" || isIgnoredUri(doc.uri) || doc.text.length > MAX_DOCUMENT_BYTES) {
    return { uri: doc.uri, kind: "unsupported", entries: [] };
  }
  if (!options.ecosystems[cls.ecosystem]) return { uri: doc.uri, kind: cls.kind, ecosystem: cls.ecosystem, entries: [] };
  // Before the first index build, local module names and private scopes are unknown:
  // analysing now could send them. The index fires onDidChange when it is ready.
  if (!index.ready) return { uri: doc.uri, kind: cls.kind, ecosystem: cls.ecosystem, entries: [] };
  return cls.kind === "manifest" ? analyzeManifest(doc, cls.manifestKind, index, filter, options) : analyzeSource(doc, cls.ecosystem, index, filter, options);
}

function skipEntry(label: string, range: AnalysisEntry["range"], reason: NonNullable<AnalysisEntry["skip"]>["reason"], detail?: string): AnalysisEntry {
  const entry: AnalysisEntry = { label, line: range.start.line, range, skip: { reason } };
  if (detail !== undefined) (entry.skip as { detail?: string }).detail = detail;
  return entry;
}

function declaredIn(manifest: { uri: string; kind: ManifestKind }, dep: ManifestDependency): DeclaredIn {
  return { manifestUri: manifest.uri, manifestKind: manifest.kind, dependency: dep };
}

type Choice = Pick<LookupTarget, "version" | "range" | "versionSource" | "lockfile">;

/** The choice for an undeclared import: the locked version when a lockfile has one, else latest. */
function lockedOrLatest(version: string | undefined, lockfileName: string | undefined): Choice {
  if (version === undefined) return { versionSource: "latest" };
  const choice: Choice = { version, versionSource: "lockfile" };
  if (lockfileName) choice.lockfile = lockfileName;
  return choice;
}

/** Version choice for a declared dependency: lockfile, exact manifest version, range, latest. */
function versionFor(
  ecosystem: Ecosystem,
  dep: ManifestDependency,
  lock: { version?: string; lockfileName?: string } | undefined,
): Choice {
  if (lock?.version) {
    const choice: Choice = { version: lock.version, versionSource: "lockfile" };
    if (lock.lockfileName) choice.lockfile = lock.lockfileName;
    return choice;
  }
  if (dep.exactVersion) return { version: dep.exactVersion, versionSource: "manifest" };
  const range = ecosystem === "npm" ? classifyNpmSpec(dep.spec).range : dep.spec.trim();
  if (range !== "" && range !== "*" && (ecosystem !== "npm" || semver.validRange(range, { loose: true }) !== null)) {
    return { range, versionSource: "range" };
  }
  return { versionSource: "latest" };
}

function buildEntry(
  label: string,
  range: AnalysisEntry["range"],
  id: PackageId,
  choice: Choice,
  filter: PrivacyFilter,
  signals: LocalSignals,
  decl: DeclaredIn | undefined,
  specRange?: AnalysisEntry["specRange"],
): AnalysisEntry {
  const entry: AnalysisEntry = { label, line: range.start.line, range };
  if (specRange) entry.specRange = specRange;
  if (decl) entry.declaredIn = decl;
  const verdict = filter.check(id, signals);
  if (!verdict.allowed) {
    entry.excluded = { rule: verdict.rule };
    return entry;
  }
  const target: LookupTarget = { id, versionSource: choice.versionSource };
  if (choice.version !== undefined) target.version = choice.version;
  if (choice.range !== undefined) target.range = choice.range;
  if (choice.lockfile !== undefined) target.lockfile = choice.lockfile;
  entry.target = target;
  return entry;
}

// ---- source files -------------------------------------------------------------

export function analyzeSource(
  doc: { uri: string; text: string },
  ecosystem: Ecosystem,
  index: WorkspaceIndexImpl,
  filter: PrivacyFilter,
  options: ResolveOptions,
): DocumentAnalysis {
  const entries: AnalysisEntry[] = [];
  if (ecosystem === "npm") {
    const imports = safeParse(() => parseJsImports(doc.text));
    const ts = index.tsconfigFor(doc.uri);
    const ctx = { patterns: ts?.patterns ?? [], baseUrlNames: ts?.baseUrlNames ?? new Set<string>(), selfNames: index.selfNames("npm") };
    const registries = index.npmRegistries(doc.uri);
    for (const imp of imports) entries.push(npmImportEntry(doc.uri, imp, ctx, registries, index, filter, options));
  } else if (ecosystem === "pypi") {
    if (doc.uri.endsWith(".py")) index.notePythonFile(doc.uri);
    const imports = safeParse(() => parsePythonImports(doc.text));
    const declared = index.pypiDeclared();
    const ctx = { localModules: index.pythonModules(), localDirs: index.pythonDirs(), selfNames: index.selfNames("pypi") };
    for (const imp of imports) entries.push(pythonImportEntry(doc.uri, imp, declared, ctx, index, filter, options));
  } else {
    const imports = safeParse(() => parseGoImports(doc.text));
    const gomod = index.nearestGoMod(doc.uri);
    for (const imp of imports) entries.push(goImportEntry(imp, gomod, index, filter, options));
  }
  return { uri: doc.uri, kind: "source", ecosystem, entries };
}

function safeParse(fn: () => ImportRef[]): ImportRef[] {
  try {
    return fn();
  } catch {
    return [];
  }
}

function npmImportEntry(
  docUri: string,
  imp: ImportRef,
  ctx: Parameters<typeof npmPackageFor>[1],
  registries: NpmRegistryConfig,
  index: WorkspaceIndexImpl,
  filter: PrivacyFilter,
  options: ResolveOptions,
): AnalysisEntry {
  const m = npmPackageFor(imp.specifier, ctx);
  if ("skip" in m) return skipEntry(imp.specifier, imp.range, m.skip, m.detail);
  // Code imports the dependency key, which differs from the package for npm: aliases.
  const decl = index.findDeclaration("npm", docUri, m.name, "rawName");
  if (decl) {
    const dep = decl.dep;
    if (dep.nonRegistry) return skipEntry(m.name, imp.range, "non-registry", dep.nonRegistry);
    if (index.selfNames("npm").has(dep.name)) return skipEntry(m.name, imp.range, "self");
    const manifestDir = dirname(decl.manifest.uri);
    const lock = index.lockfileFor("npm", manifestDir);
    const importer = lock ? relative(lock.dir, manifestDir) : undefined;
    const lockVersion = lock?.lockfile.versions(dep.rawName, importer, classifyNpmSpec(dep.spec).range);
    const host = lock?.lockfile.resolvedHost(dep.rawName, importer);
    const choice = versionFor("npm", dep, lockVersion ? { version: lockVersion, lockfileName: lock?.lockfile.kind } : undefined);
    const signals: LocalSignals = { npmRegistries: registries };
    if (host) signals.lockfileHost = host;
    return buildEntry(dep.name, imp.range, { ecosystem: "npm", name: dep.name }, choice, filter, signals, declaredIn(decl.manifest, dep));
  }
  if (!options.lookupUndeclaredImports) return skipEntry(m.name, imp.range, "undeclared");
  const importerDir = index.nearestManifestDir(docUri, "npm") ?? dirname(docUri);
  const lock = index.lockfileFor("npm", importerDir);
  const importer = lock ? relative(lock.dir, importerDir) : undefined;
  const lockVersion = lock?.lockfile.versions(m.name, importer);
  const host = lock?.lockfile.resolvedHost(m.name, importer);
  const signals: LocalSignals = { npmRegistries: registries };
  if (host) signals.lockfileHost = host;
  const choice = lockedOrLatest(lockVersion, lock?.lockfile.kind);
  return buildEntry(m.name, imp.range, { ecosystem: "npm", name: m.name }, choice, filter, signals, undefined);
}

function pythonImportEntry(
  docUri: string,
  imp: ImportRef,
  declared: { has(name: string): boolean },
  ctx: Parameters<typeof pythonDistributionFor>[2],
  index: WorkspaceIndexImpl,
  filter: PrivacyFilter,
  options: ResolveOptions,
): AnalysisEntry {
  const m = pythonDistributionFor(imp.specifier, declared, ctx, imp.names);
  if ("skip" in m) return skipEntry(imp.specifier, imp.range, m.skip, m.detail);
  const decl = index.findDeclaration("pypi", docUri, m.name);
  if (decl) {
    const dep = decl.dep;
    if (dep.nonRegistry) return skipEntry(m.name, imp.range, "non-registry", dep.nonRegistry);
    const manifestDir = dirname(decl.manifest.uri);
    const lock = index.lockfileFor("pypi", manifestDir);
    const lockVersion = lock?.lockfile.versions(dep.name);
    const host = lock?.lockfile.resolvedHost(dep.name);
    const choice = versionFor("pypi", dep, lockVersion ? { version: lockVersion, lockfileName: lock?.lockfile.kind } : undefined);
    const signals = pythonSignals(decl.manifest, host);
    // Show the distribution as the manifest spells it.
    return buildEntry(dep.rawName, imp.range, { ecosystem: "pypi", name: dep.rawName }, choice, filter, signals, declaredIn(decl.manifest, dep));
  }
  if (!m.declared && !options.lookupUndeclaredImports) return skipEntry(m.name, imp.range, "undeclared");
  const lock = index.lockfileFor("pypi", dirname(docUri));
  const lockVersion = lock?.lockfile.versions(m.name);
  const host = lock?.lockfile.resolvedHost(m.name);
  const signals: LocalSignals = {};
  if (host) signals.lockfileHost = host;
  // No manifest declares it: any index a workspace Python manifest configures could serve it.
  const urls = index.pypiIndexUrls();
  if (urls.length > 0) {
    signals.indexUrls = urls;
    signals.indexSource = "a Python manifest of the workspace";
  }
  const choice = lockedOrLatest(lockVersion, lock?.lockfile.kind);
  return buildEntry(m.name, imp.range, { ecosystem: "pypi", name: m.name }, choice, filter, signals, undefined);
}

function goImportEntry(imp: ImportRef, gomod: GoModManifest | undefined, index: WorkspaceIndexImpl, filter: PrivacyFilter, options: ResolveOptions): AnalysisEntry {
  const requires = (gomod?.dependencies ?? []).map((d) => {
    const r: { path: string; version?: string } = { path: d.name };
    if (d.exactVersion) r.version = d.exactVersion;
    return r;
  });
  const m = goModuleFor(imp.specifier, {
    mainModules: index.goMainModules(),
    requires,
    replaces: gomod?.replaces ?? [],
    lookupUndeclared: options.lookupUndeclaredImports,
  });
  if ("skip" in m) return skipEntry(imp.specifier, imp.range, m.skip, m.detail);
  const dep = gomod?.dependencies.find((d) => d.name === (m.requiredAs ?? m.module));
  const choice: Pick<LookupTarget, "version" | "versionSource"> = m.version ? { version: m.version, versionSource: "manifest" } : { versionSource: "latest" };
  const decl = gomod && dep ? declaredIn(gomod, dep) : undefined;
  return buildEntry(m.module, imp.range, { ecosystem: "golang", name: m.module }, choice, filter, {}, decl);
}

/** The privacy signals of a Python manifest: its lockfile host and the index URLs it configures. */
function pythonSignals(manifest: AnyManifest, host: string | undefined): LocalSignals {
  const signals: LocalSignals = {};
  if (host) signals.lockfileHost = host;
  if (manifest.indexUrls && manifest.indexUrls.length > 0) {
    signals.indexUrls = manifest.indexUrls;
    signals.indexSource = manifest.kind === "requirements" ? "its requirements file" : basename(manifest.uri);
  }
  return signals;
}

// ---- manifests ----------------------------------------------------------------

export function analyzeManifest(
  doc: { uri: string; text: string },
  kind: ManifestKind,
  index: WorkspaceIndexImpl,
  filter: PrivacyFilter,
  _options: ResolveOptions,
): DocumentAnalysis {
  let manifest: AnyManifest;
  try {
    manifest = parseManifest(doc.uri, doc.text, kind);
  } catch {
    return { uri: doc.uri, kind: "manifest", entries: [] };
  }
  const ecosystem = manifest.ecosystem;
  const dir = dirname(doc.uri);
  const entries: AnalysisEntry[] = [];
  const selfNames = index.selfNames(ecosystem);
  const registries = ecosystem === "npm" ? index.npmRegistries(doc.uri) : undefined;
  const lock = ecosystem === "golang" ? undefined : index.lockfileFor(ecosystem, dir);
  const importer = lock ? relative(lock.dir, dir) : undefined;
  const replaces = manifest.kind === "go.mod" ? (manifest as GoModManifest).replaces : [];

  for (const dep of manifest.dependencies) {
    const label = dep.rawName;
    const decl = declaredIn(manifest, dep);
    const withDecl = (e: AnalysisEntry): AnalysisEntry => {
      e.declaredIn = decl;
      if (dep.specRange) e.specRange = dep.specRange;
      return e;
    };
    if (dep.nonRegistry) {
      entries.push(withDecl(skipEntry(label, dep.nameRange, "non-registry", dep.nonRegistry)));
      continue;
    }
    const selfKey = ecosystem === "pypi" ? normalizePypiName(dep.name) : dep.name;
    if (selfNames.has(selfKey)) {
      entries.push(withDecl(skipEntry(label, dep.nameRange, "self")));
      continue;
    }

    let id: PackageId = { ecosystem, name: dep.name };
    let choice: Choice;
    let signals: LocalSignals = {};
    if (ecosystem === "golang") {
      const rep = replacementFor(replaces, dep.name, dep.exactVersion);
      if (rep?.local) {
        entries.push(withDecl(skipEntry(label, dep.nameRange, "non-registry", "local-replace")));
        continue;
      }
      if (rep) {
        id = { ecosystem, name: rep.to };
        choice = rep.toVersion ? { version: rep.toVersion, versionSource: "manifest" } : { versionSource: "latest" };
      } else {
        choice = versionFor(ecosystem, dep, undefined);
      }
    } else {
      const key = ecosystem === "npm" ? dep.rawName : dep.name;
      const range = ecosystem === "npm" ? classifyNpmSpec(dep.spec).range : dep.spec;
      const lockVersion = lock?.lockfile.versions(key, importer, range);
      const host = lock?.lockfile.resolvedHost(key, importer);
      choice = versionFor(ecosystem, dep, lockVersion ? { version: lockVersion, lockfileName: lock?.lockfile.kind } : undefined);
      if (ecosystem === "pypi") signals = pythonSignals(manifest, host);
      else if (host) signals.lockfileHost = host;
      if (registries) signals.npmRegistries = registries;
    }
    entries.push(buildEntry(label, dep.nameRange, id, choice, filter, signals, decl, dep.specRange));
  }
  return { uri: doc.uri, kind: "manifest", ecosystem, entries };
}
