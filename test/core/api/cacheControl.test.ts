import { describe, expect, it } from "vitest";
import { parseCacheControl, parseRetryAfter } from "../../../src/core/api/cacheControl";

describe("Cache-Control", () => {
  it("reads max-age, stale-while-revalidate and no-store", () => {
    expect(parseCacheControl("public, max-age=300, stale-while-revalidate=600")).toEqual({ maxAgeSec: 300, swrSec: 600, noStore: false });
    expect(parseCacheControl("no-store")).toEqual({ noStore: true });
    expect(parseCacheControl(null)).toEqual({ noStore: false });
    expect(parseCacheControl("max-age=abc")).toEqual({ noStore: false });
  });
});

describe("Retry-After", () => {
  const now = Date.UTC(2026, 9, 5, 12, 0, 0);
  it("reads seconds and HTTP dates", () => {
    expect(parseRetryAfter("30", now)).toBe(30_000);
    expect(parseRetryAfter(new Date(now + 90_000).toUTCString(), now)).toBe(90_000);
    expect(parseRetryAfter(new Date(now - 5_000).toUTCString(), now)).toBe(0);
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
  });
});
