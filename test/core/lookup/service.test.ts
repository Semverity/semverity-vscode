import { describe, expect, it } from "vitest";
import { SemverityClient } from "../../../src/core/api/client";
import { fromPurl } from "../../../src/core/api/purl";
import { ScoreCache } from "../../../src/core/cache/scoreCache";
import { LookupServiceImpl, targetKeyOf } from "../../../src/core/lookup/service";
import { TokenBucket } from "../../../src/core/lookup/rateLimiter";
import type { LookupTarget, NetworkStatus } from "../../../src/core/types";
import { FakeClock } from "../../helpers/fakeClock";
import { FakeFetch, json, type RecordedRequest } from "../../helpers/fakeFetch";
import { MemoryStore } from "../../helpers/memoryStore";
import { apiCard, apiListing, must } from "../builders";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const MIN = 60_000;

function setup(o: { key?: string; enabled?: boolean; rpm?: number } = {}) {
  const clock = new FakeClock();
  const fake = new FakeFetch(() => clock.now());
  const store = new MemoryStore();
  let key = o.key;
  const client = new SemverityClient(
    { fetch: fake.fetch, secrets: { getApiKey: () => Promise.resolve(key) }, logger: silent, now: () => clock.now() },
    { apiBaseUrl: "https://api.semverity.dev", userAgent: "semverity-vscode/0.1.0" },
  );
  const cache = new ScoreCache(store, clock, { apiBaseUrl: "https://api.semverity.dev", ttlMs: 24 * 60 * MIN, negativeTtlMs: 60 * MIN });
  const svc = new LookupServiceImpl(client, cache, clock, silent, { networkEnabled: o.enabled ?? true, maxRequestsPerMinute: o.rpm ?? 20 });
  const updates: string[][] = [];
  const statuses: NetworkStatus[] = [];
  svc.onDidUpdate((k) => updates.push(k));
  svc.onDidChangeStatus((s) => statuses.push(s));
  return { clock, fake, store, cache, svc, updates, statuses, setKey: (k: string | undefined) => (key = k) };
}

const npm = (name: string, version?: string, range?: string): LookupTarget => {
  const t: LookupTarget = { id: { ecosystem: "npm", name }, versionSource: version ? "lockfile" : range ? "range" : "latest" };
  if (version) t.version = version;
  if (range) t.range = range;
  return t;
};

function purlsOf(r: RecordedRequest | undefined): string[] {
  return r?.body ? (JSON.parse(r.body) as { purls: string[] }).purls : [];
}

/** Answers every batch with a card per requested purl. */
function batchAllScored(fake: FakeFetch): void {
  fake.on("POST", "/v1/packages:batch", (req) => {
    const cards = purlsOf(req).map((p) => {
      const c = must(fromPurl(p));
      return apiCard(c.ecosystem, c.name, c.version);
    });
    return json(200, { cards }, { "cache-control": "no-store" });
  });
}

function cardRoute(fake: FakeFetch, etag = '"card-etag"'): void {
  fake.on("GET", /^\/v1\/packages\/npm\/[^/]+\/versions\//, (req) => {
    const m = must(/^\/v1\/packages\/npm\/(.+)\/versions\/(.+)$/.exec(req.path));
    if (req.headers["If-None-Match"] === etag) return json(304, undefined, { "cache-control": "public, max-age=300" });
    return json(200, apiCard("npm", must(m[1]), decodeURIComponent(must(m[2]))), { etag, "cache-control": "public, max-age=300, stale-while-revalidate=600" });
  });
}

describe("LookupService scheduling", () => {
  it("coalesces requests made within 150 ms into one batch", async () => {
    const { clock, fake, svc, updates } = setup();
    batchAllScored(fake);
    svc.request([npm("a", "1.0.0")], "visible");
    await clock.advance(50);
    svc.request([npm("b", "2.0.0"), npm("a", "1.0.0")], "visible");
    svc.request([npm("c", "3.0.0")], "visible");
    expect(fake.requests).toHaveLength(0);
    await clock.advance(150);
    expect(fake.requests).toHaveLength(1);
    expect(purlsOf(fake.requests[0]).sort()).toEqual(["pkg:npm/a@1.0.0", "pkg:npm/b@2.0.0", "pkg:npm/c@3.0.0"]);
    expect(svc.peek(npm("b", "2.0.0"))).toMatchObject({ state: "scored", coordinate: { name: "b", version: "2.0.0" }, versionSource: "lockfile", stale: false });
    expect(updates.flat().sort()).toEqual(["npm:a@1.0.0", "npm:b@2.0.0", "npm:c@3.0.0"]);
    // Fresh answers are not requested again.
    svc.request([npm("a", "1.0.0")], "visible");
    await clock.advance(1000);
    expect(fake.requests).toHaveLength(1);
  });

  it("uses a single card GET when exactly one card is needed", async () => {
    const { clock, fake, svc } = setup();
    cardRoute(fake);
    svc.request([npm("lodash", "4.18.1")], "visible");
    await clock.advance(200);
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1/packages/npm/lodash/versions/4.18.1"]);
    expect(svc.peek(npm("lodash", "4.18.1"))?.state).toBe("scored");
  });

  it("chunks batches at 25 purls signed out and 100 signed in", async () => {
    const out = setup();
    batchAllScored(out.fake);
    out.svc.request(Array.from({ length: 60 }, (_, i) => npm(`p${i}`, "1.0.0")), "background");
    await out.clock.advance(2 * MIN);
    expect(out.fake.requests.map((r) => purlsOf(r).length)).toEqual([25, 25, 10]);

    const signedIn = setup({ key: "svk_test" });
    batchAllScored(signedIn.fake);
    await signedIn.clock.advance(1);
    signedIn.svc.request(Array.from({ length: 160 }, (_, i) => npm(`p${i}`, "1.0.0")), "background");
    await signedIn.clock.advance(10 * MIN);
    expect(signedIn.fake.requests.map((r) => purlsOf(r).length)).toEqual([100, 60]);
  });

  it("sends visible targets before background ones", async () => {
    const { clock, fake, svc } = setup();
    batchAllScored(fake);
    svc.request(Array.from({ length: 30 }, (_, i) => npm(`bg${i}`, "1.0.0")), "background");
    svc.request([npm("seen1", "1.0.0"), npm("seen2", "1.0.0")], "visible");
    await clock.advance(200);
    const first = purlsOf(fake.requests[0]);
    expect(first.slice(0, 2)).toEqual(["pkg:npm/seen1@1.0.0", "pkg:npm/seen2@1.0.0"]);
    expect(first).toHaveLength(25);
  });

  it("fetches the listing first for latest and range targets", async () => {
    const { clock, fake, svc } = setup();
    fake.on("GET", "/v1/packages/npm/lodash", json(200, apiListing("npm", "lodash", ["4.18.1", "4.17.21", "4.17.20", "3.10.1"]), { etag: '"l1"', "cache-control": "public, max-age=300" }));
    batchAllScored(fake);
    cardRoute(fake);
    svc.request([npm("lodash"), npm("lodash", undefined, "^4.17.0"), npm("lodash", undefined, "~3.10.0")], "visible");
    await clock.advance(200);
    expect(fake.requests[0]?.path).toBe("/v1/packages/npm/lodash");
    expect(fake.requests.filter((r) => r.path === "/v1/packages/npm/lodash")).toHaveLength(1);
    expect(purlsOf(fake.requests[1]).sort()).toEqual(["pkg:npm/lodash@3.10.1", "pkg:npm/lodash@4.18.1"]);
    expect(svc.peek(npm("lodash"))).toMatchObject({ state: "scored", coordinate: { version: "4.18.1" }, versionSource: "latest" });
    expect(svc.peek(npm("lodash", undefined, "^4.17.0"))).toMatchObject({ state: "scored", coordinate: { version: "4.18.1" }, versionSource: "range", listing: { healthy: "4.18.1" } });
    expect(svc.peek(npm("lodash", undefined, "~3.10.0"))).toMatchObject({ coordinate: { version: "3.10.1" } });
    const scored = svc.peek(npm("lodash"));
    expect(scored?.state === "scored" && "allVersions" in (scored.listing ?? {})).toBe(false);
  });

  it("answers a latest target from its listing, then fetches the card in the background", async () => {
    const { clock, fake, svc, updates } = setup();
    for (const n of ["a", "b", "c"]) fake.on("GET", `/v1/packages/npm/${n}`, json(200, apiListing("npm", n, ["2.0.0", "1.0.0"])));
    batchAllScored(fake);
    svc.request([npm("a"), npm("b"), npm("c")], "visible");
    await clock.advance(200);
    // Three listings, then one batch for the three cards.
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /v1/packages/npm/a",
      "GET /v1/packages/npm/b",
      "GET /v1/packages/npm/c",
      "POST /v1/packages:batch",
    ]);
    expect(purlsOf(fake.requests[3]).sort()).toEqual(["pkg:npm/a@2.0.0", "pkg:npm/b@2.0.0", "pkg:npm/c@2.0.0"]);
    // Each target was answered as soon as its listing arrived.
    expect(updates.slice(0, 3).map((k) => k.join())).toEqual(["npm:a@latest", "npm:b@latest", "npm:c@latest"]);
    const full = svc.peek(npm("a"));
    expect(full?.state === "scored" && full.card.fromListing).toBeFalsy();
  });

  it("shows the listing's score while the card waits for capacity", async () => {
    const { clock, fake, svc } = setup();
    fake.on("GET", "/v1/packages/npm/lodash", json(200, apiListing("npm", "lodash", ["4.18.1", "4.17.21"])));
    // The batch is refused for now, so only the listing is known.
    fake.on("POST", "/v1/packages:batch", json(429, { error: { code: "rate_limited", message: "slow down" } }, { "retry-after": "60" }));
    svc.request([npm("lodash")], "visible");
    await clock.advance(200);
    const r = svc.peek(npm("lodash"));
    expect(r).toMatchObject({ state: "scored", coordinate: { version: "4.18.1" }, versionSource: "latest", card: { fromListing: true, gates: [{ id: "no_provenance", hard: false }] } });
    expect(r?.state === "scored" && r.card.headline?.score).toBe(82.8);
  });

  it("makes a full resolve wait for the card instead of the listing's summary", async () => {
    const { clock, fake, svc } = setup();
    fake.on("GET", "/v1/packages/npm/lodash", json(200, apiListing("npm", "lodash", ["4.18.1"])));
    cardRoute(fake);
    const quick = svc.resolve([npm("lodash")], "visible");
    const full = svc.resolve([npm("lodash")], "visible", { full: true });
    await clock.advance(200);
    const q = (await quick).get("npm:lodash@latest");
    const f = (await full).get("npm:lodash@latest");
    expect(q?.state === "scored" && q.card.fromListing).toBe(true);
    expect(f?.state === "scored" && f.card.fromListing).toBeFalsy();
    expect(fake.requests.map((r) => r.path)).toEqual(["/v1/packages/npm/lodash", "/v1/packages/npm/lodash/versions/4.18.1"]);
  });

  it("answers not scored when a range matches nothing Semverity knows", async () => {
    const { clock, fake, svc } = setup();
    fake.on("GET", "/v1/packages/npm/lodash", json(200, apiListing("npm", "lodash", ["4.18.1"])));
    svc.request([npm("lodash", undefined, "^9.0.0")], "visible");
    await clock.advance(200);
    expect(svc.peek(npm("lodash", undefined, "^9.0.0"))).toMatchObject({ state: "not_scored", reason: "not_found", versionSource: "range" });
  });

  it("revalidates a card with its ETag once it is due", async () => {
    const { clock, fake, svc } = setup();
    cardRoute(fake);
    const t = npm("lodash", "4.18.1");
    svc.request([t], "visible");
    await clock.advance(200);
    const first = svc.peek(t);
    await clock.advance(16 * MIN);
    svc.request([t], "visible");
    await clock.advance(200);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]?.headers["If-None-Match"]).toBe('"card-etag"');
    const second = svc.peek(t);
    expect(second?.state === "scored" && first?.state === "scored" && second.validatedAt > first.validatedAt).toBe(true);
  });

  it("stores not indexed answers with the negative lifetime", async () => {
    const { clock, fake, svc } = setup();
    fake.on("POST", "/v1/packages:batch", json(200, { cards: [], not_indexed: ["pkg:npm/a@1.0.0"] }));
    svc.request([npm("a", "1.0.0"), npm("b", "1.0.0")], "visible");
    await clock.advance(200);
    expect(svc.peek(npm("a", "1.0.0"))).toMatchObject({ state: "not_scored", reason: "not_indexed" });
    expect(svc.peek(npm("b", "1.0.0"))).toMatchObject({ state: "not_scored", reason: "not_indexed" });
    await clock.advance(59 * MIN);
    svc.request([npm("a", "1.0.0")], "visible");
    await clock.advance(200);
    expect(fake.requests).toHaveLength(1);
    await clock.advance(2 * MIN);
    svc.request([npm("a", "1.0.0")], "visible");
    await clock.advance(200);
    expect(fake.requests).toHaveLength(2);
  });

  it("splits a batch the API refuses as too large", async () => {
    const { clock, fake, svc } = setup();
    fake.on("POST", "/v1/packages:batch", (req) => {
      const purls = purlsOf(req);
      if (purls.length > 2) return json(400, { code: "bad_request" });
      return json(200, { cards: purls.map((p) => apiCard("npm", must(fromPurl(p)).name, must(fromPurl(p)).version)) });
    });
    svc.request(["a", "b", "c", "d"].map((n) => npm(n, "1.0.0")), "visible");
    await clock.advance(MIN);
    expect(fake.requests.map((r) => purlsOf(r).length)).toEqual([4, 2, 2]);
    expect(svc.peek(npm("d", "1.0.0"))?.state).toBe("scored");
  });
});

describe("LookupService failures", () => {
  it("pauses on 429 until Retry-After, then resumes", async () => {
    const { clock, fake, svc, statuses } = setup();
    let limited = true;
    fake.on("POST", "/v1/packages:batch", (req) => (limited ? json(429, { code: "rate_limited" }, { "retry-after": "30" }) : json(200, { cards: purlsOf(req).map((p) => apiCard("npm", must(fromPurl(p)).name, "1.0.0")) })));
    svc.request([npm("a", "1.0.0"), npm("b", "1.0.0")], "visible");
    await clock.advance(200);
    expect(svc.status()).toMatchObject({ state: "rate_limited", retryAt: clock.now() - 50 + 30_000 });
    expect(svc.peek(npm("a", "1.0.0"))).toMatchObject({ state: "rate_limited" });
    svc.request([npm("c", "1.0.0")], "visible");
    await clock.advance(20_000);
    expect(fake.requests).toHaveLength(1);
    limited = false;
    await clock.advance(11_000);
    expect(fake.requests).toHaveLength(2);
    expect(purlsOf(fake.requests[1]).sort()).toEqual(["pkg:npm/a@1.0.0", "pkg:npm/b@1.0.0", "pkg:npm/c@1.0.0"]);
    expect(svc.status().state).toBe("ok");
    expect(statuses.map((s) => s.state)).toEqual(["rate_limited", "ok"]);
  });

  it("backs off while offline, keeps cached answers, and recovers", async () => {
    const { clock, fake, svc } = setup();
    cardRoute(fake);
    svc.request([npm("cached", "1.0.0")], "visible");
    await clock.advance(200);
    fake.reset();
    let online = false;
    fake.on("GET", /.*/, () => (online ? json(200, apiCard("npm", "fresh", "1.0.0")) : new TypeError("fetch failed")));
    svc.request([npm("fresh", "1.0.0")], "visible");
    await clock.advance(200);
    expect(svc.status()).toMatchObject({ state: "offline" });
    expect(svc.peek(npm("fresh", "1.0.0"))).toMatchObject({ state: "offline" });
    expect(svc.peek(npm("cached", "1.0.0"))).toMatchObject({ state: "scored" });
    await clock.advance(15_000);
    expect(fake.requests).toHaveLength(2);
    await clock.advance(29_000);
    expect(fake.requests).toHaveLength(2);
    await clock.advance(1_000);
    expect(fake.requests).toHaveLength(3);
    online = true;
    await clock.advance(60_000);
    expect(fake.requests).toHaveLength(4);
    expect(svc.status().state).toBe("ok");
    expect(svc.peek(npm("fresh", "1.0.0"))?.state).toBe("scored");
  });

  it("marks a cached answer stale when its revalidation fails", async () => {
    const { clock, fake, svc } = setup();
    cardRoute(fake);
    svc.request([npm("a", "1.0.0")], "visible");
    await clock.advance(200);
    fake.reset();
    fake.on("GET", /.*/, json(500, { code: "internal" }));
    await clock.advance(16 * MIN);
    expect(svc.peek(npm("a", "1.0.0"))).toMatchObject({ state: "scored", stale: false });
    svc.request([npm("a", "1.0.0")], "visible");
    await clock.advance(200);
    expect(fake.requests).toHaveLength(1);
    expect(svc.peek(npm("a", "1.0.0"))).toMatchObject({ state: "scored", stale: true });
  });

  it("reports an error only when nothing is cached", async () => {
    const { clock, fake, svc } = setup();
    fake.on("GET", /.*/, json(500, { code: "internal" }));
    const results = svc.resolve([npm("a", "1.0.0")], "visible");
    await clock.advance(200);
    expect((await results).get("npm:a@1.0.0")).toMatchObject({ state: "error" });
  });

  it("stays within the request and purl budgets over ten minutes", async () => {
    const { clock, fake, svc } = setup();
    batchAllScored(fake);
    cardRoute(fake);
    svc.request(Array.from({ length: 400 }, (_, i) => npm(`p${i}`, "1.0.0")), "background");
    for (let i = 0; i < 600; i++) {
      if (i % 30 === 0) svc.request([npm(`v${i}`, "1.0.0")], "visible");
      await clock.advance(1000);
    }
    const reqs = fake.requests;
    expect(reqs.length).toBeGreaterThan(10);
    for (const r of reqs) {
      const windowReqs = reqs.filter((x) => x.at >= r.at && x.at < r.at + MIN);
      expect(windowReqs.length).toBeLessThanOrEqual(5 + 20);
      const purls = windowReqs.reduce((n, x) => n + (x.method === "POST" ? purlsOf(x).length : 1), 0);
      expect(purls).toBeLessThanOrEqual(25 + 60);
    }
    // Everything requested was eventually answered within the budget.
    expect(svc.peek(npm("p399", "1.0.0"))?.state).toBe("scored");
  });
});

describe("LookupService with an API key", () => {
  it("polls a pending collection at most six times", async () => {
    const { clock, fake, svc } = setup({ key: "svk_test" });
    fake.on("GET", /.*/, json(202, { purl: "pkg:npm/new@1.0.0", status: "collecting", status_url: "/s", retry_after_seconds: 10 }, { "retry-after": "10" }));
    await clock.advance(1);
    const r = svc.resolve([npm("new", "1.0.0")], "visible");
    await clock.advance(200);
    expect((await r).get("npm:new@1.0.0")).toMatchObject({ state: "pending" });
    await clock.advance(30 * MIN);
    expect(fake.requests).toHaveLength(7);
    expect(svc.peek(npm("new", "1.0.0"))).toMatchObject({ state: "pending" });
  });

  it("drops a refused key, retries signed out and reports unauthorized", async () => {
    const { clock, fake, svc } = setup({ key: "svk_bad" });
    fake.on("GET", /.*/, (req) => (req.headers.Authorization ? json(401, { code: "unauthorized" }) : json(200, apiCard("npm", "a", "1.0.0"))));
    svc.request([npm("a", "1.0.0")], "visible");
    await clock.advance(200);
    expect(fake.requests.map((r) => r.headers.Authorization)).toEqual(["Bearer svk_bad", undefined]);
    expect(svc.peek(npm("a", "1.0.0"))?.state).toBe("scored");
    expect(svc.status()).toMatchObject({ state: "unauthorized", signedIn: false });
  });

  it("drops negative answers when the key changes", async () => {
    const { clock, fake, svc, setKey } = setup();
    fake.on("GET", /.*/, json(404, { code: "not_indexed" }, { "cache-control": "public, max-age=60" }));
    svc.request([npm("a", "1.0.0")], "visible");
    await clock.advance(200);
    expect(svc.peek(npm("a", "1.0.0"))?.state).toBe("not_scored");
    setKey("svk_new");
    svc.apiKeyChanged();
    await clock.advance(1);
    expect(svc.peek(npm("a", "1.0.0"))).toBeUndefined();
    await clock.advance(200);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]?.headers.Authorization).toBe("Bearer svk_new");
    expect(svc.status().signedIn).toBe(true);
  });
});

describe("LookupService switches", () => {
  it("sends nothing while network lookups are off", async () => {
    const { clock, fake, svc } = setup({ enabled: false });
    batchAllScored(fake);
    svc.request([npm("a", "1.0.0")], "visible");
    const r = await svc.resolve([npm("b", "1.0.0")], "visible");
    expect(await svc.listing({ ecosystem: "npm", name: "a" })).toBeUndefined();
    await clock.advance(10 * MIN);
    expect(fake.requests).toHaveLength(0);
    expect(r.get("npm:b@1.0.0")).toEqual({ state: "disabled" });
    expect(svc.peek(npm("a", "1.0.0"))).toEqual({ state: "disabled" });
    expect(svc.status().state).toBe("disabled");
    svc.updateOptions({ networkEnabled: true, maxRequestsPerMinute: 20 });
    svc.request([npm("a", "1.0.0")], "visible");
    await clock.advance(200);
    expect(fake.requests).toHaveLength(1);
  });

  it("serves listings for hovers and invalidates on demand", async () => {
    const { clock, fake, svc, updates } = setup();
    fake.on("GET", "/v1/packages/npm/lodash", json(200, apiListing("npm", "lodash", ["4.18.1", "4.17.21"]), { etag: '"l"' }));
    cardRoute(fake);
    const t = npm("lodash", "4.17.21");
    svc.request([t], "visible");
    await clock.advance(200);
    const listing = svc.listing({ ecosystem: "npm", name: "lodash" });
    await clock.advance(200);
    expect(await listing).toMatchObject({ latest: "4.18.1", healthy: "4.18.1", latestScored: "4.18.1" });
    expect(svc.peek(t)).toMatchObject({ state: "scored", listing: { healthy: "4.18.1" } });
    expect(updates.flat()).toContain(targetKeyOf(t));
    const before = fake.requests.length;
    svc.invalidate([{ ecosystem: "npm", name: "lodash" }]);
    expect(svc.peek(t)).toBeUndefined();
    await clock.advance(200);
    expect(fake.requests.length).toBe(before + 1);
    expect(svc.peek(t)?.state).toBe("scored");
  });

  it("drops queued work the new settings refuse", async () => {
    const { clock, fake, svc } = setup();
    batchAllScored(fake);
    svc.request([npm("@acme/secret", "1.0.0"), npm("ok", "1.0.0")], "visible");
    svc.dropQueued((id) => id.name.startsWith("@acme/"));
    await clock.advance(200);
    expect(fake.requests.flatMap((r) => (r.method === "POST" ? purlsOf(r) : [r.path]))).toEqual(["/v1/packages/npm/ok/versions/1.0.0"]);
  });
});

describe("TokenBucket", () => {
  it("grants a burst, then refills per minute", async () => {
    const clock = new FakeClock();
    const b = new TokenBucket(5, 20, clock);
    for (let i = 0; i < 5; i++) expect(b.take(1)).toBe(0);
    expect(b.take(1)).toBe(3000);
    await clock.advance(3000);
    expect(b.take(1)).toBe(0);
    expect(b.wait(10)).toBeGreaterThan(0);
  });
});
