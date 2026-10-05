// tsconfig.json and jsconfig.json: `compilerOptions.paths` patterns and
// `baseUrl`, which turn bare-looking specifiers into local aliases. `extends`
// is not followed in 0.1.0.

import { parse } from "jsonc-parser";

export interface TsconfigAliases {
  patterns: string[];
  baseUrl?: string;
}

export function parseTsconfigAliases(text: string): TsconfigAliases {
  const result: TsconfigAliases = { patterns: [] };
  let doc: unknown;
  try {
    doc = parse(text, [], { allowTrailingComma: true, disallowComments: false });
  } catch {
    return result;
  }
  if (typeof doc !== "object" || doc === null) return result;
  const options = (doc as { compilerOptions?: unknown }).compilerOptions;
  if (typeof options !== "object" || options === null) return result;
  const { paths, baseUrl } = options as { paths?: unknown; baseUrl?: unknown };
  if (typeof paths === "object" && paths !== null) result.patterns = Object.keys(paths);
  if (typeof baseUrl === "string") result.baseUrl = baseUrl;
  return result;
}

/** True when a specifier matches a `paths` pattern ("@app/*", "~/*", "config"). */
export function matchesPathsPattern(specifier: string, pattern: string): boolean {
  const star = pattern.indexOf("*");
  if (star < 0) return specifier === pattern;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return specifier.length >= prefix.length + suffix.length && specifier.startsWith(prefix) && specifier.endsWith(suffix);
}
