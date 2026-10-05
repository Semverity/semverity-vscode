// String operations on URIs of the form "scheme:///path" or
// "scheme://authority/path". Paths use "/" separators. The core treats URIs as
// opaque local identifiers; they are never part of a request.

function splitUri(uri: string): { prefix: string; path: string } {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*)(.*)$/.exec(uri);
  if (m) return { prefix: m[1] ?? "", path: m[2] ?? "" };
  return { prefix: "", path: uri };
}

function stripQuery(path: string): string {
  const q = path.search(/[?#]/);
  return q >= 0 ? path.slice(0, q) : path;
}

/** The parent directory; the root stays the root. */
export function dirname(uri: string): string {
  const { prefix, path } = splitUri(uri);
  const p = stripQuery(path).replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  if (i <= 0) return `${prefix}/`;
  return prefix + p.slice(0, i);
}

/** The last path segment, percent-decoded when possible. */
export function basename(uri: string): string {
  const { path } = splitUri(uri);
  const p = stripQuery(path).replace(/\/+$/, "");
  const seg = p.slice(p.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** Joins path parts onto a directory URI, resolving "." and ".." segments. */
export function join(uri: string, ...parts: string[]): string {
  const { prefix, path } = splitUri(uri.replace(/\/+$/, ""));
  const segments = path.split("/").filter((s, i) => s !== "" || i === 0);
  for (const part of parts) {
    for (const seg of part.replace(/\\/g, "/").split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (segments.length > 1) segments.pop();
        continue;
      }
      segments.push(encodeSegment(seg));
    }
  }
  const joined = segments.join("/");
  return prefix + (joined.startsWith("/") ? joined : `/${joined}`);
}

function encodeSegment(seg: string): string {
  // Keep already-encoded segments as they are; encode characters a URI path cannot hold.
  return /%[0-9a-fA-F]{2}/.test(seg) ? seg : seg.replace(/[ #?%]/g, (c) => encodeURIComponent(c));
}

/** True when `child` is `parent` or lies below it. */
export function isUnder(child: string, parent: string): boolean {
  const p = parent.replace(/\/+$/, "");
  return child === p || child.startsWith(`${p}/`);
}

/**
 * The directories from the directory of `uri` up to `stopAt` (inclusive), nearest first.
 * Empty when `uri` is not under `stopAt`.
 */
export function ancestors(uri: string, stopAt: string): string[] {
  const stop = stopAt.replace(/\/+$/, "");
  if (!isUnder(uri, stop)) return [];
  const out: string[] = [];
  let dir = dirname(uri);
  for (;;) {
    out.push(dir);
    if (dir === stop || !isUnder(dir, stop)) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out.filter((d) => isUnder(d, stop));
}

/** The relative path from directory `from` to `to` ("" when equal), with ".." where needed. */
export function relative(from: string, to: string): string {
  const a = splitUri(from.replace(/\/+$/, ""));
  const b = splitUri(to.replace(/\/+$/, ""));
  if (a.prefix !== b.prefix) return to;
  const as = a.path.split("/").filter(Boolean);
  const bs = b.path.split("/").filter(Boolean);
  let i = 0;
  while (i < as.length && i < bs.length && as[i] === bs[i]) i++;
  const up = as.slice(i).map(() => "..");
  return [...up, ...bs.slice(i)].map(decodeSafe).join("/");
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
