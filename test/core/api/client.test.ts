import { describe, expect, it } from "vitest";
import { SemverityClient, mayCarryKey } from "../../../src/core/api/client";
import { FakeFetch, json } from "../../helpers/fakeFetch";
import { apiCard, apiListing } from "../builders";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const NOW = Date.UTC(2026, 9, 5, 12);

function client(opts: { key?: string; base?: string } = {}) {
  const fake = new FakeFetch(() => NOW);
  let key = opts.key;
  const c = new SemverityClient(
    { fetch: fake.fetch, secrets: { getApiKey: () => Promise.resolve(key) }, logger: silent, now: () => NOW },
    { apiBaseUrl: opts.base ?? "https://api.semverity.dev", userAgent: "semverity-vscode/0.1.0" },
  );
  return { c, fake, setKey: (k: string | undefined) => (key = k) };
}

describe("SemverityClient requests", () => {
  it("sends exactly the allowed headers signed out", async () => {
    const { c, fake } = client();
    fake.on("GET", "/v1/packages/npm/lodash/versions/4.18.1", json(200, apiCard("npm", "lodash", "4.18.1")));
    await c.card({ ecosystem: "npm", name: "lodash", version: "4.18.1" });
    const req = fake.requests[0];
    expect(req?.method).toBe("GET");
    expect(req?.url).toBe("https://api.semverity.dev/v1/packages/npm/lodash/versions/4.18.1");
    expect(Object.keys(req?.headers ?? {}).sort()).toEqual(["Accept", "User-Agent"]);
    expect(req?.headers["User-Agent"]).toBe("semverity-vscode/0.1.0");
  });

  it("adds Authorization only with a key and an https or loopback base", async () => {
    const signedIn = client({ key: "svk_test" });
    signedIn.fake.on("GET", /.*/, json(404, { code: "not_found" }));
    await signedIn.c.listing({ ecosystem: "npm", name: "lodash" }, '"etag-1"');
    expect(signedIn.fake.requests[0]?.headers).toEqual({
      Accept: "application/json",
      "User-Agent": "semverity-vscode/0.1.0",
      "If-None-Match": '"etag-1"',
      Authorization: "Bearer svk_test",
    });
    const plain = client({ key: "svk_test", base: "http://api.example.test" });
    plain.fake.on("GET", /.*/, json(404, {}));
    await plain.c.listing({ ecosystem: "npm", name: "lodash" });
    expect(plain.fake.requests[0]?.headers.Authorization).toBeUndefined();
    expect(mayCarryKey("http://localhost:8080")).toBe(true);
    expect(mayCarryKey("http://127.0.0.1:8080")).toBe(true);
    expect(mayCarryKey("http://example.com")).toBe(false);
  });

  it("posts only purls in the batch body", async () => {
    const { c, fake } = client();
    fake.on("POST", "/v1/packages:batch", json(200, { cards: [], not_indexed: [] }, { "cache-control": "no-store" }));
    await c.batch([
      { ecosystem: "npm", name: "@types/node", version: "26.6.4" },
      { ecosystem: "pypi", name: "PyYAML", version: "6.0.3" },
      { ecosystem: "golang", name: "github.com/stretchr/testify", version: "v1.12.1" },
      { ecosystem: "npm", name: "@types/node", version: "26.6.4" },
    ]);
    const req = fake.requests[0];
    expect(req?.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(req?.body ?? "")).toEqual({ purls: ["pkg:npm/%40types/node@26.6.4", "pkg:pypi/pyyaml@6.0.3", "pkg:golang/github.com/stretchr/testify@v1.12.1"] });
  });
});

describe("SemverityClient answers", () => {
  it("matches batch answers by purl, never by position", async () => {
    const { c, fake } = client();
    fake.on(
      "POST",
      "/v1/packages:batch",
      json(200, {
        cards: [apiCard("pypi", "pyyaml", "6.0.3"), apiCard("npm", "@types/node", "26.6.4")],
        not_indexed: ["pkg:npm/lodash@4.17.21"],
        invalid: ["pkg:npm/bad@%"],
      }),
    );
    const out = await c.batch([
      { ecosystem: "npm", name: "lodash", version: "4.17.21" },
      { ecosystem: "npm", name: "@types/node", version: "26.6.4" },
      { ecosystem: "pypi", name: "PyYAML", version: "6.0.3" },
      { ecosystem: "npm", name: "missing", version: "1.0.0" },
    ]);
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.items.get("npm:lodash@4.17.21")).toEqual({ kind: "not_indexed" });
    expect(out.items.get("npm:@types/node@26.6.4")?.kind).toBe("card");
    expect(out.items.get("pypi:pyyaml@6.0.3")?.kind).toBe("card");
    expect(out.items.get("npm:missing@1.0.0")).toEqual({ kind: "not_indexed" });
  });

  it("reads pending entries of a signed-in 202", async () => {
    const { c, fake } = client({ key: "svk_x" });
    fake.on(
      "POST",
      "/v1/packages:batch",
      json(202, { cards: [], pending: [{ purl: "pkg:npm/new@1.0.0", status: "collecting", status_url: "/x", retry_after_seconds: 12 }] }, { "retry-after": "5" }),
    );
    const out = await c.batch([{ ecosystem: "npm", name: "new", version: "1.0.0" }]);
    expect(out.kind === "ok" && out.items.get("npm:new@1.0.0")).toEqual({ kind: "pending", retryAfterMs: 12_000 });
  });

  it("maps statuses", async () => {
    const { c, fake } = client();
    const id = { ecosystem: "npm" as const, name: "x" };
    const route = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => {
      fake.reset();
      fake.on("GET", /.*/, json(status, body, headers));
      return c.listing(id, '"e"');
    };
    expect(await route(200, apiListing("npm", "x", ["1.0.0"]), { etag: '"e2"', "cache-control": "public, max-age=300" })).toMatchObject({ kind: "ok", etag: '"e2"', cache: { maxAgeSec: 300 } });
    expect(await route(304, undefined, { "cache-control": "max-age=300" })).toEqual({ kind: "not_modified", cache: { maxAgeSec: 300, noStore: false } });
    expect(await route(404, { code: "not_indexed" }, { "cache-control": "public, max-age=60" })).toEqual({ kind: "not_found", reason: "not_indexed", cache: { maxAgeSec: 60, noStore: false } });
    expect(await route(404, { code: "not_found" })).toMatchObject({ kind: "not_found", reason: "not_found" });
    expect(await route(202, { purl: "pkg:npm/x", status: "collecting", status_url: "/s", retry_after_seconds: 3 })).toEqual({ kind: "pending", retryAfterMs: 5_000 });
    expect(await route(400)).toEqual({ kind: "invalid" });
    expect(await route(429, {}, { "retry-after": "17" })).toEqual({ kind: "rate_limited", retryAfterMs: 17_000 });
    expect(await route(429)).toEqual({ kind: "rate_limited", retryAfterMs: 60_000 });
    expect(await route(503, {}, { "retry-after": "2" })).toEqual({ kind: "unavailable", retryAfterMs: 2_000 });
    expect(await route(500)).toEqual({ kind: "server_error", status: 500 });
    expect(await route(200, "not json")).toEqual({ kind: "server_error", status: 200 });
    fake.reset();
    fake.on("GET", /.*/, () => new TypeError("fetch failed"));
    expect(await c.listing(id)).toEqual({ kind: "network_error", message: "TypeError" });
  });

  it("asks the caller to split a batch on 400 and 413", async () => {
    const { c, fake } = client();
    fake.on("POST", /.*/, json(413, { code: "payload_too_large" }));
    expect(await c.batch([{ ecosystem: "npm", name: "a", version: "1.0.0" }])).toEqual({ kind: "too_large" });
  });

  it("drops a refused key for the session and retries signed out", async () => {
    const { c, fake, setKey } = client({ key: "svk_bad" });
    fake.on("GET", /.*/, (req) => (req.headers.Authorization ? json(401, { code: "unauthorized" }) : json(404, { code: "not_indexed" })));
    const out = await c.card({ ecosystem: "npm", name: "x", version: "1.0.0" });
    expect(out).toMatchObject({ kind: "not_found" });
    expect(fake.requests.map((r) => r.headers.Authorization)).toEqual(["Bearer svk_bad", undefined]);
    expect(c.keyRefused()).toBe(true);
    await c.card({ ecosystem: "npm", name: "x", version: "1.0.0" });
    expect(fake.requests[2]?.headers.Authorization).toBeUndefined();
    setKey("svk_new");
    await c.card({ ecosystem: "npm", name: "x", version: "1.0.0" });
    expect(fake.requests[3]?.headers.Authorization).toBe("Bearer svk_new");
  });
});

describe("privacy of requests", () => {
  it("never puts paths, source lines or workspace names in a URL or body", async () => {
    const { c, fake } = client({ key: "svk_k" });
    fake.on("POST", /.*/, json(200, { cards: [] }));
    fake.on("GET", /.*/, json(404, {}));
    const coords = [
      { ecosystem: "npm" as const, name: "lodash", version: "4.17.21" },
      { ecosystem: "pypi" as const, name: "requests", version: "2.32.3" },
    ];
    await c.batch(coords);
    await c.card(coords[0] as (typeof coords)[0]);
    await c.listing({ ecosystem: "pypi", name: "requests" });
    const forbidden = ["file://", "/home/", "secret-workspace", "import ", "src/", "package.json", "requirements"];
    for (const r of fake.requests) {
      const all = `${r.url} ${r.body ?? ""} ${JSON.stringify(r.headers)}`;
      for (const f of forbidden) expect(all).not.toContain(f);
      if (r.body) expect(Object.keys(JSON.parse(r.body) as object)).toEqual(["purls"]);
    }
  });
});
