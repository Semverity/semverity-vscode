// The score cache (docs/DESIGN.md section 5): memory plus globalState,
// partitioned by API base URL, LRU bounded, with lifetimes that honour
// Cache-Control, a 15 minute floor, shorter negative lifetimes, and the stale
// rules the presentation shows.

import { createHash } from "node:crypto";
import type { Clock, KeyValueStore, Logger } from "../ports";
import type { CardSummary, ListingSummary, PackageId } from "../types";
import { packageKey } from "../api/purl";
import { compareVersions } from "../resolver/versions";

export const LIFETIME_FLOOR_MS = 15 * 60_000;
export const MAX_ENTRIES = 3000;
export const WRITE_DELAY_MS = 5000;
/** Listings with more versions than this are persisted truncated and without their ETag. */
export const PERSISTED_VERSIONS_CAP = 500;
const SCHEMA = 1;

export type CacheValue =
  | { kind: "card"; card: CardSummary }
  | { kind: "listing"; listing: ListingSummary }
  | { kind: "not_scored"; reason: "not_indexed" | "not_found" | "invalid" };

export interface CacheEntry {
  value: CacheValue;
  /** Epoch ms of the last successful fetch or revalidation. */
  validatedAt: number;
  /** Epoch ms after which the entry is due for revalidation. */
  freshUntil: number;
  etag?: string;
  negative: boolean;
  /** Epoch ms of the last failed attempt to revalidate. */
  lastFailureAt?: number;
}

export interface CacheOptions {
  apiBaseUrl: string;
  ttlMs: number;
  negativeTtlMs: number;
}

interface Persisted {
  schema: number;
  entries: [string, CacheEntry][];
}

export function cardKey(coordinateKey: string): string {
  return `card:${coordinateKey}`;
}

export function listKey(id: PackageId): string {
  return `list:${packageKey(id)}`;
}

/** The globalState key of a base URL's partition. */
export function storageKey(apiBaseUrl: string): string {
  const hash = createHash("sha256").update(apiBaseUrl.replace(/\/+$/, "")).digest("hex").slice(0, 12);
  return `semverity.cache.v1:${hash}`;
}

export class ScoreCache {
  private entries = new Map<string, CacheEntry>();
  private options: CacheOptions;
  private writeTimer: unknown;
  private dirty = false;

  constructor(
    private readonly store: KeyValueStore,
    private readonly clock: Clock,
    options: CacheOptions,
    private readonly logger?: Logger,
  ) {
    this.options = options;
    this.load();
  }

  /** Reads the persisted partition of the current base URL; an unreadable or other-schema value is dropped. */
  load(): void {
    this.entries.clear();
    let raw: unknown;
    try {
      raw = this.store.get<unknown>(storageKey(this.options.apiBaseUrl));
    } catch {
      raw = undefined;
    }
    if (!raw || typeof raw !== "object") return;
    const p = raw as Partial<Persisted>;
    if (p.schema !== SCHEMA || !Array.isArray(p.entries)) {
      void this.store.update(storageKey(this.options.apiBaseUrl), undefined);
      return;
    }
    for (const item of p.entries) {
      if (!Array.isArray(item) || typeof item[0] !== "string" || !isEntry(item[1])) continue;
      this.entries.set(item[0], item[1]);
    }
    this.evict();
  }

  async setOptions(options: CacheOptions): Promise<void> {
    const partitionChanged = options.apiBaseUrl.replace(/\/+$/, "") !== this.options.apiBaseUrl.replace(/\/+$/, "");
    if (partitionChanged) await this.flush();
    this.options = options;
    if (partitionChanged) this.load();
  }

  get size(): number {
    return this.entries.size;
  }

  /** The entry, refreshed as most recently used. */
  get(key: string): CacheEntry | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    this.entries.delete(key);
    this.entries.set(key, e);
    return e;
  }

  /** The entry without touching its LRU position. */
  peek(key: string): CacheEntry | undefined {
    return this.entries.get(key);
  }

  private lifetime(maxAgeSec: number | undefined, negative: boolean): number {
    const fromHeader = maxAgeSec !== undefined ? maxAgeSec * 1000 : undefined;
    const base = negative ? Math.max(fromHeader ?? 0, this.options.negativeTtlMs) : (fromHeader ?? this.options.ttlMs);
    return Math.max(base, LIFETIME_FLOOR_MS);
  }

  set(key: string, value: CacheValue, meta: { maxAgeSec?: number; etag?: string } = {}): CacheEntry {
    const now = this.clock.now();
    const negative = value.kind === "not_scored";
    const entry: CacheEntry = { value, validatedAt: now, freshUntil: now + this.lifetime(meta.maxAgeSec, negative), negative };
    if (meta.etag) entry.etag = meta.etag;
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.evict();
    this.scheduleWrite();
    return entry;
  }

  /** A 304: keep the value, renew its lifetime and validatedAt. */
  renew(key: string, meta: { maxAgeSec?: number } = {}): CacheEntry | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    const now = this.clock.now();
    e.validatedAt = now;
    e.freshUntil = now + this.lifetime(meta.maxAgeSec, e.negative);
    delete e.lastFailureAt;
    this.scheduleWrite();
    return e;
  }

  markFailure(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.lastFailureAt = this.clock.now();
    this.scheduleWrite();
  }

  isDue(e: CacheEntry): boolean {
    return this.clock.now() >= e.freshUntil;
  }

  /** Stale: not rechecked for a whole TTL, or past its lifetime with the last attempt failed. */
  isStale(e: CacheEntry): boolean {
    const now = this.clock.now();
    if (now - e.validatedAt > this.options.ttlMs) return true;
    return now >= e.freshUntil && e.lastFailureAt !== undefined && e.lastFailureAt > e.validatedAt;
  }

  /** Drops the card and listing entries of these packages (all entries when ids is undefined). */
  invalidate(ids?: PackageId[]): void {
    if (!ids) {
      this.entries.clear();
    } else {
      const prefixes = ids.map((id) => packageKey(id));
      for (const key of [...this.entries.keys()]) {
        const body = key.slice(key.indexOf(":") + 1);
        if (prefixes.some((p) => body === p || body.startsWith(`${p}@`))) this.entries.delete(key);
      }
    }
    this.scheduleWrite();
  }

  /** Drops every negative entry (an API key changes what is found). */
  dropNegative(): void {
    for (const [k, e] of [...this.entries]) {
      if (e.negative) this.entries.delete(k);
    }
    this.scheduleWrite();
  }

  async clear(): Promise<void> {
    this.entries.clear();
    this.cancelWrite();
    this.dirty = false;
    await this.store.update(storageKey(this.options.apiBaseUrl), undefined);
  }

  private evict(): void {
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  private scheduleWrite(): void {
    this.dirty = true;
    if (this.writeTimer !== undefined) return;
    this.writeTimer = this.clock.setTimeout(() => {
      this.writeTimer = undefined;
      void this.flush();
    }, WRITE_DELAY_MS);
  }

  private cancelWrite(): void {
    if (this.writeTimer !== undefined) {
      this.clock.clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
  }

  /** Writes the partition now (on deactivate, or when the write timer fires). */
  async flush(): Promise<void> {
    this.cancelWrite();
    if (!this.dirty) return;
    this.dirty = false;
    const entries: [string, CacheEntry][] = [];
    for (const [k, e] of this.entries) entries.push([k, persistable(e)]);
    const value: Persisted = { schema: SCHEMA, entries };
    try {
      await this.store.update(storageKey(this.options.apiBaseUrl), value);
    } catch (err) {
      this.logger?.warn(`Could not persist the score cache: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  dispose(): Promise<void> {
    return this.flush();
  }
}

function persistable(e: CacheEntry): CacheEntry {
  if (e.value.kind !== "listing") return e;
  const all = e.value.listing.allVersions;
  if (!all || all.length <= PERSISTED_VERSIONS_CAP) return e;
  // Too many versions to keep on disk: keep the newest part, and drop the ETag so the
  // next revalidation fetches the whole listing instead of answering 304.
  const { etag: _etag, ...rest } = e;
  const eco = e.value.listing.id.ecosystem;
  const newest = [...all].sort((a, b) => compareVersions(eco, b, a)).slice(0, PERSISTED_VERSIONS_CAP);
  return { ...rest, value: { kind: "listing", listing: { ...e.value.listing, allVersions: newest, allVersionsTruncated: true } } };
}

function isEntry(v: unknown): v is CacheEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Partial<CacheEntry>;
  return typeof e.validatedAt === "number" && typeof e.freshUntil === "number" && typeof e.negative === "boolean" && typeof e.value === "object" && e.value !== null;
}
