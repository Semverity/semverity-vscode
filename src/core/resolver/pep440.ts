// PEP 440 versions and specifiers: parsing, ordering and `satisfies` for the
// operators == != <= >= < > ~= === and the `==1.2.*` wildcard. Enough to pick
// the newest version that matches a requirement; not a full implementation of
// the packaging library.

export interface Pep440Version {
  epoch: number;
  release: number[];
  pre?: [string, number];
  post?: number;
  dev?: number;
  local?: string;
}

const VERSION =
  /^\s*v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|b|c|rc|alpha|beta|pre|preview)[-_.]?(\d+)?)?(?:-(\d+)|[-_.]?(post|rev|r)[-_.]?(\d+)?)?(?:[-_.]?(dev)[-_.]?(\d+)?)?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?\s*$/i;

export function parsePep440(v: string): Pep440Version | undefined {
  const m = VERSION.exec(v);
  if (!m) return undefined;
  const out: Pep440Version = {
    epoch: m[1] ? Number(m[1]) : 0,
    release: (m[2] ?? "0").split(".").map(Number),
  };
  if (m[3]) {
    const l = m[3].toLowerCase();
    const label = l === "alpha" ? "a" : l === "beta" ? "b" : l === "c" || l === "pre" || l === "preview" ? "rc" : l;
    out.pre = [label, m[4] ? Number(m[4]) : 0];
  }
  if (m[5] !== undefined) out.post = Number(m[5]);
  else if (m[6]) out.post = m[7] ? Number(m[7]) : 0;
  if (m[8]) out.dev = m[9] ? Number(m[9]) : 0;
  if (m[10]) out.local = m[10].toLowerCase();
  return out;
}

export function isPep440Prerelease(v: Pep440Version): boolean {
  return v.pre !== undefined || v.dev !== undefined;
}

const PRE_ORDER: Record<string, number> = { a: 0, b: 1, rc: 2 };

function cmpRelease(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function cmpParsed(a: Pep440Version, b: Pep440Version): number {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch;
  const r = cmpRelease(a.release, b.release);
  if (r !== 0) return r;
  // Pre-release key: dev-only releases sort before every pre-release; no pre sorts after.
  const preKey = (v: Pep440Version): [number, number] => {
    if (v.pre) return [PRE_ORDER[v.pre[0]] ?? 0, v.pre[1]];
    if (v.post === undefined && v.dev !== undefined) return [-1, 0];
    return [3, 0];
  };
  const pa = preKey(a);
  const pb = preKey(b);
  if (pa[0] !== pb[0]) return pa[0] - pb[0];
  if (pa[1] !== pb[1]) return pa[1] - pb[1];
  const posta = a.post ?? -1;
  const postb = b.post ?? -1;
  if (posta !== postb) return posta - postb;
  const deva = a.dev ?? Number.POSITIVE_INFINITY;
  const devb = b.dev ?? Number.POSITIVE_INFINITY;
  if (deva !== devb) return deva < devb ? -1 : 1;
  const la = a.local ?? "";
  const lb = b.local ?? "";
  return la === lb ? 0 : la < lb ? -1 : 1;
}

/** Orders two PEP 440 versions; unparsable versions sort first, by string. */
export function comparePep440(a: string, b: string): number {
  const pa = parsePep440(a);
  const pb = parsePep440(b);
  if (pa && pb) return cmpParsed(pa, pb);
  if (pa) return 1;
  if (pb) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function withoutLocal(v: Pep440Version): Pep440Version {
  const { local: _local, ...rest } = v;
  return rest;
}

function prefixMatch(v: Pep440Version, prefix: string): boolean {
  const p = parsePep440(prefix);
  if (!p) return false;
  if (p.epoch !== v.epoch) return false;
  // `==1.2.*` matches every version whose release starts with 1.2 (padding with zeros).
  for (let i = 0; i < p.release.length; i++) {
    if ((v.release[i] ?? 0) !== p.release[i]) return false;
  }
  if (p.pre) return !!v.pre && v.pre[0] === p.pre[0] && v.pre[1] === p.pre[1];
  return true;
}

function clauseSatisfied(v: Pep440Version, raw: string, op: string, target: string): boolean {
  if (op === "===") return raw.trim() === target.trim();
  if ((op === "==" || op === "!=") && target.endsWith(".*")) {
    const hit = prefixMatch(v, target.slice(0, -2));
    return op === "==" ? hit : !hit;
  }
  const t = parsePep440(target);
  if (!t) return false;
  const vv = t.local ? v : withoutLocal(v);
  const c = cmpParsed(vv, t);
  switch (op) {
    case "==":
      return c === 0;
    case "!=":
      return c !== 0;
    case "<=":
      return c <= 0;
    case ">=":
      return c >= 0;
    case "<":
      // `<V` excludes pre-releases of V unless V is itself a pre-release.
      return c < 0 && !(isPep440Prerelease(v) && !isPep440Prerelease(t) && cmpRelease(v.release, t.release) === 0 && v.epoch === t.epoch);
    case ">":
      // `>V` excludes post-releases of V unless V is itself a post-release.
      return c > 0 && !(v.post !== undefined && t.post === undefined && cmpRelease(v.release, t.release) === 0 && v.epoch === t.epoch && !v.pre);
    case "~=": {
      if (t.release.length < 2) return false;
      if (c < 0) return false;
      const prefix = t.release.slice(0, -1);
      for (let i = 0; i < prefix.length; i++) {
        if ((v.release[i] ?? 0) !== prefix[i]) return false;
      }
      return v.epoch === t.epoch;
    }
    default:
      return false;
  }
}

/** Splits a specifier into clauses; undefined when a clause is not understood. */
export function parseSpecifier(specifier: string): { op: string; version: string }[] | undefined {
  const clauses: { op: string; version: string }[] = [];
  for (const part of specifier.split(",")) {
    const s = part.trim();
    if (s === "") continue;
    const m = /^(===|==|!=|<=|>=|~=|<|>)\s*(\S+)$/.exec(s);
    if (!m || !m[1] || !m[2]) return undefined;
    clauses.push({ op: m[1], version: m[2] });
  }
  return clauses;
}

/** True when `version` satisfies every clause of `specifier` ("" is satisfied by anything). */
export function satisfiesPep440(version: string, specifier: string): boolean {
  const v = parsePep440(version);
  if (!v) return false;
  const clauses = parseSpecifier(specifier);
  if (!clauses) return false;
  return clauses.every((c) => clauseSatisfied(v, version, c.op, c.version));
}
