// A scripted fetch: routes by method and path, records every request with its
// headers and body, and answers with canned responses or network errors.

import type { FetchInitLike, FetchLike, FetchResponseLike } from "../../src/core/ports";

export interface RecordedRequest {
  method: string;
  url: string;
  /** Path and query, without the origin. */
  path: string;
  headers: Record<string, string>;
  body?: string;
  at: number;
}

export interface FakeResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Responder = (req: RecordedRequest) => FakeResponse | Error | Promise<FakeResponse | Error>;

export function json(status: number, body?: unknown, headers: Record<string, string> = {}): FakeResponse {
  return { status, body, headers };
}

export class FakeFetch {
  readonly requests: RecordedRequest[] = [];
  private routes: { method: string; match: string | RegExp; respond: Responder }[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Later routes win over earlier ones. */
  on(method: "GET" | "POST", match: string | RegExp, respond: Responder | FakeResponse): this {
    const r: Responder = typeof respond === "function" ? respond : () => respond;
    this.routes.unshift({ method, match, respond: r });
    return this;
  }

  reset(): void {
    this.routes = [];
    this.requests.length = 0;
  }

  readonly fetch: FetchLike = async (url: string, init: FetchInitLike): Promise<FetchResponseLike> => {
    const u = new URL(url);
    const req: RecordedRequest = { method: init.method, url, path: u.pathname + u.search, headers: { ...init.headers }, at: this.now() };
    if (init.body !== undefined) req.body = init.body;
    this.requests.push(req);
    const route = this.routes.find((r) => r.method === init.method && (typeof r.match === "string" ? r.match === req.path : r.match.test(req.path)));
    const res = route ? await route.respond(req) : json(599, { code: "unrouted", message: `no route for ${init.method} ${req.path}` });
    if (res instanceof Error) throw res;
    const headers = new Map(Object.entries(res.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const text = res.body === undefined ? "" : typeof res.body === "string" ? res.body : JSON.stringify(res.body);
    return {
      status: res.status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      text: () => Promise.resolve(text),
    };
  };
}
