// A FileSource over a map of URI to text, with glob matching close enough to
// workspace.findFiles for the index (**, *, ?, {a,b}).

import type { FileSource } from "../../src/core/ports";

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const close = glob.indexOf("}", i);
      re += `(?:${glob
        .slice(i + 1, close)
        .split(",")
        .map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
        .join("|")})`;
      i = close;
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export class MemoryFiles implements FileSource {
  readonly files = new Map<string, string>();
  /** User-level registry files by name (".npmrc", ".yarnrc.yml" ...). */
  userConfigs: Record<string, string> = {};
  reads: string[] = [];

  constructor(
    private readonly rootUris: string[],
    files: Record<string, string> = {},
  ) {
    for (const [k, v] of Object.entries(files)) this.files.set(k, v);
  }

  /** Adds files relative to the first root. */
  add(files: Record<string, string>): this {
    for (const [rel, text] of Object.entries(files)) this.files.set(`${this.rootUris[0]}/${rel}`, text);
    return this;
  }

  roots(): string[] {
    return this.rootUris;
  }

  readText(uri: string): Promise<string | undefined> {
    this.reads.push(uri);
    return Promise.resolve(this.files.get(uri));
  }

  findFiles(include: string, exclude?: string, maxResults?: number): Promise<string[]> {
    const inc = globToRegExp(include);
    const exc = exclude ? globToRegExp(exclude) : undefined;
    const out: string[] = [];
    for (const uri of [...this.files.keys()].sort()) {
      for (const root of this.rootUris) {
        if (!uri.startsWith(`${root}/`)) continue;
        const rel = uri.slice(root.length + 1);
        if (inc.test(rel) && !(exc && exc.test(rel))) out.push(uri);
      }
      if (maxResults !== undefined && out.length >= maxResults) break;
    }
    return Promise.resolve(out);
  }

  exists(uri: string): Promise<boolean> {
    return Promise.resolve(this.files.has(uri));
  }

  set userNpmrc(text: string | undefined) {
    if (text === undefined) delete this.userConfigs[".npmrc"];
    else this.userConfigs[".npmrc"] = text;
  }

  readUserConfig(name: string): Promise<string | undefined> {
    return Promise.resolve(this.userConfigs[name]);
  }
}
