// The Semverity API client: the only module that calls fetch. Its methods
// accept coordinates and package ids only, so source text, file paths and
// workspace names cannot reach a request by construction. The client sets
// only the headers of docs/DESIGN.md section 4; the Node.js HTTP stack adds
// standard transport headers that carry nothing about the user or workspace.

import type { FetchLike, FetchResponseLike, Logger, SecretSource } from "../ports";
import type { Coordinate, PackageId } from "../types";
import { parseCacheControl, parseRetryAfter, type CacheDirectives } from "./cacheControl";
import { cardPath, coordinateKey, fromPurl, listingPath, toPurl } from "./purl";
import type { BatchResponse, ErrorResponse, PackageCard, PackageList, Pending } from "./types";

export const REQUEST_TIMEOUT_MS = 15_000;

/** Failures shared by every call. */
export type Failure =
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "unavailable"; retryAfterMs?: number }
  | { kind: "server_error"; status: number }
  | { kind: "network_error"; message: string };

export type GetOutcome<T> =
  | { kind: "ok"; value: T; etag?: string; cache: CacheDirectives }
  | { kind: "not_modified"; cache: CacheDirectives }
  | { kind: "not_found"; reason: "not_indexed" | "not_found"; cache: CacheDirectives }
  | { kind: "pending"; retryAfterMs: number }
  | { kind: "invalid" }
  | Failure;

export type BatchItem =
  | { kind: "card"; card: PackageCard }
  | { kind: "not_indexed" }
  | { kind: "invalid" }
  | { kind: "pending"; retryAfterMs: number };

export type BatchOutcome =
  | { kind: "ok"; items: Map<string, BatchItem>; cache: CacheDirectives }
  /** 400 or 413: the caller splits the batch. */
  | { kind: "too_large" }
  | Failure;

export interface ClientOptions {
  apiBaseUrl: string;
  userAgent: string;
}

export interface ClientDeps {
  fetch: FetchLike;
  secrets: SecretSource;
  logger: Logger;
  now: () => number;
}

/** True when the API key may be sent to this base URL: https, or http on a loopback host. */
export function mayCarryKey(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(u.hostname);
  } catch {
    return false;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class SemverityClient {
  private options: ClientOptions;
  /** The key the API refused (401 or 403); not sent again this session unless it changes. */
  private refusedKey: string | undefined;
  private lastKeyRefused = false;

  constructor(
    private readonly deps: ClientDeps,
    options: ClientOptions,
  ) {
    this.options = options;
  }

  setOptions(options: ClientOptions): void {
    this.options = options;
  }

  /** The key to send, or undefined when none is stored, it was refused, or the base URL may not carry it. */
  async usableKey(): Promise<string | undefined> {
    let key: string | undefined;
    try {
      key = (await this.deps.secrets.getApiKey())?.trim() || undefined;
    } catch {
      key = undefined;
    }
    if (!key) {
      this.refusedKey = undefined;
      this.lastKeyRefused = false;
      return undefined;
    }
    if (key === this.refusedKey) return undefined;
    if (this.refusedKey !== undefined) {
      // The key changed since it was refused: try the new one.
      this.refusedKey = undefined;
      this.lastKeyRefused = false;
    }
    return mayCarryKey(this.options.apiBaseUrl) ? key : undefined;
  }

  /** True while the stored key is refused by the API. */
  keyRefused(): boolean {
    return this.lastKeyRefused;
  }

  private url(pathAndQuery: string): string {
    return `${this.options.apiBaseUrl.replace(/\/+$/, "")}${pathAndQuery}`;
  }

  private headers(key: string | undefined, extra: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json", "User-Agent": this.options.userAgent, ...extra };
    if (key) h.Authorization = `Bearer ${key}`;
    return h;
  }

  /** Sends one request; on 401 or 403 with a key, forgets the key for the session and retries once signed out. */
  private async send(method: "GET" | "POST", path: string, extra: Record<string, string>, body?: string): Promise<FetchResponseLike | { error: string }> {
    const key = await this.usableKey();
    const attempt = async (k: string | undefined): Promise<FetchResponseLike | { error: string }> => {
      const init: Parameters<FetchLike>[1] = { method, headers: this.headers(k, extra) };
      if (body !== undefined) init.body = body;
      try {
        if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") init.signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      } catch {
        // No timeout support: the request still runs.
      }
      try {
        return await this.deps.fetch(this.url(path), init);
      } catch (e) {
        return { error: e instanceof Error ? e.name || "network error" : "network error" };
      }
    };
    const res = await attempt(key);
    if (key && "status" in res && (res.status === 401 || res.status === 403)) {
      this.refusedKey = key;
      this.lastKeyRefused = true;
      this.deps.logger.warn(`The API refused the stored API key (${res.status}); continuing signed out.`);
      return attempt(undefined);
    }
    return res;
  }

  private async readJson(res: FetchResponseLike): Promise<unknown> {
    try {
      const text = await res.text();
      return text === "" ? undefined : (JSON.parse(text) as unknown);
    } catch {
      return undefined;
    }
  }

  private failure(res: FetchResponseLike, path: string, body: unknown): Failure {
    const now = this.deps.now();
    if (isRecord(body)) {
      const err = body as Partial<ErrorResponse>;
      this.deps.logger.debug(`${res.status} ${String(err.code ?? "")} for ${path}${err.request_id ? ` (request ${err.request_id})` : ""}`);
    }
    if (res.status === 429) return { kind: "rate_limited", retryAfterMs: parseRetryAfter(res.headers.get("retry-after"), now) ?? 60_000 };
    if (res.status === 503) {
      const retry = parseRetryAfter(res.headers.get("retry-after"), now);
      return retry === undefined ? { kind: "unavailable" } : { kind: "unavailable", retryAfterMs: retry };
    }
    return { kind: "server_error", status: res.status };
  }

  private pendingDelay(res: FetchResponseLike, body: unknown): number {
    const header = parseRetryAfter(res.headers.get("retry-after"), this.deps.now()) ?? 0;
    const fromBody = isRecord(body) && typeof body.retry_after_seconds === "number" ? body.retry_after_seconds * 1000 : 0;
    return Math.max(header, fromBody, 5_000);
  }

  private async get<T>(path: string, etag: string | undefined, validate: (v: unknown) => v is T): Promise<GetOutcome<T>> {
    const extra: Record<string, string> = {};
    if (etag) extra["If-None-Match"] = etag;
    const res = await this.send("GET", path, extra);
    if ("error" in res) return { kind: "network_error", message: res.error };
    const cache = parseCacheControl(res.headers.get("cache-control"));
    if (res.status === 304) return { kind: "not_modified", cache };
    const body = await this.readJson(res);
    if (res.status === 200) {
      if (!validate(body)) return { kind: "server_error", status: 200 };
      const out: GetOutcome<T> = { kind: "ok", value: body, cache };
      const tag = res.headers.get("etag");
      if (tag) out.etag = tag;
      return out;
    }
    if (res.status === 202) return { kind: "pending", retryAfterMs: this.pendingDelay(res, body) };
    if (res.status === 404) {
      const code = isRecord(body) ? body.code : undefined;
      return { kind: "not_found", reason: code === "not_found" ? "not_found" : "not_indexed", cache };
    }
    if (res.status === 400 || res.status === 413) return { kind: "invalid" };
    if (res.status === 401 || res.status === 403) return { kind: "server_error", status: res.status };
    return this.failure(res, path, body);
  }

  /** GET /v1/packages/{ecosystem}/{name}/versions/{version}: one card, conditional when an ETag is given. */
  card(c: Coordinate, etag?: string): Promise<GetOutcome<PackageCard>> {
    return this.get(cardPath(c), etag, isCard);
  }

  /** GET /v1/packages/{ecosystem}/{name}: the version listing with latest and healthy. */
  listing(id: PackageId, etag?: string): Promise<GetOutcome<PackageList>> {
    return this.get(listingPath(id), etag, isListing);
  }

  /**
   * POST /v1/packages:batch. Answers are matched to the requested coordinates
   * by purl, never by position; a requested purl the answer does not mention
   * counts as not indexed.
   */
  async batch(coords: Coordinate[]): Promise<BatchOutcome> {
    const purls: string[] = [];
    const requested = new Map<string, string>(); // coordinateKey -> purl
    for (const c of coords) {
      const k = coordinateKey(c);
      if (requested.has(k)) continue;
      const p = toPurl(c);
      requested.set(k, p);
      purls.push(p);
    }
    const body = JSON.stringify({ purls });
    const res = await this.send("POST", "/v1/packages:batch", { "Content-Type": "application/json" }, body);
    if ("error" in res) return { kind: "network_error", message: res.error };
    const json = await this.readJson(res);
    if (res.status === 400 || res.status === 413) return { kind: "too_large" };
    if (res.status !== 200 && res.status !== 202) {
      if (res.status === 401 || res.status === 403) return { kind: "server_error", status: res.status };
      return this.failure(res, "/v1/packages:batch", json);
    }
    if (!isRecord(json)) return { kind: "server_error", status: res.status };
    const answer = json as Partial<BatchResponse>;
    const items = new Map<string, BatchItem>();
    const keyOf = (purl: unknown): string | undefined => {
      if (typeof purl !== "string") return undefined;
      const c = fromPurl(purl);
      return c ? coordinateKey(c) : undefined;
    };
    for (const card of Array.isArray(answer.cards) ? answer.cards : []) {
      if (!isCard(card)) continue;
      const k = keyOf(card.purl);
      if (k && requested.has(k)) items.set(k, { kind: "card", card });
    }
    for (const purl of Array.isArray(answer.not_indexed) ? answer.not_indexed : []) {
      const k = keyOf(purl);
      if (k && requested.has(k) && !items.has(k)) items.set(k, { kind: "not_indexed" });
    }
    for (const purl of Array.isArray(answer.invalid) ? answer.invalid : []) {
      const k = keyOf(purl);
      if (k && requested.has(k) && !items.has(k)) items.set(k, { kind: "invalid" });
    }
    const header = parseRetryAfter(res.headers.get("retry-after"), this.deps.now()) ?? 0;
    for (const p of Array.isArray(answer.pending) ? answer.pending : []) {
      if (!isRecord(p)) continue;
      const pending = p as Partial<Pending>;
      const k = keyOf(pending.purl);
      if (!k || !requested.has(k) || items.has(k)) continue;
      const fromBody = typeof pending.retry_after_seconds === "number" ? pending.retry_after_seconds * 1000 : 0;
      items.set(k, { kind: "pending", retryAfterMs: Math.max(header, fromBody, 5_000) });
    }
    for (const k of requested.keys()) {
      if (!items.has(k)) items.set(k, { kind: "not_indexed" });
    }
    return { kind: "ok", items, cache: parseCacheControl(res.headers.get("cache-control")) };
  }
}

function isCard(v: unknown): v is PackageCard {
  return isRecord(v) && typeof v.purl === "string" && typeof v.ecosystem === "string" && typeof v.name === "string" && typeof v.version === "string";
}

function isListing(v: unknown): v is PackageList {
  return isRecord(v) && typeof v.ecosystem === "string" && typeof v.name === "string" && (v.versions === undefined || Array.isArray(v.versions));
}
