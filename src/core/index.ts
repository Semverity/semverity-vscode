// The public surface of the core layer. The ui layer imports from here and
// from ./types only. createCore wires the core modules together; the
// signatures below are the contract (docs/DESIGN.md section 3).

import type { Clock, FetchLike, FileSource, KeyValueStore, Logger, SecretSource } from "./ports";
import { SemverityClient } from "./api/client";
import { ScoreCache } from "./cache/scoreCache";
import { LookupServiceImpl } from "./lookup/service";
import { PrivacyFilter, type PrivacyOptions } from "./privacy/filter";
import { analyzeDocument } from "./resolver/resolve";
import { WorkspaceIndexImpl } from "./resolver/workspaceIndex";
import type {
  CoreOptions,
  DocumentAnalysis,
  Disposable,
  Event,
  ListingSummary,
  LookupResult,
  LookupTarget,
  NetworkStatus,
  PackageId,
  ParsedManifest,
} from "./types";

export * from "./types";
export type * from "./ports";
import { canonicalName } from "./api/purl";
export { packagePageUrl, toPurl, coordinateKey, packageKey, canonicalName } from "./api/purl";

export type Priority = "visible" | "background";

/** Workspace manifests, lockfiles, .npmrc scopes and tsconfig paths, kept current by the adapters. */
export interface WorkspaceIndex {
  /** Scans every workspace root. Called once on activation and by "Check Workspace". */
  rebuild(): Promise<void>;
  /** A manifest, lockfile, .npmrc, tsconfig/jsconfig or go.work file changed on disk (or was created or deleted). */
  fileChanged(uri: string): Promise<void>;
  /**
   * The editor text of an open manifest changed (unsaved edits count): the
   * index re-parses it, so declarations and their ranges match what the user
   * sees. Fires onDidChange (asynchronously) only when the text differs from
   * the last one seen. Manifests outside the workspace folders are ignored.
   */
  documentChanged(uri: string, text: string): void;
  /** Every parsed manifest, for the workspace check and the tree view. */
  manifests(): ParsedManifest[];
  /** Fires after the index changed (the ui re-analyses visible documents). */
  readonly onDidChange: Event<void>;
}

export interface LookupService {
  /** The cached answer, without any network activity (stale answers included, marked stale). */
  peek(target: LookupTarget): LookupResult | undefined;
  /** Queues lookups; answers arrive through onDidUpdate. Visible requests go first. */
  request(targets: LookupTarget[], priority: Priority): void;
  /**
   * Queues and waits for the answers (the workspace check and hovers). With
   * `full`, a target answered so far only from its listing waits for its card.
   */
  resolve(targets: LookupTarget[], priority: Priority, options?: { full?: boolean }): Promise<Map<string, LookupResult>>;
  /** The listing (latest and healthy versions); cached and revalidated with ETag. */
  listing(id: PackageId): Promise<ListingSummary | undefined>;
  /** Drops cached answers (all when ids is undefined) and re-requests what is visible. */
  invalidate(ids?: PackageId[]): void;
  /** Empties the memory and persistent caches. */
  clear(): Promise<void>;
  status(): NetworkStatus;
  /**
   * Call after the API key was set or cleared: negative answers are dropped
   * (a key changes what is found) and visible targets are looked up again.
   */
  apiKeyChanged?(): void;
  /** Keys (targetKey) whose answers changed. */
  readonly onDidUpdate: Event<string[]>;
  readonly onDidChangeStatus: Event<NetworkStatus>;
}

export interface Core extends Disposable {
  readonly workspace: WorkspaceIndex;
  readonly lookups: LookupService;
  /**
   * Parses one document (source file or manifest) and resolves every entry
   * against the workspace index and the privacy filter. Synchronous and
   * network-free; `text` is the editor buffer, so unsaved edits count.
   */
  analyze(doc: { uri: string; languageId: string; text: string }): DocumentAnalysis;
  updateOptions(options: CoreOptions): void;
}

export interface CoreDeps {
  options: CoreOptions;
  fetch: FetchLike;
  clock: Clock;
  store: KeyValueStore;
  files: FileSource;
  secrets: SecretSource;
  logger: Logger;
}

/** The dedupe key of a lookup target (also the key in onDidUpdate and resolve()). */
export function targetKey(t: LookupTarget): string {
  const v = t.version ?? (t.range !== undefined ? `range:${t.range}` : "latest");
  return `${t.id.ecosystem}:${canonicalName(t.id.ecosystem, t.id.name)}@${v}`;
}

function privacyOptions(o: CoreOptions): PrivacyOptions {
  return {
    excludePatterns: o.excludePatterns,
    excludeNpmrcScopes: o.excludeNpmrcScopes,
    trustedRegistryHosts: o.trustedRegistryHosts,
    goPrivate: o.goPrivate,
    npmEnvRegistries: o.npmEnvRegistries ?? [],
    pythonIndexes: o.pythonIndexes ?? [],
  };
}

/** Wires the workspace index, privacy filter, client, cache and lookup service. */
export function createCore(deps: CoreDeps): Core {
  let options = deps.options;
  const index = new WorkspaceIndexImpl(deps.files, deps.logger, deps.clock);
  const filter = new PrivacyFilter(privacyOptions(options));
  const client = new SemverityClient(
    { fetch: deps.fetch, secrets: deps.secrets, logger: deps.logger, now: () => deps.clock.now() },
    { apiBaseUrl: options.apiBaseUrl, userAgent: options.userAgent },
  );
  const cache = new ScoreCache(
    deps.store,
    deps.clock,
    { apiBaseUrl: options.apiBaseUrl, ttlMs: options.cacheTtlMs, negativeTtlMs: options.negativeTtlMs },
    deps.logger,
  );
  const lookups = new LookupServiceImpl(client, cache, deps.clock, deps.logger, {
    networkEnabled: options.networkEnabled,
    maxRequestsPerMinute: options.maxRequestsPerMinute,
  });

  return {
    workspace: index,
    lookups,
    analyze(doc) {
      return analyzeDocument(doc, index, filter, {
        ecosystems: options.ecosystems,
        lookupUndeclaredImports: options.lookupUndeclaredImports,
      });
    },
    updateOptions(next) {
      options = next;
      filter.update(privacyOptions(next));
      client.setOptions({ apiBaseUrl: next.apiBaseUrl, userAgent: next.userAgent });
      void cache.setOptions({ apiBaseUrl: next.apiBaseUrl, ttlMs: next.cacheTtlMs, negativeTtlMs: next.negativeTtlMs });
      // Queued work computed under the old settings must not outlive a new exclusion.
      lookups.dropQueued((id) => !filter.check(id).allowed || !next.ecosystems[id.ecosystem]);
      lookups.updateOptions({ networkEnabled: next.networkEnabled, maxRequestsPerMinute: next.maxRequestsPerMinute });
    },
    dispose() {
      lookups.dispose();
      void cache.flush();
      index.dispose();
    },
  };
}
