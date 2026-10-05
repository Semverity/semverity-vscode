// Cache-Control and Retry-After parsing.

export interface CacheDirectives {
  maxAgeSec?: number;
  swrSec?: number;
  noStore: boolean;
}

export function parseCacheControl(header: string | null | undefined): CacheDirectives {
  const out: CacheDirectives = { noStore: false };
  if (!header) return out;
  for (const part of header.split(",")) {
    const [rawKey, rawValue] = part.split("=", 2);
    const key = (rawKey ?? "").trim().toLowerCase();
    const value = (rawValue ?? "").trim().replace(/^"|"$/g, "");
    const n = /^\d+$/.test(value) ? Number(value) : undefined;
    if (key === "max-age" && n !== undefined) out.maxAgeSec = n;
    else if (key === "stale-while-revalidate" && n !== undefined) out.swrSec = n;
    else if (key === "no-store") out.noStore = true;
  }
  return out;
}

/** Retry-After as a delay in milliseconds (seconds or an HTTP date); undefined when absent or unreadable. */
export function parseRetryAfter(header: string | null | undefined, nowMs: number): number | undefined {
  if (!header) return undefined;
  const h = header.trim();
  if (/^\d+$/.test(h)) return Number(h) * 1000;
  const t = Date.parse(h);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, t - nowMs);
}
