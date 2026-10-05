// Coordinates to purls, API paths and package page URLs. These are the exact
// forms the Semverity API accepts (checked against https://api.semverity.dev):
//
//   purl     pkg:npm/%40types/node@26.6.4   (namespace "@" percent-encoded, as the API echoes it)
//            pkg:pypi/pyyaml@6.0.3          (PEP 503 normalised; "PyYAML" answers 404)
//            pkg:golang/github.com/stretchr/testify@v1.12.1
//   path     /v1/packages/npm/@types/node   (raw "@" and "/" in the name)
//            /v1/packages/npm/@types/node/versions/26.6.4
//            a name with a "versions" segment (example.com/versions/v2) uses
//            "/v1/packages/golang/example.com/versions/v2?version=v2.0.0" for the card
//            and a trailing "/versions" for the listing.
//   page     https://semverity.dev/registry/npm/@types/node[/versions/26.6.4]

import type { Coordinate, Ecosystem, PackageId } from "../types";

/** PEP 503 name normalisation: lowercase, runs of "-", "_" and "." become "-". */
export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** The registry-native form of a name for the API (PyPI normalised, others unchanged). */
export function canonicalName(ecosystem: Ecosystem, name: string): string {
  return ecosystem === "pypi" ? normalizePypiName(name) : name;
}

function encodeSegment(segment: string): string {
  return encodeURIComponent(segment);
}

/** pkg:<type>/<namespace>/<name>@<version>, each segment percent-encoded. */
export function toPurl(c: Coordinate): string {
  const name = canonicalName(c.ecosystem, c.name);
  const segments = name.split("/").map(encodeSegment).join("/");
  return `pkg:${c.ecosystem}/${segments}@${encodeSegment(c.version)}`;
}

/** Splits a purl the API returned back into a coordinate; undefined when it is not one of ours. */
export function fromPurl(purl: string): Coordinate | undefined {
  const m = /^pkg:(npm|pypi|golang)\/(.+)@([^@/]+)$/.exec(purl);
  if (!m) return undefined;
  const [, eco, rawName, rawVersion] = m as unknown as [string, Ecosystem, string, string];
  try {
    const name = rawName.split("/").map(decodeURIComponent).join("/");
    return { ecosystem: eco, name, version: decodeURIComponent(rawVersion) };
  } catch {
    return undefined;
  }
}

/** The cache and dedupe key of a package version. */
export function coordinateKey(c: Coordinate): string {
  return `${c.ecosystem}:${canonicalName(c.ecosystem, c.name)}@${c.version}`;
}

/** The cache and dedupe key of a package. */
export function packageKey(id: PackageId): string {
  return `${id.ecosystem}:${canonicalName(id.ecosystem, id.name)}`;
}

function pathName(id: PackageId): string {
  return canonicalName(id.ecosystem, id.name)
    .split("/")
    .map((s) => encodeSegment(s).replace(/%40/g, "@"))
    .join("/");
}

function hasVersionsSegment(name: string): boolean {
  return name.split("/").includes("versions");
}

/** Path (with query) of GET /v1/packages/{ecosystem}/{name}, the version listing. */
export function listingPath(id: PackageId): string {
  const base = `/v1/packages/${id.ecosystem}/${pathName(id)}`;
  return hasVersionsSegment(canonicalName(id.ecosystem, id.name)) ? `${base}/versions` : base;
}

/** Path (with query) of the card route of one version. */
export function cardPath(c: Coordinate): string {
  const base = `/v1/packages/${c.ecosystem}/${pathName(c)}`;
  if (hasVersionsSegment(canonicalName(c.ecosystem, c.name))) {
    return `${base}?version=${encodeURIComponent(c.version)}`;
  }
  return `${base}/versions/${encodeSegment(c.version)}`;
}

/** The public package page on the Semverity web site. */
export function packagePageUrl(siteBaseUrl: string, id: PackageId, version?: string): string {
  const site = siteBaseUrl.replace(/\/+$/, "");
  const page = `${site}/registry/${id.ecosystem}/${pathName(id)}`;
  return version ? `${page}/versions/${encodeSegment(version)}` : page;
}
