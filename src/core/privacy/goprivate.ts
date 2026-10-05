// GOPRIVATE, GONOPROXY and GONOSUMDB matching with the go command's semantics
// (module.MatchPrefixPatterns): a comma-separated list of path.Match globs,
// each matched against the leading path elements of the module path, as many
// elements as the pattern has.

function elementGlobToRegExp(glob: string): RegExp | undefined {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "\\") {
      const next = glob[i + 1];
      if (next === undefined) return undefined;
      re += next.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
      i++;
    } else if (c === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close < 0) return undefined;
      let cls = glob.slice(i + 1, close);
      if (cls.startsWith("^")) cls = `^${cls.slice(1)}`;
      re += `[${cls.replace(/\\/g, "\\\\")}]`;
      i = close;
    } else re += c.replace(/[.+^${}()|\]\\/-]/g, "\\$&");
  }
  try {
    return new RegExp(`^${re}$`);
  } catch {
    return undefined;
  }
}

export function matchGoPrivate(patterns: string, modulePath: string): boolean {
  if (!patterns) return false;
  const target = modulePath.split("/");
  for (const raw of patterns.split(",")) {
    const pattern = raw.trim().replace(/\/+$/, "");
    if (pattern === "") continue;
    const elements = pattern.split("/");
    if (target.length < elements.length) continue;
    const prefix = target.slice(0, elements.length).join("/");
    const re = elementGlobToRegExp(pattern);
    if (re?.test(prefix)) return true;
  }
  return false;
}
