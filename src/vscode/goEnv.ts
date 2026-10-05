// Reads the file `go env -w` writes, for GOPRIVATE and its siblings. Only the
// three privacy variables are kept (src/settings.ts parseGoEnvFile); the file
// is read locally and nothing from it is ever sent.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { goEnvFilePath } from "../settings";

const MAX_GO_ENV_BYTES = 64 * 1024;

export function readGoEnvFile(env: Readonly<Record<string, string | undefined>>): string | undefined {
  let home: string | undefined;
  try {
    home = homedir();
  } catch {
    home = env.HOME;
  }
  const path = goEnvFilePath(env, process.platform, home);
  if (!path) return undefined;
  try {
    if (statSync(path).size > MAX_GO_ENV_BYTES) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
