// The one place globalThis.fetch is handed to the core, as the FetchLike port.
// Only the API client (src/core/api/client.ts) calls it, with coordinates.

import type { FetchLike, FetchResponseLike } from "../core/ports";

const TIMEOUT_MS = 15_000;

export function createFetch(): FetchLike {
  return async (url, init): Promise<FetchResponseLike> => {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return globalThis.fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal,
      // Requests go to the configured API base URL and nowhere else: a redirect
      // to another location is treated as an error rather than followed.
      redirect: "error",
      credentials: "omit",
    });
  };
}
