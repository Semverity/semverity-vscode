// Ports: the only ways the core reaches the outside world. The vscode adapters
// in src/vscode implement them for the extension host; tests implement them with
// fakes (test/helpers). None of them carries source text, paths or workspace
// names to the network: only FetchLike talks to the network, and only the API
// client calls it, with coordinates.

/** The subset of the WHATWG fetch Response the client reads. */
export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface FetchInitLike {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** globalThis.fetch in the extension host; a scripted fake in tests. */
export type FetchLike = (url: string, init: FetchInitLike) => Promise<FetchResponseLike>;

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** vscode.Memento (ExtensionContext.globalState) or an in-memory map. */
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** Writes to the "Semverity" log output channel. Never given secrets or source text. */
export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** vscode.SecretStorage behind a narrow port: the core can read the key, never store it. */
export interface SecretSource {
  getApiKey(): Promise<string | undefined>;
}

/**
 * Read-only access to workspace files by URI string ("file:///..." or any
 * scheme the workspace file system serves). Unsaved editor contents win over
 * disk for documents that are open.
 */
export interface FileSource {
  /** Workspace folder URIs, without a trailing slash. */
  roots(): string[];
  /** undefined when the file does not exist or cannot be read. */
  readText(uri: string): Promise<string | undefined>;
  /** URIs matching a glob relative to every root, honouring `exclude` and `maxResults`. */
  findFiles(include: string, exclude?: string, maxResults?: number): Promise<string[]>;
  exists(uri: string): Promise<boolean>;
  /**
   * A user-level npm registry file (~/.npmrc, ~/.yarnrc, ~/.yarnrc.yml,
   * ~/.bunfig.toml), read only for registry URLs; undefined when absent.
   */
  readUserConfig(name: ".npmrc" | ".yarnrc" | ".yarnrc.yml" | "bunfig.toml"): Promise<string | undefined>;
}
