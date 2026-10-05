import { describe, expect, it } from "vitest";
import { LIFETIME_FLOOR_MS, MAX_ENTRIES, PERSISTED_VERSIONS_CAP, ScoreCache, cardKey, listKey, storageKey } from "../../../src/core/cache/scoreCache";
import { summarizeCard, summarizeListing } from "../../../src/core/api/summary";
import { FakeClock } from "../../helpers/fakeClock";
import { MemoryStore } from "../../helpers/memoryStore";
import { apiCard, apiListing, must } from "../builders";

const HOUR = 3_600_000;
const card = must(summarizeCard(apiCard("npm", "lodash", "4.18.1")));
const opts = { apiBaseUrl: "https://api.semverity.dev", ttlMs: 24 * HOUR, negativeTtlMs: HOUR };

function setup() {
  const clock = new FakeClock();
  const store = new MemoryStore();
  const cache = new ScoreCache(store, clock, opts);
  return { clock, store, cache };
}

describe("ScoreCache lifetimes", () => {
  it("uses max-age when present, else the TTL, with a 15 minute floor", () => {
    const { clock, cache } = setup();
    const now = clock.now();
    expect(cache.set("card:a", { kind: "card", card }).freshUntil).toBe(now + 24 * HOUR);
    expect(cache.set("card:b", { kind: "card", card }, { maxAgeSec: 300 }).freshUntil).toBe(now + LIFETIME_FLOOR_MS);
    expect(cache.set("card:c", { kind: "card", card }, { maxAgeSec: 7200 }).freshUntil).toBe(now + 2 * HOUR);
  });

  it("gives negative answers the longer of max-age and the negative TTL", () => {
    const { clock, cache } = setup();
    const now = clock.now();
    expect(cache.set("card:n", { kind: "not_scored", reason: "not_indexed" }, { maxAgeSec: 60 }).freshUntil).toBe(now + HOUR);
    expect(cache.set("card:m", { kind: "not_scored", reason: "not_indexed" }, { maxAgeSec: 7200 }).freshUntil).toBe(now + 2 * HOUR);
  });

  it("marks entries stale after a whole TTL, or past freshness with a failed attempt", async () => {
    const { clock, cache } = setup();
    const e = cache.set("card:a", { kind: "card", card }, { maxAgeSec: 300 });
    expect(cache.isDue(e)).toBe(false);
    await clock.advance(LIFETIME_FLOOR_MS);
    expect(cache.isDue(e)).toBe(true);
    expect(cache.isStale(e)).toBe(false);
    cache.markFailure("card:a");
    expect(cache.isStale(e)).toBe(true);
    cache.renew("card:a", { maxAgeSec: 300 });
    expect(cache.isStale(e)).toBe(false);
    expect(cache.isDue(e)).toBe(false);
    await clock.advance(24 * HOUR + 1);
    expect(cache.isStale(e)).toBe(true);
  });
});

describe("ScoreCache persistence", () => {
  it("round-trips through the store, written after a delay", async () => {
    const { clock, store, cache } = setup();
    cache.set(cardKey("npm:lodash@4.18.1"), { kind: "card", card }, { etag: '"x"' });
    expect(store.writes).toBe(0);
    await clock.advance(5000);
    expect(store.writes).toBe(1);
    const again = new ScoreCache(store, clock, opts);
    expect(again.peek(cardKey("npm:lodash@4.18.1"))).toMatchObject({ value: { kind: "card", card: { name: "lodash" } }, etag: '"x"' });
  });

  it("keeps one partition per API base URL", async () => {
    const { clock, store, cache } = setup();
    cache.set("card:a", { kind: "card", card });
    await cache.flush();
    await cache.setOptions({ ...opts, apiBaseUrl: "http://localhost:8080" });
    expect(cache.peek("card:a")).toBeUndefined();
    expect(storageKey("https://api.semverity.dev")).not.toBe(storageKey("http://localhost:8080"));
    expect(storageKey("https://api.semverity.dev/")).toBe(storageKey("https://api.semverity.dev"));
    await cache.setOptions(opts);
    expect(cache.peek("card:a")).toBeDefined();
    expect(new ScoreCache(store, clock, opts).size).toBe(1);
  });

  it("drops an unreadable or other-schema value", () => {
    const store = new MemoryStore();
    store.data.set(storageKey(opts.apiBaseUrl), { schema: 99, entries: [] });
    const cache = new ScoreCache(store, new FakeClock(), opts);
    expect(cache.size).toBe(0);
    expect(store.data.has(storageKey(opts.apiBaseUrl))).toBe(false);
    store.data.set(storageKey(opts.apiBaseUrl), { schema: 1, entries: [["card:ok", { value: { kind: "card", card }, validatedAt: 1, freshUntil: 2, negative: false }], ["bad", 42]] });
    expect(new ScoreCache(store, new FakeClock(), opts).size).toBe(1);
  });

  it("persists long listings truncated to the newest versions and without the ETag", async () => {
    const { store, cache } = setup();
    const versions = Array.from({ length: PERSISTED_VERSIONS_CAP + 100 }, (_, i) => `1.0.${i}`);
    const listing = must(summarizeListing(apiListing("npm", "big", versions)));
    cache.set(listKey({ ecosystem: "npm", name: "big" }), { kind: "listing", listing }, { etag: '"big"' });
    await cache.flush();
    const raw = store.get<{ entries: [string, { etag?: string; value: { listing: { allVersions: string[]; allVersionsTruncated?: boolean } } }][] }>(storageKey(opts.apiBaseUrl));
    const entry = raw?.entries[0]?.[1];
    expect(entry?.etag).toBeUndefined();
    expect(entry?.value.listing.allVersions).toHaveLength(PERSISTED_VERSIONS_CAP);
    expect(entry?.value.listing.allVersions[0]).toBe(`1.0.${PERSISTED_VERSIONS_CAP + 99}`);
    expect(entry?.value.listing.allVersionsTruncated).toBe(true);
    // The live entry keeps everything.
    expect(cache.peek(listKey({ ecosystem: "npm", name: "big" }))?.etag).toBe('"big"');
  });
});

describe("ScoreCache maintenance", () => {
  it("evicts the least recently used entries", () => {
    const { cache } = setup();
    for (let i = 0; i < MAX_ENTRIES; i++) cache.set(`card:${i}`, { kind: "not_scored", reason: "not_indexed" });
    cache.get("card:0");
    cache.set("card:new", { kind: "not_scored", reason: "not_indexed" });
    expect(cache.size).toBe(MAX_ENTRIES);
    expect(cache.peek("card:0")).toBeDefined();
    expect(cache.peek("card:1")).toBeUndefined();
  });

  it("invalidates packages, drops negatives and clears", async () => {
    const { store, cache } = setup();
    cache.set(cardKey("npm:lodash@1.0.0"), { kind: "card", card });
    cache.set(cardKey("npm:lodash-es@1.0.0"), { kind: "card", card });
    cache.set(listKey({ ecosystem: "npm", name: "lodash" }), { kind: "not_scored", reason: "not_indexed" });
    cache.set(cardKey("pypi:pyyaml@6.0"), { kind: "not_scored", reason: "not_indexed" });
    cache.invalidate([{ ecosystem: "npm", name: "lodash" }]);
    expect(cache.peek(cardKey("npm:lodash@1.0.0"))).toBeUndefined();
    expect(cache.peek(listKey({ ecosystem: "npm", name: "lodash" }))).toBeUndefined();
    expect(cache.peek(cardKey("npm:lodash-es@1.0.0"))).toBeDefined();
    cache.dropNegative();
    expect(cache.peek(cardKey("pypi:pyyaml@6.0"))).toBeUndefined();
    await cache.flush();
    await cache.clear();
    expect(cache.size).toBe(0);
    expect(store.data.size).toBe(0);
  });
});
