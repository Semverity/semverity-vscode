// Reads the user and site pip.conf (pip.ini) and uv.toml files, so a private
// package index configured there keeps every PyPI name from being sent. The
// files are read locally; only their index URLs are kept (src/core/privacy/localConfig.ts),
// and nothing from them is ever sent.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { pythonConfigPaths } from "../core/privacy/localConfig";

const MAX_CONFIG_BYTES = 256 * 1024;

export function readPythonConfigs(env: Readonly<Record<string, string | undefined>>): { kind: "pip" | "uv"; text: string }[] {
  let home: string | undefined;
  try {
    home = homedir();
  } catch {
    home = env.HOME;
  }
  const out: { kind: "pip" | "uv"; text: string }[] = [];
  for (const { path, kind } of pythonConfigPaths(env, process.platform, home)) {
    try {
      const st = statSync(path);
      if (!st.isFile() || st.size > MAX_CONFIG_BYTES) continue;
      out.push({ kind, text: readFileSync(path, "utf8") });
    } catch {
      // Absent.
    }
  }
  return out;
}
