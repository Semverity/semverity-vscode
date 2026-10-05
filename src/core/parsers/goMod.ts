// go.mod: the module path, require lines (single and blocks, with
// `// indirect`) and replace directives. Line based, like the go command's own
// parser; a half-typed file yields what can be read.

import type { ManifestDependency, ParsedManifest } from "../types";
import { lineIndex } from "./scan";

export interface GoReplace {
  from: string;
  fromVersion?: string;
  to: string;
  toVersion?: string;
  /** The replacement is a directory on disk, not a module. */
  local: boolean;
  line: number;
}

export interface GoModManifest extends ParsedManifest {
  kind: "go.mod";
  module?: string;
  replaces: GoReplace[];
}

/** True when a replacement target is a file system path rather than a module path. */
export function isLocalGoPath(p: string): boolean {
  return /^(?:\.{1,2}(?:[\\/]|$)|\/|[A-Za-z]:[\\/]|\\\\)/.test(p);
}

function unquote(token: string): string {
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("`") && token.endsWith("`"))) {
    return token.slice(1, -1);
  }
  return token;
}

interface Token {
  text: string;
  start: number;
  end: number;
}

function tokens(line: string, base: number): Token[] {
  const out: Token[] = [];
  const re = /"(?:[^"\\]|\\.)*"|`[^`]*`|=>|[^\s]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push({ text: m[0], start: base + m.index, end: base + m.index + m[0].length });
  return out;
}

export function parseGoMod(uri: string, text: string): GoModManifest {
  const result: GoModManifest = { uri, kind: "go.mod", ecosystem: "golang", dependencies: [], replaces: [] };
  const index = lineIndex(text);
  let block: string | undefined;
  let offset = 0;

  for (const rawLine of text.split("\n")) {
    const lineStart = offset;
    offset += rawLine.length + 1;
    const commentAt = rawLine.indexOf("//");
    const comment = commentAt >= 0 ? rawLine.slice(commentAt + 2) : "";
    const code = (commentAt >= 0 ? rawLine.slice(0, commentAt) : rawLine).replace(/\r$/, "");
    let toks = tokens(code, lineStart);
    if (toks.length === 0) continue;

    let verb: string | undefined;
    if (block) {
      if (toks[0]?.text === ")") {
        block = undefined;
        continue;
      }
      verb = block;
    } else {
      verb = toks[0]?.text;
      toks = toks.slice(1);
      if (toks[0]?.text === "(") {
        block = verb;
        continue;
      }
    }

    if (verb === "module" && toks[0]) {
      result.module = unquote(toks[0].text);
    } else if (verb === "require" && toks[0]) {
      const nameTok = toks[0];
      const name = unquote(nameTok.text);
      const versionTok = toks[1];
      const nameRange = index.rangeOf(nameTok.start + (nameTok.text !== name ? 1 : 0), nameTok.end - (nameTok.text !== name ? 1 : 0));
      const dep: ManifestDependency = {
        ecosystem: "golang",
        name,
        rawName: name,
        spec: versionTok?.text ?? "",
        section: "require",
        line: nameRange.start.line,
        nameRange,
      };
      if (versionTok) {
        dep.specRange = index.rangeOf(versionTok.start, versionTok.end);
        dep.exactVersion = versionTok.text;
      }
      if (/\bindirect\b/.test(comment)) dep.indirect = true;
      result.dependencies.push(dep);
    } else if (verb === "replace") {
      const arrow = toks.findIndex((t) => t.text === "=>");
      if (arrow < 1) continue;
      const left = toks.slice(0, arrow);
      const right = toks.slice(arrow + 1);
      if (!left[0] || !right[0]) continue;
      const to = unquote(right[0].text);
      const r: GoReplace = {
        from: unquote(left[0].text),
        to,
        local: isLocalGoPath(to) || right.length === 1,
        line: index.positionAt(left[0].start).line,
      };
      if (left[1]) r.fromVersion = left[1].text;
      if (right[1]) r.toVersion = right[1].text;
      result.replaces.push(r);
    }
  }

  // A requirement replaced by a directory never comes from the registry.
  for (const dep of result.dependencies) {
    const r = replacementFor(result.replaces, dep.name, dep.exactVersion);
    if (r?.local) dep.nonRegistry = "local-replace";
  }
  return result;
}

/** The replace directive that applies to a module version (a versioned replace wins over a general one). */
export function replacementFor(replaces: GoReplace[], module: string, version?: string): GoReplace | undefined {
  let general: GoReplace | undefined;
  for (const r of replaces) {
    if (r.from !== module) continue;
    if (r.fromVersion === undefined) general = r;
    else if (r.fromVersion === version) return r;
  }
  return general;
}
