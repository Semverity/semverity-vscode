// The lookup service (docs/DESIGN.md sections 4.4 and 5): a queue of lookup
// targets served from the score cache, with coalescing, chunked batches,
// listings for range and latest targets, conditional revalidation, polling of
// pending collections, backoff, two token buckets and one request in flight.

import type { Clock, Logger } from "../ports";
import type {
  CardSummary,
  Coordinate,
  Disposable,
  ListingSummary,
  LookupResult,
  LookupTarget,
  NetworkStatus,
  PackageId,
  VersionSource,
} from "../types";
import type { LookupService, Priority } from "../index";
import { Emitter } from "../emitter";
import { coordinateKey, packageKey, canonicalName } from "../api/purl";
import { cardFromListing, summarizeCard, summarizeListing } from "../api/summary";
import type { BatchOutcome, Failure, GetOutcome, SemverityClient } from "../api/client";
import type { PackageCard, PackageList } from "../api/types";
import { cardKey, listKey, type CacheEntry, type ScoreCache } from "../cache/scoreCache";
import { pickVersion } from "../resolver/versions";
import { TokenBucket } from "./rateLimiter";

export const COALESCE_MS = 150;
export const MAX_POLLS = 6;
export const CHUNK_SIGNED_OUT = 25;
export const CHUNK_SIGNED_IN = 100;
const REQUEST_BURST = 10;
const PURLS_SIGNED_OUT = { capacity: 25, perMinute: 60 };
const PURLS_SIGNED_IN = { capacity: 100, perMinute: 10 };
const OFFLINE_FIRST_MS = 15_000;
const OFFLINE_MAX_MS = 10 * 60_000;
const SERVER_FIRST_MS = 5_000;
const SERVER_MAX_MS = 5 * 60_000;
const MAX_ERROR_ATTEMPTS = 3;
const KNOWN_LIMIT = 5000;
const RECENT_VISIBLE_LIMIT = 1000;

export function targetKeyOf(t: LookupTarget): string {
  const v = t.version ?? (t.range !== undefined ? `range:${t.range}` : "latest");
  return `${t.id.ecosystem}:${canonicalName(t.id.ecosystem, t.id.name)}@${v}`;
}

export interface LookupServiceOptions {
  networkEnabled: boolean;
  maxRequestsPerMinute: number;
}

interface Queued {
  target: LookupTarget;
  key: string;
  priority: Priority;
  waiters: ((r: LookupResult) => void)[];
  /** Waiters that want the full card, not an answer built from the listing (the hover). */
  fullWaiters: ((r: LookupResult) => void)[];
}

interface ListingRequest {
  id: PackageId;
  priority: Priority;
  waiters: ((l: ListingSummary | undefined) => void)[];
}

interface PendingInfo {
  retryAt: number;
  polls: number;
}

interface ErrorInfo {
  message: string;
  retryAt?: number;
  attempts: number;
}

type Step =
  | { type: "listing"; id: PackageId; etag?: string }
  | { type: "card"; coordinate: Coordinate; etag?: string; forced?: boolean }
  | { type: "batch"; coordinates: Coordinate[]; forced?: boolean };

export class LookupServiceImpl implements LookupService, Disposable {
  private readonly updateEmitter = new Emitter<string[]>();
  private readonly statusEmitter = new Emitter<NetworkStatus>();
  readonly onDidUpdate = this.updateEmitter.event;
  readonly onDidChangeStatus = this.statusEmitter.event;

  private queue = new Map<string, Queued>();
  private listingRequests = new Map<string, ListingRequest>();
  private pending = new Map<string, PendingInfo>();
  private errors = new Map<string, ErrorInfo>();
  private forcedChunks: Coordinate[][] = [];
  private known = new Map<string, LookupTarget>();
  private recentVisible = new Map<string, LookupTarget>();

  private pausedUntil = 0;
  private netState: "ok" | "offline" | "rate_limited" = "ok";
  private offlineBackoff = 0;
  private serverBackoff = 0;
  private unavailableCount = 0;
  private signedIn = false;
  private keyKnown = false;
  private keyRefused = false;

  private flushTimer: unknown;
  private wakeTimer: unknown;
  private wakeAt = 0;
  private running = false;
  private disposed = false;
  private lastStatus: NetworkStatus;

  private readonly requests: TokenBucket;
  private readonly purlsOut: TokenBucket;
  private readonly purlsIn: TokenBucket;

  constructor(
    private readonly client: SemverityClient,
    private readonly cache: ScoreCache,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private options: LookupServiceOptions,
  ) {
    this.requests = new TokenBucket(REQUEST_BURST, clampRate(options.maxRequestsPerMinute), clock);
    this.purlsOut = new TokenBucket(PURLS_SIGNED_OUT.capacity, PURLS_SIGNED_OUT.perMinute, clock);
    this.purlsIn = new TokenBucket(PURLS_SIGNED_IN.capacity, PURLS_SIGNED_IN.perMinute, clock);
    this.lastStatus = this.status();
    void this.refreshKeyState();
  }

  // ---- public surface -------------------------------------------------------

  updateOptions(options: LookupServiceOptions): void {
    const wasEnabled = this.options.networkEnabled;
    this.options = options;
    this.requests.configure(REQUEST_BURST, clampRate(options.maxRequestsPerMinute));
    if (wasEnabled && !options.networkEnabled) {
      this.drainWaiters();
      this.queue.clear();
      this.forcedChunks = [];
    }
    this.emitStatus();
    if (!wasEnabled && options.networkEnabled) this.scheduleFlush();
  }

  status(): NetworkStatus {
    const s: NetworkStatus = { state: "ok", signedIn: this.signedIn && !this.keyRefused };
    if (!this.options.networkEnabled) s.state = "disabled";
    else if (this.netState === "rate_limited") {
      s.state = "rate_limited";
      s.retryAt = this.pausedUntil;
    } else if (this.netState === "offline") {
      s.state = "offline";
      s.retryAt = this.pausedUntil;
    } else if (this.keyRefused) s.state = "unauthorized";
    return s;
  }

  peek(target: LookupTarget): LookupResult | undefined {
    if (target.version !== undefined) {
      return this.resultFor({ ...target.id, version: target.version }, target.versionSource);
    }
    const lk = listKey(target.id);
    const entry = this.cache.peek(lk);
    if (entry) {
      if (entry.value.kind === "not_scored") {
        return {
          state: "not_scored",
          versionSource: target.versionSource,
          reason: entry.value.reason,
          validatedAt: entry.validatedAt,
          stale: this.cache.isStale(entry),
        };
      }
      if (entry.value.kind === "listing") {
        const listing = entry.value.listing;
        const version = chooseVersion(target, listing);
        if (version === undefined) {
          if (listing.allVersionsTruncated) return this.fallback(lk);
          return {
            state: "not_scored",
            versionSource: target.versionSource,
            reason: "not_found",
            listing: publicListing(listing),
            validatedAt: entry.validatedAt,
            stale: this.cache.isStale(entry),
          };
        }
        const c = { ...target.id, version };
        const r = this.resultFor(c, target.versionSource);
        if (r && (r.state === "scored" || r.state === "not_scored" || r.state === "pending")) return r;
        // No card yet: the listing's entry for the version answers until it arrives.
        return this.listingAnswer(c, target.versionSource, listing, entry) ?? r;
      }
    }
    const p = this.pending.get(lk);
    if (p) return { state: "pending", retryAt: p.retryAt };
    return this.fallback(lk);
  }

  request(targets: LookupTarget[], priority: Priority): void {
    if (this.disposed) return;
    for (const t of targets) {
      const key = this.remember(t, priority);
      if (!this.options.networkEnabled || !this.needsWork(t)) continue;
      this.enqueue(t, key, priority);
    }
    this.scheduleFlush();
  }

  resolve(targets: LookupTarget[], priority: Priority, options: { full?: boolean } = {}): Promise<Map<string, LookupResult>> {
    const entries = targets.map(async (t): Promise<[string, LookupResult]> => {
      const key = this.remember(t, priority);
      if (!this.options.networkEnabled || this.disposed || !this.needsWork(t)) return [key, this.peek(t) ?? this.fallbackResult(t)];
      if (this.netState === "offline" && this.pausedUntil > this.clock.now()) {
        // Offline: answer from the cache now and retry in the background.
        this.enqueue(t, key, priority);
        return [key, this.peek(t) ?? this.fallbackResult(t)];
      }
      return [
        key,
        await new Promise<LookupResult>((resolve) => {
          const q = this.enqueue(t, key, priority);
          (options.full ? q.fullWaiters : q.waiters).push(resolve);
        }),
      ];
    });
    this.scheduleFlush();
    return Promise.all(entries).then((list) => new Map(list));
  }

  async listing(id: PackageId): Promise<ListingSummary | undefined> {
    const lk = listKey(id);
    const entry = this.cache.peek(lk);
    const cached = entry?.value.kind === "listing" ? entry.value.listing : undefined;
    if (entry && !this.cache.isDue(entry)) {
      return cached ? publicListing(cached) : undefined;
    }
    if (!this.options.networkEnabled || this.disposed || this.isWaiting(lk)) return cached ? publicListing(cached) : undefined;
    if (entry) {
      // Stale while revalidate: answer now, recheck in the background.
      this.requestListing(id, "background");
      return cached ? publicListing(cached) : undefined;
    }
    return new Promise<ListingSummary | undefined>((resolve) => {
      this.requestListing(id, "visible").waiters.push(resolve);
    });
  }

  invalidate(ids?: PackageId[]): void {
    this.cache.invalidate(ids);
    const keys = ids ? new Set(ids.map((id) => packageKey(id))) : undefined;
    const matches = (k: string): boolean => {
      if (!keys) return true;
      const body = k.slice(k.indexOf(":") + 1);
      for (const p of keys) if (body === p || body.startsWith(`${p}@`)) return true;
      return false;
    };
    for (const k of [...this.pending.keys()]) if (matches(k)) this.pending.delete(k);
    for (const k of [...this.errors.keys()]) if (matches(k)) this.errors.delete(k);
    const affected: string[] = [];
    const again: LookupTarget[] = [];
    for (const [tk, t] of this.known) {
      if (!keys || keys.has(packageKey(t.id))) {
        affected.push(tk);
        if (this.recentVisible.has(tk)) again.push(t);
      }
    }
    if (affected.length) this.updateEmitter.fire(affected);
    if (again.length) this.request(again, "visible");
  }

  async clear(): Promise<void> {
    await this.cache.clear();
    this.pending.clear();
    this.errors.clear();
    const all = [...this.known.keys()];
    if (all.length) this.updateEmitter.fire(all);
  }

  /** Call when the API key was set or cleared: negative answers are dropped, since a key changes what is found. */
  apiKeyChanged(): void {
    this.cache.dropNegative();
    for (const [k, p] of [...this.pending]) if (p.retryAt === Number.POSITIVE_INFINITY) this.pending.delete(k);
    void this.refreshKeyState(true).then(() => {
      const all = [...this.known.keys()];
      if (all.length) this.updateEmitter.fire(all);
      const again = [...this.recentVisible.values()];
      if (again.length) this.request(again, "visible");
    });
  }

  /** Drops queued work for packages the predicate refuses (a new exclusion or a disabled ecosystem). */
  dropQueued(refuse: (id: PackageId) => boolean): void {
    for (const [key, q] of [...this.queue]) {
      if (!refuse(q.target.id)) continue;
      this.queue.delete(key);
      const r = this.peek(q.target) ?? this.fallbackResult(q.target);
      for (const w of [...q.waiters.splice(0), ...q.fullWaiters.splice(0)]) w(r);
    }
    for (const [key, r] of [...this.listingRequests]) {
      if (!refuse(r.id)) continue;
      this.listingRequests.delete(key);
      for (const w of r.waiters.splice(0)) w(undefined);
    }
    this.forcedChunks = this.forcedChunks.map((chunk) => chunk.filter((c) => !refuse(c))).filter((chunk) => chunk.length > 0);
  }

  dispose(): void {
    this.disposed = true;
    if (this.flushTimer !== undefined) this.clock.clearTimeout(this.flushTimer);
    if (this.wakeTimer !== undefined) this.clock.clearTimeout(this.wakeTimer);
    this.flushTimer = undefined;
    this.wakeTimer = undefined;
    this.drainWaiters();
    this.queue.clear();
    this.updateEmitter.dispose();
    this.statusEmitter.dispose();
  }

  // ---- results --------------------------------------------------------------

  private cachedListing(id: PackageId): ListingSummary | undefined {
    const e = this.cache.peek(listKey(id));
    return e?.value.kind === "listing" ? publicListing(e.value.listing) : undefined;
  }

  private resultFor(c: Coordinate, versionSource: VersionSource): LookupResult | undefined {
    const ck = cardKey(coordinateKey(c));
    const entry = this.cache.peek(ck);
    const listing = this.cachedListing(c);
    if (entry) {
      const stale = this.cache.isStale(entry);
      if (entry.value.kind === "card") {
        const r: LookupResult = { state: "scored", coordinate: c, versionSource, card: entry.value.card, validatedAt: entry.validatedAt, stale };
        if (listing) r.listing = listing;
        return r;
      }
      if (entry.value.kind === "not_scored") {
        const r: LookupResult = { state: "not_scored", coordinate: c, versionSource, reason: entry.value.reason, validatedAt: entry.validatedAt, stale };
        if (listing) r.listing = listing;
        return r;
      }
    }
    const p = this.pending.get(ck);
    if (p) return { state: "pending", coordinate: c, retryAt: p.retryAt };
    return this.fallback(ck);
  }

  /** A scored answer from the listing's entry for `c`, while its card is not cached. */
  private listingAnswer(c: Coordinate, versionSource: VersionSource, listing: ListingSummary, entry: CacheEntry): LookupResult | undefined {
    const v = listing.versions.find((x) => x.version === c.version);
    const card = v ? cardFromListing(c, v) : undefined;
    if (!card) return undefined;
    return {
      state: "scored",
      coordinate: c,
      versionSource,
      card,
      listing: publicListing(listing),
      validatedAt: entry.validatedAt,
      stale: this.cache.isStale(entry),
    };
  }

  /** True when the listing can answer a target for coordinate `c` before its card arrives. */
  private answeredByListing(t: LookupTarget, c: Coordinate): boolean {
    if (t.version !== undefined) return false;
    const e = this.cache.peek(listKey(t.id));
    if (e?.value.kind !== "listing") return false;
    const v = e.value.listing.versions.find((x) => x.version === c.version);
    return v !== undefined && cardFromListing(c, v) !== undefined;
  }

  private fallback(key: string): LookupResult | undefined {
    if (!this.options.networkEnabled) return { state: "disabled" };
    const err = this.errors.get(key);
    if (err) return err.retryAt !== undefined ? { state: "error", message: err.message, retryAt: err.retryAt } : { state: "error", message: err.message };
    if (this.netState === "offline") return { state: "offline", retryAt: this.pausedUntil };
    if (this.netState === "rate_limited") return { state: "rate_limited", retryAt: this.pausedUntil };
    return undefined;
  }

  private fallbackResult(t: LookupTarget): LookupResult {
    if (!this.options.networkEnabled) return { state: "disabled" };
    return this.peek(t) ?? { state: "error", message: "No answer from the Semverity API." };
  }

  // ---- bookkeeping ----------------------------------------------------------

  private remember(t: LookupTarget, priority: Priority): string {
    const key = targetKeyOf(t);
    this.known.delete(key);
    this.known.set(key, t);
    if (this.known.size > KNOWN_LIMIT) {
      const oldest = this.known.keys().next().value;
      if (oldest !== undefined) this.known.delete(oldest);
    }
    if (priority === "visible") {
      this.recentVisible.delete(key);
      this.recentVisible.set(key, t);
      if (this.recentVisible.size > RECENT_VISIBLE_LIMIT) {
        const oldest = this.recentVisible.keys().next().value;
        if (oldest !== undefined) this.recentVisible.delete(oldest);
      }
    }
    return key;
  }

  private enqueue(t: LookupTarget, key: string, priority: Priority): Queued {
    const existing = this.queue.get(key);
    if (existing) {
      if (priority === "visible") existing.priority = "visible";
      return existing;
    }
    const q: Queued = { target: t, key, priority, waiters: [], fullWaiters: [] };
    this.queue.set(key, q);
    return q;
  }

  private requestListing(id: PackageId, priority: Priority): ListingRequest {
    const pk = packageKey(id);
    let r = this.listingRequests.get(pk);
    if (!r) {
      r = { id, priority, waiters: [] };
      this.listingRequests.set(pk, r);
    } else if (priority === "visible") r.priority = "visible";
    this.scheduleFlush();
    return r;
  }

  /** True while a key waits for a pending poll or an error retry. */
  private isWaiting(key: string): boolean {
    const p = this.pending.get(key);
    if (p && p.retryAt > this.clock.now()) return true;
    const e = this.errors.get(key);
    if (e && (e.attempts >= MAX_ERROR_ATTEMPTS || (e.retryAt !== undefined && e.retryAt > this.clock.now()))) return true;
    return false;
  }

  private entryNeedsFetch(key: string, entry: CacheEntry | undefined): boolean {
    if (this.isWaiting(key)) return false;
    return !entry || this.cache.isDue(entry);
  }

  /** The coordinate a target resolves to now (through the cached listing for range and latest targets). */
  private coordinateOf(t: LookupTarget): Coordinate | undefined {
    if (t.version !== undefined) return { ...t.id, version: t.version };
    const e = this.cache.peek(listKey(t.id));
    if (e?.value.kind !== "listing") return undefined;
    const v = chooseVersion(t, e.value.listing);
    return v === undefined ? undefined : { ...t.id, version: v };
  }

  private listingNeeded(t: LookupTarget): boolean {
    if (t.version !== undefined) return false;
    const lk = listKey(t.id);
    const e = this.cache.peek(lk);
    if (e?.value.kind === "listing" && e.value.listing.allVersionsTruncated && chooseVersion(t, e.value.listing) === undefined) {
      return !this.isWaiting(lk);
    }
    return this.entryNeedsFetch(lk, e);
  }

  private needsWork(t: LookupTarget): boolean {
    if (this.listingNeeded(t)) return true;
    const c = this.coordinateOf(t);
    if (!c) return false;
    const ck = cardKey(coordinateKey(c));
    return this.entryNeedsFetch(ck, this.cache.peek(ck));
  }

  // ---- scheduling -----------------------------------------------------------

  private scheduleFlush(): void {
    if (this.disposed || this.running || this.flushTimer !== undefined) return;
    if (this.queue.size === 0 && this.listingRequests.size === 0 && this.forcedChunks.length === 0) return;
    if (this.wakeTimer !== undefined) return;
    this.flushTimer = this.clock.setTimeout(() => {
      this.flushTimer = undefined;
      void this.pump();
    }, COALESCE_MS);
  }

  private scheduleWake(ms: number): void {
    const at = this.clock.now() + Math.max(0, ms);
    if (this.wakeTimer !== undefined) {
      if (this.wakeAt <= at) return;
      this.clock.clearTimeout(this.wakeTimer);
    }
    this.wakeAt = at;
    this.wakeTimer = this.clock.setTimeout(() => {
      this.wakeTimer = undefined;
      void this.pump();
    }, Math.max(0, ms));
  }

  private async refreshKeyState(force = false): Promise<void> {
    let key: string | undefined;
    try {
      key = await this.client.usableKey();
    } catch {
      key = undefined;
    }
    const signedIn = key !== undefined;
    const refused = this.client.keyRefused();
    if (this.keyKnown && (signedIn !== this.signedIn || force)) this.cache.dropNegative();
    this.signedIn = signedIn;
    this.keyKnown = true;
    this.keyRefused = refused;
    this.emitStatus();
  }

  private emitStatus(): void {
    const s = this.status();
    const prev = this.lastStatus;
    if (prev.state !== s.state || prev.retryAt !== s.retryAt || prev.signedIn !== s.signedIn) {
      this.lastStatus = s;
      this.statusEmitter.fire(s);
    }
  }

  private async pump(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      for (;;) {
        if (this.disposed || !this.options.networkEnabled) break;
        const now = this.clock.now();
        if (this.pausedUntil > now) {
          this.scheduleWake(this.pausedUntil - now);
          break;
        }
        await this.refreshKeyState();
        const step = this.plan();
        if (!step) break;
        const purls = step.type === "batch" ? step.coordinates.length : 1;
        const purlBucket = this.signedIn ? this.purlsIn : this.purlsOut;
        const wait = Math.max(this.requests.wait(1), purlBucket.wait(purls));
        if (wait > 0) {
          this.scheduleWake(wait);
          break;
        }
        this.requests.take(1);
        purlBucket.take(purls);
        if (step.type !== "listing" && step.forced) this.forcedChunks.shift();
        const changed = await this.execute(step);
        this.keyRefused = this.client.keyRefused();
        this.settle();
        this.notify(changed);
        this.emitStatus();
      }
    } catch (e) {
      this.logger.error(`Lookup queue failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.running = false;
      this.settle();
      this.scheduleNextPoll();
      if (this.wakeTimer === undefined && this.pausedUntil <= this.clock.now()) {
        // Work that arrived while the last request was in flight.
        if (this.plan() !== undefined) this.scheduleFlush();
      }
    }
  }

  /** Chooses the next request: listings, then cards, visible work first. */
  private plan(): Step | undefined {
    for (const priority of ["visible", "background"] as const) {
      // Listings for range and latest targets, and explicit listing requests.
      for (const r of this.listingRequests.values()) {
        if (r.priority !== priority) continue;
        const lk = listKey(r.id);
        if (this.isWaiting(lk)) continue;
        return this.listingStep(r.id);
      }
      for (const q of this.queue.values()) {
        if (q.target.version !== undefined || !this.listingNeeded(q.target)) continue;
        const lk = listKey(q.target.id);
        const missing = !this.cache.peek(lk);
        // A missing listing is fetched at the target's priority; a revalidation at background priority.
        if ((missing ? q.priority : "background") !== priority) continue;
        return this.listingStep(q.target.id);
      }

      if (priority === "visible" && this.forcedChunks.length > 0) {
        const chunk = this.forcedChunks[0] as Coordinate[];
        return chunk.length === 1 ? { type: "card", coordinate: chunk[0] as Coordinate, forced: true } : { type: "batch", coordinates: chunk, forced: true };
      }

      const due: { c: Coordinate; etag?: string }[] = [];
      const seen = new Set<string>();
      const collect = (pr: Priority): void => {
        for (const q of this.queue.values()) {
          const c = this.coordinateOf(q.target);
          if (!c) continue;
          const ck = cardKey(coordinateKey(c));
          if (seen.has(ck)) continue;
          const e = this.cache.peek(ck);
          if (!this.entryNeedsFetch(ck, e)) continue;
          // A revalidation, or a card whose score the listing already shows,
          // waits for background capacity unless a hover is waiting for it.
          const deferred = e !== undefined || (q.fullWaiters.length === 0 && this.answeredByListing(q.target, c));
          const effective: Priority = deferred ? "background" : q.priority;
          if (effective !== pr) continue;
          seen.add(ck);
          const item: { c: Coordinate; etag?: string } = { c };
          if (e?.etag) item.etag = e.etag;
          due.push(item);
        }
      };
      collect(priority);
      if (due.length === 0) continue;
      // Conditional revalidation of a card that came with an ETag.
      const withEtag = due.find((d) => d.etag);
      if (withEtag) return { type: "card", coordinate: withEtag.c, etag: withEtag.etag as string };
      if (priority === "visible") collect("background");
      const plain = due.filter((d) => !d.etag);
      if (plain.length === 1) return { type: "card", coordinate: (plain[0] as { c: Coordinate }).c };
      const size = this.signedIn ? CHUNK_SIGNED_IN : CHUNK_SIGNED_OUT;
      return { type: "batch", coordinates: plain.slice(0, size).map((d) => d.c) };
    }
    return undefined;
  }

  private listingStep(id: PackageId): Step {
    const e = this.cache.peek(listKey(id));
    const truncated = e?.value.kind === "listing" && e.value.listing.allVersionsTruncated;
    const step: Step = { type: "listing", id };
    if (e?.etag && !truncated) step.etag = e.etag;
    return step;
  }

  // ---- execution ------------------------------------------------------------

  private async execute(step: Step): Promise<Set<string>> {
    const changed = new Set<string>();
    if (step.type === "listing") {
      const lk = listKey(step.id);
      const out = await this.client.listing(step.id, step.etag);
      this.applyGet(lk, out, changed, (v: PackageList) => {
        const s = summarizeListing(v);
        return s ? { kind: "listing", listing: s } : undefined;
      });
      const pk = packageKey(step.id);
      const req = this.listingRequests.get(pk);
      if (req && !(out.kind === "rate_limited" || out.kind === "unavailable")) {
        this.listingRequests.delete(pk);
        const listing = this.cachedListing(step.id);
        for (const w of req.waiters) w(listing);
      }
      return changed;
    }
    if (step.type === "card") {
      const ck = cardKey(coordinateKey(step.coordinate));
      const out = await this.client.card(step.coordinate, step.etag);
      this.applyGet(ck, out, changed, (v: PackageCard) => {
        const s = summarizeCard(v);
        return s ? { kind: "card", card: s } : undefined;
      });
      return changed;
    }
    const out = await this.client.batch(step.coordinates);
    this.applyBatch(step.coordinates, out, changed);
    return changed;
  }

  private succeeded(): void {
    this.netState = "ok";
    this.offlineBackoff = 0;
    this.serverBackoff = 0;
    this.unavailableCount = 0;
    this.pausedUntil = 0;
  }

  private applyGet<T>(
    key: string,
    out: GetOutcome<T>,
    changed: Set<string>,
    toValue: (v: T) => { kind: "listing"; listing: ListingSummary } | { kind: "card"; card: CardSummary } | undefined,
  ): void {
    switch (out.kind) {
      case "ok": {
        this.succeeded();
        const value = toValue(out.value);
        const meta: { maxAgeSec?: number; etag?: string } = {};
        if (out.cache.maxAgeSec !== undefined && !out.cache.noStore) meta.maxAgeSec = out.cache.maxAgeSec;
        if (out.etag) meta.etag = out.etag;
        this.cache.set(key, value ?? { kind: "not_scored", reason: "invalid" }, meta);
        this.pending.delete(key);
        this.errors.delete(key);
        changed.add(key);
        return;
      }
      case "not_modified": {
        this.succeeded();
        const meta: { maxAgeSec?: number } = {};
        if (out.cache.maxAgeSec !== undefined) meta.maxAgeSec = out.cache.maxAgeSec;
        this.cache.renew(key, meta);
        this.errors.delete(key);
        changed.add(key);
        return;
      }
      case "not_found": {
        this.succeeded();
        const meta: { maxAgeSec?: number } = {};
        if (out.cache.maxAgeSec !== undefined) meta.maxAgeSec = out.cache.maxAgeSec;
        this.cache.set(key, { kind: "not_scored", reason: out.reason }, meta);
        this.pending.delete(key);
        this.errors.delete(key);
        changed.add(key);
        return;
      }
      case "invalid":
        this.succeeded();
        this.cache.set(key, { kind: "not_scored", reason: "invalid" });
        changed.add(key);
        return;
      case "pending":
        this.succeeded();
        this.markPending(key, out.retryAfterMs);
        changed.add(key);
        return;
      default:
        this.applyFailure(out, [key], changed);
    }
  }

  private applyBatch(coords: Coordinate[], out: BatchOutcome, changed: Set<string>): void {
    const keys = coords.map((c) => cardKey(coordinateKey(c)));
    if (out.kind === "too_large") {
      if (coords.length === 1) {
        this.cache.set(keys[0] as string, { kind: "not_scored", reason: "invalid" });
        changed.add(keys[0] as string);
      } else {
        const half = Math.ceil(coords.length / 2);
        this.forcedChunks.unshift(coords.slice(0, half), coords.slice(half));
      }
      return;
    }
    if (out.kind !== "ok") {
      this.applyFailure(out, keys, changed);
      return;
    }
    this.succeeded();
    for (const c of coords) {
      const ck = cardKey(coordinateKey(c));
      const item = out.items.get(coordinateKey(c));
      if (!item || item.kind === "not_indexed") this.cache.set(ck, { kind: "not_scored", reason: "not_indexed" });
      else if (item.kind === "invalid") this.cache.set(ck, { kind: "not_scored", reason: "invalid" });
      else if (item.kind === "pending") {
        this.markPending(ck, item.retryAfterMs);
        changed.add(ck);
        continue;
      } else {
        const s = summarizeCard(item.card);
        this.cache.set(ck, s ? { kind: "card", card: s } : { kind: "not_scored", reason: "invalid" });
      }
      this.pending.delete(ck);
      this.errors.delete(ck);
      changed.add(ck);
    }
  }

  private markPending(key: string, retryAfterMs: number): void {
    const prev = this.pending.get(key);
    const polls = (prev?.polls ?? 0) + 1;
    const retryAt = polls > MAX_POLLS ? Number.POSITIVE_INFINITY : this.clock.now() + Math.max(retryAfterMs, 5_000);
    this.pending.set(key, { retryAt, polls });
  }

  private applyFailure(f: Failure, keys: string[], changed: Set<string>): void {
    const now = this.clock.now();
    let delay: number;
    switch (f.kind) {
      case "rate_limited":
        delay = Math.max(f.retryAfterMs, 1000);
        this.netState = "rate_limited";
        this.logger.info(`Rate limited by the Semverity API; pausing lookups for ${Math.round(delay / 1000)} s.`);
        break;
      case "unavailable":
        this.unavailableCount++;
        delay = Math.min(
          SERVER_MAX_MS,
          this.unavailableCount > 1 ? Math.max(f.retryAfterMs ?? 0, SERVER_FIRST_MS * 2 ** (this.unavailableCount - 2)) : (f.retryAfterMs ?? SERVER_FIRST_MS),
        );
        this.logger.info(`The Semverity API is busy; retrying in ${Math.round(delay / 1000)} s.`);
        break;
      case "server_error":
        this.serverBackoff = this.serverBackoff === 0 ? SERVER_FIRST_MS : Math.min(SERVER_MAX_MS, this.serverBackoff * 2);
        delay = this.serverBackoff;
        this.logger.warn(`The Semverity API answered ${f.status}; retrying in ${Math.round(delay / 1000)} s.`);
        break;
      case "network_error":
        this.offlineBackoff = this.offlineBackoff === 0 ? OFFLINE_FIRST_MS : Math.min(OFFLINE_MAX_MS, this.offlineBackoff * 2);
        delay = this.offlineBackoff;
        this.netState = "offline";
        this.logger.info(`The Semverity API is not reachable (${f.message}); retrying in ${Math.round(delay / 1000)} s.`);
        break;
    }
    this.pausedUntil = now + delay;
    for (const key of keys) {
      const entry = this.cache.peek(key);
      if (entry) this.cache.markFailure(key);
      else if (f.kind === "server_error" || f.kind === "unavailable") {
        const prev = this.errors.get(key);
        this.errors.set(key, {
          message: f.kind === "server_error" ? `The Semverity API answered ${f.status}.` : "The Semverity API is busy.",
          retryAt: this.pausedUntil,
          attempts: (prev?.attempts ?? 0) + 1,
        });
      }
      changed.add(key);
    }
  }

  /** Resolves the waiters of targets that have an answer (or a definite failure), and drops finished targets. */
  private settle(): void {
    for (const [key, q] of [...this.queue]) {
      const done = this.isSettled(q.target);
      if (done === "no") continue;
      const r = this.peek(q.target) ?? this.fallbackResult(q.target);
      for (const w of q.waiters.splice(0)) w(r);
      // A hover waits for the full card while it is still to come.
      const partial = r.state === "scored" && r.card.fromListing === true && done !== "yes";
      if (!partial) for (const w of q.fullWaiters.splice(0)) w(r);
      if (done === "yes") this.queue.delete(key);
    }
  }

  /** True while a cache key still has work: a fetch now, a revalidation, a pending poll or an error retry. */
  private remaining(key: string, entry: CacheEntry | undefined): boolean {
    const p = this.pending.get(key);
    if (p) return p.retryAt !== Number.POSITIVE_INFINITY;
    const err = this.errors.get(key);
    if (err) return err.attempts < MAX_ERROR_ATTEMPTS;
    return !entry || this.cache.isDue(entry);
  }

  /** "yes": nothing left to do; "answered": waiters can be told, but work remains; "no": no answer yet. */
  private isSettled(t: LookupTarget): "yes" | "answered" | "no" {
    let listWork = false;
    if (t.version === undefined) {
      const lk = listKey(t.id);
      const le = this.cache.peek(lk);
      listWork = this.remaining(lk, le) || (le?.value.kind === "listing" && !!le.value.listing.allVersionsTruncated && chooseVersion(t, le.value.listing) === undefined && !this.isWaiting(lk));
    }
    const c = this.coordinateOf(t);
    let cardWork = false;
    if (c) {
      const ck = cardKey(coordinateKey(c));
      cardWork = this.remaining(ck, this.cache.peek(ck));
    }
    if (!listWork && !cardWork) return "yes";
    return this.peek(t) !== undefined ? "answered" : "no";
  }

  private scheduleNextPoll(): void {
    if (this.disposed || !this.options.networkEnabled) return;
    let next = Number.POSITIVE_INFINITY;
    const now = this.clock.now();
    for (const p of this.pending.values()) if (p.retryAt > now && p.retryAt < next) next = p.retryAt;
    for (const e of this.errors.values()) if (e.attempts < MAX_ERROR_ATTEMPTS && e.retryAt !== undefined && e.retryAt > now && e.retryAt < next) next = e.retryAt;
    if (next !== Number.POSITIVE_INFINITY && this.queue.size > 0) this.scheduleWake(next - now);
  }

  private notify(changed: Set<string>): void {
    if (changed.size === 0) return;
    const keys: string[] = [];
    for (const [tk, t] of this.known) {
      const deps = [listKey(t.id)];
      const c = this.coordinateOf(t);
      if (c) deps.push(cardKey(coordinateKey(c)));
      if (deps.some((d) => changed.has(d))) keys.push(tk);
    }
    if (keys.length) this.updateEmitter.fire(keys);
  }

  private drainWaiters(): void {
    for (const q of this.queue.values()) {
      const r = this.peek(q.target) ?? this.fallbackResult(q.target);
      for (const w of [...q.waiters.splice(0), ...q.fullWaiters.splice(0)]) w(r);
    }
    for (const r of this.listingRequests.values()) {
      const l = this.cachedListing(r.id);
      for (const w of r.waiters.splice(0)) w(l);
    }
    this.listingRequests.clear();
  }
}

function clampRate(n: number): number {
  return Number.isFinite(n) ? Math.min(60, Math.max(1, Math.round(n))) : 60;
}

/** The version a range or latest target resolves to through a listing. */
export function chooseVersion(t: LookupTarget, listing: ListingSummary): string | undefined {
  const all = listing.allVersions ?? listing.versions.map((v) => v.version);
  if (t.range !== undefined && t.range.trim() !== "" && t.versionSource === "range") return pickVersion(t.id.ecosystem, t.range, all);
  return listing.latest ?? pickVersion(t.id.ecosystem, "", all);
}

/** A listing as the presentation sees it (without the full version list). */
function publicListing(l: ListingSummary): ListingSummary {
  const { allVersions: _all, allVersionsTruncated: _t, ...rest } = l;
  return rest;
}
